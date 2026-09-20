'use strict';

// Rodada de integrações core (2026-09-20) · Meta Ads na Store nativa (`loja_legada = NULL`):
// Conectar → OAuth → callback → conta de anúncios → sync de gasto → Dashboard/Financeiro, por
// `organization_id + store_id`.
//
// A Meta é simulada pelo provider mock: o code `meta<X>` vira o token `EAAG-long-<X>`; a ÚLTIMA
// letra do token escolhe a conta de anúncio (`act_<X>001`) e o gasto (100 + código da letra % 50) — a
// prova de qual credencial (e, portanto, de qual Store) foi usada em cada chamada.
//
//   C  Store nativa                    — o caminho completo, com gasto real no Dashboard/consolidado
//   D  Store nativa                    — isolamento (mesma plataforma, outro token, outra conta)
//   E  Store nativa                    — conexão em erro: o Dashboard diz "com problema"

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
const ORGS = {
  C: 'a1000000-0000-4000-8000-00000000000c',
  D: 'a1000000-0000-4000-8000-00000000000d',
  E: 'a1000000-0000-4000-8000-00000000000e',
};
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_meta_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_PLATAFORMA = 'segredo-plataforma-meta-app';
const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const gastoDe = (letra) => 100 + (letra.charCodeAt(0) % 50);

let db;
let sup;
let filho;
let saida = '';
let base;
const store = {};
const email = (l) => `meta-${l.toLowerCase()}@teste.oria`;
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, redirect = 'follow', semCookie = false } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie && !semCookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, {
      method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo), redirect, signal: AbortSignal.timeout(10000),
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

async function ate(fn, { tentativas = 60, intervalo = 300 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const v = await fn();
    if (v) return v;
    await esperar(intervalo);
  }
  return null;
}

async function criarNativa(letra) {
  const org = ORGS[letra];
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Tenant Nativo ${letra}`]);
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id', [crypto.randomUUID(), org, `Loja Nativa ${letra}`]
  );
  store[letra] = s.id;
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email(letra), await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [org, u.id]);
  await concederFeatures(sup, org, { financial: true, meta_ads: true, google_ads: true, analytics_ga4: true, whatsapp: true, catalog: true });
}

async function iniciar(nav) {
  const r = await nav.req('GET', '/api/admin/integrations/meta/connect', { redirect: 'manual' });
  assert.equal(r.status, 302, `Conectar Meta: ${r.texto}`);
  const url = new URL(r.location);
  return { url, state: url.searchParams.get('state') };
}

const callback = (nav, params) => nav.req('GET', `/api/admin/integrations/meta/callback?${new URLSearchParams(params)}`, { redirect: 'manual', semCookie: true });

// Conecta pelo produto: connect → (Meta) → callback sem sessão, e espera as contas de anúncio.
async function conectar(letra) {
  const nav = await entrar(letra);
  const { state } = await iniciar(nav);
  const r = await callback(navegador(), { code: `meta${letra}`, state });
  assert.equal(r.status, 302);
  return nav;
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_meta_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();
  for (const l of Object.keys(ORGS)) await criarNativa(l);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-meta-srv-'));
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: path.join(dir, 'chamadas.jsonl'),
      META_APP_ID: '123', META_APP_SECRET: SEGREDO_PLATAFORMA, META_OAUTH_REDIRECT_URI: 'https://oria.test/meta',
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

// ── OAuth ─────────────────────────────────────────────────────────────────────────────────────

test('connect · Store nativa é redirecionada à Meta com state; só ads_read; nenhum segredo na URL', async () => {
  const c = await entrar('C');
  const { url, state } = await iniciar(c);
  assert.equal(url.hostname, 'www.facebook.com');
  assert.ok(state && state.length >= 32);
  assert.equal(url.searchParams.get('scope'), 'ads_read', 'só leitura: sem ads_management, sem business_management');
  assert.equal(url.searchParams.get('client_id'), '123');
  assert.ok(!url.toString().includes(SEGREDO_PLATAFORMA), 'o segredo do app Meta nunca vai na URL');
  const { rows: [st] } = await sup.query("SELECT provider, organization_id, dados FROM oauth_states WHERE provider = 'meta' ORDER BY criado_em DESC LIMIT 1");
  assert.equal(st.organization_id, ORGS.C);
  assert.equal(st.dados.storeId, store.C, 'o state carrega a Store que iniciou o fluxo');
});

test('callback · sem sessão, com state válido: conecta, guarda o token cifrado e traz as contas de anúncio', async () => {
  const c = await conectar('C');
  const status = await c.req('GET', '/api/admin/integrations/meta/status');
  assert.equal(status.status, 200, status.texto);
  assert.equal(status.json.conexao.status, 'connected');
  assert.equal(status.json.oauthConfigurado, true);
  assert.deepEqual(status.json.contas.map((x) => x.metaAccountId), ['act_C001'], 'a conta vem da credencial de C');
  assert.equal(status.json.contas[0].selecionada, false, 'nada é selecionado por dedução');
  assert.equal(status.json.contas[0].atribuidaAEstaStore, false);

  const { rows } = await sup.query("SELECT tipo, ciphertext FROM integration_secrets WHERE organization_id = $1 AND tipo = 'access_token' AND integration_id IN (SELECT id FROM integrations WHERE organization_id = $1 AND provider = 'meta')", [ORGS.C]);
  assert.equal(rows.length, 1, 'o token da Meta foi guardado');
  assert.ok(!String(rows[0].ciphertext).includes('EAAG'), 'cifrado no banco');
  assert.ok(!status.texto.includes('EAAG'), 'o token nunca sai na resposta');
});

test('callback · state inválido, reutilizado, forjado ou de outra Store não grava nada', async () => {
  const c = await entrar('C');
  const contar = async () => (await sup.query('SELECT count(*)::int AS n, max(atualizado_em) AS ultima FROM meta_connections')).rows[0];
  const antes = await contar();
  const anonimo = navegador();
  assert.equal((await callback(anonimo, { code: 'metaX', state: 'inventado-que-nao-existe' })).status, 302);
  const { state } = await iniciar(c);
  await callback(anonimo, { code: 'metaC', state });
  const depoisDoPrimeiro = await contar();
  assert.equal((await callback(anonimo, { code: 'metaZ', state })).status, 302, 'replay do state: só redireciona');
  assert.deepEqual((await contar()).ultima, depoisDoPrimeiro.ultima, 'o replay não alterou nada');
  assert.equal((await contar()).n, antes.n);

  // State válido, mas SEM a Store (estado antigo) ou com a Store de OUTRA Organization (forjado):
  // fail-closed — o callback só redireciona e nada é gravado.
  for (const dados of [{}, { storeId: store.D }]) {
    const { state: s2 } = await iniciar(c);
    await sup.query("UPDATE oauth_states SET dados = $1::jsonb WHERE id = (SELECT id FROM oauth_states WHERE provider = 'meta' ORDER BY criado_em DESC LIMIT 1)", [JSON.stringify(dados)]);
    const ultimaAntes = (await contar()).ultima;
    assert.equal((await callback(anonimo, { code: 'metaC', state: s2 })).status, 302);
    assert.deepEqual((await contar()).ultima, ultimaAntes, `state com ${JSON.stringify(dados)} não pode gravar nada`);
  }
});

test('callback · cross-tenant: o state de D conecta a Store de D; C não é tocada', async () => {
  const antesC = (await sup.query('SELECT status, atualizado_em FROM meta_connections WHERE organization_id = $1', [ORGS.C])).rows[0];
  const d = await conectar('D');
  const statusD = await d.req('GET', '/api/admin/integrations/meta/status');
  assert.deepEqual(statusD.json.contas.map((x) => x.metaAccountId), ['act_D001'], 'D só enxerga a conta da credencial dela');
  const depoisC = (await sup.query('SELECT status, atualizado_em FROM meta_connections WHERE organization_id = $1', [ORGS.C])).rows[0];
  assert.deepEqual(depoisC, antesC, 'a conexão de C não foi tocada');
  const c = await entrar('C');
  const statusC = await c.req('GET', '/api/admin/integrations/meta/status');
  assert.ok(!statusC.json.contas.some((x) => x.metaAccountId === 'act_D001'));
});

// ── Conta de anúncios → sync → Dashboard e Financeiro ─────────────────────────────────────────

test('conta · selecionar atribui à Store (store_id) e o sync grava o gasto REAL da conta, de forma idempotente', async () => {
  const c = await entrar('C');
  const sel = await c.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: 'act_C001' } });
  assert.equal(sel.status, 200, sel.texto);
  const { rows: [conta] } = await sup.query("SELECT selecionada, store_id, loja_atribuida FROM meta_ad_accounts WHERE organization_id = $1 AND meta_account_id = 'act_C001'", [ORGS.C]);
  assert.equal(conta.selecionada, true);
  assert.equal(conta.store_id, store.C);
  assert.equal(conta.loja_atribuida, null);

  // A importação inicial roda em background sob o contexto da Organization/Store.
  const linhas = await ate(async () => {
    const { rows } = await sup.query("SELECT meta_account_id, data, spend FROM meta_insights_daily WHERE organization_id = $1 AND level = 'account'", [ORGS.C]);
    return rows.length ? rows : null;
  });
  assert.ok(linhas, 'o sync não gravou insights');
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].meta_account_id, 'act_C001');
  assert.equal(Number(linhas[0].spend), gastoDe('C'));

  // Idempotência: sincronizar de novo não duplica (mesma linha, mesmo gasto).
  await ate(async () => {
    const st = await c.req('GET', '/api/admin/integrations/meta/status');
    return !st.json.syncEmAndamento;
  });
  const manual = await c.req('POST', '/api/admin/integrations/meta/sync', { corpo: {} });
  assert.equal(manual.status, 200, manual.texto);
  await esperar(1500);
  await ate(async () => !(await c.req('GET', '/api/admin/integrations/meta/status')).json.syncEmAndamento);
  const { rows: depois } = await sup.query("SELECT spend FROM meta_insights_daily WHERE organization_id = $1 AND level = 'account'", [ORGS.C]);
  assert.equal(depois.length, 1, 'nenhuma linha duplicada');
  assert.equal(Number(depois[0].spend), gastoDe('C'));
});

test('Dashboard · com a conta da Store conectada, o gasto real entra e a fonte é "conectada com dados"', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.midia.reduce((a, m) => a + Number(m.spend), 0), gastoDe('C'));
  for (const m of r.json.midia) assert.equal(m.loja, null, 'a Store nativa não tem chave legada');
  const meta = r.json.midiaFontes.find((f) => f.provider === 'meta');
  assert.equal(meta.conectado, true);
  assert.equal(meta.comProblema, false);
  assert.equal(meta.motivo, null);
  assert.deepEqual(r.json.midiaSinalizada, []);
});

test('Financeiro · o consolidado incorpora o gasto Meta real da Store nativa', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', `/api/admin/analytics/consolidado?from=${HOJE}&to=${HOJE}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.resultado.totalMidia, gastoDe('C'));
  assert.equal(r.json.resultado.midiaPorProvedor.meta, gastoDe('C'));
  assert.deepEqual(r.json.midiaSinalizada, []);
  const ov = await c.req('GET', `/api/admin/analytics/meta/overview?from=${HOJE}&to=${HOJE}`);
  assert.equal(ov.status, 200, ov.texto);
  assert.equal(ov.json.conta.metaAccountId, 'act_C001');
});

test('cross-tenant · D com a conta dela recebe SÓ o gasto dela; C não seleciona a conta de D e D não vê o gasto de C', async () => {
  const d = await entrar('D');
  const c = await entrar('C');
  const roubo = await c.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: 'act_D001' } });
  assert.equal(roubo.status, 404, 'a conta de D não existe para C');

  const sel = await d.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: 'act_D001' } });
  assert.equal(sel.status, 200, sel.texto);
  await ate(async () => (await sup.query("SELECT 1 FROM meta_insights_daily WHERE organization_id = $1 AND level = 'account'", [ORGS.D])).rows.length);
  await ate(async () => !(await d.req('GET', '/api/admin/integrations/meta/status')).json.syncEmAndamento);
  const rd = await d.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(rd.json.midia.reduce((a, m) => a + Number(m.spend), 0), gastoDe('D'));
  assert.notEqual(gastoDe('D'), gastoDe('C'));
  const rc = await c.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(rc.json.midia.reduce((a, m) => a + Number(m.spend), 0), gastoDe('C'), 'o gasto de C não foi alterado pelo de D');
  const { rows } = await sup.query("SELECT organization_id, meta_account_id FROM meta_insights_daily WHERE level = 'account' ORDER BY organization_id");
  assert.deepEqual(rows.map((x) => [x.organization_id, x.meta_account_id]).sort(), [[ORGS.C, 'act_C001'], [ORGS.D, 'act_D001']].sort());
});

// ── Erro e cancelamento ───────────────────────────────────────────────────────────────────────

test('cancelamento pelo usuário na Meta vira estado de integração (error/permissão), sem exceção e sem segredo', async () => {
  const e = await entrar('E');
  const { state } = await iniciar(e);
  await callback(navegador(), { error: 'access_denied', error_description: 'usuario cancelou', state });
  const status = await e.req('GET', '/api/admin/integrations/meta/status');
  assert.equal(status.json.conexao.status, 'error');
  assert.ok(status.json.conexao.ultimoErroCodigo, 'o erro tem código de integração');
  assert.doesNotMatch(status.texto, /EAAG|stack|at \w+ \(/);
});

test('Dashboard · conta da loja com a conexão em erro é "com problema" (não "conectada" nem "gasto zero")', async () => {
  // E tem conta atribuída à Store, mas a conexão está em erro (cancelamento acima).
  await sup.query(`INSERT INTO meta_ad_accounts (organization_id, meta_account_id, selecionada, store_id) VALUES ($1, 'act_E001', true, $2)`, [ORGS.E, store.E]);
  const e = await entrar('E');
  const r = await e.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(r.status, 200, r.texto);
  const meta = r.json.midiaFontes.find((f) => f.provider === 'meta');
  assert.equal(meta.conectado, true);
  assert.equal(meta.comProblema, true);
});

// ── Desconectar ───────────────────────────────────────────────────────────────────────────────

test('desconectar · revoga na Meta, apaga o token e a mídia SÓ da Organization da sessão', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/integrations/meta/disconnect', { corpo: {} });
  assert.equal(r.status, 200, r.texto);
  const status = await c.req('GET', '/api/admin/integrations/meta/status');
  assert.equal(status.json.conexao.status, 'disconnected');
  assert.equal(status.json.contas.length, 0);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM meta_insights_daily WHERE organization_id = $1', [ORGS.C])).rows[0].n, 0);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM meta_insights_daily WHERE organization_id = $1', [ORGS.D])).rows[0].n, 1, 'a mídia de D continua');
  // Depois de desconectada, a fonte volta a "não conectada" (nunca "gasto zero").
  const dash = await c.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  const meta = dash.json.midiaFontes.find((f) => f.provider === 'meta');
  assert.equal(meta.conectado, false);
  assert.equal(dash.json.midia.length, 0);
});

// ── Segredos, logs e processo ─────────────────────────────────────────────────────────────────

test('segurança · nenhum token nem segredo do app Meta aparece no log do processo', () => {
  for (const segredo of ['EAAG-long-', 'EAAG-oauth-', SEGREDO_PLATAFORMA]) {
    assert.ok(!saida.includes(segredo), `"${segredo}" vazou para o log do processo`);
  }
});

test('processo · zero UNHANDLED_REJECTION e nenhuma falha por chave legada na Meta', async () => {
  await esperar(300);
  assert.doesNotMatch(saida, /UNHANDLED_REJECTION/, `rejeição não tratada no log:\n${saida.slice(-1500)}`);
  assert.doesNotMatch(saida, /não tem loja legada|STORE_WITHOUT_LEGACY_KEY/);
});

// ── Fonte ─────────────────────────────────────────────────────────────────────────────────────

function blocoDe(fonte, assinatura) {
  const inicio = fonte.indexOf(assinatura);
  assert.ok(inicio >= 0, `não encontrado: ${assinatura}`);
  const fechamento = assinatura.startsWith('app.') ? '\n});' : '\n}\n';
  const fim = fonte.indexOf(fechamento, inicio);
  assert.ok(fim > inicio, `fim do bloco não encontrado: ${assinatura}`);
  return fonte.slice(inicio, fim + fechamento.length);
}

test('fonte · a Meta (connect, callback, contas, sync) não usa a chave legada e o callback confere a Store do state', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  for (const assinatura of [
    "app.get('/api/admin/integrations/meta/connect'", "app.get('/api/admin/integrations/meta/callback'",
    "app.get('/api/admin/integrations/meta/ad-accounts'", "app.post('/api/admin/integrations/meta/select-account'",
    "app.post('/api/admin/integrations/meta/sync'", "app.post('/api/admin/integrations/meta/disconnect'",
    'async function sincronizarMeta(', 'async function sincronizarContasMeta(',
  ]) {
    assert.doesNotMatch(blocoDe(fonte, assinatura), /lojaLegadaDoContexto\(\)/, `${assinatura} voltou a exigir a chave legada`);
  }
  assert.match(blocoDe(fonte, "app.get('/api/admin/integrations/meta/callback'"), /storeDoContexto\(\) !== storeDoState/);
  assert.match(blocoDe(fonte, "app.get('/api/admin/integrations/meta/connect'"), /criarStateOAuth\(req, 'meta', \{ storeId: storeDoContexto\(\) \}\)/);
  assert.doesNotMatch(blocoDe(fonte, "app.get('/api/admin/integrations/meta/connect'"), /META_APP_ID\/META_APP_SECRET/);
  // Escopo mínimo, declarado num lugar só.
  assert.match(fonte, /const META_OAUTH_SCOPE = 'ads_read';/);
});
