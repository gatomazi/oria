'use strict';

// Fase H (rodada H→I) · monta os serviços de Product Analytics UMA VEZ por processo.
//
// Risco de integração explícito no comando: se a factory do ProductPerformanceService (e o
// ReportCache dela) fosse criada a cada request, o TTL de 15 min nunca produziria reuso nenhum
// entre páginas/requests — seria o mesmo custo de não ter cache. Por isso este módulo é chamado
// UMA VEZ no bootstrap do servidor (server.js) e o resultado (registry/services) vive pelo
// processo inteiro — o mesmo ciclo de vida de `pgPool`/`CHAVEIRO` no próprio server.js.
//
// Isolamento entre tenants/properties não depende de recriar o service por Organization: o
// ReportCache particiona por (organizationId, storeId, analyticsProvider, período, escopoCache) —
// ver product-performance-service.js — e toda chamada aos services abaixo já recebe
// organizationId/storeId explícitos (nunca implícitos, nunca de um closure de request).

const { createConnectorRegistry } = require('../connectors/registry');
const { createConnectorIntegrationPort } = require('../platform/connector-integration-port');
const { createConnectorSecretPort } = require('../platform/connector-secret-port');
const { createReservaInkCommerceDescriptor } = require('../connectors/commerce/reserva-ink');
const { createInkOrdersRepository } = require('../connectors/commerce/reserva-ink/orders-repository');
const { createGa4AnalyticsDescriptor } = require('../connectors/analytics/ga4');
const { createGa4PropertyRepository } = require('../connectors/analytics/ga4/property-repository');
const { createCommerceCatalogRepository } = require('./commerce-catalog-repository');
const { createProductPerformanceService, createReportCache } = require('./product-performance-service');
const { createReconciliationService } = require('./reconciliation');
const { createJourneyAnalyticsService } = require('./journey-analytics-service');

const ANALYTICS_PROVIDER = 'ga4';
const COMMERCE_PROVIDER = 'reserva_ink';

/**
 * @param {{pool, keyring, fetchImpl?, googleClientId?, googleClientSecret?, reportCacheTtlMs?}} deps
 *   `pool`: a fachada tenant-scoped (RLS) — o mesmo `pgPool` do resto do server.js, NUNCA o pool
 *   real sem RLS (`pgPoolReal`).
 * @returns {Readonly<{registry, catalogRepository, productPerformanceService, reconciliationService,
 *   reportCache, analyticsProvider: string, commerceProvider: string}>}
 */
function createProductAnalyticsComposition({ pool, keyring, fetchImpl, googleClientId, googleClientSecret, reportCacheTtlMs } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createProductAnalyticsComposition exige pool');
  if (!keyring) throw new Error('createProductAnalyticsComposition exige keyring');

  const integrations = createConnectorIntegrationPort({ pool });
  const secretPort = createConnectorSecretPort({ pool, keyring });
  const registry = createConnectorRegistry({ integrations });

  // Reserva Ink: capability `orders` (Etapa 2/rodada G.1) lê o cache local, nunca a API — mesmo
  // secretPort do GA4 (é genérico por integração, não por provider).
  registry.register(createReservaInkCommerceDescriptor({
    secretPort, fetchImpl, ordersRepository: createInkOrdersRepository({ pool }),
  }));
  registry.register(createGa4AnalyticsDescriptor({
    secretPort, propertyRepository: createGa4PropertyRepository({ pool }),
    fetchImpl, clientId: googleClientId, clientSecret: googleClientSecret,
  }));

  const catalogRepository = createCommerceCatalogRepository({ pool });
  const reportCache = createReportCache(reportCacheTtlMs ? { ttlMs: reportCacheTtlMs } : undefined);
  const productPerformanceService = createProductPerformanceService({ pool, registry, catalogRepository, reportCache });
  const reconciliationService = createReconciliationService({ registry, productPerformanceService });
  // Rodada K · Journey Analytics reaproveita o MESMO registry (GA4 + Ink já registrados acima) — a
  // conta Meta Ads é lida direto de meta_insights_daily (lib/meta/campaign-performance.js), fora do
  // registry por enquanto (ver comentário no próprio arquivo). Nenhum provider `event_analytics` é
  // registrado nesta composição — tier3 (jornada individual) fica estruturalmente indisponível até
  // uma composição futura registrar um.
  const journeyAnalyticsService = createJourneyAnalyticsService({ pool, registry, productPerformanceService, analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: COMMERCE_PROVIDER });

  return Object.freeze({
    registry, catalogRepository, productPerformanceService, reconciliationService, journeyAnalyticsService, reportCache,
    analyticsProvider: ANALYTICS_PROVIDER, commerceProvider: COMMERCE_PROVIDER,
  });
}

module.exports = { createProductAnalyticsComposition, ANALYTICS_PROVIDER, COMMERCE_PROVIDER };
