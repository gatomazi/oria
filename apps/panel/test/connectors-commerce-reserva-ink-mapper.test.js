'use strict';

// Fase C · mapper Ink (lib/connectors/commerce/reserva-ink/mapper.js): InkProductDTO → CommerceProduct
// / CommerceProductVariant. Fixtures no formato documentado em documentacao-api-ink.yaml
// (`GET /v1/stores/products`, `product.product_variants[]`).

const test = require('node:test');
const assert = require('node:assert/strict');

const { PROVIDER, mapProduct, mapVariant, mapVariants, paraIdExterno, ExternalIdUnsafeError } = require('../lib/connectors/commerce/reserva-ink/mapper');

const CTX = Object.freeze({ organizationId: 'a1000000-0000-4000-8000-00000000000a', storeId: 'a1a10000-0000-4000-8000-0000000000a1' });

const PRODUTO_COMPLETO = Object.freeze({
  id: 386559,
  name: 'Camiseta Estampa Regional',
  slug: 'camiseta-estampa-regional',
  description: 'Descrição interna da Ink, fora do canônico',
  store_product_url: 'https://loja.reserva.ink/produtos/camiseta-estampa-regional',
  visible_in_store: true,
  customizable_by_buyer: false,
  total_sales_count: 42,
  product_cluster_id: 777,
  price: '129.90',
  promotional_price: '99.90',
  tags: ['regional', 'estampa'],
  main_image_url: 'https://cdn.reserva.ink/img/386559.webp',
  approval_status: 'approved',
  status: 'active',
  created_at: '2026-01-10T12:00:00Z',
  updated_at: '2026-09-20T08:30:00Z',
  product_type: { id: 12, name: 'Camiseta', slug: 'camiseta' },
  product_variants: [
    { id: 9001, sku: 'CAM-GG-AZUL', color: 'Azul', hex_color: '#1a2b3c', size: 'GG', model: 'Regular', is_available: true, available_quantity: 5, sales_count: 10 },
    { id: 9002, sku: 'CAM-M-VERM', color: 'Vermelho', hex_color: '#c0392b', size: 'M', model: 'Slim', is_available: false, available_quantity: 0, sales_count: 2 },
  ],
});

const PRODUTO_MINIMO = Object.freeze({ id: 111, name: null, price: null, promotional_price: null });

test('C · mapProduct converte todos os campos documentados do produto completo', () => {
  const p = mapProduct(PRODUTO_COMPLETO, CTX);
  assert.equal(p.provider, PROVIDER);
  assert.equal(p.providerProductId, '386559');
  assert.equal(typeof p.providerProductId, 'string');
  assert.equal(p.organizationId, CTX.organizationId);
  assert.equal(p.storeId, CTX.storeId);
  assert.equal(p.name, 'Camiseta Estampa Regional');
  assert.equal(p.slug, 'camiseta-estampa-regional');
  assert.equal(p.imageUrl, 'https://cdn.reserva.ink/img/386559.webp');
  assert.equal(p.productUrl, 'https://loja.reserva.ink/produtos/camiseta-estampa-regional');
  assert.equal(p.productType, 'Camiseta');
  assert.equal(p.price, 129.9);
  assert.equal(p.promotionalPrice, 99.9);
  assert.equal(p.visible, true);
  assert.ok(p.syncedAt instanceof Date);
});

test('C · mapProduct aceita product_url quando store_product_url não vem (variação de endpoint)', () => {
  const p = mapProduct({ id: 1, product_url: 'https://x/p/1' }, CTX);
  assert.equal(p.productUrl, 'https://x/p/1');
});

test('C · mapProduct: campos opcionais ausentes viram null, nunca undefined ou erro', () => {
  const p = mapProduct(PRODUTO_MINIMO, CTX);
  assert.equal(p.name, '');
  assert.equal(p.slug, null);
  assert.equal(p.imageUrl, null);
  assert.equal(p.productUrl, null);
  assert.equal(p.productType, null);
  assert.equal(p.price, null);
  assert.equal(p.promotionalPrice, null);
  assert.equal(p.visible, null);
  assert.deepEqual({ ...p.metadata }, { productTypeId: null, approvalStatus: null, status: null, productClusterId: null });
});

test('C · mapProduct: id BIGINT (dentro do intervalo seguro de Number) vira TEXT sem perder dígito', () => {
  // Precisão de ponto flutuante é limite do próprio JSON.parse do client (fora do escopo do mapper);
  // o que o mapper garante é não truncar/arredondar/notar-cientificamente um inteiro seguro.
  const GRANDE = 123456789012345; // 15 dígitos, < Number.MAX_SAFE_INTEGER (9007199254740991)
  const p = mapProduct({ id: GRANDE, name: 'x' }, CTX);
  assert.equal(p.providerProductId, '123456789012345');
  assert.doesNotMatch(p.providerProductId, /e\+/i);
});

test('C · mapProduct exige id do produto, e nunca inventa PK interna', () => {
  assert.throws(() => mapProduct({ name: 'sem id' }, CTX), TypeError);
  assert.throws(() => mapProduct(null, CTX), TypeError);
  assert.equal(mapProduct({ id: 1 }, CTX).id, undefined);
});

test('C · mapProduct nunca propaga o DTO cru: description e customizable_by_buyer da Ink não vazam no canônico', () => {
  const p = mapProduct(PRODUTO_COMPLETO, CTX);
  assert.equal('description' in p, false);
  assert.equal('customizable_by_buyer' in p, false);
  assert.equal(JSON.stringify(p).includes('Descrição interna'), false);
});

test('C · mapProduct devolve objeto e metadata congelados', () => {
  const p = mapProduct(PRODUTO_COMPLETO, CTX);
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.metadata));
});

// ── Variants ────────────────────────────────────────────────────────────────────────────────────

test('C · mapVariant converte sku/color/size/model e não usa SKU como identidade principal', () => {
  const v = mapVariant(PRODUTO_COMPLETO.product_variants[0], { ...CTX, commerceProductId: 'cp-1' });
  assert.equal(v.provider, PROVIDER);
  assert.equal(v.providerVariantId, '9001');
  assert.equal(typeof v.providerVariantId, 'string');
  assert.equal(v.commerceProductId, 'cp-1');
  assert.equal(v.sku, 'CAM-GG-AZUL');
  assert.equal(v.color, 'Azul');
  assert.equal(v.size, 'GG');
  assert.equal(v.model, 'Regular');
  assert.deepEqual({ ...v.metadata }, { hexColor: '#1a2b3c', isAvailable: true, availableQuantity: 5 });
});

test('C · mapVariant: campos opcionais ausentes viram null', () => {
  const v = mapVariant({ id: 1 }, { ...CTX, commerceProductId: null });
  assert.equal(v.sku, null);
  assert.equal(v.color, null);
  assert.equal(v.size, null);
  assert.equal(v.model, null);
});

test('C · mapVariant exige id da variante', () => {
  assert.throws(() => mapVariant({ sku: 'x' }, CTX), TypeError);
});

test('C · mapVariants mapeia todas as variantes do produto, na ordem', () => {
  const vs = mapVariants(PRODUTO_COMPLETO, CTX);
  assert.equal(vs.length, 2);
  assert.deepEqual(vs.map((v) => v.providerVariantId), ['9001', '9002']);
});

test('C · mapVariants de produto sem product_variants devolve lista vazia, não erro', () => {
  assert.deepEqual(mapVariants({ id: 1 }, CTX), []);
});

// ── Fase D §9: segurança numérica de IDs externos ──────────────────────────────────────────────

test('D · paraIdExterno: string é aceita como está (nunca perde precisão em trânsito)', () => {
  assert.equal(paraIdExterno('386559', 'x'), '386559');
  assert.equal(paraIdExterno('9007199254740995123', 'x'), '9007199254740995123'); // 19 dígitos, só cabe como string
});

test('D · paraIdExterno: integer seguro vira string exata, sem notação científica', () => {
  assert.equal(paraIdExterno(386559, 'x'), '386559');
  assert.equal(paraIdExterno(Number.MAX_SAFE_INTEGER, 'x'), '9007199254740991');
  assert.equal(paraIdExterno(0, 'x'), '0');
});

test('D · paraIdExterno: number > MAX_SAFE_INTEGER falha explícito, nunca converte arredondado', () => {
  assert.throws(() => paraIdExterno(Number.MAX_SAFE_INTEGER + 2, 'produto.id'), (err) => {
    assert.ok(err instanceof ExternalIdUnsafeError);
    assert.equal(err.codigo, 'EXTERNAL_ID_UNSAFE');
    assert.match(err.message, /produto\.id/);
    return true;
  });
  assert.throws(() => paraIdExterno(1e21, 'x'), ExternalIdUnsafeError);
});

test('D · paraIdExterno: NaN/Infinity/vazio/tipo errado falham, nunca viram "undefined" ou "NaN" persistido', () => {
  for (const ruim of [NaN, Infinity, -Infinity]) assert.throws(() => paraIdExterno(ruim, 'x'), TypeError);
  assert.throws(() => paraIdExterno('', 'x'), TypeError);
  assert.throws(() => paraIdExterno('   ', 'x'), TypeError);
  assert.throws(() => paraIdExterno(null, 'x'), TypeError);
  assert.throws(() => paraIdExterno(undefined, 'x'), TypeError);
  assert.throws(() => paraIdExterno({}, 'x'), TypeError);
  assert.throws(() => paraIdExterno([386559], 'x'), TypeError);
});

test('D · mapProduct propaga o erro de id inseguro em vez de persistir algo arredondado', () => {
  assert.throws(() => mapProduct({ id: Number.MAX_SAFE_INTEGER + 10, name: 'x' }, CTX), ExternalIdUnsafeError);
});

test('D · mapVariant propaga o erro de id inseguro', () => {
  assert.throws(() => mapVariant({ id: Number.MAX_SAFE_INTEGER + 10 }, { ...CTX, commerceProductId: null }), ExternalIdUnsafeError);
});
