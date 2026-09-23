'use strict';

// Fase F.2.B — `centavosDeUsd` (conversão USD → centavos inteiros, unidade da coluna
// `cost_usd_estimated_cents`). Achado durante a execução real do piloto: um custo de sub-centavo
// (ex.: gpt-4o-mini de verdade fica na casa de US$ 0,0006/chamada) arredondava para 0 com
// `Math.round`, apagando a granularidade do teto de VALOR — corrigido para arredondar sempre para
// CIMA (nunca subestimar uma reserva).

const test = require('node:test');
const assert = require('node:assert/strict');

const { centavosDeUsd } = require('../lib/creative-core/enrichmentPilotBudget');

test('centavosDeUsd: sub-centavo nunca vira zero — sempre arredonda para cima', () => {
  assert.equal(centavosDeUsd(0.0006), 1, 'US$ 0,0006 (custo real típico de uma chamada) não pode reservar 0 centavo');
  assert.equal(centavosDeUsd(0.001), 1);
  assert.equal(centavosDeUsd(0.0001), 1);
});

test('centavosDeUsd: valores acima de 1 centavo arredondam para cima, nunca para baixo', () => {
  assert.equal(centavosDeUsd(0.011), 2, '1,1 centavo vira 2, não 1 — nunca subestima');
  assert.equal(centavosDeUsd(0.02), 2, 'valor exato não ganha nem perde um centavo');
  assert.equal(centavosDeUsd(0.04), 4);
});

test('centavosDeUsd: zero continua zero (não força 1 centavo para um custo genuinamente nulo)', () => {
  assert.equal(centavosDeUsd(0), 0);
});

test('centavosDeUsd: rejeita valores inválidos', () => {
  assert.throws(() => centavosDeUsd(-0.01), /inválido/);
  assert.throws(() => centavosDeUsd(NaN), /inválido/);
});
