'use strict';

// Indicadores (lib/clientes/metricas.js), visão 360° (detalhe.js), exportação CSV e tradução para filtros de
// campanha (segmento.js): funções puras, sem banco.

const test = require('node:test');
const assert = require('node:assert/strict');

const { calcularIndicadores, normalizarPeriodo, periodoAnterior } = require('../lib/clientes/metricas');
const { montarDetalhe, telefoneParaWhatsapp, montarPedido } = require('../lib/clientes/detalhe');
const { gerarCsv } = require('../lib/clientes/exportacao');
const { filtrosDoPredicado, filtrosDaConsulta } = require('../lib/clientes/segmento');
const { classificarRfm, REGRAS, predicadoDaRegra, PADROES } = require('../lib/clientes/rfm');
const { normalizarConsulta } = require('../lib/clientes/lista');

const p = (data, valor, extra = {}) => ({ criadoEm: `${data}T15:00:00Z`, valor, paymentStatus: 'paid', isTroca: false, ...extra });
const c = (id, pedidos) => ({ id, pedidos });

test('indicadores: todos os cards saem do MESMO conjunto de pedidos válidos do período', () => {
  const clientes = [
    c('a', [p('2026-09-02', 100), p('2026-09-10', 200)]),
    c('b', [p('2026-09-05', 300)]),
    c('c', [p('2026-09-06', 500, { paymentStatus: 'canceled' })]),
    c('d', [p('2026-09-07', 50, { paymentStatus: 'refunded' })]),
    c('e', [p('2026-08-20', 400)]), // fora do período
  ];
  const r = calcularIndicadores(clientes, { de: '2026-09-01', ate: '2026-09-30' }, { primeiroPedidoEm: '2026-08-20T15:00:00Z' });
  const a = r.atual;
  assert.equal(a.faturamento, 600);
  assert.equal(a.pedidos, 3);
  assert.equal(a.clientes, 2);
  assert.equal(a.recorrentes, 1);
  assert.equal(a.taxaRecompra, 0.5);
  assert.equal(a.ticketMedio, 200);
  assert.equal(a.receitaPorCliente, 300);
  assert.equal(a.receitaRecorrente, 300);
  assert.equal(a.clientesPrimeiraCompra, 2);
  assert.equal(a.pedidosReembolsados, 1);
});

test('indicadores: primeira compra é a de toda a vida, não a do período', () => {
  const clientes = [c('a', [p('2026-01-10', 100), p('2026-09-10', 100)])];
  const r = calcularIndicadores(clientes, { de: '2026-09-01', ate: '2026-09-30' }, { primeiroPedidoEm: '2026-01-10T15:00:00Z' });
  assert.equal(r.atual.clientesPrimeiraCompra, 0);
  assert.equal(r.atual.recorrentes, 0, 'recorrência é dentro do período');
});

test('indicadores: período vazio dá nulos, não zero enganoso nem NaN', () => {
  const r = calcularIndicadores([], { de: '2026-09-01', ate: '2026-09-30' }, {});
  assert.equal(r.atual.pedidos, 0);
  assert.equal(r.atual.ticketMedio, null);
  assert.equal(r.atual.taxaRecompra, null);
  assert.equal(r.atual.receitaPorCliente, null);
});

test('comparação só existe quando o histórico sincronizado cobre o período anterior inteiro', () => {
  const clientes = [c('a', [p('2026-08-15', 100), p('2026-09-15', 100)])];
  const periodo = { de: '2026-09-01', ate: '2026-09-30' };
  const cobre = calcularIndicadores(clientes, periodo, { primeiroPedidoEm: '2026-07-01T00:00:00Z' });
  assert.equal(cobre.comparacao.periodo.de, '2026-08-02');
  assert.equal(cobre.comparacao.anterior.pedidos, 1);
  const naoCobre = calcularIndicadores(clientes, periodo, { primeiroPedidoEm: '2026-08-15T15:00:00Z' });
  assert.equal(naoCobre.comparacao.anterior, null);
  assert.match(naoCobre.comparacao.motivo, /não cobre/);
  assert.equal(calcularIndicadores(clientes, periodo, {}).comparacao.anterior, null, 'sem cobertura conhecida, não compara');
});

test('período: entrada inválida cai no padrão, futuro é cortado em hoje e o teto de dias vale', () => {
  const hoje = '2026-09-23';
  assert.deepEqual(normalizarPeriodo({ de: 'x', ate: 'y' }, { hoje }), { de: '2026-08-25', ate: '2026-09-23' });
  assert.deepEqual(normalizarPeriodo({ de: '2026-09-01', ate: '2027-01-01' }, { hoje }), { de: '2026-09-01', ate: hoje });
  assert.deepEqual(normalizarPeriodo({ de: '2026-09-30', ate: '2026-09-10' }, { hoje }), { de: '2026-09-10', ate: '2026-09-10' });
  assert.deepEqual(normalizarPeriodo({ de: '2026-02-30', ate: hoje }, { hoje }), { de: '2026-08-25', ate: hoje });
  assert.ok(normalizarPeriodo({ de: '2000-01-01', ate: hoje }, { hoje }).de > '2021-01-01');
  assert.deepEqual(periodoAnterior({ de: '2026-09-01', ate: '2026-09-30' }), { de: '2026-08-02', ate: '2026-08-31' });
});

const cliente360 = (pedidos, extra = {}) => ({
  loja: 'sul', customerKey: 'k', nome: 'Ana', email: 'ana@x.com', telefone: '51999990000', documento: '11122233344', aceitaMarketing: true,
  motivosDeUniao: [], pedidos, ...extra,
});
const ped = (id, extra = {}) => ({ inkOrderId: id, criadoEm: '2026-09-10T15:00:00Z', valor: 185, paymentStatus: 'paid', orderStatus: 'sent', isTroca: false, frete: 15, descontos: 30, itensQuantidade: 1, ...extra });
const item = (extra = {}) => ({ produto_nome: 'Camiseta', sku: 'S', modelo: 'M', cor: 'Preta', tamanho: 'M', quantidade: 2, valor_venda: 200, desconto_rateado: 30, ...extra });

test('pedido: total = itens + frete − desconto; subtotal derivado é conferido contra os itens', () => {
  const ok = montarPedido(ped('1'), [item()]);
  assert.equal(ok.subtotal, 200);
  assert.equal(ok.somaItens, 200);
  assert.equal(ok.conciliado, true);
  assert.equal(ok.itens[0].valorLiquido, 170);
  assert.equal(ok.itens[0].imagem, null);
  const divergente = montarPedido(ped('1'), [item({ valor_venda: 150 })]);
  assert.equal(divergente.conciliado, false, 'soma dos itens diferente do subtotal é sinalizada, não escondida');
});

test('pedido: sem itens ou sem frete/desconto conhecidos, nada é inventado', () => {
  assert.equal(montarPedido(ped('1'), []).conciliado, null);
  const semFrete = montarPedido(ped('1', { frete: null }), [item()]);
  assert.equal(semFrete.subtotal, null);
  assert.equal(semFrete.conciliado, null);
});

test('pedido reembolsado: devolvido por inteiro, líquido zero, fora do LTV; parcial não é rastreado', () => {
  const r = montarPedido(ped('1', { paymentStatus: 'refunded' }), [item()]);
  assert.equal(r.devolvido, 185);
  assert.equal(r.totalLiquido, 0);
  assert.equal(r.contaNoLtv, false);
  const pago = montarPedido(ped('2'), [item()]);
  assert.equal(pago.devolvido, null);
  assert.equal(pago.devolucaoParcialRastreada, false);
});

test('detalhe: LTV soma só pedidos válidos; distintivos são fatos com denominador conhecido', () => {
  const cli = cliente360([ped('1'), ped('2', { paymentStatus: 'canceled' }), ped('3', { paymentStatus: 'refunded' }), ped('4', { valor: 300 })]);
  const rfm = classificarRfm([{ id: 'x', pedidos: cli.pedidos }], { asOf: new Date('2026-09-23T15:00:00Z') });
  const d = montarDetalhe({
    cliente: cli, classificacao: rfm.clientes[0], rfm,
    itensPorPedido: new Map([['1', [item()]], ['4', [item({ valor_venda: 285, desconto_rateado: 0 })]]]),
    campanhas: [], whatsappConectado: false, ticketMedioDaBase: 200, uf: 'RS',
  });
  assert.equal(d.indicadores.ltv, 485);
  assert.equal(d.indicadores.pedidosPagos, 2);
  assert.equal(d.indicadores.ticketMedio, 242.5);
  assert.equal(d.indicadores.itensComprados, 4);
  const ids = d.distintivos.map((x) => x.id);
  assert.ok(ids.includes('segunda_compra') && ids.includes('ticket_acima_da_media') && ids.includes('aceita_marketing'));
  const semBase = montarDetalhe({ cliente: cli, classificacao: rfm.clientes[0], rfm, itensPorPedido: new Map(), campanhas: [], whatsappConectado: false, ticketMedioDaBase: null, uf: null });
  assert.ok(!semBase.distintivos.some((x) => x.id === 'ticket_acima_da_media'), 'sem denominador, sem badge de ticket');
  assert.equal(semBase.indicadores.itensComprados, null, 'itens desconhecidos → sem soma parcial');
});

test('canais: WhatsApp externo só com telefone válido; e-mail nunca é disparo do Oria', () => {
  assert.equal(telefoneParaWhatsapp('(51) 99999-0000'), '5551999990000');
  assert.equal(telefoneParaWhatsapp('5551999990000'), '5551999990000');
  assert.equal(telefoneParaWhatsapp('999'), null);
  assert.equal(telefoneParaWhatsapp(null), null);
  const rfm = classificarRfm([], { asOf: new Date() });
  const semTel = montarDetalhe({ cliente: cliente360([ped('1')], { telefone: '12', email: 'nao-e-email' }), classificacao: undefined, rfm, itensPorPedido: new Map(), campanhas: [], whatsappConectado: true, ticketMedioDaBase: null });
  assert.equal(semTel.canais.whatsapp.acao, 'indisponivel');
  assert.equal(semTel.canais.email.acao, 'indisponivel');
  assert.equal(semTel.canais.email.provedorIntegrado, false);
  assert.equal(semTel.canais.whatsapp.conexaoOria, 'conectada');
});

test('CSV: sem documento, com BOM, aspas escapadas e proteção contra fórmula', () => {
  const csv = gerarCsv([{ nome: '=HYPERLINK("x")', email: 'a@x.com', telefone: '5199', segmentoNome: 'Novos, teste', pedidosValidos: 1, ltv: 100, documento: '11122233344', aceitaMarketing: true }]);
  assert.ok(csv.startsWith('﻿'));
  const [cab, linha] = csv.replace('﻿', '').trim().split('\r\n');
  assert.ok(!cab.includes('documento'));
  assert.ok(!csv.includes('11122233344'));
  assert.ok(linha.startsWith('"\'=HYPERLINK(""x"")"'), linha);
  assert.ok(linha.includes('"Novos, teste"'));
  assert.ok(linha.includes(',sim'));
});

test('segmento → filtros: cada regra da RFM vira faixas numéricas que a audiência sabe avaliar', () => {
  for (const regra of REGRAS) {
    const filtros = filtrosDoPredicado(predicadoDaRegra(regra, PADROES.limitesRecenciaDias, 150));
    assert.ok(filtros.every((f) => ['diasSemComprar', 'quantidadePedidos', 'totalGasto'].includes(f.field) && ['gte', 'lte', 'lt'].includes(f.op)), regra.id);
    assert.ok(filtros.length >= 1, regra.id);
  }
  const campeoes = filtrosDoPredicado(predicadoDaRegra(REGRAS.find((r) => r.id === 'campeoes'), PADROES.limitesRecenciaDias, 150));
  assert.deepEqual(campeoes, [
    { field: 'diasSemComprar', op: 'lte', value: 90 },
    { field: 'quantidadePedidos', op: 'gte', value: 3 },
    { field: 'totalGasto', op: 'gte', value: 150 },
  ]);
  const perdidos = filtrosDoPredicado(predicadoDaRegra(REGRAS.find((r) => r.id === 'perdidos'), PADROES.limitesRecenciaDias, 150));
  assert.deepEqual(perdidos, [{ field: 'diasSemComprar', op: 'gte', value: 366 }]);
});

test('consulta → filtros: só o que o motor sabe avaliar; o resto é devolvido como não convertido', () => {
  const q = normalizarConsulta({ recenciaMin: '30', ltvMin: '200', pedidosMax: '1', marketing: 'sim', busca: 'ana', ultimaDe: '2026-09-01' });
  const { filtros, naoConvertidos } = filtrosDaConsulta(q);
  assert.deepEqual(filtros.map((f) => `${f.field}:${f.op}`), ['diasSemComprar:gte', 'quantidadePedidos:lte', 'totalGasto:gte', 'optIn:undefined']);
  assert.deepEqual(naoConvertidos, ['busca', 'data da última compra']);
});
