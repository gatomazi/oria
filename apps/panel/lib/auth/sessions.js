'use strict';

// Sessões persistidas e revogáveis (Fase 2).
//
// O cookie carrega só um token opaco de 256 bits. No banco fica o SHA-256 dele: quem lê a tabela
// não ganha uma sessão viva. Toda request consulta o banco — revogar vale na request seguinte,
// sem esperar o cookie expirar.
//
// O token CSRF é HMAC(segredo, id da sessão): vinculado à sessão, não precisa ser armazenado, e o
// de uma sessão não serve em outra.

const crypto = require('crypto');

const TTL_MS = 12 * 60 * 60 * 1000;
// Não reescreve `ultimo_uso_em` a cada request: um UPDATE por leitura seria o preço do rastro.
const INTERVALO_TOQUE_MS = 5 * 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

class SessaoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessaoError';
  }
}

const idDoToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function derivarChaveCsrf(segredo) {
  if (typeof segredo !== 'string' || segredo.length < 32) {
    throw new SessaoError('segredo de sessão ausente ou curto (mínimo 32 caracteres)');
  }
  return Buffer.from(crypto.hkdfSync('sha256', segredo, '', 'oria-csrf-v1', 32));
}

function createSessionStore({ pool, segredo, ttlMs = TTL_MS, agora = () => Date.now() }) {
  if (!pool) throw new SessaoError('store de sessão exige Postgres');
  const chaveCsrf = derivarChaveCsrf(segredo);

  function csrfDe(sessaoId) {
    return crypto.createHmac('sha256', chaveCsrf).update(sessaoId).digest('base64url');
  }

  function csrfConfere(sessaoId, recebido) {
    if (typeof recebido !== 'string' || !recebido) return false;
    const a = Buffer.from(csrfDe(sessaoId));
    const b = Buffer.from(recebido);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Sempre um token NOVO, gerado aqui. Nenhum valor vindo do cliente vira id de sessão.
  async function criar({ userId, metodo }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = idDoToken(token);
    const expiraEm = new Date(agora() + ttlMs);
    await pool.query(
      `INSERT INTO sessions (id, user_id, metodo, expira_em) VALUES ($1, $2, $3, $4)`,
      [id, userId, metodo, expiraEm]
    );
    return { token, id, expiraEm, csrfToken: csrfDe(id) };
  }

  // Sessão válida = existe, não revogada, não expirada, e o usuário está ativo.
  async function buscar(token) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const id = idDoToken(token);
    const { rows } = await pool.query(
      `SELECT s.id, s.user_id, s.metodo, s.expira_em, s.ultimo_uso_em, s.active_organization_id, u.email, u.nome
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1
          AND s.revogada_em IS NULL
          AND s.expira_em > now()
          AND u.status = 'active'`,
      [id]
    );
    const s = rows[0];
    if (!s) return null;
    if (agora() - new Date(s.ultimo_uso_em).getTime() > INTERVALO_TOQUE_MS) {
      await pool.query('UPDATE sessions SET ultimo_uso_em = now() WHERE id = $1', [id]);
    }
    return {
      sessaoId: s.id,
      userId: s.user_id,
      email: s.email,
      nome: s.nome,
      metodo: s.metodo,
      organizacaoAtivaId: s.active_organization_id,
      expiraEm: s.expira_em,
      csrfToken: csrfDe(s.id),
    };
  }

  async function revogar(sessaoId, { por = null, motivo }) {
    const { rowCount } = await pool.query(
      `UPDATE sessions SET revogada_em = now(), revogada_por = $2, motivo_revogacao = $3
        WHERE id = $1 AND revogada_em IS NULL`,
      [sessaoId, por, motivo]
    );
    return rowCount;
  }

  async function revogarPorToken(token, opcoes) {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return 0;
    return revogar(idDoToken(token), opcoes);
  }

  async function revogarDoUsuario(userId, { por = null, motivo, exceto = null }) {
    const { rowCount } = await pool.query(
      `UPDATE sessions SET revogada_em = now(), revogada_por = $2, motivo_revogacao = $3
        WHERE user_id = $1 AND revogada_em IS NULL AND ($4::text IS NULL OR id <> $4)`,
      [userId, por, motivo, exceto]
    );
    return rowCount;
  }

  // Sessões ativas do próprio usuário. O id devolvido é o hash — não reconstrói o cookie.
  async function listarDoUsuario(userId) {
    const { rows } = await pool.query(
      `SELECT id, metodo, criado_em, expira_em, ultimo_uso_em FROM sessions
        WHERE user_id = $1 AND revogada_em IS NULL AND expira_em > now()
        ORDER BY criado_em DESC`,
      [userId]
    );
    return rows;
  }

  return { criar, buscar, revogar, revogarPorToken, revogarDoUsuario, listarDoUsuario, csrfDe, csrfConfere };
}

module.exports = { TTL_MS, SessaoError, createSessionStore, idDoToken, derivarChaveCsrf };
