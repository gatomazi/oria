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
  assert.equal(r.suficiente, true);
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
  assert.equal(r.janelaCobreHistorico, false);
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
  assert.equal(r.suficiente, false);
  assert.match(r.motivoInsuficiencia, /base pequena/);
  assert.ok(r.clientes.every((c) => c.segmento.id === 'dados_insuficientes' && c.escore === null));
  assert.deepEqual(r.segmentos.map((s) => s.id), ['dados_insuficientes']);
  assert.equal(r.segmentos[0].clientes, 10);
});

test('histórico curto: Dados insuficientes mesmo com base grande', () => {
  const clientes = Array.from({ length: 60 }, (_, i) => cliente(`c${i}`, [pedido(i % 30, 100)]));
  const r = classificarRfm(clientes, { asOf: AS_OF });
  assert.equal(r.suficiente, false);
  assert.match(r.motivoInsuficiencia, /histórico curto/);
  assert.ok(r.clientes.every((c) => c.segmento.id === 'dados_insuficientes'));
});

test('base sem nenhum cliente com compra: universo vazio, insuficiente, sem exceção', () => {
  const r = classificarRfm([], { asOf: AS_OF });
  assert.equal(r.universo, 0);
  assert.equal(r.suficiente, false);
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
  assert.equal(r.historicoDias, 205);
  assert.equal(r.janelaCobreHistorico, true);
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
