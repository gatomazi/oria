'use strict';

// Rodada K · JourneyAnalyticsService fim a fim: ProductPerformanceService real (catálogo canônico +
// identity + GA4 fake), Meta Ads real via meta_insights_daily (Postgres real, RLS), Commerce fake —
// mesmo padrão de reconciliation.test.js (o provider-agnostic da reconciliação/jornada é o alvo
// aqui; Ink/GA4 reais já têm cobertura própria em connectors-analytics-ga4-*.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createConnectorRegistry } = h.sujeito('lib/connectors/registry.js');
const { createCommerceCatalogRepository } = h.sujeito('lib/product-analytics/commerce-catalog-repository.js');
const { createProductPerformanceService } = h.sujeito('lib/product-analytics/product-performance-service.js');
const { bootstrapCommerceIdentities } = h.sujeito('lib/product-analytics/product-identity-resolver.js');
const { createJourneyAnalyticsService, MAX_TRANSACTION_SAMPLE_SIZE, classificarIndisponibilidade } = h.sujeito('lib/product-analytics/journey-analytics-service.js');
const { LOCAL_ORDERS_HISTORY_START } = h.sujeito('lib/product-analytics/reconciliation.js');

const ORG_A = 'a1c00000-0000-4000-8000-000000000001';
const STORE_A = 'a1c10000-0000-4000-8000-000000000001';
const RUN = crypto.randomUUID();
const ROLE = `oria_app_jrn_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const PROVIDER = 'fake_commerce';
const ANALYTICS_PROVIDER = 'fake_ga4';
const PERIODO = { startDate: '2026-09-01', endDate: '2026-09-20' };

let db;
let sup;
let appPoolReal;

const em = (fn) => runtime.comContexto({ organizationId: ORG_A, storeId: STORE_A, origem: 'teste' }, fn);
const pool = () => runtime.criarPoolTenant(appPoolReal);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_journey');
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

function pedidoFake(id, { isPaid = true, items = [], totalValue = 0 } = {}) {
  return { id, organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER, providerOrderId: id, status: 'x', paymentStatus: isPaid ? 'paid' : 'pending', isPaid, isRefunded: false, totalValue, createdAt: new Date(), paidAt: null, items };
}

// `analyticsExtra`: sobrepõe getAcquisitionPerformance/getTransactionCapabilities/findTransaction —
// omitido = capability AUSENTE (o service trata como "provider sem esta capability", nunca erro).
function registryFake({ pedidos = [], linhas = [], analyticsExtra = {}, comercioIndisponivel = false, analyticsIndisponivel = false } = {}) {
  const registry = createConnectorRegistry();
  if (!comercioIndisponivel) {
    registry.register({
      domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
      capabilities: { products: true, variants: false, productsWithVariants: false, orders: true, refunds: false, productCosts: false },
      create: () => ({
        listProducts: async () => ({ items: [], nextCursor: null }),
        getProduct: async () => null,
        listOrders: async ({ cursor, limit = 200 }) => {
          const pagina = cursor ? Number(cursor) : 1;
          const inicio = (pagina - 1) * limit;
          const fatia = pedidos.slice(inicio, inicio + limit);
          return { items: fatia, nextCursor: inicio + fatia.length < pedidos.length ? String(pagina + 1) : null };
        },
        getOrder: async () => null,
      }),
    });
  }
  if (!analyticsIndisponivel) {
    registry.register({
      domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
      capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
      create: () => ({ getProductPerformance: async () => linhas, ...analyticsExtra }),
    });
  }
  return registry;
}

async function montarServico(registry, overrides = {}) {
  const catalogRepository = createCommerceCatalogRepository({ pool: pool() });
  const productPerformanceService = createProductPerformanceService({ pool: pool(), registry, catalogRepository });
  return createJourneyAnalyticsService({ pool: pool(), registry, productPerformanceService, analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: PROVIDER, ...overrides });
}

// ── Validação / gate de histórico ────────────────────────────────────────────────────────────────

test('K · exige organizationId/storeId/período; período antes de 19/08/2026 → insufficient_data', () => em(async () => {
  const svc = await montarServico(registryFake());
  await assert.rejects(svc.getJourneyAnalytics({ storeId: STORE_A, ...PERIODO }), TypeError);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, startDate: '2026-07-01', endDate: '2026-08-01' });
  assert.equal(r.status, 'insufficient_data');
  assert.equal(r.reason, 'LOCAL_ORDERS_HISTORY_STARTS_LATER');
  assert.equal(r.historyStartsAt, LOCAL_ORDERS_HISTORY_START);
}));

// ── Tier 1: funil, aquisição, Meta, Commerce — cada um available/unavailable independente ────────

test('K · tier1: funil/commerce available; aquisição/Meta unavailable quando o fake não implementa/conecta — nunca derruba a feature inteira', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p1' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [pedidoFake('o1', { items: [{ commerceProductId: ids.get('p1'), quantity: 1, totalValue: 250 }], totalValue: 250 })],
    linhas: [linhaAnalytics('p1')],
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.status, 'ok');
  assert.equal(r.tier1.funnel.available, true);
  assert.equal(r.tier1.funnel.observed.itemsPurchased, 5);
  assert.equal(r.tier1.confirmedOrders.available, true);
  assert.equal(r.tier1.confirmedOrders.count, 1);
  assert.equal(r.tier1.confirmedOrders.revenue, 250);
  // fake não implementa getAcquisitionPerformance nem tem conta Meta selecionada nesta Org:
  assert.equal(r.tier1.acquisition.available, false);
  assert.equal(r.tier1.acquisition.reason, 'PROVIDER_WITHOUT_ACQUISITION_CAPABILITY');
  assert.equal(r.tier1.adsInvestment.available, false);
  assert.equal(r.tier1.adsInvestment.reason, 'META_NOT_CONNECTED');
  assert.equal(r.coverage.funnel, 'available');
  assert.equal(r.coverage.adsInvestment, 'unavailable');
}));

test('K · tier1: Commerce indisponível (registry sem provider) → confirmedOrders unavailable, tier2 também (nunca inventa pedido)', () => em(async () => {
  const registry = registryFake({ comercioIndisponivel: true, linhas: [linhaAnalytics('p1')] });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier1.confirmedOrders.available, false);
  assert.equal(r.tier1.confirmedOrders.status, 'not_connected');
  assert.equal(r.tier2.transactionOrderLink.available, false);
  // L: tier2 herda o MESMO status/reason que tier1.confirmedOrders já classificou — nunca um
  // "COMMERCE_UNAVAILABLE" genérico que cairia em temporary_failure por padrão (achado do smoke visual).
  assert.equal(r.tier2.transactionOrderLink.status, r.tier1.confirmedOrders.status);
  assert.equal(r.tier2.transactionOrderLink.reason, r.tier1.confirmedOrders.reason);
}));

test('K · tier1: aquisição por canal/campanha disponível quando o provider implementa a capability', () => em(async () => {
  const registry = registryFake({
    linhas: [],
    analyticsExtra: { getAcquisitionPerformance: async () => [{ source: 'instagram', medium: 'paid_social', campaign: 'bf', sessions: 10, ecommercePurchases: 2, totalRevenue: 199.8 }] },
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier1.acquisition.available, true);
  assert.equal(r.tier1.acquisition.rows.length, 1);
}));

// ── Tier 2: correlação transactionId ↔ providerOrderId ────────────────────────────────────────────

test('K · tier2 unavailable quando o provider não implementa getTransactionCapabilities/findTransaction', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p2' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [pedidoFake('o1', { items: [{ commerceProductId: ids.get('p2'), quantity: 1, totalValue: 100 }], totalValue: 100 })],
    linhas: [linhaAnalytics('p2')],
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier2.transactionOrderLink.available, false);
  assert.equal(r.tier2.transactionOrderLink.reason, 'PROVIDER_WITHOUT_TRANSACTION_CAPABILITY');
}));

test('K · tier2 unavailable quando a propriedade GA4 não é apta para transactionId (capability checada, nunca contornada)', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p3' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [pedidoFake('o1', { items: [{ commerceProductId: ids.get('p3'), quantity: 1, totalValue: 100 }], totalValue: 100 })],
    linhas: [linhaAnalytics('p3')],
    analyticsExtra: {
      getTransactionCapabilities: async () => ({ apt: false, reason: 'TRANSACTION_ID_UNAVAILABLE', transactionIdAvailable: false, metrics: {} }),
      findTransaction: async () => { throw new Error('nunca deveria ser chamado sem apt'); },
    },
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier2.transactionOrderLink.available, false);
  assert.equal(r.tier2.transactionOrderLink.reason, 'TRANSACTION_ID_UNAVAILABLE');
}));

test('K · tier2: liga pedido↔transação SÓ por providerOrderId igual — um pedido nunca é dado como linkado sem o GA4 confirmar', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p4' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [
      pedidoFake('ligado-1', { items: [{ commerceProductId: ids.get('p4'), quantity: 1, totalValue: 100 }], totalValue: 100 }),
      pedidoFake('nao-ligado-2', { items: [{ commerceProductId: ids.get('p4'), quantity: 1, totalValue: 50 }], totalValue: 50 }),
    ],
    linhas: [linhaAnalytics('p4')],
    analyticsExtra: {
      getTransactionCapabilities: async () => ({ apt: true, reason: null, transactionIdAvailable: true, metrics: { transactions: true, purchaseRevenue: true } }),
      findTransaction: async ({ transactionId }) => (transactionId === 'ligado-1' ? { found: true, transactions: 1, revenue: 100 } : { found: false, transactions: null, revenue: null }),
    },
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier2.transactionOrderLink.available, true);
  assert.equal(r.tier2.transactionOrderLink.checked, 2);
  assert.equal(r.tier2.transactionOrderLink.linked, 1);
  const linkLigado = r.tier2.transactionOrderLink.links.find((l) => l.providerOrderId === 'ligado-1');
  const linkNaoLigado = r.tier2.transactionOrderLink.links.find((l) => l.providerOrderId === 'nao-ligado-2');
  assert.equal(linkLigado.linked, true);
  assert.equal(linkNaoLigado.linked, false);
}));

// ── Tier 3: jornada individual — sempre reservada nesta rodada, nunca fabricada ───────────────────

test('K · tier3 (jornada individual) sempre unavailable nesta rodada — nenhum event_analytics registrado em nenhuma composição', () => em(async () => {
  const registry = registryFake({ linhas: [] });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier3.individualJourney.available, false);
  assert.equal(r.tier3.individualJourney.reason, 'NO_EVENT_ANALYTICS_SOURCE_CONFIGURED');
  assert.equal(r.coverage.individualJourney, 'unavailable');
}));

test('K · tier3 se ativa sozinho quando um event_analytics Connector é registrado — nenhuma mudança no service', () => em(async () => {
  const registry = registryFake({ linhas: [] });
  registry.register({
    domain: 'event_analytics', provider: 'oria_web_sdk', integrationProvider: 'oria_web_sdk', requiresStoreContext: false,
    capabilities: { aggregatedProductEvents: false, eventLevel: true, productIdentity: false, eventDedupKeys: false },
    create: () => ({ getEventCoverage: async () => ({ events: [] }), getProductEvents: async () => ({ items: [], nextCursor: null }) }),
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier3.individualJourney.available, true);
  assert.equal(r.tier3.individualJourney.provider, 'oria_web_sdk');
  assert.equal(r.tier3.individualJourney.eventLevel, true);
}));

// ── Atribuição: nunca soma Meta+GA4+Commerce entre si ─────────────────────────────────────────────

test('K · attribution: 3 fontes lado a lado, nenhuma somada com outra', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p5' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  await sup.query('INSERT INTO meta_ad_accounts (organization_id, meta_account_id, nome, currency, selecionada) VALUES ($1, $2, $3, $4, true)', [ORG_A, 'act_K1', 'Conta K', 'BRL']);
  await sup.query(
    `INSERT INTO meta_insights_daily (organization_id, meta_account_id, level, entidade_id, data, meta_campaign_id, purchases, purchase_value, spend)
     VALUES ($1,$2,'campaign','camp_k','2026-09-05','camp_k',7,'700.00','80.00')`,
    [ORG_A, 'act_K1']
  );
  const registry = registryFake({
    pedidos: [pedidoFake('o1', { items: [{ commerceProductId: ids.get('p5'), quantity: 1, totalValue: 250 }], totalValue: 250 })],
    linhas: [linhaAnalytics('p5', { itemsPurchased: 5, itemRevenue: 250 })],
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  const commerce = r.attribution.find((a) => a.source === 'commerce');
  const meta = r.attribution.find((a) => a.source === 'meta_ads');
  const ga4 = r.attribution.find((a) => a.source === 'ga4');
  assert.equal(commerce.purchases, 1);
  assert.equal(commerce.revenue, 250);
  assert.equal(meta.purchases, 7);
  assert.equal(meta.revenue, 700);
  assert.equal(meta.spend, 80);
  assert.equal(ga4.purchases, 5);
  assert.equal(ga4.revenue, 250);
  // as 3 nunca colapsam num total único — cada linha da atribuição só carrega os campos da SUA fonte
  assert.equal(Object.prototype.hasOwnProperty.call(commerce, 'spend'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ga4, 'spend'), false);
}));

// ── L §2.1/§2.2: taxonomia de status e linkType explícito (nunca complete_journey) ────────────────

test('L · classificarIndisponibilidade: taxonomia normalizada — not_connected/unsupported/insufficient_data/not_verified/temporary_failure', () => {
  assert.equal(classificarIndisponibilidade(null), 'available');
  assert.equal(classificarIndisponibilidade('META_NOT_CONNECTED'), 'not_connected');
  assert.equal(classificarIndisponibilidade('COMMERCE_NOT_REGISTERED'), 'not_connected');
  // CONNECTOR_NOT_REGISTERED é o codigo REAL que lib/connectors/registry.js lança (CODIGOS.NOT_REGISTERED)
  // — não um literal inventado; achado do smoke visual (Rodada L).
  assert.equal(classificarIndisponibilidade('CONNECTOR_NOT_REGISTERED'), 'not_connected');
  assert.equal(classificarIndisponibilidade('PROVIDER_WITHOUT_TRANSACTION_CAPABILITY'), 'unsupported');
  assert.equal(classificarIndisponibilidade('GA4_ACQUISITION_DIMENSIONS_OR_METRICS_UNAVAILABLE'), 'unsupported');
  assert.equal(classificarIndisponibilidade('LOCAL_ORDERS_HISTORY_STARTS_LATER'), 'insufficient_data');
  assert.equal(classificarIndisponibilidade('insufficient_data'), 'insufficient_data');
  assert.equal(classificarIndisponibilidade('TRANSACTION_CAPABILITY_CHECK_FAILED'), 'not_verified');
  assert.equal(classificarIndisponibilidade('ALGO_NUNCA_VISTO_ANTES'), 'temporary_failure'); // nunca escondido atrás de "unsupported"
});

test('L · tier2 nunca rotula um vínculo como "complete_journey" — só transaction_linked', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p6' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const registry = registryFake({
    pedidos: [pedidoFake('link-6', { items: [{ commerceProductId: ids.get('p6'), quantity: 1, totalValue: 100 }], totalValue: 100 })],
    linhas: [linhaAnalytics('p6')],
    analyticsExtra: {
      getTransactionCapabilities: async () => ({ apt: true, reason: null, transactionIdAvailable: true, metrics: {} }),
      findTransaction: async () => ({ found: true, transactions: 1, revenue: 100 }),
    },
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(r.tier2.transactionOrderLink.links[0].linkType, 'transaction_linked');
  assert.doesNotMatch(JSON.stringify(r), /complete_journey/);
}));

// ── L §2.3: findTransaction nunca faz N chamadas sem teto no relatório agregado ────────────────────

test('L · tier2 (agregado) verifica só uma AMOSTRA limitada de pedidos pagos — nunca todos, mesmo com muitos pedidos', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p7' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const TOTAL_PEDIDOS = MAX_TRANSACTION_SAMPLE_SIZE + 5; // mais pedidos do que o teto — prova que o teto de fato limita
  const pedidos = Array.from({ length: TOTAL_PEDIDOS }, (_, i) => pedidoFake(`p7-${i}`, { items: [{ commerceProductId: ids.get('p7'), quantity: 1, totalValue: 10 }], totalValue: 10 }));
  let chamadasFindTransaction = 0;
  const registry = registryFake({
    pedidos,
    linhas: [linhaAnalytics('p7')],
    analyticsExtra: {
      getTransactionCapabilities: async () => ({ apt: true, reason: null, transactionIdAvailable: true, metrics: {} }),
      findTransaction: async () => { chamadasFindTransaction += 1; return { found: false, transactions: null, revenue: null }; },
    },
  });
  const svc = await montarServico(registry);
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(chamadasFindTransaction, MAX_TRANSACTION_SAMPLE_SIZE, `esperava exatamente o teto de chamadas GA4 (${MAX_TRANSACTION_SAMPLE_SIZE}), não 1 por pedido pago (${TOTAL_PEDIDOS})`);
  assert.equal(r.tier2.transactionOrderLink.checked, MAX_TRANSACTION_SAMPLE_SIZE);
  assert.equal(r.tier2.transactionOrderLink.sampled, true);
  assert.equal(r.tier2.transactionOrderLink.sampleSize, MAX_TRANSACTION_SAMPLE_SIZE);
  assert.equal(r.tier2.transactionOrderLink.totalEligible, TOTAL_PEDIDOS);
}));

test('L · maxTransactionSampleSize é configurável na composição — nunca um número mágico fixo', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p8' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  const pedidos = Array.from({ length: 5 }, (_, i) => pedidoFake(`p8-${i}`, { items: [{ commerceProductId: ids.get('p8'), quantity: 1, totalValue: 10 }], totalValue: 10 }));
  let chamadas = 0;
  const registry = registryFake({
    pedidos, linhas: [linhaAnalytics('p8')],
    analyticsExtra: {
      getTransactionCapabilities: async () => ({ apt: true, reason: null, transactionIdAvailable: true, metrics: {} }),
      findTransaction: async () => { chamadas += 1; return { found: false, transactions: null, revenue: null }; },
    },
  });
  const svc = await montarServico(registry, { maxTransactionSampleSize: 2 });
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO });
  assert.equal(chamadas, 2);
  assert.equal(r.tier2.transactionOrderLink.sampled, true);
}));

// ── L §2.3: verificação sob demanda de 1 pedido — o caminho que a UI usa, nunca a carga inicial ────

test('L · checkOrderTransactionLink: 1 pedido explícito, 1 chamada ao Commerce + 1 ao GA4, nunca mais', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p9' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  let chamadasGetOrder = 0;
  let chamadasFindTransaction = 0;
  const pedido = pedidoFake('sob-demanda-1', { items: [{ commerceProductId: ids.get('p9'), quantity: 1, totalValue: 300 }], totalValue: 300 });
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: true, variants: false, productsWithVariants: false, orders: true, refunds: false, productCosts: false },
    create: () => ({
      listProducts: async () => ({ items: [], nextCursor: null }),
      getProduct: async () => null,
      listOrders: async () => ({ items: [], nextCursor: null }),
      getOrder: async ({ providerOrderId }) => { chamadasGetOrder += 1; return providerOrderId === pedido.id ? pedido : null; },
    }),
  });
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({
      getProductPerformance: async () => [],
      getTransactionCapabilities: async () => ({ apt: true, reason: null, transactionIdAvailable: true, metrics: {} }),
      findTransaction: async ({ transactionId }) => { chamadasFindTransaction += 1; return { found: transactionId === pedido.id, transactions: 1, revenue: 300 }; },
    }),
  });
  const svc = await montarServico(registry);
  const r = await svc.checkOrderTransactionLink({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO, providerOrderId: pedido.id });
  assert.equal(chamadasGetOrder, 1);
  assert.equal(chamadasFindTransaction, 1);
  assert.equal(r.available, true);
  assert.equal(r.linked, true);
  assert.equal(r.linkType, 'transaction_linked');
  assert.equal(r.order.id, pedido.id);
}));

// ── M: achado real de produção (Use Sul) — a Ink manda transaction_id pro GA4 como INK<id> ────────

test('M · commerceTransactionIdPrefix: findTransaction recebe o providerOrderId PREFIXADO, nunca o cru — achado real contra o GA4 da Use Sul', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p10' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  let transactionIdRecebido = null;
  const pedido = pedidoFake('2010279', { items: [{ commerceProductId: ids.get('p10'), quantity: 1, totalValue: 794.20 }], totalValue: 794.20 });
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: true, variants: false, productsWithVariants: false, orders: true, refunds: false, productCosts: false },
    create: () => ({
      listProducts: async () => ({ items: [], nextCursor: null }),
      getProduct: async () => null,
      listOrders: async () => ({ items: [], nextCursor: null }),
      getOrder: async ({ providerOrderId }) => (providerOrderId === pedido.id ? pedido : null),
    }),
  });
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({
      getProductPerformance: async () => [],
      getTransactionCapabilities: async () => ({ apt: true, reason: null, transactionIdAvailable: true, metrics: {} }),
      // GA4 REAL só reconhece 'INK2010279' — se o service mandasse o id cru ('2010279'), nunca acharia.
      findTransaction: async ({ transactionId }) => { transactionIdRecebido = transactionId; return { found: transactionId === 'INK2010279', transactions: 1, revenue: 794.20 }; },
    }),
  });
  const svc = await montarServico(registry, { commerceTransactionIdPrefix: 'INK' });
  const r = await svc.checkOrderTransactionLink({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO, providerOrderId: pedido.id });
  assert.equal(transactionIdRecebido, 'INK2010279');
  assert.equal(r.linked, true);
  // O providerOrderId exposto na resposta continua CRU (é o id do Commerce, nunca o formato do GA4).
  assert.equal(r.order.id, '2010279');
}));

test('M · commerceTransactionIdPrefix default é vazio — nenhum provider ganha prefixo sem ser explicitamente configurado', () => em(async () => {
  const ids = await semearCatalogo([{ providerProductId: 'p11' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  let transactionIdRecebido = null;
  const pedido = pedidoFake('sem-prefixo-1', { items: [{ commerceProductId: ids.get('p11'), quantity: 1, totalValue: 50 }], totalValue: 50 });
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: true, variants: false, productsWithVariants: false, orders: true, refunds: false, productCosts: false },
    create: () => ({
      listProducts: async () => ({ items: [], nextCursor: null }), getProduct: async () => null, listOrders: async () => ({ items: [], nextCursor: null }),
      getOrder: async ({ providerOrderId }) => (providerOrderId === pedido.id ? pedido : null),
    }),
  });
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({
      getProductPerformance: async () => [],
      getTransactionCapabilities: async () => ({ apt: true, reason: null, transactionIdAvailable: true, metrics: {} }),
      findTransaction: async ({ transactionId }) => { transactionIdRecebido = transactionId; return { found: false, transactions: null, revenue: null }; },
    }),
  });
  const svc = await montarServico(registry); // sem commerceTransactionIdPrefix — default ''
  await svc.checkOrderTransactionLink({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO, providerOrderId: pedido.id });
  assert.equal(transactionIdRecebido, 'sem-prefixo-1'); // cru, sem prefixo nenhum
}));

test('L · checkOrderTransactionLink: pedido inexistente → insufficient_data/ORDER_NOT_FOUND, nunca chama o GA4', () => em(async () => {
  let chamouGa4 = false;
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: true, variants: false, productsWithVariants: false, orders: true, refunds: false, productCosts: false },
    create: () => ({ listProducts: async () => ({ items: [], nextCursor: null }), getProduct: async () => null, listOrders: async () => ({ items: [], nextCursor: null }), getOrder: async () => null }),
  });
  registry.register({
    domain: 'analytics', provider: ANALYTICS_PROVIDER, integrationProvider: ANALYTICS_PROVIDER, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({ getProductPerformance: async () => [], findTransaction: async () => { chamouGa4 = true; return { found: false, transactions: null, revenue: null }; } }),
  });
  const svc = await montarServico(registry);
  const r = await svc.checkOrderTransactionLink({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO, providerOrderId: 'nunca-existiu' });
  assert.equal(r.available, false);
  assert.equal(r.status, 'insufficient_data');
  assert.equal(r.reason, 'ORDER_NOT_FOUND');
  assert.equal(chamouGa4, false);
}));

test('L · checkOrderTransactionLink exige providerOrderId e período válido', () => em(async () => {
  const svc = await montarServico(registryFake());
  await assert.rejects(svc.checkOrderTransactionLink({ organizationId: ORG_A, storeId: STORE_A, ...PERIODO }), TypeError);
}));

// ── L §2.4: localOrdersHistoryStart injetável — nunca uma data global fixa pra todo tenant SaaS ────

test('L · localOrdersHistoryStart é injetável na composição — default preserva o comportamento atual', () => em(async () => {
  const svc = await montarServico(registryFake());
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, startDate: '2026-07-01', endDate: '2026-08-01' });
  assert.equal(r.historyStartsAt, LOCAL_ORDERS_HISTORY_START); // default = mesma constante de reconciliation.js
}));

test('L · localOrdersHistoryStart customizado permite um período que o default rejeitaria — nunca hardcoded globalmente', () => em(async () => {
  const svc = await montarServico(registryFake({ linhas: [] }), { localOrdersHistoryStart: '2026-01-01' });
  const r = await svc.getJourneyAnalytics({ organizationId: ORG_A, storeId: STORE_A, startDate: '2026-07-01', endDate: '2026-08-01' });
  assert.equal(r.status, 'ok'); // com o default (19/08/2026) isto teria sido insufficient_data
}));

// ── L §2.5: provider abstraction — nunca client concreto de Meta/Ink/GA4 direto ────────────────────

test('L · journey-analytics-service.js só importa domínio (reconciliation, meta/campaign-performance via registry) — nunca client concreto', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const arq = path.join(__dirname, '..', '..', 'lib', 'product-analytics', 'journey-analytics-service.js');
  const fonte = fs.readFileSync(arq, 'utf8');
  // (?<![.\w]) exclui `resolvido.require('orders')` (método do registry, não `require()` de módulo).
  const requires = [...fonte.matchAll(/(?<![.\w])require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ['./reconciliation', '../meta/campaign-performance']);
  assert.doesNotMatch(fonte, /reserva[_-]?ink|InkClient|inkApi|Ga4Client|ga4\/(client|connector)|graph\.facebook\.com/i);
});
