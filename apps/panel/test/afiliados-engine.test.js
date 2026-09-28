'use strict';

// Motor de atribuição por item (lib/afiliados/engine.js): matriz de colisões, base contratual, descontos e estados.

const test = require('node:test');
const assert = require('node:assert/strict');

const { apurarPedido, estadoDoPedido, normalizarCodigo } = require('../lib/afiliados/engine');

const VENDA = new Date('2026-09-10T15:00:00Z');
const ANTES = new Date('2026-01-01T00:00:00Z');

let seqVersao = 0;
function versao(contractId, extra = {}) {
  seqVersao += 1;
  return {
    id: `ver-${contractId}-${seqVersao}`, contractId, version: 1, status: 'active', modality: 'hybrid',
    commissionBasis: 'verified_margin_percent', commissionBps: 2000, fixedPerUnitCents: null,
    conflictPolicy: 'collab_precedence', splitCouponBps: null, splitCollabBps: null, levelKey: 'raiz', ...extra,
  };
}

function pedido(extra = {}) {
  return {
    inkOrderId: 9001, createdAt: VENDA, paymentStatus: 'paid', orderStatus: 'paid', isExchange: false, deliveredAt: null,
    snapshotComplete: true, promotionCode: null, promotionValueCents: 0, paymentDiscountCents: 0, freightDifferenceCents: 0, kickbackCents: null,
    ...extra,
  };
}

function item(itemId, productId, extra = {}) {
  return { itemId, productId, variantId: null, clusterId: null, quantity: 1, freeQuantity: 0, refundedQuantity: 0, totalValueCents: 10000, unitCostCents: 6000, sku: null, ...extra };
}

function collab(id, produtos, criadores, extra = {}) {
  return {
    id, startsAt: ANTES, endsAt: null,
    memberships: produtos.map((p) => ({ productId: p, variantId: null, status: 'active', validFrom: ANTES, validTo: null })),
    creators: criadores.map(([partnerId, contractId, shareBps = 10000]) => ({ partnerId, contractId, shareBps, validFrom: ANTES, validTo: null })),
    ...extra,
  };
}

function cupom(id, partnerId, contractId, code, extra = {}) {
  return { id, partnerId, contractId, codeNormalized: code, validFrom: ANTES, validUntil: null, status: 'active', ...extra };
}

function rodar(entrada) {
  const versoes = entrada.versoes || {};
  return apurarPedido({
    coupons: [], collabs: [], partners: {}, minContributionBps: 0,
    ...entrada,
    versionAt: (contractId) => versoes[contractId] || null,
  });
}

const totalDe = (r) => r.attributions.filter((a) => a.status === 'calculated').reduce((s, a) => s + a.current.targetCommissionCents, 0);
const daLinha = (r, itemId) => r.attributions.filter((a) => a.inkItemId === itemId);

test('exemplo do contrato: 2 itens de R$100, desconto de R$20, custo R$60; collab 20% e cupom 15% de margem', () => {
  const r = rodar({
    order: pedido({ promotionCode: ' amanda10 ', promotionValueCents: 2000 }),
    items: [item(1, 111), item(2, 222)],
    collabs: [collab('c1', [111], [['pCollab', 'kCollab']])],
    coupons: [cupom('l1', 'pCupom', 'kCupom', 'AMANDA10')],
    versoes: { kCollab: versao('kCollab', { commissionBps: 2000 }), kCupom: versao('kCupom', { commissionBps: 1500 }) },
  });
  const collabAttr = daLinha(r, 1);
  const cupomAttr = daLinha(r, 2);
  assert.equal(collabAttr.length, 1);
  assert.equal(collabAttr[0].basis, 'collab');
  assert.equal(collabAttr[0].snapshot.liquidoCents, 9000);
  assert.equal(collabAttr[0].snapshot.margemPreParceriaCents, 3000);
  assert.equal(collabAttr[0].current.targetCommissionCents, 600);
  assert.equal(cupomAttr.length, 1);
  assert.equal(cupomAttr[0].basis, 'coupon');
  assert.equal(cupomAttr[0].current.targetCommissionCents, 450);
  assert.equal(totalDe(r), 1050);
  // O cupom de OUTRO parceiro não paga também sobre o item da collab: fica só como evidência.
  assert.equal(collabAttr[0].evidence.couponAlsoMatched.paidOnThisLine, false);
});

test('collab sem cupom gera comissão pelo produto vinculado (produto isolado, sem cluster)', () => {
  const r = rodar({
    order: pedido(),
    items: [item(1, 111, { clusterId: null })],
    collabs: [collab('c1', [111], [['p1', 'k1']])],
    versoes: { k1: versao('k1', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000 }) },
  });
  assert.equal(r.attributions.length, 1);
  assert.equal(r.attributions[0].current.targetCommissionCents, 1000);
  assert.equal(r.attributions[0].evidence.promotionCode, null);
});

test('produto fora da collab não gera comissão de collab; código não cadastrado não gera comissão', () => {
  const r = rodar({
    order: pedido({ promotionCode: 'DESCONHECIDO' }),
    items: [item(1, 999)],
    collabs: [collab('c1', [111], [['p1', 'k1']])],
    coupons: [cupom('l1', 'p2', 'k2', 'OUTRO')],
    versoes: { k1: versao('k1'), k2: versao('k2') },
  });
  assert.equal(r.attributions.length, 0);
  assert.equal(r.reviews.length, 0);
});

test('cupom expirado respeita a vigência: venda depois de valid_until não comissiona', () => {
  const r = rodar({
    order: pedido({ promotionCode: 'VELHO' }),
    items: [item(1, 999)],
    coupons: [cupom('l1', 'p2', 'k2', 'VELHO', { validUntil: new Date('2026-09-01T00:00:00Z') })],
    versoes: { k2: versao('k2') },
  });
  assert.equal(r.attributions.length, 0);
});

test('cupom planejado ou ainda não validado não comissiona', () => {
  for (const status of ['planned', 'pending_validation']) {
    const r = rodar({
      order: pedido({ promotionCode: 'NOVO' }),
      items: [item(1, 999)],
      coupons: [cupom('l1', 'p2', 'k2', 'NOVO', { status })],
      versoes: { k2: versao('k2') },
    });
    assert.equal(r.attributions.length, 0, status);
  }
});

test('cupom do PRÓPRIO criador da collab não paga duas vezes a mesma linha', () => {
  const r = rodar({
    order: pedido({ promotionCode: 'AMANDA10' }),
    items: [item(1, 111)],
    collabs: [collab('c1', [111], [['pA', 'kA']])],
    coupons: [cupom('l1', 'pA', 'kA', 'AMANDA10')],
    versoes: { kA: versao('kA', { commissionBps: 2000 }) },
  });
  assert.equal(r.attributions.length, 1);
  assert.equal(r.attributions[0].basis, 'collab');
  assert.equal(r.attributions[0].evidence.couponAlsoMatched.partnerId, 'pA');
  assert.equal(totalDe(r), 800);
});

test('split_explicit paga collab e cupom com fatias auditáveis da mesma linha', () => {
  const kA = versao('kA', { commissionBasis: 'net_item_revenue_percent', commissionBps: 2000, conflictPolicy: 'split_explicit', splitCollabBps: 7000, splitCouponBps: 3000 });
  const kB = versao('kB', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000 });
  const r = rodar({
    order: pedido({ promotionCode: 'TERCEIRO' }),
    items: [item(1, 111)],
    collabs: [collab('c1', [111], [['pA', 'kA']])],
    coupons: [cupom('l1', 'pB', 'kB', 'TERCEIRO')],
    versoes: { kA, kB },
  });
  const collabAttr = r.attributions.find((a) => a.basis === 'collab');
  const cupomAttr = r.attributions.find((a) => a.basis === 'coupon');
  // Collab: 20% de 70% de R$100; cupom: 10% de 30% de R$100.
  assert.equal(collabAttr.current.targetCommissionCents, 1400);
  assert.equal(cupomAttr.current.targetCommissionCents, 300);
  assert.equal(collabAttr.evidence.sideBps, 7000);
  assert.equal(cupomAttr.evidence.sideBps, 3000);
});

test('coupon_precedence: o titular do cupom recebe, o criador da collab não', () => {
  const kA = versao('kA', { conflictPolicy: 'coupon_precedence', commissionBasis: 'net_item_revenue_percent', commissionBps: 2000 });
  const kB = versao('kB', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000 });
  const r = rodar({
    order: pedido({ promotionCode: 'TERCEIRO' }),
    items: [item(1, 111)],
    collabs: [collab('c1', [111], [['pA', 'kA']])],
    coupons: [cupom('l1', 'pB', 'kB', 'TERCEIRO')],
    versoes: { kA, kB },
  });
  assert.equal(r.attributions.length, 1);
  assert.equal(r.attributions[0].partnerId, 'pB');
  assert.equal(r.attributions[0].current.targetCommissionCents, 1000);
});

test('duas collabs de criadores diferentes no mesmo carrinho apuram cada uma na sua linha', () => {
  const r = rodar({
    order: pedido(),
    items: [item(1, 111), item(2, 222)],
    collabs: [collab('c1', [111], [['pA', 'kA']]), collab('c2', [222], [['pB', 'kB']])],
    versoes: { kA: versao('kA', { commissionBps: 2000 }), kB: versao('kB', { commissionBps: 1000 }) },
  });
  assert.equal(daLinha(r, 1)[0].partnerId, 'pA');
  assert.equal(daLinha(r, 1)[0].current.targetCommissionCents, 800);
  assert.equal(daLinha(r, 2)[0].partnerId, 'pB');
  assert.equal(daLinha(r, 2)[0].current.targetCommissionCents, 400);
});

test('dois criadores na mesma arte: ledger separado por criador e fatias que somam a base', () => {
  const r = rodar({
    order: pedido(),
    items: [item(1, 111, { totalValueCents: 10000, unitCostCents: 0 })],
    collabs: [collab('c1', [111], [['pA', 'kA', 6000], ['pB', 'kB', 4000]])],
    versoes: {
      kA: versao('kA', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000 }),
      kB: versao('kB', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000 }),
    },
  });
  assert.equal(r.attributions.length, 2);
  const [a, b] = r.attributions;
  assert.equal(a.partnerId, 'pA');
  assert.equal(a.current.targetCommissionCents, 600);
  assert.equal(b.partnerId, 'pB');
  assert.equal(b.current.targetCommissionCents, 400);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
});

test('criadores com políticas de conflito diferentes vão para revisão manual, nunca pagam automaticamente', () => {
  const r = rodar({
    order: pedido(),
    items: [item(1, 111)],
    collabs: [collab('c1', [111], [['pA', 'kA', 5000], ['pB', 'kB', 5000]])],
    versoes: { kA: versao('kA'), kB: versao('kB', { conflictPolicy: 'coupon_precedence' }) },
  });
  assert.equal(r.attributions.length, 0);
  assert.equal(r.reviews[0].reason, 'conflict_policy_mismatch');
});

test('mudança retroativa de contrato: vale a versão vigente na data da venda', () => {
  const antiga = versao('k1', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000, version: 1 });
  const nova = versao('k1', { commissionBasis: 'net_item_revenue_percent', commissionBps: 2500, version: 2 });
  const entrada = { order: pedido(), items: [item(1, 111)], collabs: [collab('c1', [111], [['p1', 'k1']])] };
  const naVenda = apurarPedido({ ...entrada, coupons: [], partners: {}, versionAt: (c, at) => (at < new Date('2026-09-15T00:00:00Z') ? antiga : nova) });
  assert.equal(naVenda.attributions[0].current.targetCommissionCents, 1000);
  assert.equal(naVenda.attributions[0].contractVersionId, antiga.id);
  const depois = apurarPedido({ ...entrada, order: pedido({ createdAt: new Date('2026-09-20T00:00:00Z') }), coupons: [], partners: {}, versionAt: (c, at) => (at < new Date('2026-09-15T00:00:00Z') ? antiga : nova) });
  assert.equal(depois.attributions[0].current.targetCommissionCents, 2500);
});

test('produto desvinculado DEPOIS da venda continua atribuído; desvinculado ANTES não é', () => {
  const removidoDepois = collab('c1', [], [['p1', 'k1']]);
  removidoDepois.memberships = [{ productId: 111, variantId: null, status: 'removed', validFrom: ANTES, validTo: new Date('2026-09-30T00:00:00Z') }];
  const removidoAntes = collab('c1', [], [['p1', 'k1']]);
  removidoAntes.memberships = [{ productId: 111, variantId: null, status: 'removed', validFrom: ANTES, validTo: new Date('2026-09-01T00:00:00Z') }];
  const versoes = { k1: versao('k1') };
  assert.equal(rodar({ order: pedido(), items: [item(1, 111)], collabs: [removidoDepois], versoes }).attributions.length, 1);
  assert.equal(rodar({ order: pedido(), items: [item(1, 111)], collabs: [removidoAntes], versoes }).attributions.length, 0);
});

test('associação pendente de aprovação não comissiona (nunca retroativa por padrão)', () => {
  const c = collab('c1', [], [['p1', 'k1']]);
  c.memberships = [{ productId: 111, variantId: null, status: 'pending_approval', validFrom: null, validTo: null }];
  const r = rodar({ order: pedido(), items: [item(1, 111)], collabs: [c], versoes: { k1: versao('k1') } });
  assert.equal(r.attributions.length, 0);
});

test('nome, imagem ou cluster iguais não bastam: só o id do produto atribui', () => {
  const r = rodar({
    order: pedido(),
    items: [item(1, 555, { clusterId: 42 })],
    collabs: [{ ...collab('c1', [111], [['p1', 'k1']]), clusterId: 42 }],
    versoes: { k1: versao('k1') },
  });
  assert.equal(r.attributions.length, 0);
});

test('item sem product_id, com collab ativa na janela: revisão manual, sem chute', () => {
  const r = rodar({
    order: pedido(),
    items: [item(1, null, { sku: 'SKU-X' })],
    collabs: [collab('c1', [111], [['p1', 'k1']])],
    versoes: { k1: versao('k1') },
  });
  assert.equal(r.attributions.length, 0);
  assert.equal(r.reviews[0].reason, 'item_without_product_id');
});

test('variante exigida e ausente no item: revisão', () => {
  const c = collab('c1', [], [['p1', 'k1']]);
  c.memberships = [{ productId: 111, variantId: 7, status: 'active', validFrom: ANTES, validTo: null }];
  const sem = rodar({ order: pedido(), items: [item(1, 111)], collabs: [c], versoes: { k1: versao('k1') } });
  assert.equal(sem.reviews[0].reason, 'variant_unresolved');
  const com = rodar({ order: pedido(), items: [item(1, 111, { variantId: 7 })], collabs: [c], versoes: { k1: versao('k1') } });
  assert.equal(com.attributions.length, 1);
  const outra = rodar({ order: pedido(), items: [item(1, 111, { variantId: 8 })], collabs: [c], versoes: { k1: versao('k1') } });
  assert.equal(outra.attributions.length, 0);
});

test('quantidade 2 com devolução de 1 unidade: alvo cai pela metade e a base é a das unidades elegíveis', () => {
  const entrada = {
    order: pedido(),
    items: [item(1, 111, { quantity: 2, totalValueCents: 20000, unitCostCents: 6000 })],
    collabs: [collab('c1', [111], [['p1', 'k1']])],
    versoes: { k1: versao('k1', { commissionBps: 2000 }) },
  };
  const cheio = rodar(entrada);
  // Margem: 20000 - 12000 = 8000; 20% = 1600.
  assert.equal(cheio.attributions[0].current.targetCommissionCents, 1600);
  const devolvido = rodar({ ...entrada, items: [{ ...entrada.items[0], refundedQuantity: 1 }] });
  assert.equal(devolvido.attributions[0].current.targetCommissionCents, 800);
  assert.equal(devolvido.attributions[0].current.eligibleQty, 1);
  assert.equal(devolvido.attributions[0].snapshot.qtdPaga, 2);
});

test('desconto de valor fixo é rateado por linha e soma exatamente o desconto, inclusive R$0,01', () => {
  const r = rodar({
    order: pedido({ promotionCode: 'C', promotionValueCents: 1 }),
    items: [item(1, 111), item(2, 222)],
    coupons: [cupom('l1', 'p1', 'k1', 'C')],
    versoes: { k1: versao('k1', { commissionBasis: 'net_item_revenue_percent', commissionBps: 10000 }) },
  });
  const descontos = r.attributions.map((a) => a.snapshot.descontoAlocadoCents);
  assert.deepEqual(descontos, [1, 0]);
  assert.equal(descontos.reduce((s, x) => s + x, 0), 1);
  assert.equal(r.attributions[0].snapshot.liquidoCents, 9999);
});

test('desconto de forma de pagamento entra no rateio; frete e kickback nunca entram na base', () => {
  const r = rodar({
    order: pedido({ promotionCode: 'C', promotionValueCents: 1000, paymentDiscountCents: 1000, freightDifferenceCents: 3000, kickbackCents: 99999 }),
    items: [item(1, 111), item(2, 222)],
    coupons: [cupom('l1', 'p1', 'k1', 'C')],
    versoes: { k1: versao('k1', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1000 }) },
  });
  assert.deepEqual(r.attributions.map((a) => a.snapshot.liquidoCents), [9000, 9000]);
  assert.equal(totalDe(r), 1800);
});

test('base fixa por unidade e base em receita não exigem custo', () => {
  const semCusto = item(1, 111, { unitCostCents: null });
  const fixo = rodar({
    order: pedido(), items: [{ ...semCusto, quantity: 3, totalValueCents: 30000 }], collabs: [collab('c1', [111], [['p1', 'k1']])],
    versoes: { k1: versao('k1', { commissionBasis: 'fixed_per_unit', commissionBps: null, fixedPerUnitCents: 700 }) },
  });
  assert.equal(fixo.attributions[0].current.targetCommissionCents, 2100);
  assert.equal(fixo.attributions[0].status, 'calculated');
});

test('base em margem com custo desconhecido: revisão manual, sem alvo de comissão', () => {
  const r = rodar({
    order: pedido(), items: [item(1, 111, { unitCostCents: null })], collabs: [collab('c1', [111], [['p1', 'k1']])],
    versoes: { k1: versao('k1') },
  });
  assert.equal(r.attributions[0].status, 'manual_review');
  assert.equal(r.attributions[0].reviewReason, 'cost_unknown');
  assert.equal(r.attributions[0].current.targetCommissionCents, 0);
  assert.equal(r.attributions[0].snapshot.contributionAfterPartnerCents, null);
});

test('margem negativa não gera comissão negativa', () => {
  const r = rodar({
    order: pedido(), items: [item(1, 111, { unitCostCents: 20000 })], collabs: [collab('c1', [111], [['p1', 'k1']])],
    versoes: { k1: versao('k1') },
  });
  assert.equal(r.attributions[0].current.targetCommissionCents, 0);
});

test('alerta de margem: comissão que derruba a contribuição abaixo do mínimo é sinalizada, sem bloquear', () => {
  const r = rodar({
    order: pedido(), items: [item(1, 111, { unitCostCents: 8000 })], collabs: [collab('c1', [111], [['p1', 'k1']])],
    minContributionBps: 1500,
    versoes: { k1: versao('k1', { commissionBasis: 'net_item_revenue_percent', commissionBps: 1500 }) },
  });
  // Receita 100, custo 80, comissão 15 => contribuição 5 (5%) < mínimo de 15%.
  assert.equal(r.attributions[0].snapshot.marginAlert, true);
  assert.equal(r.attributions[0].current.targetCommissionCents, 1500);
});

test('pedido cancelado, reembolsado ou com chargeback tem alvo zero; aguardando pagamento fica provisionado', () => {
  const base = { items: [item(1, 111)], collabs: [collab('c1', [111], [['p1', 'k1']])], versoes: { k1: versao('k1') } };
  for (const [pagamento, situacao, estado] of [['canceled', 'canceled', 'canceled'], ['refunded', 'refunded', 'refunded'], ['chargeback', 'paid', 'chargeback']]) {
    const r = rodar({ ...base, order: pedido({ paymentStatus: pagamento, orderStatus: situacao }) });
    assert.equal(r.orderState, estado);
    assert.equal(r.attributions[0].current.targetCommissionCents, 0, pagamento);
  }
  const aguardando = rodar({ ...base, order: pedido({ paymentStatus: 'waiting_payment', orderStatus: 'waiting_payment' }) });
  assert.equal(aguardando.orderState, 'awaiting_payment');
  assert.equal(aguardando.attributions[0].current.targetCommissionCents, 800);
});

test('troca/reposição não é venda nova', () => {
  const r = rodar({
    order: pedido({ isExchange: true }), items: [item(1, 111)], collabs: [collab('c1', [111], [['p1', 'k1']])], versoes: { k1: versao('k1') },
  });
  assert.equal(r.orderState, 'exchange');
  assert.equal(r.attributions.length, 0);
});

test('pedido sem snapshot completo (anterior ao campo de cupom): revisão, nunca "sem cupom"', () => {
  const r = rodar({
    order: pedido({ snapshotComplete: false }), items: [item(1, 111)], collabs: [collab('c1', [111], [['p1', 'k1']])], versoes: { k1: versao('k1') },
  });
  assert.equal(r.attributions.length, 0);
  assert.equal(r.reviews[0].reason, 'order_data_incomplete');
});

test('status de pagamento desconhecido vai para revisão', () => {
  const r = rodar({ order: pedido({ paymentStatus: 'algo_novo' }), items: [item(1, 111)] });
  assert.equal(r.reviews[0].reason, 'unknown_payment_status');
});

test('parceiro com afiliado nativo da INK declarado: atribuição bloqueada (sem remuneração duplicada)', () => {
  const r = rodar({
    order: pedido(), items: [item(1, 111)], collabs: [collab('c1', [111], [['p1', 'k1']])], versoes: { k1: versao('k1') },
    partners: { p1: { legacyInkAffiliate: true } },
  });
  assert.equal(r.attributions[0].status, 'blocked');
  assert.equal(r.attributions[0].reviewReason, 'legacy_ink_affiliate_conflict');
  assert.equal(r.attributions[0].current.targetCommissionCents, 0);
});

test('contrato pausado/encerrado na data da venda não remunera, e isso é registrado', () => {
  const r = rodar({
    order: pedido({ promotionCode: 'C' }), items: [item(1, 999)], coupons: [cupom('l1', 'p1', 'k1', 'C')],
    versoes: { k1: versao('k1', { status: 'paused' }) },
  });
  assert.equal(r.attributions.length, 0);
  assert.equal(r.skipped[0].reason, 'coupon_contract_not_active_at_sale');
});

test('modalidade do contrato é respeitada: contrato só de cupom não recebe comissão de collab', () => {
  const r = rodar({
    order: pedido(), items: [item(1, 111)], collabs: [collab('c1', [111], [['p1', 'k1']])],
    versoes: { k1: versao('k1', { modality: 'coupon' }) },
  });
  assert.equal(r.attributions.length, 0);
  assert.equal(r.reviews[0].reason, 'collab_without_valid_creator');
});

test('quantidade gratuita (unit_free) com semântica não confirmada: revisão', () => {
  const r = rodar({
    order: pedido(), items: [item(1, 111, { freeQuantity: 1, quantity: 2 })], collabs: [collab('c1', [111], [['p1', 'k1']])], versoes: { k1: versao('k1') },
  });
  assert.equal(r.attributions.length, 0);
  assert.equal(r.reviews[0].reason, 'free_quantity_unconfirmed');
});

test('idempotência: o mesmo pedido apurado duas vezes gera as mesmas chaves e os mesmos valores', () => {
  const entrada = {
    order: pedido({ promotionCode: 'C' }), items: [item(1, 111), item(2, 222)],
    collabs: [collab('c1', [111], [['p1', 'k1']])], coupons: [cupom('l1', 'p2', 'k2', 'C')],
    versoes: { k1: versao('k1'), k2: versao('k2') },
  };
  const a = rodar(entrada);
  const b = rodar(entrada);
  assert.deepEqual(a.attributions.map((x) => [x.idempotencyKey, x.current.targetCommissionCents]), b.attributions.map((x) => [x.idempotencyKey, x.current.targetCommissionCents]));
  assert.equal(new Set(a.attributions.map((x) => x.idempotencyKey)).size, a.attributions.length);
});

test('utilitários: código normalizado (trim + maiúsculas) e rótulos em português', () => {
  assert.equal(normalizarCodigo('  amanda10 '), 'AMANDA10');
  assert.equal(normalizarCodigo('   '), null);
  assert.equal(estadoDoPedido({ paymentStatus: 'Pago', orderStatus: 'paid', deliveredAt: null }), 'paid');
  assert.equal(estadoDoPedido({ paymentStatus: 'paid', orderStatus: 'delivered' }), 'delivered');
  assert.equal(estadoDoPedido({ paymentStatus: 'paid', orderStatus: 'paid', deliveredAt: new Date() }), 'delivered');
  assert.equal(estadoDoPedido({ paymentStatus: 'dispute', orderStatus: 'paid' }), 'disputed');
});
