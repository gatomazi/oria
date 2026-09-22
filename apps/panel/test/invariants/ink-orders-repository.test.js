'use strict';

// Etapa 2 (rodada G.1/Orders) · InkOrdersRepository contra Postgres real: lê pedidos_ink/
// pedidos_ink_itens (o MESMO cache que server.js já sincroniza — schema pré-existente, sem
// migration nova nesta rodada), resolve commerce_product_id por JOIN com o catálogo canônico
// (Fase D), pagina sem N+1, isola por Organization/Store (RLS).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createInkOrdersRepository } = h.sujeito('lib/connectors/commerce/reserva-ink/orders-repository.js');

const ORG_A = 'ad000000-0000-4000-8000-000000000001';
const ORG_B = 'ad000000-0000-4000-8000-000000000002';
const STORE_A = 'ae000000-0000-4000-8000-000000000001';
const STORE_B = 'ae000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_ord_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const RUN = crypto.randomUUID();

let db;
let sup;
let appPoolReal;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);
const pool = () => runtime.criarPoolTenant(appPoolReal);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_ord');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });

  for (const [org, store, nome] of [[ORG_A, STORE_A, 'Org A'], [ORG_B, STORE_B, 'Org B']]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
  }
});

test.after(async () => {
  await appPoolReal?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

let proximoInkOrderId = 700000;
let proximoItemId = 1; // (organization_id, store_id, item_id) é único: contador global do arquivo, nunca reiniciado por pedido
let diaContador = 0;

// Cada teste que filtra por período usa um dia PRÓPRIO (nunca 2026-09-05 fixo pra todo mundo) —
// isola os testes entre si sem precisar de Organization/Store nova por teste.
function novoDia() {
  diaContador += 1;
  const d = new Date(Date.UTC(2026, 0, 1));
  d.setUTCDate(d.getUTCDate() + diaContador);
  return d.toISOString().slice(0, 10);
}

async function semearPedido(org, store, { paymentStatus = 'paid', orderStatus = 'delivered', totalValue = '100', criadoEm, isTroca = false, itens = [] } = {}) {
  const inkOrderId = proximoInkOrderId += 1;
  await sup.query(
    `INSERT INTO pedidos_ink (organization_id, store_id, ink_order_id, payment_status, order_status, total_value, criado_em, is_troca)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [org, store, inkOrderId, paymentStatus, orderStatus, totalValue, criadoEm ?? novoDia(), isTroca]
  );
  for (const it of itens) {
    await sup.query(
      `INSERT INTO pedidos_ink_itens (organization_id, store_id, ink_order_id, item_id, produto_id, produto_nome, sku, modelo, cor, tamanho, quantidade, valor_venda, desconto_rateado, custo_producao, lucro_operacional)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [org, store, inkOrderId, proximoItemId += 1, it.produtoId ?? null, it.produtoNome ?? null, it.sku ?? null, it.modelo ?? null, it.cor ?? null, it.tamanho ?? null,
        it.quantidade ?? 1, it.valorVenda ?? '10', it.descontoRateado ?? '0', it.custoProducao ?? '0', it.lucroOperacional ?? '0'],
    );
  }
  return inkOrderId;
}

async function semearProdutoCanonico(org, store, providerProductId) {
  const { rows: [{ id }] } = await sup.query(
    `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
     VALUES ($1, $2, 'reserva_ink', $3, $4, $5) RETURNING id`,
    [org, store, providerProductId, `Produto ${providerProductId}`, RUN]
  );
  return id;
}

// ── listOrders: básico, período, paginação, sem N+1 ──────────────────────────────────────────────
// Cada teste usa seu PRÓPRIO dia (novoDia()) como período — Organization/Store são compartilhadas
// pelo arquivo inteiro, então sem isso os pedidos de um teste vazariam para o count/paginação do
// próximo (mesma Organization, mesmo período fixo).

test('G.1 · listOrders devolve pedidos do período com itens agregados (pedido + itens brutos)', () => em(ORG_A, STORE_A, async () => {
  const dia = novoDia();
  const idProduto = await semearProdutoCanonico(ORG_A, STORE_A, '9001');
  const inkOrderId = await semearPedido(ORG_A, STORE_A, { criadoEm: dia, itens: [{ produtoId: 9001, quantidade: 2, valorVenda: '40' }] });
  const repo = createInkOrdersRepository({ pool: pool() });
  const pagina = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia });
  const encontrado = pagina.items.find((x) => String(x.pedido.ink_order_id) === String(inkOrderId));
  assert.ok(encontrado, 'pedido semeado deveria aparecer na página');
  assert.equal(encontrado.itens.length, 1);
  assert.equal(encontrado.itens[0].commerce_product_id, idProduto);
  assert.equal(Number(encontrado.itens[0].valor_venda), 40);
}));

test('G.1 · listOrders: item cujo produto nunca passou por catalog sync vem com commerce_product_id null (nunca inventado)', () => em(ORG_A, STORE_A, async () => {
  const dia = novoDia();
  const inkOrderId = await semearPedido(ORG_A, STORE_A, { criadoEm: dia, itens: [{ produtoId: 999999, quantidade: 1, valorVenda: '10' }] });
  const repo = createInkOrdersRepository({ pool: pool() });
  const pagina = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia });
  const encontrado = pagina.items.find((x) => String(x.pedido.ink_order_id) === String(inkOrderId));
  assert.equal(encontrado.itens[0].commerce_product_id, null);
}));

test('G.1 · listOrders: fora do período não aparece', () => em(ORG_A, STORE_A, async () => {
  const diaFora = novoDia();
  const diaConsultado = novoDia();
  const inkOrderId = await semearPedido(ORG_A, STORE_A, { criadoEm: diaFora });
  const repo = createInkOrdersRepository({ pool: pool() });
  const pagina = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: diaConsultado, endDate: diaConsultado });
  assert.equal(pagina.items.some((x) => String(x.pedido.ink_order_id) === String(inkOrderId)), false);
}));

test('G.1 · listOrders: endDate é inclusivo (pedido no último instante do dia final aparece)', () => em(ORG_A, STORE_A, async () => {
  const dia = novoDia();
  const inkOrderId = await semearPedido(ORG_A, STORE_A, { criadoEm: `${dia}T23:59:00Z` });
  const repo = createInkOrdersRepository({ pool: pool() });
  const pagina = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia });
  assert.equal(pagina.items.some((x) => String(x.pedido.ink_order_id) === String(inkOrderId)), true);
}));

test('G.1 · listOrders: paginação — totalCount correto, nextCursor avança, sem duplicar nem pular', () => em(ORG_A, STORE_A, async () => {
  const dia = novoDia();
  const N = 25;
  for (let i = 0; i < N; i += 1) await semearPedido(ORG_A, STORE_A, { criadoEm: dia });
  const repo = createInkOrdersRepository({ pool: pool() });
  const p1 = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia, limit: 10 });
  assert.equal(p1.items.length, 10);
  assert.equal(p1.totalCount, N);
  assert.ok(p1.nextCursor);
  const p2 = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia, limit: 10, cursor: p1.nextCursor });
  const p3 = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia, limit: 10, cursor: p2.nextCursor });
  assert.equal(p3.nextCursor, null);
  assert.equal(p1.items.length + p2.items.length + p3.items.length, N);
  const idsUnicos = new Set([...p1.items, ...p2.items, ...p3.items].map((x) => x.pedido.ink_order_id));
  assert.equal(idsUnicos.size, N);
}));

test('G.1 · listOrders: 1 query de pedidos + 1 query de itens por página, nunca 1 de itens por pedido', () => em(ORG_A, STORE_A, async () => {
  const dia = novoDia();
  for (let i = 0; i < 15; i += 1) await semearPedido(ORG_A, STORE_A, { criadoEm: dia, itens: [{ produtoId: 1, valorVenda: '5' }] });
  const poolReal = pool();
  let chamadas = 0;
  const poolContado = { query: (...args) => { chamadas += 1; return poolReal.query(...args); } };
  const repo = createInkOrdersRepository({ pool: poolContado });
  chamadas = 0;
  const pagina = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia, limit: 50 });
  assert.equal(pagina.items.length, 15);
  // count(*) + SELECT pedidos + SELECT itens = 3 queries, independente de quantos pedidos vieram.
  assert.equal(chamadas, 3);
}));

// ── getOrder ───────────────────────────────────────────────────────────────────────────────────

test('G.1 · getOrder: encontra por providerOrderId com itens; inexistente devolve null', () => em(ORG_A, STORE_A, async () => {
  const inkOrderId = await semearPedido(ORG_A, STORE_A, { itens: [{ produtoId: 1, valorVenda: '30' }] });
  const repo = createInkOrdersRepository({ pool: pool() });
  const achado = await repo.getOrder({ organizationId: ORG_A, storeId: STORE_A, providerOrderId: String(inkOrderId) });
  assert.equal(String(achado.pedido.ink_order_id), String(inkOrderId));
  assert.equal(achado.itens.length, 1);
  assert.equal(await repo.getOrder({ organizationId: ORG_A, storeId: STORE_A, providerOrderId: '1' }), null);
}));

// ── Isolamento ─────────────────────────────────────────────────────────────────────────────────

test('G.1 · Organization isolation: A não vê pedido de B mesmo pedindo o mesmo período', () => em(ORG_A, STORE_A, async () => {
  const dia = novoDia();
  const inkOrderIdB = await em(ORG_B, STORE_B, () => semearPedido(ORG_B, STORE_B, { criadoEm: dia }));
  const inkOrderIdA = await semearPedido(ORG_A, STORE_A, { criadoEm: dia });
  const repo = createInkOrdersRepository({ pool: pool() });
  const pagina = await repo.listOrders({ organizationId: ORG_A, storeId: STORE_A, startDate: dia, endDate: dia });
  assert.equal(pagina.items.some((x) => String(x.pedido.ink_order_id) === String(inkOrderIdA)), true);
  assert.equal(pagina.items.some((x) => String(x.pedido.ink_order_id) === String(inkOrderIdB)), false);
  const { rows } = await sup.query('SELECT organization_id FROM pedidos_ink WHERE ink_order_id = $1', [inkOrderIdA]);
  assert.equal(rows[0].organization_id, ORG_A);
}));

test('G.1 · RLS: role da aplicação sob contexto de A não lê pedido de B por baixo (sem passar por listOrders)', () => em(ORG_A, STORE_A, async () => {
  await em(ORG_B, STORE_B, () => semearPedido(ORG_B, STORE_B, { criadoEm: '2026-09-10' }));
  const { rows } = await pool().query('SELECT count(*)::int AS n FROM pedidos_ink WHERE organization_id = $1', [ORG_B]);
  assert.equal(rows[0].n, 0);
}));
