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

module.exports = { PROVIDER, mapProduct, mapVariant, mapVariants, paraIdExterno, ExternalIdUnsafeError };
