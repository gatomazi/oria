'use strict';

// Campanhas AGENDADAS cuja hora chegou (Rodada 7). O agendador chama `iniciar` (a mesma `iniciarDisparoCampanha` do /start). Se a
// definição de audiência é recusada (condição inválida, sem condição explícita, segmento RFM aproximado sem confirmação, regra RFM
// que mudou…), a campanha continua `scheduled`, SEM destinatários, e o MOTIVO fica registrado para o administrador ver (lista e
// detalhe da campanha) — não só num log do servidor. O registro é em memória (não há coluna para isso e nada é persistido de novo):
// o agendador repete a tentativa a cada ciclo e o restaura em até um ciclo depois de um restart.

const ESPERA_APOS_BLOQUEIO_MS = 10 * 60 * 1000;

function criarRegistroDeBloqueios() {
  const porCampanha = new Map(); // id -> { codigo, mensagem, detalhes, desde, ultimaTentativa, origem }
  return {
    registrar(id, err) {
      const chave = String(id);
      const anterior = porCampanha.get(chave);
      const agora = new Date().toISOString();
      const mesmo = anterior && anterior.codigo === err.codigo && anterior.mensagem === err.message;
      porCampanha.set(chave, {
        codigo: err.codigo, mensagem: err.message, detalhes: err.detalhes || [], origem: 'agendador',
        desde: mesmo ? anterior.desde : agora, ultimaTentativa: agora,
      });
      return !mesmo; // true = causa nova (vale logar)
    },
    limpar(id) { porCampanha.delete(String(id)); },
    obter(id) { return porCampanha.get(String(id)) || null; },
    // Ids bloqueados cuja última tentativa foi há menos de `esperaMs`: o agendador os PULA (senão as 5 campanhas mais antigas, todas
    // bloqueadas, ocupariam a janela de 5 do agendador para sempre e as válidas seguintes nunca seriam iniciadas). Passada a espera,
    // voltam a ser tentadas (a causa pode ter mudado sem edição, ex.: a regra RFM).
    idsEmEspera(esperaMs = ESPERA_APOS_BLOQUEIO_MS, agora = Date.now()) {
      const ids = [];
      for (const [id, b] of porCampanha) if (agora - Date.parse(b.ultimaTentativa) < esperaMs) ids.push(id);
      return ids;
    },
    tamanho() { return porCampanha.size; },
  };
}

// Erro TIPADO de definição/audiência = bloqueio com motivo; qualquer outro erro é falha transitória (log a cada ciclo, sem rótulo).
const ehBloqueioDeAudiencia = (err) => !!(err && err.codigo && typeof err.codigo === 'string' && (err.codigo.startsWith('AUDIENCIA_') || err.codigo.startsWith('RFM_')));

async function iniciarAgendadasVencidas({ campanhas, iniciar, bloqueios, logger = console }) {
  const resultado = { iniciadas: 0, bloqueadas: 0, falhas: 0 };
  for (const campanha of campanhas) {
    try {
      await iniciar(campanha);
      bloqueios.limpar(campanha.id);
      resultado.iniciadas += 1;
    } catch (err) {
      if (ehBloqueioDeAudiencia(err)) {
        resultado.bloqueadas += 1;
        // Loga UMA vez por campanha+causa, não a cada ciclo do agendador.
        if (bloqueios.registrar(campanha.id, err)) logger.error(`[CAMPANHAS_FILA] campanha agendada ${campanha.id} NÃO iniciada (${err.codigo}): ${err.message}`);
      } else {
        resultado.falhas += 1;
        logger.error(`[CAMPANHAS_FILA] falha ao iniciar campanha agendada ${campanha.id}: ${err.message}`);
      }
    }
  }
  return resultado;
}

module.exports = { ESPERA_APOS_BLOQUEIO_MS, criarRegistroDeBloqueios, iniciarAgendadasVencidas, ehBloqueioDeAudiencia };
