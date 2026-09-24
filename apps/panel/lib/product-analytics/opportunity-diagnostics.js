'use strict';

// Rodada "Jornada de Valor" · Gate C — Opportunity Diagnostics.
//
// Camada determinística, provider-agnostic, SEM IA e sem classificação mágica: consome os serviços
// que já existem (ProductPerformanceService — Fase G/G.1, ReconciliationService — Etapa 3) e produz
// uma lista curta e ORDENADA de sinais que merecem investigação, com evidência numérica, hipótese
// (nunca causa comprovada), ação sugerida e CTA pra uma tela real. NUNCA um segundo motor de
// jornada: nenhuma chamada nova ao GA4/Ink/Meta além das que os dois services acima já fazem (o
// ReportCache de 15min deles é reaproveitado de graça — ver product-performance-service.js).
//
// Vocabulário do comando (§3.2): esta camada só produz `hypothesis` (explicação possível, com ação
// de verificação) fundamentada em `observed`/`linked` — nunca `hypothesis` apresentada como fato, e
// nunca um diagnóstico sem volume mínimo (`insufficient_data` em vez de "oportunidade" fabricada).
//
// Cinco sinais nesta rodada (a tabela do comando tem seis; o sexto — gasto Meta por CAMPANHA vs.
// resultado — fica de fora: o reader atual (lib/meta/campaign-performance.js, usado por
// journeyAnalyticsService) só dá o agregado da Store no período, não por campanha individual o
// bastante pra apontar UMA campanha com sinal; forçar isso aqui seria inventar granularidade que a
// fonte não tem — ver relatório da rodada):
//
//   1. low_view_to_cart            — itemsAddedToCartPerItemViewed abaixo do baseline da Store
//   2. low_cart_to_checkout        — itemsCheckedOutPerItemAddedToCart abaixo do baseline da Store
//   3. low_checkout_to_purchase    — itemsPurchasedPerItemCheckedOut abaixo do baseline da Store
//   4. units_divergent_ga4_commerce — ReconciliationService marcou 'divergent' com volume relevante
//   5. identity_coverage_low       — muitos itemId GA4 observados sem produto canônico resolvido
//
// Baseline: mediana da Store entre produtos com volume >= amostra mínima do PRÓPRIO sinal (nunca um
// limiar universal fixo — §4.2). Prioridade: volume × desvio × confiabilidade da amostra (fórmula
// documentada abaixo, nunca "receita perdida" nem previsão).

const { classificarIndisponibilidade } = require('./journey-analytics-service');

// Amostra mínima por sinal — configurável por chamada (`minSamples`), nunca um valor universal
// promovido a verdade fixa; estes são só o default operacional documentado (§4.2 pede "mínimo de
// amostra configurável").
const MIN_SAMPLES_PADRAO = Object.freeze({
  viewToCart: 30, // itemsViewed mínimos pro produto entrar na comparação de add-to-cart
  cartToCheckout: 10, // itemsAddedToCart mínimos
  checkoutToPurchase: 5, // itemsCheckedOut mínimos
  commerceUnits: 3, // unidades pagas mínimas pra um "divergente" não ser ruído de 1 pedido
  observedIdsCoverage: 20, // itemIds GA4 observados mínimos pra cobertura ruim virar sinal
});
const DESVIO_MINIMO_PADRAO = 0.3; // 30% abaixo do baseline — heurística de partida, documentada, não "a" verdade
const COBERTURA_MINIMA_PADRAO = 0.7; // abaixo disso, "identidade incompleta" vira sinal
const LIMITE_PADRAO = 5; // "Prioridades de hoje" é curto de propósito (§0/§5.2) — nunca 5 tabelas técnicas

function validarEntrada({ organizationId, storeId, startDate, endDate }) {
  if (!organizationId || !storeId) throw new TypeError('organizationId e storeId são obrigatórios');
  if (!startDate || !endDate) throw new TypeError('startDate e endDate são obrigatórios (ISO puro)');
  if (String(startDate) > String(endDate)) throw new TypeError('startDate deve ser <= endDate');
}

// Divisão nula-segura — mesma disciplina de `taxa()` em product-performance-service.js (não
// reexportada de lá: é matemática de 2 linhas, duplicar é mais barato que acoplar num helper interno
// de outro módulo só por isso).
function taxaSegura(numerador, denominador) {
  if (numerador === null || numerador === undefined || denominador === null || !(denominador > 0)) return null;
  return numerador / denominador;
}

function mediana(valores) {
  if (!valores.length) return null;
  const ordenado = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(ordenado.length / 2);
  return ordenado.length % 2 ? ordenado[meio] : (ordenado[meio - 1] + ordenado[meio]) / 2;
}

// Confiabilidade da amostra: 0 no limiar mínimo, 1 a partir de 3x o mínimo — nunca binário
// (§4.2 "volume × desvio × confiabilidade da cobertura"). Documentado aqui porque é a ÚNICA fórmula
// de prioridade deste módulo; qualquer ajuste de peso deve mudar só esta função.
function confiabilidade(volume, minimo) {
  if (!(minimo > 0)) return 1;
  return Math.max(0, Math.min(1, (volume - minimo) / (minimo * 2)));
}

// ── Full-store pagination do ProductPerformanceService (mesmo padrão de reconciliation.js
// `agregarAnalyticsCompleto` — nunca uma chamada de analytics por página: o ReportCache faz o
// relatório ser 1 chamada real ao provider, reusada por todas as páginas deste loop). Duplicado
// aqui (em vez de importado de reconciliation.js, que não exporta a função) de propósito: acoplar
// dois módulos por uma função privada de 8 linhas custaria mais do que os repetir. ──
async function paginarDesempenhoCompleto(productPerformanceService, entrada) {
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

// ── Geradores de sinal — cada um só recebe o que precisa, cada um só emite candidatos com volume
// mínimo E desvio mínimo (nunca "toda diferença é oportunidade"). ──

function gerarSinalDeRazao({ items, campo, denominadorCampo, tipo, minimo, desvioMinimo, hipotese, acao }) {
  // Baseline: mediana da Store entre produtos com volume suficiente NESTE sinal — nunca todo o
  // catálogo (um produto com 2 visualizações não deveria puxar o baseline de quem tem 3000).
  const elegiveis = items.filter((it) => it.metrics && it.metrics[denominadorCampo] !== null && it.metrics[denominadorCampo] >= minimo);
  const razoes = elegiveis.map((it) => it.itemRatios[campo]).filter((r) => r !== null && r !== undefined);
  const baseline = mediana(razoes);
  if (baseline === null || !(baseline > 0)) return [];

  const candidatos = [];
  for (const it of elegiveis) {
    const razao = it.itemRatios[campo];
    if (razao === null || razao === undefined) continue;
    const volume = it.metrics[denominadorCampo];
    const desvio = (baseline - razao) / baseline;
    if (desvio < desvioMinimo) continue; // só "abaixo" do baseline interessa aqui — acima não é problema
    candidatos.push({
      type: tipo,
      scope: 'product',
      product: it.product,
      evidence: {
        [denominadorCampo]: volume,
        [campo]: Number(razao.toFixed(4)),
        storeBaseline: Number(baseline.toFixed(4)),
        deviation: Number(desvio.toFixed(4)),
        sampleMinimum: minimo,
      },
      hypothesis: hipotese,
      suggestedAction: acao,
      confidence: confiabilidade(volume, minimo) >= 0.66 ? 'alta' : confiabilidade(volume, minimo) >= 0.33 ? 'media' : 'baixa',
      score: volume * desvio * (0.4 + 0.6 * confiabilidade(volume, minimo)), // confiabilidade nunca zera o score: mesmo no limiar mínimo já é candidato real
    });
  }
  return candidatos;
}

function gerarSinalDeCheckoutParaCompra({ items, minimo, desvioMinimo, hipotese, acao }) {
  // itemsPurchasedPerItemCheckedOut não existe em CAMPOS_RATIO (product-performance-service.js só
  // tem a razão contra itemsViewed) — calculado aqui, localmente, a partir de métricas JÁ trazidas
  // pelo service (nunca um campo novo pedido ao provider).
  const elegiveis = items.filter((it) => it.metrics && it.metrics.itemsCheckedOut !== null && it.metrics.itemsCheckedOut >= minimo);
  const comRazao = elegiveis.map((it) => ({ it, razao: taxaSegura(it.metrics.itemsPurchased, it.metrics.itemsCheckedOut) })).filter((x) => x.razao !== null);
  const baseline = mediana(comRazao.map((x) => x.razao));
  if (baseline === null || !(baseline > 0)) return [];

  const candidatos = [];
  for (const { it, razao } of comRazao) {
    const volume = it.metrics.itemsCheckedOut;
    const desvio = (baseline - razao) / baseline;
    if (desvio < desvioMinimo) continue;
    candidatos.push({
      type: 'low_checkout_to_purchase',
      scope: 'product',
      product: it.product,
      evidence: {
        itemsCheckedOut: volume, itemsPurchased: it.metrics.itemsPurchased,
        itemsPurchasedPerItemCheckedOut: Number(razao.toFixed(4)), storeBaseline: Number(baseline.toFixed(4)),
        deviation: Number(desvio.toFixed(4)), sampleMinimum: minimo,
      },
      hypothesis: hipotese,
      suggestedAction: acao,
      confidence: confiabilidade(volume, minimo) >= 0.66 ? 'alta' : confiabilidade(volume, minimo) >= 0.33 ? 'media' : 'baixa',
      score: volume * desvio * (0.4 + 0.6 * confiabilidade(volume, minimo)),
    });
  }
  return candidatos;
}

function gerarSinalDeDivergencia({ reconciliation, minimo }) {
  if (!reconciliation || reconciliation.status !== 'ok') return [];
  const candidatos = [];
  for (const item of reconciliation.items) {
    if (item.status !== 'divergent') continue;
    if (item.commerceUnits === null || item.commerceUnits < minimo) continue; // ruído de 1-2 pedidos não é sinal
    const base = Math.max(item.analyticsUnits, item.commerceUnits, 1);
    const deltaRate = Math.abs(item.analyticsUnits - item.commerceUnits) / base;
    candidatos.push({
      type: 'units_divergent_ga4_commerce',
      scope: 'product',
      product: item.product,
      evidence: {
        analyticsUnits: item.analyticsUnits, commerceUnits: item.commerceUnits,
        paidOrdersDistinct: item.paidOrdersDistinct, deviation: Number(deltaRate.toFixed(4)),
      },
      hypothesis: 'Pode existir divergência operacional ou de tracking entre o que o GA4 observou como compra e o que o Commerce confirmou como pago.',
      suggestedAction: 'Conferir IDs de transação, datas (createdAt vs. paidAt), estornos e possível duplicação de evento de purchase.',
      confidence: item.commerceUnits >= minimo * 3 ? 'alta' : item.commerceUnits >= minimo * 2 ? 'media' : 'baixa',
      score: item.commerceUnits * deltaRate,
    });
  }
  return candidatos;
}

function gerarSinalDeCoberturaBaixa({ coverage, minimoObservados, coberturaMinima }) {
  if (!coverage || coverage.status !== 'ok') return [];
  if (coverage.observedAnalyticsIds < minimoObservados) return [];
  if (coverage.coverageRate === null || coverage.coverageRate >= coberturaMinima) return [];
  return [{
    type: 'identity_coverage_low',
    scope: 'store',
    product: null,
    evidence: {
      observedAnalyticsIds: coverage.observedAnalyticsIds,
      matchedAnalyticsIds: coverage.matchedAnalyticsIds,
      unmatchedAnalyticsIds: coverage.unmatchedAnalyticsIds,
      coverageRate: Number(coverage.coverageRate.toFixed(4)),
      coverageMinimum: coberturaMinima,
    },
    hypothesis: 'Uma parte relevante do que o GA4 observou não tem produto canônico correspondente — decisões por produto ficam incompletas para esses itens.',
    suggestedAction: 'Conferir se o catálogo (commerce_products) está sincronizado e revisar a identidade dos itemIds sem match.',
    confidence: coverage.coverageRate < coberturaMinima / 2 ? 'alta' : 'media',
    score: coverage.unmatchedAnalyticsIds,
  }];
}

/**
 * @param {{productPerformanceService, reconciliationService, analyticsProvider: string, commerceProvider: string}} deps
 */
function createOpportunityDiagnosticsService({ productPerformanceService, reconciliationService, analyticsProvider, commerceProvider }) {
  if (!productPerformanceService || typeof productPerformanceService.getProductPerformance !== 'function') {
    throw new Error('createOpportunityDiagnosticsService exige productPerformanceService');
  }
  if (!reconciliationService || typeof reconciliationService.reconcileProductPerformance !== 'function') {
    throw new Error('createOpportunityDiagnosticsService exige reconciliationService');
  }
  if (!analyticsProvider) throw new Error('createOpportunityDiagnosticsService exige analyticsProvider');
  if (!commerceProvider) throw new Error('createOpportunityDiagnosticsService exige commerceProvider');

  /**
   * @param {{organizationId, storeId, startDate, endDate, limit?, minSamples?, minDeviation?, minCoverage?}} entrada
   */
  async function getOpportunities(entrada) {
    validarEntrada(entrada);
    const { organizationId, storeId, startDate, endDate } = entrada;
    const limit = Number.isInteger(entrada.limit) && entrada.limit > 0 ? Math.min(entrada.limit, 20) : LIMITE_PADRAO;
    const minSamples = { ...MIN_SAMPLES_PADRAO, ...(entrada.minSamples || {}) };
    const minDeviation = typeof entrada.minDeviation === 'number' ? entrada.minDeviation : DESVIO_MINIMO_PADRAO;
    const minCoverage = typeof entrada.minCoverage === 'number' ? entrada.minCoverage : COBERTURA_MINIMA_PADRAO;

    // Funil (GA4) — nunca derruba a chamada inteira se GA4 estiver desconectado/indisponível (mesmo
    // padrão de tier `available/status/reason` de journey-analytics-service.js): sem GA4, os sinais
    // 1-3 e 5 ficam vazios (candidatos = []), nunca um erro 500/409 pra quem só quer ver o que já dá
    // pra saber com o Commerce sozinho.
    let items = [];
    let coverage = null;
    let funnelSource = { available: false, status: 'not_connected', reason: null };
    try {
      const completo = await paginarDesempenhoCompleto(productPerformanceService, { organizationId, storeId, analyticsProvider, startDate, endDate });
      items = completo.items;
      coverage = completo.coverage;
      funnelSource = { available: coverage.status === 'ok', status: coverage.status === 'ok' ? 'available' : classificarIndisponibilidade(coverage.status), reason: coverage.status === 'ok' ? null : coverage.status };
    } catch (err) {
      const reason = err.codigo || 'ANALYTICS_UNAVAILABLE';
      funnelSource = { available: false, status: classificarIndisponibilidade(reason), reason };
    }

    // Reconciliação (Commerce) — mesma tolerância: sem Commerce conectado, ou período fora do
    // histórico local confiável, o sinal 4 fica vazio, nunca derruba os outros quatro.
    let reconciliation = null;
    let commerceSource = { available: false, status: 'not_connected', reason: null };
    try {
      reconciliation = await reconciliationService.reconcileProductPerformance({ organizationId, storeId, commerceProvider, analyticsProvider, startDate, endDate });
      commerceSource = reconciliation.status === 'ok'
        ? { available: true, status: 'available', reason: null }
        : { available: false, status: classificarIndisponibilidade(reconciliation.reason), reason: reconciliation.reason };
    } catch (err) {
      const reason = err.codigo || 'COMMERCE_UNAVAILABLE';
      commerceSource = { available: false, status: classificarIndisponibilidade(reason), reason };
    }

    const candidatos = [
      ...gerarSinalDeRazao({
        items, campo: 'itemsAddedToCartPerItemViewed', denominadorCampo: 'itemsViewed', tipo: 'low_view_to_cart',
        minimo: minSamples.viewToCart, desvioMinimo: minDeviation,
        hipotese: 'A oferta ou a apresentação deste produto pode merecer revisão — o volume de visualizações não está convertendo em adição ao carrinho na mesma proporção de produtos comparáveis da Store.',
        acao: 'Inspecionar foto, preço, descrição, tamanhos/variações e a promessa do anúncio que traz tráfego pra este produto.',
      }),
      ...gerarSinalDeRazao({
        items, campo: 'itemsCheckedOutPerItemAddedToCart', denominadorCampo: 'itemsAddedToCart', tipo: 'low_cart_to_checkout',
        minimo: minSamples.cartToCheckout, desvioMinimo: minDeviation,
        hipotese: 'Pode haver fricção depois do carrinho — a proporção de itens que avançam para o checkout está abaixo de produtos comparáveis, mas o GA4 não localiza a causa.',
        acao: 'Conferir custo/prazo de frete, disponibilidade da variante e a experiência de carrinho, se houver dado que sustente a hipótese.',
      }),
      ...gerarSinalDeCheckoutParaCompra({
        items, minimo: minSamples.checkoutToPurchase, desvioMinimo: minDeviation,
        hipotese: 'Vale investigar a etapa final — a proporção de checkouts que viram compra observada está abaixo de produtos comparáveis.',
        acao: 'Conferir meios de pagamento, frete no checkout e eventos de purchase; cruzar com o pedido confirmado no Commerce quando existir.',
      }),
      ...gerarSinalDeDivergencia({ reconciliation, minimo: minSamples.commerceUnits }),
      ...gerarSinalDeCoberturaBaixa({ coverage, minimoObservados: minSamples.observedIdsCoverage, coberturaMinima: minCoverage }),
    ];

    candidatos.sort((a, b) => b.score - a.score);
    const opportunities = candidatos.slice(0, limit).map((c) => Object.freeze({ ...c, product: c.product ? Object.freeze({ ...c.product }) : null }));

    return Object.freeze({
      period: { startDate, endDate },
      status: 'ok',
      config: Object.freeze({ minSamples: Object.freeze(minSamples), minDeviation, minCoverage, limit }),
      sources: Object.freeze({ productFunnel: Object.freeze(funnelSource), commerceReconciliation: Object.freeze(commerceSource) }),
      opportunities: Object.freeze(opportunities),
      totalCandidates: candidatos.length,
    });
  }

  return Object.freeze({ getOpportunities });
}

module.exports = { createOpportunityDiagnosticsService, MIN_SAMPLES_PADRAO, DESVIO_MINIMO_PADRAO, COBERTURA_MINIMA_PADRAO, LIMITE_PADRAO };
