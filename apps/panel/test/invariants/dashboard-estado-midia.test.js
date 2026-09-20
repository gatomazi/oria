'use strict';

// Dashboard · estado da mídia (src/pages/dashboard/estadoMidia.ts).
//
// "Integração ausente ≠ gasto zero." O painel só tinha o TOTAL gasto, e R$ 0 significava três coisas:
// nenhuma conta conectada, conta que não é desta loja, ou conta da loja sem gasto no período. Só a
// última é "gasto zero". Aqui o estado vem do servidor (`midiaFontes`) e a decisão de exibição é
// uma função pura — testada sobre o arquivo REAL do painel, transpilado.

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

const { estadoDaMidia, avisoDeMidiaFora } = carregar('estadoMidia.ts');

const fonte = (provider, conectado, motivo = null) => ({ provider, conectado, relevante: true, motivo });

test('sem nenhuma conta (nem uma fonte conectada, nem uma conta fora do total): "não conectada", nunca "gasto zero"', () => {
  assert.equal(estadoDaMidia([fonte('meta', false), fonte('google_ads', false)]), 'nao_conectada');
  assert.equal(avisoDeMidiaFora('nao_conectada'), 'sem mídia conectada');
});

test('conta da loja conectada = "conectada", inclusive com gasto zero (esse zero é verdadeiro)', () => {
  assert.equal(estadoDaMidia([fonte('meta', true), fonte('google_ads', false)]), 'conectada');
  assert.equal(avisoDeMidiaFora('conectada'), null);
});

test('conta que existe mas não entra no total (sem loja / de outra loja) é um estado próprio, com aviso', () => {
  assert.equal(estadoDaMidia([fonte('meta', false, 'sem_loja'), fonte('google_ads', false)]), 'conta_fora_do_total');
  assert.equal(estadoDaMidia([fonte('meta', false, 'outra_loja')]), 'conta_fora_do_total');
  assert.equal(avisoDeMidiaFora('conta_fora_do_total'), 'conta de anúncios sem loja atribuída');
});

test('uma fonte conectada vence uma conta fora do total (a outra plataforma ainda entra no lucro)', () => {
  assert.equal(estadoDaMidia([fonte('meta', true), fonte('google_ads', false, 'outra_loja')]), 'conectada');
});

test('não conseguiu ler as fontes: "desconhecido" — a tela não afirma "sem mídia" nem "gasto zero"', () => {
  assert.equal(estadoDaMidia(null), 'desconhecido');
  assert.equal(estadoDaMidia(undefined), 'desconhecido');
  assert.equal(avisoDeMidiaFora('desconhecido'), null);
});

test('o Dashboard decide pelo estado e não voltou a tratar `gasto > 0` como "mídia conectada"', () => {
  const pagina = fs.readFileSync(path.join(DIR, 'DashboardPage.tsx'), 'utf8');
  assert.match(pagina, /from '\.\/estadoMidia'/);
  assert.match(pagina, /estadoDaMidia\(midiaFontes\)/);
  assert.doesNotMatch(pagina, /const temMidia = atual\.midia > 0;/);
});
