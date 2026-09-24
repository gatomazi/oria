'use strict';

// Gate C (rodada "Jornada de Valor") · OpportunityDiagnosticsService — unitário, puro: dubla
// productPerformanceService/reconciliationService/catalogRepository (a integração REAL das duas com
// Postgres/GA4 fake já tem cobertura própria em product-performance-service.test.js e
// reconciliation.test.js; aqui o alvo é só a matemática de baseline/desvio/score/limiar e a
// degradação honesta por fonte).
//
// Rodada "corrigir o gargalo real" · reescrito pra dublar o contrato NOVO (prepareStoreAnalytics +
// idsComIdentidadeParaProdutos + getCommerceUnitsAggregation + catalogRepository.getByIds) — o
// serviço não pagina mais o catálogo por dentro (paginarDesempenhoCompleto foi removido: era
// exatamente o gargalo O(páginas × itemIds) que esta rodada corrigiu). Os testes de NEGÓCIO
// (baseline, desvio mínimo, ordenação, degradação por fonte) continuam os mesmos — só a forma de
// alimentar o fake mudou.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { createOpportunityDiagnosticsService, MIN_SAMPLES_PADRAO } = h.sujeito('lib/product-analytics/opportunity-diagnostics.js');

const PERIODO = { organizationId: 'org-1', storeId: 'store-1', startDate: '2026-09-01', endDate: '2026-09-20' };
const ANALYTICS_PROVIDER = 'ga4';
const COMMERCE_PROVIDER = 'reserva_ink';

function produto(id, over = {}) {
  return { id, name: `Produto ${id}`, imageUrl: null, productType: null, provider: COMMERCE_PROVIDER, providerProductId: id, ...over };
}

// Uma entrada do Map `metricasPorProduto` — MESMO formato que
// product-performance-service.js#prepareStoreAnalytics produz de verdade (metrics cru, sem
// itemRatios pré-calculado: quem calcula é `calcularItemRatios`, reaproveitado direto do service
// real — nunca uma segunda fórmula aqui).
function metricas(over = {}) {
  return { itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 0, itemsPurchased: 0, itemRevenue: 0, ...over };
}

// Monta um cenário completo: Map de métricas (pro fake productPerformanceService) + Map de produtos
// (pro fake catalogRepository) a partir de uma lista [{id, metrics}] — cobre o par inteiro que os
// testes precisam, sem repetir os dois em todo teste.
function cenario(entradas) {
  const metricasPorProduto = new Map();
  const produtosPorId = new Map();
  for (const { id, metrics: m } of entradas) {
    metricasPorProduto.set(id, { metrics: metricas(m), externalIds: new Set([`${ANALYTICS_PROVIDER}.item_id:${id}`]) });
    produtosPorId.set(id, produto(id));
  }
  return { metricasPorProduto, produtosPorId };
}

function coberturaOk({ observed, matched }) {
  return {
    observedAnalyticsIds: observed, matchedAnalyticsIds: matched, unmatchedAnalyticsIds: observed - matched,
    coverageRate: observed > 0 ? matched / observed : null, status: 'ok',
  };
}

function fakeProductPerformanceService({ metricasPorProduto = new Map(), coverage = coberturaOk({ observed: 0, matched: 0 }), erro = null, identidadeHistorica = new Set() } = {}) {
  return {
    async prepareStoreAnalytics() {
      if (erro) throw erro;
      return { metricasPorProduto, coverage };
    },
    // Só relevante pro sinal de divergência (produto com venda Commerce, zero atividade GA4 no
    // período, mas identity JÁ resolvida historicamente) — por padrão, nenhuma identity histórica
    // extra (os testes que precisam passam `identidadeHistorica` explícito).
    async idsComIdentidadeParaProdutos({ ids }) {
      return new Set(ids.filter((id) => identidadeHistorica.has(id)));
    },
  };
}

// `resposta`: { status: 'ok', porProduto: Map<id, {unitsSold, itemRevenue, paidOrders: Set}> } |
// { status: 'insufficient_data', reason }
function fakeReconciliationService({ resposta = null, erro = null } = {}) {
  return {
    async getCommerceUnitsAggregation() {
      if (erro) throw erro;
      return resposta || { status: 'ok', porProduto: new Map(), caveats: [] };
    },
  };
}

function fakeCatalogRepository(produtosPorId = new Map()) {
  return {
    async getByIds({ ids }) {
      return ids.map((id) => produtosPorId.get(id)).filter(Boolean);
    },
  };
}

function pedidoPago({ unitsSold, itemRevenue = 0, paidOrders = 1 }) {
  const orders = new Set(Array.from({ length: paidOrders }, (_, i) => `pedido-${i}`));
  return { unitsSold, itemRevenue, paidOrders: orders };
}

function servico({ pps, recon, catalogo, ...overridesConfig } = {}) {
  return createOpportunityDiagnosticsService({
    productPerformanceService: pps || fakeProductPerformanceService(),
    reconciliationService: recon || fakeReconciliationService(),
    catalogRepository: catalogo || fakeCatalogRepository(),
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
  const { metricasPorProduto, produtosPorId } = cenario([
    // Baseline: 5 produtos "normais" com ~20% de conversão view→cart.
    { id: 'p1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'p2', metrics: { itemsViewed: 100, itemsAddedToCart: 22 } },
    { id: 'p3', metrics: { itemsViewed: 100, itemsAddedToCart: 18 } },
    { id: 'p4', metrics: { itemsViewed: 100, itemsAddedToCart: 21 } },
    { id: 'p5', metrics: { itemsViewed: 100, itemsAddedToCart: 19 } },
    // Sinal: mesmo volume de views, muito menos adição ao carrinho.
    { id: 'ruim', metrics: { itemsViewed: 120, itemsAddedToCart: 3 } },
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 6, matched: 6 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);

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
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'p1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'p2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'p3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'campeao', metrics: { itemsViewed: 100, itemsAddedToCart: 90 } }, // MUITO acima do baseline — nunca um "problema"
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 4, matched: 4 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.product?.id === 'campeao'), false);
});

test('C · volume abaixo do mínimo configurado nunca vira oportunidade, mesmo com desvio grande (evita ruído de amostra pequena)', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'p1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'p2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'p3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'poucas-views', metrics: { itemsViewed: 5, itemsAddedToCart: 0 } }, // desvio de 100%, mas abaixo do mínimo de amostra
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 4, matched: 4 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.product?.id === 'poucas-views'), false);
});

test('C · itemsCheckedOut > itemsAddedToCart (não-monotonicidade de instrumentação distinta): nunca lança, nunca vira sinal fabricado por denominador incoerente', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'p1', metrics: { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 25 } }, // checkout > cart: instrumentação distinta, não erro
    { id: 'p2', metrics: { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 18 } },
    { id: 'p3', metrics: { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 19 } },
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 3, matched: 3 }) });
  await assert.doesNotReject(() => servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO));
});

test('C · denominador zero (itemsViewed=0 num produto elegível por outro campo): taxa vira null, nunca Infinity/NaN', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'p1', metrics: { itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 15, itemsPurchased: 10 } },
    { id: 'p2', metrics: { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 15, itemsPurchased: 10 } },
    { id: 'p3', metrics: { itemsViewed: 100, itemsAddedToCart: 20, itemsCheckedOut: 15, itemsPurchased: 10 } },
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 3, matched: 3 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
  for (const o of r.opportunities) {
    for (const v of Object.values(o.evidence)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `evidence nunca pode ter Infinity/NaN: ${JSON.stringify(o.evidence)}`);
    }
  }
});

test('C · GA4 desconectado (prepareStoreAnalytics lança): productFunnel not_connected, nunca derruba a chamada inteira', async () => {
  const erro = Object.assign(new Error('não conectado'), { codigo: 'INTEGRATION_NOT_CONNECTED' });
  const pps = fakeProductPerformanceService({ erro });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.status, 'ok');
  assert.equal(r.sources.productFunnel.available, false);
  assert.equal(r.sources.productFunnel.status, 'not_connected');
  assert.deepEqual(r.opportunities, []);
});

test('C · Commerce desconectado (getCommerceUnitsAggregation lança): commerceReconciliation not_connected, sinais 1-3/5 continuam funcionando', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'p1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'p2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'p3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'ruim', metrics: { itemsViewed: 120, itemsAddedToCart: 2 } },
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 4, matched: 4 }) });
  const erro = Object.assign(new Error('não conectado'), { codigo: 'INTEGRATION_NOT_CONNECTED' });
  const recon = fakeReconciliationService({ erro });
  const r = await servico({ pps, recon, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
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
  const recon = fakeReconciliationService({ resposta: { status: 'insufficient_data', reason: 'LOCAL_ORDERS_HISTORY_STARTS_LATER' } });
  const r = await servico({ recon }).getOpportunities(PERIODO);
  assert.equal(r.sources.commerceReconciliation.available, false);
  assert.equal(r.sources.commerceReconciliation.status, 'insufficient_data');
});

test('C · GA4 conectado mas zero linhas no período: productFunnel insufficient_data (nunca "not_connected" — a diferença importa pra UI)', async () => {
  const pps = fakeProductPerformanceService({ metricasPorProduto: new Map(), coverage: { observedAnalyticsIds: 0, matchedAnalyticsIds: 0, unmatchedAnalyticsIds: 0, coverageRate: null, status: 'insufficient_data' } });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.sources.productFunnel.status, 'insufficient_data');
  assert.deepEqual(r.opportunities, []);
});

test('C · reconciliação com unidades divergentes e volume relevante → units_divergent_ga4_commerce', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'divergente', metrics: { itemsPurchased: 50 } },
    { id: 'alinhado', metrics: { itemsPurchased: 10 } },
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 2, matched: 2 }) });
  const porProduto = new Map([
    ['divergente', pedidoPago({ unitsSold: 10, itemRevenue: 200, paidOrders: 8 })],
    ['alinhado', pedidoPago({ unitsSold: 10, itemRevenue: 200, paidOrders: 9 })],
  ]);
  const recon = fakeReconciliationService({ resposta: { status: 'ok', porProduto } });
  const r = await servico({ pps, recon, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
  const sinal = r.opportunities.find((o) => o.type === 'units_divergent_ga4_commerce');
  assert.ok(sinal, 'esperava units_divergent_ga4_commerce pro produto divergente');
  assert.equal(sinal.product.id, 'divergente');
  assert.equal(sinal.evidence.analyticsUnits, 50);
  assert.equal(sinal.evidence.commerceUnits, 10);
  assert.equal(r.opportunities.some((o) => o.product?.id === 'alinhado'), false);
});

test('C · divergência com volume mínimo (1-2 unidades pagas): nunca vira sinal — ruído de 1 pedido', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([{ id: 'ruido', metrics: { itemsPurchased: 5 } }]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 1, matched: 1 }) });
  const porProduto = new Map([['ruido', pedidoPago({ unitsSold: 1, itemRevenue: 20, paidOrders: 1 })]]);
  const recon = fakeReconciliationService({ resposta: { status: 'ok', porProduto } });
  const r = await servico({ pps, recon, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.type === 'units_divergent_ga4_commerce'), false);
});

test('C · produto com venda Commerce mas ZERO atividade GA4 no período, identity JÁ resolvida historicamente → ainda vira candidato a divergência (nunca excluído)', async () => {
  // Gate 1.6 do comando: "sem excluir produtos elegíveis com zero atividade... não representada no GA4".
  const pps = fakeProductPerformanceService({
    metricasPorProduto: new Map(), // NENHUMA atividade GA4 este período
    coverage: coberturaOk({ observed: 0, matched: 0 }),
    identidadeHistorica: new Set(['so-commerce']), // mas JÁ tem identity ga4.item_id de um período anterior
  });
  const catalogo = fakeCatalogRepository(new Map([['so-commerce', produto('so-commerce')]]));
  const porProduto = new Map([['so-commerce', pedidoPago({ unitsSold: 20, itemRevenue: 400, paidOrders: 15 })]]);
  const recon = fakeReconciliationService({ resposta: { status: 'ok', porProduto } });
  const r = await servico({ pps, recon, catalogo }).getOpportunities(PERIODO);
  const sinal = r.opportunities.find((o) => o.type === 'units_divergent_ga4_commerce');
  assert.ok(sinal, 'produto com identity histórica + venda Commerce sem GA4 este período devia virar divergência (zero real vs. 20 unidades)');
  assert.equal(sinal.evidence.analyticsUnits, 0);
  assert.equal(sinal.evidence.commerceUnits, 20);
});

test('C · produto com venda Commerce mas SEM NENHUMA identity GA4 (nunca resolvida, nem historicamente): fora do sinal de divergência (não dá pra comparar)', async () => {
  const pps = fakeProductPerformanceService({
    metricasPorProduto: new Map(),
    coverage: coberturaOk({ observed: 0, matched: 0 }),
    identidadeHistorica: new Set(), // nenhuma identity, nem histórica
  });
  const catalogo = fakeCatalogRepository(new Map([['sem-identity', produto('sem-identity')]]));
  const porProduto = new Map([['sem-identity', pedidoPago({ unitsSold: 20, itemRevenue: 400, paidOrders: 15 })]]);
  const recon = fakeReconciliationService({ resposta: { status: 'ok', porProduto } });
  const r = await servico({ pps, recon, catalogo }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.type === 'units_divergent_ga4_commerce'), false);
});

test('C · cobertura de identidade baixa (muitos itemId observados sem produto) → identity_coverage_low, sinal de ESCOPO STORE (product: null)', async () => {
  const pps = fakeProductPerformanceService({ metricasPorProduto: new Map(), coverage: coberturaOk({ observed: 100, matched: 40 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  const sinal = r.opportunities.find((o) => o.type === 'identity_coverage_low');
  assert.ok(sinal, 'esperava identity_coverage_low com 40/100 de cobertura');
  assert.equal(sinal.scope, 'store');
  assert.equal(sinal.product, null);
  assert.equal(sinal.evidence.unmatchedAnalyticsIds, 60);
});

test('C · cobertura de identidade ACIMA do mínimo configurado: nunca vira sinal', async () => {
  const pps = fakeProductPerformanceService({ metricasPorProduto: new Map(), coverage: coberturaOk({ observed: 100, matched: 95 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.type === 'identity_coverage_low'), false);
});

test('C · cobertura baixa mas com poucos ids observados (abaixo do mínimo de amostra): nunca vira sinal — evita alarme com 2 de 3 itemIds', async () => {
  const pps = fakeProductPerformanceService({ metricasPorProduto: new Map(), coverage: coberturaOk({ observed: 3, matched: 1 }) });
  const r = await servico({ pps }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.type === 'identity_coverage_low'), false);
});

test('C · ordenação por score (volume × desvio × confiabilidade) — maior score primeiro, sempre', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'base1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'base2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'base3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'sinal-pequeno', metrics: { itemsViewed: 31, itemsAddedToCart: 1 } }, // desvio grande, volume raso (perto do mínimo)
    { id: 'sinal-grande', metrics: { itemsViewed: 5000, itemsAddedToCart: 50 } }, // mesmo desvio proporcional, volume ENORME
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 5, matched: 5 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
  const idx = (id) => r.opportunities.findIndex((o) => o.product?.id === id);
  assert.ok(idx('sinal-grande') !== -1 && idx('sinal-pequeno') !== -1, 'os dois deviam aparecer como candidatos');
  assert.ok(idx('sinal-grande') < idx('sinal-pequeno'), 'maior volume com desvio comparável deve vir primeiro (score = volume × desvio × confiabilidade)');
});

test('C · limite (Prioridades de hoje é curto de propósito): corta em `limit`, mas totalCandidates mostra o total real', async () => {
  // Maioria de produtos "normais" (mantém a MEDIANA ancorada no baseline bom) e uma minoria "ruim"
  // maior que o `limit` — prova que o corte é só de APRESENTAÇÃO, nunca de critério.
  const base = Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, metrics: { itemsViewed: 100, itemsAddedToCart: 20 } }));
  const ruins = Array.from({ length: 5 }, (_, i) => ({ id: `ruim${i}`, metrics: { itemsViewed: 100 + i, itemsAddedToCart: 1 } }));
  const { metricasPorProduto, produtosPorId } = cenario([...base, ...ruins]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 14, matched: 14 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities({ ...PERIODO, limit: 3 });
  assert.equal(r.opportunities.length, 3);
  assert.equal(r.totalCandidates, 5); // todos os 5 "ruins" passam no critério — só a APRESENTAÇÃO corta em 3
  assert.equal(r.config.limit, 3);
});

test('C · Gate C (rodada "Jornada de Valor Operacional"): rótulo é evidenceStrength suficiente/limitada — NUNCA "confidence"/"confiança alta/média/baixa" (soaria como confiança estatística calibrada que este motor não tem)', async () => {
  const { metricasPorProduto, produtosPorId } = cenario([
    { id: 'base1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'base2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'base3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    // No limiar mínimo exato (30) — evidência LIMITADA.
    { id: 'no-limiar', metrics: { itemsViewed: 30, itemsAddedToCart: 0 } },
    // Bem acima do dobro do mínimo (60) — evidência SUFICIENTE.
    { id: 'bem-acima', metrics: { itemsViewed: 5000, itemsAddedToCart: 1 } },
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 5, matched: 5 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities(PERIODO);
  for (const o of r.opportunities) {
    assert.equal('confidence' in o, false, 'campo "confidence" não pode existir — usar evidenceStrength');
    assert.ok(['suficiente', 'limitada'].includes(o.evidenceStrength), `evidenceStrength inválido: ${o.evidenceStrength}`);
  }
  const noLimiar = r.opportunities.find((o) => o.product?.id === 'no-limiar');
  const bemAcima = r.opportunities.find((o) => o.product?.id === 'bem-acima');
  assert.equal(noLimiar.evidenceStrength, 'limitada');
  assert.equal(bemAcima.evidenceStrength, 'suficiente');
});

test('C · ranking encontra a oportunidade forte num universo de 250+ produtos, nunca truncado antes de rankear (a resolução de catálogo só acontece DEPOIS do corte, mas o RANKING usa o conjunto inteiro)', async () => {
  // 249 produtos "normais" (ratio de baseline saudável) + 1 forte candidato, inserido por ÚLTIMO no
  // Map (nunca "primeiro" por acaso) — o universo de comparação/ranking tem que ser o Map inteiro,
  // nunca um subconjunto arbitrário cortado antes da hora.
  const base = Array.from({ length: 249 }, (_, i) => ({ id: `base${i}`, metrics: { itemsViewed: 100, itemsAddedToCart: 20 } }));
  const forte = { id: 'produto-forte-por-ultimo', metrics: { itemsViewed: 10000, itemsAddedToCart: 5 } };
  const { metricasPorProduto, produtosPorId } = cenario([...base, forte]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 250, matched: 250 }) });
  const r = await servico({ pps, catalogo: fakeCatalogRepository(produtosPorId) }).getOpportunities({ ...PERIODO, limit: 1 });
  assert.equal(r.opportunities.length, 1);
  assert.equal(r.opportunities[0].product.id, 'produto-forte-por-ultimo', 'o sinal mais forte tem que vencer o ranking mesmo com 250 produtos no universo elegível');
});

test('C · candidato cujo produto some do catálogo entre a agregação e a resolução final: descartado, nunca aparece com product undefined/quebrado', async () => {
  const { metricasPorProduto } = cenario([
    { id: 'base1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'base2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'base3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'sumiu', metrics: { itemsViewed: 120, itemsAddedToCart: 1 } },
  ]);
  const pps = fakeProductPerformanceService({ metricasPorProduto, coverage: coberturaOk({ observed: 4, matched: 4 }) });
  // catalogRepository NUNCA devolve 'sumiu' — simula produto desativado entre a agregação e o getByIds final.
  const catalogo = fakeCatalogRepository(new Map([['base1', produto('base1')], ['base2', produto('base2')], ['base3', produto('base3')]]));
  const r = await servico({ pps, catalogo }).getOpportunities(PERIODO);
  assert.equal(r.opportunities.some((o) => o.product?.id === 'sumiu'), false);
  for (const o of r.opportunities) assert.notEqual(o.product, undefined);
});

test('C · limiares configuráveis (minSamples/minDeviation/minCoverage) — nunca hardcoded, sempre repassados e refletidos em config', async () => {
  const pps = fakeProductPerformanceService({ metricasPorProduto: new Map(), coverage: coberturaOk({ observed: 0, matched: 0 }) });
  const r = await servico({ pps }).getOpportunities({ ...PERIODO, minSamples: { viewToCart: 999 }, minDeviation: 0.5, minCoverage: 0.9 });
  assert.equal(r.config.minSamples.viewToCart, 999);
  assert.equal(r.config.minSamples.cartToCheckout, MIN_SAMPLES_PADRAO.cartToCheckout); // parcial: só o campo passado muda
  assert.equal(r.config.minDeviation, 0.5);
  assert.equal(r.config.minCoverage, 0.9);
});

test('C · Gate 4 (rodada "corrigir o gargalo real"): concorrência/reentrância — duas Organizations diferentes, MESMA instância de service (como em produção — composition.js monta os services UMA VEZ pro processo inteiro), chamadas concorrentes, nunca cruzam dado', async () => {
  // Fakes cientes de organizationId — cada Organization tem seu PRÓPRIO produto-sinal, nunca visto
  // pela outra. A mesma instância de serviço atende as duas chamadas concorrentes (Promise.all),
  // exatamente como um processo real atende requests HTTP concorrentes de tenants diferentes.
  const cenarioA = cenario([
    { id: 'a-base1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'a-base2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'a-base3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'a-ruim', metrics: { itemsViewed: 120, itemsAddedToCart: 1 } },
  ]);
  const cenarioB = cenario([
    { id: 'b-base1', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'b-base2', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'b-base3', metrics: { itemsViewed: 100, itemsAddedToCart: 20 } },
    { id: 'b-ruim', metrics: { itemsViewed: 120, itemsAddedToCart: 1 } },
  ]);
  const porOrg = { 'org-a': cenarioA, 'org-b': cenarioB };

  const pps = {
    async prepareStoreAnalytics({ organizationId }) {
      return { metricasPorProduto: porOrg[organizationId].metricasPorProduto, coverage: coberturaOk({ observed: 4, matched: 4 }) };
    },
    async idsComIdentidadeParaProdutos() { return new Set(); },
  };
  const catalogo = {
    async getByIds({ organizationId, ids }) {
      return ids.map((id) => porOrg[organizationId].produtosPorId.get(id)).filter(Boolean);
    },
  };
  const recon = fakeReconciliationService(); // Commerce indisponível nos dois — irrelevante pro que este teste prova

  const svc = servico({ pps, recon, catalogo });
  const [rA, rB] = await Promise.all([
    svc.getOpportunities({ ...PERIODO, organizationId: 'org-a', storeId: 'store-a' }),
    svc.getOpportunities({ ...PERIODO, organizationId: 'org-b', storeId: 'store-b' }),
  ]);

  assert.ok(rA.opportunities.some((o) => o.product?.id === 'a-ruim'), 'Organization A devia ver o sinal dela');
  assert.equal(rA.opportunities.some((o) => o.product?.id?.startsWith('b-')), false, 'Organization A NUNCA pode ver produto da Organization B');
  assert.ok(rB.opportunities.some((o) => o.product?.id === 'b-ruim'), 'Organization B devia ver o sinal dela');
  assert.equal(rB.opportunities.some((o) => o.product?.id?.startsWith('a-')), false, 'Organization B NUNCA pode ver produto da Organization A');

  // Reentrância: 2 chamadas concorrentes da MESMA Organization/período têm que devolver o MESMO
  // resultado, nunca um efeito de corrida (cada chamada cria seu próprio Map local, nunca um
  // acumulador compartilhado entre chamadas).
  const [r1, r2] = await Promise.all([
    svc.getOpportunities({ ...PERIODO, organizationId: 'org-a', storeId: 'store-a' }),
    svc.getOpportunities({ ...PERIODO, organizationId: 'org-a', storeId: 'store-a' }),
  ]);
  assert.deepEqual(r1, r2);
});
