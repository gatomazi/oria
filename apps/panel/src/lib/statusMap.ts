import type { Tone } from '../components/ds/StatusBadge';

// Porte 1:1 de src/admin/design-system/status-map.js.
export interface StatusEntry {
  label: string;
  tone: Tone;
}
type StatusMap = Record<string, StatusEntry>;

// Valores 1:1 com o enum `order_status` de GET /v1/stores/orders (documentacao-api-ink.yaml).
export const ORDER_STATUS_MAP: StatusMap = {
  waiting_payment: { label: 'Aguardando pagamento', tone: 'warning' },
  awaiting_analysis: { label: 'Em análise', tone: 'warning' },
  payment_refused: { label: 'Pagamento recusado', tone: 'danger' },
  expired: { label: 'Expirado', tone: 'danger' },
  paid: { label: 'Pago', tone: 'success' },
  refund_requested: { label: 'Reembolso solicitado', tone: 'warning' },
  refunded: { label: 'Reembolsado', tone: 'danger' },
  canceled: { label: 'Cancelado', tone: 'danger' },
  waiting_approval: { label: 'Aguardando aprovação', tone: 'warning' },
  awaiting_stamp: { label: 'Aguardando estampagem', tone: 'info' },
  awaiting_production: { label: 'Aguardando produção', tone: 'info' },
  production_delayed: { label: 'Produção atrasada', tone: 'warning' },
  waiting_to_be_sent: { label: 'Produzido', tone: 'info' },
  waiting_to_be_collected: { label: 'Aguardando coleta', tone: 'info' },
  sent: { label: 'Despachado', tone: 'info' },
  preparing_for_delivery: { label: 'Preparando para entrega', tone: 'info' },
  delivery_in_progress: { label: 'Em trânsito', tone: 'info' },
  left_for_delivery: { label: 'Saiu para entrega', tone: 'info' },
  delivery_failure: { label: 'Falha na entrega', tone: 'danger' },
  delivery_interrupted: { label: 'Entrega interrompida', tone: 'danger' },
  waiting_sender_action: { label: 'Aguardando ação do remetente', tone: 'warning' },
  return_started: { label: 'Devolução iniciada', tone: 'warning' },
  returned: { label: 'Devolvido', tone: 'neutral' },
  delivered: { label: 'Entregue', tone: 'success' },
  delivered_correios: { label: 'Entregue (Correios)', tone: 'success' },
};

// Valores 1:1 com o enum `payment_status` do mesmo endpoint.
export const PAYMENT_STATUS_MAP: StatusMap = {
  pending: { label: 'Pendente', tone: 'warning' },
  paid: { label: 'Pago', tone: 'success' },
  succeeded: { label: 'Pago', tone: 'success' },
  free: { label: 'Grátis', tone: 'success' },
  waiting_payment: { label: 'Aguardando pagamento', tone: 'warning' },
  awaiting_analysis: { label: 'Em análise', tone: 'warning' },
  refund_requested: { label: 'Reembolso solicitado', tone: 'warning' },
  refunded: { label: 'Reembolsado', tone: 'danger' },
  canceled: { label: 'Cancelado', tone: 'danger' },
  failed: { label: 'Falhou', tone: 'danger' },
  expired: { label: 'Expirado', tone: 'danger' },
  not_authorized: { label: 'Não autorizado', tone: 'danger' },
  dispute: { label: 'Em disputa', tone: 'danger' },
  chargeback: { label: 'Chargeback', tone: 'danger' },
};

export const WHATSAPP_STATUS_MAP: StatusMap = {
  sent: { label: 'Enviado', tone: 'info' },
  delivered: { label: 'Entregue', tone: 'success' },
  read: { label: 'Lido', tone: 'success' },
  failed: { label: 'Falha', tone: 'danger' },
  pending: { label: 'Pendente', tone: 'warning' },
};

// Chaves em maiúsculo de propósito — é o enum real devolvido pela Meta Cloud API.
export const TEMPLATE_META_STATUS_MAP: StatusMap = {
  APPROVED: { label: 'Aprovado', tone: 'success' },
  PENDING: { label: 'Em análise', tone: 'warning' },
  REJECTED: { label: 'Rejeitado', tone: 'danger' },
};

// Estados calculados no servidor pra Recuperação (Fase 6) — derivados do cruzamento com o
// estado local de automação (ver /api/admin/recuperacao), não vêm de enum da Ink.
export const RECUPERACAO_STATUS_MAP: StatusMap = {
  recuperavel: { label: 'Recuperável', tone: 'success' },
  aguardando: { label: 'Aguardando', tone: 'warning' },
  comprou: { label: 'Já comprou', tone: 'info' },
  sem_permissao: { label: 'Sem permissão', tone: 'danger' },
  concluido: { label: 'Concluído', tone: 'neutral' },
};

// Status de campanha (Campanhas/Remarketing) — "sending"/"paused"/"completed"/"failed" só
// passam a existir de verdade a partir da Fase 5 (fila de envio), ainda não implementada; hoje
// uma campanha só chega a draft ou scheduled.
export const CAMPANHA_STATUS_MAP: StatusMap = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  scheduled: { label: 'Agendada', tone: 'info' },
  preparing: { label: 'Preparando', tone: 'warning' },
  sending: { label: 'Enviando', tone: 'warning' },
  paused: { label: 'Pausada', tone: 'warning' },
  completed: { label: 'Concluída', tone: 'success' },
  cancelled: { label: 'Cancelada', tone: 'neutral' },
  failed: { label: 'Falhou', tone: 'danger' },
};

// Enums reais de GET /v1/stores/products.
export const PRODUCT_APPROVAL_STATUS_MAP: StatusMap = {
  waiting: { label: 'Em curadoria', tone: 'warning' },
  approved: { label: 'Aprovado', tone: 'success' },
  disapproved: { label: 'Reprovado', tone: 'danger' },
  retrying: { label: 'Reprocessando', tone: 'warning' },
  resizing: { label: 'Gerando mockups', tone: 'info' },
};

export const PRODUCT_STATUS_MAP: StatusMap = {
  published: { label: 'Publicado', tone: 'success' },
  not_published: { label: 'Não publicado', tone: 'neutral' },
  invalid_art: { label: 'Arte inválida', tone: 'danger' },
  refused: { label: 'Recusado', tone: 'danger' },
  retrying: { label: 'Reprocessando', tone: 'warning' },
  duplicating: { label: 'Duplicando', tone: 'info' },
};

export const PROMOTION_TYPE_LABELS: Record<string, string> = {
  standard: 'Desconto simples',
  progressive: 'Progressiva',
  unit_free: 'Compre N e ganhe 1',
};

// A Ink não documenta o enum de `payment_method`: rótulo humano para os valores conhecidos e,
// para qualquer outro, o texto cru com a primeira letra maiúscula (nunca some da tela).
const PAYMENT_METHOD_LABELS: Record<string, string> = {
  pix: 'Pix',
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  boleto: 'Boleto',
  bank_slip: 'Boleto',
  free: 'Grátis',
};

export function paymentMethodLabel(method: string | null | undefined): string | null {
  if (!method) return null;
  const key = method.toLowerCase();
  return PAYMENT_METHOD_LABELS[key] ?? method.charAt(0).toUpperCase() + method.slice(1);
}

// Tipos de movimentação do extrato da Ink (enum não documentado): rótulo humano pros valores
// vistos e texto cru com inicial maiúscula pros demais.
const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  charge: 'Venda',
  refund: 'Reembolso',
  chargeback: 'Chargeback',
  withdrawal: 'Saque',
  transfer: 'Transferência',
  anticipation: 'Antecipação',
  fee: 'Taxa',
  adjustment: 'Ajuste',
};

export function movementTypeLabel(type: string | null | undefined): string | null {
  if (!type) return null;
  return MOVEMENT_TYPE_LABELS[type.toLowerCase()] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export function lookup(map: StatusMap, key: string | null | undefined, fallbackLabel?: string): StatusEntry {
  if (key && map[key]) return map[key];
  return { label: fallbackLabel || key || '—', tone: 'neutral' };
}

// A API de Trocas não documenta o enum de `status`/`support_review_status` — em vez de inventar
// uma lista fixa, coloriza por palavra-chave e sempre mostra o texto cru que a Ink devolveu.
// Status de uma TROCA na Ink (`exchange.status`). Valores conhecidos em português; o que não está aqui
// aparece humanizado ("waiting_for_approval" → "Waiting for approval") em vez de código cru.
export const EXCHANGE_STATUS_LABELS: Record<string, string> = {
  waiting_for_approval: 'Aguardando aprovação',
  waiting_approval: 'Aguardando aprovação',
  in_progress: 'Em andamento',
  canceled: 'Cancelada',
  cancelled: 'Cancelada',
  completed: 'Concluída',
  finished: 'Concluída',
  approved: 'Aprovada',
  refused: 'Recusada',
  rejected: 'Recusada',
};

export function labelForExchangeStatus(status: string | null | undefined): string {
  if (!status) return '—';
  const conhecido = EXCHANGE_STATUS_LABELS[String(status).toLowerCase()];
  if (conhecido) return conhecido;
  const humano = String(status).replace(/_/g, ' ').trim();
  return humano.charAt(0).toUpperCase() + humano.slice(1);
}

export function toneForGenericStatus(status: string | null | undefined): Tone {
  const s = String(status || '').toLowerCase();
  if (/approv|paid|success|deliver|ok|concluid|aprovad/.test(s)) return 'success';
  if (/refus|reject|cancel|fail|error|recusad|negad/.test(s)) return 'danger';
  if (/wait|pend|analy|review|aguard|analis/.test(s)) return 'warning';
  return 'neutral';
}

export interface ExchangeReason {
  value: string;
  label: string;
  suporte: boolean;
}

// 1:1 com o enum `exchange_reason` de POST /v1/stores/exchanges.
export const EXCHANGE_REASONS: ExchangeReason[] = [
  { value: 'larger_size', label: 'Tamanho maior', suporte: false },
  { value: 'smaller_size', label: 'Tamanho menor', suporte: false },
  { value: 'change_color', label: 'Trocar cor', suporte: false },
  { value: 'change_print', label: 'Trocar estampa', suporte: false },
  { value: 'incorrect_print_position', label: 'Posição incorreta da estampa', suporte: true },
  { value: 'defect_in_product', label: 'Defeito no produto', suporte: true },
  { value: 'print_quality', label: 'Qualidade da impressão', suporte: true },
  { value: 'other', label: 'Outro', suporte: false },
];

// Gerador de Criativos — estados do lote e de cada criativo (lib/creative-core/status.js).
export const CREATIVE_JOB_STATUS_MAP: StatusMap = {
  queued: { label: 'Na fila', tone: 'neutral' },
  planning: { label: 'Planejando', tone: 'info' },
  generating: { label: 'Gerando', tone: 'info' },
  processing: { label: 'Processando', tone: 'info' },
  completed: { label: 'Concluído', tone: 'success' },
  partial: { label: 'Parcial', tone: 'warning' },
  failed: { label: 'Falhou', tone: 'danger' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
};
