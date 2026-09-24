'use strict';

// Via ESPECÍFICA da Audiência de Campanhas para segmentos de origem RFM ("opção A" preservada: pessoas dinâmicas, corte de
// valor materializado no segmento salvo).
//
// Problema que resolve. Os filtros genéricos de Campanhas (`diasSemComprar`, `quantidadePedidos`, `totalGasto`) medem
// diferente da RFM: contam troca paga como compra, ignoram a janela de frequência de 365 dias e usam 24h corridas em vez de
// dia de calendário no fuso da Organização (ver `agregado.js`). Traduzir o segmento em quatro filtros genéricos dava uma
// população APROXIMADA. Aqui o segmento salvo vira UM filtro `rfm`, avaliado pelo MESMO predicado (`casaPredicado`) e pelos
// MESMOS R/F/V (`classificarRfm`) da matriz de Clientes — mesma população, no mesmo `asOf`, com a regra e o corte salvos.
//
// Contrato do filtro persistido (em `segments.filtros` / `campaigns.audience_definition.filtros`):
//   { field: 'rfm', op: 'segmento', value: { segmento, regraVersao, classificadoEm, predicado } }
//   · `predicado` guarda o corte de valor SALVO (nunca recalculado aqui); `regraVersao` é a regra sob a qual foi salvo;
//   · é condição OBRIGATÓRIA mesmo com `match: 'ANY'` (um OU aqui alargaria o público para "todos os clientes");
//   · qualquer defeito (forma inválida, regra que mudou, amostra insuficiente, junção inconsistente) LANÇA `ErroAudienciaRfm`:
//     a Audiência nunca degrada para "todos os clientes" nem para a última resposta.
//
// Ordem de elegibilidade: (1) população comercial = membros do segmento pela RFM; (2) condições adicionais; (3) exclusões de
// contato (opt-in, telefone válido, cooldown) — que só atuam DEPOIS e são discriminadas por motivo (server.js).

const { casaPredicado, REGRAS, METRICAS_VALOR } = require('./rfm');
const { chaveDeJuncao } = require('./analise');
const { estadoDoSegmentoSalvo } = require('./segmento');

const CAMPO = 'rfm';
const OPERADOR = 'segmento';

class ErroAudienciaRfm extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroAudienciaRfm';
    this.codigo = codigo;
    this.status = 409;
  }
}

const ehObjeto = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const inteiroNaoNegativo = (v) => Number.isInteger(v) && v >= 0;
const numeroFinito = (v) => typeof v === 'number' && Number.isFinite(v);
const soChaves = (o, permitidas) => Object.keys(o).every((k) => permitidas.includes(k));

function invalido(motivo) {
  return new ErroAudienciaRfm('RFM_FILTRO_INVALIDO', `O filtro de segmento RFM desta audiência está inválido (${motivo}). Volte a Clientes e crie o segmento de novo.`);
}

function validarPredicado(p) {
  if (!ehObjeto(p) || !soChaves(p, ['recenciaDias', 'frequencia', 'valor'])) throw invalido('predicado');
  const r = p.recenciaDias;
  if (!ehObjeto(r) || !soChaves(r, ['min', 'max']) || !inteiroNaoNegativo(r.min) || !(r.max === null || (inteiroNaoNegativo(r.max) && r.max >= r.min))) throw invalido('recência');
  let frequencia = null;
  if (p.frequencia != null) {
    const f = p.frequencia;
    const limite = (v) => v === null || v === undefined || inteiroNaoNegativo(v);
    if (!ehObjeto(f) || !soChaves(f, ['min', 'max']) || !limite(f.min) || !limite(f.max) || (f.min != null && f.max != null && f.max < f.min)) throw invalido('frequência');
    frequencia = { min: f.min ?? null, max: f.max ?? null };
  }
  let valor = null;
  if (p.valor != null) {
    const v = p.valor;
    const corte = (x) => x === null || x === undefined || numeroFinito(x);
    if (!ehObjeto(v) || !soChaves(v, ['metrica', 'min', 'maxExclusivo']) || !METRICAS_VALOR.includes(v.metrica) || !corte(v.min) || !corte(v.maxExclusivo)) throw invalido('valor');
    valor = { metrica: v.metrica, min: v.min ?? null, maxExclusivo: v.maxExclusivo ?? null };
  }
  return { recenciaDias: { min: r.min, max: r.max }, frequencia, valor };
}

// Valida e normaliza; devolve o filtro pronto para persistir/avaliar. Lança em qualquer desvio.
function validarFiltroRfm(filtro) {
  if (!ehObjeto(filtro) || filtro.field !== CAMPO || filtro.op !== OPERADOR || !ehObjeto(filtro.value)) throw invalido('forma');
  const v = filtro.value;
  if (!soChaves(v, ['segmento', 'regraVersao', 'classificadoEm', 'predicado'])) throw invalido('campos desconhecidos');
  if (typeof v.segmento !== 'string' || !REGRAS.some((r) => r.id === v.segmento)) throw invalido('segmento');
  if (typeof v.regraVersao !== 'string' || !v.regraVersao) throw invalido('versão da regra');
  if (v.classificadoEm != null && (typeof v.classificadoEm !== 'string' || !Number.isFinite(Date.parse(v.classificadoEm)))) throw invalido('data de classificação');
  return {
    field: CAMPO, op: OPERADOR,
    value: { segmento: v.segmento, regraVersao: v.regraVersao, classificadoEm: v.classificadoEm ?? null, predicado: validarPredicado(v.predicado) },
  };
}

// O filtro que o segmento RFM persiste (a partir do predicado calculado no servidor).
function filtroRfmDoSegmento({ segmento, regraVersao, classificadoEm, predicado }) {
  return validarFiltroRfm({ field: CAMPO, op: OPERADOR, value: { segmento, regraVersao, classificadoEm, predicado } });
}

const ehFiltroRfm = (f) => f != null && typeof f === 'object' && f.field === CAMPO;

// Separa o filtro RFM (no máximo um; obrigatório) das demais condições. Mais de um é erro, nunca "o primeiro vence".
function separarFiltros(filtros) {
  const lista = Array.isArray(filtros) ? filtros : [];
  const rfm = lista.filter(ehFiltroRfm);
  if (rfm.length > 1) throw invalido('mais de um filtro de segmento RFM');
  return { rfm: rfm.length ? validarFiltroRfm(rfm[0]) : null, demais: lista.filter((f) => !ehFiltroRfm(f)) };
}

// `agregados`: clientes do cadastro de Campanhas (agregado.js); `analise`: resultado de `analisarRfm` sobre as MESMAS linhas.
// Devolve os agregados que pertencem ao segmento pela RFM e o resumo auditável. Puro: relógio só via `analise.rfm.asOf`.
function resolverPopulacaoRfm({ agregados, analise, filtro }) {
  const f = validarFiltroRfm(filtro);
  const { rfm } = analise;
  if (!rfm.amostraSuficiente) {
    throw new ErroAudienciaRfm('RFM_AMOSTRA_INSUFICIENTE', `Não há base suficiente para a classificação RFM hoje (${rfm.motivoInsuficiencia}); a audiência do segmento não pode ser calculada.`);
  }
  if (f.value.regraVersao !== rfm.regraVersao) {
    throw new ErroAudienciaRfm('RFM_REGRA_DIVERGENTE', `A regra RFM mudou desde que este segmento foi salvo (${f.value.regraVersao} → ${rfm.regraVersao}). Crie um novo segmento em Clientes com a regra atual.`);
  }

  const agregadoPorChave = new Map();
  for (const a of agregados) agregadoPorChave.set(chaveDeJuncao(a.loja, a.customerKey), a);

  const membros = [];
  let semJuncao = 0;
  for (const c of analise.clientes) {
    const k = analise.classificacaoPorId.get(c.id);
    if (!k) continue; // identidade sem compra válida: fora do universo RFM
    const a = agregadoPorChave.get(chaveDeJuncao(c.loja, c.customerKey));
    if (!a) { semJuncao += 1; continue; }
    if (casaPredicado(f.value.predicado, k.r, k.f, k.v)) membros.push(a);
  }
  // Uma pessoa da RFM sem cadastro correspondente seria silenciosamente omitida da audiência: prefere-se falhar.
  if (semJuncao) throw new ErroAudienciaRfm('RFM_JUNCAO_INCONSISTENTE', 'A classificação RFM e o cadastro de campanha divergem na identidade de alguns clientes; a audiência do segmento não foi calculada.');

  const estado = estadoDoSegmentoSalvo(
    { predicado: f.value.predicado, regraVersao: f.value.regraVersao, classificadoEm: f.value.classificadoEm, rfmSegmento: f.value.segmento },
    rfm,
  );
  return {
    membros,
    resumo: {
      equivalencia: 'exata',
      segmento: f.value.segmento,
      regraVersao: rfm.regraVersao,
      asOf: rfm.asOf,
      fuso: rfm.fuso,
      classificadoEmSalvo: f.value.classificadoEm,
      // Três universos distintos, nunca somados: pessoas com pedido ⊃ compradores válidos ⊃ segmento.
      universos: { pessoasComPedido: agregados.length, compradoresValidos: rfm.universo, segmento: membros.length },
      corteSalvo: estado.salvo.corte,
      corteAtual: estado.atual.corte,
      divergente: estado.divergente,
      pessoasNoSegmentoDeHoje: estado.pessoas.comRegraAtual,
    },
  };
}

module.exports = { ErroAudienciaRfm, CAMPO, OPERADOR, validarFiltroRfm, filtroRfmDoSegmento, ehFiltroRfm, separarFiltros, resolverPopulacaoRfm };
