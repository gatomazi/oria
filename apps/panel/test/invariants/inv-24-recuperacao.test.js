'use strict';

// INV-24 — o casamento carrinho → compra da recuperação filtra SEMPRE pelo escopo do carrinho.
// O defeito histórico era `if (alvo.loja && p.loja !== alvo.loja)`: sem loja no alvo, o filtro
// sumia e a compra de outra loja (outra Organization) "recuperava" o carrinho.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { acharCompraDoCarrinho } = h.sujeito('lib/recuperacao/compra.js');

const pedidoDeOutraLoja = { loja: 'centro', inkOrderId: 7, criadoEm: '2026-09-12T15:00:00Z', telefone: '53999813355' };

test('INV-24 · alvo sem escopo é erro, nunca busca em todos os pedidos', () => {
  for (const alvo of [{ telefone: '53999813355' }, { loja: '', telefone: '53999813355' }, { loja: null, telefone: '53999813355' }]) {
    assert.throws(() => acharCompraDoCarrinho(alvo, [pedidoDeOutraLoja]), /escopo obrigatório/);
  }
});

test('INV-24 · compra de outra loja nunca casa, mesmo com o mesmo comprador', () => {
  assert.equal(acharCompraDoCarrinho({ loja: 'sul', telefone: '53999813355' }, [pedidoDeOutraLoja]), null);
  assert.equal(acharCompraDoCarrinho({ loja: 'centro', telefone: '53999813355' }, [pedidoDeOutraLoja]).inkOrderId, 7);
});
