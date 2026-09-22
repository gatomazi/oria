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
 * Premissa do produto (ORIA-TENANCY-STORE-01): 1 Organization = 1 Store. A integração pertence à
 * ORGANIZATION; a Store é contexto operacional.
 *
 * @typedef {Object} ConnectorContext
 * @property {string} organizationId     tenant: dono das integrações, dos segredos e dos entitlements
 * @property {string|null} storeId       contexto OPERACIONAL (produtos, pedidos, catálogo, analytics);
 *                                       null só em connector com `requiresStoreContext: false`
 * @property {string|null} integrationId integração explicitamente ligada, quando o chamador já sabe qual
 *                                       (jobs); id opaco (hoje `integrations.id` é BIGSERIAL)
 */

/**
 * Saída do IntegrationResolver, já conferida pelo registry.
 *
 * ATENÇÃO: `storeId` NÃO é uma coluna `store_id` de `integrations` (ela não existe, e não vai existir:
 * a integração é da Organization). É o "validated execution Store context": a Store que a porta
 * validou como pertencente à Organization antes de resolver. Não leia este tipo como "a integração
 * é da Store".
 *
 * @typedef {Object} ResolvedIntegration
 * @property {string} integrationId
 * @property {string} organizationId          dono da integração
 * @property {string|null} storeId            Store de execução validada (ver acima); null se o contexto não tinha
 * @property {string} integrationProvider     `integrations.provider` da linha resolvida
 * @property {string|null} status             devolvido como está; interpretar é do connector/service
 * @property {Readonly<Object>} config        NUNCA contém segredo
 */

/**
 * Porta que a camada de integrações implementa (Fase B.1). O registry entrega ao connector uma
 * função `resolveIntegration()` já ligada a (domain, provider, contexto); o connector não escolhe
 * organização, Store nem provider da credencial. Nenhuma busca pode ser só por `integrationId` ou só
 * por provider: a Organization do contexto entra sempre.
 *
 * @typedef {Object} IntegrationResolver
 * @property {(consulta: IntegrationQuery) => Promise<ResolvedIntegration>} resolve
 */

/**
 * @typedef {Object} IntegrationQuery
 * @property {string} domain
 * @property {string} provider              chave no registry (ex.: `reserva_ink`)
 * @property {string} integrationProvider   chave em `integrations.provider` (ex.: `ink`)
 * @property {boolean} requiresStoreContext
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
 * Etapa 2 (rodada G.1/Orders) · `commerceProductId` é `string|null`, não sempre resolvível: um item
 * de um pedido antigo pode referenciar um produto que nunca passou por um catalog sync (Fase D) —
 * o adapter reporta `null` em vez de inventar um id ou descartar o item silenciosamente.
 *
 * @typedef {Object} CommerceOrderItem
 * @property {string|null} commerceProductId
 * @property {string|null} [commerceVariantId]
 * @property {number} quantity
 * @property {number} unitValue
 * @property {number} totalValue
 */

/**
 * `status`/`paymentStatus` são o vocabulário CRU do provider (diagnóstico — nunca comparados por
 * quem lê fora do adapter). `isPaid`/`isRefunded` são o que o adapter normaliza a partir desse
 * vocabulário próprio (cada provider tem o seu) para um sinal provider-agnostic que uma camada como
 * `lib/product-analytics/reconciliation.js` pode usar sem conhecer nenhum status de nenhum provider.
 *
 * @typedef {Object} CommerceOrder
 * @property {string} id
 * @property {string} organizationId
 * @property {string} storeId
 * @property {string} provider
 * @property {string} providerOrderId
 * @property {string|null} status
 * @property {string|null} [paymentStatus]
 * @property {boolean} isPaid
 * @property {boolean} isRefunded
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
 * Fase D: produto + variantes do MESMO payload do provider — nunca uma composição feita por quem
 * chama (`Page.items` aqui não é `CommerceProduct[]`; é este par). Existe para que um full catalog
 * sync consiga persistir produto e variantes de uma página sem 1 chamada extra por produto.
 *
 * @typedef {Object} CommerceProductWithVariants
 * @property {CommerceProduct} product
 * @property {CommerceProductVariant[]} variants
 */

/**
 * Capabilities `products`: listProducts, getProduct · `variants`: listProductVariants ·
 * `productsWithVariants`: listProductsWithVariants (produto+variantes em lote, sem N+1) ·
 * `orders`: listOrders, getOrder · `productCosts`: getProductCost · `refunds`: informativa.
 *
 * @typedef {Object} CommerceConnector
 * @property {(entrada: {cursor?: string|null, limit?: number, updatedSince?: string}) => Promise<Page>} [listProducts]
 * @property {(entrada: {providerProductId: string}) => Promise<CommerceProduct|null>} [getProduct]
 * @property {(entrada: {providerProductId?: string, cursor?: string|null, limit?: number}) => Promise<Page>} [listProductVariants]
 * @property {(entrada: {cursor?: string|null, limit?: number}) => Promise<{items: CommerceProductWithVariants[], nextCursor: string|null}>} [listProductsWithVariants]
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
