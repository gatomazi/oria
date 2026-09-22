'use strict';

// Etapa 3 (rodada G.1/Orders/Reconciliação) · ReconciliationService contra Postgres real: catálogo
// canônico (Fase D) + identity (Fase F) + ProductPerformanceService (Fase G) real, Commerce e
// Analytics FAKE (o provider-agnostic da reconciliação é o alvo aqui — Ink/GA4 reais já têm
// cobertura própria em ink-orders-repository.test.js/connectors-analytics-ga4-*.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createConnectorRegistry } = h.sujeito('lib/connectors/registry.js');
const { createCommerceCatalogRepository } = h.sujeito('lib/product-analytics/commerce-catalog-repository.js');
const { createProductPerformanceService } = h.sujeito('lib/product-analytics/product-performance-service.js');
const { bootstrapCommerceIdentities } = h.sujeito('lib/product-analytics/product-identity-resolver.js');
const { createReconciliationService, LOCAL_ORDERS_HISTORY_START } = h.sujeito('lib/product-analytics/reconciliation.js');

const ORG_A = 'af000000-0000-4000-8000-000000000001';
const STORE_A = 'af100000-0000-4000-8000-000000000001';
const ROLE = `oria_app_rec_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const RUN = crypto.randomUUID();
const PROVIDER = 'fake_commerce';
const ANALYTICS_PROVIDER = 'fake_ga4';
const PERIODO = { startDate: '2026-09-01', endDate: '2026-09-20' };

let db;
let sup;
let appPoolReal;

const em = (fn) => runtime.comContexto({ organizationId: ORG_A, storeId: STORE_A, origem: 'teste' }, fn);
const pool = () => runtime.criarPoolTenant(appPoolReal);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_rec');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG_A, 'Org A']);
  await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [STORE_A, ORG_A, 'Org A']);
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

async function semearCatalogo(produtos) {
  const idsPorPid = new Map();
  for (const p of produtos) {
    const { rows: [{ id }] } = await sup.query(
      `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ORG_A, STORE_A, PROVIDER, p.providerProductId, p.name || `Produto ${p.providerProductId}`, RUN]
    );
    idsPorPid.set(p.providerProductId, id);
  }
  return idsPorPid;
}

const linhaAnalytics = (externalProductId, over = {}) => ({
  externalProductId, externalProductName: null, itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 10, itemsPurchased: 5, itemRevenue: 250,
  analyticsProvider: ANALYTICS_PROVIDER, ...over,
});

// Fake commerce: paginado de verdade (limit/cursor), pra provar que a reconciliação soma TODAS as
// páginas de pedidos, não só a primeira.
function pedidoFake(id, { isPaid = true, items = [] } = {}) {
  return { id, organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER, providerOrderId: id, status: 'x', paymentStatus: isPaid ? 'paid' : 'pending', isPaid, isRefunded: false, totalValue: 0, createdAt: new Date(), paidAt: null, items };
}

function registryFake({ pedidos = [], linhas = [] } = {}) {
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: true, variants: false, productsWithVariants: false, orders: true, refunds: false, productCosts: false },
    create: () => ({
      listProducts: async () => ({ items: [], nextCursor: null }),
      getProduct: async () => null,
      listOrders: async ({ cursor, limit = 2 }) => {
        const pagina = cursor ? Number(cursor) : 1;
        const inicio = (pagina - 1) * limit;
        const fatia = pedidos.slice(inicio, inicio + limit);
        return { items: fatia, nextCursor: inicio + fatia.length < pedidos.length ? String(pagina + 1) : null };
      },
      getOrder: async () => null,
    }),
  });
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({ getProductPerformance: async () => linhas }),
  });
  return registry;
}

function montarServico(registry) {
  const catalogRepository = createCommerceCatalogRepository({ pool: pool() });
  const productPerformanceService = createProductPerformanceService({ pool: pool(), registry, catalogRepository });
  return createReconciliationService({ registry, productPerformanceService });
}

// ── Validação / cobertura de histórico local ─────────────────────────────────────────────────────

test('G.1 · exige organizationId/storeId/commerceProvider/analyticsProvider/período', () => em(async () => {
  const svc = montarServico(registryFake());
  await assert.rejects(svc.reconcileProductPerformance({ storeId: STORE_A, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO }), TypeError);
  await assert.rejects(svc.reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, ...PERIODO }), TypeError);
}));

test('G.1 · período que começa antes de 19/08/2026 devolve insufficient_data sem tentar comparar', () => em(async () => {
  const svc = montarServico(registryFake());
  const r = await svc.reconcileProductPerformance({
    organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER,
    startDate: '2026-07-01', endDate: '2026-08-01',
  });
  assert.equal(r.status, 'insufficient_data');
  assert.equal(r.reason, 'LOCAL_ORDERS_HISTORY_STARTS_LATER');
  assert.equal(r.historyStartsAt, LOCAL_ORDERS_HISTORY_START);
  assert.deepEqual(r.items, []);
}));

// ── Unidades equivalentes: itemsPurchased vs unidades vendidas (nunca vs contagem de PEDIDOS) ────

test('G.1 · unitsSold soma QUANTIDADE de itens, não número de pedidos — pedido único com 5 unidades conta 5', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [pedidoFake('o1', { items: [{ commerceProductId: ids.get('p1'), quantity: 5, totalValue: 250 }] })],
    linhas: [linhaAnalytics('p1', { itemsPurchased: 5 })],
  });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p1'));
  assert.equal(linha.commerceUnits, 5); // 1 pedido, 5 unidades — nunca "1"
  assert.equal(linha.paidOrdersDistinct, 1);
  assert.equal(linha.status, 'aligned');
}));

test('G.1 · soma unidades de VÁRIOS pedidos pagos do mesmo produto', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p2' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [
      pedidoFake('o1', { items: [{ commerceProductId: ids.get('p2'), quantity: 2, totalValue: 100 }] }),
      pedidoFake('o2', { items: [{ commerceProductId: ids.get('p2'), quantity: 3, totalValue: 150 }] }),
    ],
    linhas: [linhaAnalytics('p2', { itemsPurchased: 5 })],
  });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p2'));
  assert.equal(linha.commerceUnits, 5);
  assert.equal(linha.paidOrdersDistinct, 2);
}));

test('G.1 · pedido NÃO pago (isPaid=false) nunca entra na soma — provider-agnostic (só isPaid, nunca status literal)', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p3' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [
      pedidoFake('o1', { isPaid: true, items: [{ commerceProductId: ids.get('p3'), quantity: 2, totalValue: 100 }] }),
      pedidoFake('o2', { isPaid: false, items: [{ commerceProductId: ids.get('p3'), quantity: 99, totalValue: 9900 }] }),
    ],
    linhas: [linhaAnalytics('p3', { itemsPurchased: 2 })],
  });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p3'));
  assert.equal(linha.commerceUnits, 2); // os 99 do pedido não pago nunca entram
}));

test('G.1 · pagina o Commerce inteiro (várias páginas de listOrders) antes de somar', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p4' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const pedidos = Array.from({ length: 9 }, (_, i) => pedidoFake(`o${i}`, { items: [{ commerceProductId: ids.get('p4'), quantity: 1, totalValue: 10 }] }));
  const registry = registryFake({ pedidos, linhas: [linhaAnalytics('p4', { itemsPurchased: 9 })] });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p4'));
  assert.equal(linha.commerceUnits, 9); // registryFake pagina de 2 em 2 por padrão — teria que ver 5 páginas
}));

// ── Diagnósticos: divergência, identidade insuficiente, métrica indisponível ─────────────────────

test('G.1 · diferença grande vira divergent, com os dois valores brutos (nunca escondidos)', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p5' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [pedidoFake('o1', { items: [{ commerceProductId: ids.get('p5'), quantity: 1, totalValue: 10 }] })],
    linhas: [linhaAnalytics('p5', { itemsPurchased: 100 })],
  });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p5'));
  assert.equal(linha.status, 'divergent');
  assert.ok(linha.diagnostics.includes('units_divergent'));
  assert.equal(linha.analyticsUnits, 100);
  assert.equal(linha.commerceUnits, 1);
}));

test('G.1 · produto sem identity resolvida no Analytics vira insufficient_identity (nunca comparado) — distinto de "período sem dado nenhum"', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p6' }]);
  // Sem bootstrapCommerceIdentities pra 'p6' — mas o período TEM dado de analytics (de um id
  // qualquer, não relacionado), então a resposta não cai no ramo "insufficient_data" de período
  // vazio: é ESTE produto que não resolveu, com o resto do período coberto normalmente.
  const registry = registryFake({ pedidos: [], linhas: [linhaAnalytics('id-nao-relacionado')] });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p6'));
  assert.equal(linha.status, 'insufficient_identity');
  assert.equal(linha.analyticsUnits, null);
  assert.equal(linha.commerceUnits, null);
}));

test('G.1 · período do produto sem NENHUM dado de analytics vira insufficient_data (não insufficient_identity)', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p6b' }]);
  const registry = registryFake({ pedidos: [], linhas: [] }); // período inteiro sem nenhuma linha
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p6b'));
  assert.equal(linha.status, 'insufficient_data');
  assert.ok(linha.diagnostics.includes('no_analytics_data_in_period'));
}));

test('G.1 · itemsPurchased indisponível na propriedade vira insufficient_data por produto', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p7' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [pedidoFake('o1', { items: [{ commerceProductId: ids.get('p7'), quantity: 1, totalValue: 10 }] })],
    linhas: [linhaAnalytics('p7', { itemsPurchased: null })],
  });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  const linha = r.items.find((x) => x.product.id === ids.get('p7'));
  assert.equal(linha.status, 'insufficient_data');
  assert.ok(linha.diagnostics.includes('metric_unavailable'));
}));

// ── Caveats de receita sempre presentes ───────────────────────────────────────────────────────────

test('G.1 · caveats de receita/timezone/sync-lag sempre presentes na resposta', () => em(async () => {
  await semearCatalogo([{ providerProductId: 'p8' }]);
  const registry = registryFake({ pedidos: [], linhas: [] });
  const r = await montarServico(registry).reconcileProductPerformance({ organizationId: ORG_A, storeId: STORE_A, commerceProvider: PROVIDER, analyticsProvider: ANALYTICS_PROVIDER, ...PERIODO });
  assert.ok(r.caveats.length > 0);
  assert.ok(r.caveats.some((c) => /reembolso|desconto/i.test(c)));
  assert.ok(r.caveats.some((c) => /fuso/i.test(c)));
}));

// ── Guarda estática: provider-agnostic de verdade ─────────────────────────────────────────────────

test('G.1 · nenhum literal de provider/status específico (reserva_ink, ga4, "pago", "paid") no reconciliation.js', () => {
  const arq = path.join(__dirname, '..', '..', 'lib', 'product-analytics', 'reconciliation.js');
  const achados = [];
  fs.readFileSync(arq, 'utf8').split('\n').forEach((l, i) => {
    if (l.trimStart().startsWith('//')) return;
    if (/reserva[_-]?ink|['"]ga4['"]|['"]paid['"]|['"]pago['"]|InkClient|Ga4Client/i.test(l)) achados.push(`${i + 1}: ${l.trim()}`);
  });
  assert.deepEqual(achados, []);
});
