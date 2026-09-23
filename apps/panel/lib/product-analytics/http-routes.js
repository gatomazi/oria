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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const CAMPOS_CATALOGO = Object.freeze(['name', 'price', 'created_at', 'updated_at']);
const CAMPOS_METRICA = Object.freeze(['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue']);
const CAMPOS_RATIO = Object.freeze(['itemsAddedToCartPerItemViewed', 'itemsCheckedOutPerItemViewed', 'itemsCheckedOutPerItemAddedToCart', 'itemsPurchasedPerItemViewed']);
const CAMPOS_SORT_VALIDOS = Object.freeze([...CAMPOS_CATALOGO, ...CAMPOS_METRICA, ...CAMPOS_RATIO]);
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
  return filters;
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
 * @param {{productPerformanceService, reconciliationService, journeyAnalyticsService, registry, analyticsProvider: string, commerceProvider: string}} deps
 * @returns {import('express').Router}
 */
function createProductAnalyticsRouter({ productPerformanceService, reconciliationService, journeyAnalyticsService, registry, analyticsProvider, commerceProvider }) {
  if (!productPerformanceService || typeof productPerformanceService.getProductPerformance !== 'function' || typeof productPerformanceService.getProductPerformanceSummary !== 'function') {
    throw new Error('createProductAnalyticsRouter exige productPerformanceService');
  }
  if (!reconciliationService || typeof reconciliationService.reconcileProductPerformance !== 'function') {
    throw new Error('createProductAnalyticsRouter exige reconciliationService');
  }
  if (!journeyAnalyticsService || typeof journeyAnalyticsService.getJourneyAnalytics !== 'function') {
    throw new Error('createProductAnalyticsRouter exige journeyAnalyticsService');
  }
  if (!registry || typeof registry.resolve !== 'function') throw new Error('createProductAnalyticsRouter exige registry');
  if (!analyticsProvider || !commerceProvider) throw new Error('createProductAnalyticsRouter exige analyticsProvider e commerceProvider');

  const router = express.Router();

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

  return router;
}

module.exports = { createProductAnalyticsRouter, CAMPOS_SORT_VALIDOS };
