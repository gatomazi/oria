'use strict';

// Motor de atribuição e comissão POR ITEM. Puro: recebe o pedido/itens (já em centavos), os cupons, as collabs
// e uma função que devolve a versão de contrato vigente numa data; devolve atribuições, revisões e o alvo de
// comissão de cada atribuição. Não toca banco, relógio nem rede — quem persiste é o serviço.
//
// Princípios (docs/afiliados/arquitetura.md):
//   - fail-closed: dado ambíguo ou faltante vira `reviews`, nunca um chute e nunca dinheiro liberado;
//   - por item: apura a linha antes de agregar por pedido/parceiro; nunca duas comissões na mesma linha por padrão;
//   - a apuração usa ids (`product_id` da linha × vínculo versionado da collab), nunca título, imagem, slug ou cluster;
//   - desconto do pedido (promoção + forma de pagamento) é rateado entre as linhas pelo valor bruto, com centavos
//     residuais determinísticos; frete NUNCA entra na base; `kickback_value` da INK é só conferência.

const { percentualDe, proporcao, ratear } = require('./money');

const ESTADOS_PAGOS = new Set(['paid', 'succeeded', 'free']);
const ESTADOS_AGUARDANDO = new Set(['pending', 'waiting_payment', 'awaiting_analysis', 'waiting_approval']);
const ESTADOS_CANCELADOS = new Set(['canceled', 'failed', 'expired', 'not_authorized', 'payment_refused']);
const ESTADOS_ENTREGUES = new Set(['delivered', 'delivered_correios']);
const ROTULOS_PT = Object.freeze({
  pago: 'paid', pendente: 'waiting_payment', expirado: 'expired', 'não autorizado': 'not_authorized',
  'aguardando análise': 'awaiting_analysis', cancelado: 'canceled', reembolsado: 'refunded', contestado: 'dispute',
});

const MODALIDADES_DE_COLLAB = new Set(['collab', 'hybrid']);
const MODALIDADES_DE_CUPOM = new Set(['coupon', 'hybrid']);

function normalizarCodigo(codigo) {
  if (codigo === null || codigo === undefined) return null;
  const c = String(codigo).trim().toUpperCase();
  return c === '' ? null : c;
}

function normalizarEstado(valor) {
  const t = String(valor === null || valor === undefined ? '' : valor).trim().toLowerCase();
  return ROTULOS_PT[t] || t;
}

const emJanela = (inicio, fim, instante) => {
  const t = instante.getTime();
  if (inicio && t < new Date(inicio).getTime()) return false;
  if (fim && t >= new Date(fim).getTime()) return false;
  return true;
};

// Estado de negócio do pedido, a partir do que o cache guarda (payment_status/order_status/entrega/troca).
function estadoDoPedido(pedido) {
  if (pedido.isExchange) return 'exchange';
  const pagamento = normalizarEstado(pedido.paymentStatus);
  const situacao = normalizarEstado(pedido.orderStatus);
  if (pagamento === 'chargeback') return 'chargeback';
  if (pagamento === 'refunded' || situacao === 'refunded') return 'refunded';
  if (pagamento === 'dispute' || pagamento === 'refund_requested' || situacao === 'refund_requested') return 'disputed';
  if (ESTADOS_CANCELADOS.has(pagamento) || ESTADOS_CANCELADOS.has(situacao)) return 'canceled';
  if (ESTADOS_AGUARDANDO.has(pagamento)) return 'awaiting_payment';
  if (ESTADOS_PAGOS.has(pagamento)) {
    return pedido.deliveredAt || ESTADOS_ENTREGUES.has(situacao) ? 'delivered' : 'paid';
  }
  return 'unknown';
}

const ESTADOS_SEM_COMISSAO = new Set(['canceled', 'refunded', 'chargeback']);

// Rateia o desconto do pedido entre as linhas pelo valor bruto (maior resto). Sem linhas com valor, ninguém recebe desconto.
function ratearDescontos(itens, descontoTotalCents) {
  const brutos = itens.map((i) => Math.max(0, i.totalValueCents));
  const somaBruta = brutos.reduce((a, b) => a + b, 0);
  if (somaBruta === 0 || descontoTotalCents <= 0) return itens.map(() => 0);
  return ratear(Math.min(descontoTotalCents, somaBruta), brutos);
}

// Comissão de UMA regra sobre a parcela (`shareBps`) da linha. Devolve { cents, unknown }.
function comissaoDaRegra(versao, base) {
  const { baseElegivelCents, custoElegivelCents, qtdElegivel, shareBps } = base;
  if (versao.commissionBasis === 'fixed_per_unit') {
    return { cents: proporcao(versao.fixedPerUnitCents * qtdElegivel, shareBps, 10000), unknown: false };
  }
  const baseParte = percentualDe(baseElegivelCents, shareBps);
  if (versao.commissionBasis === 'net_item_revenue_percent') {
    return { cents: percentualDe(baseParte, versao.commissionBps), unknown: false };
  }
  // verified_margin_percent
  if (custoElegivelCents === null) return { cents: 0, unknown: true };
  const custoParte = percentualDe(custoElegivelCents, shareBps);
  const margem = baseParte - custoParte;
  return { cents: margem > 0 ? percentualDe(margem, versao.commissionBps) : 0, unknown: false };
}

function chaveIdempotente(pedidoId, itemId, basis, partnerId) {
  return `attr:v1:${pedidoId}:${itemId}:${basis}:${partnerId}`;
}

/**
 * @returns {{orderState:string, attributions:object[], reviews:object[], skipped:object[]}}
 */
function apurarPedido(entrada) {
  const { order, items, coupons = [], collabs = [], partners = {}, versionAt, minContributionBps = 0, overrides = {} } = entrada;
  const resultado = { orderState: 'unknown', attributions: [], reviews: [], skipped: [] };
  const saleAt = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt);

  const estado = estadoDoPedido(order);
  resultado.orderState = estado;
  if (estado === 'exchange') {
    resultado.skipped.push({ reason: 'exchange_is_not_a_sale' });
    return resultado;
  }
  if (estado === 'unknown') {
    resultado.reviews.push({ inkItemId: null, reason: 'unknown_payment_status', details: { paymentStatus: order.paymentStatus ?? null, orderStatus: order.orderStatus ?? null } });
    return resultado;
  }
  if (!order.snapshotComplete) {
    // Pedido anterior ao campo novo (cupom/devolução desconhecidos): não dá para afirmar "sem cupom".
    resultado.reviews.push({ inkItemId: null, reason: 'order_data_incomplete', details: { hint: 'pedido ainda não reprocessado com cupom e quantidade devolvida' } });
    return resultado;
  }

  const codigo = normalizarCodigo(order.promotionCode);
  const descontoTotal = Math.max(0, order.promotionValueCents || 0) + Math.max(0, order.paymentDiscountCents || 0);
  const descontos = ratearDescontos(items, descontoTotal);
  const semComissao = ESTADOS_SEM_COMISSAO.has(estado);

  const cupons = codigo
    ? coupons.filter((l) => l.codeNormalized === codigo && !['planned', 'pending_validation'].includes(l.status) && emJanela(l.validFrom, l.validUntil, saleAt))
    : [];

  items.forEach((item, idx) => {
    const itemId = item.itemId;
    const qtd = item.quantity;
    const gratis = item.freeQuantity || 0;
    const devolvida = item.refundedQuantity || 0;
    const qtdPaga = qtd - gratis;

    // Associação MANUAL auditada (resolução de revisão): substitui o casamento automático desta linha.
    const forcado = overrides[String(itemId)] || null;
    const cuponsDaLinha = forcado && forcado.couponLinkId ? coupons.filter((l) => l.id === forcado.couponLinkId) : cupons;

    // ── Colisões e dados ambíguos: revisão, nunca chute ──────────────────────────────────────────────
    const collabsDaJanela = collabs.filter((c) => emJanela(c.startsAt, c.endsAt, saleAt));
    if (!forcado && (item.productId === null || item.productId === undefined)) {
      if (collabsDaJanela.some((c) => c.memberships.length > 0)) {
        resultado.reviews.push({ inkItemId: itemId, reason: 'item_without_product_id', details: { sku: item.sku ?? null, variantId: item.variantId ?? null } });
      }
      if (cuponsDaLinha.length === 0) return;
    }

    const collabsCasadas = forcado && forcado.collabId ? collabs.filter((c) => c.id === forcado.collabId)
      : (item.productId === null || item.productId === undefined ? [] : collabsDaJanela.filter((c) => c.memberships.some((m) => (
      m.status !== 'pending_approval'
      && String(m.productId) === String(item.productId)
      && emJanela(m.validFrom, m.validTo, saleAt)
      && (m.variantId === null || m.variantId === undefined || (item.variantId !== null && item.variantId !== undefined && String(m.variantId) === String(item.variantId)))
    ))));
    const variantePendente = !forcado && item.productId !== null && item.productId !== undefined && collabsDaJanela.some((c) => c.memberships.some((m) => (
      m.status !== 'pending_approval' && String(m.productId) === String(item.productId) && emJanela(m.validFrom, m.validTo, saleAt)
      && m.variantId !== null && m.variantId !== undefined && (item.variantId === null || item.variantId === undefined)
    )));
    if (variantePendente) {
      resultado.reviews.push({ inkItemId: itemId, reason: 'variant_unresolved', details: { productId: item.productId } });
      return;
    }
    if (collabsCasadas.length > 1) {
      resultado.reviews.push({ inkItemId: itemId, reason: 'multiple_collab_match', details: { collabIds: collabsCasadas.map((c) => c.id) } });
      return;
    }
    if (cuponsDaLinha.length > 1) {
      resultado.reviews.push({ inkItemId: itemId, reason: 'multiple_coupon_match', details: { code: codigo } });
      return;
    }
    if (gratis > 0) {
      resultado.reviews.push({ inkItemId: itemId, reason: 'free_quantity_unconfirmed', details: { freeQuantity: gratis, quantity: qtd } });
      return;
    }

    // ── Base da linha ────────────────────────────────────────────────────────────────────────────────
    const brutoCents = Math.max(0, item.totalValueCents);
    const liquidoCents = Math.max(0, brutoCents - descontos[idx]);
    const qtdElegivel = semComissao ? 0 : Math.max(0, qtdPaga - devolvida);
    const baseElegivelCents = qtdPaga > 0 ? proporcao(liquidoCents, qtdElegivel, qtdPaga) : 0;
    const custoUnit = item.unitCostCents === null || item.unitCostCents === undefined ? null : item.unitCostCents;
    const custoElegivelCents = custoUnit === null ? null : custoUnit * qtdElegivel;
    const custoPagoCents = custoUnit === null ? null : custoUnit * qtdPaga;
    const margemPreParceriaCents = custoPagoCents === null ? null : liquidoCents - custoPagoCents;

    const base = { baseElegivelCents, custoElegivelCents, qtdElegivel };
    const linha = { brutoCents, descontoAlocadoCents: descontos[idx], liquidoCents, qtd, qtdPaga, devolvida, qtdElegivel, baseElegivelCents, custoUnitarioCents: custoUnit, custoQualidade: custoUnit === null ? 'unknown' : 'production_only', margemPreParceriaCents };

    // ── Quem tem direito ─────────────────────────────────────────────────────────────────────────────
    const candidatos = [];
    const evidenciaBase = { orderState: estado, promotionCode: codigo, productId: item.productId ?? null };
    const cupomCasado = cuponsDaLinha.length === 1 ? cuponsDaLinha[0] : null;
    const versaoCupom = cupomCasado ? versionAt(cupomCasado.contractId, saleAt) : null;
    const cupomVale = !!(versaoCupom && versaoCupom.status === 'active' && MODALIDADES_DE_CUPOM.has(versaoCupom.modality));
    if (cupomCasado && !cupomVale) {
      resultado.skipped.push({ inkItemId: itemId, reason: 'coupon_contract_not_active_at_sale', couponLinkId: cupomCasado.id });
    }

    if (collabsCasadas.length === 1) {
      const collab = collabsCasadas[0];
      const criadores = collab.creators
        .filter((c) => emJanela(c.validFrom, c.validTo, saleAt))
        .map((c) => ({ ...c, versao: versionAt(c.contractId, saleAt) }))
        .filter((c) => c.versao && c.versao.status === 'active' && MODALIDADES_DE_COLLAB.has(c.versao.modality));
      if (criadores.length === 0) {
        resultado.reviews.push({ inkItemId: itemId, reason: 'collab_without_valid_creator', details: { collabId: collab.id } });
        return;
      }
      const politicas = new Set(criadores.map((c) => c.versao.conflictPolicy));
      if (politicas.size > 1) {
        resultado.reviews.push({ inkItemId: itemId, reason: 'conflict_policy_mismatch', details: { collabId: collab.id, policies: [...politicas] } });
        return;
      }
      const politica = [...politicas][0];
      const splitCollab = criadores[0].versao.splitCollabBps;
      const splits = new Set(criadores.map((c) => c.versao.splitCollabBps));
      if (politica === 'split_explicit' && splits.size > 1) {
        resultado.reviews.push({ inkItemId: itemId, reason: 'conflict_policy_mismatch', details: { collabId: collab.id, split: [...splits] } });
        return;
      }

      const gerarCollab = (ladoBps) => criadores.forEach((c) => candidatos.push({
        basis: 'collab', partnerId: c.partnerId, versao: c.versao, collabId: collab.id, couponLinkId: null,
        shareBps: Math.max(1, Math.round((c.shareBps * ladoBps) / 10000)), sideBps: ladoBps, creatorShareBps: c.shareBps,
      }));
      const gerarCupom = (ladoBps) => candidatos.push({
        basis: 'coupon', partnerId: cupomCasado.partnerId, versao: versaoCupom, collabId: null, couponLinkId: cupomCasado.id,
        shareBps: ladoBps, sideBps: ladoBps, creatorShareBps: 10000,
      });

      if (politica === 'coupon_precedence' && cupomVale) gerarCupom(10000);
      else if (politica === 'split_explicit' && cupomVale) { gerarCollab(splitCollab); gerarCupom(10000 - splitCollab); }
      else {
        // collab_precedence (padrão): a collab paga; o cupom (do mesmo criador ou de terceiro) fica só como evidência.
        gerarCollab(10000);
        if (cupomCasado) evidenciaBase.couponAlsoMatched = { couponLinkId: cupomCasado.id, partnerId: cupomCasado.partnerId, paidOnThisLine: false };
      }
    } else if (cupomCasado && cupomVale) {
      candidatos.push({
        basis: 'coupon', partnerId: cupomCasado.partnerId, versao: versaoCupom, collabId: null, couponLinkId: cupomCasado.id,
        shareBps: 10000, sideBps: 10000, creatorShareBps: 10000,
      });
    }

    // ── Comissão de cada candidato ───────────────────────────────────────────────────────────────────
    const gerados = candidatos.map((cand) => {
      const parceiro = partners[cand.partnerId] || {};
      const regra = comissaoDaRegra(cand.versao, { ...base, shareBps: cand.shareBps });
      let status = 'calculated';
      let motivo = null;
      if (parceiro.legacyInkAffiliate) { status = 'blocked'; motivo = 'legacy_ink_affiliate_conflict'; }
      else if (regra.unknown) { status = 'manual_review'; motivo = 'cost_unknown'; }
      const alvo = status === 'calculated' ? regra.cents : 0;
      return {
        inkItemId: itemId,
        partnerId: cand.partnerId,
        contractId: cand.versao.contractId,
        contractVersionId: cand.versao.id,
        basis: cand.basis,
        collabId: cand.collabId,
        couponLinkId: cand.couponLinkId,
        creatorShareBps: cand.shareBps,
        status,
        reviewReason: motivo,
        evidence: { ...evidenciaBase, sideBps: cand.sideBps, creatorShareBps: cand.creatorShareBps, conflictPolicy: cand.versao.conflictPolicy },
        snapshot: {
          ...linha,
          shareBps: cand.shareBps,
          rule: { basis: cand.versao.commissionBasis, commissionBps: cand.versao.commissionBps ?? null, fixedPerUnitCents: cand.versao.fixedPerUnitCents ?? null },
          levelKey: cand.versao.levelKey ?? null,
          contractVersion: cand.versao.version ?? null,
          commissionTargetCents: alvo,
        },
        manualOverride: !!forcado,
        current: {
          orderState: estado,
          targetCommissionCents: alvo,
          eligibleQty: qtdElegivel,
          baseEligibleCents: baseElegivelCents,
          marginEligibleCents: custoElegivelCents === null ? null : baseElegivelCents - custoElegivelCents,
        },
        idempotencyKey: chaveIdempotente(order.inkOrderId, itemId, cand.basis, cand.partnerId),
        saleAt,
      };
    });

    // Contribuição depois de TODAS as comissões da linha (estimada quando falta custo).
    const totalLinha = gerados.filter((g) => g.status === 'calculated').reduce((s, g) => s + g.current.targetCommissionCents, 0);
    // Sobre as unidades ELEGÍVEIS (devolução reduz base e custo juntos). "estimated": falta custo de taxas/impostos.
    const contribuicao = custoElegivelCents === null ? null : baseElegivelCents - custoElegivelCents - totalLinha;
    const alerta = contribuicao !== null && baseElegivelCents > 0 && contribuicao < percentualDe(baseElegivelCents, minContributionBps);
    for (const g of gerados) {
      g.snapshot.contributionAfterPartnerCents = contribuicao;
      g.snapshot.contributionQuality = custoElegivelCents === null ? 'unknown' : 'estimated';
      g.snapshot.marginAlert = alerta;
      g.current.marginAlert = alerta;
      g.current.contributionAfterPartnerCents = contribuicao;
      resultado.attributions.push(g);
    }
  });

  return resultado;
}

module.exports = {
  ESTADOS_PAGOS, MODALIDADES_DE_COLLAB, MODALIDADES_DE_CUPOM, normalizarCodigo, normalizarEstado, estadoDoPedido, apurarPedido, ratearDescontos, comissaoDaRegra, chaveIdempotente,
};
