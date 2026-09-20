'use strict';

// Dashboard · escopo de Store (src/pages/dashboard/escopoLoja.ts).
//
// O defeito: o servidor devolve `loja: null` para toda linha da Store nativa do Oria, e o Dashboard
// comparava `item.loja === escopo` com `escopo = useLojaAtiva() ?? ''`. `null === ''` é `false`, então
// TODO pedido, carrinho e linha financeira era filtrado — R$ 0,00 com 431 pedidos no banco.
//
// O teste transpila o arquivo REAL do painel (não uma cópia): se alguém voltar a comparar com `===`,
// ele reprova.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const h = require('./harness');

// O sujeito vem do harness: o negative control roda ESTE arquivo contra uma cópia defeituosa.
const DIR_DASHBOARD = path.join(h.RAIZ_SUJEITO, 'src', 'pages', 'dashboard');
const ARQUIVO = path.join(DIR_DASHBOARD, 'escopoLoja.ts');

function carregar(arquivo = ARQUIVO) {
  const js = ts.transpileModule(fs.readFileSync(arquivo, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} };
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports });
  return modulo.exports;
}

const { porEscopo, mesmaLoja, chaveDeLoja } = carregar();

const pedidos = [
  { id: 1, loja: null },
  { id: 2, loja: null },
  { id: 3, loja: 'sul' },
];

test('Store nativa: linhas com loja null passam quando o escopo é vazio ou nulo (métricas reais, não zeros)', () => {
  assert.deepEqual(porEscopo(pedidos, '').map((p) => p.id), [1, 2]);
  assert.deepEqual(porEscopo(pedidos, null).map((p) => p.id), [1, 2]);
});

test('Store legada: só as linhas da chave dela', () => {
  assert.deepEqual(porEscopo(pedidos, 'sul').map((p) => p.id), [3]);
  assert.deepEqual(porEscopo(pedidos, 'centro'), []);
});

test('ausente, vazio e nulo são a mesma coisa: "sem chave legada"', () => {
  assert.equal(chaveDeLoja(undefined), null);
  assert.equal(chaveDeLoja(''), null);
  assert.equal(chaveDeLoja(null), null);
  assert.equal(chaveDeLoja('sul'), 'sul');
  assert.ok(mesmaLoja(null, ''));
  assert.ok(mesmaLoja(undefined, null));
  assert.ok(!mesmaLoja(null, 'sul'));
  assert.ok(!mesmaLoja('sul', 'centro'));
});

test('lista vazia continua vazia', () => {
  assert.deepEqual(porEscopo([], ''), []);
});

test('o Dashboard usa o helper e não voltou a comparar `loja === escopo`', () => {
  const pagina = fs.readFileSync(path.join(DIR_DASHBOARD, 'DashboardPage.tsx'), 'utf8');
  assert.match(pagina, /from '\.\/escopoLoja'/);
  assert.doesNotMatch(pagina, /\.loja === escopo/);
  assert.doesNotMatch(pagina, /function porEscopo/, 'o filtro estrito local voltou');
});
