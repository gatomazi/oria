'use strict';

// Integrações · read model: UM estado por provider, derivado no servidor.
//
// O que este teste protege é a ausência de cards que se contradizem: "API conectada" ao lado de erro,
// "Não incluído no plano" com o plano concedendo, "Pendente" porque um webhook adiado de propósito
// não existe, "Conectar" numa plataforma que não está configurada. Duas camadas:
//   1. a função pura (lib/platform/integration-read-model.js), em cada regra de precedência;
//   2. o endpoint real (`GET /api/admin/integrations`), com Organizations de planos diferentes.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');
const rm = h.sujeito('lib/platform/integration-read-model.js');
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { limparCache, concederFeatures } = require('../helpers/linhas');

// ── 1. função pura ────────────────────────────────────────────────────────────────────────────

const d = (fatos) => rm.derivarEstado(fatos);

test('Given integração inexistente, When derivar, Then é coming_soon — e nada mais a rebaixa ou promove', () => {
  assert.equal(d({ comingSoon: true, entitled: false, platformAvailable: false }).estado, 'coming_soon');
  assert.equal(d({ comingSoon: true, entitled: true, connected: true }).estado, 'coming_soon', 'entitlement não finge conexão');
});

test('Given plano sem a feature, When derivar, Then not_entitled vence a plataforma e a conexão', () => {
  assert.deepEqual(d({ entitled: false, platformAvailable: false, connected: true }), { estado: 'not_entitled', proximaAcao: 'ask_plan' });
});

test('Given plano ilegível (entitled null), When derivar, Then NÃO bloqueia: a leitura não decide por quem usa a rota', () => {
  assert.equal(d({ entitled: null, platformAvailable: true, connected: true }).estado, 'connected');
});

test('Given plataforma sem configuração, When ainda não conectou, Then platform_unavailable (e não "não configurada")', () => {
  assert.deepEqual(d({ entitled: true, platformAvailable: false }), { estado: 'platform_unavailable', proximaAcao: 'wait_platform' });
});

test('Given plataforma que perdeu a configuração, When já estava conectado, Then degraded, não "indisponível"', () => {
  assert.equal(d({ entitled: true, platformAvailable: false, connected: true }).estado, 'degraded');
});

test('Given conexão com erro ou degradada, When derivar, Then error/degraded pedem reconectar', () => {
  assert.deepEqual(d({ entitled: true, platformAvailable: true, connected: true, failing: 'error' }), { estado: 'error', proximaAcao: 'reconnect' });
  assert.equal(d({ entitled: true, platformAvailable: true, connected: true, failing: 'degraded' }).estado, 'degraded');
});

test('Given conectado sem recurso escolhido, When derivar, Then configured com ação select_resource', () => {
  assert.deepEqual(d({ entitled: true, platformAvailable: true, connected: true, needsResource: true }), { estado: 'configured', proximaAcao: 'select_resource' });
});

test('Given conectado, When tem ou não dados, Then connected_with_data só com dados de verdade', () => {
  assert.equal(d({ platformAvailable: true, connected: true }).estado, 'connected');
  assert.equal(d({ platformAvailable: true, connected: true, hasData: true }).estado, 'connected_with_data');
  assert.equal(d({ platformAvailable: true }).estado, 'not_configured');
});

test('Given leitura que falha, When montar a linha, Then vira error com retry — nunca "não configurado"', () => {
  const l = rm.linhaComFalha('ga4');
  assert.equal(l.estado, 'error');
  assert.equal(l.proximaAcao, 'retry');
  assert.equal(l.leituraFalhou, true);
});

test('Given componentes, When a linha é montada, Then o webhook adiado não rebaixa o provider', () => {
  const l = rm.linhaDoProvider('ink', { platformAvailable: true, configured: true, connected: true }, { api: 'connected', webhook: 'deferred' });
  assert.equal(l.estado, 'connected');
  assert.deepEqual(l.componentes, { api: 'connected', webhook: 'deferred' });
});

test('Given o vocabulário, When listado, Then é fechado e cobre todos os estados que a tela traduz', () => {
  assert.deepEqual([...rm.ESTADOS].sort(), [
    'coming_soon', 'configured', 'connected', 'connected_with_data', 'connecting', 'deferred', 'degraded',
    'error', 'not_configured', 'not_entitled', 'platform_unavailable',
  ]);
});

// ── 2. endpoint real ──────────────────────────────────────────────────────────────────────────

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORGS = { X: 'a1000000-0000-4000-8000-0000000000e1', Y: 'a1000000-0000-4000-8000-0000000000e2' };
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_rm_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const email = (l) => `rm-${l.toLowerCase()}@teste.oria`;
let db;
let sup;
let filho;
let base;

async function entrar(letra) {
  const r = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email(letra), password: SENHA }),
  });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const { csrfToken } = await r.json();
  const chamar = async (metodo, caminho, corpo) => {
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrfToken };
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    const x = await fetch(base + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    return { status: x.status, json: await x.json().catch(() => null) };
  };
  return { get: (c) => chamar('GET', c), put: (c, b) => chamar('PUT', c, b) };
}

async function criar(letra, features) {
  const org = ORGS[letra];
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Tenant RM ${letra}`]);
  await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [crypto.randomUUID(), org, `Loja ${letra}`]);
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email(letra), await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [org, u.id]);
  await concederFeatures(sup, org, features);
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_rm_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-1500)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();
  await criar('X', { analytics_ga4: true, meta_ads: true, google_ads: true, whatsapp: true, instagram: true });
  await criar('Y', { analytics_ga4: false, meta_ads: false, google_ads: false, whatsapp: false, instagram: false });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-rm-srv-'));
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, [SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE), DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA, ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      // Google pronto (GA4 disponível); SEM developer token (Google Ads indisponível) e SEM app de Ads.
      GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', GOOGLE_OAUTH_REDIRECT_URI: 'https://oria.test/google/callback',
      WHATSAPP_SERVICE_URL: 'http://127.0.0.1:1', WHATSAPP_API_KEY: 'k'.repeat(24),
    },
  }), { aoLer: () => {}, limiteMs: 30000 });
  filho = processo.filho;
  base = processo.base;
});

test.after(async () => {
  if (filho && filho.exitCode === null) filho.kill('SIGKILL');
  if (sup) { await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {}); await sup.end(); }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const linha = (json, provider) => json.integracoes.find((i) => i.provider === provider);

test('endpoint · o plano concede: cada integração reflete a plataforma, sem contradição', async () => {
  const x = await entrar('X');
  const r = await x.get('/api/admin/integrations');
  assert.equal(r.status, 200);
  assert.equal(linha(r.json, 'ga4').estado, 'not_configured', 'plataforma do Google pronta, nada conectado');
  assert.equal(linha(r.json, 'meta_ads').estado, 'platform_unavailable', 'app de Ads não configurado na plataforma');
  assert.equal(linha(r.json, 'google_ads').estado, 'platform_unavailable', 'sem developer token o Google Ads não é oferecido');
  assert.equal(linha(r.json, 'whatsapp').estado, 'not_configured', 'serviço de WhatsApp pronto, sem número');
  assert.equal(linha(r.json, 'openai').estado, 'not_configured');
  assert.equal(linha(r.json, 'ink').estado, 'not_configured');
  assert.equal(linha(r.json, 'instagram').estado, 'coming_soon', 'mesmo com a feature no plano: não implementada');
  assert.equal(linha(r.json, 'instagram').entitled, true);
});

test('endpoint · o plano NÃO concede: not_entitled, e o instagram segue em breve (não "não incluído")', async () => {
  const y = await entrar('Y');
  const r = await y.get('/api/admin/integrations');
  for (const p of ['ga4', 'meta_ads', 'google_ads', 'whatsapp']) assert.equal(linha(r.json, p).estado, 'not_entitled', p);
  assert.equal(linha(r.json, 'instagram').estado, 'coming_soon');
});

test('endpoint · os estados do read model vêm todos do vocabulário fechado, sem segredo nem env na resposta', async () => {
  const x = await entrar('X');
  const r = await x.get('/api/admin/integrations');
  for (const i of r.json.integracoes) {
    assert.ok(rm.ESTADOS.includes(i.estado), `${i.provider}: ${i.estado}`);
    assert.ok(rm.PROXIMAS_ACOES.includes(i.proximaAcao), `${i.provider}: ${i.proximaAcao}`);
  }
  const texto = JSON.stringify(r.json);
  assert.doesNotMatch(texto, /META_ADS_|GOOGLE_ADS_DEVELOPER_TOKEN|GOOGLE_CLIENT_SECRET|csecret/, 'nome de variável ou segredo nunca vai à tela');
});

test('endpoint · Ink sem credencial: API não configurada e webhook adiado, sem "pendente"', async () => {
  const x = await entrar('X');
  const r = await x.get('/api/admin/integrations');
  assert.equal(r.json.ink.status, 'not_configured');
  assert.equal(r.json.ink.webhook, 'adiado');
  assert.notEqual(r.json.ink.status, 'pendente');
});

test('endpoint · Ink com token e SEM webhook: API conectada, webhook adiado — nunca pendente', async () => {
  const x = await entrar('X');
  const salvo = await x.put('/api/admin/integrations/ink/credenciais', { apiToken: 'token-de-teste-da-ink-0123456789' });
  assert.equal(salvo.status, 200, JSON.stringify(salvo.json));
  const r = await x.get('/api/admin/integrations');
  assert.equal(r.json.ink.status, 'conectada');
  assert.equal(r.json.ink.conectado, true);
  assert.equal(r.json.ink.webhook, 'adiado');
  const ink = linha(r.json, 'ink');
  assert.equal(ink.estado, 'connected', 'o webhook adiado não rebaixa a API');
  assert.deepEqual(ink.componentes, { api: 'connected', webhook: 'deferred' });
  assert.ok(!JSON.stringify(r.json).includes('token-de-teste-da-ink'), 'o token nunca sai na resposta');
});
