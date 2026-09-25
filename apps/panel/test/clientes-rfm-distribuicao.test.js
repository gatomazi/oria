'use strict';

// Transformações do RFM Explorer (src/pages/clientes/rfmDistribuicao.ts): zero, proporção, ordenação, receita, nomenclatura,
// estabilidade e eventos de seleção. Carrega o arquivo REAL do painel.

const test = require('node:test');
const assert = require('node:assert/strict');
const { carregarTs } = require('./helpers/ts-carregar.cjs');

const { prepararDistribuicao, alternarSelecao, explicarZero, rotuloAria, GRUPOS_DESCRICAO } = carregarTs('src/pages/clientes/rfmDistribuicao.ts');
const { ESTILO_SEGMENTO } = carregarTs('src/pages/clientes/rfmSegmentos.ts');

// Os objetos vêm de outro realm do `vm`: `plano()` os normaliza para comparar com deepEqual.
const plano = (x) => JSON.parse(JSON.stringify(x));

const NOMES = {
  campeoes: 'Campeões', leais: 'Leais', potenciais_leais: 'Potenciais leais', primeira_alto_valor: 'Primeira compra de alto valor', novos: 'Novos',
  aguardando_recompra: 'Aguardando recompra', precisam_atencao: 'Precisam de atenção', prestes_a_dormir: 'Prestes a dormir', em_risco: 'Em risco',
  hibernando: 'Hibernando', perdidos: 'Perdidos',
};
// Fixture do cenário-alvo: 0, 1, < 1%, 5% e > 50% (1.000 compradores; receita proporcional ao número de clientes × ticket do grupo).
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

test('todo segmento vira uma linha — inclusive 0 cliente e < 1% — e nenhum é filtrado', () => {
  const d = prepararDistribuicao(segmentos(), 'clientes');
  assert.equal(d.linhas.length, 11);
  assert.deepEqual(plano(d.linhas.map((l) => l.id).sort()), Object.keys(NOMES).sort());
  assert.deepEqual(plano(d.linhas.filter((l) => l.vazio).map((l) => l.id).sort()), ['campeoes', 'leais', 'perdidos']);
  const umCliente = d.linhas.find((l) => l.id === 'em_risco');
  assert.equal(umCliente.clientes, 1);
  assert.equal(umCliente.vazio, false);
  assert.equal(umCliente.abaixoDeUmPorCento, true);
  assert.equal(d.linhas.find((l) => l.id === 'precisam_atencao').abaixoDeUmPorCento, true, '0,3%');
  assert.equal(d.linhas.find((l) => l.id === 'potenciais_leais').abaixoDeUmPorCento, true, '0,6%');
  assert.equal(d.linhas.find((l) => l.id === 'novos').abaixoDeUmPorCento, false, '5%');
  assert.equal(d.totalClientes, 1000);
});

test('nomenclatura: o nome completo do servidor é preservado em todas as linhas, sem abreviar nem truncar', () => {
  const d = prepararDistribuicao(segmentos(), 'clientes');
  for (const l of d.linhas) assert.equal(l.nome, NOMES[l.id]);
  assert.ok(d.linhas.some((l) => l.nome === 'Primeira compra de alto valor'));
  assert.ok(d.linhas.some((l) => l.nome === 'Aguardando recompra'));
});

test('proporção: barra linear com base no maior valor; zero = 0; nada é distorcido por causa de texto', () => {
  const d = prepararDistribuicao(segmentos(), 'clientes');
  const por = Object.fromEntries(d.linhas.map((l) => [l.id, l]));
  assert.equal(d.maiorValor, 520);
  assert.equal(por.hibernando.larguraPct, 100);
  assert.equal(por.prestes_a_dormir.larguraPct, (250 / 520) * 100);
  assert.equal(por.novos.larguraPct, (50 / 520) * 100);
  assert.equal(por.perdidos.larguraPct, 0);
  assert.ok(Math.abs(por.prestes_a_dormir.larguraPct / por.novos.larguraPct - 250 / 50) < 1e-9, 'razão entre barras = razão entre valores');
});

test('marca mínima só para valor > 0 cuja barra ficaria invisível — declarada, nunca aplicada a zero', () => {
  const d = prepararDistribuicao(segmentos(), 'clientes', 300);
  const por = Object.fromEntries(d.linhas.map((l) => [l.id, l]));
  assert.equal(por.em_risco.marcaMinima, true, '1/520 de 300 px = 0,6 px');
  assert.equal(por.primeira_alto_valor.marcaMinima, true);
  assert.equal(por.precisam_atencao.marcaMinima, true, '3/520 de 300 px = 1,7 px');
  assert.equal(por.potenciais_leais.marcaMinima, false, '6/520 de 300 px = 3,5 px: já visível na escala real');
  assert.equal(por.novos.marcaMinima, false);
  for (const id of ['campeoes', 'leais', 'perdidos']) assert.equal(por[id].marcaMinima, false, `${id}: zero nunca ganha marca`);
  // Em uma trilha maior a mesma linha deixa de precisar da marca (a decisão é pela escala real, não fixa).
  const larga = prepararDistribuicao(segmentos(), 'clientes', 1200);
  assert.equal(larga.linhas.find((l) => l.id === 'precisam_atencao').marcaMinima, false);
});

test('receita: alterna a métrica sem mudar linhas, ordem nem grupos (a linha não "pula" ao trocar Clientes/Receita)', () => {
  const porClientes = prepararDistribuicao(segmentos(), 'clientes');
  const porReceita = prepararDistribuicao(segmentos(), 'receita');
  assert.deepEqual(plano(porReceita.linhas.map((l) => l.id)), plano(porClientes.linhas.map((l) => l.id)), 'mesma ordem');
  assert.deepEqual(plano(porReceita.grupos.map((g) => g.grupo)), plano(porClientes.grupos.map((g) => g.grupo)));
  assert.equal(porReceita.metrica, 'receita');
  const por = Object.fromEntries(porReceita.linhas.map((l) => [l.id, l]));
  const maior = Math.max(...porReceita.linhas.map((l) => l.receita));
  assert.equal(porReceita.maiorValor, maior);
  assert.equal(por.hibernando.valor, 520 * 130);
  assert.equal(por[porReceita.linhas.find((l) => l.receita === maior).id].larguraPct, 100);
  // Mesmos totais: a composição da base não muda com a métrica.
  assert.equal(porReceita.totalClientes, porClientes.totalClientes);
  assert.equal(porReceita.totalReceita, porClientes.totalReceita);
  // Principal × secundário trocam de papel, com os mesmos números do servidor.
  const h = por.hibernando;
  const hc = porClientes.linhas.find((l) => l.id === 'hibernando');
  assert.equal(h.pctPrincipal, hc.pctSecundario);
  assert.equal(h.pctSecundario, hc.pctPrincipal);
});

test('ordenação estável e agrupada por ciclo de vida, na precedência da regra; determinística', () => {
  const d = prepararDistribuicao(segmentos(), 'clientes');
  assert.deepEqual(plano(d.grupos.map((g) => g.grupo)), ['Fidelidade', 'Primeira compra', 'Atenção', 'Risco', 'Inativos']);
  assert.deepEqual(plano(d.grupos.map((g) => g.linhas.map((l) => l.id))), [
    ['campeoes', 'leais', 'potenciais_leais'], ['primeira_alto_valor', 'novos', 'aguardando_recompra'], ['precisam_atencao', 'prestes_a_dormir'], ['em_risco'], ['hibernando', 'perdidos'],
  ]);
  // Mesmo dado, entrada embaralhada de dentro de cada grupo → mesma ordem de saída dos GRUPOS; e repetir dá o mesmo resultado.
  assert.deepEqual(plano(prepararDistribuicao(segmentos(), 'clientes')), plano(d));
  const invertida = prepararDistribuicao(segmentos().reverse(), 'clientes');
  assert.deepEqual(plano(invertida.grupos.map((g) => g.grupo)), plano(d.grupos.map((g) => g.grupo)), 'grupos na ordem do ciclo de vida, não da entrada');
});

test('totais por grupo fecham com a base e não dependem da métrica', () => {
  const d = prepararDistribuicao(segmentos(), 'clientes');
  assert.equal(d.grupos.reduce((a, g) => a + g.clientes, 0), 1000);
  assert.ok(Math.abs(d.grupos.reduce((a, g) => a + g.pctBase, 0) - 1) < 1e-9);
  assert.ok(Math.abs(d.grupos.reduce((a, g) => a + g.pctReceita, 0) - 1) < 1e-9);
  const inativos = d.grupos.find((g) => g.grupo === 'Inativos');
  assert.equal(inativos.clientes, 520, 'Hibernando 520 + Perdidos 0');
  assert.ok(inativos.pctBase > 0.5, 'um só grupo concentra mais da metade da base');
  for (const g of d.grupos) assert.ok(GRUPOS_DESCRICAO[g.grupo], `grupo ${g.grupo} explicado em texto`);
});

test('casos extremos: base vazia, um único segmento, milhões e receita zero não geram NaN nem barra falsa', () => {
  const vazia = prepararDistribuicao(segmentos(Object.fromEntries(Object.keys(NOMES).map((id) => [id, 0]))), 'clientes');
  assert.equal(vazia.linhas.length, 11, 'os 11 continuam listados');
  assert.ok(vazia.linhas.every((l) => l.vazio && l.larguraPct === 0 && l.pctBase === 0 && !l.marcaMinima));
  assert.equal(vazia.maiorValor, 0);
  const um = prepararDistribuicao(segmentos({ ...Object.fromEntries(Object.keys(NOMES).map((id) => [id, 0])), novos: 1 }), 'clientes');
  assert.equal(um.linhas.find((l) => l.id === 'novos').larguraPct, 100);
  assert.equal(um.linhas.find((l) => l.id === 'novos').pctPrincipal, 1);
  const grande = prepararDistribuicao(segmentos({ ...CLIENTES, hibernando: 5_000_000 }), 'clientes');
  assert.ok(grande.linhas.every((l) => Number.isFinite(l.larguraPct) && Number.isFinite(l.pctPrincipal)));
  assert.ok(grande.linhas.find((l) => l.id === 'em_risco').marcaMinima);
  const semReceita = prepararDistribuicao(segmentos().map((s) => ({ ...s, receita: 0, pctReceita: 0 })), 'receita');
  assert.ok(semReceita.linhas.every((l) => l.larguraPct === 0 && !l.marcaMinima && Number.isFinite(l.pctPrincipal)));
});

test('segmento "dados insuficientes" (base pequena) também vira linha, num grupo próprio', () => {
  const d = prepararDistribuicao([{ ...segmentos()[0], id: 'dados_insuficientes', nome: 'Dados insuficientes', clientes: 12, pctBase: 1, receita: 1200, pctReceita: 1 }], 'clientes');
  assert.equal(d.linhas.length, 1);
  assert.equal(d.grupos[0].grupo, 'Sem classificação');
});

test('eventos de seleção: alternar adiciona/remove, mantém ordem e nunca duplica; trocar a métrica não toca na seleção', () => {
  let sel = [];
  sel = alternarSelecao(sel, 'novos');
  sel = alternarSelecao(sel, 'em_risco');
  assert.deepEqual(plano(sel), ['novos', 'em_risco']);
  sel = alternarSelecao(sel, 'novos');
  assert.deepEqual(plano(sel), ['em_risco']);
  assert.deepEqual(plano(alternarSelecao(alternarSelecao(['a'], 'b'), 'b')), ['a'], 'ligar e desligar volta ao início');
  const original = ['x', 'y'];
  alternarSelecao(original, 'z');
  assert.deepEqual(plano(original), ['x', 'y'], 'não muta o array recebido');
  // A distribuição é função só de (segmentos, métrica): a seleção vive fora dela.
  const antes = plano(prepararDistribuicao(segmentos(), 'clientes').linhas.map((l) => l.id));
  const depois = plano(prepararDistribuicao(segmentos(), 'receita').linhas.map((l) => l.id));
  assert.deepEqual(antes, depois);
});

test('explicação de zero: Perdidos com histórico curto é aritmética do histórico; outros zeros não inventam causa', () => {
  const curto = explicarZero('perdidos', { historicoObservadoDias: 300, limitePerdidosDias: 365 });
  assert.match(curto, /Ainda não pode existir/);
  assert.match(curto, /300 dias de histórico/);
  assert.match(curto, /mais de 365/);
  const longo = explicarZero('perdidos', { historicoObservadoDias: 500, limitePerdidosDias: 365 });
  assert.match(longo, /Nenhum cliente atende à regra hoje/);
  assert.match(explicarZero('leais', { historicoObservadoDias: 300, limitePerdidosDias: 365 }), /Nenhum cliente atende à regra hoje/);
  assert.match(explicarZero('perdidos', { historicoObservadoDias: 365, limitePerdidosDias: 365 }), /Ainda não pode existir/, 'exatamente 365 dias ainda não basta');
});

test('rótulo de acessibilidade: nome + grupo + clientes + % da base + % da receita, com singular e plural', () => {
  const d = prepararDistribuicao(segmentos(), 'clientes');
  const r = Object.fromEntries(d.linhas.map((l) => [l.id, rotuloAria(l)]));
  assert.match(r.em_risco, /^Em risco, Risco: 1 cliente, 0,1% da base, /);
  assert.match(r.hibernando, /^Hibernando, Inativos: 520 clientes, 52,0% da base, /);
  assert.match(r.perdidos, /^Perdidos, Inativos: 0 clientes, 0,0% da base, 0,0% da receita$/);
  assert.match(r.primeira_alto_valor, /^Primeira compra de alto valor, Primeira compra: 1 cliente/);
});

test('cada segmento tem estilo semântico e o grupo aparece em texto (a cor nunca é a única pista)', () => {
  for (const [id, e] of Object.entries(plano(ESTILO_SEGMENTO))) assert.ok(e.grupo && e.cor && e.tint && e.opacidade > 0 && e.opacidade < 1, id);
});
