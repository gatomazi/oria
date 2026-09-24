'use strict';

// Test doubles da Fase B: quatro descritores com o formato dos connectors reais que virão nas fases
// seguintes (Ink, GA4, Meta Ads, Meta Events) e uma porta de integrações em memória. Nada aqui é
// adapter funcional: os métodos só devolvem o que o teste precisa observar.

const ORG_A = 'a1000000-0000-4000-8000-00000000000a';
const ORG_B = 'b2000000-0000-4000-8000-00000000000b';
// Uma Store por Organization (ORIA-TENANCY-STORE-01): não há cenário com duas Stores na mesma Organization.
const STORE_A = 'a1a10000-0000-4000-8000-0000000000a1';
const STORE_B = 'b2b10000-0000-4000-8000-0000000000b1';
const LOJAS = Object.freeze({ [STORE_A]: ORG_A, [STORE_B]: ORG_B });
// `integrations.id` hoje é BIGSERIAL: o pg entrega string numérica. O contrato trata o id como opaco.
const INT_INK_A = '101';
const INT_GA4_A = '201';
const INT_META_A = '301';
const INT_INK_B = '111';

// Uma linha por integração — sempre da Organization, sem Store.
const INTEGRACOES = Object.freeze([
  { integrationId: INT_INK_A, organizationId: ORG_A, integrationProvider: 'ink' },
  { integrationId: INT_GA4_A, organizationId: ORG_A, integrationProvider: 'ga4' },
  { integrationId: INT_META_A, organizationId: ORG_A, integrationProvider: 'meta' },
  { integrationId: INT_INK_B, organizationId: ORG_B, integrationProvider: 'ink' },
]);

const erroComCodigo = (mensagem, codigo) => Object.assign(new Error(mensagem), { codigo });

// Resolvedor de referência (o comportamento que o adaptador real da B.1 implementa): a Store, se
// vier, tem de ser da Organization; a integração é achada por organização + provider (+ id, se vier).
// `storeId` do resultado é a Store de execução validada — não uma propriedade da integração.
function portaDeIntegracoes(linhas = INTEGRACOES) {
  const consultas = [];
  return {
    consultas,
    async resolve(consulta) {
      consultas.push(consulta);
      const { context, integrationProvider } = consulta;
      if (context.storeId !== null && LOJAS[context.storeId] !== context.organizationId) {
        throw erroComCodigo('Store não pertence à Organization', 'STORE_NOT_IN_ORGANIZATION');
      }
      const achada = linhas.find((l) => l.organizationId === context.organizationId
        && l.integrationProvider === integrationProvider
        && (context.integrationId === null || l.integrationId === context.integrationId));
      if (!achada) throw erroComCodigo('integração não conectada', 'INTEGRATION_NOT_CONNECTED');
      return { ...achada, storeId: context.storeId, status: 'connected', config: {} };
    },
  };
}

const chamar = (deps) => async () => deps.resolveIntegration();

function descritorReservaInk(extra = {}) {
  return {
    domain: 'commerce',
    provider: 'reserva_ink',
    integrationProvider: 'ink',
    requiresStoreContext: true,
    capabilities: { products: true, variants: true, productsWithVariants: false, orders: true, productCosts: false, refunds: true },
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
    requiresStoreContext: true,
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
    // Performance de campanha é dado da conta de anúncios (Organization): não precisa de Store.
    requiresStoreContext: false,
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
    // Evento de produto é dado da Store.
    requiresStoreContext: true,
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
  ORG_A, ORG_B, STORE_A, STORE_B,
  INT_INK_A, INT_GA4_A, INT_META_A, INT_INK_B,
  INTEGRACOES,
  portaDeIntegracoes,
  descritorReservaInk, descritorGa4, descritorMetaAds, descritorMetaEvents,
};
