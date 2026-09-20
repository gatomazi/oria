'use strict';

// Rodada de integrações core (2026-09-20) · GA4 na Store nativa (`loja_legada = NULL`):
// Conectar → OAuth → callback → propriedade → status → UTM Performance → cache, por
// `organization_id + store_id`, sem chave legada.
//
// Antes: `/google-analytics/connect` respondia `STORE_WITHOUT_LEGACY_KEY` (a conexão e o cache eram
// indexados por `loja NOT NULL`), o status da Store nativa era "desconectado" para sempre, o UTM
// Tracker ficava sem Performance e o consolidado sem GA4.
//
// O Google é simulado pelo provider mock: `oauth2.googleapis.com` troca o `code` por tokens
// (`ya29.code-<code>`), `analyticsadmin` lista propriedades conforme o code (`single…` = 1,
// `multi…` = 2) e `analyticsdata` devolve números proporcionais ao id da propriedade.
//
//   A  Store COM chave legada `sul`   — compatibilidade (linha antiga é reivindicada, não duplicada)
//   C  Store nativa                    — propriedade única, selecionada sozinha
//   D  Store nativa                    — duas propriedades, escolha explícita; isolamento

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
const ORGS = {
  A: 'a1000000-0000-4000-8000-000000000001',
  C: 'a1000000-0000-4000-8000-00000000000c',
  D: 'a1000000-0000-4000-8000-00000000000d',
};
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_ga4_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_PLATAFORMA = 'segredo-plataforma-google-ga4';

let db;
let sup;
let filho;
let saida = '';
let base;
const store = {};
const email = (l) => `ga4-${l.toLowerCase()}@teste.oria`;
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

async function criarNativa(letra) {
  const org = ORGS[letra];
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Tenant Nativo ${letra}`]);
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id', [crypto.randomUUID(), org, `Loja Nativa ${letra}`]
  );
  store[letra] = s.id;
}

async function pessoa(letra) {
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email(letra), await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [ORGS[letra], u.id]);
  await concederFeatures(sup, ORGS[letra], { financial: true, analytics_ga4: true, meta_ads: true, google_ads: true, catalog: true });
}

// Inicia o fluxo pelo produto: o `connect` redireciona ao Google com um `state` de uso único.
async function iniciar(nav) {
  const r = await nav.req('GET', '/api/admin/integrations/google-analytics/connect', { redirect: 'manual' });
  assert.equal(r.status, 302, `Conectar GA4 não pode exigir chave legada: ${r.texto}`);
  const url = new URL(r.location);
  assert.equal(url.hostname, 'accounts.google.com');
  return { url, state: url.searchParams.get('state') };
}

// O callback do Google chega SEM o cookie do painel: quem prova a legitimidade é o `state`.
const callback = (nav, params) => nav.req('GET', `/api/admin/integrations/google-analytics/callback?${new URLSearchParams(params)}`, { redirect: 'manual', semCookie: true });

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_ga4_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();
  const { rows: [sa] } = await sup.query('SELECT id FROM stores WHERE organization_id = $1', [ORGS.A]);
  store.A = sa.id;
  await criarNativa('C');
  await criarNativa('D');
  for (const l of Object.keys(ORGS)) await pessoa(l);
  // Linha ANTIGA de A (só a chave legada, sem store_id): o fluxo novo a reivindica por mapeamento.
  await inserir(sup, 'google_analytics_connections', { organization_id: ORGS.A, store_id: null, loja: 'sul', status: 'disconnected' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-ga4-srv-'));
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
      GOOGLE_CLIENT_ID: 'cliente-google', GOOGLE_CLIENT_SECRET: SEGREDO_PLATAFORMA, GOOGLE_OAUTH_REDIRECT_URI: 'https://oria.test/cb',
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

// ── Conectar (OAuth) ──────────────────────────────────────────────────────────────────────────

test('connect · Store nativa é redirecionada ao Google com state; a URL não carrega segredo da plataforma', async () => {
  const c = await entrar('C');
  const { url, state } = await iniciar(c);
  assert.ok(state && state.length >= 32, 'state anti-CSRF gerado no servidor');
  assert.equal(url.searchParams.get('client_id'), 'cliente-google');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.match(url.searchParams.get('scope'), /analytics\.readonly/, 'só leitura');
  assert.ok(!url.toString().includes(SEGREDO_PLATAFORMA), 'o segredo do app OAuth nunca vai na URL');
  const { rows: [st] } = await sup.query('SELECT provider, organization_id FROM oauth_states ORDER BY criado_em DESC LIMIT 1');
  assert.equal(st.provider, 'ga4');
  assert.equal(st.organization_id, ORGS.C, 'o state é da Organization que iniciou o fluxo');
  await c.req('POST', '/api/admin/integrations/google-analytics/disconnect', { corpo: {} });
});

test('callback · sem sessão, com state válido: conecta a Store certa, guarda token cifrado e seleciona a propriedade única', async () => {
  const c = await entrar('C');
  const { state } = await iniciar(c);
  const anonimo = navegador();
  const r = await callback(anonimo, { code: 'single-C', state });
  assert.equal(r.status, 302);
  assert.equal(new URL(r.location, base).pathname, '/admin/integracoes');

  const status = await c.req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(status.status, 200, status.texto);
  const [conexao] = status.json.conexoes;
  assert.equal(conexao.storeId, store.C);
  assert.equal(conexao.loja, null);
  assert.equal(conexao.storeNome, 'Loja Nativa C');
  assert.equal(conexao.status, 'connected');
  assert.ok(conexao.propertyId, 'uma única propriedade é selecionada automaticamente');
  assert.ok(conexao.propertyId.startsWith('555'));
  assert.equal(status.json.oauthConfigurado, true);

  const { rows } = await sup.query('SELECT store_id, loja, property_id, status FROM google_analytics_connections WHERE organization_id = $1', [ORGS.C]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].store_id, store.C);
  assert.equal(rows[0].loja, null);

  // Tokens: cifrados no banco, nunca em resposta.
  const { rows: segredos } = await sup.query("SELECT tipo, ciphertext FROM integration_secrets WHERE organization_id = $1 AND tipo IN ('refresh_token','access_token')", [ORGS.C]);
  assert.ok(segredos.length >= 1, 'o token foi guardado');
  for (const sgr of segredos) assert.ok(!String(sgr.ciphertext).includes('ya29') && !String(sgr.ciphertext).includes('code-refresh'), 'cifrado');
  assert.ok(!status.texto.includes('ya29') && !status.texto.includes('code-refresh'), 'token nunca sai na resposta');
});

test('callback · state inválido, reutilizado ou forjado não grava nada', async () => {
  const c = await entrar('C');
  const antes = (await sup.query('SELECT count(*)::int AS n, max(atualizado_em) AS ultima FROM google_analytics_connections')).rows[0];
  const anonimo = navegador();
  assert.equal((await callback(anonimo, { code: 'single-X', state: 'estado-inventado-que-nao-existe' })).status, 302);
  const { state } = await iniciar(c);
  assert.equal((await callback(anonimo, { code: 'single-C', state })).status, 302);
  // Replay do MESMO state (uso único): recusado.
  const depoisDoPrimeiro = (await sup.query('SELECT max(atualizado_em) AS ultima FROM google_analytics_connections')).rows[0];
  assert.equal((await callback(anonimo, { code: 'single-Z', state })).status, 302);
  const depoisDoReplay = (await sup.query('SELECT max(atualizado_em) AS ultima FROM google_analytics_connections')).rows[0];
  assert.deepEqual(depoisDoReplay.ultima, depoisDoPrimeiro.ultima, 'o replay do state não alterou nada');
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM google_analytics_connections')).rows[0].n, antes.n);
});

test('callback · cross-tenant: o state de D só conecta a Store de D; C não é tocada', async () => {
  const d = await entrar('D');
  const c = await entrar('C');
  const antesC = (await sup.query('SELECT property_id, atualizado_em FROM google_analytics_connections WHERE organization_id = $1', [ORGS.C])).rows[0];
  const { state } = await iniciar(d);
  await callback(navegador(), { code: 'multi-D', state });
  const linhas = (await sup.query('SELECT organization_id, store_id, loja FROM google_analytics_connections WHERE organization_id = $1', [ORGS.D])).rows;
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].store_id, store.D);
  assert.equal(linhas[0].loja, null);
  const depoisC = (await sup.query('SELECT property_id, atualizado_em FROM google_analytics_connections WHERE organization_id = $1', [ORGS.C])).rows[0];
  assert.deepEqual(depoisC, antesC, 'a conexão de C não foi tocada');
  const statusC = await c.req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(statusC.json.conexoes[0].storeId, store.C);
});

test('propriedades · com várias, o tenant escolhe: lista, seleciona pelo ID externo e outra Organization não a toma', async () => {
  const d = await entrar('D');
  const status = await d.req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(status.json.conexoes[0].status, 'connected');
  assert.equal(status.json.conexoes[0].propertyId, null, 'com duas propriedades nada é escolhido por dedução');

  const lista = await d.req('GET', '/api/admin/integrations/google-analytics/properties');
  assert.equal(lista.status, 200, lista.texto);
  assert.equal(lista.json.propriedades.length, 2);
  const escolhida = lista.json.propriedades[1];
  const sel = await d.req('POST', '/api/admin/integrations/google-analytics/property', { corpo: { propertyId: escolhida.propertyId, propertyName: escolhida.propertyName } });
  assert.equal(sel.status, 200, sel.texto);
  assert.equal(sel.json.conexao.propertyId, escolhida.propertyId, 'persiste o ID externo real, não o nome');
  assert.equal(sel.json.conexao.storeId, store.D);

  // PD-016: a propriedade de D não pode ser reivindicada por C.
  const c = await entrar('C');
  const roubo = await c.req('POST', '/api/admin/integrations/google-analytics/property', { corpo: { propertyId: escolhida.propertyId, propertyName: 'x' } });
  assert.equal(roubo.status, 409, roubo.texto);
  assert.equal(roubo.json.codigo, 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE');
});

// ── Teste de conexão ──────────────────────────────────────────────────────────────────────────

test('teste de conexão do GA4 · usa a conexão da Store nativa, sem chave legada', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/integrations/ga4/teste', { corpo: {} });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.status, 'connected');
});

// ── UTM Performance e cache ───────────────────────────────────────────────────────────────────

test('UTM Performance · a Store nativa lê o GA4 da SUA propriedade e a campanha salva reconhece a combinação', async () => {
  const c = await entrar('C');
  const criada = await c.req('POST', '/api/admin/utm/campaigns', { corpo: { nome: 'Black Friday', source: 'instagram', medium: 'paid_social', campaign: 'bf26', destinationUrl: 'https://loja.exemplo/colecao' } });
  assert.equal(criada.status, 200, criada.texto);

  const r = await c.req('GET', '/api/admin/integrations/google-analytics/performance?periodo=30d');
  assert.equal(r.status, 200, `a Performance do UTM não pode exigir chave legada: ${r.texto}`);
  assert.equal(r.json.doCache, false);
  assert.equal(r.json.linhas.length, 1);
  assert.equal(r.json.linhas[0].campanhaNome, 'Black Friday', 'a campanha salva da Store reconhece a combinação do GA4');
  assert.ok(r.json.totais.sessions > 0 && r.json.totais.revenue > 0);

  const { rows } = await sup.query('SELECT store_id, loja, periodo FROM ga4_performance_cache WHERE organization_id = $1', [ORGS.C]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].store_id, store.C, 'o cache é por store_id');
  assert.equal(rows[0].loja, null);

  const segunda = await c.req('GET', '/api/admin/integrations/google-analytics/performance?periodo=30d');
  assert.equal(segunda.json.doCache, true, 'a segunda leitura vem do cache da Store');
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM ga4_performance_cache WHERE organization_id = $1', [ORGS.C])).rows[0].n, 1, 'idempotente: não duplica');
});

test('cache · isolamento: D lê os números da propriedade dela, e o cache de C nunca vaza', async () => {
  const c = await entrar('C');
  const d = await entrar('D');
  const rc = await c.req('GET', '/api/admin/integrations/google-analytics/performance?periodo=30d');
  const rd = await d.req('GET', '/api/admin/integrations/google-analytics/performance?periodo=30d');
  assert.equal(rd.status, 200, rd.texto);
  assert.notEqual(rd.json.totais.sessions, rc.json.totais.sessions, 'propriedades diferentes → números diferentes');
  assert.equal(rd.json.doCache, false, 'D não recebeu o cache de C');
  assert.equal(rd.json.linhas[0].campanhaNome, null, 'D não tem a campanha salva de C');
  const { rows } = await sup.query('SELECT organization_id, store_id FROM ga4_performance_cache ORDER BY organization_id');
  assert.deepEqual(rows.map((x) => [x.organization_id, x.store_id]).sort(), [[ORGS.C, store.C], [ORGS.D, store.D]].sort());
});

test('consolidado · o GA4 da Store nativa (cache) entra na atribuição, sem chave legada', async () => {
  const c = await entrar('C');
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  // O consolidado só LÊ o cache `overview:custom:<from>:<to>`: semeia uma linha no formato real.
  await sup.query(
    `INSERT INTO ga4_performance_cache (organization_id, store_id, loja, periodo, dados, buscado_em) VALUES ($1, $2, NULL, $3, $4::jsonb, now())`,
    [ORGS.C, store.C, `overview:custom:${hoje}:${hoje}`, JSON.stringify({ totais: { sessions: 10, purchases: 2, revenue: 200 } })]
  );
  const r = await c.req('GET', `/api/admin/analytics/consolidado?from=${hoje}&to=${hoje}`);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.ga4Disponivel, true);
});

// ── Compatibilidade histórica e desconexão ────────────────────────────────────────────────────

test('compatibilidade · a Store COM chave legada reivindica a linha antiga (sem duplicar) e segue exposta pela chave', async () => {
  const a = await entrar('A');
  const { state } = await iniciar(a);
  await callback(navegador(), { code: 'single-A', state });
  const { rows } = await sup.query('SELECT store_id, loja, status FROM google_analytics_connections WHERE organization_id = $1', [ORGS.A]);
  assert.equal(rows.length, 1, 'a linha antiga foi reivindicada, não duplicada');
  assert.equal(rows[0].store_id, store.A);
  assert.equal(rows[0].loja, 'sul');
  assert.equal(rows[0].status, 'connected');
  const status = await a.req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(status.json.conexoes[0].loja, 'sul');
});

test('desconectar · limpa a conexão da Store (e só dela), sem apagar a linha', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/integrations/google-analytics/disconnect', { corpo: {} });
  assert.equal(r.status, 200, r.texto);
  const status = await c.req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(status.json.conexoes[0].status, 'disconnected');
  assert.equal(status.json.conexoes[0].propertyId, null);
  const d = await (await entrar('D')).req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(d.json.conexoes[0].status, 'connected', 'a conexão de D não foi afetada');
  // Desconectado: a Performance vira um estado, não um erro técnico.
  const perf = await c.req('GET', '/api/admin/integrations/google-analytics/performance?periodo=7d');
  assert.equal(perf.status, 409);
  assert.match(perf.json.error, /conecte o Google Analytics/);
});

test('erro do Google no callback vira estado de integração (error), não exceção nem segredo', async () => {
  const c = await entrar('C');
  const { state } = await iniciar(c);
  await callback(navegador(), { error: 'access_denied', state });
  const status = await c.req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(status.json.conexoes[0].status, 'error');
  assert.match(status.json.conexoes[0].lastError, /access_denied/);
});

// ── Segredos, logs e processo ─────────────────────────────────────────────────────────────────

test('segurança · nenhum token nem segredo da plataforma aparece no log do processo', () => {
  for (const segredo of ['ya29.', 'code-refresh', SEGREDO_PLATAFORMA]) {
    assert.ok(!saida.includes(segredo), `"${segredo}" vazou para o log do processo`);
  }
});

test('processo · zero UNHANDLED_REJECTION e nenhuma falha por chave legada no GA4', async () => {
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

test('fonte · o GA4 inteiro (rotas e helpers) não chama lojaLegadaDoContexto() e o callback confere a Store do state', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  const blocos = [
    "app.get('/api/admin/integrations/google-analytics/status'", "app.get('/api/admin/integrations/google-analytics/connect'",
    "app.get('/api/admin/integrations/google-analytics/callback'", "app.get('/api/admin/integrations/google-analytics/properties'",
    "app.post('/api/admin/integrations/google-analytics/property'", "app.post('/api/admin/integrations/google-analytics/disconnect'",
    "app.get('/api/admin/integrations/google-analytics/performance'", "app.get('/api/admin/integrations/google-analytics/performance/series'",
    "app.get('/api/admin/integrations/google-analytics/overview'",
    'async function obterConexaoGA4()', 'async function salvarTokensGA4(', 'async function marcarErroGA4(', 'async function salvarPropriedadeGA4(',
    'async function desconectarGA4()', 'async function obterAccessTokenValidoGA4()', 'async function obterCachePerformanceGA4(',
    'async function salvarCachePerformanceGA4(', 'async function listarUtmCampanhasParaMatch()', 'async function atribuicaoGA4(',
  ];
  for (const assinatura of blocos) {
    assert.doesNotMatch(blocoDe(fonte, assinatura), /lojaLegadaDoContexto\(\)/, `${assinatura} voltou a exigir a chave legada`);
  }
  const cb = blocoDe(fonte, "app.get('/api/admin/integrations/google-analytics/callback'");
  assert.match(cb, /storeDoContexto\(\) !== storeId/, 'o callback precisa conferir que a Store do state é a da Organization do state');
  assert.match(blocoDe(fonte, "app.get('/api/admin/integrations/google-analytics/connect'"), /criarStateOAuth\(req, 'ga4', \{ storeId \}\)/);
  // O tenant nunca lê o nome das variáveis da plataforma.
  assert.doesNotMatch(blocoDe(fonte, "app.get('/api/admin/integrations/google-analytics/connect'"), /GOOGLE_CLIENT_ID\/GOOGLE_CLIENT_SECRET/);
});

test('fonte · escritas do GA4 carregam store_id (nenhum write novo só por loja)', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  assert.match(blocoDe(fonte, 'async function salvarTokensGA4('), /INSERT INTO google_analytics_connections \(store_id, loja,/);
  assert.match(blocoDe(fonte, 'async function marcarErroGA4('), /INSERT INTO google_analytics_connections \(store_id, loja,/);
  assert.match(blocoDe(fonte, 'async function salvarCachePerformanceGA4('), /INSERT INTO ga4_performance_cache \(store_id, loja,/);
});
