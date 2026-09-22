'use strict';

// Test doubles da Fase B: quatro descritores com o formato dos connectors reais que virão nas fases
// seguintes (Ink, GA4, Meta Ads, Meta Events) e uma porta de integrações em memória. Nada aqui é
// adapter funcional: os métodos só devolvem o que o teste precisa observar.

const ORG_A = 'a1000000-0000-4000-8000-00000000000a';
const ORG_B = 'b2000000-0000-4000-8000-00000000000b';
const STORE_A1 = 'a1a10000-0000-4000-8000-0000000000a1';
const STORE_A2 = 'a1a20000-0000-4000-8000-0000000000a2';
const STORE_B1 = 'b2b10000-0000-4000-8000-0000000000b1';
// `integrations.id` hoje é BIGSERIAL: o pg entrega string numérica. O contrato trata o id como opaco.
const INT_INK_A1 = '101';
const INT_INK_A2 = '102';
const INT_GA4_A1 = '201';
const INT_META_A_ORG = '301';
const INT_INK_B1 = '111';

// Uma linha por integração, no formato que a camada de integrações devolverá na Fase B.1.
const INTEGRACOES = Object.freeze([
  { integrationId: INT_INK_A1, organizationId: ORG_A, storeId: STORE_A1, integrationProvider: 'ink' },
  { integrationId: INT_INK_A2, organizationId: ORG_A, storeId: STORE_A2, integrationProvider: 'ink' },
  { integrationId: INT_GA4_A1, organizationId: ORG_A, storeId: STORE_A1, integrationProvider: 'ga4' },
  { integrationId: INT_META_A_ORG, organizationId: ORG_A, storeId: null, integrationProvider: 'meta' },
  { integrationId: INT_INK_B1, organizationId: ORG_B, storeId: STORE_B1, integrationProvider: 'ink' },
]);

// Resolvedor de referência: casa organizationId + storeId + integrationProvider e só devolve a
// integração da Organization quando o escopo do connector permite. Registra as consultas.
function portaDeIntegracoes(linhas = INTEGRACOES) {
  const consultas = [];
  return {
    consultas,
    async resolve(consulta) {
      consultas.push(consulta);
      const { context, integrationProvider, integrationScope } = consulta;
      const candidatas = linhas.filter((l) => l.organizationId === context.organizationId && l.integrationProvider === integrationProvider);
      const daStore = candidatas.find((l) => l.storeId === context.storeId);
      const daOrganization = candidatas.find((l) => l.storeId === null);
      const achada = daStore || (integrationScope !== 'store' ? daOrganization : null);
      if (!achada) throw new Error('integração não conectada');
      return { ...achada, status: 'connected', config: {} };
    },
  };
}

const chamar = (deps) => async () => deps.resolveIntegration();

function descritorReservaInk(extra = {}) {
  return {
    domain: 'commerce',
    provider: 'reserva_ink',
    integrationProvider: 'ink',
    integrationScope: 'store',
    capabilities: { products: true, variants: true, orders: true, productCosts: false, refunds: true },
    create: (deps) => ({
      listProducts: async () => ({ items: [], nextCursor: null }),
      getProduct: async () => null,
      listProductVariants: async () => ({ items: [], nextCursor: null }),
      listOrders: async () => ({ items: [], nextCursor: null }),
      getOrder: async () => null,
      integracaoEmUso: chamar(deps),
    }),
    ...extra,
  };
}

function descritorGa4(extra = {}) {
  return {
    domain: 'analytics',
    provider: 'ga4',
    integrationScope: 'store',
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: (deps) => ({
      getProductPerformance: async () => [],
      integracaoEmUso: chamar(deps),
    }),
    ...extra,
  };
}

function descritorMetaAds(extra = {}) {
  return {
    domain: 'ads',
    provider: 'meta',
    integrationScope: 'store_or_organization',
    capabilities: { campaignPerformance: true, adPerformance: true, creativePerformance: false },
    create: (deps) => ({
      getCampaignPerformance: async () => [],
      getAdPerformance: async () => [],
      integracaoEmUso: chamar(deps),
    }),
    ...extra,
  };
}

function descritorMetaEvents(extra = {}) {
  return {
    domain: 'event_analytics',
    provider: 'meta',
    integrationScope: 'store_or_organization',
    capabilities: { aggregatedProductEvents: true, eventLevel: false, productIdentity: true, eventDedupKeys: false },
    create: (deps) => ({
      getEventCoverage: async () => ({ events: [] }),
      getProductEventAggregates: async () => [],
      integracaoEmUso: chamar(deps),
    }),
    ...extra,
  };
}

module.exports = {
  ORG_A, ORG_B, STORE_A1, STORE_A2, STORE_B1,
  INT_INK_A1, INT_INK_A2, INT_GA4_A1, INT_META_A_ORG, INT_INK_B1,
  INTEGRACOES,
  portaDeIntegracoes,
  descritorReservaInk, descritorGa4, descritorMetaAds, descritorMetaEvents,
};
