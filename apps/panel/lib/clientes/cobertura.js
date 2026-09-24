'use strict';

// Semântica de COBERTURA do histórico de pedidos, separada de "amostra suficiente" (estatística, em rfm.js).
//
//   historicoObservadoDias   dias entre o pedido mais antigo que EXISTE no cache e a data de referência. É só o que se vê:
//                            nada garante que não haja pedidos anteriores que nunca foram sincronizados.
//   backfillConfirmado       existe um backfill de pedidos CONCLUÍDO para a Store (job `concluido`). Só isso confirma que um
//                            intervalo foi lido por inteiro da Ink.
//   coberturaConfirmadaDias  dias entre o início do intervalo do backfill concluído (`desde`) e a referência; `null` sem backfill.
//   cobertura365Confirmada   coberturaConfirmadaDias ≥ 365. É o que autoriza dizer "a janela de frequência de 365 dias está
//                            completa". Observar 365+ dias NÃO basta: pode haver buracos.
//
// Função pura: quem chama lê `pedidos_backfill_jobs` (somente leitura) e passa o resumo.

const { diasDeCalendario } = require('./rfm');

const FUSO_PADRAO = 'America/Sao_Paulo';

// Coluna DATE do Postgres chega como Date à meia-noite LOCAL do processo; texto chega como 'AAAA-MM-DD'. Nos dois casos o dia
// é o do calendário, sem passar por UTC (que poderia deslocar um dia).
function diaDeCalendario(v) {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v).slice(0, 10);
}

// `backfill`: { ultimoStatus, concluidoDesde } — `concluidoDesde` = menor `desde` entre os jobs `concluido` (Date ou AAAA-MM-DD).
function semanticaDeCobertura({ primeiroPedidoEm, asOf, fuso = FUSO_PADRAO, backfill = null, janelaFrequenciaDias = 365 }) {
  const ref = asOf instanceof Date ? asOf : new Date(asOf);
  const observados = primeiroPedidoEm ? diasDeCalendario(new Date(primeiroPedidoEm), ref, fuso) : 0;
  const desdeDia = backfill && backfill.concluidoDesde ? diaDeCalendario(backfill.concluidoDesde) : null;
  const desde = desdeDia ? new Date(`${desdeDia}T12:00:00Z`) : null;
  const backfillConfirmado = desde != null && Number.isFinite(desde.getTime());
  const confirmados = backfillConfirmado ? diasDeCalendario(desde, ref, fuso) : null;
  const cobertura365Confirmada = confirmados != null && confirmados >= 365;
  const coberturaJanelaConfirmada = confirmados != null && confirmados >= janelaFrequenciaDias;
  let leitura;
  if (!backfillConfirmado) {
    leitura = `Histórico OBSERVADO: ${observados} dia(s). Nenhum backfill concluído: a cobertura não está confirmada e os números não devem ser tratados como o histórico completo da loja.`;
  } else if (!coberturaJanelaConfirmada) {
    leitura = `Backfill concluído cobre ${confirmados} dia(s), menos que a janela de frequência (${janelaFrequenciaDias}): a janela não está confirmada por inteiro.`;
  } else {
    leitura = `Backfill concluído cobre ${confirmados} dia(s): a janela de frequência (${janelaFrequenciaDias}) está confirmada.`;
  }
  return {
    historicoObservadoDias: observados,
    ultimoBackfillStatus: backfill ? backfill.ultimoStatus || null : null,
    backfillConfirmado,
    backfillConcluidoDesde: backfillConfirmado ? desdeDia : null,
    coberturaConfirmadaDias: confirmados,
    cobertura365Confirmada,
    coberturaJanelaConfirmada,
    janelaObservadaAbrange365: observados >= 365,
    leitura,
  };
}

module.exports = { semanticaDeCobertura };
