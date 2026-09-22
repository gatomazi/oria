'use strict';

// Fase C · InkProductDTO → CommerceProduct/CommerceProductVariant (docs/features/… V2 §7-8).
//
// Nenhum DTO da Ink atravessa este mapper. `organizationId`/`storeId` vêm do ConnectorContext, não
// do payload da Ink (a Ink não sabe o que é Organization). `id` é sempre `undefined` aqui: o id
// INTERNO do Oria é responsabilidade de quem persiste (Fase D) — o mapper produz o modelo canônico
// sem inventar uma PK que ainda não existe.
//
// `providerProductId`/`providerVariantId` são sempre STRING, mesmo a Ink usando inteiro (BIGINT no
// banco legado): o contrato canônico (§7) é explícito sobre isso, e converter aqui, uma vez, evita
// qualquer downstream reintroduzir o pressuposto "id de produto é número".

const PROVIDER = 'reserva_ink';

// Fase D · §9: um id externo só vira TEXT com segurança se o parser do client já não tiver perdido
// precisão. A Ink usa inteiro; `res.json()` (client.js) já entrega isso como Number — se esse Number
// passou de Number.MAX_SAFE_INTEGER, o arredondamento já aconteceu ANTES de chegar aqui, e não tem
// volta: convertê-lo para string produziria um id que parece exato e não é. Por isso falha explícito
// em vez de persistir um id potencialmente errado. String já veio como veio (nunca perde precisão em
// trânsito) e é aceita como está.
class ExternalIdUnsafeError extends TypeError {
  constructor(campo, valor) {
    super(`${campo}: id numérico ${valor} não é um inteiro seguro em JS (> Number.MAX_SAFE_INTEGER) — não convertido para não persistir um id arredondado`);
    this.name = 'ExternalIdUnsafeError';
    this.codigo = 'EXTERNAL_ID_UNSAFE';
  }
}

function paraIdExterno(valor, campo) {
  if (typeof valor === 'string') {
    const s = valor.trim();
    if (!s) throw new TypeError(`${campo}: id vazio`);
    return s;
  }
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) throw new TypeError(`${campo}: id não é um número finito (${valor})`);
    if (!Number.isSafeInteger(valor)) throw new ExternalIdUnsafeError(campo, valor);
    return String(valor);
  }
  throw new TypeError(`${campo}: id deve ser string ou number, recebi ${typeof valor}`);
}

/**
 * @param {Object} produtoInk  item de `GET /v1/stores/products` (products[])
 * @param {{organizationId: string, storeId: string}} contexto
 * @returns {import('../../types').CommerceProduct}
 */
function mapProduct(produtoInk, { organizationId, storeId }) {
  if (produtoInk === null || typeof produtoInk !== 'object') throw new TypeError('mapProduct exige o produto da Ink');
  if (produtoInk.id === undefined || produtoInk.id === null) throw new TypeError('produto da Ink sem id');
  return Object.freeze({
    id: undefined,
    organizationId,
    storeId,
    provider: PROVIDER,
    providerProductId: paraIdExterno(produtoInk.id, 'produto.id'),
    name: produtoInk.name ?? '',
    slug: produtoInk.slug ?? null,
    imageUrl: produtoInk.main_image_url ?? null,
    // A Ink documenta os dois nomes em endpoints diferentes (`product_url` e `store_product_url`)
    // para o mesmo dado; aceitar ambos evita um mapper que funciona num endpoint e não no outro.
    productUrl: produtoInk.store_product_url ?? produtoInk.product_url ?? null,
    productType: (produtoInk.product_type && produtoInk.product_type.name) ?? null,
    price: produtoInk.price === null || produtoInk.price === undefined ? null : Number(produtoInk.price),
    promotionalPrice: produtoInk.promotional_price === null || produtoInk.promotional_price === undefined ? null : Number(produtoInk.promotional_price),
    visible: produtoInk.visible_in_store ?? null,
    // Dado da Ink sem lugar no canônico, mas útil para diagnóstico (§7: "somente quando realmente
    // úteis") — nunca um campo que algum consumidor vá tratar como parte do contrato.
    metadata: Object.freeze({
      productTypeId: produtoInk.product_type ? produtoInk.product_type.id ?? null : null,
      approvalStatus: produtoInk.approval_status ?? null,
      status: produtoInk.status ?? null,
      productClusterId: produtoInk.product_cluster_id ?? null,
    }),
    syncedAt: new Date(),
  });
}

/**
 * @param {Object} variantInk  item de `product.product_variants[]`
 * @param {{organizationId: string, storeId: string, commerceProductId: string|undefined}} contexto
 * @returns {import('../../types').CommerceProductVariant}
 */
function mapVariant(variantInk, { organizationId, storeId, commerceProductId }) {
  if (variantInk === null || typeof variantInk !== 'object') throw new TypeError('mapVariant exige a variante da Ink');
  if (variantInk.id === undefined || variantInk.id === null) throw new TypeError('variante da Ink sem id');
  return Object.freeze({
    id: undefined,
    organizationId,
    storeId,
    commerceProductId,
    provider: PROVIDER,
    providerVariantId: paraIdExterno(variantInk.id, 'variante.id'),
    sku: variantInk.sku ?? null,
    color: variantInk.color ?? null,
    size: variantInk.size ?? null,
    model: variantInk.model ?? null,
    metadata: Object.freeze({
      hexColor: variantInk.hex_color ?? null,
      isAvailable: variantInk.is_available ?? null,
      availableQuantity: variantInk.available_quantity ?? null,
    }),
  });
}

/**
 * `product.product_variants` mapeadas, já ligadas ao `providerProductId` do produto (o
 * `commerceProductId` interno ainda não existe nesta fase — ver comentário do topo).
 */
function mapVariants(produtoInk, contexto) {
  return (produtoInk.product_variants || []).map((v) => mapVariant(v, { ...contexto, commerceProductId: undefined }));
}

// ── Etapa 2 (rodada G.1/Orders) · pedidos_ink/pedidos_ink_itens (repositório local) → CommerceOrder ──
//
// Diferente de mapProduct/mapVariant (payload CRU da API da Ink), a entrada aqui já vem do
// orders-repository.js: uma linha de `pedidos_ink` + as linhas de `pedidos_ink_itens` do mesmo
// pedido — nunca a API da Ink diretamente (Etapa 2 lê só o cache local sincronizado).
//
// Mesmo vocabulário de `PAYMENT_STATUSES_CONVERTIDO`/`normalizarPaymentStatusInk` do server.js
// (INTOCÁVEL — nunca importado aqui): duplicado deliberadamente, coberto por um teste comparativo
// contra o server.js real (mesmo padrão já usado pelo mapper de produto na Fase C) para nunca
// divergir em silêncio.
const PAGAMENTOS_CONVERTIDOS_INK = Object.freeze(new Set(['paid', 'succeeded', 'free']));
const PAGAMENTOS_REEMBOLSO_INK = Object.freeze(new Set(['refunded', 'refund_requested']));

/**
 * @param {Object} linha  uma linha de `pedidos_ink_itens`, com `commerce_product_id` já resolvido
 *   por JOIN (orders-repository.js) — `null` quando o produto nunca passou por um catalog sync.
 * @returns {import('../../types').CommerceOrderItem}
 */
function mapOrderItem(linha) {
  const quantidade = Number(linha.quantidade) || 0;
  const venda = linha.valor_venda === null || linha.valor_venda === undefined ? 0 : Number(linha.valor_venda);
  return Object.freeze({
    commerceProductId: linha.commerce_product_id || null,
    // pedidos_ink_itens não guarda o id de variante da Ink (só sku/modelo/cor/tamanho soltos) — sem
    // provider_variant_id não há como casar com commerce_product_variants sem ambiguidade; nunca
    // inferido por sku (poderia casar errado quando o mesmo SKU aparece em mais de uma variante
    // histórica). Reportado null, explícito, nunca chutado.
    commerceVariantId: null,
    quantity: quantidade,
    // valor_venda é o TOTAL da linha (financeiroItensPedidoInk usa it.total_value, já quantidade ×
    // preço unitário — ver lib/ink/financeiro.js), não o preço unitário: unitValue é derivado.
    unitValue: quantidade > 0 ? venda / quantidade : venda,
    totalValue: venda,
  });
}

/**
 * @param {{pedido: Object, itens: Object[]}} registro  devolvido por orders-repository.js
 * @param {{organizationId: string, storeId: string}} contexto
 * @returns {import('../../types').CommerceOrder}
 */
function mapOrder({ pedido, itens }, { organizationId, storeId }) {
  if (!pedido) throw new TypeError('mapOrder exige o pedido');
  const paymentStatus = pedido.payment_status || null;
  // is_troca: uma troca nunca conta como venda confirmada, mesmo com payment_status "pago" — mesma
  // regra de `pagosSemTroca`/`is_troca IS NOT TRUE` já aplicada em todo lugar do server.js.
  const isPaid = PAGAMENTOS_CONVERTIDOS_INK.has(paymentStatus) && pedido.is_troca !== true;
  const isRefunded = PAGAMENTOS_REEMBOLSO_INK.has(paymentStatus);
  return Object.freeze({
    id: String(pedido.id),
    organizationId,
    storeId,
    provider: PROVIDER,
    providerOrderId: String(pedido.ink_order_id),
    status: pedido.order_status || null,
    paymentStatus,
    isPaid,
    isRefunded,
    totalValue: pedido.total_value === null || pedido.total_value === undefined ? 0 : Number(pedido.total_value),
    createdAt: pedido.criado_em,
    // pedidos_ink não tem uma coluna própria de "pago em" (só `criado_em`, a criação, e
    // `atualizado_em`, o último toque de sync/webhook — nem um nem outro é o instante do pagamento).
    // Reportar null é mais honesto que aproximar por criado_em: quem precisar de "quando pagou" tem
    // que buscar na API da Ink, não aqui — ver reconciliation.js sobre a consequência disso.
    paidAt: null,
    items: itens.map(mapOrderItem),
  });
}

module.exports = {
  PROVIDER, mapProduct, mapVariant, mapVariants, paraIdExterno, ExternalIdUnsafeError,
  mapOrder, mapOrderItem, PAGAMENTOS_CONVERTIDOS_INK, PAGAMENTOS_REEMBOLSO_INK,
};
