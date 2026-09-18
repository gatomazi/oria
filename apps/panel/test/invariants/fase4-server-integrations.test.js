'use strict';

// Fase 4 no processo real: server.js sob a role da aplicação (DB_ENFORCE_APP_ROLE=1), com os
// providers externos simulados (test/helpers/provider-mock.cjs, carregado por --require). Prova,
// com duas Organizations:
//   - cada request usa a credencial da própria Organization, inclusive intercaladas (INV-12);
//   - o callback OAuth pertence à Organization do state, não a um parâmetro do navegador;
//   - recurso externo não é de duas Organizations (PD-016);
//   - desconectar A não mexe em B;
//   - dashboard financeiro e consolidado usam o mesmo gasto de mídia (F-01, INV-11);
//   - nenhum token sai em resposta ou log (INV-13).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const { inserir, limparCache } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
// Organization criada no meio da suíte para o caso do tenant novo: id fora da faixa do cenário.
const ORG_C = 'a1000000-0000-4000-8000-00000000000c';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_f4s_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const LOJA = { [ORG_A]: 'sul', [ORG_B]: 'centro' };
const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ONTEM = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 86_400_000));

const T = {
  [ORG_A]: { ink: `inkA${crypto.randomBytes(12).toString('hex')}`, meta: `EAAGA${crypto.randomBytes(12).toString('hex')}`, gads: `1//gadsA${crypto.randomBytes(12).toString('hex')}`, ga4: `1//gaA${crypto.randomBytes(12).toString('hex')}`, openai: `sk-A${crypto.randomBytes(16).toString('hex')}` },
  [ORG_B]: { ink: `inkB${crypto.randomBytes(12).toString('hex')}`, meta: `EAAGB${crypto.randomBytes(12).toString('hex')}`, gads: `1//gadsB${crypto.randomBytes(12).toString('hex')}`, ga4: `1//gaB${crypto.randomBytes(12).toString('hex')}`, openai: `sk-B${crypto.randomBytes(16).toString('hex')}` },
};
const TODOS_OS_TOKENS = Object.values(T).flatMap((x) => Object.values(x));

let db;
let sup;
let resolver;
let filho;
let saida = '';
let base;
let mockLog;
const respostas = [];
const donos = {};

const chamadasMock = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const em = (org, fn) => runtime.comContexto({ organizationId: org, loja: LOJA[org] }, fn);

async function criarPessoa(email, org, papel) {
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]
  );
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
  return u.id;
}

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, redirect = 'follow' } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo), redirect });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    respostas.push(texto);
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto, location: res.headers.get('location') };
  };
  nav.entrar = async (email) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email, password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_f4_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const fachada = runtime.criarPoolTenant(sup);
  resolver = createIntegrationResolver({
    pool: fachada,
    segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {},
    logger: { warn() {}, error() {} },
  });
  donos.A = await criarPessoa('f4-a@teste.oria', ORG_A, 'owner');
  donos.Am = await criarPessoa('f4-am@teste.oria', ORG_A, 'member');
  donos.B = await criarPessoa('f4-b@teste.oria', ORG_B, 'owner');
  limparCache();
  for (const org of [ORG_A, ORG_B]) {
    await em(org, async () => {
      await resolver.gravarSegredo('ink', 'api_token', T[org].ink);
      await resolver.gravarSegredo('meta', 'access_token', T[org].meta, { expiresAt: new Date(Date.now() + 30 * 86_400_000) });
      await resolver.gravarSegredo('google_ads', 'refresh_token', T[org].gads);
      await resolver.gravarSegredo('ga4', 'refresh_token', T[org].ga4);
      await resolver.gravarSegredo('openai', 'api_key', T[org].openai);
    });
    await sup.query(`INSERT INTO meta_connections (organization_id, id, status, token_expires_at) VALUES ($1, 1, 'connected', now() + interval '30 days')`, [org]);
    await sup.query(`INSERT INTO google_ads_connections (organization_id, id, status) VALUES ($1, 1, 'connected')`, [org]);
    await sup.query(`INSERT INTO google_analytics_connections (organization_id, loja, status) VALUES ($1, $2, 'connected')`, [org, LOJA[org]]);
    await sup.query(
      `INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'entitlements', '{"financial": true, "catalog": true}'::jsonb)`, [org]
    );
  }

  mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-f4-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-f4-srv-'));
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: mockLog,
      GOOGLE_CLIENT_ID: 'cliente-google', GOOGLE_CLIENT_SECRET: 'segredo-plataforma-google', GOOGLE_OAUTH_REDIRECT_URI: 'https://oria.test/cb',
      META_APP_ID: '123', META_APP_SECRET: 'segredo-plataforma-meta', META_OAUTH_REDIRECT_URI: 'https://oria.test/meta',
      // Variável legada da loja centro, SEM a flag: ninguém pode usá-la.
      INK_TOKEN_CENTRO: 'ink-env-centro-nao-use-000000',
    },
  }), {
    aoLer: (pedaco, { reiniciando }) => { saida = reiniciando ? '' : saida + pedaco; },
    limiteMs: 30000,
  });
  filho = processo.filho;
  base = processo.base;
});

test.after(async () => {
  if (filho && filho.exitCode === null) filho.kill('SIGKILL');
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const credencialEsperada = (org, provider) => ({
  ink: `Bearer ${T[org].ink}`,
  meta: `Bearer ${T[org].meta}`,
  google_ads: `Bearer ya29.${T[org].gads}`,
  ga4: `Bearer ya29.${T[org].ga4}`,
  openai: `Bearer ${T[org].openai}`,
}[provider]);
const hostDe = { ink: 'api.reserva.ink', meta: 'graph.facebook.com', google_ads: 'googleads.googleapis.com', ga4: 'analyticsadmin.googleapis.com', openai: 'api.openai.com' };

test('INV-12 · teste de conexão de cada provider usa a credencial da Organization da sessão', async () => {
  const navs = { [ORG_A]: await navegador().entrar('f4-a@teste.oria'), [ORG_B]: await navegador().entrar('f4-b@teste.oria') };
  for (const provider of ['ink', 'meta', 'google_ads', 'ga4', 'openai']) {
    for (const org of [ORG_A, ORG_B]) {
      const antes = chamadasMock().length;
      const r = await navs[org].req('POST', `/api/admin/integrations/${provider}/teste`, { corpo: {} });
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.status, 'connected', `${provider}/${org}: ${r.texto}`);
      const novas = chamadasMock().slice(antes).filter((c) => c.host === hostDe[provider]);
      assert.ok(novas.length > 0, `${provider}: provider não foi chamado`);
      for (const c of novas) assert.equal(c.auth, credencialEsperada(org, provider), `${provider}/${org}`);
    }
  }
});

test('INV-12 · requests intercaladas e concorrentes não cruzam credenciais', async () => {
  const navs = { [ORG_A]: await navegador().entrar('f4-a@teste.oria'), [ORG_B]: await navegador().entrar('f4-b@teste.oria') };
  const antes = chamadasMock().length;
  const pedidos = [];
  for (let i = 0; i < 12; i += 1) {
    const org = i % 2 ? ORG_B : ORG_A;
    pedidos.push(navs[org].req('POST', `/api/admin/integrations/${i % 3 ? 'ink' : 'openai'}/teste`, { corpo: {} }));
  }
  const rs = await Promise.all(pedidos);
  assert.ok(rs.every((r) => r.json.status === 'connected'));
  const conta = {};
  for (const c of chamadasMock().slice(antes)) conta[c.auth] = (conta[c.auth] || 0) + 1;
  assert.deepEqual(conta, {
    [credencialEsperada(ORG_A, 'ink')]: 4, [credencialEsperada(ORG_B, 'ink')]: 4,
    [credencialEsperada(ORG_A, 'openai')]: 2, [credencialEsperada(ORG_B, 'openai')]: 2,
  });
});

test('OAuth · o callback grava na Organization do state; organization_id do navegador é ignorado', async () => {
  const a = await navegador().entrar('f4-a@teste.oria');
  const inicio = await a.req('GET', '/api/admin/integrations/google-analytics/connect', { redirect: 'manual' });
  assert.equal(inicio.status, 302);
  const state = new URL(inicio.location).searchParams.get('state');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  // Callback sem cookie (o Google redireciona o navegador), tentando mandar para B.
  const cb = await fetch(`${base}/api/admin/integrations/google-analytics/callback?code=novoA&state=${state}&organization_id=${ORG_B}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  await em(ORG_A, async () => assert.equal(await resolver.usarSegredo('ga4', 'refresh_token', (v) => v), '1//code-refresh-novoA'));
  await em(ORG_B, async () => assert.equal(await resolver.usarSegredo('ga4', 'refresh_token', (v) => v), T[ORG_B].ga4));
  // Reuso do state não faz nada.
  const reuso = await fetch(`${base}/api/admin/integrations/google-analytics/callback?code=outro&state=${state}`, { redirect: 'manual' });
  assert.equal(reuso.status, 302);
  await em(ORG_A, async () => assert.equal(await resolver.usarSegredo('ga4', 'refresh_token', (v) => v), '1//code-refresh-novoA'));
  // State do Google não vale no callback da Meta.
  const inicio2 = await a.req('GET', '/api/admin/integrations/google-analytics/connect', { redirect: 'manual' });
  const state2 = new URL(inicio2.location).searchParams.get('state');
  const antesMeta = chamadasMock().filter((c) => c.caminho.endsWith('/oauth/access_token')).length;
  await fetch(`${base}/api/admin/integrations/meta/callback?code=x&state=${state2}`, { redirect: 'manual' });
  assert.equal(chamadasMock().filter((c) => c.caminho.endsWith('/oauth/access_token')).length, antesMeta, 'a Meta não pode ter sido chamada');
  await em(ORG_A, () => resolver.gravarSegredo('ga4', 'refresh_token', T[ORG_A].ga4));
});

test('INV-11 · dashboard financeiro e consolidado usam o mesmo gasto; recurso sem loja fica fora e sinalizado', async () => {
  await sup.query(`INSERT INTO meta_ad_accounts (organization_id, meta_account_id, selecionada, loja_atribuida) VALUES ($1, 'act_dre_a', true, 'sul')`, [ORG_A]);
  await inserir(sup, 'meta_insights_daily', { organization_id: ORG_A, meta_account_id: 'act_dre_a', level: 'account', entidade_id: 'act_dre_a', data: HOJE, spend: 150 });
  // Customer do Google Ads selecionado SEM loja: o gasto não pode entrar em nenhuma das telas.
  await sup.query(`INSERT INTO google_ads_customers (organization_id, customer_id, selecionada, loja_atribuida) VALUES ($1, '5550001111', true, NULL)`, [ORG_A]);
  await inserir(sup, 'google_ads_insights_daily', { organization_id: ORG_A, customer_id: '5550001111', level: 'customer', entidade_id: '5550001111', data: HOJE, contagem_conversao: 'conversions', custo: 999 });
  // Mesmo customer em B, atribuído: nunca aparece para A.
  await sup.query(`INSERT INTO google_ads_customers (organization_id, customer_id, selecionada, loja_atribuida) VALUES ($1, '5550001111', true, 'centro')`, [ORG_B]);
  await inserir(sup, 'google_ads_insights_daily', { organization_id: ORG_B, customer_id: '5550001111', level: 'customer', entidade_id: '5550001111', data: HOJE, contagem_conversao: 'conversions', custo: 4321 });

  const a = await navegador().entrar('f4-a@teste.oria');
  const dash = await a.req('GET', '/api/admin/dashboard/financeiro?dias=2');
  assert.equal(dash.status, 200, dash.texto);
  const somaDash = dash.json.midia.filter((m) => m.dia >= ONTEM).reduce((t, m) => t + m.spend, 0);
  const cons = await a.req('GET', `/api/admin/analytics/consolidado?from=${ONTEM}&to=${HOJE}`);
  assert.equal(cons.status, 200, cons.texto);
  assert.equal(somaDash, 150);
  assert.equal(cons.json.resultado.totalMidia, somaDash, 'as duas telas precisam do mesmo gasto');
  assert.deepEqual(cons.json.midiaSinalizada, [{ provider: 'google_ads', recurso: '5550001111', motivo: 'sem_loja' }]);
  assert.ok(cons.json.qualidade.avisos.join(' ').length > 0);
  // Parâmetro de loja não sobrescreve a atribuição: é recusado.
  assert.equal((await a.req('GET', `/api/admin/analytics/consolidado?from=${ONTEM}&to=${HOJE}&loja=centro`)).status, 400);

  const b = await navegador().entrar('f4-b@teste.oria');
  const consB = await b.req('GET', `/api/admin/analytics/consolidado?from=${ONTEM}&to=${HOJE}`);
  assert.equal(consB.json.resultado.totalMidia, 4321);
});

test('PD-016 · a mesma conta de anúncios não é selecionada por duas Organizations', async () => {
  for (const org of [ORG_A, ORG_B]) {
    await sup.query(`INSERT INTO meta_ad_accounts (organization_id, meta_account_id, selecionada) VALUES ($1, 'act_compartilhada', false)`, [org]);
  }
  const a = await navegador().entrar('f4-a@teste.oria');
  const b = await navegador().entrar('f4-b@teste.oria');
  const ra = await a.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: 'act_compartilhada' } });
  assert.equal(ra.status, 200, ra.texto);
  const rb = await b.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: 'act_compartilhada' } });
  assert.deepEqual([rb.status, rb.json.codigo], [409, 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE']);
  const { rows } = await sup.query(`SELECT organization_id, selecionada FROM meta_ad_accounts WHERE meta_account_id = 'act_compartilhada' ORDER BY organization_id`);
  assert.deepEqual(rows.map((r) => [r.organization_id, r.selecionada]), [[ORG_A, true], [ORG_B, false]]);
  // A troca de conta: a antiga (act_dre_a) é liberada.
  const { rows: claims } = await sup.query(`SELECT external_id FROM external_resource_claims WHERE organization_id = $1 AND provider = 'meta'`, [ORG_A]);
  assert.deepEqual(claims.map((c) => c.external_id), ['act_compartilhada']);
});

test('desconectar · revoga e apaga só na Organization da sessão', async () => {
  const b = await navegador().entrar('f4-b@teste.oria');
  const antes = chamadasMock().length;
  const r = await b.req('POST', '/api/admin/integrations/google-ads/disconnect', { corpo: {} });
  assert.equal(r.status, 200, r.texto);
  const revogacoes = chamadasMock().slice(antes).filter((c) => c.caminho === '/revoke');
  assert.equal(revogacoes.length, 1);
  assert.equal(new URLSearchParams(revogacoes[0].corpo).get('token'), T[ORG_B].gads, 'revoga o token de B');
  await em(ORG_B, () => assert.rejects(resolver.usarSegredo('google_ads', 'refresh_token', (v) => v), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED'));
  await em(ORG_A, async () => assert.equal(await resolver.usarSegredo('google_ads', 'refresh_token', (v) => v), T[ORG_A].gads));
  const a = await navegador().entrar('f4-a@teste.oria');
  assert.equal((await a.req('POST', '/api/admin/integrations/google_ads/teste', { corpo: {} })).json.status, 'connected');
  assert.equal((await b.req('POST', '/api/admin/integrations/google_ads/teste', { corpo: {} })).json.status, 'error');
  const { rows } = await sup.query(`SELECT count(*)::int AS n FROM external_resource_claims WHERE organization_id = $1 AND provider = 'google_ads'`, [ORG_B]);
  assert.equal(rows[0].n, 0);
});

test('Ink · credencial manual só por owner, validada, e o env legado não serve sem a flag', async () => {
  const membro = await navegador().entrar('f4-am@teste.oria');
  assert.equal((await membro.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { apiToken: 'x'.repeat(20) } })).status, 403);
  const a = await navegador().entrar('f4-a@teste.oria');
  assert.equal((await a.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { feedUrl: 'http://169.254.169.254/latest' } })).status, 400);
  assert.equal((await a.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { apiToken: 'curto' } })).status, 400);
  assert.equal((await a.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { apiToken: T[ORG_A].ink, loja: 'centro' } })).status, 400);
  const novo = `inkA2${crypto.randomBytes(12).toString('hex')}`;
  const ok = await a.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { apiToken: novo, feedUrl: 'https://feed.reserva.ink/a' } });
  assert.equal(ok.status, 200, ok.texto);
  assert.deepEqual(ok.json.segredos.map((s) => [s.tipo, s.last4]).sort(), [['api_token', novo.slice(-4)], ['feed_url', 'https://feed.reserva.ink/a'.slice(-4)]].sort());
  assert.ok(!ok.texto.includes(novo));
  T[ORG_A].ink = novo;

  const b = await navegador().entrar('f4-b@teste.oria');
  assert.equal((await b.req('DELETE', '/api/admin/integrations/ink/credenciais')).status, 200);
  const semToken = await b.req('POST', '/api/admin/integrations/ink/teste', { corpo: {} });
  assert.equal(semToken.json.status, 'error', 'INK_TOKEN_CENTRO do ambiente não pode ser usado sem a flag');
  assert.ok(!chamadasMock().some((c) => c.auth === 'Bearer ink-env-centro-nao-use-000000'));
  const ra = await a.req('POST', '/api/admin/integrations/ink/teste', { corpo: {} });
  assert.equal(ra.json.status, 'connected', 'A não foi afetada pela desconexão de B');
});

test('INV-13 · nenhum token de tenant em resposta HTTP ou no log do processo', async () => {
  const a = await navegador().entrar('f4-a@teste.oria');
  for (const rota of ['/api/admin/integrations', '/api/admin/integrations/ink/credenciais', '/api/admin/integrations/meta/status',
    '/api/admin/integrations/google-ads/status', '/api/admin/integrations/google-analytics/status', '/api/admin/criativos/settings/openai-key']) {
    await a.req('GET', rota);
  }
  const tudo = respostas.join('\n');
  for (const token of [...TODOS_OS_TOKENS, 'segredo-plataforma-google', 'segredo-plataforma-meta']) {
    assert.ok(!tudo.includes(token), 'token numa resposta');
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const token of TODOS_OS_TOKENS) assert.ok(!saida.includes(token), 'token no log do processo');
  assert.doesNotMatch(saida, /TENANT_CONTEXT_REQUIRED|row-level security|permission denied/i);
});

// ── Tenant novo: a tela de Integrações é a PRIMEIRA que um lojista abre ───────────────────────
//
// Caso real do Tenant #1 (Use Origens, 18/09/2026): organization criada pelo Oria Admin, store
// válida, assinatura ativa, ZERO integrações. A tela devolvia 502 — `lojasDaIntegracaoInk()`
// chamava `lojaDoContexto()`, que lança `STORE_WITHOUT_INK` quando a store não tem loja legada, e
// o handler async sem try/catch transformava isso em unhandled rejection: a requisição ficava sem
// resposta e o proxy respondia 502.
//
// Store sem loja legada é um ESTADO — toda organization nasce assim. Status é leitura: abrir a
// tela não pode depender de nada estar configurado, nem falar com provider externo.
test('tenant novo · Integrações abre com zero integrações: 200, not_configured, sem tocar provider', async () => {
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG_C, 'Tenant Novo']);
  await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)',
    [crypto.randomUUID(), ORG_C, 'Loja do Tenant Novo']
  );
  await criarPessoa('f4-c@teste.oria', ORG_C, 'owner');

  const chamadasAntes = chamadasMock().length;
  const c = await navegador().entrar('f4-c@teste.oria');
  const r = await c.req('GET', '/api/admin/integrations');

  assert.equal(r.status, 200, `a tela de status não pode falhar num tenant novo: ${r.texto}`);
  assert.deepEqual(r.json.reservaInk, [], 'sem loja legada não há linha de Ink — lista vazia, não erro');
  assert.equal(r.json.ink.conectado, false);
  assert.equal(r.json.ink.status, 'not_configured');
  assert.equal(r.json.whatsapp.conectado, false);
  assert.equal(r.json.whatsapp.status, 'not_configured');

  // Abrir a tela é leitura: nenhuma chamada externa sai daqui.
  assert.equal(chamadasMock().length, chamadasAntes, 'abrir Integrações disparou chamada a provider externo');

  // E o processo não registrou rejeição não tratada — é isso que virava 502.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.doesNotMatch(saida, /UNHANDLED_REJECTION/, 'requisição terminou em rejeição não tratada');
});

// Fail-closed continua valendo: sem segredo, a ação de provider não roda — e JAMAIS cai na
// credencial de outro tenant nem na variável de ambiente legada.
test('tenant novo · sem segredo, ação de provider falha fechada e não usa credencial de ninguém', async () => {
  const c = await navegador().entrar('f4-c@teste.oria');
  const chamadasAntes = chamadasMock().length;

  const teste = await c.req('POST', '/api/admin/integrations/ink/teste', { corpo: {} });
  assert.notEqual(teste.json && teste.json.status, 'connected', 'tenant sem credencial não pode conectar');

  // Nenhuma credencial de A, de B ou do ambiente legado foi usada em nome do tenant novo.
  const novas = chamadasMock().slice(chamadasAntes);
  for (const chamada of novas) {
    const auth = String(chamada.auth || '');
    for (const token of TODOS_OS_TOKENS) {
      assert.ok(!auth.includes(token), 'ação do tenant novo usou credencial de outro tenant');
    }
    assert.ok(!auth.includes('ink-env-centro-nao-use-000000'), 'ação do tenant novo caiu no env legado');
  }
});
