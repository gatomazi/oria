'use strict';

// Fase 7 (construção) · onboarding de uma Organization nova.
//
//   convite (token opaco, só o hash no banco, expira, uso único)
//     → pessoa + Organization + Store 1:1 + membership owner + estado de onboarding   (UMA transação)
//     → integrações (pelo caminho normal: integrations + integration_secrets)
//     → entitlements explícitos (operação de plataforma, nunca do próprio owner)
//     → finalizar (readiness)
//
// Regras desta construção:
//
//   1. Gate no BACKEND. Nada cria Organization sem SECOND_TENANT_ENABLED=1. O padrão é desligado,
//      e valor inválido é erro de configuração (não "desligado por engano", nem "ligado por engano").
//   2. Nenhuma decisão comercial. Cada passo é required/optional/disabled por CONFIGURAÇÃO
//      explícita (ONBOARDING_STEP_REQUIREMENTS ou parâmetro). Sem configuração, a criação é recusada
//      (ONBOARDING_CONFIG_REQUIRED) — não existe plano padrão. Só os passos estruturais (org_store,
//      owner, readiness) são sempre required, porque sem eles não há Organization utilizável.
//   3. Um source of truth. O estado dos passos de provider é DERIVADO de integrations +
//      integration_secrets a cada leitura; onboarding_steps guarda a projeção e o último código de
//      erro (código, nunca mensagem de provider). O de entitlements é derivado de app_config.
//   4. Idempotência por chave EXPLÍCITA (pessoa, chave). Nada de "a pessoa já tem uma Organization".
//   5. Tudo sob a role da aplicação: a transação fixa a Organization nova no contexto e a RLS
//      forçada vale como em qualquer request. Nenhum superusuário, nenhum bypass.

const crypto = require('crypto');
const { comOrganization } = require('./tenant-db');
const { FEATURES } = require('./entitlements');
const { gerarHash } = require('../auth/password');

const PASSOS = Object.freeze([
  'org_store', 'owner', 'ink', 'meta', 'google', 'ga4', 'openai_byok', 'whatsapp', 'entitlements', 'readiness',
]);
const REQUISITOS = Object.freeze(['required', 'optional', 'disabled']);
// Estruturais: a Organization não existe sem eles. Não são decisão comercial.
const PASSOS_ESTRUTURAIS = Object.freeze(['org_store', 'owner', 'readiness']);

// Passo de provider → integração (provider em integrations) e o que precisa existir nela. Os tipos
// são os de lib/platform/integrations.js (SEGREDOS). Configuração é só não sensível.
const PASSOS_DE_PROVIDER = Object.freeze({
  ink: Object.freeze({ provider: 'ink', segredos: ['api_token', 'webhook_secret'], config: [] }),
  meta: Object.freeze({ provider: 'meta', segredos: ['access_token'], config: [] }),
  google: Object.freeze({ provider: 'google_ads', segredos: ['refresh_token'], config: [] }),
  ga4: Object.freeze({ provider: 'ga4', segredos: ['refresh_token'], config: [] }),
  openai_byok: Object.freeze({ provider: 'openai', segredos: ['api_key'], config: [] }),
  whatsapp: Object.freeze({ provider: 'whatsapp', segredos: ['access_token'], config: ['waba_id', 'phone_number_id'] }),
});

// Vocabulário fechado do que pode ir para last_error_code. Qualquer outra coisa vira PROVIDER_ERROR.
const CODIGOS_DE_ERRO = Object.freeze([
  'PROVIDER_ERROR',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_PERMISSION_DENIED',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_INVALID_CONFIG',
  'PROVIDER_RESOURCE_OWNED_ELSEWHERE',
  'INTEGRATION_SECRET_EXPIRED',
]);

const VALIDADE_CONVITE_PADRAO_MS = 72 * 60 * 60 * 1000;
const VALIDADE_CONVITE_MAXIMA_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE_RE = /^[A-Za-z0-9_.:-]{16,200}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

class OnboardingError extends Error {
  constructor(codigo, status, message, extra = {}) {
    super(message || codigo);
    this.name = 'OnboardingError';
    this.codigo = codigo;
    this.status = status;
    Object.assign(this, extra);
  }
}

const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

function lerFlag(nome, valor) {
  const v = String(valor ?? '').trim().toLowerCase();
  if (v === '' || v === '0' || v === 'false') return false;
  if (v === '1' || v === 'true') return true;
  throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 500, `${nome} inválido: use 1 ou deixe vazio`);
}

// Requisito de cada passo. Todos os passos precisam estar declarados — faltar um é erro, não default.
function validarPassos(passos) {
  if (!passos || typeof passos !== 'object' || Array.isArray(passos)) {
    throw new OnboardingError('ONBOARDING_CONFIG_REQUIRED', 409,
      'configuração dos passos de onboarding ausente (ONBOARDING_STEP_REQUIREMENTS) — não existe plano padrão');
  }
  const chaves = Object.keys(passos);
  const desconhecidos = chaves.filter((k) => !PASSOS.includes(k));
  const faltando = PASSOS.filter((k) => !chaves.includes(k));
  if (desconhecidos.length || faltando.length) {
    throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 400,
      `configuração de passos inválida (faltando: ${faltando.join(', ') || '-'}; desconhecidos: ${desconhecidos.join(', ') || '-'})`);
  }
  for (const k of PASSOS) {
    if (!REQUISITOS.includes(passos[k])) {
      throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 400, `passo ${k}: requisito inválido`);
    }
    if (PASSOS_ESTRUTURAIS.includes(k) && passos[k] !== 'required') {
      throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 400, `passo ${k} é estrutural e precisa ser required`);
    }
  }
  return Object.freeze(Object.fromEntries(PASSOS.map((k) => [k, passos[k]])));
}

function resolverConfigOnboarding(env = process.env) {
  const criacaoHabilitada = lerFlag('SECOND_TENANT_ENABLED', env.SECOND_TENANT_ENABLED);
  const bruto = String(env.ONBOARDING_STEP_REQUIREMENTS || '').trim();
  let passos = null;
  if (bruto) {
    let lido;
    try { lido = JSON.parse(bruto); } catch {
      throw new OnboardingError('ONBOARDING_CONFIG_INVALID', 500, 'ONBOARDING_STEP_REQUIREMENTS não é JSON');
    }
    passos = validarPassos(lido);
  }
  return Object.freeze({ criacaoHabilitada, passos });
}

// Nunca guarda mensagem: só um código do vocabulário fechado.
function normalizarErro(erro) {
  if (typeof erro === 'string') return CODIGOS_DE_ERRO.includes(erro) ? erro : 'PROVIDER_ERROR';
  if (!erro || typeof erro !== 'object') return 'PROVIDER_ERROR';
  if (erro.codigo === 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE') return 'PROVIDER_RESOURCE_OWNED_ELSEWHERE';
  if (CODIGOS_DE_ERRO.includes(erro.codigo)) return erro.codigo;
  const status = Number(erro.status || erro.statusCode || 0);
  if (status === 401) return 'PROVIDER_AUTH_FAILED';
  if (status === 403) return 'PROVIDER_PERMISSION_DENIED';
  if (status === 429) return 'PROVIDER_RATE_LIMITED';
  if (status === 400 || status === 422) return 'PROVIDER_INVALID_CONFIG';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(erro.code)) return 'PROVIDER_UNAVAILABLE';
  return 'PROVIDER_ERROR';
}

function nomeValido(valor, campo) {
  const v = typeof valor === 'string' ? valor.trim() : '';
  if (!v || v.length > 200) throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, `${campo} inválido`);
  return v;
}

function exigirUuid(valor, campo) {
  if (typeof valor !== 'string' || !UUID_RE.test(valor)) {
    throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, `${campo} inválido`);
  }
  return valor.toLowerCase();
}

// Erro de controle para desfazer a transação quando a chave já pertence a outra Organization.
class ChaveJaReservada extends Error {
  constructor(reserva) {
    super('chave de idempotência já reservada');
    this.reserva = reserva;
  }
}

function createOnboardingService({ poolReal, env = process.env, agora = () => new Date() }) {
  if (!poolReal) throw new Error('createOnboardingService exige o pool do Postgres');
  const config = resolverConfigOnboarding(env);

  // Gate de criação externa (seção 20). Fica no serviço — a UI e as rotas não decidem isto.
  function exigirCriacaoHabilitada() {
    if (!config.criacaoHabilitada) {
      throw new OnboardingError('SECOND_TENANT_DISABLED', 403, 'criação de Organization desabilitada (SECOND_TENANT_ENABLED)');
    }
  }

  function passosEfetivos(passos) {
    return validarPassos(passos === undefined ? config.passos : passos);
  }

  async function membershipDe(userId, organizationId) {
    const { rows } = await poolReal.query('SELECT organization_id, papel FROM auth_memberships($1)', [userId]);
    return rows.find((r) => r.organization_id === organizationId) || null;
  }

  // Quem não é membro recebe o mesmo 404 de uma Organization que não existe.
  async function exigirMembro(organizationId, userId, { owner = false } = {}) {
    exigirUuid(organizationId, 'organizationId');
    exigirUuid(userId, 'userId');
    const m = await membershipDe(userId, organizationId);
    if (!m) throw new OnboardingError('ONBOARDING_NOT_FOUND', 404, 'onboarding não encontrado');
    if (owner && m.papel !== 'owner') throw new OnboardingError('OWNER_REQUIRED', 403, 'apenas owner');
    return m;
  }

  // ── Criação atômica ──────────────────────────────────────────────────────────────────────────
  // Uma transação, com a Organization nova no contexto: consumo do convite (se houver), pessoa,
  // reserva da chave, Organization, Store, owner, estado de onboarding e auditoria. Qualquer falha
  // desfaz tudo — inclusive o consumo do convite e a reserva da chave.
  async function criarNaTransacao({ ownerUserId, conviteHash, senhaHash, nomePessoa, chave, organizacao, store, passos }) {
    const organizationId = crypto.randomUUID();
    const storeId = crypto.randomUUID();
    const nomeOrg = nomeValido(organizacao && organizacao.nome, 'organizacao.nome');
    const nomeStore = nomeValido(store && store.nome, 'store.nome');
    const requisitos = passosEfetivos(passos);
    const digest = sha256(JSON.stringify({ o: nomeOrg, s: nomeStore, p: requisitos }));

    try {
      return await comOrganization(poolReal, organizationId, async (c) => {
        let userId = ownerUserId;
        let chaveHash = chave ? sha256(chave) : null;
        if (conviteHash) {
          const { rows: [conv] } = await c.query('SELECT * FROM onboarding_consumir_convite($1)', [conviteHash]);
          if (conv.motivo !== 'ok') {
            const codigo = { usado: 'INVITE_ALREADY_USED', expirado: 'INVITE_EXPIRED' }[conv.motivo] || 'INVITE_INVALID';
            throw new OnboardingError(codigo, codigo === 'INVITE_INVALID' ? 404 : 410, 'convite inválido, expirado ou já usado');
          }
          // E-mail já cadastrado: a UNIQUE recusa e a transação inteira (convite incluído) desfaz.
          const { rows: [u] } = await c.query(
            'INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id',
            [conv.email, nomePessoa, senhaHash]
          ).catch((err) => {
            if (err.code === '23505' && err.constraint === 'uq_users_email') {
              throw new OnboardingError('INVITE_EMAIL_ALREADY_REGISTERED', 409, 'este e-mail já tem conta — entre e crie a organization logado');
            }
            throw err;
          });
          userId = u.id;
          // Um convite cria no máximo uma Organization: a chave é o próprio convite.
          chaveHash = sha256(`convite:${conv.convite_id}`);
        } else {
          const { rows } = await c.query(`SELECT 1 FROM users WHERE id = $1 AND status = 'active'`, [userId]);
          if (!rows.length) throw new OnboardingError('OWNER_NOT_FOUND', 404, 'pessoa não encontrada ou desativada');
        }

        const { rows: [reserva] } = await c.query(
          'SELECT * FROM onboarding_reservar_organizacao($1, $2, $3)', [userId, chaveHash, digest]
        );
        if (reserva.organization_id !== organizationId) throw new ChaveJaReservada({ ...reserva, userId });

        await c.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [organizationId, nomeOrg]);
        await c.query(
          'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)',
          [storeId, organizationId, nomeStore]
        );
        await c.query(
          `INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')`,
          [organizationId, userId]
        );
        await c.query(
          `INSERT INTO onboarding_sessions (organization_id, status, config, criado_por)
           VALUES ($1, 'in_progress', $2::jsonb, $3)`,
          [organizationId, JSON.stringify(requisitos), userId]
        );
        for (const passo of PASSOS) {
          const requisito = requisitos[passo];
          const feito = passo === 'org_store' || passo === 'owner';
          const status = requisito === 'disabled' ? 'skipped' : feito ? 'complete' : 'pending';
          await c.query(
            `INSERT INTO onboarding_steps (organization_id, step_id, requirement, status, completed_at)
             VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'complete' THEN now() END)`,
            [organizationId, passo, requisito, status]
          );
        }
        await c.query(
          `INSERT INTO audit_log (criado_em, actor_user_id, action, entity_type, entity_id, loja, before, after, organization_id)
           VALUES (now(), $1, 'onboarding.organization_created', 'organization', $2::text, NULL, 'null'::jsonb, $3::jsonb, $4::uuid)`,
          [userId, organizationId, JSON.stringify({ storeId, viaConvite: !!conviteHash }), organizationId]
        );
        return { organizationId, storeId, ownerUserId: userId, criada: true };
      });
    } catch (err) {
      if (!(err instanceof ChaveJaReservada)) throw err;
      const { reserva } = err;
      if (reserva.digest !== digest) {
        throw new OnboardingError('IDEMPOTENCY_KEY_REUSED', 409, 'chave de idempotência já usada com outro pedido');
      }
      // Mesma chave, mesmo pedido: devolve o que já foi criado — depois de conferir o vínculo.
      await exigirMembro(reserva.organization_id, reserva.userId, { owner: true });
      const { rows: [s] } = await comOrganization(poolReal, reserva.organization_id, (c) => c.query(
        'SELECT id FROM stores WHERE organization_id = $1 AND ativa', [reserva.organization_id]
      ));
      return { organizationId: reserva.organization_id, storeId: s ? s.id : null, ownerUserId: reserva.userId, criada: false };
    }
  }

  // Pessoa já autenticada cria a própria Organization. `ownerUserId` vem da sessão validada no
  // servidor, nunca do corpo do request.
  async function createOrganizationWithStore({ ownerUserId, idempotencyKey, organizacao, store, passos } = {}) {
    exigirCriacaoHabilitada();
    exigirUuid(ownerUserId, 'ownerUserId');
    if (typeof idempotencyKey !== 'string' || !CHAVE_RE.test(idempotencyKey)) {
      throw new OnboardingError('IDEMPOTENCY_KEY_REQUIRED', 400, 'chave de idempotência explícita obrigatória (16-200 caracteres)');
    }
    return criarNaTransacao({ ownerUserId: ownerUserId.toLowerCase(), chave: idempotencyKey, organizacao, store, passos });
  }

  // ── Convite do primeiro owner ────────────────────────────────────────────────────────────────
  // Sem provedor de e-mail definido: quem emite recebe o token e o entrega por fora (dev flow).
  async function emitirConvite({ email, validadeMs = VALIDADE_CONVITE_PADRAO_MS } = {}) {
    exigirCriacaoHabilitada();
    const normalizado = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(normalizado) || normalizado.length > 320) {
      throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, 'e-mail inválido');
    }
    if (!Number.isInteger(validadeMs) || validadeMs <= 0 || validadeMs > VALIDADE_CONVITE_MAXIMA_MS) {
      throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, 'validade do convite inválida');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const expira = new Date(agora().getTime() + validadeMs);
    const { rows: [r] } = await poolReal.query(
      'SELECT * FROM onboarding_emitir_convite($1, $2, $3)', [sha256(token), normalizado, expira]
    );
    return { conviteId: r.id, token, expiraEm: r.expira_em };
  }

  async function aceitarConvite({ token, senha, nome = null, organizacao, store, passos } = {}) {
    exigirCriacaoHabilitada();
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) {
      throw new OnboardingError('INVITE_INVALID', 404, 'convite inválido, expirado ou já usado');
    }
    // Valida antes de gastar o scrypt; o hash é feito fora da transação.
    passosEfetivos(passos);
    const senhaHash = await gerarHash(senha).catch((err) => {
      throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, err.message);
    });
    const nomePessoa = typeof nome === 'string' && nome.trim() ? nome.trim().slice(0, 200) : null;
    return criarNaTransacao({ conviteHash: sha256(token), senhaHash, nomePessoa, organizacao, store, passos });
  }

  // ── Estado (retomável) ───────────────────────────────────────────────────────────────────────
  async function lerIntegracoes(c, organizationId) {
    const { rows } = await c.query(
      `SELECT i.provider, i.status, i.config,
              COALESCE(array_agg(s.tipo) FILTER (WHERE s.tipo IS NOT NULL AND (s.expires_at IS NULL OR s.expires_at > now())), '{}') AS validos,
              COALESCE(array_agg(s.tipo) FILTER (WHERE s.expires_at IS NOT NULL AND s.expires_at <= now()), '{}') AS vencidos
         FROM integrations i
         LEFT JOIN integration_secrets s ON s.integration_id = i.id AND s.organization_id = i.organization_id
        WHERE i.organization_id = $1 AND i.escopo IS NULL
        GROUP BY i.id, i.provider, i.status, i.config`,
      [organizationId]
    );
    const porProvider = new Map();
    for (const r of rows) {
      if (porProvider.has(r.provider)) {
        throw new OnboardingError('INTEGRATION_INTEGRITY_ERROR', 500, 'erro de integridade da integração');
      }
      porProvider.set(r.provider, r);
    }
    return porProvider;
  }

  // Situação real de um passo de provider, a partir da integração.
  function derivarProvider(regra, integracao) {
    if (!integracao) return { conectado: false, iniciado: false, vencido: false };
    const config = integracao.config || {};
    const temSegredos = regra.segredos.every((t) => integracao.validos.includes(t));
    const temConfig = regra.config.every((k) => typeof config[k] === 'string' && config[k].trim() !== '');
    const vencido = regra.segredos.some((t) => integracao.vencidos.includes(t));
    return {
      conectado: integracao.status === 'connected' && temSegredos && temConfig,
      iniciado: true,
      vencido,
    };
  }

  // Recalcula os passos a partir do estado real e grava a projeção. Roda dentro de comOrganization.
  async function reconciliar(c, organizationId) {
    const { rows: [sessao] } = await c.query(
      'SELECT status, config, concluido_em FROM onboarding_sessions WHERE organization_id = $1 FOR UPDATE',
      [organizationId]
    );
    if (!sessao) throw new OnboardingError('ONBOARDING_NOT_FOUND', 404, 'onboarding não encontrado');
    const { rows: passos } = await c.query(
      'SELECT step_id, requirement, status, last_error_code, tentativas, completed_at FROM onboarding_steps WHERE organization_id = $1',
      [organizationId]
    );
    const integracoes = await lerIntegracoes(c, organizationId);
    // O passo `entitlements` confere a FONTE CANÔNICA — assinatura ativa com ao menos uma feature
    // concedida —, não mais uma linha em `app_config`. O plano vem do Oria Admin; exigir a cópia
    // local transformava "o Admin já concedeu" em "falta rodar um script".
    const { rows: plano } = await c.query(
      'SELECT EXISTS (SELECT 1 FROM entitlements_efetivos($1)) AS ok',
      [organizationId]
    );
    const { rows: [estrutura] } = await c.query(
      `SELECT (SELECT count(*)::int FROM stores WHERE organization_id = $1 AND ativa) AS stores,
              (SELECT count(*)::int FROM organization_members m JOIN users u ON u.id = m.user_id
                WHERE m.organization_id = $1 AND m.papel = 'owner' AND u.status = 'active') AS owners,
              (SELECT status FROM organizations WHERE id = $1) AS org_status`,
      [organizationId]
    );

    const resultado = [];
    for (const p of passos) {
      const novo = { ...p };
      if (p.requirement === 'disabled') {
        novo.status = 'skipped';
      } else if (p.step_id === 'org_store') {
        Object.assign(novo, estrutura.stores === 1 && estrutura.org_status === 'active'
          ? { status: 'complete', last_error_code: null }
          : { status: 'blocked', last_error_code: 'STORE_NOT_READY' });
      } else if (p.step_id === 'owner') {
        Object.assign(novo, estrutura.owners >= 1
          ? { status: 'complete', last_error_code: null }
          : { status: 'blocked', last_error_code: 'OWNER_MISSING' });
      } else if (p.step_id === 'entitlements') {
        novo.status = plano.length === 1 && plano[0].ok ? 'complete' : 'pending';
      } else if (PASSOS_DE_PROVIDER[p.step_id]) {
        const regra = PASSOS_DE_PROVIDER[p.step_id];
        const d = derivarProvider(regra, integracoes.get(regra.provider));
        if (d.conectado) {
          Object.assign(novo, { status: 'complete', last_error_code: null });
        } else if (d.vencido) {
          Object.assign(novo, { status: 'blocked', last_error_code: 'INTEGRATION_SECRET_EXPIRED' });
        } else if (p.status === 'blocked') {
          // Continua bloqueado até o provider responder bem (ou alguém retomar o passo).
        } else {
          novo.status = d.iniciado || p.status === 'in_progress' ? 'in_progress' : 'pending';
        }
      }
      // readiness é marco: só `finalizar` o conclui.
      if (novo.status === 'complete') novo.completed_at = p.completed_at || agora();
      else novo.completed_at = null;

      const mudou = novo.status !== p.status || novo.last_error_code !== p.last_error_code
        || (novo.completed_at === null) !== (p.completed_at === null);
      if (mudou) {
        await c.query(
          `UPDATE onboarding_steps SET status = $3, last_error_code = $4, completed_at = $5, atualizado_em = now()
            WHERE organization_id = $1 AND step_id = $2`,
          [organizationId, p.step_id, novo.status, novo.last_error_code, novo.completed_at]
        );
      }
      resultado.push(novo);
    }

    let status;
    const ativos = resultado.filter((p) => p.requirement === 'required');
    if (sessao.concluido_em) status = 'complete';
    else if (ativos.some((p) => p.status === 'blocked')) status = 'blocked';
    else if (resultado.some((p) => ['complete', 'in_progress', 'blocked'].includes(p.status))) status = 'in_progress';
    else status = 'not_started';
    if (status !== sessao.status) {
      await c.query('UPDATE onboarding_sessions SET status = $2, atualizado_em = now() WHERE organization_id = $1', [organizationId, status]);
    }
    return formatar(organizationId, { status, concluido_em: sessao.concluido_em }, resultado);
  }

  function formatar(organizationId, sessao, passos) {
    const ordenados = PASSOS.map((id) => passos.find((p) => p.step_id === id)).filter(Boolean);
    const proximo = ordenados.find((p) => p.requirement === 'required' && p.status !== 'complete');
    return {
      organizationId,
      status: sessao.status,
      concluidoEm: sessao.concluido_em ? new Date(sessao.concluido_em).toISOString() : null,
      proximoPasso: proximo ? proximo.step_id : null,
      passos: ordenados.map((p) => ({
        id: p.step_id,
        requirement: p.requirement,
        status: p.status,
        lastErrorCode: p.last_error_code,
        completedAt: p.completed_at ? new Date(p.completed_at).toISOString() : null,
        tentativas: p.tentativas,
      })),
    };
  }

  async function estado(organizationId, { userId } = {}) {
    await exigirMembro(organizationId, userId);
    return comOrganization(poolReal, organizationId, (c) => reconciliar(c, organizationId));
  }

  // Falha de provider durante a conexão: grava só o código normalizado e bloqueia o passo.
  async function registrarErroDoPasso(organizationId, passo, erro, { userId } = {}) {
    if (!PASSOS_DE_PROVIDER[passo]) throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, 'passo sem provider');
    await exigirMembro(organizationId, userId, { owner: true });
    const codigo = normalizarErro(erro);
    return comOrganization(poolReal, organizationId, async (c) => {
      await c.query(
        `UPDATE onboarding_steps SET status = 'blocked', last_error_code = $3, tentativas = tentativas + 1,
                completed_at = NULL, atualizado_em = now()
          WHERE organization_id = $1 AND step_id = $2 AND requirement <> 'disabled'`,
        [organizationId, passo, codigo]
      );
      return reconciliar(c, organizationId);
    });
  }

  // Pessoa decide tentar de novo: o passo sai de blocked; o último código fica visível.
  async function retomarPasso(organizationId, passo, { userId } = {}) {
    if (!PASSOS_DE_PROVIDER[passo]) throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, 'passo sem provider');
    await exigirMembro(organizationId, userId, { owner: true });
    return comOrganization(poolReal, organizationId, async (c) => {
      await c.query(
        `UPDATE onboarding_steps SET status = 'in_progress', atualizado_em = now()
          WHERE organization_id = $1 AND step_id = $2 AND status = 'blocked'`,
        [organizationId, passo]
      );
      return reconciliar(c, organizationId);
    });
  }

  // Operação de PLATAFORMA (operador), não do owner: quem recebe a Organization não concede
  // features a si mesmo. Lista explícita, vocabulário fechado; nada é ligado por omissão. Só vale
  // para Organization em onboarding (não mexe no plano de quem não passou por ele).
  async function semearEntitlements(organizationId, features) {
    exigirCriacaoHabilitada();
    exigirUuid(organizationId, 'organizationId');
    if (!Array.isArray(features) || !features.length) {
      throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, 'lista explícita de features obrigatória');
    }
    const desconhecidas = features.filter((f) => !FEATURES.includes(f));
    if (desconhecidas.length) {
      throw new OnboardingError('ONBOARDING_INPUT_INVALID', 400, `feature fora do vocabulário: ${desconhecidas.join(', ')}`);
    }
    return comOrganization(poolReal, organizationId, async (c) => {
      const { rows } = await c.query('SELECT 1 FROM onboarding_sessions WHERE organization_id = $1', [organizationId]);
      if (!rows.length) throw new OnboardingError('ONBOARDING_NOT_FOUND', 404, 'onboarding não encontrado');
      const ligar = JSON.stringify(Object.fromEntries(features.map((f) => [f, true])));
      await c.query(
        `INSERT INTO app_config (organization_id, chave, valor, atualizado_em)
         VALUES ($1, 'entitlements', $2::jsonb, now())
         ON CONFLICT (organization_id, chave) DO UPDATE
           SET valor = (CASE WHEN jsonb_typeof(app_config.valor) = 'object' THEN app_config.valor ELSE '{}'::jsonb END) || EXCLUDED.valor,
               atualizado_em = now()`,
        [organizationId, ligar]
      );
      return reconciliar(c, organizationId);
    });
  }

  // Passo final. Idempotente: a segunda chamada devolve o mesmo concluido_em.
  async function finalizar(organizationId, { userId } = {}) {
    await exigirMembro(organizationId, userId, { owner: true });
    return comOrganization(poolReal, organizationId, async (c) => {
      const atual = await reconciliar(c, organizationId);
      if (atual.status === 'complete') return atual;
      const pendentes = atual.passos
        .filter((p) => p.requirement === 'required' && p.id !== 'readiness' && p.status !== 'complete')
        .map((p) => p.id);
      if (pendentes.length) {
        throw new OnboardingError('ONBOARDING_NOT_READY', 409, `passos obrigatórios pendentes: ${pendentes.join(', ')}`, { pendentes });
      }
      await c.query(
        `UPDATE onboarding_steps SET status = 'complete', last_error_code = NULL, completed_at = now(), atualizado_em = now()
          WHERE organization_id = $1 AND step_id = 'readiness' AND status <> 'complete'`,
        [organizationId]
      );
      await c.query(
        `UPDATE onboarding_sessions SET status = 'complete', concluido_em = now(), atualizado_em = now()
          WHERE organization_id = $1 AND concluido_em IS NULL`,
        [organizationId]
      );
      await c.query(
        `INSERT INTO audit_log (criado_em, actor_user_id, action, entity_type, entity_id, loja, before, after, organization_id)
         VALUES (now(), $1, 'onboarding.completed', 'organization', $2::text, NULL, 'null'::jsonb, 'null'::jsonb, $3::uuid)`,
        [userId, organizationId, organizationId]
      );
      return reconciliar(c, organizationId);
    });
  }

  return {
    config,
    createOrganizationWithStore,
    emitirConvite,
    aceitarConvite,
    estado,
    registrarErroDoPasso,
    retomarPasso,
    semearEntitlements,
    finalizar,
  };
}

module.exports = {
  PASSOS,
  REQUISITOS,
  PASSOS_ESTRUTURAIS,
  PASSOS_DE_PROVIDER,
  CODIGOS_DE_ERRO,
  OnboardingError,
  resolverConfigOnboarding,
  validarPassos,
  normalizarErro,
  createOnboardingService,
};
