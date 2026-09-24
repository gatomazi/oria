import type { ProductAnalyticsDiagnostic } from '../../api/productAnalytics';
import type { Tone } from '../../components/ds';

// `itemRatios` são razões entre CONTAGENS DE ITEM — nunca taxa de conversão de usuário/sessão
// (rodada H→I, §H.3). Formatados como percentual (fração de item para item), nunca renomeados.
export function formatarRazao(v: number | null): string {
  if (v == null) return '—';
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

export const DIAGNOSTICO_LABEL: Record<ProductAnalyticsDiagnostic | string, string> = {
  unmatched_identity: 'Identidade não resolvida',
  multiple_analytics_identities: 'Múltiplos ids somados',
  metric_unavailable: 'Métrica indisponível na propriedade',
  insufficient_data: 'Sem dado no período',
};

export function diagnosticoTone(diagnostico: string): Tone {
  switch (diagnostico) {
    case 'unmatched_identity':
    case 'insufficient_data':
      return 'warning';
    case 'metric_unavailable':
      return 'neutral';
    case 'multiple_analytics_identities':
      return 'info';
    default:
      return 'neutral';
  }
}
