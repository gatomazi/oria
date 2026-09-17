'use strict';

// Resultado financeiro de pedido da Reserva Ink, no modelo do painel da Ink. Fica fora do server.js
// pelo mesmo motivo de lib/meta: a conta precisa de teste unitário (test/ink-financeiro.test.js) e
// nada dentro do server.js é testável sem subir pool, rotas e timers.
//
// Todo desconto (cupom, desconto do Pix, frete grátis bancado) sai do lojista; a Ink sempre recebe
// o custo base da peça. Validado contra 152 pedidos reais de webhook em 2026-09-14:
//   total_value    = Σ itens + shipping_value − promotion − payment_discount − freight_value_difference  (152/152)
//   kickback_value = Σ itens − Σ custo base − promotion − payment_discount − freight_value_difference   (151/152;
//                    o único fora é pedido reembolsado, com kickback zerado pela Ink)
// Logo: lucro bruto = total − frete pago pelo cliente; lucro operacional = lucro bruto − custo de
// produção = kickback_value (fonte da verdade quando vier). Troca (is_exchange) tem kickback 0 e
// não é venda — fica marcada pra quem soma excluir.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function centavos(v) {
  return Math.round(v * 100) / 100;
}

// Devolve null quando o payload não traz itens (evento parcial): sem itens não dá pra saber o custo.
function financeiroPedidoInk(order) {
  if (!order || !Array.isArray(order.items) || order.total_value == null) return null;
  const custoProducao = order.items.reduce(
    (acc, it) => acc + (num(it && it.unit_ink_base_price) + num(it && it.unit_additional_service_price)) * num(it && it.quantity),
    0
  );
  const frete = num(order.shipping_value);
  const lucroBruto = num(order.total_value) - frete;
  const lucroOperacional = order.kickback_value != null ? num(order.kickback_value) : lucroBruto - custoProducao;
  return {
    frete: centavos(frete),
    descontos: centavos(num(order.promotion_value) + num(order.payment_discount_value) + num(order.freight_value_difference)),
    lucroBruto: centavos(lucroBruto),
    custoProducao: centavos(custoProducao),
    lucroOperacional: centavos(lucroOperacional),
    troca: !!order.is_exchange,
  };
}

// Resultado por item. Os descontos do pedido não vêm por item na Ink, então são rateados pelo valor
// de venda de cada item. Custo = custo base × quantidade. O centavo que sobra do arredondamento vai
// pro último item, pra soma dos itens bater exatamente com o lucro operacional do pedido.
function financeiroItensPedidoInk(order) {
  const fin = financeiroPedidoInk(order);
  if (!fin) return [];
  const itens = order.items.filter((it) => it && it.id != null);
  const vendaTotal = itens.reduce((acc, it) => acc + num(it.total_value), 0);
  let lucroAcumulado = 0;
  return itens.map((it, i) => {
    const venda = num(it.total_value);
    const peso = vendaTotal > 0 ? venda / vendaTotal : 1 / itens.length;
    const custo = centavos((num(it.unit_ink_base_price) + num(it.unit_additional_service_price)) * num(it.quantity));
    const desconto = centavos(fin.descontos * peso);
    const ultimo = i === itens.length - 1;
    const lucro = ultimo ? centavos(fin.lucroOperacional - lucroAcumulado) : centavos(venda - desconto - custo);
    lucroAcumulado += lucro;
    const produto = it.product_v2 || {};
    const variante = it.product_variant || {};
    return {
      itemId: it.id,
      produtoId: produto.id || null,
      produtoNome: produto.name || null,
      sku: it.sku || variante.sku || null,
      modelo: variante.model || null,
      cor: variante.color || null,
      tamanho: variante.size || null,
      quantidade: num(it.quantity),
      venda: centavos(venda),
      desconto,
      custo,
      lucro,
    };
  });
}

module.exports = { financeiroPedidoInk, financeiroItensPedidoInk };
