'use strict';

// Fase F.2.A — cota simples de execuções do provider REAL do Product Enrichment, por Organization,
// por processo. Em memória de propósito: nesta fase nenhuma chamada real acontece (o core recusa
// todo provider "openai" sem client injetado — ver creative_core/service.py::_enrichment_propose),
// então isto nunca é exercitado por tráfego real ainda; existe para ser testável agora e já impor o
// limite no dia em que a F.2.B ligar um client de verdade.
//
// NÃO é distribuído entre processos/réplicas — uma cota por réplica, não uma cota global da
// Organization. Se a operação escalar horizontalmente antes de existir um limite compartilhado
// (banco ou Redis), isto SUBESTIMA o uso real (cada réplica conta separadamente): nunca bloqueia sem
// motivo, mas também não impede gasto se o tráfego se espalhar por várias réplicas. Risco
// remanescente documentado no relatório da Fase F.2.A — aceitável aqui porque, nesta rodada, o
// contador nunca chega a ser incrementado por uma chamada real (não existe nenhuma).

const janelas = new Map(); // tenantId -> [timestamps ms de chamadas reais contadas]
const JANELA_MS = 24 * 60 * 60 * 1000;

function limiteDiario(env) {
  const bruto = Number((env && env.CREATIVE_ENRICHMENT_OPENAI_MAX_PER_DAY) || 20);
  return Number.isFinite(bruto) && bruto > 0 ? Math.floor(bruto) : 20;
}

// Só CONSULTA — nunca conta a chamada sozinho (contar é `registrar`, chamado só depois de uma
// proposta REAL efetivamente criada, nunca antes de saber se ela teve sucesso).
function verificar(tenantId, env, agora = Date.now()) {
  const limite = limiteDiario(env);
  const lista = (janelas.get(tenantId) || []).filter((t) => agora - t < JANELA_MS);
  janelas.set(tenantId, lista);
  return { ok: lista.length < limite, usado: lista.length, limite };
}

function registrar(tenantId, agora = Date.now()) {
  const lista = janelas.get(tenantId) || [];
  lista.push(agora);
  janelas.set(tenantId, lista);
}

function _resetParaTeste() {
  janelas.clear();
}

module.exports = { verificar, registrar, limiteDiario, _resetParaTeste };
