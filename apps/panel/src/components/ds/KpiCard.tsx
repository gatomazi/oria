import { MiniSparkline } from './MiniSparkline';

// Célula de KPI dentro de <KpiStrip> (DESIGN.md › KPI Strip). `icon` é o miolo de um <svg> 24x24
// (ver icons.ts) e sai monocromático. `tone` é mantido por compatibilidade e não pinta mais nada:
// a cor fica só no delta (subiu/caiu), que é o único dado semântico da célula.
export type KpiTone = 'success' | 'info' | 'warning' | 'danger' | 'premium';

interface KpiCardProps {
  title: string;
  value: string | number | null | undefined;
  helper?: string;
  delta?: string;
  trend?: 'up' | 'down';
  icon?: string;
  /** @deprecated sem efeito visual — ver comentário acima */
  tone?: KpiTone;
  // Série real opcional (ex: últimos N dias) — só passe quando houver dado real o bastante pra
  // desenhar uma linha (2+ pontos); não fabricar série pra preencher a célula.
  sparkline?: number[];
}

export function KpiCard({ title, value, helper, delta, trend, icon, sparkline }: KpiCardProps) {
  // Estado em palavra ("Indisponível", "Conectado") não é número: sai em tamanho de texto, sem cortar.
  const textual = typeof value === 'string' && value.length > 1 && !/\d/.test(value);
  return (
    <div className="ds-kpi">
      <p className="ds-kpi__title">
        {icon && (
          <svg
            className="ds-kpi__icon"
            viewBox="0 0 24 24"
            width={16}
            height={16}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: icon }}
          />
        )}
        <span className="ds-kpi__title-text">{title}</span>
        {sparkline && sparkline.length > 1 && (
          <span className="ds-kpi__sparkline" aria-hidden="true">
            <MiniSparkline values={sparkline} />
          </span>
        )}
      </p>
      <div className="ds-kpi__value-row">
        <strong className={['ds-kpi__value', textual ? 'ds-kpi__value--texto' : null].filter(Boolean).join(' ')}>{value != null ? String(value) : '—'}</strong>
      </div>
      {(delta || helper) && (
        <div className="ds-kpi__footer-row">
          {delta && <span className={`ds-kpi__delta ds-kpi__delta--${trend === 'down' ? 'down' : 'up'}`}>{delta}</span>}
          {helper && <p className="ds-kpi__helper">{helper}</p>}
        </div>
      )}
    </div>
  );
}
