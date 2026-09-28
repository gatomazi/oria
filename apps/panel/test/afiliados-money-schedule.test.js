'use strict';

// Aritmética em centavos e calendário financeiro do módulo de afiliados (lib/afiliados/money.js, schedule.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const money = require('../lib/afiliados/money');
const schedule = require('../lib/afiliados/schedule');

test('centavosDeDecimal lê decimais sem passar por float e arredonda meio-para-cima', () => {
  assert.equal(money.centavosDeDecimal('100.00'), 10000);
  assert.equal(money.centavosDeDecimal('45.5'), 4550);
  assert.equal(money.centavosDeDecimal('0.005'), 1);
  assert.equal(money.centavosDeDecimal('0.004'), 0);
  assert.equal(money.centavosDeDecimal('19.999'), 2000);
  assert.equal(money.centavosDeDecimal('-3.10'), -310);
  assert.equal(money.centavosDeDecimal('abc'), null);
  assert.equal(money.centavosDeDecimal(null), null);
  assert.equal(money.centavosDeDecimal(0.1 + 0.2), 30);
});

test('percentualDe usa basis points e arredonda meio-para-cima', () => {
  assert.equal(money.percentualDe(3000, 1500), 450);
  assert.equal(money.percentualDe(3000, 2000), 600);
  assert.equal(money.percentualDe(1, 5000), 1);
  assert.equal(money.percentualDe(9999, 3333), 3333);
  assert.equal(money.percentualDe(-100, 5000), -50);
  assert.throws(() => money.percentualDe(10.5, 100), TypeError);
});

test('ratear soma exatamente o total, com resíduo determinístico pelo maior resto', () => {
  assert.deepEqual(money.ratear(1, [1, 1, 1]), [1, 0, 0]);
  assert.deepEqual(money.ratear(2000, [10000, 10000]), [1000, 1000]);
  assert.deepEqual(money.ratear(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(money.ratear(7, [0, 0]), [4, 3]);
  const partes = money.ratear(12345, [3333, 3333, 3334, 1]);
  assert.equal(partes.reduce((a, b) => a + b, 0), 12345);
  assert.deepEqual(money.ratear(12345, [3333, 3333, 3334, 1]), partes);
  assert.deepEqual(money.ratear(-5, [1, 1]), [-3, -2]);
});

test('centavosParaDecimal e formatarBRL são exatos', () => {
  assert.equal(money.centavosParaDecimal(1050), '10.50');
  assert.equal(money.centavosParaDecimal(-5), '-0.05');
  assert.match(money.formatarBRL(1050), /10,50/);
});

test('dataLocal e competencia respeitam o timezone da loja, não o UTC', () => {
  // 01:00Z de 1º/10 ainda é 30/09 em São Paulo (UTC-3).
  const instante = new Date('2026-10-01T01:00:00Z');
  assert.equal(schedule.dataLocal(instante, 'America/Sao_Paulo'), '2026-09-30');
  assert.equal(schedule.dataLocal(instante, 'UTC'), '2026-10-01');
  assert.equal(schedule.competenciaDoMes(instante, 'America/Sao_Paulo'), '2026-09-01');
});

test('inicioDoDiaLocal devolve 00:00 local em UTC', () => {
  assert.equal(schedule.inicioDoDiaLocal(2026, 10, 10, 'America/Sao_Paulo').toISOString(), '2026-10-10T03:00:00.000Z');
});

test('política padrão: entrega + 7 dias, pagar dia 10 do mês seguinte', () => {
  const entregue = new Date('2026-09-05T15:00:00Z');
  const liberacao = schedule.calcularLiberacao({ politica: 'delivery_plus_hold', holdDias: 7, entregueEm: entregue });
  assert.equal(liberacao.toISOString(), '2026-09-12T15:00:00.000Z');
  const vencimento = schedule.calcularVencimento({ liberadoEm: liberacao, diaPagamento: 10, mesesDepois: 1, deslocarFimDeSemana: false });
  assert.equal(schedule.dataLocal(vencimento), '2026-10-10');
});

test('sem entrega não há liberação nem vencimento (nunca inventa data)', () => {
  assert.equal(schedule.calcularLiberacao({ politica: 'delivery_plus_hold', holdDias: 7, entregueEm: null }), null);
  assert.equal(schedule.calcularVencimento({ liberadoEm: null, diaPagamento: 10, mesesDepois: 1 }), null);
});

test('política payment_plus_days usa o pagamento observado', () => {
  const l = schedule.calcularLiberacao({ politica: 'payment_plus_days', holdDias: 15, pagoObservadoEm: new Date('2026-09-01T12:00:00Z'), entregueEm: null });
  assert.equal(l.toISOString(), '2026-09-16T12:00:00.000Z');
});

test('fim de semana desloca para segunda; 10/10/2026 é sábado e 11/01/2026 é domingo', () => {
  const v = schedule.calcularVencimento({ liberadoEm: new Date('2026-09-12T12:00:00Z'), diaPagamento: 10, mesesDepois: 1, deslocarFimDeSemana: true });
  assert.equal(schedule.dataLocal(v), '2026-10-12');
  const v2 = schedule.calcularVencimento({ liberadoEm: new Date('2025-12-20T12:00:00Z'), diaPagamento: 10, mesesDepois: 1, deslocarFimDeSemana: true });
  assert.equal(schedule.dataLocal(v2), '2026-01-12');
});

test('virada de ano no cálculo do mês seguinte', () => {
  const v = schedule.calcularVencimento({ liberadoEm: new Date('2026-12-20T12:00:00Z'), diaPagamento: 10, mesesDepois: 1, deslocarFimDeSemana: false });
  assert.equal(schedule.dataLocal(v), '2027-01-10');
});

test('liberação perto da meia-noite usa o mês LOCAL', () => {
  // 02:00Z de 1º/11 = 31/10 23:00 em SP: o mês da liberação é outubro, vence em 10/11.
  const v = schedule.calcularVencimento({ liberadoEm: new Date('2026-11-01T02:00:00Z'), diaPagamento: 10, mesesDepois: 1, deslocarFimDeSemana: false });
  assert.equal(schedule.dataLocal(v), '2026-11-10');
});

test('vence hoje não é atraso; no dia seguinte são 1 dia', () => {
  const due = schedule.inicioDoDiaLocal(2026, 10, 12);
  assert.equal(schedule.diasEmAtraso(due, new Date('2026-10-12T20:00:00-03:00')), 0);
  assert.equal(schedule.diasEmAtraso(due, new Date('2026-10-13T08:00:00-03:00')), 1);
  assert.equal(schedule.diasEmAtraso(null, new Date()), 0);
});

test('intervaloLocal cobre o dia inteiro nas duas pontas', () => {
  const { inicio, fim } = schedule.intervaloLocal('2026-09-01', '2026-09-30');
  assert.equal(inicio.toISOString(), '2026-09-01T03:00:00.000Z');
  assert.equal(fim.toISOString(), '2026-10-01T03:00:00.000Z');
  assert.throws(() => schedule.intervaloLocal('2026-09-30', '2026-09-01'), RangeError);
});
