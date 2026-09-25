'use strict';

// Rodada K/L · Journey Analytics Engine — cruza GA4 (funil agregado + aquisição por canal/campanha +
// lookup de transação), Meta Ads (investimento/conversões REPORTADOS, via
// lib/meta/campaign-performance.js) e Commerce (pedidos pagos) num só relatório por Organization/Store
// e período, sem inventar nenhuma correlação que os dados não sustentem.
//
// Escopo negativo (K e L, ambos): NUNCA implementa StoreFront, Pixel, CAPI, SDK, `journey_id` próprio
// nem endpoint público de ingestão — só o que as integrações JÁ conectadas (GA4/Meta Ads/Commerce)
// sustentam de verdade.
//
// Três camadas de cobertura, cada uma reportada com `available`/`status`/`reason` explícitos, nunca
// um erro que derruba a feature inteira:
//
//   tier1 (funil e atribuição agregados) — sempre que GA4/Meta/Commerce estão conectados; nunca
//     depende de correlação individual. Reaproveita o MESMO relatório cacheado do Product Analytics
//     (Fase G/J.4) — nenhuma chamada de analytics extra.
//   tier2 (transação↔pedido) — só quando GA4 aceita a dimensão `transactionId` NESTA propriedade
//     (checado ao vivo 1x por período, nunca presumido). Vínculo SÓ por identificador igual — nunca
//     por proximidade. Rodada L §2.3: o relatório agregado nunca varre TODOS os pedidos pagos (risco
//     de N+1 — 1 chamada GA4 por pedido, sem teto, numa rota que qualquer sessão pode abrir); ele
//     verifica só uma AMOSTRA limitada (`maxTransactionSampleSize`, default 10) e expõe
//     `sampled`/`sampleSize`/`totalEligible` para a UI nunca confundir amostra com cobertura total.
//     A verificação de UM pedido específico é `checkOrderTransactionLink` — sob demanda, 1 chamada
//     GA4 por invocação, é o caminho que a UI usa quando o usuário seleciona um pedido.
//   tier3 (jornada individual) — reservado para quando um `EventAnalyticsConnector` real (domain
//     `event_analytics`, contrato já em lib/connectors/types.js) for registrado no registry; hoje
//     `registry.providersOf('event_analytics')` está sempre vazio nesta composição — tratado como
//     "ainda não existe fonte", nunca como erro. Registrar um provider real no futuro não exige
//     nenhuma mudança aqui: este service descobre pelo registry, nunca por um nome de provider fixo.
//     Rodada L §2.2: registrar um `event_analytics` Connector NÃO ativa jornada individual sozinho —
//     ainda exige `eventLevel` real (não só `aggregatedProductEvents`); sem isso fica `unavailable`.
//
// NUNCA soma Meta+GA4 diretamente (fontes diferentes, nunca a mesma unidade); atribuição de
// plataforma (Meta Ads/GA4) nunca é apresentada como prova de um pedido específico; uma igualdade
// `GA4.transactionId === Commerce.providerOrderId` prova só VÍNCULO TRANSAÇÃO↔PEDIDO
// (`linkType: 'transaction_linked'`) — nunca rotulado `complete_journey` nem apresentado como a
// sequência completa de eventos do cliente ou o anúncio que causou a compra (Rodada L §2.1).

const { LOCAL_ORDERS_HISTORY_START } = require('./reconciliation');
const { getCampaignPerformance } = require('../meta/campaign-performance');

const MAX_TRANSACTION_SAMPLE_SIZE = 10;

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

// Rodada L §2.2 · taxonomia normalizada de indisponibilidade — sempre uma destas 5 categorias,
// nunca um `reason` cru sem classificação. Mapeia os códigos que este service e os connectors já
// usam; nunca inventa um código novo, só rotula os existentes para a UI decidir o texto certo.
//
// Achado real do smoke visual (Rodada L, gate 3): `registry.resolve(...)` sem provider registrado
// lança com `err.codigo = CODIGOS.NOT_REGISTERED` ('CONNECTOR_NOT_REGISTERED' — lib/connectors/
// errors.js), nunca o literal 'ANALYTICS_NOT_REGISTERED'/'COMMERCE_NOT_REGISTERED' que este arquivo
// só usa como fallback quando `err.codigo` está ausente (defensivo, praticamente nunca acontece,
// já que ConnectorError sempre carrega `codigo`). Os dois entram no set — o código REAL do
// registry e o literal de fallback — pra nunca mais cair silenciosamente em `temporary_failure`.
const RAZAO_NOT_CONNECTED = new Set([
  'META_NOT_CONNECTED', 'ANALYTICS_NOT_REGISTERED', 'COMMERCE_NOT_REGISTERED', 'INTEGRATION_NOT_CONNECTED',
  'CONNECTOR_NOT_REGISTERED',
]);
const RAZAO_UNSUPPORTED = new Set([
  'PROVIDER_WITHOUT_ACQUISITION_CAPABILITY', 'PROVIDER_WITHOUT_TRANSACTION_CAPABILITY',
  'TRANSACTION_ID_UNAVAILABLE', 'TRANSACTION_METRICS_UNAVAILABLE',
  'ACQUISITION_DIMENSIONS_OR_METRICS_UNAVAILABLE', 'ITEM_ID_UNAVAILABLE', 'ITEMS_VIEWED_UNAVAILABLE',
  'NO_EVENT_ANALYTICS_SOURCE_CONFIGURED', 'CONNECTOR_CAPABILITY_UNSUPPORTED',
]);
const RAZAO_INSUFFICIENT_DATA = new Set(['insufficient_data', 'LOCAL_ORDERS_HISTORY_STARTS_LATER', 'ORDER_NOT_FOUND']);
const RAZAO_NOT_VERIFIED = new Set(['TRANSACTION_CAPABILITY_CHECK_FAILED']);

function classificarIndisponibilidade(reason) {
  if (!reason) return 'available';
  const r = String(reason);
  if (RAZAO_NOT_CONNECTED.has(r)) return 'not_connected';
  // GA4_<MOTIVO> (connector.js) reusa os mesmos motivos acima com o prefixo do provider — a
  // classificação olha o sufixo, nunca lista cada provider.
  const semPrefixoProvider = r.replace(/^[A-Z0-9]+_/, '');
  if (RAZAO_UNSUPPORTED.has(r) || RAZAO_UNSUPPORTED.has(semPrefixoProvider)) return 'unsupported';
  if (RAZAO_INSUFFICIENT_DATA.has(r)) return 'insufficient_data';
  if (RAZAO_NOT_VERIFIED.has(r)) return 'not_verified';
  return 'temporary_failure'; // falha inesperada/transiente — nunca escondida atrás de "unsupported"
}

/**
 * @param {{pool, registry, productPerformanceService, analyticsProvider, commerceProvider,
 *   localOrdersHistoryStart?: string, maxTransactionSampleSize?: number, commerceTransactionIdPrefix?: string}} deps
 *   `localOrdersHistoryStart`: Rodada L §2.4 — o cache local de pedidos só é confiável a partir
 *   desta data NESTA instalação (LOCAL_ORDERS_HISTORY_START, reconciliation.js, Fase G.1). Injetável
 *   de propósito: não é uma regra global do produto SaaS, é uma característica de cobertura de
 *   sync/backfill de UM tenant/ambiente. O default preserva o comportamento atual (mesma data já
 *   usada pela reconciliação); uma composição futura pode passar um valor por Store, ou derivado de
 *   `sync_estado`/`pedidos_backfill_jobs`, sem mudar este arquivo. Não migrado nesta rodada — sem
 *   evidência de qual seria o valor certo por tenant, migrar seria inventar dado.
 *   `maxTransactionSampleSize`: Rodada L §2.3 — teto de lookups GA4 no relatório agregado.
 *   `commerceTransactionIdPrefix`: Rodada M — achado real de produção (smoke autenticado contra o
 *   GA4 de verdade da Use Sul, cruzado à mão pelo usuário): o `transaction_id` que a Ink manda pro
 *   GA4 no evento `purchase` NÃO é o `providerOrderId` cru — vem como `INK<providerOrderId>` (ex.:
 *   pedido Ink `2010279` chega no GA4 como transação `INK2010279`; confirmado comparando a mesma
 *   compra nos dois sistemas). A comparação de vínculo é sempre exata (nunca fuzzy — §6 do comando),
 *   então sem este prefixo nenhum pedido bateria, mesmo com o rastreamento funcionando perfeitamente
 *   dos dois lados — o gap era de FORMATO, não de dado ausente. Confirmado pelo usuário: é sempre o
 *   mesmo prefixo pra este commerceProvider, nunca varia por loja/período. Injetável (nunca um `if`
 *   comparando `commerceProvider` aqui dentro — decidido em composition.js, por provider) porque é
 *   uma característica do PROVIDER, não do produto — outro Commerce no futuro pode não ter
 *   prefixo nenhum (default `''`).
 */
function createJourneyAnalyticsService({
  pool, registry, productPerformanceService, analyticsProvider, commerceProvider,
  localOrdersHistoryStart = LOCAL_ORDERS_HISTORY_START, maxTransactionSampleSize = MAX_TRANSACTION_SAMPLE_SIZE,
  commerceTransactionIdPrefix = '',
}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createJourneyAnalyticsService exige pool');
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createJourneyAnalyticsService exige registry');
  if (!productPerformanceService || typeof productPerformanceService.getProductPerformanceSummary !== 'function') {
    throw new Error('createJourneyAnalyticsService exige productPerformanceService');
  }
  if (!analyticsProvider) throw new Error('createJourneyAnalyticsService exige analyticsProvider');
  if (!commerceProvider) throw new Error('createJourneyAnalyticsService exige commerceProvider');
  if (!Number.isInteger(maxTransactionSampleSize) || maxTransactionSampleSize < 1) {
    throw new Error('maxTransactionSampleSize deve ser um inteiro >= 1');
  }
  if (typeof commerceTransactionIdPrefix !== 'string') throw new Error('commerceTransactionIdPrefix deve ser string');

  // Único ponto que conhece a regra de formato — nunca espalhado. `pedido.providerOrderId`/
  // `providerOrderId` continuam CRUS em toda outra parte do service (getOrder, exibição na UI,
  // links.providerOrderId na resposta) — só a comparação COM O GA4 usa o id prefixado.
  const transactionIdNoGa4 = (providerOrderId) => `${commerceTransactionIdPrefix}${providerOrderId}`;

  // Tier 1a · funil agregado — reaproveita getProductPerformanceSummary (Fase G/J.4): observed (todo
  // itemId GA4 do período) + matched (só o resolvido a produto canônico), nunca um número novo.
  async function funilAgregado({ organizationId, storeId, startDate, endDate }) {
    try {
      const summary = await productPerformanceService.getProductPerformanceSummary({ organizationId, storeId, analyticsProvider, startDate, endDate });
      const disponivel = summary.coverage.status === 'ok';
      const reason = disponivel ? null : summary.coverage.status;
      return {
        available: disponivel, status: classificarIndisponibilidade(reason), reason,
        observed: summary.observed, matched: summary.matched, coverage: summary.coverage,
      };
    } catch (err) {
      const reason = err.codigo || 'ANALYTICS_UNAVAILABLE';
      return { available: false, status: classificarIndisponibilidade(reason), reason, observed: null, matched: null, coverage: null };
    }
  }

  // Tier 1b · aquisição por canal/campanha (GA4) — checa a capability ao vivo ANTES de tentar
  // (não presume compatibilidade sem evidência); a ausência é reportada, nunca contornada.
  async function aquisicaoPorCanal({ organizationId, storeId, startDate, endDate }) {
    let resolvido;
    try {
      resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
    } catch (err) {
      const reason = err.codigo || 'ANALYTICS_NOT_REGISTERED';
      return { available: false, status: classificarIndisponibilidade(reason), reason, rows: [] };
    }
    if (typeof resolvido.connector.getAcquisitionPerformance !== 'function') {
      return { available: false, status: 'unsupported', reason: 'PROVIDER_WITHOUT_ACQUISITION_CAPABILITY', rows: [] };
    }
    try {
      const rows = await resolvido.connector.getAcquisitionPerformance({ startDate, endDate });
      return { available: true, status: 'available', reason: null, rows };
    } catch (err) {
      const reason = err.codigo || 'ACQUISITION_UNAVAILABLE';
      return { available: false, status: classificarIndisponibilidade(reason), reason, rows: [] };
    }
  }

  // Tier 1c · investimento/conversões REPORTADOS pela Meta Ads (lib/meta/campaign-performance.js —
  // já tenant-scoped por RLS, reaproveita meta_insights_daily sem chamada nova à Graph API). Nunca
  // tratado como prova de pedido individual.
  async function investimentoMeta({ startDate, endDate }) {
    try {
      const resultado = await getCampaignPerformance({ pool, startDate, endDate });
      const reason = resultado.connected ? null : 'META_NOT_CONNECTED';
      return { available: resultado.connected, status: classificarIndisponibilidade(reason), reason, campaigns: resultado.campaigns };
    } catch (err) {
      const reason = err.codigo || 'META_UNAVAILABLE';
      return { available: false, status: classificarIndisponibilidade(reason), reason, campaigns: [] };
    }
  }

  // Tier 1d · pedidos CONFIRMADOS pelo Commerce (isPaid=true) — paginação inteira do período, mesmo
  // padrão de reconciliation.js `agregarCommercePorProduto` (nunca 1 chamada por produto/pedido).
  // `createdAt` é a criação do pedido, não a data de pagamento (`paidAt` nem sempre disponível no
  // cache local — Rodada L §2.4); este service nunca apresenta `createdAt` como "convertido em").
  async function pedidosConfirmados({ organizationId, storeId, startDate, endDate }) {
    let resolvido;
    try {
      resolvido = registry.resolve('commerce', commerceProvider, { organizationId, storeId });
      resolvido.require('orders');
    } catch (err) {
      const reason = err.codigo || 'COMMERCE_NOT_REGISTERED';
      return { available: false, status: classificarIndisponibilidade(reason), reason, orders: [] };
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
      return { available: true, status: 'available', reason: null, orders };
    } catch (err) {
      const reason = err.codigo || 'COMMERCE_UNAVAILABLE';
      return { available: false, status: classificarIndisponibilidade(reason), reason, orders: [] };
    }
  }

  // Checagem de capability de transação — 1x por chamada (nunca por pedido). Compartilhada pelo
  // relatório agregado (amostra) e pelo lookup sob demanda (1 pedido).
  async function capacidadeDeTransacao({ organizationId, storeId }) {
    let resolvido;
    try {
      resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
    } catch (err) {
      const reason = err.codigo || 'ANALYTICS_NOT_REGISTERED';
      return { ok: false, status: classificarIndisponibilidade(reason), reason, resolvido: null };
    }
    if (typeof resolvido.connector.getTransactionCapabilities !== 'function' || typeof resolvido.connector.findTransaction !== 'function') {
      return { ok: false, status: 'unsupported', reason: 'PROVIDER_WITHOUT_TRANSACTION_CAPABILITY', resolvido: null };
    }
    let capacidades;
    try {
      capacidades = await resolvido.connector.getTransactionCapabilities();
    } catch (err) {
      const reason = err.codigo || 'TRANSACTION_CAPABILITY_CHECK_FAILED';
      return { ok: false, status: classificarIndisponibilidade(reason), reason, resolvido: null };
    }
    if (!capacidades.apt) {
      const reason = capacidades.reason || 'TRANSACTION_ID_UNAVAILABLE';
      return { ok: false, status: classificarIndisponibilidade(reason), reason, resolvido: null };
    }
    return { ok: true, status: 'available', reason: null, resolvido };
  }

  // Tier 2 (relatório agregado) · verifica só uma AMOSTRA limitada de pedidos pagos — nunca todos
  // (Rodada L §2.3: 1 chamada GA4 por pedido sem teto é exatamente o N+1 que uma rota aberta ou uma
  // paginação de tabela não pode pagar). `sampled`/`sampleSize`/`totalEligible` deixam explícito que
  // isto é uma amostra, nunca a cobertura completa dos pedidos do período.
  async function correlacaoTransacaoPedido({ organizationId, storeId, startDate, endDate }, orders) {
    const cap = await capacidadeDeTransacao({ organizationId, storeId });
    if (!cap.ok) return { available: false, status: cap.status, reason: cap.reason, checked: 0, linked: 0, links: [], sampled: false, sampleSize: 0, totalEligible: orders.length };

    const amostra = orders.slice(0, maxTransactionSampleSize);
    const links = [];
    for (const pedido of amostra) {
      // eslint-disable-next-line no-await-in-loop
      const resultado = await cap.resolvido.connector.findTransaction({ startDate, endDate, transactionId: transactionIdNoGa4(pedido.providerOrderId) });
      links.push({
        commerceOrderId: pedido.id, providerOrderId: pedido.providerOrderId,
        linked: resultado.found, linkType: 'transaction_linked', ga4Transactions: resultado.transactions, ga4Revenue: resultado.revenue,
      });
    }
    return {
      available: true, status: 'available', reason: null,
      checked: links.length, linked: links.filter((l) => l.linked).length, links,
      sampled: orders.length > amostra.length, sampleSize: amostra.length, totalEligible: orders.length,
    };
  }

  /**
   * Verificação SOB DEMANDA de 1 pedido específico — o caminho que a UI usa quando o usuário
   * seleciona um pedido na tabela (nunca a carga inicial da página). 1 chamada ao Commerce
   * (`getOrder`) + 1 chamada ao GA4 (`findTransaction`), nunca mais.
   * @param {{organizationId, storeId, startDate, endDate, providerOrderId}} entrada
   */
  async function checkOrderTransactionLink({ organizationId, storeId, startDate, endDate, providerOrderId }) {
    validarEntrada({ organizationId, storeId, startDate, endDate });
    if (!providerOrderId) throw new TypeError('checkOrderTransactionLink exige providerOrderId');

    let resolvidoCommerce;
    try {
      resolvidoCommerce = registry.resolve('commerce', commerceProvider, { organizationId, storeId });
      resolvidoCommerce.require('orders');
    } catch (err) {
      const reason = err.codigo || 'COMMERCE_NOT_REGISTERED';
      return { available: false, status: classificarIndisponibilidade(reason), reason, order: null, linked: null };
    }
    let pedido;
    try {
      pedido = typeof resolvidoCommerce.connector.getOrder === 'function'
        ? await resolvidoCommerce.connector.getOrder({ providerOrderId })
        : null;
    } catch (err) {
      const reason = err.codigo || 'COMMERCE_UNAVAILABLE';
      return { available: false, status: classificarIndisponibilidade(reason), reason, order: null, linked: null };
    }
    if (!pedido) return { available: false, status: 'insufficient_data', reason: 'ORDER_NOT_FOUND', order: null, linked: null };

    const cap = await capacidadeDeTransacao({ organizationId, storeId });
    if (!cap.ok) return { available: false, status: cap.status, reason: cap.reason, order: pedido, linked: null };

    const resultado = await cap.resolvido.connector.findTransaction({ startDate, endDate, transactionId: transactionIdNoGa4(providerOrderId) });
    return {
      available: true, status: 'available', reason: null, order: pedido,
      linked: resultado.found, linkType: 'transaction_linked', ga4Transactions: resultado.transactions, ga4Revenue: resultado.revenue,
    };
  }

  // Tier 3 · jornada individual — reservado. `registry.providersOf('event_analytics')` é a fonte da
  // verdade (nunca um nome de provider fixo aqui): hoje nenhuma composição registra nada nesse
  // domain, então a lista vem sempre vazia — "ainda não existe fonte", nunca erro. Registrar um
  // provider real (`aggregatedProductEvents`, sem `eventLevel`) NÃO liga jornada individual sozinho —
  // ainda fica `unavailable`, porque agregado por evento não é o mesmo que evidência por cliente.
  async function jornadaIndividual({ organizationId, storeId }) {
    const providers = registry.providersOf('event_analytics');
    if (!providers.length) return { available: false, status: 'not_connected', reason: 'NO_EVENT_ANALYTICS_SOURCE_CONFIGURED', provider: null };
    // Mais de um provider registrado: cada um seria consultado por quem precisar do detalhe — aqui
    // só reporta o primeiro com fonte disponível, nunca escolhe um "vencedor" por conta própria.
    for (const provider of providers) {
      let resolvido;
      try {
        resolvido = registry.resolve('event_analytics', provider, { organizationId, storeId });
      } catch (err) {
        continue; // este provider específico falhou (ex.: sem integração conectada) — tenta o próximo
      }
      const eventLevel = resolvido.supports('eventLevel');
      // §2.2: só event-level real conta como "disponível" para jornada individual — agregado por
      // evento sozinho fica `unavailable` (nunca `partial`/`complete` sem identificador por cliente).
      if (!eventLevel) return { available: false, status: 'unsupported', reason: 'EVENT_ANALYTICS_AGGREGATED_ONLY', provider, eventLevel: false };
      return { available: true, status: 'available', reason: null, provider, eventLevel: true };
    }
    return { available: false, status: 'not_connected', reason: 'EVENT_ANALYTICS_UNAVAILABLE', provider: providers[0] };
  }

  /**
   * @param {{organizationId, storeId, startDate, endDate}} entrada
   */
  async function getJourneyAnalytics(entrada) {
    validarEntrada(entrada);
    const { startDate, endDate } = entrada;

    // Mesmo gate de reconciliation.js (agora injetável — §2.4): sem histórico local confiável antes
    // desta data, tier2/tier1d comparariam contra pedidos que sabidamente não existem no cache (não
    // é "zero pedidos reais").
    if (String(startDate) < localOrdersHistoryStart) {
      return Object.freeze({
        period: { startDate, endDate },
        status: 'insufficient_data',
        reason: 'LOCAL_ORDERS_HISTORY_STARTS_LATER',
        historyStartsAt: localOrdersHistoryStart,
      });
    }

    const [funil, aquisicao, meta, commerce] = await Promise.all([
      funilAgregado(entrada), aquisicaoPorCanal(entrada), investimentoMeta(entrada), pedidosConfirmados(entrada),
    ]);
    // Commerce indisponível: tier2 herda o MESMO status/reason que tier1.confirmedOrders já
    // classificou corretamente (ex.: not_connected quando é INTEGRATION_NOT_CONNECTED) — achado real
    // do smoke visual (Rodada L): um `reason` genérico aqui caía em `temporary_failure` por padrão,
    // mostrando "falha temporária" pra um estado normal de "nunca conectado".
    const tier2 = commerce.available
      ? await correlacaoTransacaoPedido(entrada, commerce.orders)
      : { available: false, status: commerce.status, reason: commerce.reason, checked: 0, linked: 0, links: [], sampled: false, sampleSize: 0, totalEligible: 0 };
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
        confirmedOrders: Object.freeze({ available: commerce.available, status: commerce.status, reason: commerce.reason, count: commerceCount, revenue: commerceRevenue }),
      }),
      tier2: Object.freeze({ transactionOrderLink: Object.freeze(tier2) }),
      tier3: Object.freeze({ individualJourney: Object.freeze(tier3) }),
      // Três fontes, NUNCA somadas entre si — cada uma mede uma coisa diferente: Commerce é a venda
      // operacional CONFIRMADA; Meta Ads é o que a PLATAFORMA reporta como atribuído (janela/modelo
      // próprios dela); GA4 é o comportamento OBSERVADO e agregado por item (nunca por pedido).
      // Divergência entre elas é diagnóstico, nunca "erro" de nenhuma das três.
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

  return Object.freeze({ getJourneyAnalytics, checkOrderTransactionLink });
}

module.exports = { createJourneyAnalyticsService, MAX_TRANSACTION_SAMPLE_SIZE, classificarIndisponibilidade };
