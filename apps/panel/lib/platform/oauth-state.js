'use strict';

// Fase 4 · state de OAuth amarrado a quem iniciou o fluxo.
//
// No início (sessão autenticada, Organization ativa) nasce um state aleatório de 256 bits. No banco
// fica só o SHA-256 dele, junto de: provider, Organization, pessoa, sessão e validade. O callback:
//
//   1. consome o state (uso único; DELETE ... RETURNING);
//   2. confere provider e validade;
//   3. revalida a sessão (não revogada, não vencida, pessoa ativa) e o membership da pessoa naquela
//      Organization — se ela perdeu o acesso entre o início e a volta, o callback falha;
//   4. devolve a Organization gravada. Nenhum valor do callback/navegador escolhe tenant.
//
// Trocar de workspace no meio do fluxo não muda a Organization do state: a conexão pertence à que
// autorizou, enquanto o membership nela existir.

const crypto = require('crypto');

const TTL_PADRAO_MS = 10 * 60 * 1000;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;
const PROVIDERS = new Set(['meta', 'google_ads', 'ga4', 'whatsapp']);

class OAuthStateError extends Error {
  constructor(motivo) {
    super(`state de OAuth inválido (${motivo})`);
    this.name = 'OAuthStateError';
    this.motivo = motivo;
  }
}

const hashDe = (state) => crypto.createHash('sha256').update(state).digest('hex');

function createOAuthStates({ poolReal, ttlMs = TTL_PADRAO_MS }) {
  if (!poolReal) throw new Error('createOAuthStates exige o pool');

  async function criar({ provider, organizationId, auth, dados = {} }) {
    if (!PROVIDERS.has(provider)) throw new Error(`provider de OAuth desconhecido: ${provider}`);
    if (!auth || !auth.sessaoId || !auth.userId) throw new OAuthStateError('sem sessão');
    if (!organizationId) throw new OAuthStateError('sem organization');
    const state = crypto.randomBytes(32).toString('base64url');
    await poolReal.query(
      `INSERT INTO oauth_states (id, provider, organization_id, user_id, session_id, dados, expira_em)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::int * interval '1 millisecond'))`,
      [hashDe(state), provider, organizationId, auth.userId, auth.sessaoId, JSON.stringify(dados), ttlMs]
    );
    // Limpeza oportunista do que já venceu.
    poolReal.query('DELETE FROM oauth_states WHERE expira_em < now()').catch(() => {});
    return state;
  }

  // `providers`: quais são aceitos neste callback (o do Google serve GA4 e Google Ads).
  async function consumir(state, providers) {
    if (typeof state !== 'string' || !STATE_RE.test(state)) throw new OAuthStateError('formato');
    // Validade medida pelo relógio do banco (o mesmo que a gravou), não pelo do processo.
    const { rows } = await poolReal.query(
      'DELETE FROM oauth_states WHERE id = $1 RETURNING *, (expira_em <= now()) AS vencido', [hashDe(state)]
    );
    const linha = rows[0];
    if (!linha) throw new OAuthStateError('desconhecido ou já usado');
    if (!providers.includes(linha.provider)) throw new OAuthStateError('provider diferente');
    if (linha.vencido) throw new OAuthStateError('vencido');

    const { rows: sessao } = await poolReal.query(
      `SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.user_id = $2 AND s.revogada_em IS NULL AND s.expira_em > now()
          AND u.status = 'active'`,
      [linha.session_id, linha.user_id]
    );
    if (!sessao.length) throw new OAuthStateError('sessão encerrada');

    const { rows: memberships } = await poolReal.query('SELECT organization_id FROM auth_memberships($1)', [linha.user_id]);
    if (!memberships.some((m) => m.organization_id === linha.organization_id)) {
      throw new OAuthStateError('sem acesso à organization');
    }
    return {
      provider: linha.provider,
      organizationId: linha.organization_id,
      userId: linha.user_id,
      dados: linha.dados || {},
    };
  }

  return { criar, consumir };
}

module.exports = { OAuthStateError, createOAuthStates, hashDe };
