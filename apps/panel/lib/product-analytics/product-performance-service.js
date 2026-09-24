'use strict';

// Fase G · ProductPerformanceService — une catálogo canônico + métricas de analytics + Product
// Identity, SEM reconciliação com pedidos Commerce (ver reconciliation.js — Etapa 3 da rodada
// G.1/Orders/Reconciliação: comparação com pedidos confirmados é uma camada À PARTE, opcional, que
// consome a saída deste service — este service nunca conhece `commerce_orders`).
//
//   Commerce catalog repository (Fase D, lib/product-analytics/commerce-catalog-repository.js)
//   AnalyticsConnector          (registry.resolve('analytics', provider, ctx) — Fase B/E)
//   ProductIdentityResolver     (lib/product-analytics/product-identity-resolver.js — Fase F)
//
// NUNCA: ReservaInkCommerceConnector direto, GA4Client direto, `pedidos_ink` direto. O service fala
// só com as três abstrações acima; o `registry` decide QUAL provider de analytics por `analyticsProvider`
// (um dado, nunca um literal comparado no código).
//
// 1 (ou poucas, já paginadas dentro do connector) chamada ao AnalyticsConnector para o PERÍODO
// INTEIRO — nunca uma por produto (§6.10), mesmo com 100/1000/85000 produtos no catálogo.
//
// Rodada G.1 (consolidação): `itemRatios` (antes `rates`) são razões entre CONTAGENS DE ITEM
// (quantos itens visualizados/adicionados/finalizados/comprados) — nunca taxa de conversão de
// usuário ou de sessão; o GA4 Data API mede eventos de item, não sessões. Nomeado
// `<numerador>PerItem<denominador>` para deixar essa base explícita no próprio campo.

const { resolveAndPersist } = require('./product-identity-resolver');

const METRICAS = Object.freeze(['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue']);
const CAMPOS_CATALOGO = Object.freeze(['name', 'price', 'created_at', 'updated_at']);

// Cada razão é sobre as MESMAS unidades (contagem de item) nos dois lados — nunca item/sessão ou
// item/usuário, que o GA4 Data API (escopo item, não sessão) não sustentaria.
const CAMPOS_RATIO = Object.freeze({
  itemsAddedToCartPerItemViewed: (m) => taxa(m.itemsAddedToCart, m.itemsViewed),
  itemsCheckedOutPerItemViewed: (m) => taxa(m.itemsCheckedOut, m.itemsViewed),
  itemsCheckedOutPerItemAddedToCart: (m) => taxa(m.itemsCheckedOut, m.itemsAddedToCart),
  itemsPurchasedPerItemViewed: (m) => taxa(m.itemsPurchased, m.itemsViewed),
});
const RATIOS_VAZIOS = Object.freeze(Object.fromEntries(Object.keys(CAMPOS_RATIO).map((k) => [k, null])));
const CAMPOS_ORDENAVEIS_METRICA = Object.freeze([...METRICAS, ...Object.keys(CAMPOS_RATIO)]);

function metricasZeradas() {
  return { itemsViewed: 0, itemsAddedToCart: 0, itemsCheckedOut: 0, itemsPurchased: 0, itemRevenue: 0 };
}

// Rodada "corrigir o gargalo real" · extraído de montarLinha pra ser reaproveitado por
// opportunity-diagnostics.js direto sobre o Map de `prepareStoreAnalytics` (metrics cru, sem
// `product`) — mesma fórmula, nunca uma segunda definição de itemRatios em outro arquivo.
function calcularItemRatios(metrics) {
  const itemRatios = {};
  for (const [nome, calc] of Object.entries(CAMPOS_RATIO)) itemRatios[nome] = calc(metrics);
  return itemRatios;
}

// Soma "conhecendo nulos": se AMBOS os lados já são number, soma normal. Se o valor da linha é
// null (métrica indisponível na propriedade — Fase E nunca inventa 0 aqui), a métrica agregada
// deste produto fica marcada indisponível (null) mesmo que outra linha tenha trazido número —
// nunca mistura "soma parcial" com "não sei".
function somarMetrica(acumulado, valor) {
  if (acumulado === null || valor === null || valor === undefined) return null;
  return acumulado + valor;
}

function taxa(numerador, denominador) {
  if (numerador === null || denominador === null || !(denominador > 0)) return null;
  return numerador / denominador;
}

function validarEntrada({ organizationId, storeId, analyticsProvider, startDate, endDate, pagination }) {
  if (!organizationId || !storeId) throw new TypeError('organizationId e storeId são obrigatórios');
  if (!analyticsProvider) throw new TypeError('analyticsProvider é obrigatório');
  if (!startDate || !endDate) throw new TypeError('startDate e endDate são obrigatórios (ISO puro — sem período relativo)');
  if (String(startDate) > String(endDate)) throw new TypeError('startDate deve ser <= endDate');
  const limit = (pagination && pagination.limit) || 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TypeError('pagination.limit deve ser um inteiro entre 1 e 500');
}

// Produtos com identity JÁ resolvida no namespace de analytics (persistida agora ou em período
// anterior — §6.8: essa é a diferença entre "zero real" e "sem evidência de coleta"). `apenasIds`
// restringe a um conjunto de commerce_product_id conhecido (uso: página já paginada pelo catálogo —
// evita carregar o conjunto elegível da Store inteira quando só a página interessa); sem ele, é o
// conjunto elegível DA STORE inteira (uso: ordenar por métrica/ratio, que precisa do total antes de
// paginar — nunca o catálogo inteiro em memória, só os ids com identity resolvida, §6.10).
async function idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, provider, apenasIds }) {
  if (apenasIds && !apenasIds.length) return [];
  const condicoes = ['pei.organization_id = $1', 'pei.store_id = $2', 'pei.namespace = $3', 'cp.is_active'];
  const params = [organizationId, storeId, namespace];
  if (provider) { params.push(provider); condicoes.push(`cp.provider = $${params.length}`); }
  if (apenasIds) { params.push(apenasIds); condicoes.push(`pei.commerce_product_id = ANY($${params.length}::uuid[])`); }
  const { rows } = await pool.query(
    `SELECT DISTINCT pei.commerce_product_id AS id
       FROM product_external_identities pei
       JOIN commerce_products cp ON cp.id = pei.commerce_product_id AND cp.organization_id = pei.organization_id
      WHERE ${condicoes.join(' AND ')}`,
    params
  );
  return rows.map((r) => r.id);
}

/**
 * @param {{pool, registry, catalogRepository, reportCache?}} deps
 */
function createProductPerformanceService({ pool, registry, catalogRepository, reportCache = createReportCache() }) {
  if (!pool) throw new Error('createProductPerformanceService exige pool');
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createProductPerformanceService exige registry');
  if (!catalogRepository || typeof catalogRepository.listPage !== 'function') throw new Error('createProductPerformanceService exige catalogRepository');

  // Resolve o connector, calcula o discriminador de cache (barato — sem chamada à API do provider,
  // ver ga4/connector.js `getCacheScope`) ANTES de consultar o ReportCache, e busca o relatório
  // (cache hit ou miss). Único ponto que fala com o AnalyticsConnector — getProductPerformance e
  // getProductPerformanceById passam pelo mesmo caminho, nunca duplicam a chamada.
  async function obterRelatorio({ organizationId, storeId, analyticsProvider, startDate, endDate }) {
    const resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
    resolvido.require('productMetrics');
    // Rodada H (cache HTTP §H.4): sem isto, reconectar a Store a OUTRA propriedade/conta dentro do
    // mesmo TTL reaproveitaria o relatório da propriedade antiga — a chave org/store/provider/período
    // sozinha não veria a troca. Opcional: um provider sem o conceito de "propriedade" (ou sem o
    // método) simplesmente não teria mais essa dimensão na chave.
    const escopoCache = typeof resolvido.connector.getCacheScope === 'function' ? await resolvido.connector.getCacheScope() : null;
    return reportCache.obter({ organizationId, storeId, analyticsProvider, startDate, endDate, escopoCache }, () => resolvido.connector.getProductPerformance({ startDate, endDate }));
  }

  // Rodada "corrigir o gargalo real" (Gate 1) · o TRABALHO POR PERÍODO que `getProductPerformance`
  // fazia DE NOVO a cada página (1 chamada de analytics — já cacheada — mas também 1
  // `resolveAndPersist` e 1 passagem de agregação sobre o relatório INTEIRO, por página) agora é
  // computado UMA VEZ aqui e reaproveitado por quem precisa do conjunto elegível INTEIRO da Store —
  // `paginarDesempenhoCompleto`/reconciliation.js, nunca 425/850 vezes por request. `getProductPerformance`
  // (abaixo) também passou a usar isto por dentro — mesma chamada de rede, mesma chamada ao banco,
  // só sem duplicar a lógica.
  //
  //   O(itemIds observados no período) — nunca O(páginas × itemIds).
  //
  // Retorna o Map cru (nunca serializado pro HTTP diretamente — quem serializa decide o formato,
  // ex.: getProductPerformance monta `items` por página, opportunity-diagnostics.js consome o Map
  // direto sem nunca tocar o catálogo inteiro).
  async function prepareStoreAnalytics({ organizationId, storeId, analyticsProvider, startDate, endDate }) {
    validarEntrada({ organizationId, storeId, analyticsProvider, startDate, endDate });
    const namespace = `${analyticsProvider}.item_id`;
    const linhasAnalytics = await obterRelatorio({ organizationId, storeId, analyticsProvider, startDate, endDate });

    if (!linhasAnalytics.length) {
      return {
        namespace, linhasAnalytics, idsObservados: [], resolucao: { resolved: [], conflicts: [], unresolved: [] },
        metricasPorProduto: new Map(), metricasIndisponiveis: [],
        coverage: { observedAnalyticsIds: 0, matchedAnalyticsIds: 0, unmatchedAnalyticsIds: 0, conflictedAnalyticsIds: 0, coverageRate: null, status: 'insufficient_data' },
      };
    }

    // Resolve (e persiste as novas regras determinísticas) os ids observados — UMA VEZ pro
    // conjunto INTEIRO, nunca por página/por consumidor.
    const idsObservados = [...new Set(linhasAnalytics.map((l) => l.externalProductId))];
    const resolucao = await resolveAndPersist({ pool }, { organizationId, storeId, namespace, externalIds: idsObservados });
    const produtoPorExternalId = new Map(resolucao.resolved.map((r) => [r.externalId, r.commerceProductId]));

    // Métrica indisponível na propriedade inteira: se NENHUMA linha observada trouxe valor para
    // ela, é a propriedade que não suporta — não o produto individual (Fase E já nunca inventa 0
    // aqui). Calculado ANTES da agregação (só lê `linhasAnalytics`, nunca o Map por produto) pra
    // `linhaZerada` já criar toda entrada nova (seja pela agregação abaixo, seja por um zeramento
    // de página feito depois por `getProductPerformance`) já com os campos indisponíveis nulos —
    // nunca "0 travestido de sem suporte", em nenhum dos dois caminhos.
    const metricasIndisponiveis = METRICAS.filter((nome) => linhasAnalytics.every((l) => l[nome] === null));
    const metricasZeradasComIndisponiveis = () => {
      const m = metricasZeradas();
      for (const nome of metricasIndisponiveis) m[nome] = null;
      return m;
    };

    // Agrega por commerce_product_id — nunca por external id solto (§6.5: soma os que apontam pro
    // MESMO produto; sem informação para deduplicar entre ids diferentes, então soma e sinaliza).
    // UMA passagem sobre `linhasAnalytics`, nunca uma por página.
    const metricasPorProduto = new Map(); // commerceProductId -> { metrics, externalIds: Set }
    const linhaZerada = (id) => {
      if (!metricasPorProduto.has(id)) metricasPorProduto.set(id, { metrics: metricasZeradasComIndisponiveis(), externalIds: new Set() });
      return metricasPorProduto.get(id);
    };
    for (const linha of linhasAnalytics) {
      const commerceProductId = produtoPorExternalId.get(linha.externalProductId);
      if (!commerceProductId) continue; // id observado sem produto canônico — não é problema do PRODUTO, é do id (coverage cobre isso)
      const acc = linhaZerada(commerceProductId);
      acc.externalIds.add(linha.externalProductId);
      for (const nome of METRICAS) {
        if (metricasIndisponiveis.includes(nome)) continue; // já null — nunca soma em cima de indisponível
        acc.metrics[nome] = somarMetrica(acc.metrics[nome], linha[nome]);
      }
    }

    return {
      namespace, linhasAnalytics, idsObservados, resolucao, metricasPorProduto, metricasIndisponiveis, linhaZerada,
      coverage: {
        observedAnalyticsIds: idsObservados.length,
        matchedAnalyticsIds: resolucao.resolved.length,
        unmatchedAnalyticsIds: resolucao.unresolved.length,
        conflictedAnalyticsIds: resolucao.conflicts.length,
        coverageRate: idsObservados.length > 0 ? resolucao.resolved.length / idsObservados.length : null,
        status: idsObservados.length > 0 ? 'ok' : 'insufficient_data',
      },
    };
  }

  async function getProductPerformance(entrada) {
    validarEntrada(entrada);
    const { organizationId, storeId, analyticsProvider, startDate, endDate, filters = {}, sort = null, pagination = {} } = entrada;
    const namespace = `${analyticsProvider}.item_id`;

    // Gate 1 · o trabalho por PERÍODO (relatório + resolução + agregação) é sempre computado UMA
    // VEZ aqui — se `entrada.aggregation` já veio pronto (reconciliation.js pagina o catálogo
    // MUITAS vezes pro mesmo período; passar a MESMA agregação evita recomputar a cada página —
    // ver reconciliation.js#agregarAnalyticsCompleto), reaproveita; sem ele, computa na hora (o
    // caminho de sempre, usado pela rota HTTP — nenhuma mudança de contrato pra quem já chama sem
    // esse campo).
    const agregacao = entrada.aggregation || await prepareStoreAnalytics({ organizationId, storeId, analyticsProvider, startDate, endDate });
    const { idsObservados, resolucao, metricasPorProduto, coverage } = agregacao;

    if (!idsObservados.length) {
      // Sem NENHUMA linha no período: não dá pra distinguir "zero de verdade" de "sem cobertura" —
      // representado no nível da resposta, não inventado por produto (§6.8/§5.8).
      const pagina = await catalogRepository.listPage({
        organizationId, storeId, provider: filters.provider, cursor: pagination.cursor, limit: pagination.limit || 50,
        sortBy: (sort && CAMPOS_CATALOGO.includes(sort.field)) ? sort.field : 'name', sortDir: sort && sort.direction,
      });
      return {
        items: pagina.items.map((p) => linhaSemAnalytics(p, 'insufficient_data')),
        nextCursor: pagina.nextCursor,
        totalCount: pagina.totalCount,
        coverage,
      };
    }

    // ── Escolha da página: catálogo (DB pagina, caminho comum de navegação — barato mesmo com um
    // catálogo grande) ou métrica/ratio (conjunto elegível DA STORE inteira, ordenado e paginado em
    // memória ANTES do corte de página — nunca só a página do catálogo: um produto de alto
    // desempenho fora da primeira página por nome tem que aparecer no topo ao ordenar por receita). ──
    const ordenarPorMetrica = sort && CAMPOS_ORDENAVEIS_METRICA.includes(sort.field);
    let produtosDaPagina;
    let nextCursor = null;
    let totalCount;
    if (ordenarPorMetrica) {
      const idsElegiveis = await idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, provider: filters.provider });
      for (const id of idsElegiveis) agregacao.linhaZerada(id);
      const todos = await catalogRepository.getByIds({ organizationId, storeId, ids: [...metricasPorProduto.keys()] });
      const valorDeOrdenacao = (produto) => valorDoCampo(metricasPorProduto.get(produto.id), sort.field);
      todos.sort((a, b) => compararComNullPorUltimo(valorDeOrdenacao(a), valorDeOrdenacao(b), sort.direction));
      totalCount = todos.length;
      const limite = pagination.limit || 50;
      const pagina = pagination.cursor ? Number(pagination.cursor) : 1;
      const inicio = (pagina - 1) * limite;
      produtosDaPagina = todos.slice(inicio, inicio + limite);
      nextCursor = inicio + produtosDaPagina.length < totalCount ? String(pagina + 1) : null;
    } else {
      const pagina = await catalogRepository.listPage({
        organizationId, storeId, provider: filters.provider, cursor: pagination.cursor, limit: pagination.limit || 50,
        sortBy: (sort && sort.field) || 'name', sortDir: sort && sort.direction,
      });
      produtosDaPagina = pagina.items;
      nextCursor = pagina.nextCursor;
      totalCount = pagina.totalCount;
      // Identity conhecida só para ESTA página (nunca a Store inteira neste ramo — é o caminho
      // comum de navegação por catálogo, tem que ficar barato mesmo com um catálogo grande).
      const idsDaPagina = await idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, apenasIds: produtosDaPagina.map((p) => p.id) });
      for (const id of idsDaPagina) agregacao.linhaZerada(id);
    }

    const items = produtosDaPagina.map((produto) => montarLinha(produto, metricasPorProduto.get(produto.id)));

    return { items, nextCursor, totalCount, coverage };
  }

  // Rodada H (detalhe do produto, GET /products/:productId) · MESMO relatório (mesma chave de
  // cache — nunca uma chamada de analytics extra só porque é 1 produto) e MESMA linha que
  // apareceria em getProductPerformance para este produto no mesmo período; devolve `null` quando o
  // produto não existe nesta Store/Organization (a rota decide o 404 — o service não inventa erro
  // HTTP nenhum).
  async function getProductPerformanceById({ organizationId, storeId, analyticsProvider, startDate, endDate, productId }) {
    validarEntrada({ organizationId, storeId, analyticsProvider, startDate, endDate });
    if (!productId) throw new TypeError('productId é obrigatório');
    const namespace = `${analyticsProvider}.item_id`;

    const produtos = await catalogRepository.getByIds({ organizationId, storeId, ids: [productId] });
    if (!produtos.length) return null;
    const produto = produtos[0];

    const linhasAnalytics = await obterRelatorio({ organizationId, storeId, analyticsProvider, startDate, endDate });
    if (!linhasAnalytics.length) return linhaSemAnalytics(produto, 'insufficient_data');

    const idsObservados = [...new Set(linhasAnalytics.map((l) => l.externalProductId))];
    const resolucao = await resolveAndPersist({ pool }, { organizationId, storeId, namespace, externalIds: idsObservados });
    const produtoPorExternalId = new Map(resolucao.resolved.map((r) => [r.externalId, r.commerceProductId]));

    const idsElegiveis = await idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, apenasIds: [productId] });
    if (!idsElegiveis.length) return montarLinha(produto, null); // unmatched_identity

    const acumulado = { metrics: metricasZeradas(), externalIds: new Set() };
    for (const linha of linhasAnalytics) {
      if (produtoPorExternalId.get(linha.externalProductId) !== productId) continue;
      acumulado.externalIds.add(linha.externalProductId);
      for (const nome of METRICAS) acumulado.metrics[nome] = somarMetrica(acumulado.metrics[nome], linha[nome]);
    }
    const metricasIndisponiveis = METRICAS.filter((nome) => linhasAnalytics.every((l) => l[nome] === null));
    for (const nome of metricasIndisponiveis) acumulado.metrics[nome] = null;

    return montarLinha(produto, acumulado);
  }

  // Rodada J.4 · totais STORE-WIDE do período (menor extensão provider-agnostic): reaproveita o
  // MESMO relatório cacheado (nenhuma chamada extra ao AnalyticsConnector) e resolve identities em
  // lote (nunca N+1 — a mesma chamada de resolveAndPersist do resto do service).
  //
  // Dois grupos, sempre os dois, nunca um só (§J.4 — "evitar que a soma duplique semanticamente...
  // exibindo os dois grupos ou explicitando a cobertura"):
  //   observed  soma de TODO itemId observado pelo GA4 no período, resolvido ou não — a verdade
  //             crua da propriedade, nunca depende de identity.
  //   matched   soma só do que resolveu a um produto canônico da Store (e, com filters.provider,
  //             só produtos DESSE provider) — o que a UI pode atribuir a um produto de verdade.
  // Os dois nunca "duplicam": cada itemId observado entra em UMA soma (observed sempre; matched só
  // se resolveu) — um produto com 3 ids (produto+variante+sku) soma 3 linhas trazidas por ele
  // mesmo, não 3 produtos diferentes contados errado.
  async function getProductPerformanceSummary({ organizationId, storeId, analyticsProvider, startDate, endDate, filters = {} }) {
    validarEntrada({ organizationId, storeId, analyticsProvider, startDate, endDate });
    const namespace = `${analyticsProvider}.item_id`;

    const linhasAnalytics = await obterRelatorio({ organizationId, storeId, analyticsProvider, startDate, endDate });
    if (!linhasAnalytics.length) {
      return {
        observed: null,
        matched: null,
        coverage: { observedAnalyticsIds: 0, matchedAnalyticsIds: 0, unmatchedAnalyticsIds: 0, conflictedAnalyticsIds: 0, coverageRate: null, status: 'insufficient_data' },
      };
    }

    // Métrica indisponível na propriedade inteira: null nos DOIS grupos — nunca 0 travestido de
    // "sem suporte" (mesma regra do resto do service, §6.8/Fase E).
    const metricasIndisponiveis = METRICAS.filter((nome) => linhasAnalytics.every((l) => l[nome] === null));
    const aplicarIndisponiveis = (m) => { for (const nome of metricasIndisponiveis) m[nome] = null; return m; };

    const observed = metricasZeradas();
    for (const linha of linhasAnalytics) {
      for (const nome of METRICAS) observed[nome] = somarMetrica(observed[nome], linha[nome]);
    }
    aplicarIndisponiveis(observed);

    const idsObservados = [...new Set(linhasAnalytics.map((l) => l.externalProductId))];
    const resolucao = await resolveAndPersist({ pool }, { organizationId, storeId, namespace, externalIds: idsObservados });
    const produtoPorExternalId = new Map(resolucao.resolved.map((r) => [r.externalId, r.commerceProductId]));

    // Com filters.provider: só conta como "matched" o que resolveu a um produto DESSE provider —
    // mesmo escopo de listPage/getProductPerformance (nunca mistura catálogo de providers diferentes
    // quando a página pediu um filtro).
    const idsElegiveis = filters.provider
      ? new Set(await idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, provider: filters.provider }))
      : null;

    const matched = metricasZeradas();
    for (const linha of linhasAnalytics) {
      const commerceProductId = produtoPorExternalId.get(linha.externalProductId);
      if (!commerceProductId) continue;
      if (idsElegiveis && !idsElegiveis.has(commerceProductId)) continue;
      for (const nome of METRICAS) matched[nome] = somarMetrica(matched[nome], linha[nome]);
    }
    aplicarIndisponiveis(matched);

    return {
      observed,
      matched,
      coverage: {
        observedAnalyticsIds: idsObservados.length,
        matchedAnalyticsIds: resolucao.resolved.length,
        unmatchedAnalyticsIds: resolucao.unresolved.length,
        conflictedAnalyticsIds: resolucao.conflicts.length,
        coverageRate: idsObservados.length > 0 ? resolucao.resolved.length / idsObservados.length : null,
        status: 'ok',
      },
    };
  }

  // Rodada "corrigir o gargalo real" (Gate 1.6) · opportunity-diagnostics.js precisa saber, pra um
  // conjunto PEQUENO e já conhecido de commerceProductIds (produtos com venda Commerce no período,
  // tipicamente centenas — nunca o catálogo inteiro), quais JÁ têm identity GA4 resolvida
  // (histórico, não só este período) — cobre "produto identificado sem atividade GA4 neste período,
  // mas com venda Commerce" sem varrer o catálogo (§ comando: "sem excluir produtos elegíveis com
  // zero atividade ou vendas Commerce não representadas no GA4"). Nunca exige `pool`/`registry` de
  // fora deste service — mantém a fronteira já existente (opportunity-diagnostics.js só fala com
  // productPerformanceService/reconciliationService, nunca toca pool/registry direto).
  async function idsComIdentidadeParaProdutos({ organizationId, storeId, analyticsProvider, ids }) {
    if (!ids || !ids.length) return new Set();
    const namespace = `${analyticsProvider}.item_id`;
    const resolvidos = await idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, apenasIds: ids });
    return new Set(resolvidos);
  }

  return Object.freeze({
    getProductPerformance, getProductPerformanceById, getProductPerformanceSummary,
    prepareStoreAnalytics, idsComIdentidadeParaProdutos,
  });
}

function linhaSemAnalytics(produto, diagnostico) {
  return Object.freeze({
    product: produto,
    metrics: null,
    itemRatios: RATIOS_VAZIOS,
    identity: { matchedAnalyticsIds: [], status: 'unmatched' },
    diagnostics: [diagnostico],
  });
}

function montarLinha(produto, acumulado) {
  if (!acumulado) {
    return Object.freeze({
      product: produto,
      metrics: null,
      itemRatios: RATIOS_VAZIOS,
      identity: Object.freeze({ matchedAnalyticsIds: [], status: 'unmatched' }),
      diagnostics: Object.freeze(['unmatched_identity']),
    });
  }

  const diagnostics = [];
  const metrics = { ...acumulado.metrics };
  const matchedAnalyticsIds = [...acumulado.externalIds];
  if (acumulado.externalIds.size > 1) diagnostics.push('multiple_analytics_identities');
  if (METRICAS.some((nome) => metrics[nome] === null)) diagnostics.push('metric_unavailable');

  return Object.freeze({
    product: produto,
    metrics: Object.freeze(metrics),
    itemRatios: Object.freeze(calcularItemRatios(metrics)),
    identity: Object.freeze({ matchedAnalyticsIds, status: 'matched' }),
    diagnostics: Object.freeze(diagnostics),
  });
}

function valorDoCampo(acumulado, campo) {
  if (!acumulado) return null; // sem identity resolvida: fora do conjunto ordenável (nunca chega aqui hoje, defensivo)
  if (METRICAS.includes(campo)) return acumulado.metrics[campo];
  if (CAMPOS_RATIO[campo]) return CAMPOS_RATIO[campo](acumulado.metrics);
  return null;
}

function compararComNullPorUltimo(a, b, direcao) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // null sempre por último, em qualquer direção
  if (b === null) return -1;
  return direcao === 'desc' ? b - a : a - b;
}

// ── Cache tenant-safe de relatório GA4 (Etapa 1/escalabilidade) ────────────────────────────────
// Repetir um relatório completo do AnalyticsConnector a cada PÁGINA do ProductPerformanceService
// seria 1 chamada de analytics por página — o mesmo N+1 que §6.10 proíbe por produto, só que por
// página. Chave: (organizationId, storeId, analyticsProvider, startDate, endDate) — período e
// escopo tenant exatos, nunca cruza Organization/Store (resolveria ERRADO se cruzasse: dado de uma
// Organization nunca pode vazar pro cache-hit de outra). TTL curto (15 min por padrão) porque o
// relatório é "quase real-time" do GA4, não um snapshot histórico — sem Redis: um Map isolado por
// INSTÂNCIA do service (nunca uma variável de módulo/global — cada `createProductPerformanceService`
// tem o seu, criado aqui só se o chamador não injetar um próprio para compartilhar entre requests
// no `cmd/`). Pior caso de cache frio é idêntico a não ter cache nenhum; nunca inventa dado.
// `relogio`: injetável (Rodada M §2) — por padrão `Date.now`, mas um teste de TTL pode passar um
// relógio controlado por ele mesmo (avança em milissegundos exatos, sem `setTimeout` real) pra
// nunca depender de quanto tempo uma chamada de banco de verdade levou. Sem isso, um TTL curto
// (ex.: 50ms) num teste corre risco real de expirar ENTRE duas chamadas que deveriam ser cache-hit,
// só porque a máquina estava ocupada — não é tolerância pra esconder corrida, é remover a corrida.
function createReportCache({ ttlMs = 15 * 60 * 1000, relogio = Date.now } = {}) {
  const cache = new Map(); // chave -> { linhas, expiraEm }
  // `escopoCache` (opcional, ver ga4/connector.js `getCacheScope`) entra na chave: property/conta
  // trocada dentro do TTL nunca reaproveita o relatório da anterior, mesmo com
  // organization/store/provider/período idênticos.
  const chaveDe = ({ organizationId, storeId, analyticsProvider, startDate, endDate, escopoCache }) =>
    [organizationId, storeId, analyticsProvider, startDate, endDate, escopoCache ?? ''].join('\u0000');

  async function obter(escopo, buscar) {
    const chave = chaveDe(escopo);
    const agora = relogio();
    const emCache = cache.get(chave);
    if (emCache && emCache.expiraEm > agora) return emCache.linhas;
    const linhas = await buscar();
    cache.set(chave, { linhas, expiraEm: agora + ttlMs });
    return linhas;
  }

  function limpar() { cache.clear(); }

  return Object.freeze({ obter, limpar });
}

module.exports = { createProductPerformanceService, createReportCache, METRICAS, calcularItemRatios, metricasZeradas };
