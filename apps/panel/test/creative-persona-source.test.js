'use strict';

// `personaSource` (lib/creative-core/requests.js): de onde veio a persona do plano, para a tela avisar quando o motor
// usou uma pessoa genérica. Só leitura do plano — nunca entra no plano nem no prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { personaSource, planSummary } = require('../lib/creative-core/requests');

test('personaSource: id default_* automático → "default" (nem Brand Kit nem Nicho têm personas sugeridas)', () => {
  assert.equal(personaSource({ id: 'default_adult_f', label: 'Mulher 30-40 anos, estilo casual', source: 'automatic' }), 'default');
  assert.equal(personaSource({ id: 'default_adult_m', label: 'Homem 30-40 anos, estilo casual', source: 'automatic' }), 'default');
});

test('personaSource: persona sugerida pelo kit (id próprio) → "kit"', () => {
  assert.equal(personaSource({ id: 'sul_mulher_35', label: 'Mulher 35 anos', source: 'automatic' }), 'kit');
  assert.equal(personaSource({ label: 'Sem id', source: 'automatic' }), 'kit');
});

test('personaSource: persona escolhida pelo lojista → "custom", mesmo que o id comece com default_', () => {
  assert.equal(personaSource({ id: 'default_qualquer', label: 'X', source: 'custom' }), 'custom');
});

test('personaSource: cena sem pessoa → null', () => {
  assert.equal(personaSource(null), null);
  assert.equal(personaSource(undefined), null);
});

test('planSummary expõe persona_source ao lado do rótulo da persona', () => {
  const resumo = planSummary({ persona: { id: 'default_adult_f', label: 'Mulher 30-40 anos, estilo casual', source: 'automatic' } });
  assert.equal(resumo.persona, 'Mulher 30-40 anos, estilo casual');
  assert.equal(resumo.persona_source, 'default');
  assert.equal(planSummary({ persona: null }).persona_source, null);
});
