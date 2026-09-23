'use strict';

// Layout do treemap RFM (src/pages/clientes/rfmSegmentos.ts): áreas proporcionais, sem sobreposição, dentro do
// contêiner e determinístico. O teste transpila o arquivo REAL do painel, não uma cópia.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ARQUIVO = path.join(__dirname, '..', 'src', 'pages', 'clientes', 'rfmSegmentos.ts');
const js = ts.transpileModule(fs.readFileSync(ARQUIVO, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const modulo = { exports: {} };
vm.runInNewContext(js, { module: modulo, exports: modulo.exports, require: () => ({}) });
const { layoutTreemap, ESTILO_SEGMENTO, estiloDe } = modulo.exports;

const PROPORCAO = 16 / 7;
const area = (r) => (r.w / 100) * PROPORCAO * (r.h / 100);

function semSobreposicao(rs) {
  for (let i = 0; i < rs.length; i += 1) {
    for (let j = i + 1; j < rs.length; j += 1) {
      const a = rs[i]; const b = rs[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1e-6 && oy > 1e-6) return false;
    }
  }
  return true;
}

const ITENS = [
  { id: 'novos', valor: 1370 }, { id: 'campeoes', valor: 113 }, { id: 'em_risco', valor: 549 }, { id: 'leais', valor: 40 },
  { id: 'hibernando', valor: 300 }, { id: 'perdidos', valor: 12 }, { id: 'aguardando_recompra', valor: 700 },
];

test('cobre o contêiner inteiro, sem sobreposição e sempre dentro dele', () => {
  const rs = layoutTreemap(ITENS, PROPORCAO);
  assert.equal(rs.length, ITENS.length);
  assert.ok(semSobreposicao(rs));
  for (const r of rs) {
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= 100 + 1e-6 && r.y + r.h <= 100 + 1e-6, JSON.stringify(r));
  }
  const soma = rs.reduce((acc, r) => acc + area(r), 0);
  assert.ok(Math.abs(soma - PROPORCAO) < 1e-6, `áreas somam ${soma}, esperado ${PROPORCAO}`);
});

test('a área de cada retângulo é proporcional ao valor', () => {
  const rs = layoutTreemap(ITENS, PROPORCAO);
  const total = ITENS.reduce((a, i) => a + i.valor, 0);
  for (const i of ITENS) {
    const r = rs.find((x) => x.id === i.id);
    assert.ok(Math.abs(area(r) / PROPORCAO - i.valor / total) < 1e-9, i.id);
  }
});

test('determinístico: a ordem de entrada e empates não mudam o desenho', () => {
  const a = layoutTreemap(ITENS, PROPORCAO);
  const b = layoutTreemap([...ITENS].reverse(), PROPORCAO);
  assert.deepEqual(a, b);
  const empate = layoutTreemap([{ id: 'b', valor: 5 }, { id: 'a', valor: 5 }], PROPORCAO);
  assert.deepEqual(empate, layoutTreemap([{ id: 'a', valor: 5 }, { id: 'b', valor: 5 }], PROPORCAO));
});

test('valor zero, negativo ou inválido fica de fora; sem itens não devolve nada; um item ocupa tudo', () => {
  // (arrays vêm de outro realm do `vm`: compara pelo tamanho)
  assert.equal(layoutTreemap([], PROPORCAO).length, 0);
  assert.equal(layoutTreemap([{ id: 'x', valor: 0 }, { id: 'y', valor: -3 }, { id: 'z', valor: NaN }], PROPORCAO).length, 0);
  const [unico] = layoutTreemap([{ id: 'x', valor: 9 }, { id: 'y', valor: 0 }], PROPORCAO);
  assert.deepEqual({ ...unico }, { id: 'x', x: 0, y: 0, w: 100, h: 100 });
});

test('proporções extremas (1 cliente contra 10 mil) continuam cobrindo sem sobrepor', () => {
  const rs = layoutTreemap([{ id: 'grande', valor: 10000 }, { id: 'a', valor: 1 }, { id: 'b', valor: 1 }, { id: 'c', valor: 2 }], PROPORCAO);
  assert.ok(semSobreposicao(rs));
  assert.ok(Math.abs(rs.reduce((acc, r) => acc + area(r), 0) - PROPORCAO) < 1e-6);
});

test('todo segmento tem estilo semântico; a cor nunca é o único identificador (grupo em texto)', () => {
  for (const [id, e] of Object.entries(ESTILO_SEGMENTO)) {
    assert.ok(e.grupo && e.cor && e.tint && e.opacidade > 0 && e.opacidade < 1, id);
  }
  assert.equal(ESTILO_SEGMENTO.campeoes.grupo, 'Fidelidade');
  assert.equal(ESTILO_SEGMENTO.em_risco.cor, 'var(--danger)');
  assert.equal(estiloDe('inexistente').grupo, 'Sem classificação');
});
