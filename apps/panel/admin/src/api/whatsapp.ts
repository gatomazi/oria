import { api } from './client';

export interface WhatsappVisaoGeral {
  servicoIndisponivel?: boolean;
  stats?: { sent: number; received: number; errors: number };
  pendingQueue?: number;
  connected: boolean;
  // Número da integração da Organization (nunca do serviço de envio).
  phoneNumberId?: string | null;
  templatesAprovados?: number | null;
  automacoesAtivas: number;
}

export function getVisaoGeral() {
  return api<WhatsappVisaoGeral>('/api/admin/whatsapp/visao-geral');
}
