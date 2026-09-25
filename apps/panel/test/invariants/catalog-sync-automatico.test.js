'use strict';

// Gate A/B ("Jornada de Valor Operacional") · sincronização automática do catálogo fim a fim, no
// processo REAL do server.js: conectar a Ink dispara o full sync SEM CLIQUE nenhum (achado real da
// rodada anterior: só existia o botão manual), e o full sync bem-sucedido dispara o bootstrap de
// identity sozinho (achado desta rodada: bootstrapCommerceIdentities só rodava em teste). Ink real
// via test/helpers/provider-mock.cjs — mesmo mock que catalog-sync.test.js/product-analytics-http.
// test.js já usam, aqui com credencial de VERDADE (tag 'A', 3 produtos fixos, 1 página só).

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
const { concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
// Wrapper aditivo (nunca modifica o compartilhado) — ver o próprio arquivo pro porquê: o fixture
// padrão da Ink usa os mesmos ids de variante em todo produto, o que colide só quando um full
// catalog sync faz upsert em lote de verdade (nenhum outro teste hoje exercita esse caminho).
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock-ink-catalogo-unico.cjs');
const ORG_A = 'c1000000-0000-4000-8000-000000000001';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_csa_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
// 4º caractere 'A' → FAIXA_INK.A no mock (provider-mock.cjs): 3 produtos fixos, 1 página só —
// prova o full sync sem depender de paginação real da Ink (isso já tem cobertura própria em
// catalog-sync.test.js/ink-orders-repository.test.js).
const TOKEN_INK_A = 'inkA-teste-token-1234567890abcdef';

let db;
let sup;
let filho;
let base;

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, opcoes = {}) => {
    const hd = { ...(opcoes.headers || {}) };
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (metodo !== 'GET' && nav.csrf) hd['X-CSRF-Token'] = nav.csrf;
    let body;
    if (opcoes.body !== undefined) { hd['Content-Type'] = 'application/json'; body = JSON.stringify(opcoes.body); }
    const res = await fetch(base + caminho, { method: metodo, headers: hd, body });
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
    const json = JSON.parse(texto);
    if (json.csrfToken) nav.csrf = json.csrfToken;
    return nav;
  };
  return nav;
}

async function criarPessoa(email, org, papel) {
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]
  );
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
  return u.id;
}

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

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_catalog_sync_auto');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }

  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG_A, 'Gate A/B automático']);
  await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES (gen_random_uuid(), $1, $2, NULL)',
    [ORG_A, 'Gate A/B automático']
  );
  await criarPessoa('csa-owner@teste.oria', ORG_A, 'owner');
  await concederFeatures(sup, ORG_A, ['analytics_product_performance']);

  const mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-csa-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-csa-srv-'));
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

test('A/B · PUT /integrations/ink/credenciais (primeira conexão) dispara o catalog sync SOZINHO — sem clicar em nenhum botão — e o sync bem-sucedido bootstrapa identity sozinho', async () => {
  const nav = await navegador().entrar('csa-owner@teste.oria');

  const antes = await nav.req('GET', '/api/admin/product-analytics/catalog-sync/status');
  assert.equal(antes.status, 200, antes.texto);
  assert.equal(antes.json.state, 'never_synced');

  const conectar = await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { body: { apiToken: TOKEN_INK_A } });
  assert.equal(conectar.status, 200, conectar.texto);
  assert.equal(conectar.json.status, 'connected');

  // NINGUÉM chamou POST /catalog-sync nem clicou em botão nenhum — só conectou a credencial.
  const status = await esperar(async () => {
    const r = await nav.req('GET', '/api/admin/product-analytics/catalog-sync/status');
    assert.equal(r.status, 200, r.texto);
    return r.json.lastRun && r.json.lastRun.status !== 'running' ? r.json : null;
  });
  assert.equal(status.state, 'completed');
  assert.equal(status.lastRun.status, 'success');
  assert.equal(status.lastRun.productsInserted, 3); // FAIXA_INK.A no mock: 3 produtos fixos

  // Gate B: bootstrapCommerceIdentities rodou sozinho depois do sync — ninguém chamou
  // resolveAndPersist nem bootstrap manualmente. Consulta direta (RLS bypassed pelo pool super) por
  // simplicidade — a rota HTTP que EXIBE identity (GET /products) também exige GA4 conectado, fora
  // do escopo deste teste (GA4↔identity já tem cobertura própria em product-analytics-http.test.js).
  const { rows: identidades } = await sup.query(
    `SELECT namespace, external_id FROM product_external_identities WHERE organization_id = $1 AND source = 'commerce_sync'`,
    [ORG_A]
  );
  assert.ok(identidades.length >= 3, `esperava pelo menos 3 identities (product_id) automáticas, achou ${identidades.length}`);
  assert.ok(identidades.every((i) => i.namespace === 'reserva_ink.product_id' || i.namespace === 'reserva_ink.variant_id' || i.namespace === 'sku'));
});

test('A/B · PUT /integrations/ink/credenciais SEM apiToken (só feedUrl, integração já conectada) NÃO dispara um novo sync', async () => {
  const nav = await navegador().entrar('csa-owner@teste.oria');

  const antes = await nav.req('GET', '/api/admin/product-analytics/catalog-sync/status');
  assert.equal(antes.status, 200, antes.texto);
  const startedAtAntes = antes.json.lastRun && antes.json.lastRun.startedAt; // run do teste anterior

  const atualizar = await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { body: { feedUrl: 'https://reserva.ink/feed.xml' } });
  assert.equal(atualizar.status, 200, atualizar.texto);

  // Dá um tempo curto pro fire-and-forget (se existisse) começar/terminar (o sync do mock é rápido —
  // 1 página, 3 produtos), e confere que NENHUM run novo apareceu — `startedAt` do último run
  // continua EXATAMENTE o mesmo timestamp (nunca "status também success" só por coincidência: um
  // run novo indevido teria um startedAt mais recente, mesmo terminando com o mesmo status).
  await new Promise((res) => setTimeout(res, 800));
  const depois = await nav.req('GET', '/api/admin/product-analytics/catalog-sync/status');
  assert.equal(depois.status, 200, depois.texto);
  assert.equal(depois.json.syncing, false);
  assert.equal(depois.json.lastRun.startedAt, startedAtAntes, 'reconectar sem apiToken novo não pode disparar um sync novo');
});
