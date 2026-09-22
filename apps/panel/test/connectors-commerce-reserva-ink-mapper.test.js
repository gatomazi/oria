'use strict';

// Fase C · mapper Ink (lib/connectors/commerce/reserva-ink/mapper.js): InkProductDTO → CommerceProduct
// / CommerceProductVariant. Fixtures no formato documentado em documentacao-api-ink.yaml
// (`GET /v1/stores/products`, `product.product_variants[]`).
//
// Etapa 2 (rodada G.1/Orders): mapOrder/mapOrderItem (pedidos_ink/pedidos_ink_itens → CommerceOrder).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROVIDER, mapProduct, mapVariant, mapVariants, paraIdExterno, ExternalIdUnsafeError,
  mapOrder, mapOrderItem, PAGAMENTOS_CONVERTIDOS_INK, PAGAMENTOS_REEMBOLSO_INK,
} = require('../lib/connectors/commerce/reserva-ink/mapper');

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

// ── Etapa 2 (rodada G.1/Orders) · mapOrder/mapOrderItem ──────────────────────────────────────────

const PEDIDO_PAGO = Object.freeze({
  id: '501', ink_order_id: 78901, payment_status: 'paid', order_status: 'shipped',
  total_value: '199.80', criado_em: new Date('2026-09-01T10:00:00Z'), atualizado_em: new Date('2026-09-01T11:00:00Z'),
  is_troca: false,
});
const ITEM_RESOLVIDO = Object.freeze({
  ink_order_id: 78901, item_id: 1, produto_id: 386559, produto_nome: 'Camiseta Regional', sku: 'CAM-GG-AZUL',
  modelo: 'Regular', cor: 'Azul', tamanho: 'GG', quantidade: 2, valor_venda: '199.80', desconto_rateado: '0',
  commerce_product_id: 'c1000000-0000-4000-8000-000000000001',
});
const ITEM_SEM_CATALOGO = Object.freeze({ ...ITEM_RESOLVIDO, item_id: 2, commerce_product_id: null });

test('G.1 · mapOrder: pedido pago (não troca) vira isPaid=true; status/paymentStatus originais preservados', () => {
  const o = mapOrder({ pedido: PEDIDO_PAGO, itens: [ITEM_RESOLVIDO] }, CTX);
  assert.equal(o.id, '501');
  assert.equal(o.provider, 'reserva_ink');
  assert.equal(o.providerOrderId, '78901');
  assert.equal(o.status, 'shipped');
  assert.equal(o.paymentStatus, 'paid');
  assert.equal(o.isPaid, true);
  assert.equal(o.isRefunded, false);
  assert.equal(o.totalValue, 199.8);
  assert.deepEqual(o.createdAt, PEDIDO_PAGO.criado_em);
  assert.equal(o.paidAt, null); // sem coluna própria de "pago em" no cache local — nunca aproximado por criado_em
});

test('G.1 · mapOrder: troca (is_troca) NUNCA conta como paga, mesmo com payment_status pago — mesma regra do server.js', () => {
  const o = mapOrder({ pedido: { ...PEDIDO_PAGO, is_troca: true }, itens: [] }, CTX);
  assert.equal(o.isPaid, false);
});

for (const status of ['waiting_payment', 'expired', 'not_authorized', 'awaiting_analysis', 'canceled', null]) {
  test(`G.1 · mapOrder: payment_status=${status} nunca é isPaid`, () => {
    const o = mapOrder({ pedido: { ...PEDIDO_PAGO, payment_status: status }, itens: [] }, CTX);
    assert.equal(o.isPaid, false);
  });
}

for (const status of ['refunded', 'refund_requested']) {
  test(`G.1 · mapOrder: payment_status=${status} vira isRefunded=true`, () => {
    const o = mapOrder({ pedido: { ...PEDIDO_PAGO, payment_status: status }, itens: [] }, CTX);
    assert.equal(o.isRefunded, true);
    assert.equal(o.isPaid, false);
  });
}

test('G.1 · mapOrderItem: commerceProductId resolvido pelo JOIN do repositório passa direto; sem catálogo vira null (nunca inventado)', () => {
  const comCatalogo = mapOrderItem(ITEM_RESOLVIDO);
  assert.equal(comCatalogo.commerceProductId, 'c1000000-0000-4000-8000-000000000001');
  assert.equal(comCatalogo.commerceVariantId, null); // pedidos_ink_itens não guarda provider_variant_id
  assert.equal(comCatalogo.quantity, 2);
  assert.equal(comCatalogo.totalValue, 199.8);
  assert.equal(comCatalogo.unitValue, 99.9); // valor_venda é o TOTAL da linha, não o unitário

  const semCatalogo = mapOrderItem(ITEM_SEM_CATALOGO);
  assert.equal(semCatalogo.commerceProductId, null);
});

test('G.1 · mapOrderItem: quantidade 0 nunca divide por zero (unitValue cai pro total, sem Infinity/NaN)', () => {
  const it = mapOrderItem({ ...ITEM_RESOLVIDO, quantidade: 0 });
  assert.equal(it.unitValue, 199.8);
  assert.ok(Number.isFinite(it.unitValue));
});

test('G.1 · mapOrder: itens mapeados em ordem, agregando o pedido inteiro', () => {
  const o = mapOrder({ pedido: PEDIDO_PAGO, itens: [ITEM_RESOLVIDO, ITEM_SEM_CATALOGO] }, CTX);
  assert.equal(o.items.length, 2);
  assert.equal(o.items[0].commerceProductId, 'c1000000-0000-4000-8000-000000000001');
  assert.equal(o.items[1].commerceProductId, null);
});

// Comparativo: o vocabulário "pago" do mapper novo é EXATAMENTE o PAYMENT_STATUSES_CONVERTIDO do
// server.js (extraído por regex do arquivo real, nunca reescrito à mão aqui) — nunca importa
// server.js (intocável), mas também nunca diverge dele em silêncio.
test('G.1 · comparativo: PAGAMENTOS_CONVERTIDOS_INK é exatamente PAYMENT_STATUSES_CONVERTIDO do server.js', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = fonte.match(/const PAYMENT_STATUSES_CONVERTIDO = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'PAYMENT_STATUSES_CONVERTIDO não encontrado em server.js — o comparativo ficaria cego');
  const doServer = new Set(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
  assert.deepEqual([...PAGAMENTOS_CONVERTIDOS_INK].sort(), [...doServer].sort());
});

// Comparativo: 'refunded'/'refund_requested' são valores reais do enum documentado (RESUMO_PROBLEMA
// em server.js já trata os dois como estado de payment_status observável) — nunca inventados aqui.
test('G.1 · comparativo: refunded/refund_requested estão no enum de payment_status que o server.js já trata (RESUMO_PROBLEMA)', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = fonte.match(/const RESUMO_PROBLEMA = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'RESUMO_PROBLEMA não encontrado em server.js — o comparativo ficaria cego');
  const doServer = new Set(m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean));
  for (const status of PAGAMENTOS_REEMBOLSO_INK) assert.ok(doServer.has(status), `${status} não está em RESUMO_PROBLEMA do server.js`);
});
