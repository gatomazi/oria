'use strict';

// Hotfix pré-merge do redesign de Integrações · D-1 (RBAC) e D-2 (entitlement), no processo real do servidor sob a role da aplicação
// (`DB_ENFORCE_APP_ROLE=1`), com os providers externos simulados (test/helpers/provider-mock.cjs).
//
//   D-1  criar, trocar ou revogar credencial/vínculo de Meta Ads, Google Ads e GA4 exige `owner` da Organization ATIVA — a mesma política
//        da credencial da Ink e do número do WhatsApp. `member` continua lendo e sincronizando. O servidor responde 403 ANTES de qualquer
//        mutação ou chamada externa (revogação no Google, por exemplo).
//   D-2  o catálogo de análises (`/api/admin/product-analytics/*`) segue negando 403 sem `analytics_product_performance`; o catálogo
//        genérico (`/api/admin/produtos/catalogo/*`) não depende dessa feature.
//
//   X  Organization COM Meta/Google Ads/GA4 e SEM `analytics_product_performance`  (owner X, member X)
//   Y  Organization COM as mesmas integrações e COM `analytics_product_performance` (owner Y, member Y)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { limparCache, concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORGS = { X: 'a1000000-0000-4000-8000-0000000000e1', Y: 'a1000000-0000-4000-8000-0000000000e2' };
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_rbac_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const CUSTOMER = { X: '1112223334', Y: '5556667778' };

let db;
let sup;
let filho;
let saida = '';
let base;
let mockLog;
const store = {};
const email = (papel, letra) => `rbac-${papel}-${letra.toLowerCase()}@teste.oria`;
const chamadasMock = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const revogacoes = () => chamadasMock().filter((c) => c.host === 'oauth2.googleapis.com' && c.caminho === '/revoke').length;

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, redirect = 'follow', semCookie = false, headers = {} } = {}) => {
    const hd = { ...headers };
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie && !semCookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, {
      method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo), redirect, signal: AbortSignal.timeout(15000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto, location: res.headers.get('location') };
  };
  nav.entrar = async (papel, letra) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email: email(papel, letra), password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}
const entrar = (papel, letra) => navegador().entrar(papel, letra);
const semCookie = (nav, caminho) => nav.req('GET', caminho, { redirect: 'manual', semCookie: true });

async function criarOrganizacao(letra, features) {
  const org = ORGS[letra];
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Tenant RBAC ${letra}`]);
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id', [crypto.randomUUID(), org, `Loja RBAC ${letra}`]
  );
  store[letra] = s.id;
  for (const papel of ['owner', 'member']) {
    const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email(papel, letra), await senhas.gerarHash(SENHA)]);
    await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
  }
  await concederFeatures(sup, org, features);
  // Conta de anúncios do Google Ads já sincronizada (o mock do Google não lista contas).
  await sup.query(
    `INSERT INTO google_ads_customers (organization_id, store_id, customer_id, nome, currency, timezone_name) VALUES ($1, $2, $3, $4, 'BRL', 'America/Sao_Paulo')`,
    [org, s.id, CUSTOMER[letra], `Conta Ads ${letra}`]
  );
}

// Conecta GA4, Meta Ads e Google Ads da Organization como o produto faz (OAuth simulado; o `state` vem do servidor).
async function conectarTudo(letra) {
  const dono = await entrar('owner', letra);
  const ga = await dono.req('GET', '/api/admin/integrations/google-analytics/connect', { redirect: 'manual' });
  assert.equal(ga.status, 302, ga.texto);
  const cbGa = await semCookie(dono, `/api/admin/integrations/google-analytics/callback?${new URLSearchParams({ code: `single${letra}`, state: new URL(ga.location).searchParams.get('state') })}`);
  assert.equal(cbGa.status, 302, cbGa.texto);

  const meta = await dono.req('GET', '/api/admin/integrations/meta/connect', { redirect: 'manual' });
  assert.equal(meta.status, 302, meta.texto);
  await semCookie(dono, `/api/admin/integrations/meta/callback?${new URLSearchParams({ code: `meta${letra}`, state: new URL(meta.location).searchParams.get('state') })}`);
  const contas = (await dono.req('GET', '/api/admin/integrations/meta/ad-accounts')).json.contas;
  assert.equal((await dono.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: contas[0].metaAccountId } })).status, 200);

  const ads = await dono.req('GET', '/api/admin/integrations/google-ads/oauth/start');
  assert.equal(ads.status, 200, ads.texto);
  await semCookie(dono, `/api/admin/integrations/google-analytics/callback?${new URLSearchParams({ code: `gads${letra}`, state: new URL(ads.json.url).searchParams.get('state') })}`);
  assert.equal((await dono.req('POST', `/api/admin/integrations/google-ads/contas/${CUSTOMER[letra]}/selecionar`, { corpo: {} })).status, 200);
  return { metaAccountId: contas[0].metaAccountId };
}

// Retrato do que existe de vínculo/credencial da Organization, lido direto do banco (a fonte da verdade).
async function retrato(letra) {
  const org = ORGS[letra];
  const q = async (sql) => (await sup.query(sql, [org])).rows;
  return {
    ga4: await q(`SELECT status, property_id FROM google_analytics_connections WHERE organization_id = $1 ORDER BY 1, 2`),
    meta: await q(`SELECT status FROM meta_connections WHERE organization_id = $1`),
    metaContas: await q(`SELECT meta_account_id, selecionada FROM meta_ad_accounts WHERE organization_id = $1 ORDER BY 1`),
    ads: await q(`SELECT status FROM google_ads_connections WHERE organization_id = $1`),
    adsContas: await q(`SELECT customer_id, selecionada, store_id FROM google_ads_customers WHERE organization_id = $1 ORDER BY 1`),
    segredos: await q(`SELECT i.provider, s.tipo FROM integration_secrets s JOIN integrations i ON i.id = s.integration_id WHERE i.organization_id = $1 ORDER BY 1, 2`),
  };
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_rbac_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();
  const base_ = { financial: true, analytics_ga4: true, meta_ads: true, google_ads: true, catalog: true };
  await criarOrganizacao('X', base_);
  await criarOrganizacao('Y', { ...base_, analytics_product_performance: true });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-rbac-srv-'));
  mockLog = path.join(dir, 'chamadas.jsonl');
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ORIA_JOBS_DE_FUNDO: 'off',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: mockLog,
      GOOGLE_CLIENT_ID: 'cliente-google', GOOGLE_CLIENT_SECRET: 'segredo-plataforma-google', GOOGLE_OAUTH_REDIRECT_URI: 'https://oria.test/cb',
      META_ADS_APP_ID: '123', META_ADS_APP_SECRET: 'segredo-plataforma-meta', META_ADS_OAUTH_REDIRECT_URI: 'https://oria.test/meta',
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

// As 10 rotas que criam, trocam ou revogam credencial/vínculo (mutação ou início de OAuth).
const ROTAS_DE_PROPRIETARIO = (letra) => [
  ['GET', '/api/admin/integrations/google-analytics/connect', undefined],
  ['POST', '/api/admin/integrations/google-analytics/property', { propertyId: '123', propertyName: 'x' }],
  ['POST', '/api/admin/integrations/google-analytics/disconnect', {}],
  ['GET', '/api/admin/integrations/meta/connect', undefined],
  ['POST', '/api/admin/integrations/meta/select-account', { metaAccountId: 'act_outra' }],
  ['POST', '/api/admin/integrations/meta/disconnect', {}],
  ['GET', '/api/admin/integrations/google-ads/oauth/start', undefined],
  ['POST', `/api/admin/integrations/google-ads/contas/${CUSTOMER[letra]}/selecionar`, {}],
  ['POST', `/api/admin/integrations/google-ads/contas/${CUSTOMER[letra]}/loja`, {}],
  ['POST', '/api/admin/integrations/google-ads/disconnect', {}],
];

test('D-1 · member da Org X recebe 403 OWNER_REQUIRED nas 10 rotas de credencial/vínculo, sem alterar nada e sem chamar o provedor', async () => {
  await conectarTudo('X');
  const antes = await retrato('X');
  assert.ok(antes.segredos.length >= 3 && antes.ga4.length === 1 && antes.metaContas.some((c) => c.selecionada) && antes.adsContas.some((c) => c.selecionada), 'preparo: tudo conectado');
  const externasAntes = chamadasMock().length;
  const revogAntes = revogacoes();

  const membro = await entrar('member', 'X');
  for (const [metodo, rota, corpo] of ROTAS_DE_PROPRIETARIO('X')) {
    const r = await membro.req(metodo, rota, { corpo, redirect: 'manual' });
    assert.equal(r.status, 403, `${metodo} ${rota} deveria negar ao member (403), veio ${r.status}: ${r.texto.slice(0, 120)}`);
    assert.equal(r.json && r.json.codigo, 'OWNER_REQUIRED', rota);
  }
  assert.deepEqual(await retrato('X'), antes, 'nenhuma linha de conexão, conta ou segredo mudou');
  assert.equal(revogacoes(), revogAntes, 'nenhuma revogação foi enviada ao Google');
  assert.equal(chamadasMock().length, externasAntes, 'nenhuma chamada externa foi feita para o member');
});

test('D-1 · member continua lendo e usando as ações não destrutivas (status, sincronizar, listar contas)', async () => {
  const membro = await entrar('member', 'X');
  for (const rota of ['/api/admin/integrations/google-analytics/status', '/api/admin/integrations/meta/status', '/api/admin/integrations/google-ads/status', '/api/admin/integrations']) {
    const r = await membro.req('GET', rota);
    assert.equal(r.status, 200, `${rota} → ${r.status}`);
  }
  for (const [metodo, rota] of [
    ['POST', '/api/admin/integrations/meta/sync'], ['GET', '/api/admin/integrations/meta/ad-accounts'],
    ['POST', '/api/admin/integrations/google-ads/sync'], ['POST', '/api/admin/integrations/google-ads/contas/sincronizar'],
    ['GET', '/api/admin/integrations/google-analytics/properties'],
  ]) {
    const r = await membro.req(metodo, rota, { corpo: metodo === 'POST' ? {} : undefined });
    assert.notEqual(r.status, 403, `${metodo} ${rota} não pode virar owner-only (veio ${r.status})`);
    assert.notEqual(r.status, 401, rota);
  }
});

test('D-1 · owner da Org X desconecta a PRÓPRIA Org X (GA4, Meta e Google Ads) e o Google recebe a revogação', async () => {
  const dono = await entrar('owner', 'X');
  const revogAntes = revogacoes();
  for (const rota of ['google-analytics', 'meta', 'google-ads']) {
    const r = await dono.req('POST', `/api/admin/integrations/${rota}/disconnect`, { corpo: {} });
    assert.equal(r.status, 200, `${rota}: ${r.texto}`);
  }
  const depois = await retrato('X');
  assert.ok(depois.ga4.every((c) => c.status !== 'connected'), 'GA4 desconectado');
  assert.ok(depois.meta.every((c) => c.status !== 'connected'), 'Meta desconectada');
  assert.ok(depois.ads.every((c) => c.status !== 'connected') && depois.adsContas.every((c) => !c.selecionada), 'Google Ads desconectado');
  assert.equal(depois.segredos.length, 0, 'segredos removidos');
  assert.ok(revogacoes() > revogAntes, 'o token do Google foi revogado (GA4/Google Ads)');
});

test('D-1 · owner e member da Org Y não alteram as conexões da Org X (nem por seletor de Organization forjado)', async () => {
  await conectarTudo('X');
  const antes = await retrato('X');
  for (const papel of ['owner', 'member']) {
    const alheio = await entrar(papel, 'Y');
    for (const [metodo, rota, corpo] of ROTAS_DE_PROPRIETARIO('X')) {
      if (metodo === 'GET') continue;
      const comSeletor = `${rota}?organization_id=${ORGS.X}`;
      const a = await alheio.req(metodo, comSeletor, { corpo });
      assert.ok(a.status >= 400, `${papel} Y ${metodo} ${comSeletor} não pode dar certo (veio ${a.status})`);
      const b = await alheio.req(metodo, rota, { corpo, headers: { 'X-Organization-Id': ORGS.X } });
      assert.ok(b.status >= 400, `${papel} Y ${metodo} ${rota} com header forjado não pode dar certo (veio ${b.status})`);
    }
    // Sem seletor: o owner de Y só atua em Y (a desconexão dele não encosta em X).
    if (papel === 'owner') for (const rota of ['google-analytics', 'meta', 'google-ads']) await alheio.req('POST', `/api/admin/integrations/${rota}/disconnect`, { corpo: {} });
  }
  assert.deepEqual(await retrato('X'), antes, 'a Org X ficou intacta');
});

// ── D-2 ──────────────────────────────────────────────────────────────────────────────────────

test('D-2 · sem analytics_product_performance: 403 nas rotas do catálogo de análises e nenhuma operação executada; o catálogo genérico segue disponível', async () => {
  const dono = await entrar('owner', 'X');
  assert.equal((await dono.req('GET', '/api/admin/entitlements')).json.analytics_product_performance, false);
  const rodadasAntes = (await sup.query('SELECT count(*)::int AS n FROM commerce_catalog_sync_logs WHERE organization_id = $1', [ORGS.X])).rows[0].n;
  const externasAntes = chamadasMock().length;
  for (const [metodo, rota] of [
    ['GET', '/api/admin/product-analytics/catalog-sync/status'],
    ['POST', '/api/admin/product-analytics/catalog-sync'],
    ['POST', '/api/admin/product-analytics/catalog-sync/cancelar'],
  ]) {
    const r = await dono.req(metodo, rota, { corpo: metodo === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${metodo} ${rota} → ${r.status}`);
    assert.equal(r.json && r.json.erro, 'feature_nao_disponivel', rota);
  }
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM commerce_catalog_sync_logs WHERE organization_id = $1', [ORGS.X])).rows[0].n, rodadasAntes, 'nenhum sync foi registrado');
  assert.equal(chamadasMock().length, externasAntes, 'nenhuma chamada à Ink foi feita');
  // O catálogo genérico (busca de produtos) não é da feature de análises.
  assert.equal((await dono.req('GET', '/api/admin/produtos/catalogo/status')).status, 200);
});

test('D-2 · com analytics_product_performance (Org Y): o status do catálogo de análises responde 200; as Organizations não trocam de plano', async () => {
  const donoY = await entrar('owner', 'Y');
  assert.equal((await donoY.req('GET', '/api/admin/entitlements')).json.analytics_product_performance, true);
  assert.equal((await donoY.req('GET', '/api/admin/product-analytics/catalog-sync/status')).status, 200);
  // Alternância no mesmo navegador: dono de X e dono de Y têm sessões e planos próprios.
  const donoX = await entrar('owner', 'X');
  assert.equal((await donoX.req('GET', '/api/admin/entitlements')).json.analytics_product_performance, false);
  assert.equal((await donoY.req('GET', '/api/admin/entitlements')).json.analytics_product_performance, true);
});
