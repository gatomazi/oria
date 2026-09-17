// Tema dos gráficos (DESIGN.md › Charts): uma fonte só pra cores, eixos, grade e formatação, em vez
// de cada gráfico escolher a sua. Cores sempre por token CSS (var(--…)) — o Recharts repassa pro SVG.

export const CHART = {
  serie: 'var(--info)',
  // Lucro é resultado positivo da operação — verde operacional, não uma cor de série decorativa.
  lucro: 'var(--success)',
  comparacao: 'var(--chart-neutral)',
  grade: 'var(--border-subtle)',
  eixo: 'var(--border-default)',
  cursor: 'var(--surface-2)',
  tick: { fill: 'var(--text-muted)', fontSize: 11 },
} as const;

// Status de pedido por estágio, no tom semântico do statusMap: pago/entregue `success`, estágios em
// andamento `info` (com opacidade decrescente pra distinguir fatias vizinhas), sem cor decorativa.
export const CORES_ESTAGIO: Record<string, { cor: string; opacidade: number }> = {
  pago: { cor: 'var(--success)', opacidade: 0.55 },
  producao: { cor: 'var(--info)', opacidade: 1 },
  despachado: { cor: 'var(--info)', opacidade: 0.72 },
  transito: { cor: 'var(--info)', opacidade: 0.5 },
  entrega: { cor: 'var(--info)', opacidade: 0.32 },
  entregue: { cor: 'var(--success)', opacidade: 1 },
};

// "1,6 mil", "12 mil", "850" — mesma ideia da moeda curta, pra eixo de contagem (sessões, visitas)
// onde o número cheio ("49.438") não cabe na faixa do eixo e acaba cortado.
export function formatNumeroCurto(valor: number): string {
  if (!Number.isFinite(valor)) return '0';
  const abs = Math.abs(valor);
  if (abs >= 1_000_000) return `${(valor / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1_000) return `${(valor / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return Math.round(valor).toLocaleString('pt-BR');
}

// "R$ 1,6 mil", "R$ 12 mil", "R$ 850" — rótulo de eixo curto (o valor exato fica no tooltip).
export function formatMoedaCurta(valor: number): string {
  if (!Number.isFinite(valor)) return 'R$ 0';
  const abs = Math.abs(valor);
  if (abs >= 1_000_000) return `R$ ${(valor / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1_000) return `R$ ${(valor / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return `R$ ${Math.round(valor).toLocaleString('pt-BR')}`;
}
