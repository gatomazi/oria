'use strict';

// Fase E · GA4AnalyticsConnector — implementa o contrato `analytics` de lib/connectors/contracts.js.
//
// Fluxo de credencial (mesma ordem das Fases B/B.1/C, agora para GA4):
//
//   ConnectorContext → resolveIntegration() → ResolvedIntegration
//     → ConnectorSecretPort.use('refresh_token', …) → token-port.refreshAccessToken → Ga4Client
//
// `property_id` NÃO vem da integração: vem de `google_analytics_connections`, via
// `propertyRepository` (porta própria, §4.7) — a credencial (Organization) e a configuração da
// propriedade (Store) continuam separadas, do jeito que já eram no legado.
//
// O connector nunca importa `server.js` nem `lib/platform/integrations.js`; nunca lê
// `process.env` para credencial de tenant; nunca recebe/guarda/loga access token.

const { createGa4Client } = require('./client');
const { refreshAccessToken } = require('./token-port');
const { reportRequestBody, compatibilidadeRequestBody, METRICAS_PRODUTO, DIMENSION_ITEM_ID } = require('./queries');
const { mapReportRows } = require('./mapper');
const { ConnectorError, CODIGOS } = require('../../errors');
const secretGuard = require('../../../platform/secret-guard');

const CAPABILITIES = Object.freeze({ productMetrics: true, eventMetrics: false, realtime: false });

function normalizarErro(err) {
  throw err; // erroGoogle já classifica (RECONNECT_REQUIRED/PERMISSION_DENIED/RATE_LIMITED/…) — nada a reescrever
}

/**
 * @param {{context: Object, resolveIntegration: Function, secretPort: Object, propertyRepository: Object,
 *   fetchImpl?: Function, clientId?: string, clientSecret?: string}} deps
 * @returns {import('../../types').AnalyticsConnector & {getProductMetricCapabilities: Function}}
 */
function createGa4AnalyticsConnector({ context, resolveIntegration, secretPort, propertyRepository, fetchImpl, clientId, clientSecret }) {
  if (typeof resolveIntegration !== 'function') throw new Error('createGa4AnalyticsConnector exige resolveIntegration');
  if (!secretPort || typeof secretPort.forIntegration !== 'function') throw new Error('createGa4AnalyticsConnector exige secretPort');
  if (!propertyRepository || typeof propertyRepository.getProperty !== 'function') throw new Error('createGa4AnalyticsConnector exige propertyRepository');

  async function propriedadeDaChamada() {
    const propriedade = await propertyRepository.getProperty({ organizationId: context.organizationId, storeId: context.storeId });
    if (!propriedade) throw new ConnectorError('esta Store não tem propriedade GA4 configurada', CODIGOS.INTEGRATION_NOT_CONNECTED);
    return propriedade;
  }

  // Um access token por CHAMADA ao connector (não por request HTTP): resolve a integração, troca o
  // refresh_token por um access_token novo e devolve um Ga4Client que o reusa para metadata +
  // compatibility + todas as páginas do report — nunca um refresh a mais do que o necessário, nunca
  // guardado além do escopo da chamada.
  async function clienteDaChamada() {
    const integration = await resolveIntegration();
    const secrets = secretPort.forIntegration(context, integration);
    const accessToken = await secrets.use('refresh_token', async (refreshToken) => {
      const { accessToken: novo } = await refreshAccessToken({ refreshToken, clientId, clientSecret, fetchImpl });
      // O access token derivado é, ele também, um bearer credential — entra na mesma rede de
      // segurança do refresh token que o originou (INV-13), mesmo sem passar pelo secret store.
      secretGuard.registrar(novo);
      return novo;
    });
    return createGa4Client({ obterToken: (usar) => usar(accessToken), fetchImpl });
  }

  // Resolve integração+Store e propriedade UMA VEZ por chamada pública, nesta ordem: a integração
  // primeiro (porta B.1 valida Organization/Store antes de qualquer outra leitura tenant-scoped —
  // uma Store de outra Organization falha por CONNECTOR_INTEGRATION_TENANT_MISMATCH, nunca por
  // "propriedade não configurada", que seria a mensagem errada para esse caso). O cliente é
  // reaproveitado por metadata + compatibility + todas as páginas do report: nunca um refresh de
  // token a mais do que o necessário (§4.10 — sem refresh agressivo).
  async function resolverContexto() {
    const cliente = await clienteDaChamada();
    const propriedade = await propriedadeDaChamada();
    return { cliente, propriedade };
  }

  async function capacidadesCom(cliente, propriedade) {
    let metadata;
    let compat;
    try {
      metadata = await cliente.getMetadata(propriedade.propertyId);
      compat = await cliente.checkCompatibility(propriedade.propertyId, compatibilidadeRequestBody());
    } catch (err) {
      normalizarErro(err);
    }
    const dimsMetadata = new Set((metadata.dimensions || []).map((d) => d.apiName));
    const metricsMetadata = new Set((metadata.metrics || []).map((m) => m.apiName));
    const dimCompat = new Map((compat.dimensionCompatibilities || []).map((d) => [d.dimensionMetadata && d.dimensionMetadata.apiName, d.compatibility]));
    const metricCompat = new Map((compat.metricCompatibilities || []).map((m) => [m.metricMetadata && m.metricMetadata.apiName, m.compatibility]));

    const itemIdAvailable = dimsMetadata.has(DIMENSION_ITEM_ID) && dimCompat.get(DIMENSION_ITEM_ID) === 'COMPATIBLE';
    const metrics = {};
    for (const nome of METRICAS_PRODUTO) metrics[nome] = metricsMetadata.has(nome) && metricCompat.get(nome) === 'COMPATIBLE';
    // Query fundamental: itemId + itemsViewed. Sem ela, "não apto para Product Analytics" (§4.6) —
    // representado de forma estável (apt/reason), nunca um erro genérico nem métrica inventada.
    const apt = itemIdAvailable && metrics.itemsViewed === true;
    return Object.freeze({
      itemIdAvailable,
      metrics: Object.freeze({ ...metrics }),
      apt,
      reason: apt ? null : (!itemIdAvailable ? 'ITEM_ID_UNAVAILABLE' : 'ITEMS_VIEWED_UNAVAILABLE'),
    });
  }

  /**
   * Diagnóstico ANTES de assumir que a propriedade aceita a query fundamental (§4.2/§4.6). Não é
   * parte do contrato `AnalyticsConnector` genérico — é específico de quem precisa saber SE pode
   * perguntar por métricas de produto a esta propriedade, e com quais.
   */
  async function getProductMetricCapabilities() {
    const { cliente, propriedade } = await resolverContexto();
    return capacidadesCom(cliente, propriedade);
  }

  /**
   * Rodada H (cache HTTP) · discriminador barato (só leitura de `google_analytics_connections`,
   * nenhuma chamada à API do Google) pra quem cacheia `getProductPerformance` por fora nunca
   * reaproveitar o relatório de uma propriedade TROCADA dentro do mesmo TTL — reconectar a Store a
   * outra property (ou trocar de conta) precisa invalidar o cache mesmo sem o período mudar. Não é
   * parte do contrato `AnalyticsConnector` genérico (nenhum outro provider precisa disto pra ser
   * válido); quem cacheia trata a ausência do método como "sem discriminador extra, cache só por
   * escopo/período" (lib/product-analytics/product-performance-service.js).
   */
  async function getCacheScope() {
    // Sem propriedade configurada, `propriedadeDaChamada()` lança INTEGRATION_NOT_CONNECTED — o
    // MESMO erro que `getProductPerformance()` lançaria de qualquer forma; deixa propagar em vez de
    // mascarar com null (null pareceria "sem discriminador", não "sem conexão").
    const propriedade = await propriedadeDaChamada();
    return propriedade.propertyId;
  }

  /**
   * 1 (ou poucas, paginadas) chamada(s) `runReport` para o PERÍODO inteiro — nunca 1 por produto
   * (§4.9). `startDate`/`endDate` são ISO puro: a conversão para o formato da Data API (que aqui é
   * o mesmo ISO — GA4 aceita `YYYY-MM-DD` direto) fica só neste arquivo.
   */
  async function getProductPerformance({ startDate, endDate } = {}) {
    if (!startDate || !endDate) throw new TypeError('getProductPerformance exige startDate e endDate');
    if (String(startDate) > String(endDate)) throw new TypeError('startDate deve ser <= endDate');

    const { cliente, propriedade } = await resolverContexto();
    const capacidades = await capacidadesCom(cliente, propriedade);
    if (!capacidades.apt) {
      throw new ConnectorError(`propriedade GA4 não está apta para Product Analytics: ${capacidades.reason}`, `GA4_${capacidades.reason}`);
    }
    const metricasCompativeis = METRICAS_PRODUTO.filter((nome) => capacidades.metrics[nome]);

    const linhas = [];
    let offset = 0;
    let rowCount = Infinity;
    while (offset < rowCount) {
      const body = reportRequestBody({ startDate, endDate, metricas: metricasCompativeis, offset });
      let data;
      try {
        data = await cliente.runReport(propriedade.propertyId, body);
      } catch (err) {
        normalizarErro(err);
      }
      rowCount = Number.isFinite(Number(data.rowCount)) ? Number(data.rowCount) : (data.rows || []).length;
      const { linhas: paginaLinhas } = mapReportRows(data.rows, { metricasPedidas: metricasCompativeis, comItemName: true });
      linhas.push(...paginaLinhas);
      const recebidas = (data.rows || []).length;
      if (!recebidas) break; // sem linhas: não repete infinito mesmo se rowCount mentir
      offset += recebidas;
    }
    return linhas;
  }

  return Object.freeze({ getProductPerformance, getProductMetricCapabilities, getCacheScope });
}

module.exports = { createGa4AnalyticsConnector, CAPABILITIES };
