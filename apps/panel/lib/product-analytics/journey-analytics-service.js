'use strict';

// Rodada K · Journey Analytics Engine — cruza GA4 (funil agregado + aquisição por canal/campanha +
// lookup de transação), Meta Ads (investimento/conversões REPORTADOS, via
// lib/meta/campaign-performance.js) e Commerce (pedidos pagos) num só relatório por Organization/Store
// e período, sem inventar nenhuma correlação que os dados não sustentem.
//
// Escopo negativo desta rodada (adendo definitivo): NUNCA implementa StoreFront, Pixel, CAPI, SDK,
// `journey_id` próprio nem endpoint público de ingestão — só o que as integrações JÁ conectadas
// (GA4/Meta Ads/Commerce) sustentam de verdade.
//
// Três camadas de cobertura (adendo — complemento arquitetural: "fonte opcional de eventos de
// jornada"), cada uma reportada com `available`/`reason` explícitos, nunca um erro que derruba a
// feature inteira:
//
//   tier1 (funil e atribuição agregados) — sempre que GA4/Meta/Commerce estão conectados; nunca
//     depende de correlação individual. Reaproveita o MESMO relatório cacheado do Product Analytics
//     (Fase G/J.4) — nenhuma chamada de analytics extra.
//   tier2 (transação↔pedido) — só quando GA4 aceita a dimensão `transactionId` NESTA propriedade
//     (checado ao vivo 1x por período, nunca presumido — §1/§6 do comando: "não presuma
//     compatibilidade sem evidência"); tenta ligar cada pedido pago do Commerce a uma transação GA4
//     pelo MESMO identificador (`providerOrderId` como `transactionId`) — nunca por proximidade.
//   tier3 (jornada individual) — reservado para quando um `EventAnalyticsConnector` real (domain
//     `event_analytics`, contrato já em lib/connectors/types.js) for registrado no registry; hoje
//     `registry.providersOf('event_analytics')` está sempre vazio nesta composição — tratado como
//     "ainda não existe fonte", nunca como erro. Registrar um provider real no futuro não exige
//     nenhuma mudança aqui: este service descobre pelo registry, nunca por um nome de provider fixo.
//
// NUNCA soma Meta+GA4 diretamente (fontes diferentes, nunca a mesma unidade — §4 do comando);
// atribuição de plataforma (Meta Ads/GA4) nunca é apresentada como prova de um pedido específico;
// pedidos e transações só se ligam por identificador igual, nunca por horário/SKU/valor parecidos.

const { LOCAL_ORDERS_HISTORY_START } = require('./reconciliation');
const { getCampaignPerformance } = require('../meta/campaign-performance');

function validarEntrada({ organizationId, storeId, startDate, endDate }) {
  if (!organizationId || !storeId) throw new TypeError('organizationId e storeId são obrigatórios');
  if (!startDate || !endDate) throw new TypeError('startDate e endDate são obrigatórios (ISO puro)');
  if (String(startDate) > String(endDate)) throw new TypeError('startDate deve ser <= endDate');
}

// Soma protegida contra métrica ausente (§ mesma disciplina de somarMetrica em
// product-performance-service.js): null contamina o total, nunca vira 0 silencioso.
function somarCampos(linhas, campo) {
  if (!linhas.length) return null;
  let acc = 0;
  for (const l of linhas) {
    const v = l[campo];
    if (v === null || v === undefined) return null;
    acc += v;
  }
  return acc;
}

/**
 * @param {{pool, registry, productPerformanceService, analyticsProvider, commerceProvider}} deps
 */
function createJourneyAnalyticsService({ pool, registry, productPerformanceService, analyticsProvider, commerceProvider }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createJourneyAnalyticsService exige pool');
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createJourneyAnalyticsService exige registry');
  if (!productPerformanceService || typeof productPerformanceService.getProductPerformanceSummary !== 'function') {
    throw new Error('createJourneyAnalyticsService exige productPerformanceService');
  }
  if (!analyticsProvider) throw new Error('createJourneyAnalyticsService exige analyticsProvider');
  if (!commerceProvider) throw new Error('createJourneyAnalyticsService exige commerceProvider');

  // Tier 1a · funil agregado — reaproveita getProductPerformanceSummary (Fase G/J.4): observed (todo
  // itemId GA4 do período) + matched (só o resolvido a produto canônico), nunca um número novo.
  async function funilAgregado({ organizationId, storeId, startDate, endDate }) {
    try {
      const summary = await productPerformanceService.getProductPerformanceSummary({ organizationId, storeId, analyticsProvider, startDate, endDate });
      return {
        available: summary.coverage.status === 'ok',
        reason: summary.coverage.status === 'ok' ? null : summary.coverage.status,
        observed: summary.observed, matched: summary.matched, coverage: summary.coverage,
      };
    } catch (err) {
      return { available: false, reason: err.codigo || 'ANALYTICS_UNAVAILABLE', observed: null, matched: null, coverage: null };
    }
  }

  // Tier 1b · aquisição por canal/campanha (GA4) — checa a capability ao vivo ANTES de tentar
  // (§1: "não presuma compatibilidade sem evidência"); a ausência é reportada, nunca contornada.
  async function aquisicaoPorCanal({ organizationId, storeId, startDate, endDate }) {
    let resolvido;
    try {
      resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
    } catch (err) {
      return { available: false, reason: err.codigo || 'ANALYTICS_NOT_REGISTERED', rows: [] };
    }
    if (typeof resolvido.connector.getAcquisitionPerformance !== 'function') {
      return { available: false, reason: 'PROVIDER_WITHOUT_ACQUISITION_CAPABILITY', rows: [] };
    }
    try {
      const rows = await resolvido.connector.getAcquisitionPerformance({ startDate, endDate });
      return { available: true, reason: null, rows };
    } catch (err) {
      return { available: false, reason: err.codigo || 'ACQUISITION_UNAVAILABLE', rows: [] };
    }
  }

  // Tier 1c · investimento/conversões REPORTADOS pela Meta Ads (lib/meta/campaign-performance.js —
  // já tenant-scoped por RLS, reaproveita meta_insights_daily sem chamada nova à Graph API). Nunca
  // tratado como prova de pedido individual (§2 do comando).
  async function investimentoMeta({ startDate, endDate }) {
    try {
      const resultado = await getCampaignPerformance({ pool, startDate, endDate });
      return { available: resultado.connected, reason: resultado.connected ? null : 'META_NOT_CONNECTED', campaigns: resultado.campaigns };
    } catch (err) {
      return { available: false, reason: err.codigo || 'META_UNAVAILABLE', campaigns: [] };
    }
  }

  // Tier 1d · pedidos CONFIRMADOS pelo Commerce (isPaid=true) — paginação inteira do período, mesmo
  // padrão de reconciliation.js `agregarCommercePorProduto` (nunca 1 chamada por produto/pedido).
  async function pedidosConfirmados({ organizationId, storeId, startDate, endDate }) {
    let resolvido;
    try {
      resolvido = registry.resolve('commerce', commerceProvider, { organizationId, storeId });
      resolvido.require('orders');
    } catch (err) {
      return { available: false, reason: err.codigo || 'COMMERCE_NOT_REGISTERED', orders: [] };
    }
    const orders = [];
    let cursor = null;
    try {
      do {
        // eslint-disable-next-line no-await-in-loop
        const pagina = await resolvido.connector.listOrders({ startDate, endDate, cursor, limit: 200 });
        for (const pedido of pagina.items) if (pedido.isPaid) orders.push(pedido);
        cursor = pagina.nextCursor;
      } while (cursor);
      return { available: true, reason: null, orders };
    } catch (err) {
      return { available: false, reason: err.codigo || 'COMMERCE_UNAVAILABLE', orders: [] };
    }
  }

  // Tier 2 · transactionId(GA4) ↔ providerOrderId(Commerce) — só tenta quando a propriedade aceita a
  // dimensão (checado 1x por período, nunca por pedido — nunca N+1 de checkCompatibility). Vínculo
  // SÓ por identificador igual (§6 do comando) — nunca por horário/SKU/valor parecidos.
  async function correlacaoTransacaoPedido({ organizationId, storeId, startDate, endDate }, orders) {
    let resolvido;
    try {
      resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
    } catch (err) {
      return { available: false, reason: err.codigo || 'ANALYTICS_NOT_REGISTERED', checked: 0, linked: 0, links: [] };
    }
    if (typeof resolvido.connector.getTransactionCapabilities !== 'function' || typeof resolvido.connector.findTransaction !== 'function') {
      return { available: false, reason: 'PROVIDER_WITHOUT_TRANSACTION_CAPABILITY', checked: 0, linked: 0, links: [] };
    }
    let capacidades;
    try {
      capacidades = await resolvido.connector.getTransactionCapabilities();
    } catch (err) {
      return { available: false, reason: err.codigo || 'TRANSACTION_CAPABILITY_CHECK_FAILED', checked: 0, linked: 0, links: [] };
    }
    if (!capacidades.apt) {
      return { available: false, reason: capacidades.reason || 'TRANSACTION_ID_UNAVAILABLE', checked: 0, linked: 0, links: [] };
    }
    const links = [];
    for (const pedido of orders) {
      // eslint-disable-next-line no-await-in-loop
      const resultado = await resolvido.connector.findTransaction({ startDate, endDate, transactionId: pedido.providerOrderId });
      links.push({
        commerceOrderId: pedido.id, providerOrderId: pedido.providerOrderId,
        linked: resultado.found, ga4Transactions: resultado.transactions, ga4Revenue: resultado.revenue,
      });
    }
    return { available: true, reason: null, checked: links.length, linked: links.filter((l) => l.linked).length, links };
  }

  // Tier 3 · jornada individual — reservado. `registry.providersOf('event_analytics')` é a fonte da
  // verdade (nunca um nome de provider fixo aqui): hoje nenhuma composição registra nada nesse
  // domain, então a lista vem sempre vazia — "ainda não existe fonte", nunca erro. Quando um
  // EventAnalyticsConnector real existir, basta registrá-lo no composition.js — este service já sabe
  // descobri-lo.
  async function jornadaIndividual({ organizationId, storeId }) {
    const providers = registry.providersOf('event_analytics');
    if (!providers.length) return { available: false, reason: 'NO_EVENT_ANALYTICS_SOURCE_CONFIGURED', provider: null };
    // Mais de um provider registrado: cada um seria consultado por quem precisar do detalhe — aqui
    // só reporta que EXISTE fonte disponível (o primeiro), nunca escolhe um "vencedor" por conta própria.
    const provider = providers[0];
    try {
      const resolvido = registry.resolve('event_analytics', provider, { organizationId, storeId });
      return { available: true, reason: null, provider, eventLevel: resolvido.supports('eventLevel'), aggregatedOnly: !resolvido.supports('eventLevel') };
    } catch (err) {
      return { available: false, reason: err.codigo || 'EVENT_ANALYTICS_UNAVAILABLE', provider };
    }
  }

  /**
   * @param {{organizationId, storeId, startDate, endDate}} entrada
   */
  async function getJourneyAnalytics(entrada) {
    validarEntrada(entrada);
    const { startDate, endDate } = entrada;

    // Mesmo gate de reconciliation.js: sem histórico local confiável antes desta data, tier2/tier1d
    // comparariam contra pedidos que sabidamente não existem no cache (não é "zero pedidos reais").
    if (String(startDate) < LOCAL_ORDERS_HISTORY_START) {
      return Object.freeze({
        period: { startDate, endDate },
        status: 'insufficient_data',
        reason: 'LOCAL_ORDERS_HISTORY_STARTS_LATER',
        historyStartsAt: LOCAL_ORDERS_HISTORY_START,
      });
    }

    const [funil, aquisicao, meta, commerce] = await Promise.all([
      funilAgregado(entrada), aquisicaoPorCanal(entrada), investimentoMeta(entrada), pedidosConfirmados(entrada),
    ]);
    const tier2 = commerce.available
      ? await correlacaoTransacaoPedido(entrada, commerce.orders)
      : { available: false, reason: 'COMMERCE_UNAVAILABLE', checked: 0, linked: 0, links: [] };
    const tier3 = await jornadaIndividual(entrada);

    const commerceCount = commerce.available ? commerce.orders.length : null;
    const commerceRevenue = commerce.available ? somarCampos(commerce.orders, 'totalValue') : null;
    const metaPurchases = meta.available ? somarCampos(meta.campaigns, 'purchases') : null;
    const metaRevenue = meta.available ? somarCampos(meta.campaigns, 'revenue') : null;
    const metaSpend = meta.available ? somarCampos(meta.campaigns, 'spend') : null;

    return Object.freeze({
      period: { startDate, endDate },
      status: 'ok',
      tier1: Object.freeze({
        funnel: Object.freeze(funil),
        acquisition: Object.freeze(aquisicao),
        adsInvestment: Object.freeze(meta),
        confirmedOrders: Object.freeze({ available: commerce.available, reason: commerce.reason, count: commerceCount, revenue: commerceRevenue }),
      }),
      tier2: Object.freeze({ transactionOrderLink: Object.freeze(tier2) }),
      tier3: Object.freeze({ individualJourney: Object.freeze(tier3) }),
      // Três fontes, NUNCA somadas entre si (§4 do comando) — cada uma mede uma coisa diferente:
      // Commerce é a venda operacional CONFIRMADA; Meta Ads é o que a PLATAFORMA reporta como
      // atribuído (janela/modelo próprios dela); GA4 é o comportamento OBSERVADO e agregado por item
      // (nunca por pedido). Divergência entre elas é diagnóstico, nunca "erro" de nenhuma das três.
      attribution: Object.freeze([
        Object.freeze({ source: 'commerce', label: 'Commerce (confirmado)', purchases: commerceCount, revenue: commerceRevenue }),
        Object.freeze({ source: 'meta_ads', label: 'Meta Ads (reportado pela plataforma)', purchases: metaPurchases, revenue: metaRevenue, spend: metaSpend }),
        Object.freeze({ source: 'ga4', label: 'GA4 (observado, agregado por item)', purchases: funil.available ? funil.observed.itemsPurchased : null, revenue: funil.available ? funil.observed.itemRevenue : null }),
      ]),
      coverage: Object.freeze({
        funnel: funil.available ? 'available' : 'unavailable',
        acquisition: aquisicao.available ? 'available' : 'unavailable',
        adsInvestment: meta.available ? 'available' : 'unavailable',
        confirmedOrders: commerce.available ? 'available' : 'unavailable',
        transactionOrderLink: tier2.available ? 'available' : 'unavailable',
        individualJourney: tier3.available ? 'available' : 'unavailable',
      }),
    });
  }

  return Object.freeze({ getJourneyAnalytics });
}

module.exports = { createJourneyAnalyticsService };
