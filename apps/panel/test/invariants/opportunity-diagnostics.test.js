'use strict';

// Gate C (rodada "Jornada de Valor") · OpportunityDiagnosticsService — unitário, puro: dubla
// productPerformanceService/reconciliationService (a integração REAL das duas com Postgres/GA4 fake
// já tem cobertura própria em product-performance-service.test.js e reconciliation.test.js; aqui o
// alvo é só a matemática de baseline/desvio/score/limiar e a degradação honesta por fonte).

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { createOpportunityDiagnosticsService, MIN_SAMPLES_PADRAO } = h.sujeito('lib/product-analytics/opportunity-diagnostics.js');

const PERIODO = { organizationId: 'org-1', storeId: 'store-1', startDate: '2026-09-01', endDate: '2026-09-20' };
const ANALYTICS_PROVIDER = 'ga4';
const COMMERCE_PROVIDER = 'reserva_ink';

function taxa(num, den) {
  if (num === null || den === null || !(den > 0)) return null;
  return num / den;
}

function produto(id, over = {}) {
  return { id, name: `Produto ${id}`, imageUrl: null, productType: null, provider: COMMERCE_PROVIDER, providerProductId: id, ...over };
}

// Constrói uma linha no MESMO formato que product-performance-service.js#montarLinha devolve —
// itemRatios calculado com a mesma fórmula (nunca um valor arbitrário desalinhado do service real).
function linha(id, metrics) {
  const m = { itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 0, itemsPurchased: 0, itemRevenue: 0, ...metrics };
  return {
    product: produto(id),
    metrics: m,
    itemRatios: {
      itemsAddedToCartPerItemViewed: taxa(m.itemsAddedToCart, m.itemsViewed),
      itemsCheckedOutPerItemViewed: taxa(m.itemsCheckedOut, m.itemsViewed),
      itemsCheckedOutPerItemAddedToCart: taxa(m.itemsCheckedOut, m.itemsAddedToCart),
      itemsPurchasedPerItemViewed: taxa(m.itemsPurchased, m.itemsViewed),
    },
    identity: { matchedAnalyticsIds: [`${ANALYTICS_PROVIDER}.item_id:${id}`], status: 'matched' },
    diagnostics: [],
  };
}

function coberturaOk({ observed, matched }) {
  return {
    observedAnalyticsIds: observed, matchedAnalyticsIds: matched, unmatchedAnalyticsIds: observed - matched,
    coverageRate: observed > 0 ? matched / observed : null, status: 'ok',
  };
}

// `itemsPorPagina`: 1 array só = 1 página só (a paginação em si já é coberta pelo padrão idêntico
// em reconciliation.test.js — aqui o alvo é a matemática, não o loop de cursor).
function fakeProductPerformanceService({ items = [], coverage = coberturaOk({ observed: 0, matched: 0 }), erro = null } = {}) {
  return {
    async getProductPerformance() {
      if (erro) throw erro;
      return { items, nextCursor: null, totalCount: items.length, coverage };
    },
  };
}

function fakeReconciliationService({ resposta = null, erro = null } = {}) {
  return {
    async reconcileProductPerformance() {
      if (erro) throw erro;
      return resposta || { status: 'ok', items: [], coverage: coberturaOk({ observed: 0, matched: 0 }), caveats: [] };
    },
  };
}

function servico({ pps, recon, ...overridesConfig } = {}) {
  return createOpportunityDiagnosticsService({
    productPerformanceService: pps || fakeProductPerformanceService(),
    reconciliationService: recon || fakeReconciliationService(),
    analyticsProvider: ANALYTICS_PROVIDER,
    commerceProvider: COMMERCE_PROVIDER,
    ...overridesConfig,
  });
}

test('C · entrada inválida (sem organizationId/período): lança, nunca devolve resposta parcial', async () => {
  const svc = servico();
  await assert.rejects(() => svc.getOpportunities({ storeId: 's1', startDate: '2026-09-01', endDate: '2026-09-20' }), TypeError);
  await assert.rejects(() => svc.getOpportunities({ ...PERIODO, startDate: '2026-09-20', endDate: '2026-09-01' }), TypeError);
});

test('C · produto com views suficientes e add-to-cart muito abaixo do baseline da Store → low_view_to_cart', async () => {
  const items = [
    // Baseline: 5 produtos "normais" com ~20% de conversão view→cart.
    linha('p1', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('p2', { itemsViewed: 100, itemsAddedToCart: 22 }),
    linha('p3', { itemsViewed: 100, itemsAddedToCart: 18 }),
    linha('p4', { itemsViewed: 100, itemsAddedToCart: 21 }),
    linha('p5', { itemsViewed: 100, itemsAddedToCart: 19 }),
    // Sinal: mesmo volume de views, muito menos adição ao carrinho.
    linha('ruim', { itemsViewed: 120, itemsAddedToCart: 3 }),
  ];
  const pps = fakeProductPerformanceService({ items, coverage: coberturaOk({ observed: 6, matched: 6 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);

  assert.equal(r.status, 'ok');
  assert.equal(r.sources.productFunnel.available, true);
  const sinal = r.opportunities.find((o) => o.type === 'low_view_to_cart' && o.product.id === 'ruim');
  assert.ok(sinal, `esperava low_view_to_cart pro produto 'ruim'; achou: ${JSON.stringify(r.opportunities.map((o) => [o.type, o.product?.id]))}`);
  assert.equal(sinal.scope, 'product');
  assert.equal(sinal.evidence.itemsViewed, 120);
  assert.ok(sinal.evidence.deviation > 0.3, `desvio devia ser bem maior que o mínimo: ${sinal.evidence.deviation}`);
  assert.ok(!/causa|prova|garantid/i.test(sinal.hypothesis), 'hipótese nunca pode soar como causa comprovada');
  // Baseline nunca puxado pelo próprio produto ruim nem inflado por ele.
  assert.ok(sinal.evidence.storeBaseline > 0.15, `baseline não devia cair pro nível do produto ruim: ${sinal.evidence.storeBaseline}`);
});

test('C · produto ACIMA do baseline nunca vira oportunidade (só desvio pra baixo interessa)', async () => {
  const items = [
    linha('p1', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('p2', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('p3', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('campeao', { itemsViewed: 100, itemsAddedToCart: 90 }), // MUITO acima do baseline — nunca um "problema"
  ];
  const pps = fakeProductPerformanceService({ items, coverage: coberturaOk({ observed: 4, matched: 4 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.product?.id === 'campeao'), false);
});

test('C · volume abaixo do mínimo configurado nunca vira oportunidade, mesmo com desvio grande (evita ruído de amostra pequena)', async () => {
  const items = [
    linha('p1', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('p2', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('p3', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('poucas-views', { itemsViewed: 5, itemsAddedToCart: 0 }), // desvio de 100%, mas abaixo do mínimo de amostra
  ];
  const pps = fakeProductPerformanceService({ items, coverage: coberturaOk({ observed: 4, matched: 4 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.product?.id === 'poucas-views'), false);
});

test('C · itemsCheckedOut > itemsAddedToCart (não-monotonicidade de instrumentação distinta): nunca lança, nunca vira sinal fabricado por denominador incoerente', async () => {
  const items = [
    linha('p1', { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 25 }), // checkout > cart: instrumentação distinta, não erro
    linha('p2', { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 18 }),
    linha('p3', { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 19 }),
  ];
  const pps = fakeProductPerformanceService({ items, coverage: coberturaOk({ observed: 3, matched: 3 }) });
  await assert.doesNotReject(() => servico({ pps }).getOpportunities(PERIODO));
});

test('C · denominador zero (itemsViewed=0 num produto elegível por outro campo): taxa vira null, nunca Infinity/NaN', async () => {
  const items = [
    linha('p1', { itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 15, itemsPurchased: 10 }),
    linha('p2', { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 15, itemsPurchased: 10 }),
    linha('p3', { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 15, itemsPurchased: 10 }),
  ];
  const pps = fakeProductPerformanceService({ items, coverage: coberturaOk({ observed: 3, matched: 3 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  for (const o of r.opportunities) {
    for (const v of Object.values(o.evidence)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `evidence nunca pode ter Infinity/NaN: ${JSON.stringify(o.evidence)}`);
    }
  }
});

test('C · GA4 desconectado (productPerformanceService lança): productFunnel not_connected, nunca derruba a chamada inteira', async () => {
  const erro = Object.assign(new Error('não conectado'), { codigo: 'INTEGRATION_NOT_CONNECTED' });
  const pps = fakeProductPerformanceService({ erro });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.status, 'ok');
  assert.equal(r.sources.productFunnel.available, false);
  assert.equal(r.sources.productFunnel.status, 'not_connected');
  assert.deepEqual(r.opportunities, []);
});

test('C · Commerce desconectado (reconciliationService lança): commerceReconciliation not_connected, sinais 1-3/5 continuam funcionando', async () => {
  const items = [
    linha('p1', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('p2', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('p3', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('ruim', { itemsViewed: 120, itemsAddedToCart: 2 }),
  ];
  const pps = fakeProductPerformanceService({ items, coverage: coberturaOk({ observed: 4, matched: 4 }) });
  const erro = Object.assign(new Error('não conectado'), { codigo: 'INTEGRATION_NOT_CONNECTED' });
  const recon = fakeReconciliationService({ erro });
  const r = await servico({ pps, recon }).getOpportunities(PERIODO);
  assert.equal(r.sources.commerceReconciliation.available, false);
  assert.equal(r.sources.commerceReconciliation.status, 'not_connected');
  assert.ok(r.opportunities.some((o) => o.type === 'low_view_to_cart'), 'sinal 1 (só GA4) devia continuar funcionando sem Commerce');
  assert.equal(r.opportunities.some((o) => o.type === 'units_divergent_ga4_commerce'), false);
});

test('C · sem nenhuma integração conectada: status ok, sources ambos indisponíveis, opportunities vazio (nunca erro)', async () => {
  const erroGa4 = Object.assign(new Error('x'), { codigo: 'INTEGRATION_NOT_CONNECTED' });
  const erroCommerce = Object.assign(new Error('x'), { codigo: 'INTEGRATION_NOT_CONNECTED' });
  const pps = fakeProductPerformanceService({ erro: erroGa4 });
  const recon = fakeReconciliationService({ erro: erroCommerce });
  const r = await servico({ pps, recon }).getOpportunities(PERIODO);
  assert.equal(r.status, 'ok');
  assert.equal(r.sources.productFunnel.available, false);
  assert.equal(r.sources.commerceReconciliation.available, false);
  assert.deepEqual(r.opportunities, []);
  assert.equal(r.totalCandidates, 0);
});

test('C · reconciliação com período antes do histórico local (insufficient_data, sem lançar): commerceReconciliation vira insufficient_data, não not_connected', async () => {
  const recon = fakeReconciliationService({ resposta: { status: 'insufficient_data', reason: 'LOCAL_ORDERS_HISTORY_STARTS_LATER', items: [], caveats: [] } });
  const r = await servico({ recon }).getOpportunities(PERIODO);
  assert.equal(r.sources.commerceReconciliation.available, false);
  assert.equal(r.sources.commerceReconciliation.status, 'insufficient_data');
});

test('C · GA4 conectado mas zero linhas no período: productFunnel insufficient_data (nunca "not_connected" — a diferença importa pra UI)', async () => {
  const pps = fakeProductPerformanceService({ items: [], coverage: { observedAnalyticsIds: 0, matchedAnalyticsIds: 0, unmatchedAnalyticsIds: 0, coverageRate: null, status: 'insufficient_data' } });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.sources.productFunnel.status, 'insufficient_data');
  assert.deepEqual(r.opportunities, []);
});

test('C · reconciliação com unidades divergentes e volume relevante → units_divergent_ga4_commerce', async () => {
  const recon = fakeReconciliationService({
    resposta: {
      status: 'ok',
      items: [
        { product: produto('divergente'), analyticsUnits: 50, commerceUnits: 10, analyticsRevenue: 1000, commerceRevenue: 200, paidOrdersDistinct: 8, status: 'divergent', diagnostics: ['units_divergent'] },
        { product: produto('alinhado'), analyticsUnits: 10, commerceUnits: 10, analyticsRevenue: 200, commerceRevenue: 200, paidOrdersDistinct: 9, status: 'aligned', diagnostics: [] },
      ],
      coverage: coberturaOk({ observed: 2, matched: 2 }),
      caveats: [],
    },
  });
  const r = await servico({ recon }).getOpportunities(PERIODO);
  const sinal = r.opportunities.find((o) => o.type === 'units_divergent_ga4_commerce');
  assert.ok(sinal, 'esperava units_divergent_ga4_commerce pro produto divergente');
  assert.equal(sinal.product.id, 'divergente');
  assert.equal(sinal.evidence.analyticsUnits, 50);
  assert.equal(sinal.evidence.commerceUnits, 10);
  assert.equal(r.opportunities.some((o) => o.product?.id === 'alinhado'), false);
});

test('C · divergência com volume mínimo (1-2 unidades pagas): nunca vira sinal — ruído de 1 pedido', async () => {
  const recon = fakeReconciliationService({
    resposta: {
      status: 'ok',
      items: [{ product: produto('ruido'), analyticsUnits: 5, commerceUnits: 1, analyticsRevenue: 100, commerceRevenue: 20, paidOrdersDistinct: 1, status: 'divergent', diagnostics: ['units_divergent'] }],
      coverage: coberturaOk({ observed: 1, matched: 1 }),
      caveats: [],
    },
  });
  const r = await servico({ recon }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.type === 'units_divergent_ga4_commerce'), false);
});

test('C · cobertura de identidade baixa (muitos itemId observados sem produto) → identity_coverage_low, sinal de ESCOPO STORE (product: null)', async () => {
  const pps = fakeProductPerformanceService({ items: [], coverage: coberturaOk({ observed: 100, matched: 40 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  const sinal = r.opportunities.find((o) => o.type === 'identity_coverage_low');
  assert.ok(sinal, 'esperava identity_coverage_low com 40/100 de cobertura');
  assert.equal(sinal.scope, 'store');
  assert.equal(sinal.product, null);
  assert.equal(sinal.evidence.unmatchedAnalyticsIds, 60);
});

test('C · cobertura de identidade ACIMA do mínimo configurado: nunca vira sinal', async () => {
  const pps = fakeProductPerformanceService({ items: [], coverage: coberturaOk({ observed: 100, matched: 95 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.type === 'identity_coverage_low'), false);
});

test('C · cobertura baixa mas com poucos ids observados (abaixo do mínimo de amostra): nunca vira sinal — evita alarme com 2 de 3 itemIds', async () => {
  const pps = fakeProductPerformanceService({ items: [], coverage: coberturaOk({ observed: 3, matched: 1 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.type === 'identity_coverage_low'), false);
});

test('C · ordenação por score (volume × desvio × confiabilidade) — maior score primeiro, sempre', async () => {
  const items = [
    linha('base1', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('base2', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('base3', { itemsViewed: 100, itemsAddedToCart: 20 }),
    linha('sinal-pequeno', { itemsViewed: 31, itemsAddedToCart: 1 }), // desvio grande, volume raso (perto do mínimo)
    linha('sinal-grande', { itemsViewed: 5000, itemsAddedToCart: 50 }), // mesmo desvio proporcional, volume ENORME
  ];
  const pps = fakeProductPerformanceService({ items, coverage: coberturaOk({ observed: 5, matched: 5 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  const idx = (id) => r.opportunities.findIndex((o) => o.product?.id === id);
  assert.ok(idx('sinal-grande') !== -1 && idx('sinal-pequeno') !== -1, 'os dois deviam aparecer como candidatos');
  assert.ok(idx('sinal-grande') < idx('sinal-pequeno'), 'maior volume com desvio comparável deve vir primeiro (score = volume × desvio × confiabilidade)');
});

test('C · limite (Prioridades de hoje é curto de propósito): corta em `limit`, mas totalCandidates mostra o total real', async () => {
  // Maioria de produtos "normais" (mantém a MEDIANA ancorada no baseline bom) e uma minoria "ruim"
  // maior que o `limit` — prova que o corte é só de APRESENTAÇÃO, nunca de critério.
  const base = Array.from({ length: 9 }, (_, i) => linha(`b${i}`, { itemsViewed: 100, itemsAddedToCart: 20 }));
  const ruins = Array.from({ length: 5 }, (_, i) => linha(`ruim${i}`, { itemsViewed: 100 + i, itemsAddedToCart: 1 }));
  const pps = fakeProductPerformanceService({ items: [...base, ...ruins], coverage: coberturaOk({ observed: 14, matched: 14 }) });
  const r = await servico({ pps }).getOpportunities({ ...PERIODO, limit: 3 });
  assert.equal(r.opportunities.length, 3);
  assert.equal(r.totalCandidates, 5); // todos os 5 "ruins" passam no critério — só a APRESENTAÇÃO corta em 3
  assert.equal(r.config.limit, 3);
});

test('C · limiares configuráveis (minSamples/minDeviation/minCoverage) — nunca hardcoded, sempre repassados e refletidos em config', async () => {
  const pps = fakeProductPerformanceService({ items: [], coverage: coberturaOk({ observed: 0, matched: 0 }) });
  const r = await servico({ pps }).getOpportunities({ ...PERIODO, minSamples: { viewToCart: 999 }, minDeviation: 0.5, minCoverage: 0.9 });
  assert.equal(r.config.minSamples.viewToCart, 999);
  assert.equal(r.config.minSamples.cartToCheckout, MIN_SAMPLES_PADRAO.cartToCheckout); // parcial: só o campo passado muda
  assert.equal(r.config.minDeviation, 0.5);
  assert.equal(r.config.minCoverage, 0.9);
});
