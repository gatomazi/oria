import type { AvailabilityStatus, Opportunity, OpportunityType } from '../../api/journeyAnalytics';
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

// Gate C ("Jornada de Valor") · "Prioridades de hoje" — título curto por tipo de sinal (nunca o
// código técnico visível pro lojista, ver §5.6 do comando) e a linha de evidência numérica.
// `evidence`/`hypothesis`/`suggestedAction` vêm prontos de opportunity-diagnostics.js; aqui só
// formata número pra pt-BR, nunca reinterpreta o número nem soma nada.
export const OPORTUNIDADE_TITULO: Record<OpportunityType, string> = {
  low_view_to_cart: 'Interesse não vira carrinho',
  low_cart_to_checkout: 'Carrinho não avança pro checkout',
  low_checkout_to_purchase: 'Checkout não vira compra',
  units_divergent_ga4_commerce: 'GA4 e Commerce divergem nas unidades',
  identity_coverage_low: 'Catálogo com identidade incompleta',
};

function pct(v: number): string {
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}
function num(v: number): string {
  return v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

export function formatarEvidencia(op: Opportunity): string {
  const e = op.evidence;
  switch (op.type) {
    case 'low_view_to_cart':
      return `${num(e.itemsViewed)} visualizações · ${pct(e.itemsAddedToCartPerItemViewed)} viraram carrinho (mediana da Store: ${pct(e.storeBaseline)})`;
    case 'low_cart_to_checkout':
      return `${num(e.itemsAddedToCart)} no carrinho · ${pct(e.itemsCheckedOutPerItemAddedToCart)} avançaram pro checkout (mediana da Store: ${pct(e.storeBaseline)})`;
    case 'low_checkout_to_purchase':
      return `${num(e.itemsCheckedOut)} em checkout · ${pct(e.itemsPurchasedPerItemCheckedOut)} viraram compra (mediana da Store: ${pct(e.storeBaseline)})`;
    case 'units_divergent_ga4_commerce':
      return `GA4 observou ${num(e.analyticsUnits)} unidade(s) · Commerce confirmou ${num(e.commerceUnits)} unidade(s) paga(s) em ${num(e.paidOrdersDistinct)} pedido(s)`;
    case 'identity_coverage_low':
      return `${num(e.unmatchedAnalyticsIds)} de ${num(e.observedAnalyticsIds)} itemIds do GA4 sem produto identificado (${pct(e.coverageRate)} de cobertura)`;
    default:
      return '';
  }
}

export const CONFIANCA_LABEL: Record<Opportunity['confidence'], string> = {
  alta: 'Confiança alta',
  media: 'Confiança média',
  baixa: 'Confiança baixa',
};
export function confiancaTone(c: Opportunity['confidence']): Tone {
  return c === 'alta' ? 'success' : c === 'media' ? 'info' : 'neutral';
}
