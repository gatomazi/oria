'use strict';

// Rodada 5 — a Audiência de um segmento RFM tem de ser a MESMA população da matriz de Clientes (mesmo `asOf`, mesma regra,
// mesmo corte salvo), enquanto os filtros genéricos herdados de Campanhas medem diferente (troca paga, 24h corridas, sem janela).
// Tudo sintético e com relógio/fuso controlados: `asOf` entra por parâmetro; nomes/documentos são rótulos opacos ("Sintético S-…").
// Cada caso compara os CONJUNTOS de IDs (não só contagens): RFM (matriz) × Audiência exata × filtros genéricos (legado).

const test = require('node:test');
const assert = require('node:assert/strict');

const { analisarRfm } = require('../lib/clientes/analise');
const { agregarClientesDePedidos, avaliarFiltroNumerico } = require('../lib/clientes/agregado');
const { filtrosDoPredicado } = require('../lib/clientes/segmento');
const { REGRAS, casaPredicado } = require('../lib/clientes/rfm');
const {
  ErroAudienciaRfm, filtroRfmDoSegmento, separarFiltros, resolverPopulacaoRfm, validarFiltroRfm,
} = require('../lib/clientes/audiencia-rfm');

const FUSO = 'America/Sao_Paulo';
const CHAVE_LOJA = 'sul';
const ASOF_MEIO_DIA = new Date('2026-09-24T15:00:00Z'); // 12:00 em São Paulo (UTC−3, sem horário de verão)

// ── construtores sintéticos ─────────────────────────────────────────────────────────────────────────
let ordem = 0;
const local = (iso) => new Date(iso).toISOString(); // ISO com offset explícito (-03:00) → instante
// Meio-dia local, N dias de calendário antes do dia de `asOf`.
const diasAntes = (asOf, n, hora = '12:00:00') => {
  const [a, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(asOf).split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1, d - n));
  const dia = alvo.toISOString().slice(0, 10);
  return new Date(`${dia}T${hora}-03:00`).toISOString();
};

function linha({ ref, doc, tel, email, quando, valor = 40, pay = 'paid', order = 'sent', troca = false, aceita = true, loja = CHAVE_LOJA, id, frete = 0, descontos = 0, nome }) {
  ordem += 1;
  return {
    loja, ink_order_id: id ?? ordem, buyer_nome: nome ?? `Sintético ${ref}`,
    buyer_telefone: tel ?? null, buyer_documento: doc === undefined ? `DOC-${ref}` : doc, buyer_email: email ?? null,
    buyer_aceita_marketing: aceita, buyer_uf: 'RS', payment_status: pay, order_status: order, total_value: valor,
    criado_em: quando, is_troca: troca, frete, descontos, items_count: 1, lucro_operacional: null,
  };
}

// 40 compradores de fundo, 1 compra de R$ 50 cada, 100–217 dias antes: dão amostra suficiente (≥30 e ≥90 dias) e P75 = 50.
function fundo(asOf) {
  const linhas = [];
  for (let i = 0; i < 40; i += 1) linhas.push(linha({ ref: `F${String(i).padStart(2, '0')}`, nome: `Fundo F${String(i).padStart(2, '0')}`, quando: diasAntes(asOf, 100 + i * 3), valor: 50 }));
  return linhas;
}

// Leitura como o servidor faz: linhas → classificação RFM → agregado sobre as MESMAS linhas canônicas.
function ler(linhas, asOf) {
  const analise = analisarRfm(linhas, { asOf, fuso: FUSO, chaveDoContexto: CHAVE_LOJA });
  const agregados = agregarClientesDePedidos(analise.linhas, { agora: asOf.getTime(), chaveDoContexto: CHAVE_LOJA });
  return { analise, agregados };
}
const rotulo = (a) => a.nome.replace(/^Sintético /, '').replace(/^Fundo /, '');
const rotulos = (agregados) => agregados.map(rotulo).sort();

// O filtro que o servidor persistiria ao salvar `segmento` em `asOfSalvo`.
function salvar(linhas, asOfSalvo, segmento) {
  const { analise } = ler(linhas, asOfSalvo);
  const seg = analise.rfm.segmentos.find((s) => s.id === segmento);
  return filtroRfmDoSegmento({ segmento, regraVersao: analise.rfm.regraVersao, classificadoEm: analise.rfm.asOf, predicado: seg.predicado });
}

// (a) matriz: quem a RFM classifica em `segmento` hoje; (b) Audiência exata; (c) filtros genéricos herdados (legado).
function tresLeituras(linhas, asOf, filtro) {
  const { analise, agregados } = ler(linhas, asOf);
  const seg = filtro.value.segmento;
  const matriz = analise.rfm.clientes.filter((c) => c.segmento.id === seg).map((c) => analise.classificacaoPorId.get(c.id).id);
  const matrizRotulos = analise.clientes.filter((c) => matriz.includes(c.id)).map((c) => c.nome.replace(/^Sintético /, '').replace(/^Fundo /, '')).sort();
  const exata = resolverPopulacaoRfm({ agregados, analise, filtro });
  // Legado: linhas cruas na ordem da consulta (criado_em DESC), sem deduplicar — como `buscarClientesAgregados` sempre leu.
  const cruas = [...linhas].sort((a, b) => new Date(b.criado_em) - new Date(a.criado_em));
  const legadoAgregados = agregarClientesDePedidos(cruas, { agora: asOf.getTime(), chaveDoContexto: CHAVE_LOJA });
  const filtros = filtrosDoPredicado(filtro.value.predicado);
  const legado = legadoAgregados.filter((c) => filtros.every((f) => avaliarFiltroNumerico(c, f)));
  return { analise, matriz: matrizRotulos, exata: rotulos(exata.membros), resumo: exata.resumo, legado: rotulos(legado) };
}

const so = (lista, prefixo) => lista.filter((r) => r.startsWith(prefixo));

// ── 1. Fronteiras de recência 45/90/180/365, nos dois lados do limite ───────────────────────────────
const FRONTEIRAS = [
  { limite: 45, dentro: 'novos', fora: 'aguardando_recompra' },
  { limite: 90, dentro: 'aguardando_recompra', fora: 'prestes_a_dormir' },
  { limite: 180, dentro: 'prestes_a_dormir', fora: 'hibernando' },
  { limite: 365, dentro: 'hibernando', fora: 'perdidos' },
];
for (const { limite, dentro, fora } of FRONTEIRAS) {
  test(`fronteira ${limite} dias: exatamente no limite fica em ${dentro}; um dia depois em ${fora} — Audiência exata = matriz`, () => {
    const dentroRef = `L${limite}-no-limite`;
    const foraRef = `L${limite}-um-dia-depois`;
    const linhas = [...fundo(ASOF_MEIO_DIA), linha({ ref: dentroRef, quando: diasAntes(ASOF_MEIO_DIA, limite) }), linha({ ref: foraRef, quando: diasAntes(ASOF_MEIO_DIA, limite + 1) })];
    const { analise } = ler(linhas, ASOF_MEIO_DIA);
    const seg = (ref) => analise.rfm.clientes.find((c) => analise.clientes.find((x) => x.id === c.id).nome === `Sintético ${ref}`).segmento.id;
    assert.equal(seg(dentroRef), dentro);
    assert.equal(seg(foraRef), fora);
    for (const alvo of [dentro, fora]) {
      const r = tresLeituras(linhas, ASOF_MEIO_DIA, salvar(linhas, ASOF_MEIO_DIA, alvo));
      assert.deepEqual(r.exata, r.matriz, `segmento ${alvo}`);
      assert.equal(r.resumo.universos.segmento, r.matriz.length);
    }
    const noSeg = tresLeituras(linhas, ASOF_MEIO_DIA, salvar(linhas, ASOF_MEIO_DIA, dentro));
    assert.ok(noSeg.exata.includes(dentroRef) && !noSeg.exata.includes(foraRef));
  });
}

// ── 2. Virada de dia: 23:59 e 00:01 locais, virada de mês e de ano ──────────────────────────────────
const VIRADAS = [
  { nome: 'virada de dia', asOf: new Date('2026-09-24T00:01:00-03:00'), compraRecente: '2026-09-23T23:59:00-03:00', compraR45: '2026-08-10T00:01:00-03:00', compraR46: '2026-08-09T23:59:00-03:00' },
  { nome: 'virada de mês (30/09 → 01/10)', asOf: new Date('2026-10-01T00:01:00-03:00'), compraRecente: '2026-09-30T23:59:00-03:00', compraR45: '2026-08-17T00:01:00-03:00', compraR46: '2026-08-16T23:59:00-03:00' },
  { nome: 'virada de ano (31/12 → 01/01)', asOf: new Date('2027-01-01T00:01:00-03:00'), compraRecente: '2026-12-31T23:59:00-03:00', compraR45: '2026-11-17T00:01:00-03:00', compraR46: '2026-11-16T23:59:00-03:00' },
];
for (const v of VIRADAS) {
  test(`${v.nome}: RFM conta dia de calendário local; o filtro genérico conta 24h — divergência exata em quem está em 45/46 dias`, () => {
    const linhas = [
      ...fundo(v.asOf),
      linha({ ref: 'V-recente', quando: local(v.compraRecente) }), // 2 minutos atrás, mas de "ontem"
      linha({ ref: 'V-45', quando: local(v.compraR45) }), //          45 dias e ~0 min: R = 45
      linha({ ref: 'V-46', quando: local(v.compraR46) }), //          45 dias e 2 min: RFM R = 46 (dia seguinte na faixa)
    ];
    const r = tresLeituras(linhas, v.asOf, salvar(linhas, v.asOf, 'novos'));
    const k = (ref) => r.analise.classificacaoPorId.get(r.analise.clientes.find((c) => c.nome === `Sintético ${ref}`).id);
    assert.equal(k('V-recente').r, 1, 'RFM: compra de ontem às 23:59 já é "1 dia" às 00:01');
    assert.equal(k('V-45').r, 45);
    assert.equal(k('V-46').r, 46);
    // Matriz = Audiência exata: V-recente e V-45 são Novos; V-46 já é Aguardando recompra.
    assert.deepEqual(so(r.exata, 'V-'), ['V-45', 'V-recente']);
    assert.deepEqual(r.exata, r.matriz);
    // Legado: 24h corridas colocam V-46 (45 dias + 2 min) DENTRO de "≤ 45 dias" — a divergência que a via exata elimina.
    assert.deepEqual(so(r.legado, 'V-'), ['V-45', 'V-46', 'V-recente']);
    assert.notDeepEqual(r.legado, r.exata);
    assert.deepEqual(r.legado.filter((x) => !r.exata.includes(x)), ['V-46']);
  });
}

// ── 3. Tipo/status do pedido: troca, cancelado, devolvido, reembolso — política ATUAL e seus riscos ──
const ASOF = ASOF_MEIO_DIA;
const recente = diasAntes(ASOF, 10);

test('troca paga: RFM exclui (fora do universo); o filtro genérico a conta como compra — só-troca entra no legado e não na Audiência exata', () => {
  const linhas = [
    ...fundo(ASOF),
    linha({ ref: 'T-so-troca', quando: recente, troca: true }),
    linha({ ref: 'T-normal-e-troca', quando: recente }), linha({ ref: 'T-normal-e-troca', quando: diasAntes(ASOF, 12), troca: true }),
  ];
  const r = tresLeituras(linhas, ASOF, salvar(linhas, ASOF, 'novos'));
  assert.ok(!r.exata.includes('T-so-troca'), 'só-troca não é comprador válido');
  assert.ok(r.legado.includes('T-so-troca'), 'legado: troca paga vale como compra');
  // Compra normal + troca: RFM vê 1 pedido (Novos); o legado vê 2 (quantidadePedidos ≤ 1 falha) e o exclui de Novos.
  assert.ok(r.exata.includes('T-normal-e-troca'));
  assert.ok(!r.legado.includes('T-normal-e-troca'));
  assert.deepEqual(r.exata, r.matriz);
});

test('quem só tem pedido cancelado NUNCA é "Perdidos": o filtro genérico o incluiria ("nunca comprou" casa com "há mais de N dias"), a Audiência exata não', () => {
  const linhas = [...fundo(ASOF), linha({ ref: 'SO-CANCELADO', quando: recente, pay: 'canceled' })];
  const r = tresLeituras(linhas, ASOF, salvar(linhas, ASOF, 'perdidos'));
  assert.ok(r.legado.includes('SO-CANCELADO'), 'legado: diasSemComprar nulo casa com "gte 366"');
  assert.ok(!r.exata.includes('SO-CANCELADO') && !r.matriz.includes('SO-CANCELADO'), 'exata = matriz: não é comprador válido');
  assert.deepEqual(r.exata, r.matriz);
});

const STATUS = [
  { ref: 'S-pago-pedido-cancelado', pay: 'paid', order: 'canceled', rfm: true, legado: true, nota: 'RISCO: pagamento válido com pedido encerrado conta como compra (decisão pendente com o número real)' },
  { ref: 'S-pago-pedido-devolvido', pay: 'paid', order: 'returned', rfm: true, legado: true, nota: 'RISCO: idem, devolvido' },
  { ref: 'S-pago-pedido-reembolsado', pay: 'paid', order: 'refunded', rfm: true, legado: true, nota: 'RISCO: idem, reembolsado por status de pedido' },
  { ref: 'S-pagamento-reembolsado', pay: 'refunded', order: 'sent', rfm: false, legado: false, nota: 'reembolso total por status de pagamento: fora dos dois' },
  { ref: 'S-pagamento-cancelado', pay: 'canceled', order: 'canceled', rfm: false, legado: false, nota: 'cancelado: fora dos dois' },
  { ref: 'S-pagamento-pendente', pay: 'pending', order: 'created', rfm: false, legado: false, nota: 'pendente: fora dos dois' },
  { ref: 'S-reembolso-parcial-sem-dado', pay: 'partially_refunded', order: 'sent', rfm: false, legado: false, nota: 'reembolso parcial: o cache não guarda o valor; não se infere — a pessoa some dos dois' },
  { ref: 'S-gratuito', pay: 'free', order: 'sent', rfm: true, legado: true, valor: 0, nota: 'pedido zerado (free) é compra válida com valor 0' },
];
for (const c of STATUS) {
  test(`status ${c.pay}/${c.order}: RFM ${c.rfm ? 'inclui' : 'exclui'}, legado ${c.legado ? 'inclui' : 'exclui'} — ${c.nota}`, () => {
    const linhas = [...fundo(ASOF), linha({ ref: c.ref, quando: recente, pay: c.pay, order: c.order, valor: c.valor ?? 40 })];
    const r = tresLeituras(linhas, ASOF, salvar(linhas, ASOF, 'novos'));
    assert.equal(r.exata.includes(c.ref), c.rfm, 'Audiência exata');
    assert.equal(r.matriz.includes(c.ref), c.rfm, 'matriz');
    assert.equal(r.legado.includes(c.ref), c.legado, 'legado');
  });
}

test('frete e desconto: o valor de compra é `total_value` (já líquido) nas duas contas; frete/desconto separados não entram', () => {
  const linhas = [...fundo(ASOF), linha({ ref: 'FD', quando: recente, valor: 60, frete: 10, descontos: 5 })];
  const { analise, agregados } = ler(linhas, ASOF);
  const c = analise.rfm.clientes.find((x) => analise.clientes.find((y) => y.id === x.id).nome === 'Sintético FD');
  assert.equal(c.m, 60);
  assert.equal(agregados.find((a) => a.nome === 'Sintético FD').totalGasto, 60);
});

// ── 4. Duplicidade, mesmo dia e identidade compartilhada ────────────────────────────────────────────
test('duas compras no mesmo dia contam como dois pedidos (Potenciais leais); mesma leitura na matriz, na Audiência e no legado', () => {
  const linhas = [...fundo(ASOF), linha({ ref: 'D2', quando: diasAntes(ASOF, 5, '09:00:00') }), linha({ ref: 'D2', quando: diasAntes(ASOF, 5, '18:00:00') })];
  const r = tresLeituras(linhas, ASOF, salvar(linhas, ASOF, 'potenciais_leais'));
  assert.ok(r.exata.includes('D2') && r.legado.includes('D2'));
  assert.deepEqual(r.exata, r.matriz);
});

test('pedido duplicado (mesmo ink_order_id em duas linhas): a RFM e a Audiência exata contam UM; o legado sobre linhas cruas contaria dois', () => {
  const dup = linha({ ref: 'DUP', quando: recente, id: 777001 });
  const linhas = [...fundo(ASOF), dup, { ...dup, loja: 'sul' }];
  const r = tresLeituras(linhas, ASOF, salvar(linhas, ASOF, 'novos'));
  assert.ok(r.exata.includes('DUP'), 'exata: 1 pedido → Novos');
  assert.ok(!r.legado.includes('DUP'), 'legado cru: 2 pedidos → fora de Novos (quantidadePedidos ≤ 1 falha)');
  assert.equal(ler(linhas, ASOF).agregados.find((a) => a.nome === 'Sintético DUP').totalCompras, 1, 'o agregado da via exata já usa as linhas deduplicadas');
  assert.deepEqual(r.exata, r.matriz);
});

test('chaves de identidade compartilhadas (documento, telefone, e-mail — transitivo) viram UMA pessoa, com F somado', () => {
  const linhas = [
    ...fundo(ASOF),
    linha({ ref: 'ID', doc: 'DOC-ID-A', quando: diasAntes(ASOF, 3) }),
    linha({ ref: 'ID', doc: null, tel: '51900000001', quando: diasAntes(ASOF, 6) }),
    linha({ ref: 'ID', doc: 'DOC-ID-A', tel: '51900000001', quando: diasAntes(ASOF, 9) }),
    linha({ ref: 'ID', doc: null, tel: '51900000002', email: 'id@sintetico.invalid', quando: diasAntes(ASOF, 12) }),
    linha({ ref: 'ID', doc: null, tel: '51900000003', email: 'id@sintetico.invalid', quando: diasAntes(ASOF, 15) }),
    linha({ ref: 'ID', doc: 'DOC-ID-A', email: 'id@sintetico.invalid', quando: diasAntes(ASOF, 18) }), // liga o grupo de e-mail ao de documento
  ];
  const { analise, agregados } = ler(linhas, ASOF);
  const pessoa = agregados.filter((a) => a.nome === 'Sintético ID');
  assert.equal(pessoa.length, 1, 'uma pessoa só');
  assert.equal(pessoa[0].totalCompras, 6);
  const k = analise.classificacaoPorId.get(analise.clientes.find((c) => c.nome === 'Sintético ID').id);
  assert.equal(k.fJanela, 6);
  const r = tresLeituras(linhas, ASOF, salvar(linhas, ASOF, k.segmento.id));
  assert.ok(r.exata.includes('ID'));
  assert.deepEqual(r.exata, r.matriz);
});

test('identidade que coincide entre lojas/organizações não se funde: mesmo documento em duas lojas = duas pessoas', () => {
  const linhas = [
    ...fundo(ASOF),
    linha({ ref: 'X', doc: 'DOC-COMUM', quando: recente, loja: 'sul' }),
    linha({ ref: 'X', doc: 'DOC-COMUM', quando: recente, loja: 'centro', nome: 'Sintético X-centro' }),
  ];
  const { analise, agregados } = ler(linhas, ASOF);
  assert.equal(agregados.filter((a) => a.documento === 'DOC-COMUM').length, 2);
  assert.equal(analise.clientes.filter((c) => c.documento === 'DOC-COMUM').length, 2);
});

// ── 5. Número de compras, valor no limite e segmento vazio ──────────────────────────────────────────
test('0, 1, 2, 3 e 5+ compras e valor no limite do P75: cada pessoa cai no segmento da tabela e a Audiência exata devolve o mesmo conjunto', () => {
  const linhas = [
    ...fundo(ASOF),
    linha({ ref: 'N0', quando: recente, pay: 'canceled' }), // 0 compras válidas
    linha({ ref: 'N1', quando: recente, valor: 49.99 }), //     1 compra, um centavo abaixo do corte
    linha({ ref: 'N1-limite', quando: recente, valor: 50 }), //  1 compra exatamente no corte (P75 = 50) → valor ALTO
    ...[2, 4, 6].map((d) => linha({ ref: 'N3', quando: diasAntes(ASOF, d), valor: 20 })), // 3 compras, soma 60 ≥ 50
    ...[1, 2, 3, 4, 5].map((d) => linha({ ref: 'N5', quando: diasAntes(ASOF, d), valor: 5 })), // 5 compras, soma 25 < 50
    ...[7, 8].map((d) => linha({ ref: 'N2', quando: diasAntes(ASOF, d), valor: 20 })),
  ];
  const { analise } = ler(linhas, ASOF);
  assert.equal(analise.rfm.valorAlto, 50, 'pré-condição: o corte P75 dos valores da janela é 50');
  const segDe = (ref) => analise.classificacaoPorId.get(analise.clientes.find((c) => c.nome === `Sintético ${ref}`).id)?.segmento.id;
  assert.equal(segDe('N0'), undefined, '0 compras válidas: fora do universo');
  assert.equal(segDe('N1'), 'novos');
  assert.equal(segDe('N1-limite'), 'primeira_alto_valor', 'valor exatamente no corte é alto (≥)');
  assert.equal(segDe('N2'), 'potenciais_leais');
  assert.equal(segDe('N3'), 'campeoes');
  assert.equal(segDe('N5'), 'leais');
  for (const seg of REGRAS.map((x) => x.id)) {
    const r = tresLeituras(linhas, ASOF, salvar(linhas, ASOF, seg));
    assert.deepEqual(r.exata, r.matriz, `segmento ${seg}`);
    assert.equal(r.resumo.universos.segmento, r.matriz.length);
  }
});

test('segmento com 0 compradores: a Audiência exata devolve conjunto vazio (sem erro, sem cair para "todos")', () => {
  const linhas = fundo(ASOF); // todos entre 100 e 217 dias, uma compra: Campeões não existe
  const filtro = salvar(linhas, ASOF, 'campeoes');
  const { analise, agregados } = ler(linhas, ASOF);
  const r = resolverPopulacaoRfm({ agregados, analise, filtro });
  assert.deepEqual(r.membros, []);
  assert.equal(r.resumo.universos.segmento, 0);
  assert.equal(r.resumo.universos.compradoresValidos, 40);
});

// ── 6. P75 muda sem o hash da configuração mudar: o segmento salvo é imutável ──────────────────────
test('P75 sobe com pedidos novos e a regraVersao NÃO muda: o corte salvo continua valendo, a divergência é declarada e o filtro salvo não é reescrito', () => {
  const t0 = ASOF;
  const base = [...fundo(t0), linha({ ref: 'P-alto', quando: diasAntes(t0, 8), valor: 55 }), linha({ ref: 'P-baixo', quando: diasAntes(t0, 8), valor: 40 })];
  const salvoNovos = salvar(base, t0, 'novos');
  const salvoAlto = salvar(base, t0, 'primeira_alto_valor');
  const copia = JSON.stringify([salvoNovos, salvoAlto]);
  assert.equal(salvoNovos.value.predicado.valor.maxExclusivo, 50);

  const t1 = new Date(t0.getTime() + 10 * 86400000);
  const novos = Array.from({ length: 30 }, (_, i) => linha({ ref: `P-novo${i}`, quando: diasAntes(t1, 3), valor: 200 }));
  const linhas = [...base, ...novos];
  const { analise, agregados } = ler(linhas, t1);
  assert.equal(analise.rfm.regraVersao, salvoNovos.value.regraVersao, 'o hash cobre a configuração, não o corte');
  assert.ok(analise.rfm.valorAlto > 50, `o P75 de hoje subiu (${analise.rfm.valorAlto})`);

  const rNovos = resolverPopulacaoRfm({ agregados, analise, filtro: salvoNovos });
  assert.equal(rNovos.resumo.divergente, true);
  assert.equal(rNovos.resumo.corteSalvo.valor, 50);
  assert.equal(rNovos.resumo.corteAtual.valor, analise.rfm.valorAlto);
  // Corte SALVO (50): P-alto (55) continua "valor alto" e NÃO é Novos; P-baixo (40) é Novos. Pelo corte de hoje (>50), P-alto seria Novos.
  assert.ok(!rotulos(rNovos.membros).includes('P-alto') && rotulos(rNovos.membros).includes('P-baixo'));
  assert.ok(rNovos.resumo.pessoasNoSegmentoDeHoje > rNovos.membros.length - 0, 'o segmento "Novos" de hoje tem mais gente que o salvo');
  const rAlto = resolverPopulacaoRfm({ agregados, analise, filtro: salvoAlto });
  assert.ok(rotulos(rAlto.membros).includes('P-alto'), 'o segmento salvo de valor alto segue com o corte salvo');
  assert.equal(JSON.stringify([salvoNovos, salvoAlto]), copia, 'resolver não altera o filtro salvo');
});

test('só o tempo passando (sem pedidos novos) não move o corte: o corte salvo continua igual ao de hoje; a recência avança', () => {
  const linhas = [...fundo(ASOF), linha({ ref: 'TP', quando: diasAntes(ASOF, 40), valor: 40 })];
  const filtro = salvar(linhas, ASOF, 'novos');
  const depois = new Date(ASOF.getTime() + 10 * 86400000);
  const { analise, agregados } = ler(linhas, depois);
  const r = resolverPopulacaoRfm({ agregados, analise, filtro });
  assert.equal(r.resumo.divergente, false);
  assert.ok(!rotulos(r.membros).includes('TP'), 'TP tem 50 dias hoje: já não é Novos (a recência é reavaliada a cada uso)');
});

// ── 7. Erros nunca degradam para "todos os clientes" ────────────────────────────────────────────────
const VALIDO = () => salvar([...fundo(ASOF)], ASOF, 'hibernando');
const INVALIDOS = [
  ['nulo', () => null], ['sem value', () => ({ field: 'rfm', op: 'segmento' })], ['operador errado', () => ({ ...VALIDO(), op: 'gte' })],
  ['segmento desconhecido', () => ({ ...VALIDO(), value: { ...VALIDO().value, segmento: 'todos' } })],
  ['regraVersao vazia', () => ({ ...VALIDO(), value: { ...VALIDO().value, regraVersao: '' } })],
  ['sem predicado', () => ({ ...VALIDO(), value: { ...VALIDO().value, predicado: undefined } })],
  ['recência negativa', () => ({ ...VALIDO(), value: { ...VALIDO().value, predicado: { ...VALIDO().value.predicado, recenciaDias: { min: -1, max: 10 } } } })],
  ['recência max < min', () => ({ ...VALIDO(), value: { ...VALIDO().value, predicado: { ...VALIDO().value.predicado, recenciaDias: { min: 10, max: 5 } } } })],
  ['métrica de valor desconhecida', () => ({ ...VALIDO(), value: { ...VALIDO().value, predicado: { ...VALIDO().value.predicado, valor: { metrica: 'x', min: 1, maxExclusivo: null } } } })],
  ['campo desconhecido no valor', () => ({ ...VALIDO(), value: { ...VALIDO().value, extra: true } })],
  ['data de classificação inválida', () => ({ ...VALIDO(), value: { ...VALIDO().value, classificadoEm: 'ontem' } })],
];
for (const [nome, fabricar] of INVALIDOS) {
  test(`filtro RFM inválido (${nome}) lança RFM_FILTRO_INVALIDO`, () => {
    assert.throws(() => validarFiltroRfm(fabricar()), (e) => e instanceof ErroAudienciaRfm && e.codigo === 'RFM_FILTRO_INVALIDO' && e.status === 409);
    // via separarFiltros também: o filtro com `field: rfm` defeituoso não "some" da lista
    if (fabricar() != null) assert.throws(() => separarFiltros([{ ...fabricar(), field: 'rfm' }]), ErroAudienciaRfm);
  });
}

test('mais de um filtro RFM na mesma audiência é erro (nunca "o primeiro vence")', () => {
  assert.throws(() => separarFiltros([VALIDO(), VALIDO()]), (e) => e.codigo === 'RFM_FILTRO_INVALIDO');
});

test('o filtro RFM é sempre separado das demais condições (obrigatório, mesmo com match ANY)', () => {
  const outro = { field: 'uf', op: 'eq', value: 'RS' };
  const { rfm, demais } = separarFiltros([outro, VALIDO()]);
  assert.equal(rfm.field, 'rfm');
  assert.deepEqual(demais, [outro]);
  assert.deepEqual(separarFiltros([outro]).rfm, null, 'sem segmento RFM, o caminho genérico segue exatamente como antes');
});

test('regra que mudou desde que o segmento foi salvo → RFM_REGRA_DIVERGENTE (não avalia com outra regra)', () => {
  const linhas = fundo(ASOF);
  const filtro = salvar(linhas, ASOF, 'hibernando');
  filtro.value.regraVersao = 'rfm-v1:00000000';
  const { analise, agregados } = ler(linhas, ASOF);
  assert.throws(() => resolverPopulacaoRfm({ agregados, analise, filtro }), (e) => e.codigo === 'RFM_REGRA_DIVERGENTE');
});

test('base insuficiente hoje → RFM_AMOSTRA_INSUFICIENTE (não classifica nem devolve "todos")', () => {
  const linhas = fundo(ASOF);
  const filtro = salvar(linhas, ASOF, 'hibernando');
  const poucas = linhas.slice(0, 5);
  const { analise, agregados } = ler(poucas, ASOF);
  assert.equal(analise.rfm.amostraSuficiente, false);
  assert.throws(() => resolverPopulacaoRfm({ agregados, analise, filtro }), (e) => e.codigo === 'RFM_AMOSTRA_INSUFICIENTE');
});

test('junção inconsistente entre a RFM e o cadastro → RFM_JUNCAO_INCONSISTENTE (nunca omite gente em silêncio)', () => {
  const linhas = fundo(ASOF);
  const filtro = salvar(linhas, ASOF, 'hibernando');
  const { analise, agregados } = ler(linhas, ASOF);
  assert.throws(() => resolverPopulacaoRfm({ agregados: agregados.slice(1), analise, filtro }), (e) => e.codigo === 'RFM_JUNCAO_INCONSISTENTE');
});

// ── 8. Detector: o teste de equivalência REPROVA quando uma divergência é introduzida ───────────────
test('detector: um predicado com o limite de recência deslocado em 1 dia deixa de coincidir com a matriz (e o teste percebe)', () => {
  const linhas = [...fundo(ASOF), linha({ ref: 'DET-45', quando: diasAntes(ASOF, 45) })];
  const bom = salvar(linhas, ASOF, 'novos');
  const ruim = JSON.parse(JSON.stringify(bom));
  ruim.value.predicado.recenciaDias.max -= 1; // defeito deliberado: `≤ 45` vira `≤ 44`
  const { analise, agregados } = ler(linhas, ASOF);
  const matriz = analise.rfm.clientes.filter((c) => c.segmento.id === 'novos').length;
  assert.equal(resolverPopulacaoRfm({ agregados, analise, filtro: bom }).membros.length, matriz);
  assert.notEqual(resolverPopulacaoRfm({ agregados, analise, filtro: ruim }).membros.length, matriz);
});

// ── 9. Equivalência global: TODOS os segmentos, população completa, mesmo asOf ──────────────────────
test('matriz × Audiência exata: para cada um dos 11 segmentos o conjunto de pessoas é IDÊNTICO (universo: pessoas com pedido ⊃ compradores válidos ⊃ segmento)', () => {
  const linhas = [
    ...fundo(ASOF),
    ...[3, 20, 44, 46, 80, 91, 179, 181, 364, 366, 500].map((d, i) => linha({ ref: `G1-${i}`, quando: diasAntes(ASOF, d), valor: i % 2 ? 90 : 30 })),
    ...[2, 25, 60, 120, 250].flatMap((d, i) => [linha({ ref: `G2-${i}`, quando: diasAntes(ASOF, d), valor: 70 }), linha({ ref: `G2-${i}`, quando: diasAntes(ASOF, d + 30), valor: 20 })]),
    ...[1, 15].flatMap((d, i) => [1, 2, 3].map((k) => linha({ ref: `G3-${i}`, quando: diasAntes(ASOF, d * k), valor: 300 }))),
    linha({ ref: 'G-troca', quando: recente, troca: true }), linha({ ref: 'G-cancelado', quando: recente, pay: 'canceled' }),
  ];
  const { analise, agregados } = ler(linhas, ASOF);
  let somaSegmentos = 0;
  for (const regra of REGRAS) {
    const filtro = salvar(linhas, ASOF, regra.id);
    const r = tresLeituras(linhas, ASOF, filtro);
    assert.deepEqual(r.exata, r.matriz, `segmento ${regra.id}`);
    assert.equal(r.resumo.pessoasNoSegmentoDeHoje, r.matriz.length, `contagem do segmento de hoje = população da Audiência (${regra.id})`);
    assert.equal(r.resumo.divergente, false, `sem mudança de base, corte salvo = corte de hoje (${regra.id})`);
    somaSegmentos += r.exata.length;
  }
  assert.equal(somaSegmentos, analise.rfm.universo, 'os 11 segmentos particionam os compradores válidos');
  assert.ok(agregados.length > analise.rfm.universo, 'há pessoas com pedido que não são compradores válidos (só-troca, cancelado)');
});

test('casaPredicado é o mesmo avaliador da matriz: nenhuma pessoa casa com dois segmentos', () => {
  const linhas = [...fundo(ASOF), linha({ ref: 'U1', quando: recente })];
  const { analise } = ler(linhas, ASOF);
  const segmentos = analise.rfm.segmentos.filter((s) => s.predicado);
  for (const k of analise.rfm.clientes) {
    const casam = segmentos.filter((s) => casaPredicado(s.predicado, k.r, k.f, k.v)).map((s) => s.id);
    assert.deepEqual(casam, [k.segmento.id]);
  }
});
