'use strict';

// Relatório de calibração (lib/clientes/calibracao.js): agregado, anonimizado e determinístico. Nada de dado pessoal na
// saída, integridade das linhas auditada e alternativas comparadas contra a regra atual.

const test = require('node:test');
const assert = require('node:assert/strict');

const { gerarRelatorio, auditarLinhas, quantis, paraMarkdown, observacoesMinimas, nd, comportamentoDeRecompra } = require('../lib/clientes/calibracao');
const { semanticaDeCobertura } = require('../lib/clientes/cobertura');
const diaSP = (n) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(AS_OF.getTime() - n * 86_400_000));

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
  assert.deepEqual(r.conferencias, { somaDosSegmentosIgualAoUniverso: true, receitaDosSegmentosIgualAoLtvTotal: true, pedidosDosSegmentosIgualAosValidos: true, todasAlternativasNaMesmaPopulacaoEInstante: true });
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
  assert.equal(r.universo.amostraSuficiente, false);
  assert.match(r.universo.motivoInsuficiencia, /base pequena/);
  const vazio = gerarRelatorio([], { asOf: AS_OF });
  assert.equal(vazio.universo.compradores, 0);
  assert.equal(vazio.integridade.linhas, 0);
});

test('markdown resume as seções sem quebrar', () => {
  const md = paraMarkdown(gerarRelatorio(base(), { asOf: AS_OF }));
  for (const t of ['## 0. Cobertura do histórico', '## 1. Integridade', '## 3. Regra atual por segmento', '## 5. Regra atual × alternativas']) assert.ok(md.includes(t), t);
});

// ── Quantis: nunca `undefined`; amostra pequena → null explícito ─────────────────────────────────────
test('observações mínimas por quantil: cauda com ao menos uma observação (fronteiras exatas)', () => {
  assert.equal(observacoesMinimas(0.5), 2);
  assert.equal(observacoesMinimas(0.25), 4);
  assert.equal(observacoesMinimas(0.75), 4);
  assert.equal(observacoesMinimas(0.9), 10, 'sem erro de ponto flutuante (1/0.0999… ≠ 11)');
  assert.equal(observacoesMinimas(0.1), 10);
  assert.equal(observacoesMinimas(0.95), 20);
  assert.equal(observacoesMinimas(0.05), 20);
  assert.equal(observacoesMinimas(0.99), 100);
});

test('quantis com poucos dados: os que a amostra não sustenta são null (não undefined), com a lista em `indisponiveis`', () => {
  const q = quantis([5, 1, 9, 3, 7]); // n = 5: p25/p50/p75 ok; p5/p10/p90/p95/p99 não
  assert.equal(q.n, 5);
  assert.equal(q.p50, 5);
  for (const k of ['p5', 'p10', 'p90', 'p95', 'p99']) { assert.ok(k in q, `${k} presente`); assert.equal(q[k], null, k); }
  assert.deepEqual(q.indisponiveis.sort(), ['p10', 'p5', 'p90', 'p95', 'p99']);
  assert.ok(Object.values(q).every((v) => v !== undefined), 'nenhum undefined');
  const um = quantis([42]);
  assert.equal(um.p50, null, 'com 1 observação nem a mediana é sustentada');
  assert.equal(um.min, 42);
  assert.equal(um.max, 42);
});

test('quantis nas fronteiras de tamanho: o p aparece exatamente quando n atinge o mínimo', () => {
  const de = (n) => Array.from({ length: n }, (_, i) => i + 1);
  assert.equal(quantis(de(9)).p90, null);
  assert.equal(quantis(de(10)).p90, 9);
  assert.equal(quantis(de(19)).p95, null);
  assert.equal(quantis(de(20)).p95, 19);
  assert.equal(quantis(de(99)).p99, null);
  assert.equal(quantis(de(100)).p99, 99);
  assert.equal(quantis(de(3)).p75, null);
  assert.equal(quantis(de(4)).p75, 3);
  const grande = quantis(de(1000));
  assert.equal(grande.p50, 500);
  assert.equal(grande.p99, 990);
  assert.deepEqual(grande.indisponiveis, []);
});

test('quantis: distribuição vazia → null; valores iguais e não numéricos são tratados', () => {
  assert.equal(quantis([]), null);
  assert.equal(quantis([NaN, undefined, null]), null);
  assert.equal(quantis([NaN]), null, 'só valores inválidos = vazio');
  const iguais = quantis(Array(30).fill(7));
  assert.equal(iguais.p10, 7);
  assert.equal(iguais.p90, 7);
  assert.equal(iguais.media, 7);
});

test('markdown nunca imprime "undefined" nem "NaN", em nenhum tamanho de base (vazia, 1, 5, 40, 500 clientes)', () => {
  for (const n of [0, 1, 5, 40, 500]) {
    const linhas = [];
    for (let i = 0; i < n; i += 1) {
      linhas.push(linha(null, `5000${String(i).padStart(4, '0')}`, 3 + (i * 7) % 300));
      if (i % 9 === 0) linhas.push(linha(null, `5000${String(i).padStart(4, '0')}`, 3 + (i * 7) % 300 + 40));
    }
    const md = paraMarkdown(gerarRelatorio(linhas, { asOf: AS_OF }));
    assert.ok(!/undefined|NaN|\[object Object\]/.test(md), `base de ${n}: ${(md.match(/.{20}(undefined|NaN).{20}/) || [''])[0]}`);
    assert.ok(md.includes('n.d.') || n >= 40, `base de ${n} declara o que não tem`);
  }
  assert.equal(nd(undefined), 'n.d.');
  assert.equal(nd(NaN), 'n.d.');
  assert.equal(nd(null), 'n.d.');
  assert.equal(nd(0), '0');
});

// ── Cobertura ≠ amostra suficiente ───────────────────────────────────────────────────────────────────
test('cobertura: 260 dias observados sem backfill → amostra pode ser suficiente, cobertura NÃO confirmada', () => {
  const linhas = [];
  for (let i = 0; i < 60; i += 1) linhas.push(linha(null, `4000${String(i).padStart(4, '0')}`, 5 + i * 4)); // 5..241 dias
  linhas.push(linha(null, '40009999', 260));
  const r = gerarRelatorio(linhas, { asOf: AS_OF });
  assert.equal(r.universo.amostraSuficiente, true, 'critério estatístico atendido');
  assert.equal(r.cobertura.historicoObservadoDias, 260);
  assert.equal(r.cobertura.backfillConfirmado, false);
  assert.equal(r.cobertura.cobertura365Confirmada, false);
  assert.equal(r.cobertura.coberturaConfirmadaDias, null);
  assert.equal(r.cobertura.janelaObservadaAbrange365, false);
  assert.match(r.cobertura.leitura, /Nenhum backfill concluído/);
  assert.equal(r.recompra.segundaCompraAte['365d'].elegivel, false);
  assert.match(r.recompra.segundaCompraAte['365d'].motivoInelegivel, /histórico observado \(260 d\) menor que a janela de 365 d/);
});

test('cobertura: só backfill CONCLUÍDO confirma; observar 400 dias sem backfill continua não confirmado', () => {
  const base = { primeiroPedidoEm: dia(400), asOf: AS_OF };
  const sem = semanticaDeCobertura({ ...base, backfill: null });
  assert.equal(sem.historicoObservadoDias, 400);
  assert.equal(sem.janelaObservadaAbrange365, true, 'observado ≥ 365');
  assert.equal(sem.cobertura365Confirmada, false, 'mas nada confirma que não há buracos');
  const falhou = semanticaDeCobertura({ ...base, backfill: { ultimoStatus: 'falhou', concluidoDesde: null } });
  assert.equal(falhou.backfillConfirmado, false);
  assert.equal(falhou.ultimoBackfillStatus, 'falhou');
  const curto = semanticaDeCobertura({ ...base, backfill: { ultimoStatus: 'concluido', concluidoDesde: diaSP(200) } });
  assert.equal(curto.backfillConfirmado, true);
  assert.equal(curto.coberturaConfirmadaDias, 200);
  assert.equal(curto.cobertura365Confirmada, false);
  assert.match(curto.leitura, /menos que a janela/);
  const completo = semanticaDeCobertura({ ...base, backfill: { ultimoStatus: 'concluido', concluidoDesde: diaSP(400) } });
  assert.equal(completo.cobertura365Confirmada, true);
  assert.equal(completo.coberturaJanelaConfirmada, true);
  // Fronteira exata: 365 dias confirmados contam; 364 não.
  assert.equal(semanticaDeCobertura({ ...base, backfill: { ultimoStatus: 'concluido', concluidoDesde: diaSP(365) } }).cobertura365Confirmada, true);
  assert.equal(semanticaDeCobertura({ ...base, backfill: { ultimoStatus: 'concluido', concluidoDesde: diaSP(364) } }).cobertura365Confirmada, false);
  assert.equal(semanticaDeCobertura({ primeiroPedidoEm: null, asOf: AS_OF }).historicoObservadoDias, 0);
  // Coluna DATE do Postgres chega como objeto Date (meia-noite local): tem que valer igual ao texto AAAA-MM-DD.
  const [ano, mes, d] = diaSP(365).split('-').map(Number);
  const comoDate = semanticaDeCobertura({ ...base, backfill: { ultimoStatus: 'concluido', concluidoDesde: new Date(ano, mes - 1, d) } });
  assert.equal(comoDate.backfillConfirmado, true);
  assert.equal(comoDate.backfillConcluidoDesde, diaSP(365));
  assert.equal(comoDate.cobertura365Confirmada, true);
});

// ── Recompra: denominadores e elegibilidade por janela ───────────────────────────────────────────────
test('recompra: cada janela tem denominador próprio e declarado; os totais não são uma curva cumulativa', () => {
  const linhas = [];
  // 40 clientes com 1ª compra há 100 dias (elegíveis a 30/60/90, não a 180); 10 deles recompraram 20 dias depois.
  for (let i = 0; i < 40; i += 1) {
    linhas.push(linha(null, `3000${String(i).padStart(4, '0')}`, 100));
    if (i < 10) linhas.push(linha(null, `3000${String(i).padStart(4, '0')}`, 80));
  }
  // 40 clientes com 1ª compra há 200 dias (elegíveis a todas até 180); 4 recompraram 150 dias depois.
  for (let i = 0; i < 40; i += 1) {
    linhas.push(linha(null, `3100${String(i).padStart(4, '0')}`, 200));
    if (i < 4) linhas.push(linha(null, `3100${String(i).padStart(4, '0')}`, 50));
  }
  const r = gerarRelatorio(linhas, { asOf: AS_OF });
  const c = r.recompra.segundaCompraAte;
  assert.equal(c['30d'].elegiveis, 80);
  assert.equal(c['90d'].elegiveis, 80);
  assert.equal(c['180d'].elegiveis, 40, 'só quem comprou há 180+ dias');
  assert.equal(c['365d'].elegiveis, 0);
  assert.equal(c['365d'].elegivel, false);
  assert.equal(c['30d'].recompraram, 10);
  assert.equal(c['180d'].recompraram, 4);
  assert.equal(c['180d'].pct, 10, '4 de 40, não 14 de 80: outro denominador');
  assert.match(c['30d'].denominador, /≥ 30 dias/);
  assert.match(r.recompra.notaDenominador, /não são uma curva cumulativa/);
});

test('recompra: coorte abaixo do mínimo é inelegível com motivo (nunca um percentual sem base)', () => {
  const r = gerarRelatorio([linha(null, '20000001', 100), linha(null, '20000001', 60), linha(null, '20000002', 100)], { asOf: AS_OF });
  const c = r.recompra.segundaCompraAte['30d'];
  assert.equal(c.elegivel, false);
  assert.equal(c.pct, null);
  assert.match(c.motivoInelegivel, /coorte de 2 \(mínimo 30\)/);
});

test('recompra: pedidos da mesma pessoa no mesmo dia são contados à parte (podem ser pedido dividido)', () => {
  const linhas = [];
  for (let i = 0; i < 35; i += 1) { linhas.push(linha(null, `1000${String(i).padStart(4, '0')}`, 50)); linhas.push(linha(null, `1000${String(i).padStart(4, '0')}`, 50)); }
  const r = gerarRelatorio(linhas, { asOf: AS_OF });
  assert.equal(r.recompra.intervalosNoMesmoDia, 35);
  assert.equal(r.recompra.intervalosObservados, 35);
});

// ── Regra atual × alternativas: mesma população, mesmo instante, impacto nos Leais ───────────────────
test('alternativas: todas na mesma população e no mesmo instante, com receita, recência, recorrência e impacto nos Leais', () => {
  const r = gerarRelatorio(base(), { asOf: AS_OF });
  assert.equal(r.conferencias.todasAlternativasNaMesmaPopulacaoEInstante, true);
  for (const a of r.alternativas) {
    assert.deepEqual(a.populacao, r.populacao, a.nome);
    for (const sg of a.segmentos) for (const k of ['clientes', 'pctBase', 'receita', 'pctReceita', 'recenciaMedianaDias', 'frequenciaMediana']) assert.ok(k in sg, `${a.nome}/${sg.id}/${k}`);
    assert.equal(a.segmentos.reduce((s, x) => s + Math.round(x.receita * 100), 0), r.populacao.ltvTotalCentavos, `${a.nome}: receita fecha com o LTV da população`);
    assert.ok('leaisAtual' in a.impactoNosLeais && 'deCampeoesParaLeais' in a.impactoNosLeais);
  }
  const atualNoImpacto = r.alternativas[0].impactoNosLeais;
  assert.equal(atualNoImpacto.leaisAtual, atualNoImpacto.leaisAlternativa, 'a regra atual não muda nada nela mesma');
  const md = paraMarkdown(r);
  for (const t of ['**Clientes por segmento**', '**Receita (LTV) por segmento, R$**', '**Recência mediana (dias) por segmento**', '**Impacto sobre Campeões e Leais**']) assert.ok(md.includes(t), t);
});

test('impacto nos Leais: métrica por ticket move recorrentes de "baixo ticket" de Campeões para Leais', () => {
  const linhas = [];
  for (let i = 0; i < 60; i += 1) linhas.push(linha(null, `6000${String(i).padStart(4, '0')}`, 10 + i * 3, { total_value: 100 + i }));
  for (let i = 0; i < 6; i += 1) for (const d of [4, 30, 60]) linhas.push(linha(null, `6900${String(i).padStart(4, '0')}`, d + i, { total_value: 60 })); // soma 180 > P75 da soma; ticket 60 < P75 do ticket
  const r = gerarRelatorio(linhas, { asOf: AS_OF });
  const porTicket = r.alternativas.find((a) => a.nome === 'valor alto = P75 do ticket médio');
  assert.equal(porTicket.impactoNosLeais.leaisAtual, 0, 'pela soma, todo recorrente passa do corte e vira Campeão');
  assert.ok(porTicket.impactoNosLeais.leaisAlternativa >= 6, `pelo ticket, ${porTicket.impactoNosLeais.leaisAlternativa} viram Leais`);
  assert.ok(porTicket.impactoNosLeais.deCampeoesParaLeais >= 6);
});
