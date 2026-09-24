'use strict';

// Fase E · descritor pronto para `registry.register(...)`.
//
//   registry.register(createGa4AnalyticsDescriptor({ secretPort, propertyRepository }))
//   registry.resolve('analytics', 'ga4', { organizationId, storeId })
//
// `secretPort` e `propertyRepository` são montados uma vez no bootstrap (com o pool real) — o
// mesmo padrão do descritor da Ink (Fase C): a dependência concreta de Postgres fica FORA do
// connector.

const { createGa4AnalyticsConnector, CAPABILITIES } = require('./connector');

function createGa4AnalyticsDescriptor({ secretPort, propertyRepository, fetchImpl, clientId, clientSecret } = {}) {
  if (!secretPort) throw new Error('createGa4AnalyticsDescriptor exige secretPort');
  if (!propertyRepository) throw new Error('createGa4AnalyticsDescriptor exige propertyRepository');
  return {
    domain: 'analytics',
    provider: 'ga4',
    integrationProvider: 'ga4',
    requiresStoreContext: true,
    capabilities: CAPABILITIES,
    label: 'Google Analytics 4',
    create: ({ context, resolveIntegration }) => createGa4AnalyticsConnector({
      context, resolveIntegration, secretPort, propertyRepository, fetchImpl, clientId, clientSecret,
    }),
  };
}

module.exports = { createGa4AnalyticsDescriptor };
