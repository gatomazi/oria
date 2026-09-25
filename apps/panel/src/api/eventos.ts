// Linha do log de recebimento (nome do evento e origem). O servidor não devolve mais o corpo nem os
// headers do webhook ao painel do lojista — só o que Automações e Templates precisam.
export interface WebhookEvento {
  loja: string | null;
  eventName: string | null;
  inkOrderId: string | number | null;
  verificado: boolean;
  metodoAuth: string | null;
  recebidoEm: string | null;
}
