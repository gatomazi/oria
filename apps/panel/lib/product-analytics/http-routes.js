'use strict';

// Fase H (rodada H→I) · superfície HTTP tenant-safe de Product Analytics.
//
// Montado em server.js com UM require + UM `app.use(..., requireAdmin, router)` (ver
// lib/platform/feature-routes.js → ROTAS, que já amarra este prefixo à feature
// `analytics_product_performance`): `requireAdmin` já resolve auth (401), Organization/Store da
// SESSÃO (nunca do cliente — `TENANT_SELECTOR_NOT_ALLOWED` se o request tentar informar um) e o
// entitlement (403) antes de qualquer handler daqui rodar. Nenhum destes handlers reimplementa
// isso.
//
// `organizationId`/`storeId` vêm SEMPRE de `req.tenant` (lib/platform/tenant-pipeline.js —
// derivado da sessão), nunca de query/body/header: é o mesmo motivo pelo qual `seletoresNoRequest`
// já rejeita esses campos antes de chegar aqui.

const express = require('express');
const { ConnectorError, CODIGOS } = require('../connectors/errors');
const { CAMPO_MAIS_DADOS, MINIMOS, normalizarFiltros } = require('./performance-filters');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAMPOS_CATALOGO = Object.freeze(['name', 'price', 'created_at', 'updated_at']);
const CAMPOS_METRICA = Object.freeze(['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue']);
const CAMPOS_RATIO = Object.freeze(['itemsAddedToCartPerItemViewed', 'itemsCheckedOutPerItemViewed', 'itemsCheckedOutPerItemAddedToCart', 'itemsPurchasedPerItemViewed']);
// CAMPO_MAIS_DADOS ('data') = "mais dados primeiro" — pseudo-campo, ver performance-filters.js.
const CAMPOS_SORT_VALIDOS = Object.freeze([...CAMPOS_CATALOGO, ...CAMPOS_METRICA, ...CAMPOS_RATIO, CAMPO_MAIS_DADOS]);
const LIMITE_MAXIMO = 200;

class EntradaInvalidaError extends TypeError {}

function validarPeriodo(query) {
  const { startDate, endDate } = query;
  if (!DATA_ISO_RE.test(String(startDate || ''))) throw new EntradaInvalidaError('startDate inválido (esperado YYYY-MM-DD)');
  if (!DATA_ISO_RE.test(String(endDate || ''))) throw new EntradaInvalidaError('endDate inválido (esperado YYYY-MM-DD)');
  if (String(startDate) > String(endDate)) throw new EntradaInvalidaError('startDate deve ser <= endDate');
  return { startDate: String(startDate), endDate: String(endDate) };
}

function validarPaginacao(query) {
  let limit;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIMITE_MAXIMO) {
      throw new EntradaInvalidaError(`limit deve ser um inteiro entre 1 e ${LIMITE_MAXIMO}`);
    }
  }
  // cursor é OPACO pro cliente (o service decide o formato) — só valida que é uma string curta,
  // nunca interpreta o conteúdo aqui.
  let cursor;
  if (query.cursor !== undefined) {
    cursor = String(query.cursor);
    if (!cursor || cursor.length > 32) throw new EntradaInvalidaError('cursor inválido');
  }
  return { limit, cursor };
}

function validarSort(query) {
  if (query.sort === undefined) return null;
  const field = String(query.sort);
  if (!CAMPOS_SORT_VALIDOS.includes(field)) {
    throw new EntradaInvalidaError(`sort inválido: ${field} (permitidos: ${CAMPOS_SORT_VALIDOS.join(', ')})`);
  }
  const direction = query.sortDir === 'asc' ? 'asc' : 'desc';
  return { field, direction };
}

// Rodada L §2.3/§3 · providerOrderId do Commerce — mesma disciplina de "opaco pro cliente, nunca
// interpretado aqui" já usada pra `cursor` (validarPaginacao): só forma, nunca conteúdo. Charset
// permissivo o bastante pro id de qualquer CommerceConnector (numérico como a Ink, ou alfanumérico
// de outro provider) sem abrir espaço pra payload gigante em log/erro.
const PROVIDER_ORDER_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function validarProviderOrderId(query) {
  const valor = query.providerOrderId;
  if (typeof valor !== 'string' || !PROVIDER_ORDER_ID_RE.test(valor)) {
    throw new EntradaInvalidaError('providerOrderId inválido');
  }
  return valor;
}

function validarFilters(query) {
  const filters = {};
  // `provider` é passthrough pro repositório de catálogo (Fase D já filtra por ele de verdade —
  // §H.2 "filtros... somente quando o repositório oferecer suporte real"); provider desconhecido
  // não é erro, só devolve conjunto vazio — o mesmo comportamento de um filtro de nome sem match.
  if (query.provider !== undefined) {
    const provider = String(query.provider).trim();
    if (!provider || provider.length > 60) throw new EntradaInvalidaError('provider inválido');
    filters.provider = provider;
  }

  // Rodada "Desempenho de Produtos: mais dados primeiro + filtros" · status do catálogo, mínimos por
  // métrica e "somente com dados". Só forma aqui (string → número/boolean, nunca array nem lixo); a
  // regra de valor (>= 0, status conhecido) é a MESMA do service (performance-filters.js).
  const texto = (chave) => {
    const valor = query[chave];
    if (valor === undefined) return undefined;
    if (typeof valor !== 'string') throw new EntradaInvalidaError(`${chave} inválido`);
    return valor.trim();
  };
  const status = texto('status');
  if (status !== undefined) filters.status = status;
  for (const chave of Object.keys(MINIMOS)) {
    const bruto = texto(chave);
    if (bruto === undefined || bruto === '') continue;
    const numero = Number(bruto);
    if (!Number.isFinite(numero) || numero < 0) throw new EntradaInvalidaError(`${chave} deve ser um número maior ou igual a 0`);
    filters[chave] = numero;
  }
  const hasData = texto('hasData');
  if (hasData !== undefined && hasData !== '') {
    if (hasData !== 'true' && hasData !== 'false') throw new EntradaInvalidaError('hasData deve ser true ou false');
    filters.hasData = hasData === 'true';
  }
  try {
    normalizarFiltros(filters);
  } catch (err) {
    throw new EntradaInvalidaError(err.message);
  }
  return filters;
}

// Gate C ("Jornada de Valor") · `limit` de /journey/opportunities — mesma disciplina de
// validarPaginacao acima (inteiro, faixa fechada), teto BEM menor: "Prioridades de hoje" é curto de
// propósito (nunca uma tabela técnica disfarçada de lista curta).
function validarLimiteOportunidades(query) {
  if (query.limit === undefined) return undefined;
  const limit = Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new EntradaInvalidaError('limit deve ser um inteiro entre 1 e 20');
  return limit;
}

function erroValidacao(res, err) {
  return res.status(400).json({ error: err.message, codigo: 'PRODUCT_ANALYTICS_INVALID_INPUT' });
}

// ConnectorError (lib/connectors/errors.js) e IntegracaoError (lib/platform/integrations.js —
// lançado pela porta B.1, connector-integration-port.js, para INTEGRATION_NOT_CONNECTED e
// INTEGRATION_INTEGRITY_ERROR) são DUAS classes diferentes, mas as duas já vêm com mensagem segura
// (nunca token/segredo, consistente em toda a Fase B→H) e código estável — a checagem é por
// duck-typing em `.codigo` (e `.status`, quando a própria origem já decidiu qual — IntegracaoError
// decide 409/500 por si; ConnectorError não carrega status, a rota assume 409 pra ela: connector
// sempre nega por estado de integração, nunca por erro do servidor). A rota nunca reescreve a
// mensagem. "não conectado"/"não apto" são estados operacionais estáveis, não falha do servidor.
function mapearErro(err, res) {
  if (err instanceof EntradaInvalidaError) return erroValidacao(res, err);
  if (err instanceof TypeError) return erroValidacao(res, err);
  if (err instanceof ConnectorError || (err && typeof err.codigo === 'string')) {
    const status = Number.isInteger(err.status) ? err.status : 409;
    return res.status(status).json({ error: err.message, codigo: err.codigo });
  }
  console.error(`[PRODUCT_ANALYTICS] erro inesperado: ${err.message}`);
  return res.status(500).json({ error: 'não foi possível completar a operação' });
}

/**
 * @param {{productPerformanceService, reconciliationService, journeyAnalyticsService, opportunityDiagnosticsService?, registry, analyticsProvider: string, commerceProvider: string, syncCommerceCatalog?: Function, cancelCommerceCatalogSync?: Function, getCommerceCatalogSyncStatus?: Function}} deps
 *   `syncCommerceCatalog`/`getCommerceCatalogSyncStatus`: Rodada M — opcionais de propósito (fica
 *   compatível com quem monta o router sem essas duas, ex.: um teste antigo); sem elas, as rotas de
 *   sincronização do catálogo simplesmente não são registradas.
 *   `cancelCommerceCatalogSync`: Rodada "Observabilidade e controle do catalog sync" — kill switch
 *   da tela; mesmo padrão opcional, sem ele POST /catalog-sync/cancelar não é registrada.
 *   `opportunityDiagnosticsService`: Gate C ("Jornada de Valor") — mesmo padrão opcional; sem ele,
 *   GET /journey/opportunities não é registrada.
 * @returns {import('express').Router}
 */
function createProductAnalyticsRouter({
  productPerformanceService, reconciliationService, journeyAnalyticsService, opportunityDiagnosticsService, registry, analyticsProvider, commerceProvider,
  syncCommerceCatalog, cancelCommerceCatalogSync, getCommerceCatalogSyncStatus,
}) {
  if (!productPerformanceService || typeof productPerformanceService.getProductPerformance !== 'function' || typeof productPerformanceService.getProductPerformanceSummary !== 'function') {
    throw new Error('createProductAnalyticsRouter exige productPerformanceService');
  }
  if (!reconciliationService || typeof reconciliationService.reconcileProductPerformance !== 'function') {
    throw new Error('createProductAnalyticsRouter exige reconciliationService');
  }
  if (!journeyAnalyticsService || typeof journeyAnalyticsService.getJourneyAnalytics !== 'function' || typeof journeyAnalyticsService.checkOrderTransactionLink !== 'function') {
    throw new Error('createProductAnalyticsRouter exige journeyAnalyticsService (getJourneyAnalytics + checkOrderTransactionLink)');
  }
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createProductAnalyticsRouter exige registry');
  if (!analyticsProvider || !commerceProvider) throw new Error('createProductAnalyticsRouter exige analyticsProvider e commerceProvider');

  const router = express.Router();

  // Rodada M · proteção só de PROCESSO (nunca substitui o lease real em Postgres — que sobrevive a
  // restart/múltiplas instâncias; isto aqui só evita disparar duas vezes por um clique duplo antes
  // do primeiro fire-and-forget nem ter terminado de chamar `syncCommerceCatalog`).
  const catalogSyncEmAndamento = new Set();

  // Estado da conexão GA4 — read-only, nenhum request de dados (só metadata/compatibility, sem
  // runReport), pra UI decidir o que renderizar ANTES de pedir período/relatório.
  router.get('/status', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      const resolvido = registry.resolve('analytics', analyticsProvider, { organizationId, storeId });
      if (typeof resolvido.connector.getProductMetricCapabilities !== 'function') {
        return res.json({ analytics: { provider: analyticsProvider, connected: true, apt: null, reason: null, metrics: null } });
      }
      const cap = await resolvido.connector.getProductMetricCapabilities();
      return res.json({ analytics: { provider: analyticsProvider, connected: true, apt: cap.apt, reason: cap.reason, metrics: cap.metrics } });
    } catch (err) {
      // INTEGRATION_NOT_CONNECTED pode vir como ConnectorError OU IntegracaoError (a porta B.1
      // lança a segunda — ver mapearErro abaixo) — checagem por código, não por classe.
      if (err && err.codigo === CODIGOS.INTEGRATION_NOT_CONNECTED) {
        // Estado NORMAL (desconectado), não erro — 200, nunca 500/409 pra este caso específico:
        // a UI precisa distinguir "não configurado ainda" de "erro ao consultar".
        return res.json({ analytics: { provider: analyticsProvider, connected: false, apt: false, reason: 'not_connected', metrics: null } });
      }
      return mapearErro(err, res);
    }
  });

  // Rodada J.4 · totais STORE-WIDE do período (nunca só a página visível) — reaproveita o MESMO
  // relatório cacheado que /products usa. `observed` (todo itemId do GA4) e `matched` (só o que
  // resolveu a produto canônico) vêm SEMPRE os dois, nunca um escondendo o outro.
  router.get('/summary', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      const { startDate, endDate } = validarPeriodo(req.query);
      const filters = validarFilters(req.query);
      const r = await productPerformanceService.getProductPerformanceSummary({ organizationId, storeId, analyticsProvider, startDate, endDate, filters });
      return res.json(r);
    } catch (err) {
      return mapearErro(err, res);
    }
  });

  router.get('/coverage', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      const { startDate, endDate } = validarPeriodo(req.query);
      const r = await productPerformanceService.getProductPerformance({
        organizationId, storeId, analyticsProvider, startDate, endDate, pagination: { limit: 1 },
      });
      return res.json({ coverage: r.coverage });
    } catch (err) {
      return mapearErro(err, res);
    }
  });

  router.get('/products', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      const { startDate, endDate } = validarPeriodo(req.query);
      const { limit, cursor } = validarPaginacao(req.query);
      const sort = validarSort(req.query);
      const filters = validarFilters(req.query);
      const r = await productPerformanceService.getProductPerformance({
        organizationId, storeId, analyticsProvider, startDate, endDate, filters, sort, pagination: { limit, cursor },
      });
      return res.json(r);
    } catch (err) {
      return mapearErro(err, res);
    }
  });

  router.get('/products/:productId', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      if (!UUID_RE.test(req.params.productId)) return erroValidacao(res, new EntradaInvalidaError('productId inválido (esperado UUID)'));
      const { startDate, endDate } = validarPeriodo(req.query);
      const r = await productPerformanceService.getProductPerformanceById({
        organizationId, storeId, analyticsProvider, startDate, endDate, productId: req.params.productId,
      });
      if (!r) return res.status(404).json({ error: 'produto não encontrado', codigo: 'PRODUCT_NOT_FOUND' });
      return res.json(r);
    } catch (err) {
      return mapearErro(err, res);
    }
  });

  router.get('/reconciliation', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      const { startDate, endDate } = validarPeriodo(req.query);
      const r = await reconciliationService.reconcileProductPerformance({
        organizationId, storeId, commerceProvider, analyticsProvider, startDate, endDate,
      });
      return res.json(r);
    } catch (err) {
      return mapearErro(err, res);
    }
  });

  // Rodada K · Journey Analytics — funil/aquisição/Meta Ads/Commerce agregados (tier1), correlação
  // transactionId↔pedido quando a propriedade GA4 sustentar (tier2), e o estado (sempre `unavailable`
  // nesta rodada) de uma futura jornada individual (tier3) — nunca 500 por uma camada indisponível,
  // cada tier reporta o próprio `available`/`reason`.
  router.get('/journey', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      const { startDate, endDate } = validarPeriodo(req.query);
      const r = await journeyAnalyticsService.getJourneyAnalytics({ organizationId, storeId, startDate, endDate });
      return res.json(r);
    } catch (err) {
      return mapearErro(err, res);
    }
  });

  // Rodada L §2.3 · verificação SOB DEMANDA de 1 pedido (nunca a carga inicial de /journey, que só
  // amostra — ver journey-analytics-service.js). A UI chama isto quando o usuário seleciona um
  // pedido específico na tabela de correlação: 1 chamada ao Commerce + 1 ao GA4, nunca mais.
  router.get('/journey/transaction-link', async (req, res) => {
    const { organizationId, storeId } = req.tenant;
    try {
      const { startDate, endDate } = validarPeriodo(req.query);
      const providerOrderId = validarProviderOrderId(req.query);
      const r = await journeyAnalyticsService.checkOrderTransactionLink({ organizationId, storeId, startDate, endDate, providerOrderId });
      return res.json(r);
    } catch (err) {
      return mapearErro(err, res);
    }
  });

  // Gate C ("Jornada de Valor") · "Prioridades de hoje" — lista curta e ORDENADA de diagnósticos com
  // evidência, hipótese e CTA (ver opportunity-diagnostics.js). Reaproveita o MESMO ReportCache de
  // productPerformanceService/reconciliationService — nenhuma chamada nova ao GA4/Ink por trás desta
  // rota. Nunca 409/500 por uma fonte desconectada: `sources` reporta GA4/Commerce separadamente,
  // `opportunities` fica vazio (nunca erro) quando nenhuma fonte sustenta um sinal.
  if (opportunityDiagnosticsService) {
    router.get('/journey/opportunities', async (req, res) => {
      const { organizationId, storeId } = req.tenant;
      try {
        const { startDate, endDate } = validarPeriodo(req.query);
        const limit = validarLimiteOportunidades(req.query);
        const r = await opportunityDiagnosticsService.getOpportunities({ organizationId, storeId, startDate, endDate, limit });
        return res.json(r);
      } catch (err) {
        return mapearErro(err, res);
      }
    });
  }

  // Rodada M · achado real: `commerce_products` (o catálogo canônico que Desempenho de Produtos e a
  // Correlação de identidade dependem) nunca tinha um jeito de ser sincronizado em produção — só
  // rodava em teste (ver lib/product-analytics/catalog-sync.js). Sem isto, QUALQUER Organization com
  // GA4/Ink conectados e dado real nos dois nunca resolve identidade nenhuma — "0 produtos no
  // catálogo" mesmo com milhares de itens observados. Dispara e responde na hora (a varredura é
  // paginada, centenas/milhares de páginas, minutos — nunca síncrono numa resposta HTTP); quem
  // acompanha é o polling de `/catalog-sync/status`. Mesmo padrão de fire-and-forget que
  // `/api/admin/produtos/catalogo/sync` já usa pro cache separado de Produtos.
  if (syncCommerceCatalog) {
    router.post('/catalog-sync', async (req, res) => {
      const { organizationId, storeId } = req.tenant;
      if (catalogSyncEmAndamento.has(organizationId)) {
        return res.json({ ok: true, status: 'already_running' });
      }
      catalogSyncEmAndamento.add(organizationId);
      syncCommerceCatalog({ organizationId, storeId })
        .catch((err) => console.error(`[PRODUCT_ANALYTICS] catalog-sync falhou: ${err.message}`))
        .finally(() => catalogSyncEmAndamento.delete(organizationId));
      return res.json({ ok: true, status: 'started' });
    });
  }

  // Kill switch da tela ("Observabilidade e controle do catalog sync") — achado real de dogfooding
  // (Use Sul, 2026-09-24): sem isto, um sync travado só libera sozinho depois do TTL do lease (3h) e
  // não existe jeito de saber, só pelo `/catalog-sync/status`, se ainda está rodando de verdade ou
  // se o processo caiu. NUNCA mata o processo Node — só libera a trava e marca a linha como
  // cancelada; ver o cabeçalho de `cancelarCatalogSync` em catalog-sync.js pro que isso garante e o
  // que não garante. Também limpa o guard em memória (`catalogSyncEmAndamento`) pra um novo clique
  // em "Sincronizar" não voltar `already_running` por causa de uma promise antiga ainda pendente
  // NESTE processo — o lease real (Postgres) é que decide se dá pra começar de verdade.
  if (cancelCommerceCatalogSync) {
    router.post('/catalog-sync/cancelar', async (req, res) => {
      const { organizationId, storeId } = req.tenant;
      try {
        const r = await cancelCommerceCatalogSync({ organizationId, storeId });
        catalogSyncEmAndamento.delete(organizationId);
        return res.json(r);
      } catch (err) {
        return mapearErro(err, res);
      }
    });
  }

  if (getCommerceCatalogSyncStatus) {
    router.get('/catalog-sync/status', async (req, res) => {
      const { organizationId, storeId } = req.tenant;
      try {
        const ultimoRun = await getCommerceCatalogSyncStatus({ organizationId, storeId });
        // Gate A ("Jornada de Valor Operacional") · o Set em processo (catalogSyncEmAndamento) só
        // enxerga o que ESTA rota disparou (clique manual) — o scheduler automático e o gatilho de
        // conexão (server.js) chamam `syncCommerceCatalog` direto, sem passar por ele. `rodandoNoLog`
        // é o sinal REAL (commerce_catalog_sync_logs, escrito pelo próprio runCatalogSync ANTES de
        // qualquer trabalho — cross-process, verdadeiro não importa quem disparou nem quantas
        // instâncias do servidor existam). `syncing` combina os dois: o Set cobre só a janela ínfima
        // entre o fire-and-forget e o primeiro INSERT do log.
        //
        // `state`: a taxonomia do comando — never_synced/queued/running/completed/partial_failure/
        // failed/cancelled — nunca um status cru do banco sem rótulo pra UI decidir sozinha.
        const emProcesso = catalogSyncEmAndamento.has(organizationId);
        const rodandoNoLog = !!ultimoRun && ultimoRun.status === 'running';
        const syncing = emProcesso || rodandoNoLog;
        const state = !ultimoRun
          ? (emProcesso ? 'queued' : 'never_synced')
          : rodandoNoLog ? 'running'
            : ultimoRun.status === 'success' ? 'completed' : ultimoRun.status; // 'partial_failure' | 'failed'
        return res.json({
          syncing, state,
          lastRun: ultimoRun && {
            status: ultimoRun.status,
            startedAt: ultimoRun.started_at,
            finishedAt: ultimoRun.finished_at,
            pagesProcessed: ultimoRun.pages_processed,
            pagesTotal: ultimoRun.pages_total,
            productsSeen: ultimoRun.products_seen,
            productsInserted: ultimoRun.products_inserted,
            productsUpdated: ultimoRun.products_updated,
            productsDeactivated: ultimoRun.products_deactivated,
            errorCode: ultimoRun.error_code,
          },
        });
      } catch (err) {
        return mapearErro(err, res);
      }
    });
  }

  return router;
}

module.exports = { createProductAnalyticsRouter, CAMPOS_SORT_VALIDOS };
