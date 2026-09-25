'use strict';

// Fase F.2.A — cota do provider real do Product Enrichment (`lib/creative-core/enrichmentQuota.js`),
// testada isoladamente da rota HTTP (essa cobertura já existe em creative-enrichment.test.js). Pura
// lógica de janela deslizante em memória — nenhum Postgres necessário.

const test = require('node:test');
const assert = require('node:assert/strict');

const quota = require('../lib/creative-core/enrichmentQuota');

const ORG = 'a1000000-0000-4000-8000-000000000001';
const OUTRA_ORG = 'a1000000-0000-4000-8000-000000000002';

test('limiteDiario: default 20, valor de env válido é respeitado, valor inválido cai no default', () => {
  assert.equal(quota.limiteDiario({}), 20);
  assert.equal(quota.limiteDiario({ CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: '5' }), 5);
  assert.equal(quota.limiteDiario({ CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: '0' }), 20, 'zero não é um limite válido — cai no default');
  assert.equal(quota.limiteDiario({ CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: '-3' }), 20);
  assert.equal(quota.limiteDiario({ CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: 'abc' }), 20);
  assert.equal(quota.limiteDiario({ CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: '3.7' }), 3, 'fracionário é arredondado para baixo');
});

test('verificar: abaixo do limite permite, no limite bloqueia, nunca conta sozinho (só verificar não altera o uso)', () => {
  quota._resetParaTeste();
  const env = { CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: '2' };
  assert.deepEqual(quota.verificar(ORG, env), { ok: true, usado: 0, limite: 2 });
  quota.registrar(ORG);
  assert.deepEqual(quota.verificar(ORG, env), { ok: true, usado: 1, limite: 2 });
  // Chamar verificar várias vezes seguidas não consome cota por si só.
  quota.verificar(ORG, env);
  quota.verificar(ORG, env);
  assert.deepEqual(quota.verificar(ORG, env), { ok: true, usado: 1, limite: 2 });
  quota.registrar(ORG);
  assert.deepEqual(quota.verificar(ORG, env), { ok: false, usado: 2, limite: 2 });
});

test('a cota é por Organization — uma Organization no limite não afeta outra', () => {
  quota._resetParaTeste();
  const env = { CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: '1' };
  quota.registrar(ORG);
  assert.equal(quota.verificar(ORG, env).ok, false);
  assert.equal(quota.verificar(OUTRA_ORG, env).ok, true, 'a cota da outra Organization está intacta');
});

test('janela de 24h: uso fora da janela não conta mais — a cota se renova com o tempo', () => {
  quota._resetParaTeste();
  const env = { CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY: '1' };
  const ontem = Date.now() - 25 * 60 * 60 * 1000;
  quota.registrar(ORG, ontem);
  assert.deepEqual(quota.verificar(ORG, env), { ok: true, usado: 0, limite: 1 }, 'um uso de mais de 24h atrás não conta');
});
