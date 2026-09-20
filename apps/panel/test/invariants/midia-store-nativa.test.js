'use strict';

// Rodada de mídia (2026-09-20): atribuição de conta de anúncio (Meta e Google Ads), despesas e UTM
// por `organization_id + store_id`, com a Store nativa do Oria (`loja_legada = NULL`).
//
// O que faltava: a conta de anúncios era atribuída a uma loja pelo TEXTO `loja_atribuida`
// (`sul`/`centro`/`norte`). A Store nativa não tem valor possível para ele: selecionar conta exigia a
// chave legada, o gasto nunca era atribuído, e Dashboard e Financeiro mostravam lucro sem descontar
// mídia. Despesas e campanhas UTM eram `loja NOT NULL` — a Store nativa nem conseguia cadastrá-las.
//
// Cenário (cada Organization com um caso de atribuição diferente):
//   A  Store COM chave legada `sul`; contas atribuídas pelo texto (store_id NULL) — compatibilidade
//   C  nativa; contas atribuídas por store_id                      → gasto entra
//   D  nativa; contas atribuídas; MESMO customer id do Google que C → nunca cruza
//   E  nativa; conta selecionada mas SEM loja atribuída             → fora do total, sinalizada
//   F  nativa; nenhuma conta                                        → "não conectada" ≠ gasto zero
//   G  nativa; conta atribuída, ZERO gasto no período               → gasto zero de verdade
//   H  nativa; conta com texto legado `sul` e sem store_id          → NÃO cai no ramo legado

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
const { resolverMidiaDaOrganizacao } = h.sujeito('lib/financeiro/midia.js');
const { inserir, limparCache, concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORGS = {
  A: 'a1000000-0000-4000-8000-000000000001',
  C: 'a1000000-0000-4000-8000-00000000000c',
  D: 'a1000000-0000-4000-8000-00000000000d',
  E: 'a1000000-0000-4000-8000-00000000000e',
  F: 'a1000000-0000-4000-8000-00000000000f',
  G: 'a1000000-0000-4000-8000-000000000010',
  H: 'a1000000-0000-4000-8000-000000000011',
};
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_midia_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const CUSTOMER_COMPARTILHADO = '1111111111';

let db;
let sup;
let filho;
let saida = '';
let base;
const store = {}; // letra → store_id
const email = (letra) => `midia-${letra.toLowerCase()}@teste.oria`;

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    // Timeout: o defeito histórico deste tipo de rota era "a requisição nunca responde".
    const res = await fetch(base + caminho, {
      method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(8000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto };
  };
  nav.entrar = async (letra) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email: email(letra), password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}

const entrar = (letra) => navegador().entrar(letra);

async function criarNativa(letra) {
  const org = ORGS[letra];
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Tenant Nativo ${letra}`]);
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id',
    [crypto.randomUUID(), org, `Loja Nativa ${letra}`]
  );
  store[letra] = s.id;
}

async function pessoa(letra) {
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email(letra), await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [ORGS[letra], u.id]);
  await concederFeatures(sup, ORGS[letra], { financial: true, meta_ads: true, google_ads: true, analytics_ga4: true, whatsapp: true, catalog: true });
}

async function contaMeta(letra, { id, storeId = null, lojaAtribuida = null, selecionada = true, gasto = null }) {
  await inserir(sup, 'meta_ad_accounts', { organization_id: ORGS[letra], meta_account_id: id, selecionada, store_id: storeId, loja_atribuida: lojaAtribuida });
  if (gasto !== null) {
    await inserir(sup, 'meta_insights_daily', { organization_id: ORGS[letra], meta_account_id: id, level: 'account', entidade_id: id, data: HOJE, spend: gasto });
  }
}

async function contaGoogle(letra, { id, storeId = null, lojaAtribuida = null, selecionada = true, gasto = null }) {
  await inserir(sup, 'google_ads_customers', { organization_id: ORGS[letra], customer_id: id, selecionada, store_id: storeId, loja_atribuida: lojaAtribuida });
  if (gasto !== null) {
    await inserir(sup, 'google_ads_insights_daily', {
      organization_id: ORGS[letra], customer_id: id, level: 'customer', entidade_id: id, data: HOJE, contagem_conversao: 'conversions', custo: gasto,
    });
  }
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_midia_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();

  const { rows: [sa] } = await sup.query('SELECT id FROM stores WHERE organization_id = $1', [ORGS.A]);
  store.A = sa.id;
  for (const letra of ['C', 'D', 'E', 'F', 'G', 'H']) await criarNativa(letra);
  for (const letra of Object.keys(ORGS)) await pessoa(letra);

  // A — legada: atribuição só pelo texto (store_id NULL). Compatibilidade histórica.
  await contaMeta('A', { id: 'act_A', lojaAtribuida: 'sul', gasto: 55 });
  await contaGoogle('A', { id: '3333333333', lojaAtribuida: 'sul', gasto: 5 });
  // C — nativa, atribuída por store_id. Mais uma conta Meta e uma Google NÃO selecionadas, para o
  // fluxo de selecionar/atribuir pela API.
  await contaMeta('C', { id: 'act_C', storeId: store.C, gasto: 100 });
  await contaMeta('C', { id: 'act_C2', selecionada: false });
  await contaGoogle('C', { id: CUSTOMER_COMPARTILHADO, storeId: store.C, gasto: 20 });
  await contaGoogle('C', { id: '2222222222', selecionada: false });
  // D — nativa, MESMO customer id do Google de C, gasto bem diferente.
  await contaMeta('D', { id: 'act_D', storeId: store.D, gasto: 7000 });
  await contaGoogle('D', { id: CUSTOMER_COMPARTILHADO, storeId: store.D, gasto: 9000 });
  // E — conta selecionada, sem Store atribuída: o gasto NÃO entra.
  await contaMeta('E', { id: 'act_E', gasto: 999 });
  // F — nenhuma conta.
  // G — conta atribuída, zero gasto.
  await contaMeta('G', { id: 'act_G', storeId: store.G });
  // H — nativa, conta com o texto legado `sul` e sem store_id: não pode cair no ramo legado.
  await contaMeta('H', { id: 'act_H', lojaAtribuida: 'sul', gasto: 4242 });

  // Um pedido pago hoje em C, para o consolidado ter receita e lucro do produto.
  await inserir(sup, 'pedidos_ink', {
    organization_id: ORGS.C, store_id: store.C, loja: null, ink_order_id: 910001, payment_status: 'paid', order_status: 'producing',
    buyer_nome: 'Cliente C', total_value: 300, lucro_operacional: 120, lucro_bruto: 300, frete: 0, descontos: 0, custo_producao: 180,
    criado_em: new Date().toISOString(), items_count: 1,
  });

  const mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-midia-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-midia-srv-'));
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

const totalMidia = (json) => json.midia.reduce((acc, m) => acc + Number(m.spend), 0);
const fonte = (json, provider) => json.midiaFontes.find((f) => f.provider === provider);

// ── Dashboard: o gasto certo, atribuído à Store certa ─────────────────────────────────────────

test('Dashboard · Store nativa recebe o gasto das contas atribuídas por store_id (Meta + Google)', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(r.status, 200, r.texto);
  assert.equal(totalMidia(r.json), 120, `Meta 100 + Google 20: ${JSON.stringify(r.json.midia)}`);
  for (const m of r.json.midia) assert.equal(m.loja, null, 'a Store nativa não tem chave legada — e não pode precisar de uma');
  assert.equal(fonte(r.json, 'meta').conectado, true);
  assert.equal(fonte(r.json, 'google_ads').conectado, true);
  assert.deepEqual(r.json.midiaSinalizada, []);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(saida, /gasto de mídia indisponível/);
});

test('Dashboard · isolamento: C e D compartilham o MESMO customer id do Google e cada uma soma só o dela', async () => {
  const [c, d, a] = await Promise.all([entrar('C'), entrar('D'), entrar('A')]);
  // Intercalado e concorrente: nenhuma resposta pode trazer o gasto de outra Organization.
  const ordem = ['C', 'D', 'A', 'D', 'C', 'A', 'C', 'D'];
  const navs = { C: c, D: d, A: a };
  const respostas = await Promise.all(ordem.map((l) => navs[l].req('GET', '/api/admin/dashboard/financeiro?dias=30').then((r) => ({ l, r }))));
  const esperado = { C: 120, D: 16000, A: 60 };
  for (const { l, r } of respostas) {
    assert.equal(r.status, 200, r.texto);
    assert.equal(totalMidia(r.json), esperado[l], `${l}: ${JSON.stringify(r.json.midia)}`);
  }
});

test('Dashboard · compatibilidade histórica: Store COM chave legada continua atribuída pelo texto', async () => {
  const a = await entrar('A');
  const r = await a.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(r.status, 200, r.texto);
  assert.equal(totalMidia(r.json), 60);
  for (const m of r.json.midia) assert.equal(m.loja, 'sul');
});

test('fonte única de mídia SEM RLS por baixo: a consulta carrega o organization_id — só a conta da própria Organization entra', async () => {
  // Pool de superusuário: a RLS não filtra. O que isola aqui é o `organization_id` escrito na query,
  // a segunda camada que o Postgres confere de novo por baixo em produção.
  const pool = runtime.criarPoolTenant(sup);
  const consultar = (letra, loja) => runtime.comContexto({ organizationId: ORGS[letra], storeId: store[letra], loja },
    () => resolverMidiaDaOrganizacao(pool, { organizationId: ORGS[letra], storeId: store[letra], loja, from: HOJE, to: HOJE }));

  const c = await consultar('C', null);
  assert.deepEqual(c.fontes.map((f) => [f.provider, f.spend, f.conectado]), [['meta', 100, true], ['google_ads', 20, true]]);
  const d = await consultar('D', null);
  assert.deepEqual(d.fontes.map((f) => [f.provider, f.spend]), [['meta', 7000], ['google_ads', 9000]]);
  const a = await consultar('A', 'sul');
  assert.deepEqual(a.fontes.map((f) => [f.provider, f.spend]), [['meta', 55], ['google_ads', 5]]);
});

test('Dashboard · Store nativa NUNCA cai no ramo legado: conta com texto `sul` e sem store_id fica fora e é sinalizada', async () => {
  const hh = await entrar('H');
  const r = await hh.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(r.status, 200, r.texto);
  assert.equal(totalMidia(r.json), 0, 'os 4242 da conta "sul" NÃO entram no lucro da Store nativa H');
  assert.equal(fonte(r.json, 'meta').conectado, false);
  assert.equal(fonte(r.json, 'meta').motivo, 'outra_loja');
  assert.deepEqual(r.json.midiaSinalizada.map((s) => [s.provider, s.motivo]), [['meta', 'outra_loja']]);
});

// ── integração ausente ≠ gasto zero ───────────────────────────────────────────────────────────

test('estado da mídia · sem conta ≠ conta sem loja ≠ conta da loja com gasto zero', async () => {
  const f = await (await entrar('F')).req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(f.status, 200, f.texto);
  assert.equal(totalMidia(f.json), 0);
  assert.deepEqual(f.json.midiaFontes.map((x) => [x.provider, x.conectado, x.motivo]), [['meta', false, null], ['google_ads', false, null]],
    'F não tem nenhuma conta: "não conectada", não "gasto zero"');
  assert.deepEqual(f.json.midiaSinalizada, []);

  const e = await (await entrar('E')).req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(totalMidia(e.json), 0, 'os 999 da conta sem loja não entram');
  assert.equal(fonte(e.json, 'meta').motivo, 'sem_loja');
  assert.deepEqual(e.json.midiaSinalizada.map((s) => [s.provider, s.motivo]), [['meta', 'sem_loja']]);

  const g = await (await entrar('G')).req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(totalMidia(g.json), 0);
  assert.equal(fonte(g.json, 'meta').conectado, true, 'G tem conta da loja: gasto zero de verdade');
  assert.equal(fonte(g.json, 'meta').motivo, null);
});

// ── Financeiro: o consolidado compõe receita, mídia e despesas da Store nativa ────────────────

test('Financeiro · consolidado da Store nativa: 200, com o gasto de mídia das contas atribuídas', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', `/api/admin/analytics/consolidado?from=${HOJE}&to=${HOJE}`);
  assert.equal(r.status, 200, `o consolidado não pode exigir chave legada: ${r.texto}`);
  assert.equal(r.json.resultado.totalMidia, 120);
  assert.equal(r.json.loja.id, null);
  assert.equal(r.json.loja.storeId, store.C);
  assert.equal(r.json.loja.nome, 'Loja Nativa C', 'o rótulo vem da Store, não do enum de lojas legadas');
  assert.deepEqual(r.json.midiaSinalizada, []);
  assert.equal(r.json.ga4Disponivel, false, 'GA4 ainda é por chave legada: sem chave, indisponível — e explícito');
  assert.equal(r.json.cobertura.receitaTotal, 300);
});

test('Financeiro · despesas da Store nativa: cadastra, lista, entra no consolidado; D não vê', async () => {
  const c = await entrar('C');
  const criada = await c.req('POST', '/api/admin/financeiro/despesas', {
    corpo: { categoria: 'APPS', descricao: 'Mensalidade de ferramenta', valor: 50, data: HOJE, recorrencia: 'unica' },
  });
  assert.equal(criada.status, 201, `despesa não pode exigir chave legada: ${criada.texto}`);
  const { rows: [linha] } = await sup.query('SELECT store_id, loja FROM despesas_operacionais WHERE id = $1', [criada.json.id]);
  assert.equal(linha.store_id, store.C);
  assert.equal(linha.loja, null);

  const lista = await c.req('GET', '/api/admin/financeiro/despesas');
  assert.equal(lista.status, 200, lista.texto);
  assert.equal(lista.json.despesas.length, 1);

  const consolidado = await c.req('GET', `/api/admin/analytics/consolidado?from=${HOJE}&to=${HOJE}`);
  assert.equal(consolidado.status, 200, consolidado.texto);
  assert.equal(consolidado.json.despesas.total, 50);

  const d = await entrar('D');
  const listaD = await d.req('GET', '/api/admin/financeiro/despesas');
  assert.equal(listaD.status, 200, listaD.texto);
  assert.equal(listaD.json.despesas.length, 0, 'a despesa de C não aparece para D');
});

test('Financeiro · despesa histórica (sem store_id, com loja) só aparece para a Store que TEM essa chave', async () => {
  await sup.query(
    `INSERT INTO despesas_operacionais (organization_id, store_id, loja, categoria, descricao, valor, data, recorrencia)
     VALUES ($1, NULL, 'sul', 'APPS', 'Despesa antiga da loja sul', 10, $2, 'unica')`, [ORGS.A, HOJE]
  );
  const a = await (await entrar('A')).req('GET', '/api/admin/financeiro/despesas');
  assert.equal(a.status, 200, a.texto);
  assert.deepEqual(a.json.despesas.map((x) => x.descricao), ['Despesa antiga da loja sul']);
  const cLista = await (await entrar('C')).req('GET', '/api/admin/financeiro/despesas');
  assert.ok(!cLista.json.despesas.some((x) => x.descricao === 'Despesa antiga da loja sul'));
});

test('Financeiro · conta sem loja atribuída NÃO entra no consolidado e vem sinalizada', async () => {
  const e = await (await entrar('E')).req('GET', `/api/admin/analytics/consolidado?from=${HOJE}&to=${HOJE}`);
  assert.equal(e.status, 200, e.texto);
  assert.equal(e.json.resultado.totalMidia, 0);
  assert.deepEqual(e.json.midiaSinalizada.map((s) => [s.provider, s.motivo]), [['meta', 'sem_loja']]);
});

// ── Atribuir a conta à Store nativa pelo próprio produto ──────────────────────────────────────

test('Meta · selecionar conta atribui à Store canônica (store_id), sem exigir a chave legada', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: 'act_C2' } });
  assert.equal(r.status, 200, `selecionar conta Meta não pode exigir chave legada: ${r.texto}`);
  const { rows } = await sup.query('SELECT meta_account_id, selecionada, store_id, loja_atribuida FROM meta_ad_accounts WHERE organization_id = $1 ORDER BY meta_account_id', [ORGS.C]);
  const c2 = rows.find((x) => x.meta_account_id === 'act_C2');
  assert.equal(c2.selecionada, true);
  assert.equal(c2.store_id, store.C);
  assert.equal(c2.loja_atribuida, null, 'o texto legado só espelha — e a Store nativa não tem');
  assert.equal(rows.filter((x) => x.selecionada).length, 1, 'continua UMA conta selecionada por Organization');

  const status = await c.req('GET', '/api/admin/integrations/meta/status');
  assert.equal(status.status, 200, status.texto);
  const conta = status.json.contas.find((x) => x.metaAccountId === 'act_C2');
  assert.equal(conta.atribuidaAEstaStore, true);
  assert.equal(status.json.contas.find((x) => x.metaAccountId === 'act_C').atribuidaAEstaStore, true, 'a anterior já era da Store, só deixou de ser a selecionada');
});

test('Google Ads · selecionar e atribuir conta à Store nativa; status diz se a conta é desta Store', async () => {
  const c = await entrar('C');
  const sel = await c.req('POST', '/api/admin/integrations/google-ads/contas/2222222222/selecionar', { corpo: {} });
  assert.equal(sel.status, 200, `selecionar conta Google Ads não pode exigir chave legada: ${sel.texto}`);
  const { rows: [cliente] } = await sup.query('SELECT selecionada, store_id, loja_atribuida FROM google_ads_customers WHERE organization_id = $1 AND customer_id = $2', [ORGS.C, '2222222222']);
  assert.equal(cliente.selecionada, true);
  assert.equal(cliente.store_id, store.C);
  assert.equal(cliente.loja_atribuida, null);

  // E: conta selecionada SEM loja — o aviso "Vincular à loja" existe para isto, e tem de funcionar.
  await sup.query('UPDATE google_ads_customers SET store_id = NULL WHERE organization_id = $1 AND customer_id = $2', [ORGS.C, '2222222222']);
  let st = await c.req('GET', '/api/admin/integrations/google-ads/status');
  assert.equal(st.status, 200, st.texto);
  assert.equal(st.json.contas.find((x) => x.customerId === '2222222222').atribuidaAEstaStore, false);
  const vinc = await c.req('POST', '/api/admin/integrations/google-ads/contas/2222222222/loja', { corpo: {} });
  assert.equal(vinc.status, 200, `vincular à loja não pode exigir chave legada: ${vinc.texto}`);
  st = await c.req('GET', '/api/admin/integrations/google-ads/status');
  assert.equal(st.json.contas.find((x) => x.customerId === '2222222222').atribuidaAEstaStore, true);
});

test('Meta e Google não cruzam Organizations: C não seleciona a conta de D, e o status de C não lista contas de D', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/integrations/meta/select-account', { corpo: { metaAccountId: 'act_D' } });
  assert.equal(r.status, 404, r.texto);
  const g = await c.req('POST', `/api/admin/integrations/google-ads/contas/${CUSTOMER_COMPARTILHADO}/selecionar`, { corpo: {} });
  // O customer id é o MESMO nas duas Organizations, mas cada uma só enxerga (e seleciona) o seu.
  assert.equal(g.status, 200, g.texto);
  const { rows } = await sup.query('SELECT organization_id, store_id FROM google_ads_customers WHERE customer_id = $1 ORDER BY organization_id', [CUSTOMER_COMPARTILHADO]);
  for (const linha of rows) {
    if (linha.organization_id === ORGS.C) assert.equal(linha.store_id, store.C);
    if (linha.organization_id === ORGS.D) assert.equal(linha.store_id, store.D, 'a atribuição de D não foi tocada por C');
  }
  const status = await c.req('GET', '/api/admin/integrations/meta/status');
  assert.ok(!status.json.contas.some((x) => x.metaAccountId === 'act_D' || x.metaAccountId === 'act_A'));
});

test('banco · FK composta: conta atribuída a uma Store de OUTRA Organization é recusada', async () => {
  await assert.rejects(
    sup.query('UPDATE meta_ad_accounts SET store_id = $1 WHERE organization_id = $2 AND meta_account_id = $3', [store.D, ORGS.C, 'act_C']),
    /fk_meta_ad_accounts_store/,
    'store_id tem de pertencer à organization_id da linha'
  );
  await assert.rejects(
    sup.query('UPDATE google_ads_customers SET store_id = $1 WHERE organization_id = $2 AND customer_id = $3', [store.D, ORGS.C, CUSTOMER_COMPARTILHADO]),
    /fk_google_ads_customers_store/
  );
  await assert.rejects(
    sup.query(`INSERT INTO despesas_operacionais (organization_id, store_id, loja, categoria, descricao, valor, data) VALUES ($1, $2, NULL, 'x', 'x', 1, $3)`, [ORGS.C, store.D, HOJE]),
    /fk_despesas_operacionais_store/
  );
  await assert.rejects(
    sup.query(`INSERT INTO despesas_operacionais (organization_id, store_id, loja, categoria, descricao, valor, data) VALUES ($1, NULL, NULL, 'x', 'x', 1, $2)`, [ORGS.C, HOJE]),
    /ck_despesas_operacionais_store_ou_loja/,
    'despesa nova sem nenhuma identidade de Store é recusada pelo banco'
  );
});

// ── UTM Tracker ───────────────────────────────────────────────────────────────────────────────

test('UTM · Store nativa cria, lista, edita e duplica campanha sem chave legada; D e A não veem', async () => {
  const c = await entrar('C');
  const corpo = { nome: 'Black Friday', source: 'instagram', medium: 'paid_social', campaign: 'bf26', destinationUrl: 'https://loja.exemplo/colecao' };
  const criada = await c.req('POST', '/api/admin/utm/campaigns', { corpo });
  assert.equal(criada.status, 200, `UTM não pode exigir chave legada: ${criada.texto}`);
  assert.equal(criada.json.campanha.storeId, store.C);
  assert.equal(criada.json.campanha.loja, null);
  const id = criada.json.campanha.id;

  const lista = await c.req('GET', '/api/admin/utm/campaigns');
  assert.equal(lista.status, 200, lista.texto);
  assert.deepEqual(lista.json.campanhas.map((x) => x.nome), ['Black Friday']);

  const editada = await c.req('PATCH', `/api/admin/utm/campaigns/${id}`, { corpo: { ...corpo, nome: 'Black Friday 2026' } });
  assert.equal(editada.status, 200, editada.texto);
  assert.equal(editada.json.campanha.storeId, store.C);

  const dup = await c.req('POST', `/api/admin/utm/campaigns/${id}/duplicate`, { corpo: {} });
  assert.equal(dup.status, 200, dup.texto);
  assert.equal(dup.json.campanha.storeId, store.C, 'a cópia nasce na mesma Store');
  assert.equal(dup.json.campanha.loja, null);

  const d = await (await entrar('D')).req('GET', '/api/admin/utm/campaigns');
  assert.equal(d.status, 200, d.texto);
  assert.deepEqual(d.json.campanhas, [], 'as campanhas de C não aparecem para D');
});

test('UTM · compatibilidade: campanha histórica (sem store_id, com loja) só aparece para a Store que TEM a chave', async () => {
  await sup.query(
    `INSERT INTO utm_campaigns (organization_id, store_id, loja, nome, url_destino, utm_source, utm_medium, utm_campaign, url_completa)
     VALUES ($1, NULL, 'sul', 'Campanha histórica sul', 'https://x.exemplo', 'a', 'b', 'c', 'https://x.exemplo?utm_source=a')`, [ORGS.A]
  );
  const a = await (await entrar('A')).req('GET', '/api/admin/utm/campaigns');
  assert.equal(a.status, 200, a.texto);
  assert.deepEqual(a.json.campanhas.map((x) => x.nome), ['Campanha histórica sul']);
  const c = await (await entrar('C')).req('GET', '/api/admin/utm/campaigns');
  assert.ok(!c.json.campanhas.some((x) => x.nome === 'Campanha histórica sul'));
});

// ── Jobs: contexto explícito, sem "loja atual" implícita ──────────────────────────────────────

test('jobs · o runner entrega Organization + Store + chave legada (nula na nativa) a cada execução', async () => {
  const { rows } = await sup.query('SELECT organization_id, store_id, loja_legada FROM tenancy_organizations_para_jobs()');
  const porOrg = Object.fromEntries(rows.map((r) => [r.organization_id, r]));
  assert.equal(porOrg[ORGS.C].store_id, store.C);
  assert.equal(porOrg[ORGS.C].loja_legada, null);
  assert.equal(porOrg[ORGS.A].loja_legada, 'sul');
});

function corpoDeFuncao(fonte, assinatura) {
  const inicio = fonte.indexOf(assinatura);
  assert.ok(inicio >= 0, `função não encontrada: ${assinatura}`);
  const fim = fonte.indexOf('\n}\n', inicio);
  return fonte.slice(inicio, fim + 3);
}

test('jobs · os jobs de mídia não dependem da "loja atual": nenhum chama a chave legada', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  for (const assinatura of ['async function jobIncrementalMeta()', 'async function jobDiarioMeta()', 'async function jobRenovarTokenMeta()',
    'async function sincronizarMeta(', 'async function sincronizarInsightsMeta(', 'async function sincronizarContasMeta(',
    'async function sincronizarContasGoogleAds()', 'async function sincronizarInsightsGoogleAds(']) {
    assert.doesNotMatch(corpoDeFuncao(fonte, assinatura), /lojaLegadaDoContexto\(\)/, `${assinatura} voltou a depender da chave legada`);
  }
});

// ── Processo e fonte ──────────────────────────────────────────────────────────────────────────

test('processo · zero UNHANDLED_REJECTION depois de todos os fluxos de mídia', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.doesNotMatch(saida, /UNHANDLED_REJECTION/, `rejeição não tratada no log:\n${saida.slice(-1500)}`);
});

function blocoDaRota(fonte, assinatura) {
  const inicio = fonte.indexOf(assinatura);
  assert.ok(inicio >= 0, `rota ou função não encontrada: ${assinatura}`);
  const fechamento = assinatura.startsWith('app.') ? '\n});' : '\n}\n';
  const fim = fonte.indexOf(fechamento, inicio);
  assert.ok(fim > inicio, `fim do bloco não encontrado: ${assinatura}`);
  return fonte.slice(inicio, fim + fechamento.length);
}

test('fonte · atribuição, consolidado, despesas e UTM migrados não chamam lojaLegadaDoContexto()', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  const blocos = [
    "app.post('/api/admin/integrations/meta/select-account'",
    "app.post('/api/admin/integrations/google-ads/contas/:customerId/selecionar'",
    "app.post('/api/admin/integrations/google-ads/contas/:customerId/loja'",
    "app.get('/api/admin/analytics/consolidado'",
    "app.get('/api/admin/financeiro/despesas'",
    "app.post('/api/admin/financeiro/despesas'",
    "app.get('/api/admin/utm/campaigns'",
    "app.post('/api/admin/utm/campaigns'",
    "app.patch('/api/admin/utm/campaigns/:id'",
    "app.post('/api/admin/utm/campaigns/:id/duplicate'",
    'function prepararUtmCampanha(body)',
    'async function listarDespesas()',
    'function midiaDaOrganizacao(from, to)',
    'function contaAtribuidaAEstaStore(conta)',
  ];
  for (const assinatura of blocos) {
    assert.doesNotMatch(blocoDaRota(fonte, assinatura), /lojaLegadaDoContexto\(\)/, `${assinatura} voltou a exigir a chave legada`);
  }
  // O resolver recebe a Store canônica; a chave legada só entra como compatibilidade.
  assert.match(blocoDaRota(fonte, 'function midiaDaOrganizacao(from, to)'), /storeId: storeDoContexto\(\)/);
});

test('fonte · a fonte única de mídia decide por store_id primeiro e o ramo legado exige chave legada', () => {
  const fonte = fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'lib', 'financeiro', 'midia.js'), 'utf8');
  const bloco = blocoDaRota(fonte, 'function motivoDeExclusao(conta, { storeId, loja })');
  assert.match(bloco, /conta\.store_id/);
  assert.match(bloco, /loja && conta\.loja_atribuida === loja/, 'sem chave legada, o texto histórico nunca casa');
});
