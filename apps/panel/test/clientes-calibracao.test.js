'use strict';

// Relatório de calibração (lib/clientes/calibracao.js): agregado, anonimizado e determinístico. Nada de dado pessoal na
// saída, integridade das linhas auditada e alternativas comparadas contra a regra atual.

const test = require('node:test');
const assert = require('node:assert/strict');

const { gerarRelatorio, auditarLinhas, quantis, paraMarkdown } = require('../lib/clientes/calibracao');

const AS_OF = new Date('2026-09-23T15:00:00Z');
const dia = (n) => new Date(AS_OF.getTime() - n * 86_400_000).toISOString();
let seq = 1000;
const linha = (id, docTel, dias, extra = {}) => ({
  loja: 'sul', ink_order_id: id ?? ++seq, buyer_documento: docTel, buyer_telefone: `51${docTel}`, buyer_email: `pessoa-${docTel}@exemplo.test`,
  payment_status: 'paid', order_status: 'sent', total_value: 100, criado_em: dia(dias), is_troca: false, frete: 10, descontos: 0, items_count: 1, ...extra,
});

function base() {
  const l = [];
  for (let i = 0; i < 80; i += 1) l.push(linha(null, `9000${String(i).padStart(4, '0')}`, 5 + i * 3, { total_value: 60 + (i % 9) * 20 }));
  for (let i = 0; i < 40; i += 1) { // recorrentes: intervalos de 30–70 dias
    l.push(linha(null, `8000${String(i).padStart(4, '0')}`, 20 + i, { total_value: 150 }));
    l.push(linha(null, `8000${String(i).padStart(4, '0')}`, 20 + i + 30 + (i % 41), { total_value: 150 }));
  }
  l.push(linha(null, '77770001', 4, { payment_status: 'canceled' }));
  l.push(linha(null, '77770002', 4, { payment_status: 'Reembolsado' }));
  l.push(linha(null, '77770003', 4, { payment_status: 'paid', order_status: 'canceled' })); // pago mas pedido encerrado
  l.push(linha(null, '77770004', 4, { payment_status: 'estado-novo-da-ink' }));
  return l;
}

test('a saída não contém documento, telefone, e-mail nem nome: só agregados e rótulos opacos', () => {
  const r = gerarRelatorio(base(), { asOf: AS_OF });
  const json = JSON.stringify(r) + paraMarkdown(r);
  assert.ok(!/9000\d{4}|8000\d{4}|7777000|exemplo\.test|pessoa-/.test(json), 'nenhuma chave de cliente pode vazar');
  for (const a of r.amostrasLimitrofes) assert.match(a.ref, /^c_[0-9a-f]{8}$/);
});

test('rótulos das amostras mudam a cada execução (não dá para correlacionar relatórios), o resto é determinístico', () => {
  const a = gerarRelatorio(base(), { asOf: AS_OF });
  const b = gerarRelatorio(base(), { asOf: AS_OF });
  const semRuido = (r) => JSON.stringify({ ...r, geradoEm: 0, amostrasLimitrofes: r.amostrasLimitrofes.map(({ ref, ...x }) => x) });
  assert.equal(semRuido(a), semRuido(b));
  if (a.amostrasLimitrofes.length) assert.notEqual(a.amostrasLimitrofes[0].ref, b.amostrasLimitrofes[0].ref);
});

test('integridade: status desconhecido, pago com pedido encerrado, cruzamento e duplicidade aparecem nos números', () => {
  const linhas = [...base(), linha(1, '55550001', 9), linha(1, '55550001', 9, { loja: null })]; // mesmo ink_order_id duas vezes
  const i = auditarLinhas(linhas);
  assert.equal(i.linhasDuplicadasPorInkOrderId, 1);
  assert.deepEqual(i.statusDePagamentoNaoReconhecidos, { 'estado-novo-da-ink': 1, Reembolsado: 1 });
  assert.equal(i.pagamentoValidoComPedidoEncerrado.pedidos, 1);
  assert.equal(i.pagamentoValidoComPedidoEncerrado.valor, 100);
  assert.ok(i.statusPagamentoXPedido['paid × sent'] > 100);
  assert.equal(i.semIdentidade, 0);
  assert.equal(auditarLinhas([{ ink_order_id: 5, payment_status: null, total_value: null, criado_em: null }]).semStatusDePagamento, 1);
});

test('universo e conferências: soma dos segmentos = universo; duplicidade não infla nada', () => {
  const linhas = [...base(), linha(1, '55550001', 9), linha(1, '55550001', 9, { loja: null })];
  const r = gerarRelatorio(linhas, { asOf: AS_OF });
  assert.equal(r.cobertura.pedidosDuplicadosIgnorados, 1);
  // 80 de uma compra + 40 recorrentes + '77770003' (pago; o encerramento do PEDIDO não o exclui — é o que o relatório sinaliza) + '55550001'.
  assert.equal(r.universo.compradores, 80 + 40 + 1 + 1);
  assert.deepEqual(r.conferencias, { somaDosSegmentosIgualAoUniverso: true, receitaDosSegmentosIgualAoLtvTotal: true, pedidosDosSegmentosIgualAosValidos: true });
});

test('distribuições: uma compra concentra a base e quantis batem com o cálculo direto', () => {
  const r = gerarRelatorio(base(), { asOf: AS_OF });
  const d = r.distribuicoes;
  assert.equal(d.frequencia.distribuicao['1'], 80 + 1);
  assert.equal(d.frequencia.distribuicao['2'], 40);
  assert.equal(d.universo, r.universo.compradores);
  assert.ok(d.concentracaoDeReceita.top10pct >= 10 && d.concentracaoDeReceita.top20pct >= d.concentracaoDeReceita.top10pct);
  const q = quantis([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(q.p50, 5);
  assert.equal(q.p90, 9);
  assert.equal(quantis([]), null);
});

test('recompra: só conclui com amostra mínima; abaixo disso devolve o aviso, não um número', () => {
  const pouca = gerarRelatorio([...base().slice(0, 90), linha(null, '99990001', 400), linha(null, '99990001', 350)], { asOf: AS_OF });
  assert.equal(pouca.recompra.intervalosEntreCompras, null);
  assert.match(pouca.recompra.avisoIntervalos, /mínimo 30/);
  const r = gerarRelatorio(base(), { asOf: AS_OF });
  assert.ok(r.recompra.intervalosObservados >= 30);
  assert.ok(r.recompra.intervalosEntreCompras.p50 >= 30);
  assert.equal(r.recompra.segundaCompraAte['30d'].elegiveis > 0, true);
});

test('coorte de segunda compra exclui quem ainda não teve tempo de recomprar (sem viés de censura)', () => {
  const linhas = [];
  for (let i = 0; i < 40; i += 1) linhas.push(linha(null, `6000${String(i).padStart(4, '0')}`, 10 + i)); // 1ª compra há 10–49 dias, sem 2ª
  for (let i = 0; i < 40; i += 1) linhas.push(linha(null, `6100${String(i).padStart(4, '0')}`, 200 + i));
  const r = gerarRelatorio(linhas, { asOf: AS_OF });
  const c180 = r.recompra.segundaCompraAte['180d'];
  assert.equal(c180.elegiveis, 40, 'só quem comprou há 180+ dias entra no denominador de 180 dias');
  assert.equal(r.recompra.segundaCompraAte['30d'].elegiveis, 40 + 40 - 20, 'quem tem menos de 30 dias de idade fica de fora');
});

test('alternativas: a primeira é a regra atual (0 mudanças) e cada uma tem versão de regra própria', () => {
  const r = gerarRelatorio(base(), { asOf: AS_OF });
  assert.equal(r.alternativas[0].versusAtual.clientesQueMudaramDeSegmento, 0);
  const versoes = new Set(r.alternativas.map((a) => a.regraVersao));
  assert.equal(versoes.size, r.alternativas.length);
  for (const a of r.alternativas) assert.equal(a.segmentos.reduce((s, x) => s + x.clientes, 0), r.universo.compradores, a.nome);
  assert.ok(r.alternativas.some((a) => a.versusAtual.clientesQueMudaramDeSegmento > 0), 'alguma alternativa altera a classificação');
});

test('base pequena: relatório sai, marcado como insuficiente, sem exceção', () => {
  const r = gerarRelatorio([linha(null, '10000001', 3)], { asOf: AS_OF });
  assert.equal(r.universo.suficiente, false);
  assert.match(r.universo.motivoInsuficiencia, /base pequena/);
  const vazio = gerarRelatorio([], { asOf: AS_OF });
  assert.equal(vazio.universo.compradores, 0);
  assert.equal(vazio.integridade.linhas, 0);
});

test('markdown resume as seções sem quebrar', () => {
  const md = paraMarkdown(gerarRelatorio(base(), { asOf: AS_OF }));
  for (const t of ['## 1. Integridade', '## 3. Regra atual por segmento', '## 5. Alternativas']) assert.ok(md.includes(t), t);
});
