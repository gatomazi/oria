'use strict';

// Visão "Visual" da Distribuição RFM (src/pages/clientes/rfmTreemap.ts): layout squarified, área proporcional, piso declarado para
// segmentos pequenos, 0 sem área (mas presente), todos os segmentos representados, estabilidade e o que cabe dentro do bloco.
// Carrega o arquivo REAL do painel.

const test = require('node:test');
const assert = require('node:assert/strict');
const { carregarTs } = require('./helpers/ts-carregar.cjs');

const { layoutTreemap, prepararVisual, nivelDeRotulo, PISO_AREA } = carregarTs('src/pages/clientes/rfmTreemap.ts');
const { prepararDistribuicao } = carregarTs('src/pages/clientes/rfmDistribuicao.ts');

const plano = (x) => JSON.parse(JSON.stringify(x));
const NOMES = {
  campeoes: 'Campeões', leais: 'Leais', potenciais_leais: 'Potenciais leais', primeira_alto_valor: 'Primeira compra de alto valor', novos: 'Novos',
  aguardando_recompra: 'Aguardando recompra', precisam_atencao: 'Precisam de atenção', prestes_a_dormir: 'Prestes a dormir', em_risco: 'Em risco',
  hibernando: 'Hibernando', perdidos: 'Perdidos',
};
const CLIENTES = { campeoes: 0, leais: 0, potenciais_leais: 6, primeira_alto_valor: 1, novos: 50, aguardando_recompra: 169, precisam_atencao: 3, prestes_a_dormir: 250, em_risco: 1, hibernando: 520, perdidos: 0 };
const TICKET = { potenciais_leais: 150, primeira_alto_valor: 400, novos: 75, aguardando_recompra: 120, precisam_atencao: 160, prestes_a_dormir: 140, em_risco: 180, hibernando: 130 };

function segmentos(clientes = CLIENTES) {
  const total = Object.values(clientes).reduce((a, n) => a + n, 0);
  const receitas = Object.fromEntries(Object.entries(clientes).map(([id, n]) => [id, n * (TICKET[id] || 0)]));
  const totalReceita = Object.values(receitas).reduce((a, v) => a + v, 0);
  return Object.entries(NOMES).map(([id, nome]) => ({
    id, nome, descricao: `descrição de ${nome}`, hipotese: null, predicado: null, clientes: clientes[id], pctBase: total ? clientes[id] / total : 0,
    pedidos: clientes[id], pedidosPorCliente: clientes[id] ? 1 : 0, ticketMedio: TICKET[id] || null, receita: receitas[id], pctReceita: totalReceita ? receitas[id] / totalReceita : 0,
    recenciaMediaDias: 10, recenciaMedianaDias: 10, frequenciaMediana: 1,
  }));
}
const visual = (metrica = 'clientes', altura = 46, cli = CLIENTES) => prepararVisual(prepararDistribuicao(segmentos(cli), metrica), altura);
const area = (r) => r.w * r.h;

// ── layout squarified ───────────────────────────────────────────────────────────────────────────────
test('layout: as áreas somam exatamente o retângulo e cada uma é proporcional ao valor (sem piso)', () => {
  const itens = [{ id: 'a', valor: 520 }, { id: 'b', valor: 250 }, { id: 'c', valor: 169 }, { id: 'd', valor: 50 }, { id: 'e', valor: 11 }];
  const total = 1000;
  for (const [L, A] of [[100, 46], [100, 100], [100, 20]]) {
    const r = plano(layoutTreemap(itens, L, A));
    assert.equal(r.length, 5);
    assert.ok(Math.abs(r.reduce((s, x) => s + area(x), 0) - L * A) < 1e-6, 'preenche todo o retângulo');
    for (const it of itens) {
      const x = r.find((q) => q.id === it.id);
      assert.ok(Math.abs(area(x) / (L * A) - it.valor / total) < 1e-9, `${it.id}: área proporcional`);
    }
  }
});

test('layout: nenhum retângulo sai dos limites nem se sobrepõe a outro', () => {
  const itens = Object.entries(CLIENTES).map(([id, valor]) => ({ id, valor }));
  for (const A of [30, 46, 100, 140]) {
    const r = plano(layoutTreemap(itens, 100, A));
    for (const q of r) {
      assert.ok(q.x >= -1e-9 && q.y >= -1e-9 && q.x + q.w <= 100 + 1e-9 && q.y + q.h <= A + 1e-9, `${q.id} dentro dos limites`);
      assert.ok(q.w > 0 && q.h > 0);
    }
    for (let i = 0; i < r.length; i += 1) {
      for (let j = i + 1; j < r.length; j += 1) {
        const a = r[i]; const b = r[j];
        const sobra = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-9 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-9;
        assert.equal(sobra, false, `${a.id} × ${b.id} não se sobrepõem`);
      }
    }
  }
});

test('layout: valor 0, negativo ou inválido não recebe área; vazio/todos zero devolve lista vazia; determinístico', () => {
  const r = plano(layoutTreemap([{ id: 'a', valor: 10 }, { id: 'z', valor: 0 }, { id: 'n', valor: -3 }, { id: 'x', valor: Number.NaN }], 100, 50));
  assert.deepEqual(r.map((q) => q.id), ['a']);
  assert.equal(layoutTreemap([{ id: 'z', valor: 0 }], 100, 50).length, 0);
  assert.equal(layoutTreemap([], 100, 50).length, 0);
  assert.equal(layoutTreemap([{ id: 'a', valor: 5 }], 0, 50).length, 0);
  const itens = Object.entries(CLIENTES).map(([id, valor]) => ({ id, valor }));
  assert.deepEqual(plano(layoutTreemap(itens, 100, 46)), plano(layoutTreemap([...itens], 100, 46)));
});

test('layout: empate de valor mantém a ordem de entrada (estável)', () => {
  const r = plano(layoutTreemap([{ id: 'a', valor: 10 }, { id: 'b', valor: 10 }, { id: 'c', valor: 10 }], 100, 50));
  assert.deepEqual(r.map((q) => q.id), ['a', 'b', 'c']);
});

test('layout: os blocos maiores ficam razoavelmente quadrados (razão de aspecto controlada)', () => {
  const itens = Object.entries(CLIENTES).map(([id, valor]) => ({ id, valor })).filter((i) => i.valor >= 50);
  for (const q of plano(layoutTreemap(itens, 100, 46))) assert.ok(Math.max(q.w / q.h, q.h / q.w) < 6, `${q.id}: ${q.w.toFixed(1)}×${q.h.toFixed(1)}`);
});

// ── preparação para a tela ─────────────────────────────────────────────────────────────────────────
test('todo segmento é representado: 8 com bloco + 3 zeros só na legenda; nenhum some', () => {
  const v = visual();
  assert.equal(v.blocos.length + v.semArea.length, 11);
  assert.deepEqual(plano(v.semArea.map((l) => l.id).sort()), ['campeoes', 'leais', 'perdidos']);
  assert.deepEqual(plano(v.blocos.map((b) => b.linha.id).sort()), Object.keys(CLIENTES).filter((id) => CLIENTES[id] > 0).sort());
});

test('segmentos pequenos (1, 3 e 6 de 1.000) recebem a área mínima declarada; os grandes mantêm a área proporcional', () => {
  const v = visual('clientes', 46);
  const total = 100 * 46;
  const b = (id) => v.blocos.find((x) => x.linha.id === id);
  for (const id of ['primeira_alto_valor', 'em_risco', 'precisam_atencao', 'potenciais_leais']) {
    assert.equal(b(id).pisoAplicado, true, `${id}: piso aplicado`);
    assert.ok(area(b(id)) / total >= PISO_AREA * 0.85 - 1e-9, `${id}: área ≥ piso (${(area(b(id)) / total * 100).toFixed(2)}%)`);
  }
  for (const id of ['hibernando', 'prestes_a_dormir', 'aguardando_recompra', 'novos']) {
    assert.equal(b(id).pisoAplicado, false, `${id}: sem piso`);
  }
  // O piso é pequeno: o maior bloco continua dominando e a soma das áreas é o retângulo inteiro.
  assert.ok(Math.abs(v.blocos.reduce((s, x) => s + area(x), 0) - total) < 1e-6);
  assert.ok(area(b('hibernando')) > area(b('prestes_a_dormir')) && area(b('prestes_a_dormir')) > area(b('aguardando_recompra')));
  assert.ok(Math.abs(area(b('hibernando')) / total - 0.52) < 0.02, 'hibernando ≈ 52% (o piso só rouba ~2 p.p. no total)');
});

test('Clientes × Receita: o mesmo conjunto de segmentos, áreas recalculadas; alto valor com 1 cliente ganha mais área em Receita', () => {
  const c = visual('clientes'); const r = visual('receita');
  assert.deepEqual(plano(c.blocos.map((b) => b.linha.id).sort()), plano(r.blocos.map((b) => b.linha.id).sort()));
  assert.deepEqual(plano(c.semArea.map((l) => l.id)), plano(r.semArea.map((l) => l.id)));
  const a = (v, id) => area(v.blocos.find((x) => x.linha.id === id));
  assert.ok(a(r, 'primeira_alto_valor') >= a(c, 'primeira_alto_valor') - 1e-9);
  assert.equal(r.blocos.find((x) => x.linha.id === 'hibernando').linha.valor, 520 * 130, 'o valor exibido em Receita vem do servidor (clientes × ticket na fixture)');
});

test('altura do layout (desktop 46 × celular 100) muda a geometria, não os segmentos', () => {
  const d = visual('clientes', 46); const m = visual('clientes', 100);
  assert.deepEqual(plano(d.blocos.map((b) => b.linha.id).sort()), plano(m.blocos.map((b) => b.linha.id).sort()));
  assert.equal(d.altura, 46); assert.equal(m.altura, 100);
  assert.ok(Math.abs(m.blocos.reduce((s, x) => s + area(x), 0) - 100 * 100) < 1e-6);
});

test('base sem nenhum cliente: nenhum bloco, todos os 11 segmentos ficam na legenda (sem NaN)', () => {
  const zero = Object.fromEntries(Object.keys(NOMES).map((id) => [id, 0]));
  const v = visual('clientes', 46, zero);
  assert.equal(v.blocos.length, 0);
  assert.equal(v.semArea.length, 11);
});

test('um único segmento com clientes ocupa o retângulo inteiro (piso não infla o que é único)', () => {
  const so = { ...Object.fromEntries(Object.keys(NOMES).map((id) => [id, 0])), novos: 4 };
  const v = visual('clientes', 46, so);
  assert.equal(v.blocos.length, 1);
  assert.ok(Math.abs(area(v.blocos[0]) - 100 * 46) < 1e-6);
});

// ── o que cabe dentro do bloco ─────────────────────────────────────────────────────────────────────
test('nível de rótulo por tamanho em px: completo → nome → valor → marcador (o nome completo vive na legenda, no aria-label e no tooltip)', () => {
  assert.equal(nivelDeRotulo(300, 120), 'completo');
  assert.equal(nivelDeRotulo(119, 120), 'nome');
  assert.equal(nivelDeRotulo(100, 45), 'nome');
  assert.equal(nivelDeRotulo(60, 30), 'valor');
  assert.equal(nivelDeRotulo(30, 22), 'valor');
  assert.equal(nivelDeRotulo(20, 40), 'marcador');
  assert.equal(nivelDeRotulo(200, 12), 'marcador');
  assert.equal(nivelDeRotulo(0, 0), 'marcador');
});
