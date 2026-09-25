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
const { CAMPO_MAIS_DADOS, normalizarFiltros, passaNosFiltrosDeMetrica, volumeDeDados } = require('./performance-filters');
const { condicaoDeStatus } = require('./commerce-catalog-repository');

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
// Rodada "Desempenho de Produtos: mais dados primeiro + filtros" · `sort.field === CAMPO_MAIS_DADOS`
// ('data', ver performance-filters.js): volume = visualizações + carrinho + checkout + compras; desempate
// por compras, checkout, carrinho e nome. O RESTO do catálogo vem depois, por nome — nunca escondido (o
// achado da Rodada J: ordenar só por métrica fazia o catálogo parecer vazio). A direção é sempre "mais
// primeiro"; `sortDir` não muda nada aqui.

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
async function idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, provider, apenasIds, status = 'synced' }) {
  if (apenasIds && !apenasIds.length) return [];
  const condicoes = ['pei.organization_id = $1', 'pei.store_id = $2', 'pei.namespace = $3'];
  // Mesma regra de situação do repositório do catálogo. O padrão é 'synced' (só `is_active`, o de sempre):
  // detalhe do produto, totais da Store e Prioridades de hoje NÃO podem perder a identity de um produto só
  // porque ele não está publicado — quem quer "só publicados" (a listagem) pede 'active' explicitamente.
  const condStatus = condicaoDeStatus(status, 'cp');
  if (condStatus) condicoes.push(condStatus);
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
    const { organizationId, storeId, analyticsProvider, startDate, endDate, sort = null, pagination = {} } = entrada;
    const filtros = normalizarFiltros(entrada.filters || {});
    const namespace = `${analyticsProvider}.item_id`;

    // Gate 1 · o trabalho por PERÍODO (relatório + resolução + agregação) é sempre computado UMA
    // VEZ aqui — se `entrada.aggregation` já veio pronto (reconciliation.js pagina o catálogo
    // MUITAS vezes pro mesmo período; passar a MESMA agregação evita recomputar a cada página —
    // ver reconciliation.js), reaproveita; sem ele, computa na hora (o caminho de sempre, usado pela
    // rota HTTP — nenhuma mudança de contrato pra quem já chama sem esse campo).
    const agregacao = entrada.aggregation || await prepareStoreAnalytics({ organizationId, storeId, analyticsProvider, startDate, endDate });
    const { idsObservados, metricasPorProduto, coverage } = agregacao;
    const limite = pagination.limit || 50;
    // `search` (palavras do nome) só existe com busca por nome ativa — e aí `status` já veio 'all'.
    const base = {
      organizationId, storeId, provider: filtros.provider, status: filtros.status, search: filtros.busca ? filtros.busca.termos : undefined,
    };

    if (!idsObservados.length) {
      // Sem NENHUMA linha no período: não dá pra distinguir "zero de verdade" de "sem cobertura" —
      // representado no nível da resposta, não inventado por produto (§6.8/§5.8). Sem dado nenhum,
      // nenhum produto satisfaz "mínimo de X" nem "somente com dados": a resposta é vazia, honesta.
      if (filtros.temFiltroDeMetrica) return { items: [], nextCursor: null, totalCount: 0, coverage };
      // Só um campo do PRÓPRIO catálogo leva a direção pedida; métrica/ratio/"mais dados" não têm
      // significado sem dado, então caem em nome ascendente (a direção "desc" de uma métrica não pode
      // virar Z→A por vazamento).
      const porCatalogo = !!sort && CAMPOS_CATALOGO.includes(sort.field);
      const pagina = await catalogRepository.listPage({
        ...base, cursor: pagination.cursor, limit: limite,
        sortBy: porCatalogo ? sort.field : 'name', sortDir: porCatalogo ? sort.direction : 'asc',
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
    const campoPedido = sort && sort.field;
    // Com busca por nome, ordenar por métrica/ratio cairia no contrato da Fase G.1 (só quem tem
    // identity no GA4 entra) e ESCONDERIA produtos que a busca deveria achar — então vira "mais dados
    // primeiro", que lista todos os que casam. Campo do catálogo (nome…) segue valendo.
    const campo = filtros.busca && campoPedido && CAMPOS_ORDENAVEIS_METRICA.includes(campoPedido) ? CAMPO_MAIS_DADOS : campoPedido;
    const ordenarPorMetrica = !!campo && CAMPOS_ORDENAVEIS_METRICA.includes(campo);
    const ordenarPorMaisDados = campo === CAMPO_MAIS_DADOS;
    const pagina = pagination.cursor ? Number(pagination.cursor) : 1;
    if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('cursor inválido');
    const inicio = (pagina - 1) * limite;
    let produtosDaPagina;
    let nextCursor = null;
    let totalCount;

    if (ordenarPorMaisDados) {
      // Segmento 1 (em memória): produtos COM dado no período que passam nos filtros, do maior volume
      // pro menor. Segmento 2 (banco): o resto do catálogo, por nome — só quando não há filtro de
      // métrica (com "mínimo"/"somente com dados" a cauda, por definição, não satisfaz o filtro).
      // Uma paginação só percorre os dois em sequência: a página N cobre [inicio, inicio+limite) da
      // lista concatenada — o cursor continua sendo só o número da página.
      //
      // `rankingExtra` (só interno, como `aggregation`; nunca vem do HTTP): volume que NÃO vem do GA4
      // e entra no ranking — a reconciliação soma as unidades vendidas no Commerce, pra um produto
      // que vendeu mas o GA4 nunca viu não cair no fim da fila.
      const extra = entrada.rankingExtra instanceof Map ? entrada.rankingExtra : null;
      const metricasDe = (id) => (metricasPorProduto.get(id) ? metricasPorProduto.get(id).metrics : null);
      const volumeDe = (id) => volumeDeDados(metricasDe(id)) + ((extra && extra.get(id)) || 0);
      const comDado = new Set(metricasPorProduto.keys());
      if (extra) for (const id of extra.keys()) comDado.add(id);
      const candidatos = [...comDado].filter((id) => volumeDe(id) > 0 && passaNosFiltrosDeMetrica(metricasPorProduto.get(id), filtros));
      const produtos = await catalogRepository.getByIds({ ...base, ids: candidatos });
      produtos.sort((a, b) => {
        const ma = metricasDe(a.id) || {};
        const mb = metricasDe(b.id) || {};
        return (volumeDe(b.id) - volumeDe(a.id))
          || ((mb.itemsPurchased || 0) - (ma.itemsPurchased || 0))
          || ((mb.itemsCheckedOut || 0) - (ma.itemsCheckedOut || 0))
          || ((mb.itemsAddedToCart || 0) - (ma.itemsAddedToCart || 0))
          || String(a.name).localeCompare(String(b.name), 'pt-BR');
      });
      const rankeados = produtos.length;
      produtosDaPagina = produtos.slice(inicio, inicio + limite);
      let caudaTotal = 0;
      if (!filtros.temFiltroDeMetrica) {
        const faltam = limite - produtosDaPagina.length;
        // Uma consulta só pra cauda: traz a contagem (sempre) e as linhas que faltam pra encher a página.
        const cauda = await catalogRepository.listPage({
          ...base, excludeIds: produtos.map((p) => p.id), sortBy: 'name', sortDir: 'asc',
          limit: Math.max(faltam, 1), offset: Math.max(0, inicio - rankeados),
        });
        caudaTotal = cauda.totalCount;
        if (faltam > 0) produtosDaPagina = [...produtosDaPagina, ...cauda.items];
      }
      totalCount = rankeados + caudaTotal;
      nextCursor = inicio + produtosDaPagina.length < totalCount ? String(pagina + 1) : null;
    } else if (ordenarPorMetrica) {
      const idsElegiveis = await idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, provider: filtros.provider, status: filtros.status });
      for (const id of idsElegiveis) agregacao.linhaZerada(id);
      const candidatos = [...metricasPorProduto.keys()].filter((id) => passaNosFiltrosDeMetrica(metricasPorProduto.get(id), filtros));
      const todos = await catalogRepository.getByIds({ ...base, ids: candidatos });
      const valorDeOrdenacao = (produto) => valorDoCampo(metricasPorProduto.get(produto.id), campo);
      todos.sort((a, b) => compararComNullPorUltimo(valorDeOrdenacao(a), valorDeOrdenacao(b), sort.direction));
      totalCount = todos.length;
      produtosDaPagina = todos.slice(inicio, inicio + limite);
      nextCursor = inicio + produtosDaPagina.length < totalCount ? String(pagina + 1) : null;
    } else if (filtros.temFiltroDeMetrica) {
      // Ordenação por campo do catálogo + filtro de métrica: o filtro só existe em memória, então o
      // conjunto de ids que passou vira `onlyIds` e o BANCO continua ordenando/paginando pela coluna.
      const candidatos = [...metricasPorProduto.keys()].filter((id) => passaNosFiltrosDeMetrica(metricasPorProduto.get(id), filtros));
      const paginaCatalogo = await catalogRepository.listPage({
        ...base, onlyIds: candidatos, cursor: pagination.cursor, limit: limite,
        sortBy: campo || 'name', sortDir: sort && sort.direction,
      });
      produtosDaPagina = paginaCatalogo.items;
      nextCursor = paginaCatalogo.nextCursor;
      totalCount = paginaCatalogo.totalCount;
    } else {
      const paginaCatalogo = await catalogRepository.listPage({
        ...base, cursor: pagination.cursor, limit: limite,
        sortBy: campo || 'name', sortDir: sort && sort.direction,
      });
      produtosDaPagina = paginaCatalogo.items;
      nextCursor = paginaCatalogo.nextCursor;
      totalCount = paginaCatalogo.totalCount;
    }

    // Identity conhecida só para os produtos DESTA página que ainda não têm linha de métrica (a cauda
    // do "mais dados", ou uma página do catálogo por nome) — nunca a Store inteira: é o caminho comum
    // de navegação e tem que ficar barato mesmo com um catálogo grande. Quem já tem métrica no Map
    // tem identity por definição. Os ids já vieram filtrados por situação, então aqui não refiltra.
    const semMetrica = produtosDaPagina.filter((p) => !metricasPorProduto.has(p.id)).map((p) => p.id);
    if (semMetrica.length) {
      const idsComIdentity = await idsComIdentidadeResolvida({ pool, organizationId, storeId, namespace, status: 'all', apenasIds: semMetrica });
      for (const id of idsComIdentity) agregacao.linhaZerada(id);
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
