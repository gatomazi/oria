'use strict';

// Fase G · ProductPerformanceService — une catálogo canônico + métricas de analytics + Product
// Identity, SEM reconciliação com pedidos Commerce ainda (§6.1/§6.13 do comando: CommerceConnector
// ainda não tem `orders` no contrato novo; reconciliação fica para quando existir).
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

const { resolveAndPersist } = require('./product-identity-resolver');

const METRICAS = Object.freeze(['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue']);
const CAMPOS_CATALOGO = Object.freeze(['name', 'price', 'created_at', 'updated_at']);

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

/**
 * @param {{pool, registry, catalogRepository}} deps
 */
function createProductPerformanceService({ pool, registry, catalogRepository }) {
  if (!pool) throw new Error('createProductPerformanceService exige pool');
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createProductPerformanceService exige registry');
  if (!catalogRepository || typeof catalogRepository.listPage !== 'function') throw new Error('createProductPerformanceService exige catalogRepository');

  async function getProductPerformance(entrada) {
    validarEntrada(entrada);
    const { organizationId, storeId, analyticsProvider, startDate, endDate, filters = {}, sort = null, pagination = {} } = entrada;
    const namespace = `${analyticsProvider}.item_id`;

    // 1 (poucas, já paginadas dentro do connector) chamada de analytics para o período inteiro.
    const resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
    resolvido.require('productMetrics');
    const linhasAnalytics = await resolvido.connector.getProductPerformance({ startDate, endDate });

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
    for (const linha of linhasAnalytics) {
      const commerceProductId = produtoPorExternalId.get(linha.externalProductId);
      if (!commerceProductId) continue; // id observado sem produto canônico — não é problema do PRODUTO, é do id (coverage cobre isso)
      if (!metricasPorProduto.has(commerceProductId)) metricasPorProduto.set(commerceProductId, { metrics: metricasZeradas(), externalIds: new Set() });
      const acc = metricasPorProduto.get(commerceProductId);
      acc.externalIds.add(linha.externalProductId);
      for (const nome of METRICAS) acc.metrics[nome] = somarMetrica(acc.metrics[nome], linha[nome]);
    }

    // ── Escolha da página: catálogo (DB pagina) ou métrica (conjunto bounded pelos produtos com
    // alguma identity — nunca o catálogo inteiro em memória, §6.10). ──
    const ordenarPorMetrica = sort && !CAMPOS_CATALOGO.includes(sort.field);
    let produtosDaPagina;
    let nextCursor = null;
    let totalCount;
    if (ordenarPorMetrica) {
      const idsComMetrica = [...metricasPorProduto.keys()];
      const todos = await catalogRepository.getByIds({ organizationId, storeId, ids: idsComMetrica });
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
    }

    // Quais produtos da página JÁ têm identity conhecida (mesmo sem atividade no período — §6.8:
    // zero observado ≠ dado ausente). Um produto sem NENHUMA identity é `unmatched_identity`.
    const { rows: identidadesConhecidas } = await pool.query(
      `SELECT DISTINCT commerce_product_id FROM product_external_identities
        WHERE organization_id = $1 AND store_id = $2 AND namespace = $3 AND commerce_product_id = ANY($4::uuid[])`,
      [organizationId, storeId, namespace, produtosDaPagina.map((p) => p.id)]
    );
    const comIdentityConhecida = new Set(identidadesConhecidas.map((r) => r.commerce_product_id));

    // Métrica indisponível na propriedade: se NENHUMA linha observada trouxe valor para ela, é a
    // propriedade que não suporta — não o produto individual (Fase E já nunca inventa 0 aqui).
    const metricasIndisponiveis = METRICAS.filter((nome) => linhasAnalytics.every((l) => l[nome] === null));

    const items = produtosDaPagina.map((produto) => montarLinha(produto, metricasPorProduto.get(produto.id), comIdentityConhecida.has(produto.id), metricasIndisponiveis));

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
    rates: { addToCartRate: null, checkoutFromViewRate: null, cartToCheckoutRate: null, purchaseFromViewRate: null },
    identity: { matchedAnalyticsIds: [], status: 'unmatched' },
    diagnostics: [diagnostico],
  });
}

function montarLinha(produto, acumulado, temIdentityConhecida, metricasIndisponiveis) {
  const diagnostics = [];
  let metrics;
  let identityStatus;
  let matchedAnalyticsIds = [];

  if (acumulado) {
    metrics = { ...acumulado.metrics };
    matchedAnalyticsIds = [...acumulado.externalIds];
    identityStatus = 'matched';
    if (acumulado.externalIds.size > 1) diagnostics.push('multiple_analytics_identities');
  } else if (temIdentityConhecida) {
    // Identity conhecida, mas o id não apareceu em NENHUMA linha do período inteiro: zero real,
    // não ausência de dado (§6.8) — a Data API cobre a propriedade inteira, não filtra por item.
    metrics = metricasZeradas();
    identityStatus = 'matched';
  } else {
    metrics = null;
    identityStatus = 'unmatched';
    diagnostics.push('unmatched_identity');
  }

  if (metrics && metricasIndisponiveis.length) {
    for (const nome of metricasIndisponiveis) metrics[nome] = null;
    diagnostics.push('metric_unavailable');
  }

  return Object.freeze({
    product: produto,
    metrics: metrics ? Object.freeze(metrics) : null,
    rates: Object.freeze({
      addToCartRate: metrics ? taxa(metrics.itemsAddedToCart, metrics.itemsViewed) : null,
      checkoutFromViewRate: metrics ? taxa(metrics.itemsCheckedOut, metrics.itemsViewed) : null,
      cartToCheckoutRate: metrics ? taxa(metrics.itemsCheckedOut, metrics.itemsAddedToCart) : null,
      purchaseFromViewRate: metrics ? taxa(metrics.itemsPurchased, metrics.itemsViewed) : null,
    }),
    identity: Object.freeze({ matchedAnalyticsIds, status: identityStatus }),
    diagnostics: Object.freeze(diagnostics),
  });
}

function valorDoCampo(acumulado, campo) {
  if (METRICAS.includes(campo)) return acumulado ? acumulado.metrics[campo] : null;
  return null; // rates não são ordenáveis nesta fase (derivadas; ordenar por elas é UI futura)
}

function compararComNullPorUltimo(a, b, direcao) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // null sempre por último, em qualquer direção
  if (b === null) return -1;
  return direcao === 'desc' ? b - a : a - b;
}

module.exports = { createProductPerformanceService, METRICAS };
