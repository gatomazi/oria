'use strict';

// Contrato ÚNICO e fail-closed da definição de audiência de Campanhas/Segmentos (Rodada 6).
//
// Antes: o motor genérico ignorava campo desconhecido (`AUDIENCIA_CAMPOS_FILTRO`) e, sem nenhum filtro válido, devolvia TODOS os
// clientes; o construtor do front descartava linhas que não conseguia converter; `match` desconhecido virava "ALL" em silêncio.
// Agora QUALQUER problema de campo, operador, tipo ou valor lança `ErroAudienciaFiltro` (400, acionável) e nada é avaliado: nem
// avaliação parcial de AND/OR, nem "audiência universal" por erro. Preview, Revisão, criação/edição e envio/agendamento passam
// por esta mesma função.
//
// Audiência universal ("todos os clientes") só existe se for ESCOLHIDA: um único filtro `{ field: 'todosClientes', value: true }`
// (sem outras condições). Lista vazia, `{}` e ausência de definição NÃO são "todos": `AUDIENCIA_SEM_FILTRO`.
//
// Formatos legados aceitos (inventariados no construtor do front, nos segmentos RFM da Rodada 3/4 e nos testes do repositório):
//   numéricos  { field: diasSemComprar|quantidadePedidos|totalGasto|ticketMedio, op: gt|gte|lt|lte|eq, value: número finito ≥ 0 }
//   uf         { field: 'uf', [op: 'eq'], value: 'RS' }          (sigla das 27 UFs; maiúsculas ou minúsculas)
//   booleanos  { field: optIn|temCarrinhoAbandonado, [op: 'eq'], value: true|false }
//   campanha   { field: recebeuCampanha|naoRecebeuCampanha, value: { campanhaId: 'texto'|inteiro } }
//   janela     { field: recebeuCampanhaNosUltimosDias, value: { dias: inteiro 1..3650 } }
//   rfm        { field: 'rfm', op: 'segmento', value: {...} }     (Rodada 5; validado por lib/clientes/audiencia-rfm.js)
// Definições antigas NÃO são reescritas: as válidas seguem funcionando; as inválidas são recusadas na hora de avaliar/enviar.

const { ehFiltroRfm, validarFiltroRfm } = require('../clientes/audiencia-rfm');

const CODIGO_INVALIDO = 'AUDIENCIA_FILTRO_INVALIDO';
const CODIGO_SEM_FILTRO = 'AUDIENCIA_SEM_FILTRO';

const CAMPOS_NUMERICOS = Object.freeze(['diasSemComprar', 'quantidadePedidos', 'totalGasto', 'ticketMedio']);
const CAMPOS_INTEIROS = Object.freeze(['diasSemComprar', 'quantidadePedidos']);
const CAMPOS_BOOLEANOS = Object.freeze(['optIn', 'temCarrinhoAbandonado']);
const CAMPOS_CAMPANHA = Object.freeze(['recebeuCampanha', 'naoRecebeuCampanha']);
const OPERADORES = Object.freeze(['gt', 'gte', 'lt', 'lte', 'eq']);
const UFS = Object.freeze(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);
const CAMPO_TODOS = 'todosClientes';
const MAX_DETALHES = 20;

class ErroAudienciaFiltro extends Error {
  constructor(codigo, mensagem, detalhes = []) {
    super(mensagem);
    this.name = 'ErroAudienciaFiltro';
    this.codigo = codigo;
    this.status = 400;
    this.detalhes = detalhes;
  }
}

const ehObjeto = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const numeroFinito = (v) => typeof v === 'number' && Number.isFinite(v);
const soChaves = (o, permitidas) => Object.keys(o).every((k) => permitidas.includes(k));

// Devolve o problema (texto) ou null quando o filtro é válido; `normalizado` recebe a forma canônica.
function checarFiltro(f, normalizado) {
  if (!ehObjeto(f)) return { campo: null, operador: null, motivo: 'a condição não é um objeto { field, op, value }' };
  const { field, op, value } = f;
  const p = (motivo) => ({ campo: typeof field === 'string' ? field : null, operador: typeof op === 'string' ? op : null, motivo });
  if (typeof field !== 'string' || !field) return p('campo ausente');
  if (!soChaves(f, ['field', 'op', 'value'])) return p('a condição tem chaves desconhecidas (só field, op e value)');

  if (CAMPOS_NUMERICOS.includes(field)) {
    if (!OPERADORES.includes(op)) return p(`operador inválido para "${field}" (use gt, gte, lt, lte ou eq)`);
    if (!numeroFinito(value) || value < 0) return p(`o valor de "${field}" precisa ser um número maior ou igual a zero`);
    if (CAMPOS_INTEIROS.includes(field) && !Number.isInteger(value)) return p(`o valor de "${field}" precisa ser um número inteiro`);
    normalizado.push({ field, op, value });
    return null;
  }
  if (field === 'uf') {
    if (op !== undefined && op !== 'eq') return p('"uf" só aceita o operador eq');
    if (typeof value !== 'string' || !UFS.includes(value.trim().toUpperCase())) return p('"uf" precisa ser a sigla de um estado (ex.: RS)');
    normalizado.push({ field, op: 'eq', value: value.trim().toUpperCase() });
    return null;
  }
  if (CAMPOS_BOOLEANOS.includes(field)) {
    if (op !== undefined && op !== 'eq') return p(`"${field}" só aceita o operador eq`);
    if (typeof value !== 'boolean') return p(`o valor de "${field}" precisa ser verdadeiro ou falso`);
    normalizado.push({ field, value });
    return null;
  }
  if (CAMPOS_CAMPANHA.includes(field)) {
    if (op !== undefined) return p(`"${field}" não usa operador`);
    const id = ehObjeto(value) && soChaves(value, ['campanhaId']) ? value.campanhaId : undefined;
    const ok = (typeof id === 'string' && id.trim() !== '' && id.length <= 64) || (Number.isInteger(id) && id > 0);
    if (!ok) return p(`o valor de "${field}" precisa ser { campanhaId } com o id da campanha`);
    normalizado.push({ field, value: { campanhaId: String(id).trim() } });
    return null;
  }
  if (field === 'recebeuCampanhaNosUltimosDias') {
    if (op !== undefined) return p('"recebeuCampanhaNosUltimosDias" não usa operador');
    const dias = ehObjeto(value) && soChaves(value, ['dias']) ? value.dias : undefined;
    if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return p('o valor precisa ser { dias } com um inteiro entre 1 e 3650');
    normalizado.push({ field, value: { dias } });
    return null;
  }
  return p(`campo desconhecido: "${field}"`);
}

// `exclusoes`: só as quatro chaves conhecidas, com tipo certo. Padrões protetores: opt-in e telefone válido ligados.
function normalizarExclusoes(exclusoes, detalhes) {
  const e = exclusoes == null ? {} : exclusoes;
  if (!ehObjeto(e)) { detalhes.push({ campo: 'exclusoes', operador: null, motivo: 'as exclusões precisam ser um objeto' }); return null; }
  for (const k of Object.keys(e)) {
    if (!['semOptIn', 'numeroInvalido', 'compradoNosUltimosDias', 'recebeuCampanhaNasUltimasHoras'].includes(k)) detalhes.push({ campo: `exclusoes.${k}`, operador: null, motivo: 'exclusão desconhecida' });
  }
  const bool = (k) => {
    if (e[k] === undefined || e[k] === null) return true;
    if (typeof e[k] !== 'boolean') { detalhes.push({ campo: `exclusoes.${k}`, operador: null, motivo: 'precisa ser verdadeiro ou falso' }); return true; }
    return e[k];
  };
  const num = (k) => {
    if (e[k] === undefined || e[k] === null) return null;
    if (!numeroFinito(e[k]) || e[k] < 0) { detalhes.push({ campo: `exclusoes.${k}`, operador: null, motivo: 'precisa ser um número maior ou igual a zero (ou vazio)' }); return null; }
    return e[k];
  };
  return { semOptIn: bool('semOptIn'), numeroInvalido: bool('numeroInvalido'), compradoNosUltimosDias: num('compradoNosUltimosDias'), recebeuCampanhaNasUltimasHoras: num('recebeuCampanhaNasUltimasHoras') };
}

function resumoDosProblemas(detalhes) {
  const lista = detalhes.slice(0, 3).map((d) => `${d.indice != null ? `condição ${d.indice + 1}` : d.campo || 'definição'}${d.campo && d.indice != null ? ` (${d.campo}${d.operador ? ` ${d.operador}` : ''})` : ''}: ${d.motivo}`);
  return `${lista.join('; ')}${detalhes.length > 3 ? `; e mais ${detalhes.length - 3}` : ''}`;
}

// `definicao`: { match, filtros, exclusoes }. Devolve { match, filtros, rfm, universal, exclusoes } normalizados ou LANÇA.
function validarDefinicaoAudiencia(definicao) {
  const d = ehObjeto(definicao) ? definicao : {};
  const bruto = d.filtros;
  if (bruto !== undefined && !Array.isArray(bruto)) {
    throw new ErroAudienciaFiltro(CODIGO_INVALIDO, 'A lista de condições da audiência está inválida (esperado uma lista). Corrija a definição antes de continuar.', [{ indice: null, campo: 'filtros', operador: null, motivo: 'precisa ser uma lista' }]);
  }
  const lista = bruto || [];
  if (!lista.length) {
    throw new ErroAudienciaFiltro(CODIGO_SEM_FILTRO, 'A audiência não tem nenhuma condição. Adicione uma condição, escolha um segmento ou confirme explicitamente "todos os clientes".');
  }

  const detalhes = [];
  if (d.match !== 'ALL' && d.match !== 'ANY') detalhes.push({ indice: null, campo: 'match', operador: null, motivo: 'precisa ser ALL (todas as condições) ou ANY (qualquer condição)' });

  let rfm = null;
  let universal = false;
  const normalizados = [];
  lista.forEach((f, indice) => {
    if (ehObjeto(f) && f.field === CAMPO_TODOS) {
      if (f.value !== true || f.op !== undefined || !soChaves(f, ['field', 'value'])) detalhes.push({ indice, campo: CAMPO_TODOS, operador: null, motivo: '"todosClientes" precisa ser { field, value: true }' });
      universal = true;
      return;
    }
    if (ehFiltroRfm(f)) {
      if (rfm) { detalhes.push({ indice, campo: 'rfm', operador: null, motivo: 'só pode haver um segmento RFM' }); return; }
      rfm = validarFiltroRfm(f); // lança ErroAudienciaRfm (RFM_FILTRO_INVALIDO) com mensagem própria
      return;
    }
    const problema = checarFiltro(f, normalizados);
    if (problema) detalhes.push({ indice, ...problema });
  });
  if (universal && (lista.length > 1)) detalhes.push({ indice: null, campo: CAMPO_TODOS, operador: null, motivo: '"todos os clientes" não pode ser combinado com outras condições' });

  const exclusoes = normalizarExclusoes(d.exclusoes, detalhes);
  if (detalhes.length) {
    throw new ErroAudienciaFiltro(CODIGO_INVALIDO, `A definição da audiência tem ${detalhes.length === 1 ? 'um problema' : `${detalhes.length} problemas`}: ${resumoDosProblemas(detalhes)}. Corrija ou remova a condição; nada foi calculado nem enviado.`, detalhes.slice(0, MAX_DETALHES));
  }
  return { match: d.match, filtros: normalizados, rfm, universal, exclusoes };
}

const filtroTodosClientes = () => ({ field: CAMPO_TODOS, value: true });

// Diagnóstico ESTÁTICO (puro, sem banco) de uma campanha para o administrador: a definição salva pode ser executada? Devolve
// `{ codigo, mensagem, detalhes, origem: 'definicao' }` ou null. Rascunho vazio (`{}`) não é bloqueio — ainda está sendo montado;
// agendada sem condição explícita é (o agendador a recusaria). Não avalia a população (isso é a prévia).
function diagnosticarDefinicao(definicao, { agendada }) {
  const d = ehObjeto(definicao) ? definicao : {};
  const vazia = d.match === undefined && d.filtros === undefined;
  if (vazia && !agendada) return null;
  try {
    validarDefinicaoAudiencia({ match: d.match, filtros: d.filtros, exclusoes: d.exclusoes });
    return null;
  } catch (err) {
    if (err instanceof ErroAudienciaFiltro && err.codigo === CODIGO_SEM_FILTRO && !agendada) return null;
    if (err && typeof err.codigo === 'string') return { codigo: err.codigo, mensagem: err.message, detalhes: err.detalhes || [], origem: 'definicao' };
    throw err;
  }
}

module.exports = {
  ErroAudienciaFiltro, CODIGO_INVALIDO, CODIGO_SEM_FILTRO, CAMPO_TODOS, CAMPOS_NUMERICOS, OPERADORES, UFS,
  validarDefinicaoAudiencia, filtroTodosClientes, diagnosticarDefinicao,
};
