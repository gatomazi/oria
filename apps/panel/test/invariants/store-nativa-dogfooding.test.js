'use strict';

// Rodada de dogfooding (2026-09-19): a Store nativa do Oria (`loja_legada = NULL`) em Dashboard,
// Clientes e Financeiro, no processo real do server.js sob a role da aplicação (RLS ligada).
//
// O que a produção mostrou: `lojaLegadaDoContexto()` lançava dentro de handlers `async`; o Express 4
// não observa a promise, então a requisição nunca respondia (a tela ficava em "Carregando" para
// sempre) e o processo registrava `[UNHANDLED_REJECTION]`. E o Dashboard comparava `item.loja ===
// ''` com a `loja: null` que o servidor devolve, filtrando tudo e mostrando zeros.
//
// Cenário: A = Store COM chave legada (`sul`), C e D = Stores nativas (duas, para o isolamento).
// Cada uma tem dados próprios e reconhecíveis; nenhum aparece na resposta do outro.

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
const ORG_A = 'a1000000-0000-4000-8000-000000000001'; // Store legada `sul`
const ORG_C = 'a1000000-0000-4000-8000-00000000000c'; // Store nativa
const ORG_D = 'a1000000-0000-4000-8000-00000000000d'; // Store nativa
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_dogf_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const TOKEN_INK = { [ORG_A]: `inkA${crypto.randomBytes(10).toString('hex')}`, [ORG_C]: `inkC${crypto.randomBytes(10).toString('hex')}`, [ORG_D]: `inkD${crypto.randomBytes(10).toString('hex')}` };
const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

let db;
let sup;
let filho;
let saida = '';
let base;
let mockLog;
const store = {}; // organizationId → store_id

const chamadasMock = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    // Timeout: o defeito original era exatamente "a requisição nunca responde".
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
  nav.entrar = async (email) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email, password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}

async function criarOrganizacao(org, nome, lojaLegada) {
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2) ON CONFLICT DO NOTHING', [org, nome]);
  if (lojaLegada === undefined) return;
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id',
    [crypto.randomUUID(), org, nome]
  );
  store[org] = s.id;
}

async function criarPessoa(email, org) {
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [org, u.id]);
}

async function pedido(org, { inkOrderId, doc, nome, total, lucro, comStoreId = true, loja = null, dias = 0 }) {
  return inserir(sup, 'pedidos_ink', {
    organization_id: org,
    store_id: comStoreId ? store[org] : null,
    loja,
    ink_order_id: inkOrderId,
    payment_status: 'paid',
    order_status: 'producing',
    buyer_nome: nome,
    buyer_documento: doc,
    total_value: total,
    lucro_operacional: lucro,
    lucro_bruto: total,
    frete: 0,
    descontos: 0,
    custo_producao: total - lucro,
    criado_em: new Date(Date.now() - dias * 86_400_000).toISOString(),
    items_count: 1,
  });
}

const PRODUTO_ID = { 'Estampa Cidade C': 500001, 'Estampa Cidade D': 500002, 'Estampa Cidade A': 500003 };

async function item(org, { inkOrderId, itemId, produto, valor, custo, comStoreId = true, loja = null }) {
  return inserir(sup, 'pedidos_ink_itens', {
    organization_id: org,
    store_id: comStoreId ? store[org] : null,
    loja,
    ink_order_id: inkOrderId,
    item_id: itemId,
    // O mesmo produto tem UM id em todos os itens dele (o ranking agrupa por produto_id).
    produto_id: PRODUTO_ID[produto],
    produto_nome: produto,
    modelo: 'Camiseta',
    quantidade: 1,
    valor_venda: valor,
    desconto_rateado: 0,
    custo_producao: custo,
    lucro_operacional: valor - custo,
  });
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_dogf_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();

  // A: a Store `sul` já vem do mapeamento do cenário. C e D: Stores nativas, loja_legada NULA.
  const { rows: [sa] } = await sup.query('SELECT id FROM stores WHERE organization_id = $1', [ORG_A]);
  store[ORG_A] = sa.id;
  await criarOrganizacao(ORG_C, 'Tenant Nativo C', null);
  await criarOrganizacao(ORG_D, 'Tenant Nativo D', null);
  for (const [org, email] of [[ORG_A, 'dogf-a@teste.oria'], [ORG_C, 'dogf-c@teste.oria'], [ORG_D, 'dogf-d@teste.oria']]) {
    await criarPessoa(email, org);
    await concederFeatures(sup, org, { financial: true, catalog: true, exchanges: true, refunds: true, whatsapp: true });
  }

  // C: dois pedidos do mesmo cliente (union-find por documento) + itens.
  await pedido(ORG_C, { inkOrderId: 700001, doc: '11111111111', nome: 'Cliente C1', total: 100, lucro: 40 });
  await pedido(ORG_C, { inkOrderId: 700002, doc: '11111111111', nome: 'Cliente C1', total: 50, lucro: 10, dias: 1 });
  await item(ORG_C, { inkOrderId: 700001, itemId: 800001, produto: 'Estampa Cidade C', valor: 100, custo: 60 });
  await item(ORG_C, { inkOrderId: 700002, itemId: 800002, produto: 'Estampa Cidade C', valor: 50, custo: 40 });
  // D: um pedido, valores bem diferentes.
  await pedido(ORG_D, { inkOrderId: 700101, doc: '22222222222', nome: 'Cliente D1', total: 300, lucro: 120 });
  await item(ORG_D, { inkOrderId: 700101, itemId: 800101, produto: 'Estampa Cidade D', valor: 300, custo: 180 });
  // A (legada): uma linha HISTÓRICA (store_id NULL, só `loja`) e uma nova (store_id + loja).
  await pedido(ORG_A, { inkOrderId: 700201, doc: '33333333333', nome: 'Cliente A legado', total: 200, lucro: 80, comStoreId: false, loja: 'sul' });
  await pedido(ORG_A, { inkOrderId: 700202, doc: '44444444444', nome: 'Cliente A novo', total: 60, lucro: 20, loja: 'sul' });
  await item(ORG_A, { inkOrderId: 700201, itemId: 800201, produto: 'Estampa Cidade A', valor: 200, custo: 120, comStoreId: false, loja: 'sul' });

  // Estado de recuperação (app_config da Organization): registros da Store nativa não têm `loja`.
  const semLoja = { envios: [new Date().toISOString()], concluido: true, cart: { items: [{ total_price: 80 }] } };
  await sup.query("INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'carrinho-envios', $2)", [ORG_C, JSON.stringify({ 'c-1': semLoja })]);
  await sup.query("INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'carrinho-envios', $2)", [ORG_D, JSON.stringify({ 'd-1': { ...semLoja, concluido: false }, 'd-2': { ...semLoja, concluido: false } })]);
  await sup.query("INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'carrinho-envios', $2)", [ORG_A, JSON.stringify({ 'a-1': { ...semLoja, loja: 'sul' } })]);

  mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-dogf-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-dogf-srv-'));
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
    },
  }), {
    aoLer: (pedaco, { reiniciando }) => { saida = reiniciando ? '' : saida + pedaco; },
    limiteMs: 30000,
  });
  filho = processo.filho;
  base = processo.base;

  // A credencial Ink de cada Organization entra pelo caminho real de produto (cifrada em
  // integration_secrets), não por atalho de banco.
  for (const [org, email] of [[ORG_A, 'dogf-a@teste.oria'], [ORG_C, 'dogf-c@teste.oria'], [ORG_D, 'dogf-d@teste.oria']]) {
    const nav = await navegador().entrar(email);
    const salvo = await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { apiToken: TOKEN_INK[org] } });
    assert.equal(salvo.status, 200, salvo.texto);
  }
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

// ── Clientes ───────────────────────────────────────────────────────────────────────────────────

test('Clientes · Store nativa: 200 com o histórico da PRÓPRIA Store, agregado por identidade', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const r = await c.req('GET', '/api/admin/clientes');
  assert.equal(r.status, 200, `Clientes não pode exigir chave legada: ${r.texto}`);
  assert.equal(r.json.clientes.length, 1, 'os dois pedidos do mesmo documento são UM cliente');
  const [cliente] = r.json.clientes;
  assert.equal(cliente.documento, '11111111111');
  assert.equal(cliente.totalCompras, 2);
  assert.equal(cliente.lucroOperacional, 50);
  assert.equal(cliente.loja, store[ORG_C], 'a Store nativa não tem chave legada: a chave é o store_id, a mesma dos clientes da Ink (a tela cruza por `loja + documento`)');
});

test('Clientes · isolamento: C não vê D nem A, D não vê C, A (legada) vê só os dela — histórico e novo', async () => {
  const docs = async (email) => {
    const n = await navegador().entrar(email);
    const r = await n.req('GET', '/api/admin/clientes');
    assert.equal(r.status, 200, r.texto);
    return r.json.clientes.map((x) => x.documento).sort();
  };
  assert.deepEqual(await docs('dogf-c@teste.oria'), ['11111111111']);
  assert.deepEqual(await docs('dogf-d@teste.oria'), ['22222222222']);
  // Compatibilidade histórica: só quando a Store TEM chave legada, a linha antiga (store_id NULL) entra.
  assert.deepEqual(await docs('dogf-a@teste.oria'), ['33333333333', '44444444444']);
});

// ── Financeiro ─────────────────────────────────────────────────────────────────────────────────

test('Financeiro · Store nativa: resumo, movimentações, antecipações e saques respondem 200 pela credencial da Organization', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const antes = chamadasMock().length;

  const resumo = await c.req('GET', '/api/admin/financeiro/resumo');
  assert.equal(resumo.status, 200, `Financeiro não pode exigir chave legada: ${resumo.texto}`);
  assert.deepEqual(resumo.json.saldo, { available: 1234.56, pending: 78.9 });
  assert.equal(resumo.json.storeId, store[ORG_C]);
  assert.equal(resumo.json.loja, null);

  const mov = await c.req('GET', '/api/admin/financeiro/movimentacoes?page=1');
  assert.equal(mov.status, 200, mov.texto);
  assert.equal(mov.json.extrato.length, 1);
  assert.equal(mov.json.hasMore, false);

  const ant = await c.req('GET', '/api/admin/financeiro/antecipacoes');
  assert.equal(ant.status, 200, ant.texto);
  assert.equal(ant.json.antecipacoes.length, 1);

  const saq = await c.req('GET', '/api/admin/financeiro/saques');
  assert.equal(saq.status, 200, saq.texto);
  assert.equal(saq.json.saques.length, 1);

  const novas = chamadasMock().slice(antes).filter((x) => x.host === 'api.reserva.ink');
  assert.equal(novas.length, 4, 'uma consulta à Ink por endpoint');
  for (const x of novas) assert.equal(x.auth, `Bearer ${TOKEN_INK[ORG_C]}`, 'a credencial é a da Organization da sessão');
});

test('Financeiro · isolamento: cada Organization consulta a Ink com o SEU token, inclusive intercaladas', async () => {
  const navs = { [ORG_A]: await navegador().entrar('dogf-a@teste.oria'), [ORG_C]: await navegador().entrar('dogf-c@teste.oria'), [ORG_D]: await navegador().entrar('dogf-d@teste.oria') };
  const antes = chamadasMock().length;
  const ordem = [ORG_C, ORG_D, ORG_A, ORG_D, ORG_C, ORG_A];
  const respostas = await Promise.all(ordem.map((org) => navs[org].req('GET', '/api/admin/financeiro/resumo').then((r) => ({ org, r }))));
  for (const { org, r } of respostas) {
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.storeId, store[org], 'a resposta é da Store da sessão');
  }
  const novas = chamadasMock().slice(antes).filter((x) => x.host === 'api.reserva.ink');
  const usados = novas.map((x) => x.auth).sort();
  const esperados = ordem.map((org) => `Bearer ${TOKEN_INK[org]}`).sort();
  assert.deepEqual(usados, esperados, 'nenhuma requisição usou o token de outra Organization');
});

test('Financeiro · Organization sem credencial Ink → resposta controlada (503), não request pendurado', async () => {
  const ORG_E = 'a1000000-0000-4000-8000-00000000000e';
  await criarOrganizacao(ORG_E, 'Tenant Sem Ink', null);
  await criarPessoa('dogf-e@teste.oria', ORG_E);
  await concederFeatures(sup, ORG_E, { financial: true });
  const e = await navegador().entrar('dogf-e@teste.oria');
  const r = await e.req('GET', '/api/admin/financeiro/resumo');
  assert.equal(r.status, 503, r.texto);
  assert.match(r.json.error, /integração com a Reserva Ink/);
});

// ── Dashboard ──────────────────────────────────────────────────────────────────────────────────

test('Dashboard · financeiro devolve as linhas da Store nativa com `loja: null` (o que o front precisa tratar)', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const r = await c.req('GET', '/api/admin/dashboard/financeiro?dias=30');
  assert.equal(r.status, 200, r.texto);
  assert.ok(r.json.linhas.length > 0, 'a Store nativa tem pedidos pagos no período');
  for (const l of r.json.linhas) assert.equal(l.loja, null);
  const faturamento = r.json.linhas.reduce((acc, l) => acc + Number(l.faturamento), 0);
  assert.equal(faturamento, 150, 'só os pedidos da própria Organization somam');
  // Sem chave legada nenhuma conta de anúncio pode ser atribuída — e isso não é erro nem log.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.doesNotMatch(saida, /gasto de mídia indisponível/);
});

test('Dashboard · lucro por produto: Store nativa devolve números reais (itens ligados por store_id, não por loja)', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const r = await c.req('GET', '/api/admin/dashboard/lucro-produtos?dias=30&agrupar=produto');
  assert.equal(r.status, 200, `lucro por produto não pode exigir chave legada: ${r.texto}`);
  assert.equal(r.json.pedidosSemItens, 0);
  assert.equal(r.json.itens.length, 1);
  const [produto] = r.json.itens;
  assert.equal(produto.nome, 'Estampa Cidade C');
  assert.equal(produto.pedidos, 2);
  assert.equal(produto.pecas, 2);
  assert.equal(produto.lucroOperacional, 50);
  assert.equal(produto.custoProducao, 100);

  const modelo = await c.req('GET', '/api/admin/dashboard/lucro-produtos?dias=30&agrupar=modelo');
  assert.equal(modelo.status, 200, modelo.texto);
  assert.equal(modelo.json.itens[0].nome, 'Camiseta');
});

test('Dashboard · lucro por produto: isolamento entre nativas e compatibilidade da Store legada', async () => {
  const d = await navegador().entrar('dogf-d@teste.oria');
  const rd = await d.req('GET', '/api/admin/dashboard/lucro-produtos?dias=30');
  assert.equal(rd.status, 200, rd.texto);
  assert.deepEqual(rd.json.itens.map((i) => i.nome), ['Estampa Cidade D']);
  assert.equal(rd.json.itens[0].lucroOperacional, 120);

  // A é legada: o item HISTÓRICO (store_id NULL, só `loja`) continua ligado ao pedido dela pela chave.
  const a = await navegador().entrar('dogf-a@teste.oria');
  const ra = await a.req('GET', '/api/admin/dashboard/lucro-produtos?dias=30');
  assert.equal(ra.status, 200, ra.texto);
  assert.deepEqual(ra.json.itens.map((i) => i.nome), ['Estampa Cidade A']);
  assert.equal(ra.json.itens[0].lucroOperacional, 80);
  assert.equal(ra.json.pedidosSemItens, 1, 'o pedido 700202 de A não tem itens gravados: a tela avisa em vez de sub-reportar');
});

test('Dashboard · recuperação via WhatsApp: Store nativa lê o próprio estado (registro sem `loja`)', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const r = await c.req('GET', '/api/admin/dashboard/recuperacao-resumo');
  assert.equal(r.status, 200, `o widget do Dashboard não pode exigir chave legada: ${r.texto}`);
  assert.equal(r.json.carrinhosTentados, 1);
  assert.equal(r.json.carrinhosConvertidos, 1);
  assert.equal(r.json.receitaRecuperada, 80);

  const d = await navegador().entrar('dogf-d@teste.oria');
  const rd = await d.req('GET', '/api/admin/dashboard/recuperacao-resumo');
  assert.equal(rd.status, 200, rd.texto);
  assert.equal(rd.json.carrinhosTentados, 2, 'D vê os 2 dela, nunca o de C');
  assert.equal(rd.json.carrinhosConvertidos, 0);

  // A é legada: só entra registro com a chave dela.
  const a = await navegador().entrar('dogf-a@teste.oria');
  const ra = await a.req('GET', '/api/admin/dashboard/recuperacao-resumo');
  assert.equal(ra.status, 200, ra.texto);
  assert.equal(ra.json.carrinhosTentados, 1);
});

test('Dashboard · pedidos e carrinhos não exigem chave legada (o front recebe `loja: null`)', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const pedidos = await c.req('GET', '/api/admin/dashboard/orders?dias=30');
  assert.equal(pedidos.status, 200, pedidos.texto);
  const carrinhos = await c.req('GET', '/api/admin/dashboard/abandoned-carts');
  assert.equal(carrinhos.status, 200, carrinhos.texto);
});

// ── Erro central: o que ainda depende da chave legada responde, não pendura ──────────────────

test('handler ainda legado (Controle de estoque, adiado) numa Store nativa → 409 STORE_WITHOUT_LEGACY_KEY controlado, sem stack, sem pendurar', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const inicio = Date.now();
  const r = await c.req('GET', '/api/admin/controle-estoque');
  assert.ok(Date.now() - inicio < 5000, 'responde de imediato, não fica pendente');
  assert.equal(r.status, 409, r.texto);
  assert.equal(r.json.codigo, 'STORE_WITHOUT_LEGACY_KEY');
  assert.equal(r.json.error, 'este recurso ainda não está disponível para a sua loja');
  assert.doesNotMatch(r.texto, /\n\s+at |\.js:\d+|lojaLegadaDoContexto|server\.js/, 'nada de stack nem nome interno na resposta');
});

test('Store legada continua no caminho legado: Trocas responde 200 para A', async () => {
  const a = await navegador().entrar('dogf-a@teste.oria');
  const r = await a.req('GET', '/api/admin/trocas?page=1&per_page=20');
  assert.notEqual(r.status, 409, r.texto);
  assert.notEqual(r.status, 500, r.texto);
});

test('GA4 · status de uma Store nativa é "desconectado", não 500', async () => {
  const c = await navegador().entrar('dogf-c@teste.oria');
  const r = await c.req('GET', '/api/admin/integrations/google-analytics/status');
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.conexoes[0].status, 'disconnected');
  assert.equal(r.json.conexoes[0].loja, null);
});

// ── Processo: nenhuma rejeição não tratada, nenhum job em falha por causa da chave legada ─────

test('processo · zero UNHANDLED_REJECTION e zero falha de job por Store nativa, depois de todos os fluxos', async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.doesNotMatch(saida, /UNHANDLED_REJECTION/, `rejeição não tratada no log:\n${saida.slice(-1500)}`);
  assert.doesNotMatch(saida, /falha no sync inicial/, 'o sync de pedidos não roda mais fora de contexto de Organization');
  assert.doesNotMatch(saida, /falha ao sincronizar loja null/, 'controle de estoque não roda para Store sem chave legada');
});

// ── Fonte: os handlers migrados não podem voltar a chamar a chave legada ─────────────────────

function blocoDaRota(fonte, assinatura) {
  const inicio = fonte.indexOf(assinatura);
  assert.ok(inicio >= 0, `rota ou função não encontrada: ${assinatura}`);
  // Rota: termina no primeiro `});` em coluna 0. Função: no primeiro `}` em coluna 0.
  const fechamento = assinatura.startsWith('app.') ? '\n});' : '\n}\n';
  const fim = fonte.indexOf(fechamento, inicio);
  assert.ok(fim > inicio, `fim do bloco não encontrado: ${assinatura}`);
  return fonte.slice(inicio, fim + fechamento.length);
}

test('fonte · Clientes, Financeiro e Dashboard migrados não chamam lojaLegadaDoContexto()', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  const rotas = [
    "app.get('/api/admin/clientes'",
    "app.get('/api/admin/clientes/lista'",
    "app.get('/api/admin/clientes/resumo'",
    "app.get('/api/admin/clientes/segmentos/estado'",
    "app.get('/api/admin/financeiro/resumo'",
    "app.get('/api/admin/financeiro/movimentacoes'",
    "app.get('/api/admin/financeiro/antecipacoes'",
    "app.get('/api/admin/financeiro/saques'",
    "app.get('/api/admin/dashboard/recuperacao-resumo'",
    "app.get('/api/admin/dashboard/lucro-produtos'",
    "app.get('/api/admin/integrations/google-analytics/status'",
  ];
  for (const assinatura of rotas) {
    const bloco = blocoDaRota(fonte, assinatura);
    assert.doesNotMatch(bloco, /lojaLegadaDoContexto\(\)/, `${assinatura} voltou a exigir a chave legada`);
  }
  // `buscarClientesAgregados(linhasPrelidas = null)` ganhou um parâmetro opcional (a lista passa as linhas que também alimentam a RFM).
  for (const funcao of ['async function buscarClientesAgregados(', 'function midiaDaOrganizacao(from, to)']) {
    assert.doesNotMatch(blocoDaRota(fonte, funcao), /lojaLegadaDoContexto\(\)/, `${funcao} voltou a exigir a chave legada`);
  }
  // Os jobs de fundo canônicos: pedidos por Store (já sob contexto) e estoque só para quem tem chave.
  assert.match(blocoDaRota(fonte, 'async function sincronizarControleEstoqueDaOrganizacao()'), /lojasLegadasInkDoContexto\(\)/);
  assert.doesNotMatch(fonte, /syncPedidosInkParaPostgres\(\)\.catch\(/, 'sync de pedidos fora do runner de jobs (sem contexto)');
});

test('fonte · o erro central e a rede async estão instalados no server.js', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  assert.match(fonte, /httpSafety\.instalarSegurancaAsync\(\)/);
  assert.match(fonte, /app\.use\(httpSafety\.criarErroCentral\(\)\)/);
  // O erro central é o ÚLTIMO middleware: nada de rota registrada depois dele.
  const depois = fonte.slice(fonte.indexOf('app.use(httpSafety.criarErroCentral())'));
  assert.doesNotMatch(depois, /\napp\.(get|post|put|patch|delete|use)\(/, 'rota registrada depois do erro central');
  assert.ok(fonte.indexOf('httpSafety.instalarSegurancaAsync()') < fonte.indexOf("app.get('/api/admin/clientes'"));
});

test('Use Sul continua sem chave legada: nenhum teste preencheu `loja_legada` das Stores nativas', async () => {
  const { rows } = await sup.query('SELECT organization_id, loja_legada FROM stores WHERE organization_id = ANY($1)', [[ORG_C, ORG_D]]);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.loja_legada, null);
});
