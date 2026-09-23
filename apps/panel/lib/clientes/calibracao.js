'use strict';

// Calibração da RFM: relatório AGREGADO e ANONIMIZADO sobre as linhas de `pedidos_ink`. Função pura (sem banco, relógio
// ou rede): quem chama lê as linhas com escopo de Organization/Store, em transação somente-leitura
// (scripts/clientes/rfm-calibracao.mjs), e passa `asOf`.
//
// O que NUNCA sai daqui: nome, e-mail, telefone, documento ou qualquer identificador reversível. Só contagens, quantis,
// somas, percentuais e amostras "limítrofes" identificadas por um rótulo opaco aleatório (`ref`), com R/F/M e segmento.
//
// O objetivo não é escolher limiares para deixar a matriz "bonita", e sim mostrar, com número, (1) se os dados estão
// íntegros, (2) como a regra atual distribui a base e quão estável ela é perto dos cortes, (3) o que as alternativas
// mudam, e (4) o que o próprio comportamento de recompra da loja sugere — ou o aviso de que a amostra não permite concluir.

const crypto = require('node:crypto');
const { agruparClientes, deduplicarPedidos, compararPedidosRecentesPrimeiro, pedidoDaLinha, coberturaDe } = require('./analise');
const { classificarRfm, pedidoValido, diasDeCalendario, configuracaoEfetiva, regraVersao, PADROES } = require('./rfm');

const FUSO_PADRAO = 'America/Sao_Paulo';
const QUANTIS = Object.freeze([0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]);
// Enum documentado de `payment_status` da Ink (documentacao-api-ink.yaml) + rótulos em português já normalizados pelo painel.
const PAGAMENTOS_CONHECIDOS = new Set([
  'pending', 'paid', 'succeeded', 'waiting_payment', 'awaiting_analysis', 'free', 'refund_requested', 'refunded', 'canceled',
  'failed', 'expired', 'not_authorized', 'dispute', 'chargeback',
]);
// `order_status` que indicam pedido encerrado sem venda concluída. Se aparecerem em pedido com pagamento "válido", os
// indicadores podem estar inflados: o relatório conta e mostra, e a decisão fica com o usuário (não é aplicada sozinha).
const PEDIDOS_ENCERRADOS = new Set(['canceled', 'refunded', 'refund_requested', 'returned', 'return_started', 'payment_refused', 'expired']);
const MINIMO_INTERVALOS = 30;
const MINIMO_COORTE = 30;

const arredonda = (v, casas = 2) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** casas) / 10 ** casas);

// Quantil por posição (nearest-rank), sobre valores em qualquer ordem.
function quantis(valores, ps = QUANTIS) {
  if (!valores.length) return null;
  const o = [...valores].sort((a, b) => a - b);
  const q = {};
  for (const p of ps) q[`p${Math.round(p * 100)}`] = o[Math.min(o.length - 1, Math.max(0, Math.ceil(p * o.length) - 1))];
  return { n: o.length, min: o[0], ...q, max: o[o.length - 1], media: arredonda(o.reduce((a, v) => a + v, 0) / o.length) };
}

const contagem = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
const pct = (n, d) => (d ? arredonda((n / d) * 100, 1) : null);

// ── 1. Integridade das linhas lidas ─────────────────────────────────────────────────────────────────
function auditarLinhas(linhas) {
  const unicos = new Set();
  let duplicadas = 0;
  let semData = 0; let semValor = 0; let valorNegativo = 0; let valorZero = 0; let semIdentidade = 0; let semStatus = 0;
  const pagamento = {}; const cruzado = {}; const desconhecidos = {}; const porMes = {};
  let pagoComPedidoEncerrado = 0; let pagoComPedidoEncerradoValor = 0;
  let primeira = null; let ultima = null;
  for (const r of linhas) {
    if (r.ink_order_id != null) { const k = String(r.ink_order_id); if (unicos.has(k)) duplicadas += 1; else unicos.add(k); }
    const t = r.criado_em ? new Date(r.criado_em).getTime() : NaN;
    if (!Number.isFinite(t)) semData += 1; else {
      if (primeira == null || t < primeira) primeira = t;
      if (ultima == null || t > ultima) ultima = t;
      const mes = new Date(t).toISOString().slice(0, 7);
      porMes[mes] = (porMes[mes] || 0) + 1;
    }
    const v = r.total_value == null ? null : Number(r.total_value);
    if (v == null || !Number.isFinite(v)) semValor += 1; else if (v < 0) valorNegativo += 1; else if (v === 0) valorZero += 1;
    if (!(r.buyer_documento || r.buyer_telefone || r.buyer_email)) semIdentidade += 1;
    const ps = r.payment_status == null || r.payment_status === '' ? '(vazio)' : String(r.payment_status);
    if (ps === '(vazio)') semStatus += 1;
    pagamento[ps] = (pagamento[ps] || 0) + 1;
    const os = r.order_status == null || r.order_status === '' ? '(vazio)' : String(r.order_status);
    const k = `${ps} × ${os}`;
    cruzado[k] = (cruzado[k] || 0) + 1;
    if (ps !== '(vazio)' && !PAGAMENTOS_CONHECIDOS.has(ps)) desconhecidos[ps] = (desconhecidos[ps] || 0) + 1;
    if (pedidoValido(pedidoDaLinha(r)) && PEDIDOS_ENCERRADOS.has(os)) { pagoComPedidoEncerrado += 1; pagoComPedidoEncerradoValor += v || 0; }
  }
  return {
    linhas: linhas.length,
    pedidosDistintos: unicos.size,
    linhasDuplicadasPorInkOrderId: duplicadas,
    semData, semValor, valorNegativo, valorZero, semIdentidade, semStatusDePagamento: semStatus,
    primeiroPedidoEm: primeira == null ? null : new Date(primeira).toISOString(),
    ultimoPedidoEm: ultima == null ? null : new Date(ultima).toISOString(),
    statusDePagamento: pagamento,
    statusDePagamentoNaoReconhecidos: desconhecidos,
    statusPagamentoXPedido: Object.fromEntries(Object.entries(cruzado).sort((a, b) => b[1] - a[1])),
    // Pagamento "válido" mas pedido encerrado (cancelado/reembolsado/devolvido): ver nota no cabeçalho deste arquivo.
    pagamentoValidoComPedidoEncerrado: { pedidos: pagoComPedidoEncerrado, valor: arredonda(pagoComPedidoEncerradoValor) },
    pedidosPorMes: Object.fromEntries(Object.entries(porMes).sort()),
    moeda: 'A Ink não informa moeda no pedido; o painel assume BRL. Não há conversão.',
  };
}

// ── 2. Distribuições (base classificada) ────────────────────────────────────────────────────────────
function distribuicoes(rfm, clientesAgrupados) {
  const cs = rfm.clientes;
  const validosPorId = new Map(clientesAgrupados.map((c) => [c.id, c.pedidos.filter(pedidoValido)]));
  const f = cs.map((c) => c.fVida);
  const umaCompra = f.filter((x) => x === 1).length;
  const faixas = { '1': 0, '2': 0, '3': 0, '4': 0, '5+': 0 };
  for (const x of f) faixas[x >= 5 ? '5+' : String(x)] += 1;
  const ticketsPorPedido = [];
  for (const c of cs) for (const p of validosPorId.get(c.id) || []) ticketsPorPedido.push(Number(p.valor));
  const so1 = cs.filter((c) => c.fVida === 1); const rec = cs.filter((c) => c.fVida >= 2);
  return {
    universo: cs.length,
    recenciaDias: quantis(cs.map((c) => c.r)),
    frequencia: { distribuicao: faixas, quantis: quantis(f), clientesDeUmaCompra: umaCompra, pctClientesDeUmaCompra: pct(umaCompra, cs.length) },
    valorLtv: quantis(cs.map((c) => c.ltv)),
    valorNaJanela: quantis(cs.map((c) => c.m)),
    ticketPorPedido: quantis(ticketsPorPedido),
    ticketMedioPorCliente: quantis(cs.map((c) => (c.fVida ? c.ltv / c.fVida : 0))),
    recenciaDiasUmaCompra: quantis(so1.map((c) => c.r)),
    recenciaDiasRecorrentes: quantis(rec.map((c) => c.r)),
    ltvUmaCompra: quantis(so1.map((c) => c.ltv)),
    ltvRecorrentes: quantis(rec.map((c) => c.ltv)),
    // Concentração de receita: quanto do total vem dos 10% / 20% de maior LTV.
    concentracaoDeReceita: (() => {
      const o = cs.map((c) => c.ltv).sort((a, b) => b - a);
      const total = o.reduce((a, v) => a + v, 0);
      const topo = (p) => arredonda((o.slice(0, Math.max(1, Math.ceil(o.length * p))).reduce((a, v) => a + v, 0) / (total || 1)) * 100, 1);
      return { top10pct: topo(0.1), top20pct: topo(0.2) };
    })(),
  };
}

function tabelaDeSegmentos(rfm) {
  return rfm.segmentos.map((s) => ({
    id: s.id, nome: s.nome, clientes: s.clientes, pctBase: pct(s.clientes, rfm.universo), pedidos: s.pedidos, receita: s.receita,
    pctReceita: arredonda(s.pctReceita * 100, 1), ticketMedio: s.ticketMedio, recenciaMedianaDias: s.recenciaMedianaDias, frequenciaMediana: s.frequenciaMediana,
  }));
}

// ── 3. O que a própria loja sugere sobre recompra ────────────────────────────────────────────────────
// Intervalo entre compras consecutivas de quem comprou 2+ vezes, e "quantos dos que fizeram a 1ª compra há X+ dias já
// compraram de novo em até Y dias". Só conclui com amostra mínima; abaixo disso devolve `null` e o motivo.
function comportamentoDeRecompra(clientesAgrupados, asOf, fuso) {
  const intervalos = [];
  const segundaCompraEm = { 30: [0, 0], 60: [0, 0], 90: [0, 0], 180: [0, 0] }; // [elegíveis, recompraram]
  let coorteCom2 = 0;
  for (const c of clientesAgrupados) {
    const ts = c.pedidos.filter(pedidoValido).map((p) => new Date(p.criadoEm).getTime()).filter((t) => t <= asOf.getTime()).sort((a, b) => a - b);
    if (!ts.length) continue;
    for (let i = 1; i < ts.length; i += 1) intervalos.push(diasDeCalendario(new Date(ts[i - 1]), new Date(ts[i]), fuso));
    const idade = diasDeCalendario(new Date(ts[0]), asOf, fuso);
    for (const janela of Object.keys(segundaCompraEm)) {
      if (idade < Number(janela)) continue; // ainda não deu tempo de recomprar: fora do denominador (evita viés de censura)
      segundaCompraEm[janela][0] += 1;
      if (ts.length >= 2 && diasDeCalendario(new Date(ts[0]), new Date(ts[1]), fuso) <= Number(janela)) segundaCompraEm[janela][1] += 1;
    }
    if (ts.length >= 2) coorteCom2 += 1;
  }
  const q = intervalos.length >= MINIMO_INTERVALOS ? quantis(intervalos, [0.25, 0.5, 0.75, 0.9]) : null;
  return {
    intervalosEntreCompras: q,
    intervalosObservados: intervalos.length,
    clientesComDuasOuMaisCompras: coorteCom2,
    avisoIntervalos: q ? null : `Só ${intervalos.length} intervalo(s) observados (mínimo ${MINIMO_INTERVALOS}): não há amostra para derivar cortes de recência do comportamento de recompra.`,
    segundaCompraAte: Object.fromEntries(Object.entries(segundaCompraEm).map(([j, [el, ok]]) => [`${j}d`, {
      elegiveis: el, recompraram: ok, pct: el >= MINIMO_COORTE ? pct(ok, el) : null,
      aviso: el >= MINIMO_COORTE ? null : `coorte de ${el} (mínimo ${MINIMO_COORTE})`,
    }])),
  };
}

// ── 4. Estabilidade da regra atual e comparação com alternativas ─────────────────────────────────────
function estabilidade(rfm, margemDias = 3, margemValorPct = 5) {
  const cortes = rfm.limitesRecenciaDias;
  const universo = rfm.universo || 1;
  const porCorte = cortes.map((corte) => {
    const perto = rfm.clientes.filter((c) => Math.abs(c.r - corte) <= margemDias || Math.abs(c.r - (corte + 1)) <= margemDias).length;
    return { corteDias: corte, clientesAte3DiasDoCorte: perto, pct: pct(perto, universo) };
  });
  const alto = rfm.valorAlto;
  const pertoValor = alto == null ? null : rfm.clientes.filter((c) => c.v > 0 && Math.abs(c.v - alto) <= (alto * margemValorPct) / 100).length;
  const todos = new Set();
  for (const corte of cortes) for (const c of rfm.clientes) if (Math.abs(c.r - corte) <= margemDias || Math.abs(c.r - (corte + 1)) <= margemDias) todos.add(c.id);
  return {
    margemDias, margemValorPct,
    porCorteDeRecencia: porCorte,
    valorAlto: alto == null ? null : { corte: alto, metrica: rfm.valorAltoMetrica, clientesAte5PctDoCorte: pertoValor, pct: pct(pertoValor, universo) },
    clientesPertoDeAlgumCorteDeRecencia: { n: todos.size, pct: pct(todos.size, universo) },
    leitura: 'Quanto maior o % perto de um corte, mais a classificação de um cliente muda por poucos dias (ou reais) de diferença.',
  };
}

function compararComAtual(atual, alternativa) {
  const daAtual = new Map(atual.clientes.map((c) => [c.id, c.segmento.id]));
  const movimento = {};
  let mudaram = 0;
  for (const c of alternativa.clientes) {
    const de = daAtual.get(c.id);
    if (de !== c.segmento.id) { mudaram += 1; const k = `${de} → ${c.segmento.id}`; movimento[k] = (movimento[k] || 0) + 1; }
  }
  return {
    clientesQueMudaramDeSegmento: mudaram,
    pctDaBase: pct(mudaram, atual.universo),
    movimentos: Object.fromEntries(Object.entries(movimento).sort((a, b) => b[1] - a[1]).slice(0, 15)),
  };
}

// Alternativas padrão, todas variações de UM parâmetro por vez, para o efeito de cada uma ser isolável. NÃO são
// recomendações: são o conjunto a comparar contra os números reais.
const ALTERNATIVAS_PADRAO = Object.freeze([
  { nome: 'atual (rfm-v1)', config: {} },
  { nome: 'recência mais curta 30/60/120/270', config: { limitesRecenciaDias: [30, 60, 120, 270] } },
  { nome: 'recência mais longa 60/120/240/365', config: { limitesRecenciaDias: [60, 120, 240, 365] } },
  { nome: 'valor alto = P80 da soma', config: { percentilValorAlto: 0.8 } },
  { nome: 'valor alto = P90 da soma', config: { percentilValorAlto: 0.9 } },
  { nome: 'valor alto = P75 do ticket médio', config: { valorAltoMetrica: 'ticket_medio' } },
  { nome: 'valor alto = P90 do ticket médio', config: { valorAltoMetrica: 'ticket_medio', percentilValorAlto: 0.9 } },
  { nome: 'janela de frequência 180 dias', config: { janelaFrequenciaDias: 180 } },
]);

function amostrasLimitrofes(rfm, alternativa, porCorte = 4) {
  const salt = crypto.randomBytes(8).toString('hex'); // rótulo opaco, diferente a cada execução
  const ref = (id) => `c_${crypto.createHash('sha256').update(`${salt}:${id}`).digest('hex').slice(0, 8)}`;
  const amostras = [];
  for (const corte of rfm.limitesRecenciaDias) {
    const perto = rfm.clientes
      .filter((c) => c.r === corte || c.r === corte + 1)
      .sort((a, b) => a.r - b.r || a.fVida - b.fVida || a.ltv - b.ltv)
      .slice(0, porCorte);
    for (const c of perto) amostras.push({ ref: ref(c.id), corteDias: corte, recenciaDias: c.r, frequenciaVida: c.fVida, valorNaJanela: c.m, ltv: c.ltv, segmento: c.segmento.id });
  }
  if (rfm.valorAlto != null) {
    const perto = rfm.clientes.filter((c) => c.v > 0).sort((a, b) => Math.abs(a.v - rfm.valorAlto) - Math.abs(b.v - rfm.valorAlto)).slice(0, porCorte);
    for (const c of perto) amostras.push({ ref: ref(c.id), corteValor: rfm.valorAlto, recenciaDias: c.r, frequenciaVida: c.fVida, valorNaJanela: c.m, ltv: c.ltv, segmento: c.segmento.id });
  }
  return amostras;
}

// ── Relatório completo ───────────────────────────────────────────────────────────────────────────────
function gerarRelatorio(linhasLidas, { asOf, fuso = FUSO_PADRAO, chaveDoContexto = 'loja', alternativas = ALTERNATIVAS_PADRAO } = {}) {
  const asOfData = asOf instanceof Date ? asOf : new Date(asOf);
  const integridade = auditarLinhas(linhasLidas);
  const ordenadas = [...linhasLidas].sort(compararPedidosRecentesPrimeiro);
  const { unicas, duplicados } = deduplicarPedidos(ordenadas);
  const clientes = agruparClientes(unicas, { chaveDoContexto });
  const cobertura = coberturaDe(unicas, clientes, duplicados);

  const atual = classificarRfm(clientes, { asOf: asOfData, fuso });
  const comparativo = alternativas.map((alt) => {
    const cfg = configuracaoEfetiva(alt.config);
    const rfm = classificarRfm(clientes, { asOf: asOfData, fuso, ...alt.config });
    return {
      nome: alt.nome, regraVersao: regraVersao(cfg), configuracao: alt.config, valorAlto: rfm.valorAlto, suficiente: rfm.suficiente,
      segmentos: tabelaDeSegmentos(rfm).map((s) => ({ id: s.id, clientes: s.clientes, pctBase: s.pctBase })),
      versusAtual: compararComAtual(atual, rfm),
      estabilidade: estabilidade(rfm).clientesPertoDeAlgumCorteDeRecencia,
    };
  });

  return {
    geradoEm: new Date().toISOString(),
    metodologia: {
      somenteLeitura: true,
      semDadoPessoal: 'Só agregados e amostras com rótulo opaco aleatório; nenhuma chave de cliente é impressa.',
      pedidoValido: 'payment_status ∈ {paid, succeeded, free}, sem troca, com data e valor ≥ 0.',
      valor: 'total_value (líquido de desconto, com frete pago), BRL. Reembolso parcial não é rastreado.',
      recencia: 'dias de calendário no fuso da Organization entre a última compra válida e asOf.',
      fuso, asOf: asOfData.toISOString(),
      regraAtual: { regraVersao: atual.regraVersao, configuracao: atual.configuracao },
    },
    integridade,
    cobertura,
    universo: { compradores: atual.universo, identidadesSemCompraValida: atual.leadsSemCompraValida, suficiente: atual.suficiente, motivoInsuficiencia: atual.motivoInsuficiencia, historicoDias: atual.historicoDias },
    distribuicoes: distribuicoes(atual, clientes),
    regraAtual: { valorAlto: atual.valorAlto, valorAltoMetrica: atual.valorAltoMetrica, segmentos: tabelaDeSegmentos(atual), estabilidade: estabilidade(atual) },
    recompra: comportamentoDeRecompra(clientes, asOfData, fuso),
    alternativas: comparativo,
    amostrasLimitrofes: amostrasLimitrofes(atual),
    conferencias: {
      somaDosSegmentosIgualAoUniverso: atual.segmentos.reduce((a, s) => a + s.clientes, 0) === atual.universo,
      receitaDosSegmentosIgualAoLtvTotal: Math.round(atual.segmentos.reduce((a, s) => a + s.receita, 0) * 100) === Math.round(atual.clientes.reduce((a, c) => a + c.ltv, 0) * 100),
      pedidosDosSegmentosIgualAosValidos: atual.segmentos.reduce((a, s) => a + s.pedidos, 0) === atual.clientes.reduce((a, c) => a + c.fVida, 0),
    },
  };
}

function paraMarkdown(r) {
  const L = [];
  const tabela = (cab, linhas) => { L.push(`| ${cab.join(' | ')} |`, `| ${cab.map(() => '---').join(' | ')} |`, ...linhas.map((l) => `| ${l.join(' | ')} |`), ''); };
  const q = (x) => (x
    ? `n ${x.n} · ${['p10', 'p25', 'p50', 'p75', 'p90', 'p99'].filter((k) => x[k] !== undefined).map((k) => (k === 'p50' ? `**p50 ${x[k]}**` : `${k} ${x[k]}`)).join(' · ')} · máx ${x.max}`
    : '—');
  L.push('# Calibração da RFM — relatório agregado', '', `Gerado em ${r.geradoEm} · asOf ${r.metodologia.asOf} · fuso ${r.metodologia.fuso} · regra ${r.metodologia.regraAtual.regraVersao}`, '');
  L.push('## 1. Integridade', '');
  const i = r.integridade;
  tabela(['Item', 'Valor'], [
    ['Linhas lidas', i.linhas], ['Pedidos distintos (ink_order_id)', i.pedidosDistintos], ['Linhas duplicadas', i.linhasDuplicadasPorInkOrderId],
    ['Sem data / sem valor / valor negativo / valor zero', `${i.semData} / ${i.semValor} / ${i.valorNegativo} / ${i.valorZero}`],
    ['Sem identidade (doc/tel/e-mail)', i.semIdentidade], ['Sem status de pagamento', i.semStatusDePagamento],
    ['Primeiro / último pedido', `${i.primeiroPedidoEm} / ${i.ultimoPedidoEm}`],
    ['Pagamento válido com pedido encerrado (cancelado/reembolsado/devolvido)', `${i.pagamentoValidoComPedidoEncerrado.pedidos} pedidos · R$ ${i.pagamentoValidoComPedidoEncerrado.valor}`],
  ]);
  L.push('Status de pagamento:', '', '```json', JSON.stringify(i.statusDePagamento), '```', '');
  if (Object.keys(i.statusDePagamentoNaoReconhecidos).length) L.push('**Status NÃO reconhecidos:**', '```json', JSON.stringify(i.statusDePagamentoNaoReconhecidos), '```', '');
  L.push('## 2. Universo e distribuições', '', `Compradores classificados: **${r.universo.compradores}** · sem compra válida: ${r.universo.identidadesSemCompraValida} · histórico: ${r.universo.historicoDias} dias · suficiente: ${r.universo.suficiente}`, '');
  const d = r.distribuicoes;
  tabela(['Métrica', 'Quantis'], [
    ['Recência (dias)', q(d.recenciaDias)], ['Recência — 1 compra', q(d.recenciaDiasUmaCompra)], ['Recência — recorrentes', q(d.recenciaDiasRecorrentes)],
    ['LTV (R$)', q(d.valorLtv)], ['LTV — 1 compra', q(d.ltvUmaCompra)], ['LTV — recorrentes', q(d.ltvRecorrentes)],
    ['Ticket por pedido (R$)', q(d.ticketPorPedido)], ['Ticket médio por cliente (R$)', q(d.ticketMedioPorCliente)],
  ]);
  L.push(`Frequência (pedidos/cliente): ${JSON.stringify(d.frequencia.distribuicao)} · **${d.frequencia.pctClientesDeUmaCompra}%** de clientes com uma compra · top 10% do LTV = ${d.concentracaoDeReceita.top10pct}% da receita, top 20% = ${d.concentracaoDeReceita.top20pct}%.`, '');
  L.push('## 3. Regra atual por segmento', '');
  tabela(['Segmento', 'Clientes', '% base', 'Pedidos', 'Receita', '% receita', 'Ticket', 'Mediana recência', 'Mediana freq.'], r.regraAtual.segmentos.map((s) => [s.nome, s.clientes, s.pctBase, s.pedidos, s.receita, s.pctReceita, s.ticketMedio, s.recenciaMedianaDias, s.frequenciaMediana]));
  const e = r.regraAtual.estabilidade;
  L.push('Estabilidade perto dos cortes (±3 dias / ±5%):', '', ...e.porCorteDeRecencia.map((c) => `- corte ${c.corteDias} d: ${c.clientesAte3DiasDoCorte} clientes (${c.pct}%)`), `- valor alto (${e.valorAlto ? `${e.valorAlto.metrica} ≥ ${e.valorAlto.corte}` : '—'}): ${e.valorAlto ? `${e.valorAlto.clientesAte5PctDoCorte} clientes (${e.valorAlto.pct}%)` : '—'}`, `- perto de algum corte de recência: **${e.clientesPertoDeAlgumCorteDeRecencia.n} (${e.clientesPertoDeAlgumCorteDeRecencia.pct}%)**`, '');
  L.push('## 4. Comportamento de recompra da loja', '');
  const rc = r.recompra;
  L.push(rc.intervalosEntreCompras ? `Intervalo entre compras: ${q(rc.intervalosEntreCompras)}` : `**${rc.avisoIntervalos}**`, '');
  tabela(['Recompra em até', 'Elegíveis', 'Recompraram', '%'], Object.entries(rc.segundaCompraAte).map(([k, v]) => [k, v.elegiveis, v.recompraram, v.pct == null ? `— (${v.aviso})` : v.pct]));
  L.push('## 5. Alternativas (uma variação por vez)', '');
  tabela(['Alternativa', 'Regra', 'Mudam de segmento', '% da base', 'Perto de corte'], r.alternativas.map((a) => [a.nome, a.regraVersao, a.versusAtual.clientesQueMudaramDeSegmento, a.versusAtual.pctDaBase, `${a.estabilidade.pct}%`]));
  L.push('## 6. Amostras limítrofes (rótulos opacos)', '', '```json', JSON.stringify(r.amostrasLimitrofes), '```', '', '## 7. Conferências', '', '```json', JSON.stringify(r.conferencias), '```', '');
  return L.join('\n');
}

module.exports = { gerarRelatorio, auditarLinhas, distribuicoes, comportamentoDeRecompra, estabilidade, compararComAtual, amostrasLimitrofes, paraMarkdown, quantis, ALTERNATIVAS_PADRAO, PADROES };
