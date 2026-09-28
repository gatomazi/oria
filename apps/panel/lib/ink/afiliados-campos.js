'use strict';

// Campos do pedido da INK que o módulo de afiliados (lib/afiliados) precisa e que o cache local não guardava. Puro e testado
// (test/ink-afiliados-campos.test.js). Quem grava é o MESMO upsert de pedido já usado pelo sync e pelo webhook (server.js):
// nenhuma chamada nova à API da INK.
//
// `affiliate_snapshot_at` só é preenchido quando o payload é COMPLETO (traz itens): é ele que separa "pedido sem cupom" de
// "pedido ainda não reprocessado com cupom e devolução conhecidos" — o segundo nunca é tratado como "sem cupom".

// A INK devolve decimais como string ("100.00"); guarda-se o texto normalizado para o NUMERIC do Postgres (sem passar por float).
function decimalOuNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? t : null;
}

function inteiroOuNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

function dataOuNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const cupomOuNull = (v) => {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' || t.length > 64 ? null : t;
};

// Valores na ORDEM das colunas adicionadas ao INSERT de pedidos_ink:
//   promotion_code, promotion_value, payment_discount_value, freight_value_difference, kickback_value, delivered_at, affiliate_snapshot_at
function camposDeAfiliadosDoPedido(order, agora = new Date()) {
  const completo = !!order && Array.isArray(order.items);
  const entrega = order && order.delivery ? order.delivery : null;
  return [
    completo ? cupomOuNull(order.promotion_code) : null,
    completo ? decimalOuNull(order.promotion_value) : null,
    completo ? decimalOuNull(order.payment_discount_value) : null,
    completo ? decimalOuNull(order.freight_value_difference) : null,
    completo ? decimalOuNull(order.kickback_value) : null,
    entrega ? dataOuNull(entrega.delivered_at) : null,
    completo ? agora.toISOString() : null,
  ];
}

// Extras de UM item de pedido (os que financeiroItensPedidoInk devolve além do que já devolvia).
function camposDeAfiliadosDoItem(it) {
  const produto = (it && it.product_v2) || {};
  const variante = (it && it.product_variant) || {};
  return {
    valorUnitario: decimalOuNull(it && it.unit_value),
    quantidadeDevolvida: inteiroOuNull(it && it.refunded_quantity) ?? 0,
    quantidadeGratis: inteiroOuNull(it && it.free_quantity) ?? 0,
    custoBaseUnitario: decimalOuNull(it && it.unit_ink_base_price),
    servicoAdicionalUnitario: decimalOuNull(it && it.unit_additional_service_price),
    varianteId: inteiroOuNull(variante.id),
    clusterId: inteiroOuNull(produto.product_cluster_id),
  };
}

module.exports = { camposDeAfiliadosDoPedido, camposDeAfiliadosDoItem, decimalOuNull };
