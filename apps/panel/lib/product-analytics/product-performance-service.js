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

  async function getProductPerformance(entrada) {
    validarEntrada(entrada);
    const { organizationId, storeId, analyticsProvider, startDate, endDate, filters = {}, sort = null, pagination = {} } = entrada;
    const namespace = `${analyticsProvider}.item_id`;

    // 1 (poucas, já paginadas dentro do connector) chamada de analytics para o período inteiro —
    // com ou sem cache, sempre uma chamada de DADOS por invocação do service (o cache, quando
    // usado, fica no ReportCache abaixo — nunca aqui um "if já busquei antes" ad hoc).
    const linhasAnalytics = await reportCache.obter({ organizationId, storeId, analyticsProvider, startDate, endDate }, async () => {
      const resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
      resolvido.require('productMetrics');
      return resolvido.connector.getProductPerformance({ startDate, endDate });
    });

    if (!linhasAnalytics.length) {
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
        coverage: { observedAnalyticsIds: 0, matchedAnalyticsIds: 0, unmatchedAnalyticsIds: 0, coverageRate: null, status: 'insufficient_data' },
      };
    }

    // Resolve (e persiste as novas regras determinísticas) os ids observados contra o catálogo.
    const idsObservados = [...new Set(linhasAnalytics.map((l) => l.externalProductId))];
    const resolucao = await resolveAndPersist({ pool }, { organizationId, storeId, namespace, externalIds: idsObservados });
    const produtoPorExternalId = new Map(resolucao.resolved.map((r) => [r.externalId, r.commerceProductId]));

    // Agrega por commerce_product_id — nunca por external id solto (§6.5: soma os que apontam pro
    // MESMO produto; sem informação para deduplicar entre ids diferentes, então soma e sinaliza).
    const metricasPorProduto = new Map(); // commerceProductId -> { metrics, externalIds: Set }
    const linhaZerada = (id) => {
      if (!metricasPorProduto.has(id)) metricasPorProduto.set(id, { metrics: metricasZeradas(), externalIds: new Set() });
      return metricasPorProduto.get(id);
    };
    for (const linha of linhasAnalytics) {
      const commerceProductId = produtoPorExternalId.get(linha.externalProductId);
      if (!commerceProductId) continue; // id observado sem produto canônico — não é problema do PRODUTO, é do id (coverage cobre isso)
      const acc = linhaZerada(commerceProductId);
      acc.externalIds.add(linha.externalProductId);
      for (const nome of METRICAS) acc.metrics[nome] = somarMetrica(acc.metrics[nome], linha[nome]);
    }

    // Métrica indisponível na propriedade inteira: se NENHUMA linha observada trouxe valor para
    // ela, é a propriedade que não suporta — não o produto individual (Fase E já nunca inventa 0
    // aqui). Nula em TODO produto do map, matched-zero incluído (nunca "0 travestido de sem suporte").
    const metricasIndisponiveis = METRICAS.filter((nome) => linhasAnalytics.every((l) => l[nome] === null));
    const aplicarIndisponiveis = () => { for (const rec of metricasPorProduto.values()) for (const nome of metricasIndisponiveis) rec.metrics[nome] = null; };

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
      for (const id of idsElegiveis) linhaZerada(id);
      aplicarIndisponiveis();
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
      for (const id of idsDaPagina) linhaZerada(id);
      aplicarIndisponiveis();
    }

    const items = produtosDaPagina.map((produto) => montarLinha(produto, metricasPorProduto.get(produto.id)));

    return {
      items, nextCursor, totalCount,
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

  return Object.freeze({ getProductPerformance });
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

  const itemRatios = {};
  for (const [nome, calc] of Object.entries(CAMPOS_RATIO)) itemRatios[nome] = calc(metrics);

  return Object.freeze({
    product: produto,
    metrics: Object.freeze(metrics),
    itemRatios: Object.freeze(itemRatios),
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
function createReportCache({ ttlMs = 15 * 60 * 1000 } = {}) {
  const cache = new Map(); // chave -> { linhas, expiraEm }
  const chaveDe = ({ organizationId, storeId, analyticsProvider, startDate, endDate }) =>
    [organizationId, storeId, analyticsProvider, startDate, endDate].join('\u0000');

  async function obter(escopo, buscar) {
    const chave = chaveDe(escopo);
    const agora = Date.now();
    const emCache = cache.get(chave);
    if (emCache && emCache.expiraEm > agora) return emCache.linhas;
    const linhas = await buscar();
    cache.set(chave, { linhas, expiraEm: agora + ttlMs });
    return linhas;
  }

  function limpar() { cache.clear(); }

  return Object.freeze({ obter, limpar });
}

module.exports = { createProductPerformanceService, createReportCache, METRICAS };
