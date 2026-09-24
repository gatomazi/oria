'use strict';

// RFM próprio (lib/clientes/rfm.js): universo, pedido válido, faixas de recência, F/M, segmentos exclusivos e
// exaustivos, empates, base pequena e histórico curto. Função pura: nenhuma dependência de banco ou relógio.

const test = require('node:test');
const assert = require('node:assert/strict');

const { classificarRfm, pedidoValido, casaPredicado, REGRAS, PADROES, VERSAO_ALGORITMO } = require('../lib/clientes/rfm');
const { agruparPedidosPorIdentidade } = require('../lib/clientes/identidade');

const AS_OF = new Date('2026-09-23T15:00:00Z'); // 12:00 em São Paulo
const diasAtras = (n, hora = 15) => {
  const d = new Date(AS_OF);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hora, 0, 0, 0);
  return d.toISOString();
};
const pedido = (diasDeIdade, valor = 100, extra = {}) => ({ criadoEm: diasAtras(diasDeIdade), valor, paymentStatus: 'paid', isTroca: false, ...extra });
const cliente = (id, pedidos) => ({ id, pedidos });

// Base sintética com 40 clientes e ~200 dias de histórico, cobrindo todas as faixas.
function baseSuficiente() {
  const clientes = [];
  for (let i = 0; i < 40; i += 1) clientes.push(cliente(`c${i}`, [pedido(10 + i * 5, 80 + i)]));
  clientes.push(cliente('historia', [pedido(200, 90)])); // garante ≥ 90 dias de histórico observado
  return clientes;
}
const porId = (r, id) => r.clientes.find((c) => c.id === id);

test('pedido válido: só paid/succeeded/free, sem troca, com data e valor', () => {
  assert.equal(pedidoValido(pedido(1)), true);
  assert.equal(pedidoValido(pedido(1, 0, { paymentStatus: 'free' })), true);
  assert.equal(pedidoValido(pedido(1, 10, { paymentStatus: 'refunded' })), false);
  assert.equal(pedidoValido(pedido(1, 10, { paymentStatus: 'canceled' })), false);
  assert.equal(pedidoValido(pedido(1, 10, { paymentStatus: 'pending' })), false);
  assert.equal(pedidoValido(pedido(1, 10, { isTroca: true })), false);
  assert.equal(pedidoValido({ ...pedido(1), criadoEm: null }), false);
  assert.equal(pedidoValido({ ...pedido(1), criadoEm: 'lixo' }), false);
  assert.equal(pedidoValido({ ...pedido(1), valor: -5 }), false);
});

test('universo: cliente sem compra válida não entra e é contado à parte', () => {
  const r = classificarRfm([
    ...baseSuficiente(),
    cliente('so-cancelado', [pedido(5, 100, { paymentStatus: 'canceled' })]),
    cliente('so-troca', [pedido(5, 100, { isTroca: true })]),
    cliente('vazio', []),
  ], { asOf: AS_OF });
  assert.equal(r.universo, 41);
  assert.equal(r.leadsSemCompraValida, 3);
  assert.equal(porId(r, 'so-cancelado'), undefined);
});

test('a soma de todos os segmentos é igual ao universo classificado', () => {
  const r = classificarRfm(baseSuficiente(), { asOf: AS_OF });
  assert.equal(r.amostraSuficiente, true);
  assert.equal(r.segmentos.reduce((acc, s) => acc + s.clientes, 0), r.universo);
  assert.equal(Math.round(r.segmentos.reduce((acc, s) => acc + s.pctBase, 0) * 1e6) / 1e6, 1);
  assert.equal(Math.round(r.segmentos.reduce((acc, s) => acc + s.pctReceita, 0) * 1e6) / 1e6, 1);
});

test('regras são mutuamente exclusivas e exaustivas em toda a grade de R, F e M', () => {
  const limites = PADROES.limitesRecenciaDias;
  const valorAlto = 150;
  const regras = REGRAS.map((regra) => ({ regra, predicado: require('../lib/clientes/rfm').predicadoDaRegra(regra, limites, valorAlto) }));
  for (let rDias = 0; rDias <= 400; rDias += 1) {
    for (const f of [1, 2, 3, 4, 10]) {
      for (const m of [0, 149.99, 150, 900]) {
        // F=0 só existe fora do limite superior de recência (Perdidos); o engine força F≥1 dentro dele.
        const fEfetivo = rDias <= limites[3] ? Math.max(1, f) : f;
        const casadas = regras.filter(({ predicado }) => casaPredicado(predicado, rDias, fEfetivo, m));
        assert.equal(casadas.length, 1, `R=${rDias} F=${f} M=${m} casou ${casadas.map((c) => c.regra.id)}`);
      }
    }
  }
});

test('F=1 nunca vira fidelidade, mesmo com valor muito alto', () => {
  const clientes = baseSuficiente();
  clientes.push(cliente('rico-uma-vez', [pedido(3, 50000)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  const c = porId(r, 'rico-uma-vez');
  assert.equal(c.fVida, 1);
  assert.equal(c.segmento.id, 'primeira_alto_valor');
  assert.ok(!['campeoes', 'leais', 'potenciais_leais'].includes(c.segmento.id));
});

test('recorrente recente vira Campeão (valor alto) ou Leal (valor abaixo do alto)', () => {
  const clientes = baseSuficiente();
  clientes.push(cliente('campeao', [pedido(5, 900), pedido(40, 900), pedido(80, 900)]));
  clientes.push(cliente('leal', [pedido(6, 10), pedido(41, 10), pedido(81, 10)]));
  clientes.push(cliente('potencial', [pedido(7, 100), pedido(50, 100)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  assert.equal(porId(r, 'campeao').segmento.id, 'campeoes');
  assert.equal(porId(r, 'leal').segmento.id, 'leais');
  assert.equal(porId(r, 'potencial').segmento.id, 'potenciais_leais');
});

test('faixas de recência nas fronteiras exatas (45/46, 90/91, 180/181, 365/366)', () => {
  const clientes = baseSuficiente();
  [45, 46, 90, 91, 180, 181, 365, 366].forEach((d) => clientes.push(cliente(`d${d}`, [pedido(d, 100)])));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  assert.equal(porId(r, 'd45').segmento.id === 'novos' || porId(r, 'd45').segmento.id === 'primeira_alto_valor', true);
  assert.equal(porId(r, 'd46').segmento.id, 'aguardando_recompra');
  assert.equal(porId(r, 'd90').segmento.id, 'aguardando_recompra');
  assert.equal(porId(r, 'd91').segmento.id, 'prestes_a_dormir');
  assert.equal(porId(r, 'd180').segmento.id, 'prestes_a_dormir');
  assert.equal(porId(r, 'd181').segmento.id, 'hibernando');
  assert.equal(porId(r, 'd365').segmento.id, 'hibernando');
  assert.equal(porId(r, 'd366').segmento.id, 'perdidos');
});

test('recorrente parado cai em Precisam de atenção, Em risco e Perdidos', () => {
  const clientes = baseSuficiente();
  clientes.push(cliente('atencao', [pedido(120, 100), pedido(150, 100)]));
  clientes.push(cliente('risco', [pedido(200, 100), pedido(230, 100)]));
  clientes.push(cliente('perdido', [pedido(500, 100), pedido(520, 100)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  assert.equal(porId(r, 'atencao').segmento.id, 'precisam_atencao');
  assert.equal(porId(r, 'risco').segmento.id, 'em_risco');
  assert.equal(porId(r, 'perdido').segmento.id, 'perdidos');
  assert.equal(porId(r, 'perdido').fJanela, 0);
  assert.equal(porId(r, 'perdido').fVida, 2);
});

test('recência conta dias de calendário no fuso da Organização, não múltiplos de 24h', () => {
  // 23:30 do dia anterior em São Paulo (02:30Z de hoje) e 00:30 de hoje em São Paulo (03:30Z) — asOf 12:00 local.
  const cedo = { criadoEm: '2026-09-23T03:30:00Z', valor: 10, paymentStatus: 'paid' }; // hoje 00:30 local → R=0
  const tarde = { criadoEm: '2026-09-23T02:30:00Z', valor: 10, paymentStatus: 'paid' }; // ontem 23:30 local → R=1
  const r = classificarRfm([...baseSuficiente(), cliente('cedo', [cedo]), cliente('tarde', [tarde])], { asOf: AS_OF });
  assert.equal(porId(r, 'cedo').r, 0);
  assert.equal(porId(r, 'tarde').r, 1);
});

test('pedido depois de `asOf` é ignorado (classificação reproduzível em data passada)', () => {
  const clientes = [...baseSuficiente(), cliente('futuro', [pedido(-3, 100)])];
  const r = classificarRfm(clientes, { asOf: AS_OF });
  assert.equal(porId(r, 'futuro'), undefined);
  assert.equal(r.leadsSemCompraValida, 1);
});

test('janela de frequência: pedidos fora da janela contam na vida, não em F/M', () => {
  const clientes = baseSuficiente();
  clientes.push(cliente('antigo-e-novo', [pedido(10, 100), pedido(400, 300)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  const c = porId(r, 'antigo-e-novo');
  assert.equal(c.fJanela, 1);
  assert.equal(c.fVida, 2);
  assert.equal(c.m, 100);
  assert.equal(c.ltv, 400);
  assert.equal(r.janelaAbrangeHistoricoObservado, false);
});

test('resultado não depende da ordem de entrada nem de empates (mesmo valor → mesma nota)', () => {
  const iguais = Array.from({ length: 40 }, (_, i) => cliente(`i${i}`, [pedido(30, 100)]));
  iguais.push(cliente('historia', [pedido(200, 100)]));
  const a = classificarRfm(iguais, { asOf: AS_OF });
  const b = classificarRfm([...iguais].reverse(), { asOf: AS_OF });
  const notas = (r) => Object.fromEntries(r.clientes.map((c) => [c.id, `${c.segmento.id}|${c.escore.r}${c.escore.f}${c.escore.m}`]));
  assert.deepEqual(notas(a), notas(b));
  const doGrupo = new Set(iguais.slice(0, 40).map((c) => notas(a)[c.id]));
  assert.equal(doGrupo.size, 1, 'clientes idênticos não podem cair em notas diferentes');
});

test('base pequena: Dados insuficientes, sem rótulo de recompra', () => {
  const r = classificarRfm(baseSuficiente().slice(0, 10), { asOf: AS_OF });
  assert.equal(r.amostraSuficiente, false);
  assert.match(r.motivoInsuficiencia, /base pequena/);
  assert.ok(r.clientes.every((c) => c.segmento.id === 'dados_insuficientes' && c.escore === null));
  assert.deepEqual(r.segmentos.map((s) => s.id), ['dados_insuficientes']);
  assert.equal(r.segmentos[0].clientes, 10);
});

test('histórico curto: Dados insuficientes mesmo com base grande', () => {
  const clientes = Array.from({ length: 60 }, (_, i) => cliente(`c${i}`, [pedido(i % 30, 100)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  assert.equal(r.amostraSuficiente, false);
  assert.match(r.motivoInsuficiencia, /histórico curto/);
  assert.ok(r.clientes.every((c) => c.segmento.id === 'dados_insuficientes'));
});

test('base sem nenhum cliente com compra: universo vazio, insuficiente, sem exceção', () => {
  const r = classificarRfm([], { asOf: AS_OF });
  assert.equal(r.universo, 0);
  assert.equal(r.amostraSuficiente, false);
  assert.equal(r.valorAlto, null);
});

test('baixa recompra (5% recorrentes): a maioria não vira fidelidade', () => {
  const clientes = [];
  for (let i = 0; i < 200; i += 1) clientes.push(cliente(`u${i}`, [pedido(1 + (i % 250), 50 + (i % 7) * 40)]));
  for (let i = 0; i < 10; i += 1) clientes.push(cliente(`r${i}`, [pedido(5 + i, 120), pedido(60 + i, 120)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  const fiel = r.segmentos.filter((s) => ['campeoes', 'leais', 'potenciais_leais'].includes(s.id)).reduce((a, s) => a + s.clientes, 0);
  assert.ok(fiel <= 10, `só recorrentes podem ser fidelidade, veio ${fiel}`);
});

test('limites de recência inválidos são recusados', () => {
  assert.throws(() => classificarRfm([], { asOf: AS_OF, limitesRecenciaDias: [90, 45, 180, 365] }), /crescentes/);
  assert.throws(() => classificarRfm([], { asOf: 'nao-e-data' }), /asOf/);
});

test('saída carrega versão, asOf, fuso, janela e cobertura para reprodutibilidade', () => {
  const r = classificarRfm(baseSuficiente(), { asOf: AS_OF });
  assert.equal(r.versao, VERSAO_ALGORITMO);
  assert.equal(r.asOf, AS_OF.toISOString());
  assert.equal(r.fuso, 'America/Sao_Paulo');
  assert.equal(r.janelaFrequenciaDias, 365);
  assert.equal(r.historicoObservadoDias, 205);
  assert.equal(r.janelaAbrangeHistoricoObservado, true);
});

test('identidade: pedidos ligados por documento, telefone ou e-mail viram uma pessoa (transitivo), com motivo', () => {
  const linhas = [
    { buyer_documento: '111', buyer_telefone: null, buyer_email: null },
    { buyer_documento: null, buyer_telefone: '5199', buyer_email: null },
    { buyer_documento: '111', buyer_telefone: '5199', buyer_email: null }, // liga os dois primeiros
    { buyer_documento: '222', buyer_telefone: '5100', buyer_email: 'a@x.com' },
    { buyer_documento: null, buyer_telefone: null, buyer_email: 'a@x.com' },
  ];
  const grupos = agruparPedidosPorIdentidade(linhas);
  assert.equal(grupos.length, 2);
  const [g1, g2] = grupos.sort((a, b) => b.pedidos.length - a.pedidos.length);
  assert.equal(g1.pedidos.length, 3);
  assert.deepEqual(g1.motivosDeUniao, ['documento', 'telefone']);
  assert.deepEqual(g2.motivosDeUniao, ['email']);
});

// ── Calibração: configuração central, versão da regra, fronteiras exatas e determinismo ──────────────────────
const { configuracaoEfetiva, regraVersao, mediana, PADROES: PADROES_RFM } = require('../lib/clientes/rfm');
const { analisarPedidos, deduplicarPedidos } = require('../lib/clientes/analise');
const { filtrosDoPredicado } = require('../lib/clientes/segmento');
const { predicadoDaRegra } = require('../lib/clientes/rfm');
const { calcularIndicadores } = require('../lib/clientes/metricas');

test('versão da regra: estável para a mesma configuração e diferente para QUALQUER limiar que mude', () => {
  const base = regraVersao(configuracaoEfetiva());
  assert.match(base, /^rfm-v1:[0-9a-f]{8}$/);
  assert.equal(regraVersao(configuracaoEfetiva()), base);
  assert.equal(regraVersao(configuracaoEfetiva({ limitesRecenciaDias: [45, 90, 180, 365] })), base, 'mesmo valor explícito = mesma regra');
  for (const mudanca of [
    { janelaFrequenciaDias: 180 }, { limitesRecenciaDias: [30, 90, 180, 365] }, { percentilValorAlto: 0.8 },
    { minClientes: 50 }, { minHistoricoDias: 120 }, { valorAltoMetrica: 'ticket_medio' },
  ]) assert.notEqual(regraVersao(configuracaoEfetiva(mudanca)), base, JSON.stringify(mudanca));
});

test('configuração: validada num lugar só, com erro claro e sem alterar os padrões', () => {
  assert.throws(() => configuracaoEfetiva({ janelaFrequenciaDias: 0 }), /janela/);
  assert.throws(() => configuracaoEfetiva({ percentilValorAlto: 1 }), /percentil/);
  assert.throws(() => configuracaoEfetiva({ percentilValorAlto: 0 }), /percentil/);
  assert.throws(() => configuracaoEfetiva({ valorAltoMetrica: 'lucro' }), /métrica/);
  assert.throws(() => configuracaoEfetiva({ minClientes: -1 }), /mínimos/);
  assert.throws(() => configuracaoEfetiva({ limitesRecenciaDias: [10, 10, 20, 30] }), /crescentes/);
  assert.equal(Object.isFrozen(configuracaoEfetiva()), true);
  assert.deepEqual([...PADROES_RFM.limitesRecenciaDias], [45, 90, 180, 365], 'os padrões do rfm-v1 não foram tocados');
});

test('resultado carrega a versão da regra e a configuração usada (base dos snapshots)', () => {
  const r = classificarRfm(baseSuficiente(), { asOf: AS_OF });
  assert.equal(r.regraVersao, regraVersao(configuracaoEfetiva()));
  assert.equal(r.configuracao.percentilValorAlto, 0.75);
  assert.equal(classificarRfm(baseSuficiente(), { asOf: AS_OF, percentilValorAlto: 0.9 }).regraVersao === r.regraVersao, false);
});

test('determinismo: mesmo instante de referência → resultado idêntico, mesmo com a entrada embaralhada', () => {
  const clientes = baseSuficiente();
  clientes.push(cliente('r1', [pedido(5, 300), pedido(50, 300), pedido(100, 300)]));
  const a = classificarRfm(clientes, { asOf: AS_OF });
  const b = classificarRfm([...clientes].reverse().map((c) => ({ ...c, pedidos: [...c.pedidos].reverse() })), { asOf: AS_OF });
  const resumo = (r) => JSON.stringify({ s: r.segmentos, c: r.clientes.map((c) => [c.id, c.segmento.id, c.escore, c.r, c.f, c.m]).sort((x, y) => (x[0] < y[0] ? -1 : 1)) });
  assert.equal(resumo(a), resumo(b));
  assert.equal(resumo(a), resumo(classificarRfm(clientes, { asOf: new Date(AS_OF) })));
});

test('fronteira de valor alto: M igual ao corte é ALTO; um centavo abaixo não é', () => {
  const clientes = baseSuficiente();
  const sondagem = classificarRfm(clientes, { asOf: AS_OF });
  const corte = sondagem.valorAlto;
  assert.ok(corte > 0);
  const com = [...clientes, cliente('no-corte', [pedido(3, corte)]), cliente('abaixo', [pedido(3, Math.round((corte - 0.01) * 100) / 100)])];
  // Inserir os dois clientes desloca o P75; fixa a fronteira comparando com a MESMA base ampliada.
  const r = classificarRfm(com, { asOf: AS_OF });
  const alto = porId(r, 'no-corte');
  const baixo = porId(r, 'abaixo');
  assert.ok(alto.m >= r.valorAlto === (alto.segmento.id === 'primeira_alto_valor'));
  assert.ok(baixo.m >= r.valorAlto === (baixo.segmento.id === 'primeira_alto_valor'));
  // Fronteira exata, sem depender do deslocamento: casaPredicado com M == corte / corte − 0.01.
  const regra = REGRAS.find((x) => x.id === 'primeira_alto_valor');
  const pred = predicadoDaRegra(regra, PADROES_RFM.limitesRecenciaDias, 150);
  assert.equal(casaPredicado(pred, 3, 1, 150), true);
  assert.equal(casaPredicado(pred, 3, 1, 149.99), false);
});

test('fronteira de fuso: 23:59 e 00:00 de São Paulo caem em dias diferentes (sem horário de verão)', () => {
  const asOf = new Date('2026-09-23T15:00:00Z');
  const ultimoSegundo = { criadoEm: '2026-09-23T02:59:59Z', valor: 10, paymentStatus: 'paid' }; // 22/09 23:59:59 local
  const primeiroSegundo = { criadoEm: '2026-09-23T03:00:00Z', valor: 10, paymentStatus: 'paid' }; // 23/09 00:00:00 local
  const r = classificarRfm([...baseSuficiente(), cliente('a', [ultimoSegundo]), cliente('b', [primeiroSegundo])], { asOf });
  assert.equal(porId(r, 'a').r, 1);
  assert.equal(porId(r, 'b').r, 0);
  // Mesmas horas, mas o `asOf` em UTC já no dia seguinte local: a referência também é convertida para o fuso.
  const noite = classificarRfm([...baseSuficiente(), cliente('c', [{ criadoEm: '2026-09-23T14:00:00Z', valor: 10, paymentStatus: 'paid' }])], { asOf: new Date('2026-09-24T02:30:00Z') });
  assert.equal(porId(noite, 'c').r, 0, '24/09 02:30Z ainda é 23/09 23:30 em São Paulo');
});

test('fronteira da janela de frequência: compra a 365 dias conta; a 366 não', () => {
  const clientes = baseSuficiente();
  clientes.push(cliente('j365', [pedido(10, 100), pedido(365, 100)]));
  clientes.push(cliente('j366', [pedido(10, 100), pedido(366, 100)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  assert.equal(porId(r, 'j365').fJanela, 2);
  assert.equal(porId(r, 'j366').fJanela, 1);
  assert.equal(porId(r, 'j366').fVida, 2);
});

test('reembolso em português ("Reembolsado"), cancelado e pendente nunca viram compra válida', () => {
  for (const status of ['Reembolsado', 'reembolsado', 'refunded', 'canceled', 'Cancelado', 'pending', 'waiting_payment', 'not_authorized', 'expired', 'dispute', 'chargeback', undefined, null, '']) {
    assert.equal(pedidoValido({ criadoEm: diasAtras(3), valor: 10, paymentStatus: status }), false, String(status));
  }
});

test('métrica de valor alto por ticket: recorrente com pedidos pequenos deixa de ser "valor alto" só por somar', () => {
  const clientes = baseSuficiente(); // uma compra de R$ 80–120
  clientes.push(cliente('recorrente-barato', [pedido(5, 60), pedido(40, 60), pedido(80, 60)])); // soma 180, ticket 60
  const porSoma = classificarRfm(clientes, { asOf: AS_OF });
  const porTicket = classificarRfm(clientes, { asOf: AS_OF, valorAltoMetrica: 'ticket_medio' });
  assert.equal(porSoma.valorAltoMetrica, 'ltv_janela');
  assert.equal(porTicket.valorAltoMetrica, 'ticket_medio');
  assert.equal(porSoma.segmentos.find((s) => s.id === 'campeoes').predicado.valor.metrica, 'ltv_janela');
  assert.equal(porTicket.segmentos.find((s) => s.id === 'campeoes').predicado.valor.metrica, 'ticket_medio');
  assert.equal(porSoma.clientes.find((c) => c.id === 'recorrente-barato').segmento.id, 'campeoes', 'soma 180 passa do P75 da base');
  assert.equal(porTicket.clientes.find((c) => c.id === 'recorrente-barato').segmento.id, 'leais', 'ticket 60 não passa');
  assert.equal(porSoma.segmentos.reduce((a, s) => a + s.clientes, 0), porTicket.segmentos.reduce((a, s) => a + s.clientes, 0));
  const filtros = filtrosDoPredicado(porTicket.segmentos.find((s) => s.id === 'campeoes').predicado);
  assert.ok(filtros.some((f) => f.field === 'ticketMedio'), 'o segmento por ticket vira filtro de ticket médio');
  assert.ok(!filtros.some((f) => f.field === 'totalGasto'));
});

test('medianas por segmento: recência e frequência (par e ímpar)', () => {
  assert.equal(mediana([]), null);
  assert.equal(mediana([5]), 5);
  assert.equal(mediana([1, 3, 2]), 2);
  assert.equal(mediana([1, 2, 3, 10]), 2.5);
  const r = classificarRfm(baseSuficiente(), { asOf: AS_OF });
  const seg = r.segmentos.find((s) => s.clientes > 1);
  assert.ok(Number.isFinite(seg.recenciaMedianaDias) && Number.isFinite(seg.frequenciaMediana));
});

test('pedido duplicado (linha legada + linha da Store) conta UMA vez e é contado à parte', () => {
  const linha = (id, extra = {}) => ({ loja: 'sul', ink_order_id: id, buyer_documento: '111', buyer_telefone: null, buyer_email: null, payment_status: 'paid', total_value: 100, criado_em: diasAtras(10), is_troca: false, ...extra });
  const { unicas, duplicados } = deduplicarPedidos([linha(1), linha(1, { loja: null }), linha(2)]);
  assert.equal(unicas.length, 2);
  assert.equal(duplicados, 1);
  const a = analisarPedidos([linha(1), linha(1, { loja: null }), linha(2)], { asOf: AS_OF, periodo: { de: '2026-09-01', ate: '2026-09-23' }, chaveDoContexto: 'sul' });
  assert.equal(a.cobertura.pedidosDuplicadosIgnorados, 1);
  assert.equal(a.cobertura.pedidosTotal, 2);
  assert.equal(a.indicadores.atual.pedidos, 2, 'sem o desvio, seriam 3 pedidos e 300 de faturamento');
  assert.equal(a.indicadores.atual.faturamento, 200);
});

test('empate de horário entre pedidos: o cliente (chave e nome) não depende da ordem de leitura', () => {
  const t = diasAtras(4);
  const l = (id, nome, doc) => ({ loja: 'sul', ink_order_id: id, buyer_nome: nome, buyer_documento: doc, buyer_telefone: '5199', buyer_email: null, payment_status: 'paid', total_value: 50, criado_em: t, is_troca: false });
  const linhas = [l(10, 'Nome A', 'doc-a'), l(11, 'Nome B', 'doc-b')]; // ligados pelo telefone, mesmo instante
  const a = analisarPedidos(linhas, { asOf: AS_OF, periodo: { de: '2026-09-01', ate: '2026-09-23' }, chaveDoContexto: 'sul' });
  const b = analisarPedidos([...linhas].reverse(), { asOf: AS_OF, periodo: { de: '2026-09-01', ate: '2026-09-23' }, chaveDoContexto: 'sul' });
  assert.equal(a.clientes.length, 1);
  assert.equal(a.clientes[0].customerKey, b.clientes[0].customerKey);
  assert.equal(a.clientes[0].nome, b.clientes[0].nome);
  assert.equal(a.clientes[0].nome, 'Nome B', 'no empate vale o maior id da Ink');
});

test('indicadores: reembolso total em português entra em "pedidos reembolsados", fora do faturamento', () => {
  const clientes = [c1('a', [
    { criadoEm: '2026-09-05T15:00:00Z', valor: 100, paymentStatus: 'Reembolsado' },
    { criadoEm: '2026-09-06T15:00:00Z', valor: 100, paymentStatus: 'refunded' },
    { criadoEm: '2026-09-07T15:00:00Z', valor: 100, paymentStatus: 'paid' },
  ])];
  function c1(id, pedidos) { return { id, pedidos }; }
  const r = calcularIndicadores(clientes, { de: '2026-09-01', ate: '2026-09-30' }, { primeiroPedidoEm: '2026-08-01T00:00:00Z' });
  assert.equal(r.atual.pedidosReembolsados, 2);
  assert.equal(r.atual.faturamento, 100);
});
