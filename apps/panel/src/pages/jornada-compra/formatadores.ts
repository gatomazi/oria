import type { AvailabilityStatus } from '../../api/journeyAnalytics';
import type { Tone } from '../../components/ds';

// Rodada L §2.2: toda camada da Jornada devolve esta taxonomia normalizada — a tela decide o texto
// certo por ESTE campo, nunca tentando interpretar `reason` (que é diagnóstico/debug, não UI).
export const STATUS_LABEL: Record<AvailabilityStatus, string> = {
  available: 'Disponível',
  not_connected: 'Não conectado',
  unsupported: 'Não suportado por esta propriedade/conta',
  insufficient_data: 'Sem dado suficiente no período',
  not_verified: 'Não verificado',
  temporary_failure: 'Falha temporária — tente novamente',
};

export function statusTone(status: AvailabilityStatus): Tone {
  switch (status) {
    case 'available':
      return 'success';
    case 'not_connected':
      return 'neutral';
    case 'unsupported':
    case 'not_verified':
      return 'warning';
    case 'insufficient_data':
      return 'info';
    case 'temporary_failure':
      return 'danger';
    default:
      return 'neutral';
  }
}
