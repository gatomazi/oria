'use strict';

// Do público selecionado em Clientes (segmento da RFM ou filtros combinados) para o predicado do construtor de
// audiência de Campanhas (`avaliarAudienciaCampanha`, server.js): `{ field, op, value }` combinados por E.
//
// O segmento salvo é uma DEFINIÇÃO, não uma lista de pessoas: a audiência é reavaliada a cada uso (política
// `dinamico`). O predicado nasce de números (dias, pedidos, valor), nunca do rótulo — o rótulo é um atalho.
//
// O motor de audiência é o já existente e mede um pouco diferente da RFM; as diferenças são devolvidas em
// `observacoes` e exibidas ao usuário em vez de escondidas:
//   · `diasSemComprar` conta 24h corridas até agora; a RFM conta dias de calendário no fuso da Organização;
//   · `quantidadePedidos` e `totalGasto` somam TODO o histórico (sem janela) e incluem troca paga.

function filtrosDoPredicado(predicado) {
  const filtros = [];
  const { recenciaDias, frequencia, valor } = predicado;
  if (recenciaDias.min > 0) filtros.push({ field: 'diasSemComprar', op: 'gte', value: recenciaDias.min });
  if (recenciaDias.max != null) filtros.push({ field: 'diasSemComprar', op: 'lte', value: recenciaDias.max });
  if (frequencia) {
    if (frequencia.min != null) filtros.push({ field: 'quantidadePedidos', op: 'gte', value: frequencia.min });
    if (frequencia.max != null) filtros.push({ field: 'quantidadePedidos', op: 'lte', value: frequencia.max });
  }
  if (valor) {
    // 'ticket_medio' → filtro de ticket médio; a soma da janela (padrão) → total gasto.
    const campo = valor.metrica === 'ticket_medio' ? 'ticketMedio' : 'totalGasto';
    if (valor.min != null) filtros.push({ field: campo, op: 'gte', value: valor.min });
    if (valor.maxExclusivo != null) filtros.push({ field: campo, op: 'lt', value: valor.maxExclusivo });
  }
  return filtros;
}

function observacoesDoPredicado({ janelaAbrangeHistoricoObservado }) {
  const observacoes = [
    'A recência do filtro conta 24h corridas; a RFM conta dias de calendário. Clientes na fronteira de uma faixa podem divergir em 1 dia.',
    'O filtro de audiência soma todo o histórico de pedidos pagos, inclusive troca; a RFM só conta pedidos válidos sem troca.',
  ];
  if (!janelaAbrangeHistoricoObservado) observacoes.push('A janela de frequência da RFM é menor que o histórico: o filtro, sem janela, pode incluir pessoas a mais.');
  return observacoes;
}

// Consulta normalizada da lista (lib/clientes/lista.js) → filtros de audiência. Só o que o motor de audiência sabe
// avaliar entra; `busca`, datas absolutas e o segmento RFM ficam de fora e voltam em `naoConvertidos`.
function filtrosDaConsulta(consulta) {
  const filtros = [];
  const faixa = (campo, min, max) => {
    if (min != null) filtros.push({ field: campo, op: 'gte', value: min });
    if (max != null) filtros.push({ field: campo, op: 'lte', value: max });
  };
  faixa('diasSemComprar', consulta.recenciaMin, consulta.recenciaMax);
  faixa('quantidadePedidos', consulta.pedidosMin, consulta.pedidosMax);
  faixa('totalGasto', consulta.ltvMin, consulta.ltvMax);
  faixa('ticketMedio', consulta.ticketMin, consulta.ticketMax);
  if (consulta.marketing === 'sim') filtros.push({ field: 'optIn', value: true });
  if (consulta.uf) filtros.push({ field: 'uf', op: 'eq', value: consulta.uf });
  const naoConvertidos = [];
  if (consulta.busca) naoConvertidos.push('busca');
  if (consulta.primeiraDe || consulta.primeiraAte) naoConvertidos.push('data da primeira compra');
  if (consulta.ultimaDe || consulta.ultimaAte) naoConvertidos.push('data da última compra');
  if (consulta.marketing === 'nao') naoConvertidos.push('não aceita marketing');
  if (consulta.inativoDias != null) filtros.push({ field: 'diasSemComprar', op: 'gte', value: consulta.inativoDias });
  return { filtros, naoConvertidos };
}

// ── Segmento RFM salvo × classificação de HOJE ───────────────────────────────────────────────────────
// Um segmento RFM salvo é DINÂMICO nas pessoas (a audiência é reavaliada a cada uso com os filtros persistidos), mas o corte de
// valor "alto" é um percentil da população (P75) que foi MATERIALIZADO em número no momento em que o segmento foi salvo
// (ex.: totalGasto < 242,73). Quando novos pedidos mudam o P75, a regra (`regraVersao`) continua a mesma — o hash cobre a
// configuração, não o corte —, mas o número salvo deixou de ser o percentil de hoje. Esta função torna a divergência VISÍVEL
// (regra, `asOf`, corte salvo × corte efetivo, pessoas em cada leitura) sem reescrever nada: quem decide atualizar é o usuário.
const { casaPredicado } = require('./rfm');

function camposDoPredicado(p) {
  if (!p) return {};
  return {
    'recencia.min': p.recenciaDias ? p.recenciaDias.min : null,
    'recencia.max': p.recenciaDias ? p.recenciaDias.max : null,
    'frequencia.min': p.frequencia ? p.frequencia.min : null,
    'frequencia.max': p.frequencia ? p.frequencia.max : null,
    'valor.metrica': p.valor ? (p.valor.metrica || 'ltv_janela') : null,
    'valor.min': p.valor ? p.valor.min : null,
    'valor.maxExclusivo': p.valor ? p.valor.maxExclusivo : null,
  };
}

function corteDoPredicado(p) {
  if (!p || !p.valor) return null;
  const valor = p.valor.min != null ? p.valor.min : p.valor.maxExclusivo;
  return valor == null ? null : { metrica: p.valor.metrica || 'ltv_janela', valor, sentido: p.valor.min != null ? 'a_partir_de' : 'abaixo_de' };
}

// `salvo`: { predicado, regraVersao, classificadoEm, rfmSegmento }. `rfm`: resultado de `classificarRfm` de agora.
function estadoDoSegmentoSalvo(salvo, rfm) {
  const atualDef = rfm.segmentos.find((x) => x.id === salvo.rfmSegmento) || null;
  const atualPredicado = atualDef ? atualDef.predicado : null;
  const a = camposDoPredicado(salvo.predicado);
  const b = camposDoPredicado(atualPredicado);
  const diferencas = Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => ({ campo: k, salvo: a[k], atual: b[k] === undefined ? null : b[k] }));
  const mesmaMetrica = (a['valor.metrica'] || null) === (b['valor.metrica'] || null);
  // Pessoas hoje: (i) segundo a regra SALVA (o que a Audiência devolve se a base fosse só RFM) e (ii) segundo a regra de hoje.
  let comRegraSalva = null;
  if (salvo.predicado && mesmaMetrica) comRegraSalva = rfm.clientes.filter((c) => casaPredicado(salvo.predicado, c.r, c.f, c.v)).length;
  return {
    salvo: { regraVersao: salvo.regraVersao || null, classificadoEm: salvo.classificadoEm || null, corte: corteDoPredicado(salvo.predicado), predicado: salvo.predicado },
    atual: { regraVersao: rfm.regraVersao, classificadoEm: rfm.asOf, corte: corteDoPredicado(atualPredicado), predicado: atualPredicado, amostraSuficiente: rfm.amostraSuficiente },
    mesmaRegraVersao: (salvo.regraVersao || null) === rfm.regraVersao,
    divergente: diferencas.length > 0,
    diferencas,
    pessoas: {
      comRegraSalva,
      comRegraAtual: atualDef ? atualDef.clientes : null,
      motivoSemContagemSalva: comRegraSalva == null ? (mesmaMetrica ? 'sem predicado salvo' : 'a métrica de valor mudou; a contagem pela regra salva não é comparável') : null,
    },
    politica: {
      pessoas: 'dinamico',
      corteDeValor: 'materializado',
      texto: 'As pessoas são reavaliadas a cada uso com os filtros salvos; o corte de valor fica fixo no número salvo até um novo segmento ser criado.',
    },
  };
}

module.exports = { filtrosDoPredicado, filtrosDaConsulta, observacoesDoPredicado, estadoDoSegmentoSalvo, corteDoPredicado };
