'use strict';

// Fase 7 (construção) — onboarding de Organization nova, em Postgres descartável e sob a role
// oria_app (a mesma de INVARIANTS_APP_DATABASE_URL: NOSUPERUSER, NOBYPASSRLS, não dona).
//
//   gate       SECOND_TENANT_ENABLED desligado (padrão) → nada cria Organization nem convite
//   config     sem configuração explícita de passos → criação recusada (nenhum plano padrão)
//   E2E        convite → owner novo → Org + Store → login real → integrações (mock) → erro de
//              provider → logout/restart → retomada → entitlement explícito → complete
//   isolamento segundo tenant criado NO TESTE; RLS e aplicação não deixam um ver o outro
//   atômico    falha no meio da criação → zero Organization incompleta, convite intacto
//   idempot.   chave explícita; concorrência; mesma chave com outro pedido = conflito
//
// Isto é teste, não rollout: nada aqui cria tenant externo real.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');

const h = require('./harness');
const onboarding = h.sujeito('lib/platform/onboarding.js');
const { createAuth, resolverConfigAuth } = h.sujeito('lib/auth/index.js');
const { createLoginLimiter } = h.sujeito('lib/auth/rate-limit.js');
const senhas = h.sujeito('lib/auth/password.js');
const { comOrganization } = h.sujeito('lib/platform/tenant-db.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const { checkEntitlement, carregadorDaOrganizacao } = h.sujeito('lib/platform/entitlements.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_SUL = 'a1000000-0000-4000-8000-000000000001';
const SEGREDO_SESSAO = crypto.randomBytes(32).toString('base64url');
const MESTRA = crypto.randomBytes(32).toString('base64');
const SENHA = 'senha-forte-do-owner-123';
const silencioso = { log() {}, warn() {}, error() {} };

// Configuração de TESTE — não é plano de produto. Cobre os três requisitos.
const PASSOS = Object.freeze({
  org_store: 'required',
  owner: 'required',
  ink: 'required',
  meta: 'optional',
  google: 'disabled',
  ga4: 'disabled',
  openai_byok: 'optional',
  whatsapp: 'required',
  entitlements: 'required',
  readiness: 'required',
});
const ENV_LIGADO = { SECOND_TENANT_ENABLED: '1', ONBOARDING_STEP_REQUIREMENTS: JSON.stringify(PASSOS) };

let db;
let sup;
let appPool;
let appUrl;
let roleApp;
const servidores = [];

const q = async (sql, params = []) => (await sup.query(sql, params)).rows;
const contar = async (tabela) => (await q(`SELECT count(*)::int AS n FROM ${tabela}`))[0].n;

function servico(env = ENV_LIGADO, pool = appPool, extra = {}) {
  return onboarding.createOnboardingService({ poolReal: pool, env, ...extra });
}

function integracoesDe(pool) {
  const fachada = runtime.criarPoolTenant(pool);
  return createIntegrationResolver({
    pool: fachada,
    segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {},
    logger: silencioso,
  });
}
const naOrg = (org, fn) => runtime.comContexto({ organizationId: org, origem: 'teste' }, fn);

async function novaPessoa(prefixo) {
  const { rows: [u] } = await appPool.query(
    'INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id, email',
    [`${prefixo}-${crypto.randomBytes(4).toString('hex')}@teste.oria`, prefixo, await senhas.gerarHash(SENHA)]
  );
  return u;
}

async function contagens() {
  const [orgs, stores, membros, sessoes, passos, reservas, convitesUsados, auditoria] = await Promise.all([
    contar('organizations'), contar('stores'), contar('organization_members'), contar('onboarding_sessions'),
    contar('onboarding_steps'), contar('onboarding_idempotencia'),
    q('SELECT count(*)::int AS n FROM onboarding_invites WHERE usado_em IS NOT NULL').then((r) => r[0].n),
    q(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'onboarding.%'`).then((r) => r[0].n),
  ]);
  return { orgs, stores, membros, sessoes, passos, reservas, convitesUsados, auditoria };
}

// App mínima com o auth real e rotas de teste que usam o serviço com a pessoa da SESSÃO.
async function subirApp(servicoAtual) {
  const auth = createAuth({
    pool: appPool,
    config: resolverConfigAuth({ ADMIN_SESSION_SECRET: SEGREDO_SESSAO }),
    comOrganization,
    auditar: async () => {},
    limiter: createLoginLimiter(),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/admin', auth.router);
  const responder = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      res.status(err.status || 500).json({ codigo: err.codigo || 'ERRO' });
    }
  };
  app.get('/api/admin/teste/onboarding', auth.requireAuth, responder((req) =>
    servicoAtual().estado(req.auth.organizacaoAtivaId, { userId: req.auth.userId })));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servidores.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

function navegador(base) {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, corpo) => {
    const headers = {};
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    if (nav.cookie) headers.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') headers['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const valor = setCookie.split(';')[0];
      nav.cookie = valor.endsWith('=') ? null : valor;
    }
    const json = await res.json().catch(() => null);
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json };
  };
  nav.login = (email) => nav.req('POST', '/api/admin/login', { email, password: SENHA });
  return nav;
}

const passo = (estado, id) => estado.passos.find((p) => p.id === id);
const codigo = (c) => (err) => { assert.equal(err.codigo, c, `${err.codigo}: ${err.message}`); return true; };

test.before(async () => {
  const urlApp = process.env.INVARIANTS_APP_DATABASE_URL;
  assert.ok(urlApp, 'INVARIANTS_APP_DATABASE_URL ausente — rode pelo npm test (scripts/test-db.mjs provisiona oria_app)');
  const credencial = new URL(urlApp);
  roleApp = decodeURIComponent(credencial.username);
  assert.equal(roleApp, 'oria_app');

  db = await h.criarBancoDescartavel('oria_onb');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  // Mesma role e mesma senha do banco compartilhado: só os GRANTs deste banco são novos.
  for (const sql of sqlProvisionarAppRole({
    role: roleApp, senha: decodeURIComponent(credencial.password), tabelasSobRls: manifesto.nomesSobRls(),
  })) await sup.query(sql);
  appUrl = h.urlComUsuario(db.url, roleApp, decodeURIComponent(credencial.password));
  appPool = h.abrirPoolDescartavel(appUrl, { max: 10 });
  const { rows: [eu] } = await appPool.query('SELECT current_user AS u, (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS escapa');
  assert.deepEqual(eu, { u: 'oria_app', escapa: false });
});

test.after(async () => {
  for (const s of servidores) await new Promise((r) => s.close(r));
  await appPool?.end();
  await sup?.end();
  await db?.destruir();
});

// ── Gate e configuração ────────────────────────────────────────────────────────────────────────

test('gate · padrão (SECOND_TENANT_ENABLED ausente/0) não cria Organization nem convite', async () => {
  const antes = await contagens();
  const convitesAntes = await contar('onboarding_invites');
  const dono = await novaPessoa('gate');
  for (const env of [{}, { SECOND_TENANT_ENABLED: '0' }, { SECOND_TENANT_ENABLED: 'false', ONBOARDING_STEP_REQUIREMENTS: JSON.stringify(PASSOS) }]) {
    const s = servico(env);
    assert.equal(s.config.criacaoHabilitada, false);
    await assert.rejects(s.createOrganizationWithStore({
      ownerUserId: dono.id, idempotencyKey: `gate-${crypto.randomUUID()}`, organizacao: { nome: 'X' }, store: { nome: 'X' }, passos: PASSOS,
    }), codigo('SECOND_TENANT_DISABLED'));
    await assert.rejects(s.emitirConvite({ email: 'gate@teste.oria' }), codigo('SECOND_TENANT_DISABLED'));
    await assert.rejects(s.aceitarConvite({ token: 'x'.repeat(43), senha: SENHA, organizacao: { nome: 'X' }, store: { nome: 'X' } }),
      codigo('SECOND_TENANT_DISABLED'));
    await assert.rejects(s.semearEntitlements(ORG_SUL, ['whatsapp']), codigo('SECOND_TENANT_DISABLED'));
  }
  assert.deepEqual(await contagens(), antes);
  assert.equal(await contar('onboarding_invites'), convitesAntes);
  // Valor inesperado não vira "ligado" nem "desligado" em silêncio.
  for (const v of ['yes', 'on', '2']) {
    assert.throws(() => servico({ SECOND_TENANT_ENABLED: v }), codigo('ONBOARDING_CONFIG_INVALID'));
  }
});

test('config · sem configuração explícita de passos a criação é recusada; estruturais não viram opcionais', async () => {
  const dono = await novaPessoa('config');
  const base = { ownerUserId: dono.id, organizacao: { nome: 'Cfg' }, store: { nome: 'Cfg' } };
  const semConfig = servico({ SECOND_TENANT_ENABLED: '1' });
  assert.equal(semConfig.config.passos, null);
  await assert.rejects(semConfig.createOrganizationWithStore({ ...base, idempotencyKey: `cfg-${crypto.randomUUID()}` }),
    codigo('ONBOARDING_CONFIG_REQUIRED'));
  const { google, ...faltando } = PASSOS;
  void google;
  await assert.rejects(semConfig.createOrganizationWithStore({ ...base, idempotencyKey: `cfg-${crypto.randomUUID()}`, passos: faltando }),
    codigo('ONBOARDING_CONFIG_INVALID'));
  for (const estrutural of ['org_store', 'owner', 'readiness']) {
    await assert.rejects(semConfig.createOrganizationWithStore({
      ...base, idempotencyKey: `cfg-${crypto.randomUUID()}`, passos: { ...PASSOS, [estrutural]: 'optional' },
    }), codigo('ONBOARDING_CONFIG_INVALID'));
  }
  await assert.rejects(semConfig.createOrganizationWithStore({ ...base, idempotencyKey: 'curta', passos: PASSOS }),
    codigo('IDEMPOTENCY_KEY_REQUIRED'));
  assert.throws(() => servico({ SECOND_TENANT_ENABLED: '1', ONBOARDING_STEP_REQUIREMENTS: '{"ink":"required"}' }),
    codigo('ONBOARDING_CONFIG_INVALID'));
  assert.equal((await q('SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1', [dono.id]))[0].n, 0);
});

// ── E2E ────────────────────────────────────────────────────────────────────────────────────────

const e2e = {};

test('E2E · convite → owner novo → Organization + Store + owner + onboarding, numa transação', async () => {
  const s = servico();
  const antes = await contagens();
  const email = `owner-${crypto.randomBytes(4).toString('hex')}@teste.oria`;
  const convite = await s.emitirConvite({ email: ` ${email.toUpperCase()} ` });
  assert.match(convite.token, /^[A-Za-z0-9_-]{43}$/);
  // Só o hash no banco; o token cru não está em lugar nenhum.
  const [linha] = await q('SELECT to_jsonb(i) AS j FROM onboarding_invites i WHERE id = $1', [convite.conviteId]);
  assert.equal(linha.j.token_hash, crypto.createHash('sha256').update(convite.token).digest('hex'));
  assert.equal(linha.j.email, email);
  assert.ok(!JSON.stringify(linha.j).includes(convite.token));
  // A role da aplicação não lê a tabela de convites nem a de reservas.
  await assert.rejects(appPool.query('SELECT * FROM onboarding_invites'), /permission denied/);
  await assert.rejects(appPool.query('SELECT * FROM onboarding_idempotencia'), /permission denied/);

  const criado = await s.aceitarConvite({
    token: convite.token, senha: SENHA, nome: 'Owner Novo', organizacao: { nome: 'Loja Nova' }, store: { nome: 'Loja Nova' },
  });
  assert.equal(criado.criada, true);
  Object.assign(e2e, { org: criado.organizationId, store: criado.storeId, owner: criado.ownerUserId, email });

  const depois = await contagens();
  assert.deepEqual(
    Object.fromEntries(Object.keys(antes).map((k) => [k, depois[k] - antes[k]])),
    { orgs: 1, stores: 1, membros: 1, sessoes: 1, passos: 10, reservas: 1, convitesUsados: 1, auditoria: 1 }
  );
  assert.deepEqual(await q('SELECT email, status FROM users WHERE id = $1', [e2e.owner]), [{ email, status: 'active' }]);
  assert.deepEqual(await q('SELECT organization_id, papel FROM organization_members WHERE user_id = $1', [e2e.owner]),
    [{ organization_id: e2e.org, papel: 'owner' }]);
  assert.deepEqual(await q('SELECT organization_id, loja_legada, ativa FROM stores WHERE id = $1', [e2e.store]),
    [{ organization_id: e2e.org, loja_legada: null, ativa: true }]);
  assert.deepEqual(await q('SELECT organization_id FROM onboarding_invites WHERE id = $1', [convite.conviteId]), [{ organization_id: e2e.org }]);
  // Nasce sem entitlement nenhum: nada é concedido por omissão.
  assert.equal((await q(`SELECT count(*)::int AS n FROM app_config WHERE organization_id = $1`, [e2e.org]))[0].n, 0);

  // Uso único.
  await assert.rejects(s.aceitarConvite({
    token: convite.token, senha: SENHA, organizacao: { nome: 'De novo' }, store: { nome: 'De novo' },
  }), codigo('INVITE_ALREADY_USED'));
  assert.deepEqual(await contagens(), depois);
});

test('E2E · login real, estado inicial e retomada depois de erro de provider, logout e restart', async () => {
  let atual = servico();
  const base = await subirApp(() => atual);
  const nav = navegador(base);
  assert.equal((await nav.login(e2e.email)).status, 200);
  const sessao = await nav.req('GET', '/api/admin/session');
  assert.equal(sessao.json.organizacaoAtiva.id, e2e.org);

  const inicial = (await nav.req('GET', '/api/admin/teste/onboarding')).json;
  assert.equal(inicial.status, 'in_progress');
  assert.equal(inicial.proximoPasso, 'ink');
  assert.deepEqual(inicial.passos.map((p) => [p.id, p.requirement, p.status]), [
    ['org_store', 'required', 'complete'], ['owner', 'required', 'complete'],
    ['ink', 'required', 'pending'], ['meta', 'optional', 'pending'], ['google', 'disabled', 'skipped'],
    ['ga4', 'disabled', 'skipped'], ['openai_byok', 'optional', 'pending'], ['whatsapp', 'required', 'pending'],
    ['entitlements', 'required', 'pending'], ['readiness', 'required', 'pending'],
  ]);

  // Integração parcial (Ink só com o token da API) e erro do provider do WhatsApp.
  const integ = integracoesDe(appPool);
  await naOrg(e2e.org, () => integ.gravarSegredo('ink', 'api_token', `ink-${crypto.randomUUID()}`));
  const bruto = Object.assign(new Error('(#190) Invalid OAuth access token - Cannot parse access token'), { status: 401 });
  const bloqueado = await atual.registrarErroDoPasso(e2e.org, 'whatsapp', bruto, { userId: e2e.owner });
  assert.equal(bloqueado.status, 'blocked');
  assert.deepEqual([passo(bloqueado, 'whatsapp').status, passo(bloqueado, 'whatsapp').lastErrorCode], ['blocked', 'PROVIDER_AUTH_FAILED']);
  assert.equal(passo(bloqueado, 'ink').status, 'in_progress');
  const gravado = JSON.stringify(await q(
    `SELECT to_jsonb(s) AS s FROM onboarding_steps s WHERE organization_id = $1
     UNION ALL SELECT to_jsonb(x) FROM onboarding_sessions x WHERE organization_id = $1`, [e2e.org]
  ));
  assert.doesNotMatch(gravado, /oauth|parse|#190/i, 'mensagem do provider não pode ser persistida');
  // O banco também recusa texto livre em last_error_code.
  await assert.rejects(comOrganization(appPool, e2e.org, (c) => c.query(
    `UPDATE onboarding_steps SET last_error_code = 'Invalid OAuth access token' WHERE organization_id = $1 AND step_id = 'whatsapp'`, [e2e.org]
  )), /check constraint/);

  // Logout: a sessão morre; o estado não.
  assert.equal((await nav.req('POST', '/api/admin/logout')).status, 200);
  assert.equal((await nav.req('GET', '/api/admin/teste/onboarding')).status, 401);

  // Restart: pool novo, serviço novo, sessão nova.
  await appPool.end();
  appPool = h.abrirPoolDescartavel(appUrl, { max: 10 });
  atual = servico();
  const nav2 = navegador(await subirApp(() => atual));
  assert.equal((await nav2.login(e2e.email)).status, 200);
  // Como a UI: a sessão nova resolve a Organization (único membership) antes de qualquer tela.
  assert.equal((await nav2.req('GET', '/api/admin/session')).json.organizacaoAtiva.id, e2e.org);
  const retomado = (await nav2.req('GET', '/api/admin/teste/onboarding')).json;
  assert.equal(retomado.status, 'blocked');
  assert.equal(retomado.proximoPasso, 'ink');
  assert.deepEqual(retomado.passos.map((p) => [p.id, p.status, p.lastErrorCode]),
    bloqueado.passos.map((p) => [p.id, p.status, p.lastErrorCode]));

  // Retomar o passo tira do bloqueio; o último código continua visível.
  const retentativa = await atual.retomarPasso(e2e.org, 'whatsapp', { userId: e2e.owner });
  assert.deepEqual([passo(retentativa, 'whatsapp').status, passo(retentativa, 'whatsapp').lastErrorCode, passo(retentativa, 'whatsapp').tentativas],
    ['in_progress', 'PROVIDER_AUTH_FAILED', 1]);
  assert.equal(retentativa.status, 'in_progress');
});

test('E2E · integrações mock + entitlement explícito → onboarding complete, sem bypass', async () => {
  const s = servico();
  await assert.rejects(s.finalizar(e2e.org, { userId: e2e.owner }), (err) => {
    assert.equal(err.codigo, 'ONBOARDING_NOT_READY');
    assert.deepEqual(err.pendentes, ['ink', 'whatsapp', 'entitlements']);
    return true;
  });

  const integ = integracoesDe(appPool);
  await naOrg(e2e.org, async () => {
    await integ.gravarSegredo('ink', 'webhook_secret', `whsec-${crypto.randomUUID()}`);
    // Número/WABA sem token ainda: em andamento, não conectado.
    await integ.gravarConfig('whatsapp', { waba_id: `waba-${crypto.randomUUID()}`, phone_number_id: `phone-${crypto.randomUUID()}` });
  });
  let e = await s.estado(e2e.org, { userId: e2e.owner });
  assert.equal(passo(e, 'ink').status, 'complete');
  assert.equal(passo(e, 'whatsapp').status, 'in_progress');
  assert.equal(e.proximoPasso, 'whatsapp');

  await naOrg(e2e.org, () => integ.gravarSegredo('whatsapp', 'access_token', `EAAG-${crypto.randomUUID()}`));
  e = await s.estado(e2e.org, { userId: e2e.owner });
  assert.deepEqual([passo(e, 'whatsapp').status, passo(e, 'whatsapp').lastErrorCode], ['complete', null]);
  assert.equal(e.proximoPasso, 'entitlements');

  // Passo opcional não segura nada; secret vencido bloqueia com código próprio.
  await naOrg(e2e.org, () => integ.gravarSegredo('meta', 'access_token', `EAAG-${crypto.randomUUID()}`, { expiresAt: new Date(Date.now() - 60000) }));
  e = await s.estado(e2e.org, { userId: e2e.owner });
  assert.deepEqual([passo(e, 'meta').status, passo(e, 'meta').lastErrorCode], ['blocked', 'INTEGRATION_SECRET_EXPIRED']);
  assert.equal(e.status, 'in_progress', 'opcional bloqueado não bloqueia o onboarding');

  // Entitlement: operação de plataforma, lista explícita. Repetir não duplica.
  e = await s.semearEntitlements(e2e.org, ['whatsapp']);
  await s.semearEntitlements(e2e.org, ['whatsapp']);
  assert.equal(passo(e, 'entitlements').status, 'complete');
  assert.deepEqual(await q(`SELECT valor FROM app_config WHERE organization_id = $1 AND chave = 'entitlements'`, [e2e.org]),
    [{ valor: { whatsapp: true } }]);
  await assert.rejects(s.semearEntitlements(e2e.org, ['plano_gratis']), codigo('ONBOARDING_INPUT_INVALID'));
  await assert.rejects(s.semearEntitlements(ORG_SUL, ['whatsapp']), codigo('ONBOARDING_NOT_FOUND'),
    'Organization que não passou por onboarding não recebe plano por aqui');

  const fim = await s.finalizar(e2e.org, { userId: e2e.owner });
  assert.equal(fim.status, 'complete');
  assert.equal(fim.proximoPasso, null);
  assert.equal(passo(fim, 'readiness').status, 'complete');
  assert.ok(fim.concluidoEm);
  // Finalizar de novo não muda nada.
  const deNovo = await s.finalizar(e2e.org, { userId: e2e.owner });
  assert.equal(deNovo.concluidoEm, fim.concluidoEm);
  assert.equal(passo(deNovo, 'readiness').completedAt, passo(fim, 'readiness').completedAt);
  assert.equal((await q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'onboarding.completed' AND organization_id = $1`, [e2e.org]))[0].n, 1);

  // O plano vale no caminho normal (fail-closed para o que não foi ligado).
  const plano = carregadorDaOrganizacao(runtime.criarPoolTenant(appPool));
  await naOrg(e2e.org, async () => {
    assert.equal(await checkEntitlement(plano, 'whatsapp'), true);
    await assert.rejects(checkEntitlement(plano, 'financial'), /ausente no plano/);
  });

  // Sem segunda fonte de verdade: desconectar reflete no passo (o marco de conclusão fica).
  await naOrg(e2e.org, () => integ.desconectar('ink'));
  e = await s.estado(e2e.org, { userId: e2e.owner });
  assert.equal(passo(e, 'ink').status, 'in_progress');
  assert.equal(passo(e, 'ink').completedAt, null);
  assert.equal(e.status, 'complete');
  assert.equal(e.concluidoEm, fim.concluidoEm);
});

// ── Segundo tenant e isolamento ────────────────────────────────────────────────────────────────

test('isolamento · segundo tenant criado no teste não enxerga nem altera o primeiro (RLS sob oria_app + aplicação)', async () => {
  const s = servico();
  const donoB = await novaPessoa('tenant-b');
  const b = await s.createOrganizationWithStore({
    ownerUserId: donoB.id, idempotencyKey: `tenant-b-${crypto.randomUUID()}`,
    organizacao: { nome: 'Segundo Tenant' }, store: { nome: 'Segundo Tenant' },
  });
  assert.equal(b.criada, true);
  assert.notEqual(b.organizationId, e2e.org);
  const integ = integracoesDe(appPool);
  await naOrg(b.organizationId, () => integ.gravarSegredo('ink', 'api_token', `ink-b-${crypto.randomUUID()}`));

  // Aplicação: um owner não consulta nem mexe no onboarding do outro.
  await assert.rejects(s.estado(e2e.org, { userId: donoB.id }), codigo('ONBOARDING_NOT_FOUND'));
  await assert.rejects(s.estado(b.organizationId, { userId: e2e.owner }), codigo('ONBOARDING_NOT_FOUND'));
  await assert.rejects(s.finalizar(e2e.org, { userId: donoB.id }), codigo('ONBOARDING_NOT_FOUND'));
  await assert.rejects(s.registrarErroDoPasso(e2e.org, 'ink', 'PROVIDER_ERROR', { userId: donoB.id }), codigo('ONBOARDING_NOT_FOUND'));
  const estadoB = await s.estado(b.organizationId, { userId: donoB.id });
  assert.equal(passo(estadoB, 'ink').status, 'in_progress');
  assert.equal(passo(estadoB, 'entitlements').status, 'pending', 'o plano do primeiro tenant não aparece no segundo');
  assert.equal(passo(estadoB, 'whatsapp').status, 'pending');
  await naOrg(b.organizationId, async () => {
    await assert.rejects(integ.usarSegredo('whatsapp', 'access_token', (v) => v), (err) => err.codigo === 'INTEGRATION_NOT_CONNECTED');
  });

  // RLS: sob o contexto de B, nenhuma linha de A (nem do Tenant #1) em nenhuma tabela envolvida.
  const tabelas = ['organizations', 'stores', 'organization_members', 'onboarding_sessions', 'onboarding_steps',
    'integrations', 'integration_secrets', 'app_config', 'audit_log'];
  for (const [eu, outro] of [[b.organizationId, e2e.org], [e2e.org, b.organizationId]]) {
    await comOrganization(appPool, eu, async (c) => {
      for (const t of tabelas) {
        const col = t === 'organizations' ? 'id' : 'organization_id';
        const { rows: [r] } = await c.query(`SELECT count(*) FILTER (WHERE ${col} <> $1)::int AS fora, count(*)::int AS total FROM ${t}`, [eu]);
        assert.equal(r.fora, 0, `${t}: ${eu} enxerga linha de outra Organization`);
        if (!['app_config', 'integration_secrets'].includes(t)) assert.ok(r.total >= 1, `${t}: ${eu} não enxerga a própria linha`);
      }
      const upd = await c.query(`UPDATE onboarding_steps SET tentativas = tentativas + 1 WHERE organization_id = $1`, [outro]);
      assert.equal(upd.rowCount, 0);
      const del = await c.query(`DELETE FROM onboarding_sessions WHERE organization_id = $1`, [outro]);
      assert.equal(del.rowCount, 0);
    });
  }
  await assert.rejects(comOrganization(appPool, b.organizationId, (c) => c.query(
    `INSERT INTO onboarding_sessions (organization_id, config) VALUES ($1, '{}'::jsonb)`, [ORG_SUL]
  )), /row-level security/);
  await assert.rejects(comOrganization(appPool, b.organizationId, (c) => c.query(
    `UPDATE onboarding_steps SET organization_id = $1 WHERE organization_id = $2`, [e2e.org, b.organizationId]
  )), /row-level security|foreign key/);
  // Sem contexto, nada.
  for (const t of ['onboarding_sessions', 'onboarding_steps', 'organizations']) {
    assert.equal((await appPool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, `${t} visível sem contexto`);
  }
  // Uma Organization com uma Store ativa cada, e o Tenant #1 intacto.
  assert.deepEqual(await q(`SELECT organization_id, count(*)::int AS n FROM stores WHERE organization_id = ANY($1) GROUP BY 1 ORDER BY 1`,
    [[e2e.org, b.organizationId].sort()]), [e2e.org, b.organizationId].sort().map((o) => ({ organization_id: o, n: 1 })));
  assert.equal((await q(`SELECT count(*)::int AS n FROM onboarding_sessions WHERE organization_id::text LIKE 'a1000000-%'`))[0].n, 0);
});

// ── Atomicidade ────────────────────────────────────────────────────────────────────────────────

test('atômico · falha no meio da criação não deixa Organization incompleta nem gasta o convite', async () => {
  const s = servico();
  const dono = await novaPessoa('falha');
  const convite = await s.emitirConvite({ email: `falha-${crypto.randomBytes(4).toString('hex')}@teste.oria` });
  // Falha REAL no banco depois de Organization, Store, owner e sessão já inseridos: o último passo.
  await sup.query(`
    CREATE FUNCTION teste_falhar_readiness() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      IF NEW.step_id = 'readiness' THEN RAISE EXCEPTION 'falha simulada no meio da criação'; END IF;
      RETURN NEW;
    END $f$;
    CREATE TRIGGER teste_falhar_readiness BEFORE INSERT ON onboarding_steps
      FOR EACH ROW EXECUTE FUNCTION teste_falhar_readiness();
  `);
  const antes = await contagens();
  const pedido = {
    ownerUserId: dono.id, idempotencyKey: `falha-${crypto.randomUUID()}`, organizacao: { nome: 'Quase' }, store: { nome: 'Quase' },
  };
  try {
    await assert.rejects(s.createOrganizationWithStore(pedido), /falha simulada/);
    await assert.rejects(s.aceitarConvite({
      token: convite.token, senha: SENHA, organizacao: { nome: 'Quase' }, store: { nome: 'Quase' },
    }), /falha simulada/);
    assert.deepEqual(await contagens(), antes);
    // (o Tenant #1 do cenário A não tem membros neste banco; fica fora da segunda condição)
    assert.equal((await q(`SELECT count(*)::int AS n FROM organizations o
      WHERE NOT EXISTS (SELECT 1 FROM stores s WHERE s.organization_id = o.id)
         OR (o.id::text NOT LIKE 'a1000000-%'
             AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id = o.id))
         OR (o.id::text NOT LIKE 'a1000000-%'
             AND NOT EXISTS (SELECT 1 FROM onboarding_sessions x WHERE x.organization_id = o.id))`))[0].n, 0);
    assert.deepEqual(await q('SELECT usado_em, organization_id FROM onboarding_invites WHERE id = $1', [convite.conviteId]),
      [{ usado_em: null, organization_id: null }]);
  } finally {
    await sup.query('DROP TRIGGER teste_falhar_readiness ON onboarding_steps; DROP FUNCTION teste_falhar_readiness();');
  }
  // Retry com a MESMA chave e o MESMO convite funciona depois que a causa some.
  const ok = await s.createOrganizationWithStore(pedido);
  assert.equal(ok.criada, true);
  const peloConvite = await s.aceitarConvite({ token: convite.token, senha: SENHA, organizacao: { nome: 'Agora' }, store: { nome: 'Agora' } });
  assert.equal(peloConvite.criada, true);
  const depois = await contagens();
  assert.equal(depois.orgs - antes.orgs, 2);
  assert.equal(depois.convitesUsados - antes.convitesUsados, 1);
});

// ── Idempotência e concorrência ────────────────────────────────────────────────────────────────

test('idempotência · mesma chave em paralelo → uma Organization; repetir devolve a mesma; outro pedido com a chave é conflito', async () => {
  const s = servico();
  const dono = await novaPessoa('idem');
  const chave = `idem-${crypto.randomUUID()}`;
  const pedido = { ownerUserId: dono.id, idempotencyKey: chave, organizacao: { nome: 'Idem' }, store: { nome: 'Idem' } };
  const antes = await contagens();

  const resultados = await Promise.all(Array.from({ length: 8 }, () => s.createOrganizationWithStore(pedido)));
  const orgs = new Set(resultados.map((r) => r.organizationId));
  assert.equal(orgs.size, 1, `chave repetida criou ${orgs.size} Organizations`);
  assert.equal(resultados.filter((r) => r.criada).length, 1);
  assert.equal(new Set(resultados.map((r) => r.storeId)).size, 1);

  const depois = await contagens();
  assert.deepEqual(
    Object.fromEntries(Object.keys(antes).map((k) => [k, depois[k] - antes[k]])),
    { orgs: 1, stores: 1, membros: 1, sessoes: 1, passos: 10, reservas: 1, convitesUsados: 0, auditoria: 1 }
  );

  const repetido = await s.createOrganizationWithStore(pedido);
  assert.deepEqual([repetido.organizationId, repetido.criada], [resultados[0].organizationId, false]);
  // Restart também não perde a chave.
  const repetidoNovo = await servico().createOrganizationWithStore(pedido);
  assert.equal(repetidoNovo.organizationId, resultados[0].organizationId);

  await assert.rejects(s.createOrganizationWithStore({ ...pedido, organizacao: { nome: 'Outro nome' } }), codigo('IDEMPOTENCY_KEY_REUSED'));
  await assert.rejects(s.createOrganizationWithStore({ ...pedido, passos: { ...PASSOS, meta: 'required' } }), codigo('IDEMPOTENCY_KEY_REUSED'));
  // A chave é da PESSOA: outra pessoa com a mesma chave não recebe a Organization de ninguém.
  const outro = await novaPessoa('idem-outro');
  const doOutro = await s.createOrganizationWithStore({ ...pedido, ownerUserId: outro.id });
  assert.notEqual(doOutro.organizationId, resultados[0].organizationId);
  // Outra chave é outra Organization — nunca "a pessoa já tem uma".
  const segunda = await s.createOrganizationWithStore({ ...pedido, idempotencyKey: `idem-${crypto.randomUUID()}` });
  assert.equal(segunda.criada, true);
  assert.notEqual(segunda.organizationId, resultados[0].organizationId);
  assert.equal((await q('SELECT count(*)::int AS n FROM organization_members WHERE user_id = $1', [dono.id]))[0].n, 2);

  // Chaves diferentes em paralelo: uma Organization cada.
  const paralelas = await Promise.all(Array.from({ length: 4 }, () => s.createOrganizationWithStore({
    ...pedido, idempotencyKey: `idem-${crypto.randomUUID()}`,
  })));
  assert.equal(new Set(paralelas.map((r) => r.organizationId)).size, 4);
});

test('convite · aceite concorrente do mesmo token cria uma única pessoa e uma única Organization', async () => {
  const s = servico();
  const email = `corrida-${crypto.randomBytes(4).toString('hex')}@teste.oria`;
  const convite = await s.emitirConvite({ email });
  const antes = await contagens();
  const tentativas = await Promise.allSettled(Array.from({ length: 5 }, () => s.aceitarConvite({
    token: convite.token, senha: SENHA, organizacao: { nome: 'Corrida' }, store: { nome: 'Corrida' },
  })));
  const ok = tentativas.filter((t) => t.status === 'fulfilled');
  assert.equal(ok.length, 1);
  for (const t of tentativas.filter((x) => x.status === 'rejected')) assert.equal(t.reason.codigo, 'INVITE_ALREADY_USED');
  const depois = await contagens();
  assert.equal(depois.orgs - antes.orgs, 1);
  assert.equal((await q('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]))[0].n, 1);
});

test('convite · expirado, desconhecido e e-mail já cadastrado são recusados sem efeito', async () => {
  const s = servico();
  const antes = await contagens();
  const vencido = await s.emitirConvite({ email: `vencido-${crypto.randomBytes(4).toString('hex')}@teste.oria` });
  await sup.query(`UPDATE onboarding_invites SET criado_em = now() - interval '2 hours', expira_em = now() - interval '1 hour' WHERE id = $1`, [vencido.conviteId]);
  const pedido = { senha: SENHA, organizacao: { nome: 'N' }, store: { nome: 'N' } };
  await assert.rejects(s.aceitarConvite({ ...pedido, token: vencido.token }), codigo('INVITE_EXPIRED'));
  await assert.rejects(s.aceitarConvite({ ...pedido, token: crypto.randomBytes(32).toString('base64url') }), codigo('INVITE_INVALID'));
  await assert.rejects(s.aceitarConvite({ ...pedido, token: 'curto' }), codigo('INVITE_INVALID'));

  const existente = await novaPessoa('ja-tem-conta');
  const conviteExistente = await s.emitirConvite({ email: existente.email });
  await assert.rejects(s.aceitarConvite({ ...pedido, token: conviteExistente.token }), codigo('INVITE_EMAIL_ALREADY_REGISTERED'));
  assert.deepEqual(await q('SELECT usado_em FROM onboarding_invites WHERE id = $1', [conviteExistente.conviteId]), [{ usado_em: null }]);
  await assert.rejects(s.aceitarConvite({ ...pedido, senha: 'curta', token: conviteExistente.token }), codigo('ONBOARDING_INPUT_INVALID'));
  await assert.rejects(s.emitirConvite({ email: 'sem-arroba' }), codigo('ONBOARDING_INPUT_INVALID'));
  await assert.rejects(s.emitirConvite({ email: 'a@b.c', validadeMs: 30 * 24 * 3600 * 1000 }), codigo('ONBOARDING_INPUT_INVALID'));
  assert.deepEqual(await contagens(), antes);
});

test('papéis · member da Organization lê o estado mas não registra erro nem finaliza', async () => {
  const s = servico();
  const member = await novaPessoa('member');
  await comOrganization(appPool, e2e.org, (c) => c.query(
    `INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'member')`, [e2e.org, member.id]
  ));
  const e = await s.estado(e2e.org, { userId: member.id });
  assert.equal(e.organizationId, e2e.org);
  await assert.rejects(s.finalizar(e2e.org, { userId: member.id }), codigo('OWNER_REQUIRED'));
  await assert.rejects(s.registrarErroDoPasso(e2e.org, 'ink', 'PROVIDER_ERROR', { userId: member.id }), codigo('OWNER_REQUIRED'));
  await assert.rejects(s.estado(e2e.org, { userId: 'nao-e-uuid' }), codigo('ONBOARDING_INPUT_INVALID'));
});

test('erros · só códigos do vocabulário fechado chegam ao estado', () => {
  const { normalizarErro, CODIGOS_DE_ERRO } = onboarding;
  assert.equal(normalizarErro({ status: 401, message: 'token xyz inválido' }), 'PROVIDER_AUTH_FAILED');
  assert.equal(normalizarErro({ status: 503 }), 'PROVIDER_UNAVAILABLE');
  assert.equal(normalizarErro({ code: 'ETIMEDOUT' }), 'PROVIDER_UNAVAILABLE');
  assert.equal(normalizarErro({ codigo: 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE' }), 'PROVIDER_RESOURCE_OWNED_ELSEWHERE');
  assert.equal(normalizarErro('Error: sk-live-123 rejected'), 'PROVIDER_ERROR');
  assert.equal(normalizarErro(new Error('qualquer coisa')), 'PROVIDER_ERROR');
  for (const c of CODIGOS_DE_ERRO) assert.match(c, /^[A-Z][A-Z0-9_]{2,63}$/);
});
