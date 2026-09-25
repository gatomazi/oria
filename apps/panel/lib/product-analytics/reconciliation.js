'use strict';

// Etapa 3 (rodada G.1/Orders/Reconciliação) · compara o que o Analytics OBSERVOU
// (ProductPerformanceService — Fase G) com o que o Commerce CONFIRMOU (CommerceConnector.listOrders
// — Etapa 2), por produto canônico. Provider-agnostic dos dois lados: nunca compara literal de
// status ('paid', 'pago', …) de nenhum provider — usa só `CommerceOrder.isPaid` (normalizado pelo
// adapter, ver lib/connectors/types.js) para decidir o que é "venda confirmada".
//
// Unidades SEMPRE equivalentes (§ rodada): `itemsPurchased` (Analytics, contagem de ITEM) compara
// com unidades vendidas (Commerce, soma de `item.quantity` dos pedidos pagos) — NUNCA com
// quantidade de PEDIDOS (um pedido pode ter várias unidades do mesmo produto). `itemRevenue` nunca
// é comparado sem o caveat explícito abaixo (reembolso itemizado e rateio de desconto não estão no
// cache local — ver orders-repository.js/mapper.js).
//
// Divergência é DIAGNÓSTICO, nunca erro: a função nunca lança por causa de um número diferente do
// esperado — só por entrada inválida. Quando a identidade ou a cobertura são insuficientes, devolve
// estado explícito (`insufficient_identity`/`insufficient_data`) em vez de uma diferença que
// pareceria precisa e não é.

const { CAMPO_MAIS_DADOS } = require('./performance-filters');

const CAVEATS = Object.freeze([
  'itemRevenue (Analytics) e commerceItemRevenue (Commerce) não são diretamente comparáveis sem ajuste: '
    + 'o Commerce não tem reembolso itemizado nem rateio de desconto por item no cache local usado aqui '
    + '(ver isRefunded no pedido — é um sinal de estado, não um valor a descontar).',
  'createdAt do pedido (Commerce) é a criação do pedido, não a data de pagamento nem a data do evento '
    + 'de Analytics — divergência perto das bordas do período pode ser só isso, não um erro de dado.',
  'Fuso horário: o período é comparado como data pura (YYYY-MM-DD) nos dois lados; um pedido/evento '
    + 'perto da meia-noite pode cair num dia diferente em cada lado dependendo do fuso de cada provider.',
  'Atraso de sincronização: o cache local de pedidos e o relatório de Analytics podem estar '
    + 'defasados um em relação ao outro por minutos a horas — um período muito recente tende a '
    + 'divergir mais só por isso, não por um problema real de dado.',
]);

// §5 do comando: histórico local de pedidos só é confiável a partir desta data — período que
// começa antes disso não tem cobertura suficiente pra reconciliar (a ausência de pedido confirmado
// pareceria "toda venda observada pelo Analytics é suspeita", o que seria enganoso).
const LOCAL_ORDERS_HISTORY_START = '2026-08-19';

// Heurística de partida documentada (não uma precisão real) — exportada pra opportunity-
// diagnostics.js reusar a MESMA tolerância no sinal `units_divergent_ga4_commerce`, nunca uma
// segunda constante que pudesse divergir de GET /reconciliation.
const DIVERGENCE_TOLERANCE_PADRAO = 0.1;

function validarEntrada({ organizationId, storeId, commerceProvider, analyticsProvider, startDate, endDate }) {
  if (!organizationId || !storeId) throw new TypeError('organizationId e storeId são obrigatórios');
  if (!commerceProvider) throw new TypeError('commerceProvider é obrigatório');
  if (!analyticsProvider) throw new TypeError('analyticsProvider é obrigatório');
  if (!startDate || !endDate) throw new TypeError('startDate e endDate são obrigatórios (ISO puro)');
  if (String(startDate) > String(endDate)) throw new TypeError('startDate deve ser <= endDate');
}

function classificarDivergencia(analyticsUnits, commerceUnits, tolerancia) {
  if (analyticsUnits === null) return 'insufficient_data'; // itemsPurchased indisponível na propriedade
  const base = Math.max(analyticsUnits, commerceUnits, 1); // evita dividir por zero quando os dois são 0
  const delta = analyticsUnits - commerceUnits;
  const deltaRate = Math.abs(delta) / base;
  return deltaRate <= tolerancia ? 'aligned' : 'divergent';
}

// Uma linha da reconciliação a partir da linha de desempenho do produto (Analytics) e do que o
// Commerce confirmou. Compartilhada pelo caminho "catálogo inteiro" e pelo paginado — a semântica
// (status, diagnósticos) é UMA só.
function linhaDeReconciliacao(linha, commercePorProduto, divergenceTolerance) {
  const diagnostics = [];
  // Duas causas diferentes, as DUAS com identity.status 'unmatched' na Fase G — precisam ficar
  // separadas aqui (§ rodada: "se a identidade ou a cobertura forem insuficientes, devolva
  // estado explícito"): período INTEIRO sem nenhuma linha de analytics (`insufficient_data`,
  // linhaSemAnalytics) não é o mesmo problema que ESTE produto não ter identity resolvida
  // (`unmatched_identity`, montarLinha) com o resto do período coberto normalmente.
  if (linha.diagnostics.includes('insufficient_data')) {
    diagnostics.push('no_analytics_data_in_period');
    return Object.freeze({
      product: linha.product, analyticsUnits: null, commerceUnits: null, analyticsRevenue: null, commerceRevenue: null,
      paidOrdersDistinct: 0, status: 'insufficient_data', diagnostics: Object.freeze(diagnostics),
    });
  }
  if (linha.identity.status === 'unmatched') {
    diagnostics.push('insufficient_identity');
    return Object.freeze({
      product: linha.product, analyticsUnits: null, commerceUnits: null, analyticsRevenue: null, commerceRevenue: null,
      paidOrdersDistinct: 0, status: 'insufficient_identity', diagnostics: Object.freeze(diagnostics),
    });
  }
  const commerce = commercePorProduto.get(linha.product.id) || { unitsSold: 0, itemRevenue: 0, paidOrders: new Set() };
  const analyticsUnits = linha.metrics ? linha.metrics.itemsPurchased : null;
  const status = classificarDivergencia(analyticsUnits, commerce.unitsSold, divergenceTolerance);
  if (status === 'insufficient_data') diagnostics.push('metric_unavailable');
  if (status === 'divergent') diagnostics.push('units_divergent');
  return Object.freeze({
    product: linha.product,
    analyticsUnits,
    commerceUnits: commerce.unitsSold,
    analyticsRevenue: linha.metrics ? linha.metrics.itemRevenue : null,
    commerceRevenue: commerce.itemRevenue,
    paidOrdersDistinct: commerce.paidOrders.size,
    status,
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * @param {{registry, productPerformanceService}} deps
 */
function createReconciliationService({ registry, productPerformanceService }) {
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createReconciliationService exige registry');
  if (!productPerformanceService || typeof productPerformanceService.getProductPerformance !== 'function'
    || typeof productPerformanceService.prepareStoreAnalytics !== 'function') {
    throw new Error('createReconciliationService exige productPerformanceService (getProductPerformance + prepareStoreAnalytics)');
  }

  // Pagina o CommerceConnector inteiro (nunca 1 chamada por produto) e agrega por commerceProductId
  // — só pedidos com isPaid=true entram na soma; nenhum literal de status de nenhum provider aqui.
  async function agregarCommercePorProduto({ connector, startDate, endDate }) {
    const porProduto = new Map(); // commerceProductId -> { unitsSold, itemRevenue, paidOrders: Set }
    let cursor = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const pagina = await connector.listOrders({ startDate, endDate, cursor, limit: 200 });
      for (const pedido of pagina.items) {
        if (!pedido.isPaid) continue;
        for (const item of pedido.items) {
          if (!item.commerceProductId) continue; // sem produto canônico resolvido — não entra na soma (não é 0 nem inventado)
          if (!porProduto.has(item.commerceProductId)) porProduto.set(item.commerceProductId, { unitsSold: 0, itemRevenue: 0, paidOrders: new Set() });
          const acc = porProduto.get(item.commerceProductId);
          acc.unitsSold += item.quantity;
          acc.itemRevenue += item.totalValue;
          acc.paidOrders.add(pedido.id);
        }
      }
      cursor = pagina.nextCursor;
    } while (cursor);
    return porProduto;
  }

  // Rodada "corrigir o gargalo real" (Gate 1.4) · o lado COMMERCE da reconciliação, extraído pra
  // ser reaproveitável por quem não precisa do contrato HTTP inteiro de `reconcileProductPerformance`
  // (que varre o catálogo inteiro pra montar `items` — o formato que GET /reconciliation expõe).
  // `opportunity-diagnostics.js` usa isto direto: só as unidades/receita por produto, sem pagar o
  // custo de materializar o catálogo inteiro só pra achar 5 oportunidades. Mesmo gate de histórico
  // e mesma resolução de connector que `reconcileProductPerformance` sempre teve — nunca um segundo
  // caminho com regras diferentes.
  //
  // @returns {Promise<{status: 'ok'|'insufficient_data', reason?, historyStartsAt?, porProduto?: Map, caveats: string[]}>}
  async function getCommerceUnitsAggregation({ organizationId, storeId, commerceProvider, startDate, endDate }) {
    if (!organizationId || !storeId) throw new TypeError('organizationId e storeId são obrigatórios');
    if (!commerceProvider) throw new TypeError('commerceProvider é obrigatório');
    if (!startDate || !endDate) throw new TypeError('startDate e endDate são obrigatórios (ISO puro)');
    if (String(startDate) > String(endDate)) throw new TypeError('startDate deve ser <= endDate');

    if (String(startDate) < LOCAL_ORDERS_HISTORY_START) {
      return { status: 'insufficient_data', reason: 'LOCAL_ORDERS_HISTORY_STARTS_LATER', historyStartsAt: LOCAL_ORDERS_HISTORY_START, caveats: CAVEATS };
    }
    const resolvidoCommerce = registry.resolve('commerce', commerceProvider, { organizationId, storeId });
    resolvidoCommerce.require('orders');
    const porProduto = await agregarCommercePorProduto({ connector: resolvidoCommerce.connector, startDate, endDate });
    return { status: 'ok', porProduto, caveats: CAVEATS };
  }

  // Pagina o ProductPerformanceService inteiro pro mesmo escopo. Rodada "corrigir o gargalo real":
  // a agregação de analytics (relatório + resolução de identity + soma por produto) é computada
  // UMA VEZ aqui (`prepareStoreAnalytics`) e reaproveitada em TODAS as páginas do catálogo — antes,
  // cada uma das ~425 páginas refazia a resolução do conjunto INTEIRO de itemIds observados
  // (O(páginas × itemIds) — o gargalo real medido em produção: >23min sem terminar com 85 mil
  // produtos/20 mil itemIds). Agora é O(itemIds) uma vez + O(páginas) só pra paginar o catálogo em
  // si (leitura barata, sem identity nenhuma por dentro).
  async function agregarAnalyticsCompleto(entrada) {
    const aggregation = await productPerformanceService.prepareStoreAnalytics(entrada);
    const items = [];
    let cursor = null;
    let coverage = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const pagina = await productPerformanceService.getProductPerformance({ ...entrada, aggregation, pagination: { limit: 200, cursor } });
      items.push(...pagina.items);
      coverage = pagina.coverage;
      cursor = pagina.nextCursor;
    } while (cursor);
    return { items, coverage };
  }

  /**
   * @param {{organizationId, storeId, commerceProvider, analyticsProvider, startDate, endDate, filters?, divergenceTolerance?}} entrada
   *   `divergenceTolerance`: fração (0.1 = 10%) — heurística de partida documentada, não uma
   *   precisão real; existe pra não obrigar quem lê a fazer a própria conta pra casos óbvios.
   */
  async function reconcileProductPerformance(entrada) {
    validarEntrada(entrada);
    const { organizationId, storeId, commerceProvider, analyticsProvider, startDate, endDate, filters = {}, divergenceTolerance = DIVERGENCE_TOLERANCE_PADRAO } = entrada;

    if (String(startDate) < LOCAL_ORDERS_HISTORY_START) {
      return Object.freeze({
        status: 'insufficient_data',
        reason: 'LOCAL_ORDERS_HISTORY_STARTS_LATER',
        historyStartsAt: LOCAL_ORDERS_HISTORY_START,
        items: [],
        caveats: CAVEATS,
      });
    }

    // Caminho PAGINADO (é o da rota HTTP): nunca materializa o catálogo inteiro. Só a página pedida
    // vira linha — ranqueada por volume (unidades observadas no Analytics + unidades vendidas no
    // Commerce, então quem vendeu mas o GA4 nunca viu não cai no fim da fila), e o resto do catálogo
    // vem depois por nome. É a mesma mecânica de "mais dados primeiro" da Visão Geral.
    if (entrada.pagination) {
      const [comercioPagina, aggregation] = await Promise.all([
        getCommerceUnitsAggregation({ organizationId, storeId, commerceProvider, startDate, endDate }),
        productPerformanceService.prepareStoreAnalytics({ organizationId, storeId, analyticsProvider, startDate, endDate }),
      ]);
      const unidadesVendidas = new Map([...comercioPagina.porProduto].map(([id, v]) => [id, v.unitsSold]));
      const pagina = await productPerformanceService.getProductPerformance({
        organizationId, storeId, analyticsProvider, startDate, endDate, filters,
        aggregation, sort: { field: CAMPO_MAIS_DADOS, direction: 'desc' }, rankingExtra: unidadesVendidas, pagination: entrada.pagination,
      });
      return Object.freeze({
        status: 'ok',
        items: pagina.items.map((linha) => linhaDeReconciliacao(linha, comercioPagina.porProduto, divergenceTolerance)),
        nextCursor: pagina.nextCursor,
        totalCount: pagina.totalCount,
        coverage: pagina.coverage,
        caveats: CAVEATS,
      });
    }

    const [comercio, analyticsCompleto] = await Promise.all([
      getCommerceUnitsAggregation({ organizationId, storeId, commerceProvider, startDate, endDate }),
      agregarAnalyticsCompleto({ organizationId, storeId, analyticsProvider, startDate, endDate, filters }),
    ]);
    const commercePorProduto = comercio.porProduto;

    const items = analyticsCompleto.items.map((linha) => linhaDeReconciliacao(linha, commercePorProduto, divergenceTolerance));

    return Object.freeze({
      status: 'ok',
      items,
      coverage: analyticsCompleto.coverage,
      caveats: CAVEATS,
    });
  }

  return Object.freeze({ reconcileProductPerformance, getCommerceUnitsAggregation });
}

module.exports = { createReconciliationService, LOCAL_ORDERS_HISTORY_START, CAVEATS, classificarDivergencia, DIVERGENCE_TOLERANCE_PADRAO };
