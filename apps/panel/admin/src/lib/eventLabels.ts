// Rótulos humanos pros códigos técnicos que a interface exibe (eventos da Reserva Ink, categoria
// e idioma de template da Meta). O código original continua disponível (title/tooltip) e qualquer
// valor desconhecido aparece cru — nunca some da tela.

const EVENT_LABELS: Record<string, string> = {
  'order.created': 'Pedido criado',
  'order.canceled': 'Pedido cancelado',
  'payment.approved': 'Pagamento aprovado',
  'payment.card_not_authorized': 'Cartão não autorizado',
  'payment.pix_boleto_expired': 'Pix/boleto expirado',
  'pix.pendente': 'Pix pendente',
  'cart.abandoned': 'Carrinho abandonado',
  'shipping.waiting_to_be_sent': 'Aguardando envio',
  'shipping.sent': 'Despachado',
  'shipping.delivery_in_progress': 'Em trânsito',
  'shipping.left_for_delivery': 'Saiu para entrega',
  'shipping.delivered': 'Entregue',
};

export function eventoLabel(codigo: string | null | undefined): string {
  if (!codigo) return '—';
  return EVENT_LABELS[codigo] ?? codigo;
}

const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  MARKETING: 'Marketing',
  UTILITY: 'Utilidade',
  AUTHENTICATION: 'Autenticação',
};

export function templateCategoriaLabel(categoria: string | null | undefined): string {
  if (!categoria) return '—';
  return TEMPLATE_CATEGORY_LABELS[categoria.toUpperCase()] ?? categoria;
}

const LANGUAGE_LABELS: Record<string, string> = {
  pt_BR: 'Português (BR)',
  pt_PT: 'Português (PT)',
  en_US: 'Inglês (EUA)',
  en: 'Inglês',
  es: 'Espanhol',
  es_ES: 'Espanhol (ES)',
};

export function idiomaLabel(codigo: string | null | undefined): string {
  if (!codigo) return '—';
  return LANGUAGE_LABELS[codigo] ?? codigo;
}
