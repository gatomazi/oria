'use strict';

// Rodada "período global nas telas de mídia": Google Ads (dashboard/analytics/google-ads/overview)
// e Custos de API (dashboard/financeiro/custos-api) ganharam startDate/endDate explícitos, pelo
// MESMO `resolverPeriodoDashboard` já exaustivamente testado nos endpoints do Dashboard
// (store-nativa-dogfooding.test.js) — aqui só prova que os DOIS call sites novos usam o recorte
// corretamente: endDate é um limite REAL (exclui o dia seguinte), não só o início.

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
const { inserir, limparCache, concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG = 'f6000000-0000-4000-8000-000000000001';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_perexp_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const EMAIL = 'perexp@teste.oria';
const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ONTEM = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 86_400_000));

let db;
let sup;
let filho;
let saida = '';
let base;
let store;

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_perexp_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();

  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG, 'Tenant período explícito']);
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id',
    [crypto.randomUUID(), ORG, 'Loja período explícito']
  );
  store = s.id;
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [EMAIL, await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [ORG, u.id]);
  await concederFeatures(sup, ORG, { financial: true, google_ads: true, whatsapp: true, catalog: true });

  // Google Ads: 1 conta selecionada, atribuída à Store, com custo em DOIS dias diferentes.
  await inserir(sup, 'google_ads_customers', { organization_id: ORG, customer_id: '9990001', selecionada: true, store_id: store, loja_atribuida: null });
  await inserir(sup, 'google_ads_insights_daily', {
    organization_id: ORG, customer_id: '9990001', level: 'customer', entidade_id: '9990001', data: HOJE, contagem_conversao: 'conversions', custo: 20,
  });
  await inserir(sup, 'google_ads_insights_daily', {
    organization_id: ORG, customer_id: '9990001', level: 'customer', entidade_id: '9990001', data: ONTEM, contagem_conversao: 'conversions', custo: 50,
  });

  // Custos de API: 2 mensagens de WhatsApp Web enviadas em dias diferentes.
  await inserir(sup, 'whatsapp_web_outbox', { organization_id: ORG, status: 'sent', sent_at: `${HOJE}T10:00:00Z`, origem: 'campanha' });
  await inserir(sup, 'whatsapp_web_outbox', { organization_id: ORG, status: 'sent', sent_at: `${ONTEM}T10:00:00Z`, origem: 'campanha' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-perexp-srv-'));
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      GOOGLE_CLIENT_ID: 'cliente-google', GOOGLE_CLIENT_SECRET: 'segredo-plataforma-google', GOOGLE_OAUTH_REDIRECT_URI: 'https://oria.test/cb',
    },
  }), {
    aoLer: (pedaco, { reiniciando }) => { saida = reiniciando ? '' : saida + pedaco; },
    limiteMs: 30000,
  });
  filho = processo.filho;
  base = processo.base;
});

test.after(async () => {
  filho?.kill();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

async function entrar() {
  const res = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: SENHA }), signal: AbortSignal.timeout(8000),
  });
  assert.equal(res.status, 200, await res.text());
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : null;
  return async (caminho) => {
    const r = await fetch(base + caminho, { headers: cookie ? { Cookie: cookie } : {}, signal: AbortSignal.timeout(8000) });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    return { status: r.status, json, texto };
  };
}

test('Google Ads overview · startDate=endDate=hoje mostra só o custo de hoje; endDate é limite real', async () => {
  const req = await entrar();
  const soHoje = await req(`/api/admin/analytics/google-ads/overview?startDate=${HOJE}&endDate=${HOJE}`);
  assert.equal(soHoje.status, 200, soHoje.texto);
  assert.equal(soHoje.json.conectado, true);
  assert.equal(soHoje.json.de, HOJE);
  assert.equal(soHoje.json.ate, HOJE);
  assert.deepEqual(soHoje.json.serie.map((s) => s.data), [HOJE]);
  assert.equal(soHoje.json.total.custo, 20, 'o custo de ontem (50) não pode vazar pro dia de hoje sozinho');

  const doisDias = await req(`/api/admin/analytics/google-ads/overview?startDate=${ONTEM}&endDate=${HOJE}`);
  assert.equal(doisDias.status, 200, doisDias.texto);
  assert.equal(doisDias.json.total.custo, 70, 'os dois dias somados, igual ao `dias=2` de sempre');
});

test('Google Ads overview · startDate/endDate inválidos caem no `dias` legado, sem erro', async () => {
  const req = await entrar();
  const r = await req('/api/admin/analytics/google-ads/overview?startDate=lixo&endDate=2020-01-01&dias=2');
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.de, ONTEM);
  assert.equal(r.json.ate, HOJE);
  assert.equal(r.json.total.custo, 70);
});

test('Custos de API · startDate=endDate=hoje conta só a mensagem de hoje; endDate é limite real', async () => {
  const req = await entrar();
  const soHoje = await req(`/api/admin/financeiro/custos-api?startDate=${HOJE}&endDate=${HOJE}`);
  assert.equal(soHoje.status, 200, soHoje.texto);
  assert.equal(soHoje.json.startDate, HOJE);
  assert.equal(soHoje.json.endDate, HOJE);
  assert.equal(soHoje.json.whatsapp.semCustoDeApi, 1, 'só a mensagem de hoje; a de ontem não pode vazar');

  const doisDias = await req(`/api/admin/financeiro/custos-api?startDate=${ONTEM}&endDate=${HOJE}`);
  assert.equal(doisDias.status, 200, doisDias.texto);
  assert.equal(doisDias.json.whatsapp.semCustoDeApi, 2, 'as duas mensagens, igual ao `dias=2` de sempre');
});
