'use strict';

// Estados do lote (spec Etapa 2 §22) e dos itens. O status do lote é derivado dos itens — nunca gravado à mão fora
// daqui — para que retry individual e falha parcial fiquem consistentes.

const JOB_STATUSES = Object.freeze(['queued', 'planning', 'generating', 'processing', 'completed', 'partial', 'failed', 'cancelled']);
const ITEM_STATUSES = Object.freeze(['queued', 'planning', 'generating', 'processing', 'completed', 'failed', 'cancelled']);
const ACTIVE_ITEM = Object.freeze(['planning', 'generating', 'processing']);
const FINAL_JOB = Object.freeze(['completed', 'partial', 'failed', 'cancelled']);

function aggregateJobStatus(items, cancelled = false) {
  if (cancelled) return 'cancelled';
  const counts = Object.fromEntries(ITEM_STATUSES.map((s) => [s, 0]));
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  // O estágio mais avançado em andamento representa o lote.
  for (const active of ['processing', 'generating', 'planning']) if (counts[active] > 0) return active;
  if (counts.queued > 0) {
    return counts.completed + counts.failed > 0 ? 'generating' : 'queued';
  }
  const concluidos = counts.completed;
  const falhos = counts.failed + counts.cancelled;
  if (concluidos > 0 && falhos === 0) return 'completed';
  if (concluidos > 0) return 'partial';
  return 'failed';
}

function progress(items) {
  const done = items.filter((i) => i.status === 'completed' || i.status === 'failed' || i.status === 'cancelled').length;
  return {
    total: items.length,
    done,
    completed: items.filter((i) => i.status === 'completed').length,
    failed: items.filter((i) => i.status === 'failed').length,
  };
}

module.exports = { JOB_STATUSES, ITEM_STATUSES, ACTIVE_ITEM, FINAL_JOB, aggregateJobStatus, progress };
