import type { ReactNode } from 'react';

// Faixa de KPIs (DESIGN.md › KPI Strip): um painel só, dividido em células por divisórias finas,
// em vez de N cards soltos. Cada filho é um <KpiCard>. `label` nomeia o grupo pra leitor de tela.
export function KpiStrip({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={['ds-kpi-strip', className].filter(Boolean).join(' ')} role="group" aria-label={label}>
      {children}
    </div>
  );
}
