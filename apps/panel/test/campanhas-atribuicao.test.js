'use strict';

// Testes da atribuição de pedidos/receita a campanhas (lib/campanhas/atribuicao.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { atribuirPedidosCampanha, janelaDiasValida } = require('../lib/campanhas/atribuicao');

function envio(extra) {
  return { lote: 1, sentAt: '2026-09-16T10:00:00Z', telefone: '5553999813355', customerKey: '12345678900', ...extra };
}

function pedido(extra) {
  return { inkOrderId: 1, criadoEm: '2026-09-17T10:00:00Z', valor: 100, telefone: null, documento: null, email: null, ...extra };
}

test('pedido pago do mesmo telefone (sem DDI) dentro da janela conta pra campanha', () => {
  const r = atribuirPedidosCampanha({ envios: [envio()], pedidos: [pedido({ telefone: '53999813355', valor: 89.9 })] });
  assert.equal(r.pedidos, 1);
  assert.equal(r.receita, 89.9);
  assert.deepEqual(r.porLote.get(1), { pedidos: 1, receita: 89.9 });
});

test('casa por documento formatado e por e-mail usado como chave', () => {
  const r = atribuirPedidosCampanha({
    envios: [envio(), envio({ lote: 2, telefone: null, customerKey: 'Ana@Ex.com' })],
    pedidos: [
      pedido({ inkOrderId: 1, documento: '123.456.789-00' }),
      pedido({ inkOrderId: 2, email: ' ana@ex.com ' }),
    ],
  });
  assert.equal(r.pedidos, 2);
  assert.equal(r.porLote.get(2).pedidos, 1);
});

test('pedido antes do envio ou depois da janela de 7 dias não conta', () => {
  const r = atribuirPedidosCampanha({
    envios: [envio()],
    pedidos: [
      pedido({ inkOrderId: 1, telefone: '53999813355', criadoEm: '2026-09-16T09:59:00Z' }),
      pedido({ inkOrderId: 2, telefone: '53999813355', criadoEm: '2026-09-23T10:00:01Z' }),
    ],
  });
  assert.equal(r.pedidos, 0);
  assert.equal(r.receita, 0);
});

test('comprador que não recebeu a campanha não conta', () => {
  const r = atribuirPedidosCampanha({ envios: [envio()], pedidos: [pedido({ telefone: '51988887777' })] });
  assert.equal(r.pedidos, 0);
});

test('outra campanha enviada depois e antes do pedido leva o crédito', () => {
  const r = atribuirPedidosCampanha({
    envios: [envio()],
    outrosEnvios: [envio({ sentAt: '2026-09-17T08:00:00Z' })],
    pedidos: [pedido({ telefone: '53999813355' })],
  });
  assert.equal(r.pedidos, 0);
});

test('outra campanha enviada antes deste envio não tira o crédito', () => {
  const r = atribuirPedidosCampanha({
    envios: [envio()],
    outrosEnvios: [envio({ sentAt: '2026-09-15T08:00:00Z' })],
    pedidos: [pedido({ telefone: '53999813355' })],
  });
  assert.equal(r.pedidos, 1);
});

test('cada pedido conta uma vez só, mesmo casando por várias chaves', () => {
  const r = atribuirPedidosCampanha({
    envios: [envio()],
    pedidos: [pedido({ telefone: '53999813355', documento: '12345678900', valor: 50 })],
  });
  assert.equal(r.pedidos, 1);
  assert.equal(r.receita, 50);
});

test('janela escolhida no painel muda o que entra na atribuição', () => {
  const entrada = { envios: [envio()], pedidos: [pedido({ telefone: '53999813355', criadoEm: '2026-09-26T10:00:00Z' })] };
  assert.equal(atribuirPedidosCampanha(entrada).pedidos, 0);
  assert.equal(atribuirPedidosCampanha({ ...entrada, janelaDias: 14 }).pedidos, 1);
});

test('janela fora da lista permitida cai no padrão de 7 dias', () => {
  assert.equal(janelaDiasValida('14'), 14);
  assert.equal(janelaDiasValida('1'), 1);
  assert.equal(janelaDiasValida('5'), 7);
  assert.equal(janelaDiasValida('9999'), 7);
  assert.equal(janelaDiasValida(undefined), 7);
  assert.equal(janelaDiasValida('abc'), 7);
});
