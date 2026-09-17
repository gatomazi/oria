'use strict';

// Testes da conta financeira de pedido da Reserva Ink (lib/ink/financeiro.js). Os pedidos abaixo
// reproduzem os valores de pedidos reais de webhook (sem dado de comprador), um por regra.

const test = require('node:test');
const assert = require('node:assert/strict');

const { financeiroPedidoInk, financeiroItensPedidoInk } = require('../lib/ink/financeiro');

function item(id, { valor, base, quantidade = 1, modelo = 'Masculino', adicional = '0.0' }) {
  const total = (Number(valor) * quantidade).toFixed(2);
  return {
    id,
    quantity: quantidade,
    unit_value: valor,
    total_value: total,
    unit_ink_base_price: base,
    unit_additional_service_price: adicional,
    unit_kickback_without_promotion_value: (Number(valor) - Number(base)).toFixed(2),
    product_v2: { id: 1000 + id, name: `Produto ${id}` },
    product_variant: { model: modelo, color: 'Preta', size: 'M' },
  };
}

function somaLucroItens(order) {
  return Math.round(financeiroItensPedidoInk(order).reduce((acc, i) => acc + i.lucro, 0) * 100) / 100;
}

test('pedido simples: lucro bruto tira o frete, operacional tira o custo base e bate com o kickback', () => {
  // Pedido INK1996577: 1 camiseta 109,90, base 49,90, frete 16,53.
  const order = {
    total_value: '126.43', shipping_value: '16.53', kickback_value: '60.0',
    promotion_value: '0.0', payment_discount_value: '0.0', freight_value_difference: '0.0',
    items: [item(1, { valor: '109.9', base: '49.9' })],
  };
  const fin = financeiroPedidoInk(order);
  assert.equal(fin.frete, 16.53);
  assert.equal(fin.lucroBruto, 109.9);
  assert.equal(fin.custoProducao, 49.9);
  assert.equal(fin.lucroOperacional, 60);
  assert.equal(fin.descontos, 0);
  assert.equal(fin.troca, false);
});

test('cupom e frete grátis bancado saem do lojista, não da Ink', () => {
  // Pedido INK1992175: 2 × 109,90, cupom 21,98, frete 18,16 inteiro bancado pela loja.
  const order = {
    total_value: '197.82', shipping_value: '18.16', kickback_value: '79.86',
    promotion_value: '21.98', payment_discount_value: '0.0', freight_value_difference: '18.16',
    items: [item(1, { valor: '109.9', base: '49.9' }), item(2, { valor: '109.9', base: '49.9' })],
  };
  const fin = financeiroPedidoInk(order);
  assert.equal(fin.custoProducao, 99.8);
  assert.equal(fin.descontos, 40.14);
  assert.equal(fin.lucroBruto, 179.66);
  assert.equal(Math.round((fin.lucroBruto - fin.custoProducao) * 100) / 100, fin.lucroOperacional);
  assert.equal(fin.lucroOperacional, 79.86);
});

test('sem kickback no payload, operacional cai pra lucro bruto − custo', () => {
  const order = {
    total_value: '126.43', shipping_value: '16.53',
    items: [item(1, { valor: '109.9', base: '49.9' })],
  };
  assert.equal(financeiroPedidoInk(order).lucroOperacional, 60);
});

test('troca é marcada pra ficar fora das somas', () => {
  const order = {
    total_value: '119.9', shipping_value: '10.0', kickback_value: '0.0', is_exchange: true,
    items: [item(1, { valor: '109.9', base: '49.9' })],
  };
  assert.equal(financeiroPedidoInk(order).troca, true);
});

test('payload sem itens não calcula nada (evento parcial)', () => {
  assert.equal(financeiroPedidoInk({ total_value: '10' }), null);
  assert.equal(financeiroPedidoInk(null), null);
  assert.deepEqual(financeiroItensPedidoInk({ total_value: '10' }), []);
});

test('serviço adicional entra no custo de produção', () => {
  const order = {
    total_value: '119.9', shipping_value: '0', kickback_value: '50.0',
    items: [item(1, { valor: '119.9', base: '49.9', adicional: '20.0' })],
  };
  assert.equal(financeiroPedidoInk(order).custoProducao, 69.9);
});

test('rateio: desconto proporcional ao valor e soma dos itens igual ao kickback', () => {
  // Pedido INK1990861: progressivo R$ 25 em 3 peças de valores e bases diferentes, frete grátis 11,55.
  const order = {
    total_value: '283.8', shipping_value: '11.55', kickback_value: '126.45',
    promotion_value: '25.0', payment_discount_value: '0.0', freight_value_difference: '11.55',
    items: [
      item(1, { valor: '109.9', base: '49.9' }),
      item(2, { valor: '109.9', base: '49.9' }),
      item(3, { valor: '89.0', base: '46.0', modelo: 'Infantil' }),
    ],
  };
  const itens = financeiroItensPedidoInk(order);
  assert.equal(itens.length, 3);
  assert.equal(somaLucroItens(order), 126.45);
  assert.ok(itens[0].desconto > itens[2].desconto, 'item mais caro recebe fatia maior do desconto');
  assert.equal(itens[2].modelo, 'Infantil');
  assert.equal(itens[2].custo, 46);
});

test('rateio com quantidade > 1 multiplica custo e mantém a soma exata', () => {
  // Pedido INK1990898: 7 peças a 99,90 (uma linha com 2), progressivo R$ 85, frete grátis 27,18.
  const linhas = [1, 2, 3, 4, 5, 6].map((id) => item(id, { valor: '99.9', base: '49.9', quantidade: id === 4 ? 2 : 1 }));
  const order = {
    total_value: '614.3', shipping_value: '27.18', kickback_value: '237.82',
    promotion_value: '85.0', payment_discount_value: '0.0', freight_value_difference: '27.18',
    items: linhas,
  };
  const itens = financeiroItensPedidoInk(order);
  assert.equal(itens.find((i) => i.itemId === 4).custo, 99.8);
  assert.equal(somaLucroItens(order), 237.82);
});
