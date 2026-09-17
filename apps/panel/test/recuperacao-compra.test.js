'use strict';

// Testes do casamento carrinho abandonado → pedido pago (lib/recuperacao/compra.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { variantesTelefone, acharCompraDoCarrinho } = require('../lib/recuperacao/compra');

function pedido(extra) {
  return { loja: 'sul', inkOrderId: 1, criadoEm: '2026-09-12T15:00:00Z', telefone: null, documento: null, email: null, ...extra };
}

test('variantes de telefone: com DDI devolve também sem, sem DDI devolve também com', () => {
  assert.deepEqual(variantesTelefone('5553999813355'), ['5553999813355', '53999813355']);
  assert.deepEqual(variantesTelefone('(53) 99981-3355'), ['53999813355', '5553999813355']);
  assert.deepEqual(variantesTelefone(''), []);
  assert.deepEqual(variantesTelefone(null), []);
});

test('carrinho com telefone no formato WhatsApp casa com pedido salvo sem DDI', () => {
  const alvo = { loja: 'sul', telefone: '5553999813355', desde: '2026-09-11T10:00:00Z' };
  const compra = acharCompraDoCarrinho(alvo, [pedido({ telefone: '53999813355', inkOrderId: 42 })]);
  assert.equal(compra.inkOrderId, 42);
});

test('casa por e-mail ignorando caixa e espaços', () => {
  const alvo = { loja: 'sul', email: ' Paula@Exemplo.com ', desde: '2026-09-11T10:00:00Z' };
  const compra = acharCompraDoCarrinho(alvo, [pedido({ email: 'paula@exemplo.com' })]);
  assert.ok(compra);
});

test('pedido anterior ao carrinho não conta como compra', () => {
  const alvo = { loja: 'sul', telefone: '53999813355', desde: '2026-09-13T00:00:00Z' };
  assert.equal(acharCompraDoCarrinho(alvo, [pedido({ telefone: '53999813355' })]), null);
});

test('pedido de outra loja não conta', () => {
  const alvo = { loja: 'centro', telefone: '53999813355', desde: '2026-09-11T00:00:00Z' };
  assert.equal(acharCompraDoCarrinho(alvo, [pedido({ telefone: '53999813355' })]), null);
});

test('INV-24: sem loja no alvo é erro, nunca busca em todos os pedidos', () => {
  const pedidos = [pedido({ telefone: '53999813355' })];
  assert.throws(() => acharCompraDoCarrinho({ telefone: '53999813355', desde: null }, pedidos), /escopo obrigatório/);
  assert.throws(() => acharCompraDoCarrinho({ loja: '', telefone: '53999813355' }, pedidos), /escopo obrigatório/);
  assert.throws(() => acharCompraDoCarrinho(null, pedidos), /escopo obrigatório/);
});

test('carrinho sem nenhum dado de contato nunca casa (nem com pedido sem contato)', () => {
  assert.equal(acharCompraDoCarrinho({ loja: 'sul', desde: null }, [pedido({})]), null);
});

test('com várias compras devolve a primeira depois do carrinho', () => {
  const alvo = { loja: 'sul', telefone: '53999813355', desde: '2026-09-11T00:00:00Z' };
  const compra = acharCompraDoCarrinho(alvo, [
    pedido({ telefone: '53999813355', inkOrderId: 2, criadoEm: '2026-09-14T00:00:00Z' }),
    pedido({ telefone: '53999813355', inkOrderId: 1, criadoEm: '2026-09-12T00:00:00Z' }),
  ]);
  assert.equal(compra.inkOrderId, 1);
});
