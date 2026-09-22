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

/**
 * @param {{registry, productPerformanceService}} deps
 */
function createReconciliationService({ registry, productPerformanceService }) {
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createReconciliationService exige registry');
  if (!productPerformanceService || typeof productPerformanceService.getProductPerformance !== 'function') {
    throw new Error('createReconciliationService exige productPerformanceService');
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

  // Pagina o ProductPerformanceService inteiro pro mesmo escopo (nunca duplica a chamada de
  // analytics — o ReportCache da Fase G/G.1 já garante isso entre páginas do mesmo período).
  async function agregarAnalyticsCompleto(entrada) {
    const items = [];
    let cursor = null;
    let coverage = null;
    do {
      // eslint-disable-next-line no-await-in-loop
      const pagina = await productPerformanceService.getProductPerformance({ ...entrada, pagination: { limit: 200, cursor } });
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
    const { organizationId, storeId, commerceProvider, analyticsProvider, startDate, endDate, filters = {}, divergenceTolerance = 0.1 } = entrada;

    if (String(startDate) < LOCAL_ORDERS_HISTORY_START) {
      return Object.freeze({
        status: 'insufficient_data',
        reason: 'LOCAL_ORDERS_HISTORY_STARTS_LATER',
        historyStartsAt: LOCAL_ORDERS_HISTORY_START,
        items: [],
        caveats: CAVEATS,
      });
    }

    const resolvidoCommerce = registry.resolve('commerce', commerceProvider, { organizationId, storeId });
    resolvidoCommerce.require('orders');

    const [commercePorProduto, analyticsCompleto] = await Promise.all([
      agregarCommercePorProduto({ connector: resolvidoCommerce.connector, startDate, endDate }),
      agregarAnalyticsCompleto({ organizationId, storeId, analyticsProvider, startDate, endDate, filters }),
    ]);

    const items = analyticsCompleto.items.map((linha) => {
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
    });

    return Object.freeze({
      status: 'ok',
      items,
      coverage: analyticsCompleto.coverage,
      caveats: CAVEATS,
    });
  }

  return Object.freeze({ reconcileProductPerformance });
}

module.exports = { createReconciliationService, LOCAL_ORDERS_HISTORY_START, CAVEATS };
