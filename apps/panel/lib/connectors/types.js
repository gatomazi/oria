'use strict';

// Tipos de domínio dos connectors — SÓ JSDoc, sem código de runtime (o backend é JS; o doc
// docs/features/ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md descreve os mesmos formatos em TS).
//
// Regras que valem para todo método de connector:
//   · o tenant NÃO é parâmetro. `organizationId`/`storeId` vêm do ConnectorContext ligado no
//     `registry.resolve(...)`; o chamador não consegue perguntar por outra Store no mesmo objeto;
//   · datas de entrada e saída são ISO `YYYY-MM-DD` (o formato do GA4, `7daysAgo`, fica no adapter);
//   · o que sai é o modelo canônico do Oria. DTO de provider nunca atravessa o connector.

/**
 * @typedef {Object} ConnectorContext
 * @property {string} organizationId
 * @property {string|null} storeId       null só em connector de escopo `organization`
 * @property {string|null} integrationId null até a integração ser resolvida (ou informado por um job)
 */

/**
 * @typedef {Object} ResolvedIntegration  Saída do IntegrationResolver, já conferida pelo registry.
 * @property {string} integrationId
 * @property {string} organizationId
 * @property {string|null} storeId       null = integração da Organization
 * @property {string|null} status
 * @property {Readonly<Object>} config   NUNCA contém segredo
 */

/**
 * Porta que a camada de integrações implementa (Fase B.1). O registry entrega ao connector uma
 * função `resolveIntegration()` já ligada a (domain, provider, contexto); o connector não escolhe
 * organização, Store nem provider da credencial.
 *
 * @typedef {Object} IntegrationResolver
 * @property {(consulta: IntegrationQuery) => Promise<ResolvedIntegration>} resolve
 */

/**
 * @typedef {Object} IntegrationQuery
 * @property {string} domain
 * @property {string} provider             chave no registry (ex.: `reserva_ink`)
 * @property {string} integrationProvider  chave em `integrations.provider` (ex.: `ink`)
 * @property {'store'|'organization'|'store_or_organization'} integrationScope
 * @property {ConnectorContext} context
 */

// ── Commerce ────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CommerceProduct
 * @property {string} id                    id INTERNO do Oria; nunca o id do provider
 * @property {string} organizationId
 * @property {string} storeId
 * @property {string} provider
 * @property {string} providerProductId     TEXT: o provider pode usar número, UUID ou handle
 * @property {string} name
 * @property {string|null} [slug]
 * @property {string|null} [imageUrl]
 * @property {string|null} [productUrl]
 * @property {string|null} [productType]
 * @property {number|null} [price]
 * @property {number|null} [promotionalPrice]
 * @property {boolean|null} [visible]
 * @property {Object} [metadata]
 * @property {Date} syncedAt
 */

/**
 * @typedef {Object} CommerceProductVariant
 * @property {string} id
 * @property {string} organizationId
 * @property {string} storeId
 * @property {string} commerceProductId
 * @property {string} provider
 * @property {string} providerVariantId
 * @property {string|null} [sku]
 * @property {string|null} [color]
 * @property {string|null} [size]
 * @property {string|null} [model]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} CommerceOrderItem
 * @property {string} commerceProductId
 * @property {string|null} [commerceVariantId]
 * @property {number} quantity
 * @property {number} unitValue
 * @property {number} totalValue
 */

/**
 * @typedef {Object} CommerceOrder
 * @property {string} id
 * @property {string} organizationId
 * @property {string} storeId
 * @property {string} provider
 * @property {string} providerOrderId
 * @property {string} status
 * @property {string|null} [paymentStatus]
 * @property {number} totalValue
 * @property {Date} createdAt
 * @property {Date|null} [paidAt]
 * @property {CommerceOrderItem[]} items
 */

/**
 * @typedef {Object} Page
 * @property {Array} items
 * @property {string|null} nextCursor
 */

/**
 * Capabilities `products`: listProducts, getProduct · `variants`: listProductVariants ·
 * `orders`: listOrders, getOrder · `productCosts`: getProductCost · `refunds`: informativa.
 *
 * @typedef {Object} CommerceConnector
 * @property {(entrada: {cursor?: string|null, limit?: number, updatedSince?: string}) => Promise<Page>} [listProducts]
 * @property {(entrada: {providerProductId: string}) => Promise<CommerceProduct|null>} [getProduct]
 * @property {(entrada: {providerProductId?: string, cursor?: string|null, limit?: number}) => Promise<Page>} [listProductVariants]
 * @property {(entrada: {startDate: string, endDate: string, cursor?: string|null, limit?: number}) => Promise<Page>} [listOrders]
 * @property {(entrada: {providerOrderId: string}) => Promise<CommerceOrder|null>} [getOrder]
 * @property {(entrada: {providerProductId: string}) => Promise<{cost: number, currency: string}|null>} [getProductCost]
 */

// ── Analytics (agregado) ────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ProductAnalyticsRow
 * @property {string} analyticsProductId   id como o analytics o conhece; a resolução para o produto
 *                                         interno é do Product Identity Resolver, não do connector
 * @property {string} namespace            ex.: `ga4.item_id`
 * @property {number} views
 * @property {number} addToCarts
 * @property {number} checkouts
 * @property {number} purchases
 * @property {number} revenue
 * @property {number} [users]
 */

/**
 * @typedef {Object} AnalyticsConnector
 * @property {(entrada: {startDate: string, endDate: string}) => Promise<ProductAnalyticsRow[]>} [getProductPerformance]
 * @property {(entrada: {startDate: string, endDate: string}) => Promise<Object[]>} [getEventMetrics]
 */

// ── Event analytics (Meta Pixel/CAPI, GA4 BigQuery, tracking próprio…) ──────────────────────────

/**
 * @typedef {'product_view'|'add_to_cart'|'checkout_started'|'purchase'|'refund'|'custom'} NormalizedEventType
 */

/**
 * @typedef {Object} NormalizedJourneyEvent
 * @property {string} id
 * @property {string} organizationId
 * @property {string} storeId
 * @property {NormalizedEventType} normalizedType
 * @property {string} provider
 * @property {string} providerEventName
 * @property {string|null} [providerEventId]
 * @property {Date} occurredAt
 * @property {Date|null} [receivedAt]
 * @property {string|null} [commerceProductId]
 * @property {string|null} [externalProductId]
 * @property {string|null} [externalProductNamespace]
 * @property {string|null} [sessionKey]
 * @property {string|null} [userKey]
 * @property {string|null} [orderId]
 * @property {number|null} [value]
 * @property {string|null} [currency]
 * @property {Object} [sourceMetadata]
 */

/**
 * @typedef {Object} ProductEventAggregate
 * @property {string} externalProductId
 * @property {string} externalProductNamespace
 * @property {NormalizedEventType} normalizedType
 * @property {string} providerEventName
 * @property {number} count
 * @property {number|null} [value]
 * @property {boolean} deduplicated   true só quando o provider garante a deduplicação
 */

/**
 * @typedef {Object} EventCoverage
 * @property {Array<{providerEventName: string, normalizedType: NormalizedEventType, detected: boolean, hasProductId: boolean, lastEventAt: string|null}>} events
 */

/**
 * Capabilities `aggregatedProductEvents`: getProductEventAggregates · `eventLevel`: getProductEvents ·
 * `productIdentity`, `eventDedupKeys`: informativas. `getEventCoverage` é obrigatório.
 *
 * @typedef {Object} EventAnalyticsConnector
 * @property {(entrada: {startDate: string, endDate: string}) => Promise<EventCoverage>} getEventCoverage
 * @property {(entrada: {startDate: string, endDate: string, cursor?: string|null, limit?: number}) => Promise<Page>} [getProductEvents]
 * @property {(entrada: {startDate: string, endDate: string}) => Promise<ProductEventAggregate[]>} [getProductEventAggregates]
 */

// ── Ads ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} AdsPerformanceRow
 * @property {string} externalId
 * @property {string} name
 * @property {number} spend
 * @property {number} impressions
 * @property {number} clicks
 * @property {number} purchases
 * @property {number} revenue
 */

/**
 * @typedef {Object} AdsConnector
 * @property {(entrada: {startDate: string, endDate: string}) => Promise<AdsPerformanceRow[]>} [getCampaignPerformance]
 * @property {(entrada: {startDate: string, endDate: string}) => Promise<AdsPerformanceRow[]>} [getAdPerformance]
 * @property {(entrada: {startDate: string, endDate: string}) => Promise<AdsPerformanceRow[]>} [getCreativePerformance]
 */

module.exports = {};
