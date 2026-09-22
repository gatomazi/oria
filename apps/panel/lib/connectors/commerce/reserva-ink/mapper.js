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

function paraTexto(valor) {
  return valor === null || valor === undefined ? null : String(valor);
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
    providerProductId: String(produtoInk.id),
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
    providerVariantId: String(variantInk.id),
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

module.exports = { PROVIDER, mapProduct, mapVariant, mapVariants, paraTexto };
