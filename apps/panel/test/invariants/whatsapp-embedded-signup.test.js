'use strict';

// WhatsApp · onboarding por Embedded Signup (Tech Provider) na Store nativa (`loja_legada = NULL`).
//
// Fluxo: GET config (state de uso único) → [navegador: FB.login + mensagem da Meta] → POST complete →
// troca do code, prova na Meta (token do NOSSO app, WABA concedida, número da WABA), posse do recurso,
// assinatura de webhooks, registro do número, gravação cifrada. Depois, o webhook da Meta resolve o
// tenant pelo par (WABA, número) — e devolve a identidade canônica organization + store + business.
//
// A Meta é simulada: o code `wa-<WABA>-<NUMERO>[-flag]` vira o token `WAT-…`, e esse token só
// "enxerga" a WABA e o número que carrega (ver test/helpers/provider-mock.cjs).
//
//   C  owner, Store nativa   — o caminho completo
//   D  owner, Store nativa   — isolamento: outra WABA, outro número; não alcança o que é de C
//   M  member de C           — não conecta (só o owner)

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
const ORGS = { C: 'a1000000-0000-4000-8000-0000000000c1', D: 'a1000000-0000-4000-8000-0000000000d1' };
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_waes_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const APP_ID = '4440001';
const APP_SECRET = 'segredo-do-app-whatsapp-da-plataforma';
const CONFIG_ID = '5550001';
const CHAVE_RESOLVER = crypto.randomBytes(24).toString('hex');
const SEGREDO_REF = crypto.randomBytes(32).toString('hex');
// Identidades da Meta usadas nos cenários.
const WABA = { C: '6660001', D: '6660002', X: '6660003' };
const NUM = { C: '7770001', D: '7770002', X: '7770003' };
const BUSINESS = { C: '8880001', D: '8880002' };

let db;
let sup;
let filho;
let saida = '';
let base;
let dirTmp;
const store = {};
const email = (l) => `wa-${l.toLowerCase()}@teste.oria`;

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, headers = {}, redirect = 'follow' } = {}) => {
    const hd = { ...headers };
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
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
  nav.entrar = async (letra) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email: email(letra), password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}
const entrar = (l) => navegador().entrar(l);

async function criarNativa(letra) {
  const org = ORGS[letra];
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Tenant WhatsApp ${letra}`]);
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id', [crypto.randomUUID(), org, `Loja Nativa ${letra}`]
  );
  store[letra] = s.id;
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email(letra), await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [org, u.id]);
  await concederFeatures(sup, org, { whatsapp: true });
}

async function criarMember() {
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email('M'), await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'member')", [ORGS.C, u.id]);
}

// Simula o que o navegador faz: pega o state do servidor e, com o code da Meta, conclui.
async function conectar(nav, { waba, numero, business = null, flag = '', corpo = {} }) {
  const cfg = await nav.req('GET', '/api/admin/whatsapp/embedded-signup/config');
  assert.equal(cfg.status, 200, cfg.texto);
  return nav.req('POST', '/api/admin/whatsapp/embedded-signup/complete', {
    corpo: { state: cfg.json.state, code: `wa-${waba}-${numero}${flag}`, wabaId: waba, phoneNumberId: numero, businessId: business, ...corpo },
  });
}

const contexto = (waba, numero) => fetch(`${base}/api/internal/whatsapp/inbound-context`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Api-Key': CHAVE_RESOLVER },
  body: JSON.stringify(numero ? { waba_id: waba, phone_number_id: numero } : { waba_id: waba }),
  signal: AbortSignal.timeout(10000),
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

const chamadasDaMeta = () => {
  try { return fs.readFileSync(path.join(dirTmp, 'chamadas.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const claimsDe = async (org) => (await sup.query("SELECT tipo, external_id FROM external_resource_claims WHERE provider = 'whatsapp' AND organization_id = $1 ORDER BY tipo, external_id", [org])).rows;
const configDe = async (org) => (await sup.query("SELECT config FROM integrations WHERE organization_id = $1 AND provider = 'whatsapp'", [org])).rows[0]?.config || null;

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_waes_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();
  for (const l of Object.keys(ORGS)) await criarNativa(l);
  await criarMember();

  dirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-waes-srv-'));
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dirTmp, UPLOADS_DIR: path.join(dirTmp, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: path.join(dirTmp, 'chamadas.jsonl'),
      // App do WhatsApp (plataforma) e app de Ads: DOIS apps, variáveis diferentes.
      META_APP_ID: APP_ID, META_APP_SECRET: APP_SECRET, WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID: CONFIG_ID,
      META_ADS_APP_ID: '123', META_ADS_APP_SECRET: 'segredo-do-app-de-ads', META_ADS_OAUTH_REDIRECT_URI: 'https://oria.test/meta',
      WHATSAPP_SENDER_REF_SECRET: SEGREDO_REF, WHATSAPP_SENDER_RESOLVER_KEY: CHAVE_RESOLVER,
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

// ── config / state ────────────────────────────────────────────────────────────────────────────

test('config · devolve app, config_id e um state de uso único ligado à Store; nunca o App Secret', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', '/api/admin/whatsapp/embedded-signup/config');
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.appId, APP_ID);
  assert.equal(r.json.configId, CONFIG_ID);
  assert.match(r.json.apiVersion, /^v\d{2}\.\d$/);
  assert.ok(!r.texto.includes(APP_SECRET), 'o App Secret é da plataforma e nunca vai ao navegador');
  const { rows: [st] } = await sup.query("SELECT provider, organization_id, dados FROM oauth_states WHERE provider = 'whatsapp' ORDER BY criado_em DESC LIMIT 1");
  assert.equal(st.organization_id, ORGS.C);
  assert.equal(st.dados.storeId, store.C, 'o state carrega a Store que iniciou o fluxo');
});

test('config · só o owner conecta o WhatsApp da loja', async () => {
  const m = await entrar('M');
  const r = await m.req('GET', '/api/admin/whatsapp/embedded-signup/config');
  assert.equal(r.status, 403);
  assert.equal(r.json.codigo, 'OWNER_REQUIRED');
  const c = await m.req('POST', '/api/admin/whatsapp/embedded-signup/complete', { corpo: { state: 'x'.repeat(43), code: 'wa-6660001-7770001', wabaId: WABA.C, phoneNumberId: NUM.C } });
  assert.equal(c.status, 403);
  assert.deepEqual(await claimsDe(ORGS.C), [], 'nada foi reivindicado');
});

// ── caminho completo ──────────────────────────────────────────────────────────────────────────

test('complete · Store nativa conecta: identidade canônica gravada, token cifrado, webhooks assinados, número registrado', async () => {
  const c = await entrar('C');
  const r = await conectar(c, { waba: WABA.C, numero: NUM.C, business: BUSINESS.C });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.status, 'connected');
  assert.equal(r.json.phoneNumberId, NUM.C);
  assert.equal(r.json.wabaId, WABA.C);
  assert.equal(r.json.businessId, BUSINESS.C);
  assert.equal(r.json.storeId, store.C, 'store_id vem do contexto da sessão, não do navegador');
  assert.equal(r.json.conectadoVia, 'embedded_signup');
  assert.equal(r.json.webhookAssinado, true);
  assert.equal(r.json.numeroRegistrado, true);
  assert.equal(r.json.nomeVerificado, 'Loja de Teste');
  assert.match(r.json.token.last4, /^.{4}$/, 'a tela só vê os 4 últimos caracteres');
  assert.ok(!r.texto.includes('WAT-'), 'o token nunca sai na resposta');

  const cfg = await configDe(ORGS.C);
  assert.equal(cfg.store_id, store.C);
  assert.equal(cfg.business_id, BUSINESS.C);
  assert.equal(cfg.loja, undefined, 'sem chave legada: nada de `loja`');
  assert.deepEqual(await claimsDe(ORGS.C), [{ tipo: 'phone_number', external_id: NUM.C }, { tipo: 'waba', external_id: WABA.C }]);

  const { rows } = await sup.query("SELECT tipo, ciphertext FROM integration_secrets WHERE organization_id = $1 AND integration_id IN (SELECT id FROM integrations WHERE organization_id = $1 AND provider = 'whatsapp') ORDER BY tipo", [ORGS.C]);
  assert.deepEqual(rows.map((x) => x.tipo), ['access_token', 'two_step_pin']);
  for (const x of rows) assert.ok(!String(x.ciphertext).includes('WAT-'), 'cifrado no banco');

  // Efeitos na Meta: assinou webhooks da WABA e registrou o número, ambos com o token do cliente + appsecret_proof.
  const meta = chamadasDaMeta().filter((x) => x.auth === `Bearer WAT-${WABA.C}-${NUM.C}`);
  const assinar = meta.find((x) => x.caminho.endsWith(`/${WABA.C}/subscribed_apps`));
  const registrar = meta.find((x) => x.caminho.endsWith(`/${NUM.C}/register`));
  assert.ok(assinar && assinar.metodo === 'POST', 'assinou os webhooks da WABA');
  assert.ok(registrar && registrar.metodo === 'POST', 'registrou o número na Cloud API');
  assert.match(JSON.parse(registrar.corpo).pin, /^[0-9]{6}$/, 'PIN de 6 dígitos gerado no servidor');
  assert.match(assinar.query, /appsecret_proof=[0-9a-f]{64}/);
  assert.ok(!saida.includes('WAT-') && !saida.includes(APP_SECRET), 'nenhum token nem segredo no log do processo');
});

test('webhook · o par (WABA, número) resolve a Organization e devolve store_id e business_id ao serviço Go', async () => {
  const ok = await contexto(WABA.C, NUM.C);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.organization_id, ORGS.C);
  assert.equal(ok.json.store_id, store.C);
  assert.equal(ok.json.business_id, BUSINESS.C);
  assert.equal(ok.json.waba_id, WABA.C);
  assert.equal(ok.json.phone_number_id, NUM.C);
  assert.ok(!('access_token' in ok.json) && !JSON.stringify(ok.json).includes('WAT-'), 'o contexto nunca leva o token');
  assert.equal((await contexto('6669999')).status, 404, 'WABA que ninguém conectou é desconhecida');
});

// ── recusas: o que o navegador afirma não vale sem a Meta ─────────────────────────────────────

test('complete · WABA forjada no corpo: o token não a enxerga, nada é gravado', async () => {
  const d = await entrar('D');
  const r = await conectar(d, { waba: WABA.D, numero: NUM.D, corpo: { wabaId: WABA.C } });
  assert.equal(r.status, 403, r.texto);
  assert.equal(r.json.codigo, 'ES_WABA_NOT_GRANTED');
  assert.deepEqual(await claimsDe(ORGS.D), []);
  assert.equal(await configDe(ORGS.D), null);
});

test('complete · número que não é da WABA é recusado antes de qualquer efeito', async () => {
  const d = await entrar('D');
  const antes = chamadasDaMeta().length;
  const r = await conectar(d, { waba: WABA.D, numero: NUM.D, corpo: { phoneNumberId: NUM.X } });
  assert.equal(r.status, 403, r.texto);
  assert.equal(r.json.codigo, 'ES_PHONE_NOT_IN_WABA');
  const novas = chamadasDaMeta().slice(antes);
  assert.ok(!novas.some((x) => x.caminho.endsWith('/subscribed_apps') || x.caminho.endsWith('/register')), 'não assinou nem registrou nada');
  assert.deepEqual(await claimsDe(ORGS.D), []);
});

test('complete · token de OUTRO app da Meta não vale', async () => {
  const d = await entrar('D');
  const r = await conectar(d, { waba: WABA.D, numero: NUM.D, flag: '-foreign' });
  assert.equal(r.status, 403, r.texto);
  assert.equal(r.json.codigo, 'ES_TOKEN_OTHER_APP');
  assert.deepEqual(await claimsDe(ORGS.D), []);
});

test('complete · code expirado ou malformado é recusado, sem gravar', async () => {
  const d = await entrar('D');
  const expirado = await conectar(d, { waba: WABA.D, numero: NUM.D, flag: '-expired' });
  assert.equal(expirado.status, 400);
  assert.equal(expirado.json.codigo, 'ES_CODE_EXCHANGE_FAILED');
  const malformado = await conectar(d, { waba: WABA.D, numero: NUM.D, corpo: { code: 'curto' } });
  assert.equal(malformado.status, 400);
  assert.equal(malformado.json.codigo, 'ES_CODE_INVALID');
  assert.equal(await configDe(ORGS.D), null);
});

test('complete · campo desconhecido no corpo é recusado (sem storeId/organizationId vindos do navegador)', async () => {
  const d = await entrar('D');
  const r = await conectar(d, { waba: WABA.D, numero: NUM.D, corpo: { storeId: store.C, organizationId: ORGS.C } });
  assert.equal(r.status, 400);
  // A porta global (tenant vem da sessão) recusa storeId/organizationId no corpo antes da rota.
  assert.match(r.json.error, /não aceitos/);
  assert.equal((await claimsDe(ORGS.D)).length, 0, 'nada foi reivindicado por D');
});

// ── state ─────────────────────────────────────────────────────────────────────────────────────

test('state · uso único: repetir o pedido com o mesmo state não repete o efeito', async () => {
  const d = await entrar('D');
  const cfg = await d.req('GET', '/api/admin/whatsapp/embedded-signup/config');
  const corpo = { state: cfg.json.state, code: `wa-${WABA.D}-${NUM.D}`, wabaId: WABA.D, phoneNumberId: NUM.D, businessId: BUSINESS.D };
  const primeiro = await d.req('POST', '/api/admin/whatsapp/embedded-signup/complete', { corpo });
  assert.equal(primeiro.status, 200, primeiro.texto);
  const chamadas = chamadasDaMeta().length;
  const segundo = await d.req('POST', '/api/admin/whatsapp/embedded-signup/complete', { corpo });
  assert.equal(segundo.status, 400);
  assert.equal(segundo.json.codigo, 'ES_STATE_INVALID');
  assert.equal(chamadasDaMeta().length, chamadas, 'o replay nem chegou à Meta');
});

test('state · emitido para o Ads (provider meta) não conclui o WhatsApp', async () => {
  const d = await entrar('D');
  const ads = await d.req('GET', '/api/admin/integrations/meta/connect', { redirect: 'manual' });
  assert.equal(ads.status, 302, ads.texto);
  const stateDeAds = new URL(ads.location).searchParams.get('state');
  assert.ok(stateDeAds);
  const chamadas = chamadasDaMeta().length;
  const r = await d.req('POST', '/api/admin/whatsapp/embedded-signup/complete', {
    corpo: { state: stateDeAds, code: `wa-${WABA.X}-${NUM.X}`, wabaId: WABA.X, phoneNumberId: NUM.X },
  });
  assert.equal(r.status, 400, r.texto);
  assert.equal(r.json.codigo, 'ES_STATE_INVALID');
  assert.equal(chamadasDaMeta().length, chamadas, 'nem chegou à Meta');
  assert.deepEqual((await claimsDe(ORGS.D)).map((x) => x.external_id).sort(), [NUM.D, WABA.D].sort());
});

test('state · de outra pessoa/Store não conclui: state de C usado na sessão de D é recusado', async () => {
  const c = await entrar('C');
  const cfg = await c.req('GET', '/api/admin/whatsapp/embedded-signup/config');
  const d = await entrar('D');
  const r = await d.req('POST', '/api/admin/whatsapp/embedded-signup/complete', {
    corpo: { state: cfg.json.state, code: `wa-${WABA.X}-${NUM.X}`, wabaId: WABA.X, phoneNumberId: NUM.X },
  });
  assert.equal(r.status, 403, r.texto);
  assert.equal(r.json.codigo, 'ES_STATE_MISMATCH');
  assert.deepEqual((await claimsDe(ORGS.D)).map((x) => x.external_id).sort(), [NUM.D, WABA.D].sort(), 'D continua só com o que é dela');
});

// ── isolamento entre tenants ──────────────────────────────────────────────────────────────────

test('isolamento · D conectada com a própria WABA/número; cada um resolve para o seu tenant e a divergência é 409', async () => {
  const ctxD = await contexto(WABA.D, NUM.D);
  assert.equal(ctxD.status, 200);
  assert.equal(ctxD.json.organization_id, ORGS.D);
  assert.equal(ctxD.json.store_id, store.D);
  assert.equal(ctxD.json.business_id, BUSINESS.D);
  const ctxC = await contexto(WABA.C, NUM.C);
  assert.equal(ctxC.json.organization_id, ORGS.C, 'C não foi tocada');
  const cruzado = await contexto(WABA.C, NUM.D);
  assert.equal(cruzado.status, 409, 'WABA de C com número de D: recusa');
  assert.equal(cruzado.json.codigo, 'SENDER_MISMATCH');
});

test('isolamento · D não reivindica a WABA/número de C, nem com token válido da Meta', async () => {
  const d = await entrar('D');
  const antes = await configDe(ORGS.D);
  const r = await conectar(d, { waba: WABA.C, numero: NUM.C });
  assert.equal(r.status, 409, r.texto);
  assert.equal(r.json.codigo, 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE');
  assert.deepEqual(await configDe(ORGS.D), antes, 'a conexão de D não mudou');
  assert.deepEqual(await claimsDe(ORGS.C), [{ tipo: 'phone_number', external_id: NUM.C }, { tipo: 'waba', external_id: WABA.C }], 'C continua dona');
  const ctx = await contexto(WABA.C, NUM.C);
  assert.equal(ctx.json.organization_id, ORGS.C);
});

test('isolamento · o remetente de C não aparece para D (nem número, nem token)', async () => {
  const d = await entrar('D');
  const r = await d.req('GET', '/api/admin/whatsapp/remetente');
  assert.equal(r.status, 200);
  assert.equal(r.json.phoneNumberId, NUM.D);
  assert.ok(!r.texto.includes(NUM.C) && !r.texto.includes(WABA.C));
});

// ── falha no meio: nada fica pela metade ──────────────────────────────────────────────────────

test('complete · falha ao assinar webhooks: nada é gravado e os recursos reivindicados são devolvidos', async () => {
  const c = await entrar('C');
  const antes = await configDe(ORGS.C);
  const claimsAntes = await claimsDe(ORGS.C);
  // Troca C por uma WABA/número novos, mas a Meta falha ao assinar: C continua exatamente como estava.
  const r = await conectar(c, { waba: WABA.X, numero: NUM.X, flag: '-subfail' });
  assert.equal(r.status, 400, r.texto);
  assert.equal(r.json.codigo, 'ES_SUBSCRIBE_FAILED');
  assert.deepEqual(await configDe(ORGS.C), antes);
  assert.deepEqual(await claimsDe(ORGS.C), claimsAntes, 'só o que ESTE pedido reivindicou foi devolvido');
  assert.equal((await contexto(WABA.X, NUM.X)).status, 404, 'a WABA nova não ficou órfã com dono');
});

test('complete · falha ao registrar o número também não deixa nada gravado', async () => {
  const c = await entrar('C');
  const antes = await configDe(ORGS.C);
  const r = await conectar(c, { waba: WABA.X, numero: NUM.X, flag: '-regfail' });
  assert.equal(r.status, 400, r.texto);
  assert.equal(r.json.codigo, 'ES_REGISTER_FAILED');
  assert.deepEqual(await configDe(ORGS.C), antes);
});

// ── comportamento e desconexão ────────────────────────────────────────────────────────────────

test('remetente · salvar só a resposta automática mantém a identidade que a Meta confirmou', async () => {
  const c = await entrar('C');
  const r = await c.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: NUM.C, wabaId: WABA.C, replyRedirectMessage: 'Olá! Canal automático.' } });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.replyRedirectMessage, 'Olá! Canal automático.');
  assert.equal(r.json.businessId, BUSINESS.C);
  assert.equal(r.json.storeId, store.C);
  assert.equal(r.json.conectadoVia, 'embedded_signup');
});

test('desconectar · apaga identidade, segredos e posse; o webhook do número passa a ser desconhecido', async () => {
  const c = await entrar('C');
  const r = await c.req('DELETE', '/api/admin/whatsapp/remetente');
  assert.equal(r.status, 200, r.texto);
  const estado = await c.req('GET', '/api/admin/whatsapp/remetente');
  assert.equal(estado.json.status, 'disconnected');
  assert.equal(estado.json.phoneNumberId, null);
  assert.equal(estado.json.businessId, null);
  assert.deepEqual(await claimsDe(ORGS.C), []);
  const { rows } = await sup.query("SELECT 1 FROM integration_secrets WHERE organization_id = $1 AND integration_id IN (SELECT id FROM integrations WHERE organization_id = $1 AND provider = 'whatsapp')", [ORGS.C]);
  assert.equal(rows.length, 0);
  assert.equal((await contexto(WABA.C, NUM.C)).status, 404);
  assert.equal((await contexto(WABA.D, NUM.D)).json.organization_id, ORGS.D, 'D não foi afetada');
});

test('reconexão · a WABA/número liberados por C podem ser conectados por D, e só depois da liberação', async () => {
  const d = await entrar('D');
  const r = await conectar(d, { waba: WABA.C, numero: NUM.C });
  assert.equal(r.status, 200, r.texto);
  assert.equal((await contexto(WABA.C, NUM.C)).json.organization_id, ORGS.D, 'agora é de D');
});
