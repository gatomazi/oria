'use strict';

// Dashboard · decomposição do faturamento (src/pages/dashboard/decomposicaoResultado.ts).
//
// A barra "para onde foi cada real" é a mesma conta do Resultado do período em proporção. Ela não
// pode inventar mídia que a tela não conhece, nem desenhar fatia negativa quando há prejuízo.
// Testada sobre o arquivo REAL do painel, transpilado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const h = require('./harness');

const DIR = path.join(h.RAIZ_SUJEITO, 'src', 'pages', 'dashboard');

function carregar(arquivo) {
  const js = ts.transpileModule(fs.readFileSync(path.join(DIR, arquivo), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} };
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports });
  return modulo.exports;
}

const { decomporResultado } = carregar('decomposicaoResultado.ts');
const soma = (partes) => partes.reduce((s, p) => s + p.fracao, 0);
// Array.from: o módulo roda noutro realm (vm) — copia para um array daqui antes do deepEqual estrito.
const chaves = (d) => Array.from(d.partes, (p) => p.chave);

test('com mídia conhecida: frete, produção, mídia e sobra, somando a barra inteira', () => {
  const d = decomporResultado({ faturamento: 1000, receitaLiquida: 900, custoProducao: 400, midia: 200, resultado: 300 }, true);
  assert.deepEqual(chaves(d), ['frete', 'producao', 'midia', 'sobra']);
  assert.equal(d.prejuizo, false);
  assert.ok(Math.abs(soma(d.partes) - 1) < 1e-9);
  assert.equal(d.partes.find((p) => p.chave === 'sobra').fracao, 0.3);
});

test('sem mídia conhecida: a fatia de mídia não existe (não vira zero nem é inventada)', () => {
  const d = decomporResultado({ faturamento: 1000, receitaLiquida: 900, custoProducao: 400, midia: 250, resultado: 500 }, false);
  assert.deepEqual(chaves(d), ['frete', 'producao', 'sobra']);
});

test('prejuízo: sobra some, nenhuma fatia negativa, a barra se divide pelas saídas', () => {
  const d = decomporResultado({ faturamento: 1000, receitaLiquida: 900, custoProducao: 500, midia: 600, resultado: -200 }, true);
  assert.equal(d.prejuizo, true);
  assert.deepEqual(chaves(d), ['frete', 'producao', 'midia']);
  assert.ok(d.partes.every((p) => p.fracao > 0));
  assert.ok(Math.abs(soma(d.partes) - 1) < 1e-9);
});

test('faturamento zero: sem barra', () => {
  assert.equal(decomporResultado({ faturamento: 0, receitaLiquida: 0, custoProducao: 0, midia: 0, resultado: 0 }, true).partes.length, 0);
});
