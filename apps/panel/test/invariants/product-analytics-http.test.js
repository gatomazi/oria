'use strict';

// Fase H (rodada H→I) · superfície HTTP de Product Analytics no processo REAL do server.js —
// auth (401), entitlement real via plano/assinatura (403), tenant da sessão (nunca do cliente),
// validação de entrada (400), estados estáveis de integração (GA4 desconectado), isolamento entre
// Organizations, cache reaproveitado entre requests HTTP e reconciliação pré-19/08/2026.
//
// GA4 real via test/helpers/provider-mock.cjs (extensão Product Analytics: metadata/
// checkCompatibility/runReport item-scoped — ver o arquivo). Ink não entra aqui: a capability
// `orders` só é exercida com pedidos locais, fora do escopo deste smoke HTTP (cobertura própria em
// test/invariants/ink-orders-repository.test.js/reconciliation.test.js).

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
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const { bootstrapCommerceIdentities } = h.sujeito('lib/product-analytics/product-identity-resolver.js');
const { concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const ORG_A = 'b1000000-0000-4000-8000-000000000001';
const ORG_B = 'b1000000-0000-4000-8000-000000000002';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_pah_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
// `single-B` → 1 propriedade só (analyticsadmin.googleapis.com mock: quantidade vem do refresh
// token — ver provider-mock.cjs); o property_id real vem do mock de analyticsadmin, mas aqui
// gravamos o property_id direto em google_analytics_connections (mesma tabela que o fluxo OAuth
// legítimo grava — não simulamos o OAuth completo, só o estado final "conectado com property").
const GA4_REFRESH = { [ORG_A]: '1//rt-mockA-single-a', [ORG_B]: '1//rt-mockB-single-b' };

let db;
let sup;
let filho;
let base;
let mockLog;
let stores;

const chamadasMock = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const em = (org, fn) => runtime.comContexto({ organizationId: org, storeId: stores[org], origem: 'teste' }, fn);

async function criarPessoa(email, org, papel) {
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]
  );
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
  return u.id;
}

function navegador() {
  // `csrf`: Rodada M — só usado pelos testes de POST /catalog-sync (as rotas GET pré-existentes
  // nunca precisaram); capturado do login, igual ao padrão já usado nos outros arquivos de teste
  // deste repo (auth-flow.test.js etc.) — ver CSRF_HEADER em lib/auth/middleware.js.
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho) => {
    const hd = {};
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (metodo !== 'GET' && nav.csrf) hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers: hd });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: res.status, json, texto };
  };
  nav.entrar = async (email) => {
    const r = await fetch(`${base}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: SENHA }),
    });
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) nav.cookie = setCookie.split(';')[0];
    const texto = await r.text();
    assert.equal(r.status, 200, texto);
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return nav;
  };
  return nav;
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_pa_http');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const fachada = runtime.criarPoolTenant(sup);
  const resolver = createIntegrationResolver({
    pool: fachada, segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {}, logger: { warn() {}, error() {} },
  });

  stores = {};
  for (const org of [ORG_A, ORG_B]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Org ${org.slice(-1)}`]);
    const { rows: [s] } = await sup.query(
      'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES (gen_random_uuid(), $1, $2, NULL) RETURNING id',
      [org, `Org ${org.slice(-1)}`]
    );
    stores[org] = s.id;
  }

  // ORG_A: GA4 conectado com property. ORG_B: sem credencial GA4 nenhuma (estado "desconectado").
  await runtime.comContexto({ organizationId: ORG_A, storeId: stores[ORG_A], origem: 'teste' }, async () => {
    await resolver.gravarSegredo('ga4', 'refresh_token', GA4_REFRESH[ORG_A]);
  });
  await sup.query(
    `INSERT INTO google_analytics_connections (organization_id, store_id, property_id, property_name, status)
     VALUES ($1, $2, '5551234567', 'Site A', 'connected')`,
    [ORG_A, stores[ORG_A]]
  );
  // Produto canônico cujo provider_product_id é EXATAMENTE o item id que o mock do runReport
  // devolve (sku-mock-<propertyId>) — prova de identity resolvida ponta a ponta pelo HTTP.
  await sup.query(
    `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
     VALUES ($1, $2, 'reserva_ink', 'sku-mock-5551234567', 'Produto Mock', gen_random_uuid())`,
    [ORG_A, stores[ORG_A]]
  );
  await runtime.comContexto({ organizationId: ORG_A, storeId: stores[ORG_A], origem: 'teste' }, () => bootstrapCommerceIdentities({ pool: fachada }, { organizationId: ORG_A, storeId: stores[ORG_A], provider: 'reserva_ink' }));

  await criarPessoa('pah-a@teste.oria', ORG_A, 'owner');
  await criarPessoa('pah-a-sem-feature@teste.oria', ORG_A, 'owner'); // Organization própria, sem entitlement — ver abaixo
  await criarPessoa('pah-b@teste.oria', ORG_B, 'owner');
  await concederFeatures(sup, ORG_A, ['analytics_product_performance']);
  // ORG_B recebe a Organization mas NUNCA a feature — prova o guard real (403), não navegação escondida.

  mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-pah-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-pah-srv-'));
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
    },
  }), { limiteMs: 30000 });
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

const PERIODO = 'startDate=2026-09-01&endDate=2026-09-20';

// ── Auth / entitlement / tenant ───────────────────────────────────────────────────────────────

test('H · sem sessão: 401', async () => {
  const nav = navegador();
  const r = await nav.req('GET', `/api/admin/product-analytics/products?${PERIODO}`);
  assert.equal(r.status, 401);
});

test('H · autenticado sem a feature: 403 feature_nao_disponivel (guard real, não navegação escondida)', async () => {
  const nav = await navegador().entrar('pah-b@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/products?${PERIODO}`);
  assert.equal(r.status, 403);
  assert.equal(r.json.feature, 'analytics_product_performance');
});

test('H · tenant vem da sessão: organization_id no query é 400, nunca usado como autorização', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/products?${PERIODO}&organization_id=${ORG_B}`);
  assert.equal(r.status, 400);
  assert.equal(r.json.codigo, 'TENANT_SELECTOR_NOT_ALLOWED');
});

// ── Validação de entrada ──────────────────────────────────────────────────────────────────────

test('H · datas ausentes/ inválidas/ invertidas: 400 estável, nunca 500', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  for (const qs of ['', 'startDate=2026-09-20&endDate=2026-09-01', 'startDate=lixo&endDate=2026-09-20', "startDate=2026-09-01';--&endDate=2026-09-20"]) {
    const r = await nav.req('GET', `/api/admin/product-analytics/products?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.json.codigo, 'PRODUCT_ANALYTICS_INVALID_INPUT');
  }
});

test('H · sort fora do whitelist: 400', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/products?${PERIODO}&sort=nome_bonito`);
  assert.equal(r.status, 400);
});

test('H · limit fora do intervalo: 400', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/products?${PERIODO}&limit=99999`);
  assert.equal(r.status, 400);
});

test('H · productId que não é UUID: 400 (nunca chega no banco como texto livre)', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/products/nao-e-um-uuid?${PERIODO}`);
  assert.equal(r.status, 400);
});

// ── Estado de integração estável (GA4 desconectado nunca é 500) ──────────────────────────────

test('H · GA4 desconectado: /status devolve connected:false (200, nunca 500)', async () => {
  const nav = await navegador().entrar('pah-b@teste.oria'); // ORG_B nunca teve credencial GA4
  await concederFeatures(sup, ORG_B, ['analytics_product_performance']); // só pra este teste isolar o estado do GA4, não o entitlement
  const r = await nav.req('GET', '/api/admin/product-analytics/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.analytics.connected, false);
});

test('H · GA4 desconectado: /products devolve 409 estável com código, nunca 500 genérico', async () => {
  const nav = await navegador().entrar('pah-b@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/products?${PERIODO}`);
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'INTEGRATION_NOT_CONNECTED');
});

// ── Fluxo real com GA4 conectado: DTO, identity, cache entre requests HTTP ──────────────────────

test('H · GA4 conectado: /status devolve apt=true', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', '/api/admin/product-analytics/status');
  assert.equal(r.status, 200);
  assert.equal(r.json.analytics.connected, true);
  assert.equal(r.json.analytics.apt, true);
});

test('H · /products: DTO estável, identity resolvida ponta a ponta, nenhum token na resposta', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/products?${PERIODO}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.items.length, 1);
  const item = r.json.items[0];
  assert.equal(item.product.providerProductId, 'sku-mock-5551234567');
  assert.equal(item.identity.status, 'matched');
  assert.ok(item.metrics);
  assert.ok(item.itemRatios);
  assert.equal(r.texto.includes(GA4_REFRESH[ORG_A]), false);
  assert.equal(r.texto.includes('ya29.'), false); // access token derivado também nunca aparece
});

test('H · cache reaproveitado entre requests HTTP: 2ª chamada dentro do TTL não bate no Google de novo', async () => {
  // Período PRÓPRIO deste teste (nunca usado por outro) — garante cache frio de verdade no início,
  // em vez de assumir que nenhum teste anterior já aqueceu o cache do mesmo período/escopo.
  const periodoProprio = 'startDate=2026-09-02&endDate=2026-09-21';
  const nav = await navegador().entrar('pah-a@teste.oria');
  const antes = chamadasMock().filter((c) => c.host === 'analyticsdata.googleapis.com').length;
  await nav.req('GET', `/api/admin/product-analytics/products?${periodoProprio}`);
  const depoisDaPrimeira = chamadasMock().filter((c) => c.host === 'analyticsdata.googleapis.com').length;
  assert.ok(depoisDaPrimeira > antes, 'a primeira chamada deveria bater no Google (período próprio deste teste, nunca cacheado antes)');
  await nav.req('GET', `/api/admin/product-analytics/products?${periodoProprio}`);
  const depoisDaSegunda = chamadasMock().filter((c) => c.host === 'analyticsdata.googleapis.com').length;
  assert.equal(depoisDaSegunda, depoisDaPrimeira, 'a 2ª chamada HTTP, mesmo período, não deveria bater no Google de novo (ReportCache do processo, não por request)');
});

test('H · /coverage reaproveita o MESMO cache de /products (mesmo escopo/período)', async () => {
  const periodoProprio = 'startDate=2026-09-03&endDate=2026-09-22';
  const nav = await navegador().entrar('pah-a@teste.oria');
  await nav.req('GET', `/api/admin/product-analytics/products?${periodoProprio}`); // garante cache quente
  const antes = chamadasMock().filter((c) => c.host === 'analyticsdata.googleapis.com').length;
  const r = await nav.req('GET', `/api/admin/product-analytics/coverage?${periodoProprio}`);
  assert.equal(r.status, 200);
  assert.ok(r.json.coverage);
  assert.equal(chamadasMock().filter((c) => c.host === 'analyticsdata.googleapis.com').length, antes);
});

test('J.4 · /summary devolve observed E matched store-wide, nunca só a página visível', async () => {
  const periodoProprio = 'startDate=2026-09-04&endDate=2026-09-23';
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/summary?${periodoProprio}`);
  assert.equal(r.status, 200, r.texto);
  assert.ok(r.json.observed, 'observed deveria vir preenchido (há 1 produto com dado no mock)');
  assert.ok(r.json.matched);
  assert.equal(r.json.observed.itemsViewed, r.json.matched.itemsViewed); // só 1 produto, tudo resolvido: os dois batem
  assert.ok(r.json.coverage);
  assert.equal(r.texto.includes(GA4_REFRESH[ORG_A]), false);
});

test('J.4 · /summary reaproveita o MESMO cache de /products (mesmo escopo/período)', async () => {
  const periodoProprio = 'startDate=2026-09-05&endDate=2026-09-24';
  const nav = await navegador().entrar('pah-a@teste.oria');
  await nav.req('GET', `/api/admin/product-analytics/products?${periodoProprio}`); // garante cache quente
  const antes = chamadasMock().filter((c) => c.host === 'analyticsdata.googleapis.com').length;
  const r = await nav.req('GET', `/api/admin/product-analytics/summary?${periodoProprio}`);
  assert.equal(r.status, 200);
  assert.equal(chamadasMock().filter((c) => c.host === 'analyticsdata.googleapis.com').length, antes);
});

test('H · GET /products/:productId devolve a mesma identidade e 404 pra produto de outra Organization', async () => {
  const navA = await navegador().entrar('pah-a@teste.oria');
  const lista = await navA.req('GET', `/api/admin/product-analytics/products?${PERIODO}`);
  const productId = lista.json.items[0].product.id;

  const detalhe = await navA.req('GET', `/api/admin/product-analytics/products/${productId}?${PERIODO}`);
  assert.equal(detalhe.status, 200);
  assert.equal(detalhe.json.product.id, productId);

  const navB = await navegador().entrar('pah-b@teste.oria');
  const cruzado = await navB.req('GET', `/api/admin/product-analytics/products/${productId}?${PERIODO}`);
  assert.equal(cruzado.status, 404);
});

// ── K (Journey Analytics) ──────────────────────────────────────────────────────────────────────

test('K · GET /journey: cada tier reporta available/reason próprio — nunca 500 por uma fonte indisponível (Ink/Meta não conectados neste smoke)', async () => {
  const periodoProprio = 'startDate=2026-09-06&endDate=2026-09-25';
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/journey?${periodoProprio}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.tier1.funnel.available, true, 'GA4 mock tem dado real de item — funil deveria estar disponível');
  assert.equal(r.json.tier1.acquisition.available, true, 'GA4 mock aceita as dimensões de aquisição (checkCompatibility sempre compatível no mock)');
  assert.equal(r.json.tier1.adsInvestment.available, false); // nenhuma conta Meta selecionada neste smoke
  assert.equal(r.json.tier1.adsInvestment.reason, 'META_NOT_CONNECTED');
  assert.equal(r.json.tier1.adsInvestment.status, 'not_connected'); // L §2.2: taxonomia normalizada
  assert.equal(r.json.tier1.confirmedOrders.available, false); // Ink nunca conectado neste smoke
  assert.equal(r.json.tier1.confirmedOrders.status, 'not_connected');
  assert.equal(r.json.tier2.transactionOrderLink.available, false);
  // L: tier2 herda o MESMO status/reason de tier1.confirmedOrders — nunca "falha temporária" pra
  // um estado normal de "nunca conectado" (achado real do smoke visual da Rodada L).
  assert.equal(r.json.tier2.transactionOrderLink.status, 'not_connected');
  assert.equal(r.json.tier2.transactionOrderLink.reason, r.json.tier1.confirmedOrders.reason);
  assert.equal(r.json.tier3.individualJourney.available, false);
  assert.equal(r.json.tier3.individualJourney.reason, 'NO_EVENT_ANALYTICS_SOURCE_CONFIGURED');
  assert.equal(r.json.attribution.length, 3);
  assert.equal(r.texto.includes(GA4_REFRESH[ORG_A]), false);
});

test('L · GET /journey/transaction-link: providerOrderId ausente/inválido → 400, nunca chega no service', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const semId = await nav.req('GET', `/api/admin/product-analytics/journey/transaction-link?${PERIODO}`);
  assert.equal(semId.status, 400);
  const idInvalido = await nav.req('GET', `/api/admin/product-analytics/journey/transaction-link?${PERIODO}&providerOrderId=${encodeURIComponent('; DROP TABLE x;')}`);
  assert.equal(idInvalido.status, 400);
});

test('L · GET /journey/transaction-link: Commerce não conectado → not_connected, nunca 500 (Ink não conectado neste smoke)', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/journey/transaction-link?${PERIODO}&providerOrderId=qualquer-id-123`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.available, false);
  assert.equal(r.json.status, 'not_connected');
});

test('K · GET /journey: período anterior a 19/08/2026 → insufficient_data (mesmo gate da reconciliação)', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', '/api/admin/product-analytics/journey?startDate=2026-07-01&endDate=2026-08-01');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'insufficient_data');
  assert.equal(r.json.reason, 'LOCAL_ORDERS_HISTORY_STARTS_LATER');
});

// ── Gate C ("Jornada de Valor") · GET /journey/opportunities ─────────────────────────────────────
// Wiring fim a fim no processo REAL (auth/entitlement/validação/status de fonte); a matemática de
// baseline/desvio/score/limiar tem cobertura própria e exaustiva, pura, em
// opportunity-diagnostics.test.js — aqui o alvo é só provar que a rota está montada e degrada
// honestamente por fonte, como toda rota deste arquivo.

test('C · GET /journey/opportunities: sem sessão → 401', async () => {
  const nav = navegador();
  const r = await nav.req('GET', `/api/admin/product-analytics/journey/opportunities?${PERIODO}`);
  assert.equal(r.status, 401);
});

test('C · GET /journey/opportunities: limit fora do intervalo (1-20) → 400', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const zero = await nav.req('GET', `/api/admin/product-analytics/journey/opportunities?${PERIODO}&limit=0`);
  assert.equal(zero.status, 400);
  const grande = await nav.req('GET', `/api/admin/product-analytics/journey/opportunities?${PERIODO}&limit=21`);
  assert.equal(grande.status, 400);
});

test('C · GET /journey/opportunities: GA4 conectado (ORG_A) mas Commerce nunca conectado — productFunnel available, commerceReconciliation not_connected, nunca 500/409 pela fonte que falta', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/journey/opportunities?${PERIODO}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.sources.productFunnel.available, true);
  assert.equal(r.json.sources.commerceReconciliation.available, false);
  assert.equal(r.json.sources.commerceReconciliation.status, 'not_connected');
  // Catálogo do fixture (ver test.before) tem 1 produto só: sem outro pra comparar, a mediana da
  // Store é o próprio produto — desvio zero, nenhuma oportunidade fabricada por falta de baseline.
  assert.deepEqual(r.json.opportunities, []);
  assert.equal(Array.isArray(r.json.opportunities), true);
});

test('C · GET /journey/opportunities: respeita `limit` na config devolvida (nunca hardcoded)', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', `/api/admin/product-analytics/journey/opportunities?${PERIODO}&limit=2`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.config.limit, 2);
});

// ── M · Catalog sync (achado real: runCatalogSync nunca tinha gatilho em produção) ──────────────
// Processo REAL do server.js, Postgres real — nada mockado aqui além do GA4 (provider-mock.cjs, já
// carregado pelo próprio processo). Ink NUNCA está conectado por ORG_A neste arquivo (ver
// test.before) — de propósito: prova que um catalog sync real, fim a fim (lease → log → registry →
// connector → falha → log fechado), nunca derruba o processo nem deixa o run "running" pra sempre.

async function esperar(condFn, { timeoutMs = 20000, intervalMs = 200 } = {}) {
  const inicio = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const r = await condFn();
    if (r) return r;
    if (Date.now() - inicio > timeoutMs) throw new Error('esperar: timeout sem a condição satisfeita');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

test('M · POST /catalog-sync: sem sessão → 401', async () => {
  const nav = navegador();
  const r = await nav.req('POST', '/api/admin/product-analytics/catalog-sync');
  assert.equal(r.status, 401);
});

test('M · POST /catalog-sync: autenticado sem X-CSRF-Token → 403 codigo csrf (mesma proteção de toda escrita — lib/auth/middleware.js)', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  nav.csrf = null; // simula um client que não mandou o header
  const r = await nav.req('POST', '/api/admin/product-analytics/catalog-sync');
  assert.equal(r.status, 403);
  assert.equal(r.json.codigo, 'csrf');
});

// (sem teste "POST sem a feature" isolado aqui: `requireAdmin` aplica featureDaRota por PREFIXO de
// caminho, sem ramo por método — já provado pela suíte GET acima; e ORG_B ganha a feature ainda
// nesta suíte, mais abaixo, só pra isolar o teste de GA4 desconectado — reusar ORG_B aqui depois
// disso testaria o estado errado.)

test('M · GET /catalog-sync/status antes de qualquer sync: syncing:false, lastRun:null (nunca 404/500)', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', '/api/admin/product-analytics/catalog-sync/status');
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json, { syncing: false, lastRun: null });
});

test('M · POST /catalog-sync dispara na hora (fire-and-forget) e o run fecha REAL no log — falha de Ink vira status:failed com código estável, nunca 500 nem "running" pra sempre', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');

  const disparo = await nav.req('POST', '/api/admin/product-analytics/catalog-sync');
  assert.equal(disparo.status, 200, disparo.texto);
  assert.deepEqual(disparo.json, { ok: true, status: 'started' });

  const status = await esperar(async () => {
    const r = await nav.req('GET', '/api/admin/product-analytics/catalog-sync/status');
    assert.equal(r.status, 200, r.texto);
    return r.json.lastRun && r.json.lastRun.status !== 'running' ? r.json : null;
  });
  assert.equal(status.syncing, false);
  assert.equal(status.lastRun.status, 'failed');
  assert.equal(status.lastRun.errorCode, 'INTEGRATION_NOT_CONNECTED'); // registry.resolve → integrations.js: naoConectada()
  assert.equal(status.lastRun.pagesProcessed, 0);
  assert.equal(status.lastRun.productsSeen, 0);
  assert.equal(status.lastRun.finishedAt !== null, true);
});

test('M · POST /catalog-sync: 2ª chamada em voo com a 1ª ainda rodando → already_running (guard em processo — nunca 2 runs simultâneos da mesma Organization)', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  // Concorrente de propósito: o guard (Set em memória, ver http-routes.js) só protege entre o
  // `add()` síncrono e o `.finally()` assíncrono de syncCommerceCatalog — a janela real é o tempo
  // de lease+log+registry.resolve contra o Postgres real, bem maior que o intervalo entre as duas
  // chamadas fetch() abaixo.
  const [r1, r2] = await Promise.all([
    nav.req('POST', '/api/admin/product-analytics/catalog-sync'),
    nav.req('POST', '/api/admin/product-analytics/catalog-sync'),
  ]);
  assert.equal(r1.status, 200, r1.texto);
  assert.equal(r2.status, 200, r2.texto);
  const statuses = [r1.json.status, r2.json.status].sort();
  assert.deepEqual(statuses, ['already_running', 'started']);

  // Nunca deixa o guard em processo preso: espera o run terminar antes do teste seguinte reusar ORG_A.
  await esperar(async () => {
    const r = await nav.req('GET', '/api/admin/product-analytics/catalog-sync/status');
    return r.json.syncing === false ? true : null;
  });
});

// ── Reconciliação ──────────────────────────────────────────────────────────────────────────────

test('H · reconciliação com período anterior a 19/08/2026: insufficient_data, sem tentar comparar', async () => {
  const nav = await navegador().entrar('pah-a@teste.oria');
  const r = await nav.req('GET', '/api/admin/product-analytics/reconciliation?startDate=2026-07-01&endDate=2026-08-01');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'insufficient_data');
  assert.equal(r.json.reason, 'LOCAL_ORDERS_HISTORY_STARTS_LATER');
});

// ── Guarda estática: nenhuma dependência Ink/GA4 concreto nos HANDLERS HTTP novos ────────────────
// (composition.js é o wiring — sabe dos dois de propósito; http-routes.js, não.)

test('H · lib/product-analytics/http-routes.js não importa Ink nem cliente GA4 concreto', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const arq = path.join(__dirname, '..', '..', 'lib', 'product-analytics', 'http-routes.js');
  const achados = [];
  fs.readFileSync(arq, 'utf8').split('\n').forEach((l, i) => {
    if (l.trimStart().startsWith('//')) return;
    if (/reserva[_-]?ink|InkClient|inkApi|Ga4Client|require\([^)]*ga4\/(client|connector)['"]\)|pedidos_ink\b/i.test(l)) {
      achados.push(`${i + 1}: ${l.trim()}`);
    }
  });
  assert.deepEqual(achados, []);
});
