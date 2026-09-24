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
// Rodada "corrigir o gargalo real" · reescrito pra eliminar o gargalo medido em produção (>23min
// sem terminar com 85 mil produtos/20 mil itemIds observados, confirmado via profiling — ver
// scripts/dev/scale-test-catalog-85k.cjs e docs/features/jornada-valor-cliente-relatorio.md). Causa
// raiz: a versão anterior paginava o catálogo inteiro (`productPerformanceService.getProductPerformance`
// em páginas de 200 — ~425 chamadas pra 85k produtos) só pra montar os sinais 1-3, e CADA chamada
// refazia a resolução de identity do conjunto INTEIRO de itemIds observados (O(páginas × itemIds)).
// A reconciliação (sinal 4) fazia uma SEGUNDA varredura completa e independente, dobrando o custo.
//
// Arquitetura nova — O(itemIds + produtos-commerce-ativos + candidatos finais), NUNCA
// O(páginas × itemIds), NUNCA carrega o catálogo inteiro em memória:
//
//   1. `productPerformanceService.prepareStoreAnalytics` — relatório GA4 (cache) + resolução de
//      identity + agregação por commerceProductId, tudo UMA VEZ (nunca por página).
//   2. `reconciliationService.getCommerceUnitsAggregation` — unidades/receita Commerce por produto,
//      já eficiente por natureza (pagina PEDIDOS, não o catálogo — tipicamente centenas, não dezenas
//      de milhares).
//   3. Os sinais 1-3 e a cobertura (sinal 5) são calculados DIRETO sobre o Map de (1) — nunca
//      tocam o catálogo (`commerce_products`). O sinal 4 cruza (1) com (2) — para produtos com
//      venda Commerce mas ZERO atividade GA4 no período, `idsComIdentidadeParaProdutos` confere (só
//      pra esse conjunto pequeno) se a identity já existe historicamente, pra nunca excluir "vendeu
//      no Commerce, GA4 não viu nada este período" do sinal de divergência.
//   4. SÓ NO FINAL, depois de rankear e cortar em `limit`, os poucos candidatos vencedores têm seus
//      dados de catálogo (nome/imagem/tipo) resolvidos em UM `catalogRepository.getByIds` em lote —
//      nunca antes disso, nunca pro conjunto inteiro.
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
//   4. units_divergent_ga4_commerce — GA4×Commerce divergem (classificarDivergencia, reconciliation.js) com volume relevante
//   5. identity_coverage_low       — muitos itemId GA4 observados sem produto canônico resolvido
//
// Baseline: mediana da Store entre produtos com volume >= amostra mínima do PRÓPRIO sinal (nunca um
// limiar universal fixo — §4.2). Prioridade: volume × desvio × confiabilidade da amostra (fórmula
// documentada abaixo, nunca "receita perdida" nem previsão).

const { classificarIndisponibilidade } = require('./journey-analytics-service');
const { calcularItemRatios } = require('./product-performance-service');
const { classificarDivergencia, DIVERGENCE_TOLERANCE_PADRAO } = require('./reconciliation');

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

// Rodada "Jornada de Valor Operacional" (Gate C) · rótulo público — nunca "confiança alta/média/
// baixa" (§ comando: isso soa como confiança ESTATÍSTICA CALIBRADA, que este motor não tem — é
// mediana + limiar de amostra, nunca um modelo calibrado). Binário e objetivo: 'suficiente' a partir
// do DOBRO da amostra mínima do próprio sinal, 'limitada' entre o mínimo e o dobro — nunca abaixo do
// mínimo (esses candidatos já foram descartados antes de chegar aqui).
function forcaDaEvidencia(volume, minimo) {
  return volume >= minimo * 2 ? 'suficiente' : 'limitada';
}

// ── Geradores de sinal — cada um trabalha DIRETO sobre o Map de agregação (commerceProductId →
// {metrics, externalIds}), nunca sobre uma linha de catálogo. Candidatos saem com `productId`, não
// `product` — a resolução de catálogo é UMA VEZ, no final, só pros vencedores (ver getOpportunities). ──

function gerarSinalDeRazao({ metricasPorProduto, campo, denominadorCampo, tipo, minimo, desvioMinimo, hipotese, acao }) {
  // Baseline: mediana da Store entre produtos com volume suficiente NESTE sinal — nunca todo o
  // catálogo (um produto com 2 visualizações não deveria puxar o baseline de quem tem 3000).
  const elegiveis = [];
  for (const [productId, acumulado] of metricasPorProduto) {
    const volume = acumulado.metrics[denominadorCampo];
    if (volume === null || volume === undefined || volume < minimo) continue;
    elegiveis.push({ productId, volume, itemRatios: calcularItemRatios(acumulado.metrics) });
  }
  const razoes = elegiveis.map((e) => e.itemRatios[campo]).filter((r) => r !== null && r !== undefined);
  const baseline = mediana(razoes);
  if (baseline === null || !(baseline > 0)) return [];

  const candidatos = [];
  for (const { productId, volume, itemRatios } of elegiveis) {
    const razao = itemRatios[campo];
    if (razao === null || razao === undefined) continue;
    const desvio = (baseline - razao) / baseline;
    if (desvio < desvioMinimo) continue; // só "abaixo" do baseline interessa aqui — acima não é problema
    candidatos.push({
      type: tipo,
      scope: 'product',
      productId,
      evidence: {
        [denominadorCampo]: volume,
        [campo]: Number(razao.toFixed(4)),
        storeBaseline: Number(baseline.toFixed(4)),
        deviation: Number(desvio.toFixed(4)),
        sampleMinimum: minimo,
      },
      hypothesis: hipotese,
      suggestedAction: acao,
      evidenceStrength: forcaDaEvidencia(volume, minimo),
      score: volume * desvio * (0.4 + 0.6 * confiabilidade(volume, minimo)), // confiabilidade nunca zera o score: mesmo no limiar mínimo já é candidato real
    });
  }
  return candidatos;
}

function gerarSinalDeCheckoutParaCompra({ metricasPorProduto, minimo, desvioMinimo, hipotese, acao }) {
  // itemsPurchasedPerItemCheckedOut não existe em CAMPOS_RATIO (product-performance-service.js só
  // tem a razão contra itemsViewed) — calculado aqui, localmente, a partir de métricas JÁ trazidas
  // pelo service (nunca um campo novo pedido ao provider).
  const comRazao = [];
  for (const [productId, acumulado] of metricasPorProduto) {
    const volume = acumulado.metrics.itemsCheckedOut;
    if (volume === null || volume === undefined || volume < minimo) continue;
    const razao = taxaSegura(acumulado.metrics.itemsPurchased, acumulado.metrics.itemsCheckedOut);
    if (razao === null) continue;
    comRazao.push({ productId, volume, razao, itemsPurchased: acumulado.metrics.itemsPurchased });
  }
  const baseline = mediana(comRazao.map((x) => x.razao));
  if (baseline === null || !(baseline > 0)) return [];

  const candidatos = [];
  for (const { productId, volume, razao, itemsPurchased } of comRazao) {
    const desvio = (baseline - razao) / baseline;
    if (desvio < desvioMinimo) continue;
    candidatos.push({
      type: 'low_checkout_to_purchase',
      scope: 'product',
      productId,
      evidence: {
        itemsCheckedOut: volume, itemsPurchased,
        itemsPurchasedPerItemCheckedOut: Number(razao.toFixed(4)), storeBaseline: Number(baseline.toFixed(4)),
        deviation: Number(desvio.toFixed(4)), sampleMinimum: minimo,
      },
      hypothesis: hipotese,
      suggestedAction: acao,
      evidenceStrength: forcaDaEvidencia(volume, minimo),
      score: volume * desvio * (0.4 + 0.6 * confiabilidade(volume, minimo)),
    });
  }
  return candidatos;
}

// `metricasPorProduto`: lado GA4 (produtos com atividade NESTE período). `commercePorProduto`: lado
// Commerce (unidades pagas no período, já vem de `getCommerceUnitsAggregation` — pagina PEDIDOS,
// nunca o catálogo). `idsComIdentidadeHistorica`: Set de commerceProductIds (dentre os que têm
// venda Commerce mas NÃO aparecem em `metricasPorProduto`) que JÁ têm identity ga4.item_id
// resolvida historicamente — cobre "vendeu no Commerce, GA4 não viu nada ESTE período" como zero
// real (nunca excluído, § comando Gate 1.6) sem tratar "nunca teve identity nenhuma" como o mesmo
// caso (esse último fica de fora do sinal — não é divergência, é ausência de correlação possível).
function gerarSinalDeDivergencia({ metricasPorProduto, commercePorProduto, idsComIdentidadeHistorica, minimo, tolerancia }) {
  if (!commercePorProduto) return [];
  const candidatos = [];
  for (const [productId, commerce] of commercePorProduto) {
    if (commerce.unitsSold < minimo) continue; // ruído de 1-2 pedidos não é sinal
    const acumuladoGa4 = metricasPorProduto.get(productId);
    let analyticsUnits;
    if (acumuladoGa4) {
      analyticsUnits = acumuladoGa4.metrics.itemsPurchased; // número real (0 incluso) ou null (métrica indisponível)
    } else if (idsComIdentidadeHistorica.has(productId)) {
      analyticsUnits = 0; // identity resolvida, zero atividade GA4 neste período — zero real, nunca excluído
    } else {
      continue; // sem identity GA4 nenhuma pra este produto — fora do sinal (não dá pra comparar)
    }
    if (analyticsUnits === null) continue; // métrica indisponível na propriedade — não dá pra comparar
    const status = classificarDivergencia(analyticsUnits, commerce.unitsSold, tolerancia);
    if (status !== 'divergent') continue; // 'aligned' ou 'insufficient_data' — nunca um sinal
    const base = Math.max(analyticsUnits, commerce.unitsSold, 1);
    const deltaRate = Math.abs(analyticsUnits - commerce.unitsSold) / base;
    candidatos.push({
      type: 'units_divergent_ga4_commerce',
      scope: 'product',
      productId,
      evidence: {
        analyticsUnits, commerceUnits: commerce.unitsSold,
        paidOrdersDistinct: commerce.paidOrders.size, deviation: Number(deltaRate.toFixed(4)),
      },
      hypothesis: 'Pode existir divergência operacional ou de tracking entre o que o GA4 observou como compra e o que o Commerce confirmou como pago.',
      suggestedAction: 'Conferir IDs de transação, datas (createdAt vs. paidAt), estornos e possível duplicação de evento de purchase.',
      evidenceStrength: forcaDaEvidencia(commerce.unitsSold, minimo),
      score: commerce.unitsSold * deltaRate,
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
    productId: null,
    evidence: {
      observedAnalyticsIds: coverage.observedAnalyticsIds,
      matchedAnalyticsIds: coverage.matchedAnalyticsIds,
      unmatchedAnalyticsIds: coverage.unmatchedAnalyticsIds,
      coverageRate: Number(coverage.coverageRate.toFixed(4)),
      coverageMinimum: coberturaMinima,
    },
    hypothesis: 'Uma parte relevante do que o GA4 observou não tem produto canônico correspondente — decisões por produto ficam incompletas para esses itens.',
    suggestedAction: 'Conferir se o catálogo (commerce_products) está sincronizado e revisar a identidade dos itemIds sem match.',
    evidenceStrength: forcaDaEvidencia(coverage.observedAnalyticsIds, minimoObservados),
    score: coverage.unmatchedAnalyticsIds,
  }];
}

/**
 * @param {{productPerformanceService, reconciliationService, catalogRepository, analyticsProvider: string, commerceProvider: string}} deps
 *   `catalogRepository`: Rodada "corrigir o gargalo real" — resolve nome/imagem/tipo só dos
 *   candidatos finais (getByIds em lote), nunca do catálogo inteiro nem do conjunto elegível
 *   completo.
 */
function createOpportunityDiagnosticsService({ productPerformanceService, reconciliationService, catalogRepository, analyticsProvider, commerceProvider }) {
  if (!productPerformanceService || typeof productPerformanceService.prepareStoreAnalytics !== 'function'
    || typeof productPerformanceService.idsComIdentidadeParaProdutos !== 'function') {
    throw new Error('createOpportunityDiagnosticsService exige productPerformanceService (prepareStoreAnalytics + idsComIdentidadeParaProdutos)');
  }
  if (!reconciliationService || typeof reconciliationService.getCommerceUnitsAggregation !== 'function') {
    throw new Error('createOpportunityDiagnosticsService exige reconciliationService (getCommerceUnitsAggregation)');
  }
  if (!catalogRepository || typeof catalogRepository.getByIds !== 'function') {
    throw new Error('createOpportunityDiagnosticsService exige catalogRepository (getByIds)');
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
    // pra saber com o Commerce sozinho. UMA chamada — `prepareStoreAnalytics` — nunca mais 425.
    let metricasPorProduto = new Map();
    let coverage = null;
    let funnelSource = { available: false, status: 'not_connected', reason: null };
    try {
      const agregacao = await productPerformanceService.prepareStoreAnalytics({ organizationId, storeId, analyticsProvider, startDate, endDate });
      metricasPorProduto = agregacao.metricasPorProduto;
      coverage = agregacao.coverage;
      funnelSource = { available: coverage.status === 'ok', status: coverage.status === 'ok' ? 'available' : classificarIndisponibilidade(coverage.status), reason: coverage.status === 'ok' ? null : coverage.status };
    } catch (err) {
      const reason = err.codigo || 'ANALYTICS_UNAVAILABLE';
      funnelSource = { available: false, status: classificarIndisponibilidade(reason), reason };
    }

    // Commerce — mesma tolerância: sem Commerce conectado, ou período fora do histórico local
    // confiável, o sinal 4 fica vazio, nunca derruba os outros quatro. `getCommerceUnitsAggregation`
    // pagina PEDIDOS (nunca o catálogo) — já eficiente por natureza, sem mudança de custo aqui.
    let commercePorProduto = null;
    let commerceSource = { available: false, status: 'not_connected', reason: null };
    try {
      const comercio = await reconciliationService.getCommerceUnitsAggregation({ organizationId, storeId, commerceProvider, startDate, endDate });
      if (comercio.status === 'ok') {
        commercePorProduto = comercio.porProduto;
        commerceSource = { available: true, status: 'available', reason: null };
      } else {
        commerceSource = { available: false, status: classificarIndisponibilidade(comercio.reason), reason: comercio.reason };
      }
    } catch (err) {
      const reason = err.codigo || 'COMMERCE_UNAVAILABLE';
      commerceSource = { available: false, status: classificarIndisponibilidade(reason), reason };
    }

    // Gate 1.6 · pro sinal de divergência, produtos com venda Commerce mas SEM linha em
    // `metricasPorProduto` (zero atividade GA4 neste período) só entram se já tiverem identity
    // ga4.item_id resolvida historicamente — 1 consulta cheia, restrita a este conjunto PEQUENO
    // (produtos com pedido pago no período, nunca o catálogo inteiro).
    let idsComIdentidadeHistorica = new Set();
    if (commercePorProduto && commercePorProduto.size) {
      const semAtividadeEstePeriodo = [...commercePorProduto.keys()].filter((id) => !metricasPorProduto.has(id));
      if (semAtividadeEstePeriodo.length) {
        idsComIdentidadeHistorica = await productPerformanceService.idsComIdentidadeParaProdutos({
          organizationId, storeId, analyticsProvider, ids: semAtividadeEstePeriodo,
        });
      }
    }

    const candidatos = [
      ...gerarSinalDeRazao({
        metricasPorProduto, campo: 'itemsAddedToCartPerItemViewed', denominadorCampo: 'itemsViewed', tipo: 'low_view_to_cart',
        minimo: minSamples.viewToCart, desvioMinimo: minDeviation,
        hipotese: 'A oferta ou a apresentação deste produto pode merecer revisão — o volume de visualizações não está convertendo em adição ao carrinho na mesma proporção de produtos comparáveis da Store.',
        acao: 'Inspecionar foto, preço, descrição, tamanhos/variações e a promessa do anúncio que traz tráfego pra este produto.',
      }),
      ...gerarSinalDeRazao({
        metricasPorProduto, campo: 'itemsCheckedOutPerItemAddedToCart', denominadorCampo: 'itemsAddedToCart', tipo: 'low_cart_to_checkout',
        minimo: minSamples.cartToCheckout, desvioMinimo: minDeviation,
        hipotese: 'Pode haver fricção depois do carrinho — a proporção de itens que avançam para o checkout está abaixo de produtos comparáveis, mas o GA4 não localiza a causa.',
        acao: 'Conferir custo/prazo de frete, disponibilidade da variante e a experiência de carrinho, se houver dado que sustente a hipótese.',
      }),
      ...gerarSinalDeCheckoutParaCompra({
        metricasPorProduto, minimo: minSamples.checkoutToPurchase, desvioMinimo: minDeviation,
        hipotese: 'Vale investigar a etapa final — a proporção de checkouts que viram compra observada está abaixo de produtos comparáveis.',
        acao: 'Conferir meios de pagamento, frete no checkout e eventos de purchase; cruzar com o pedido confirmado no Commerce quando existir.',
      }),
      ...gerarSinalDeDivergencia({
        metricasPorProduto, commercePorProduto, idsComIdentidadeHistorica,
        minimo: minSamples.commerceUnits, tolerancia: DIVERGENCE_TOLERANCE_PADRAO,
      }),
      ...gerarSinalDeCoberturaBaixa({ coverage, minimoObservados: minSamples.observedIdsCoverage, coberturaMinima: minCoverage }),
    ];

    candidatos.sort((a, b) => b.score - a.score);
    const totalCandidates = candidatos.length;
    // Corte ANTES de resolver catálogo (Gate 1.6/1.7 do comando) — nunca busca produto de um
    // candidato que não vai aparecer; `totalCandidates` acima já reflete o total REAL antes do
    // corte, então cortar cedo aqui não esconde quantidade nenhuma da resposta.
    const vencedores = candidatos.slice(0, limit);

    // Gate 1.7 · resolve catálogo SÓ pros vencedores, em UM lote — nunca por candidato, nunca pro
    // conjunto elegível inteiro. Sinais de escopo 'store' (productId: null) não pedem produto.
    const idsParaResolver = [...new Set(vencedores.map((c) => c.productId).filter(Boolean))];
    const produtosResolvidos = idsParaResolver.length
      ? await catalogRepository.getByIds({ organizationId, storeId, ids: idsParaResolver })
      : [];
    const produtoPorId = new Map(produtosResolvidos.map((p) => [p.id, p]));

    const opportunities = [];
    for (const c of vencedores) {
      const { productId, ...resto } = c;
      // Defensivo: um candidato cujo produto sumiu do catálogo entre a agregação e a resolução
      // (ex.: desativado por um sync concorrente) nunca vira uma linha quebrada na tela — é
      // descartado, nunca mostrado com `product: undefined`.
      if (productId && !produtoPorId.has(productId)) continue;
      opportunities.push(Object.freeze({ ...resto, product: productId ? Object.freeze({ ...produtoPorId.get(productId) }) : null }));
    }

    return Object.freeze({
      period: { startDate, endDate },
      status: 'ok',
      config: Object.freeze({ minSamples: Object.freeze(minSamples), minDeviation, minCoverage, limit }),
      sources: Object.freeze({ productFunnel: Object.freeze(funnelSource), commerceReconciliation: Object.freeze(commerceSource) }),
      opportunities: Object.freeze(opportunities),
      totalCandidates,
    });
  }

  return Object.freeze({ getOpportunities });
}

module.exports = { createOpportunityDiagnosticsService, MIN_SAMPLES_PADRAO, DESVIO_MINIMO_PADRAO, COBERTURA_MINIMA_PADRAO, LIMITE_PADRAO };
