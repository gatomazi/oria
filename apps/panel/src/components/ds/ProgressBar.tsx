// Progresso determinado (DESIGN.md › Loading State › Progresso): trilho surface-2, preenchimento
// por transform (sem animar width), rótulo acessível via role="progressbar".
interface ProgressBarProps {
  value: number;
  max?: number;
  label: string;
  tone?: 'accent' | 'info' | 'danger';
  showValue?: boolean;
}

export function ProgressBar({ value, max = 100, label, tone = 'accent', showValue }: ProgressBarProps) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="ds-progress">
      <div
        className={`ds-progress__track ds-progress__track--${tone}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.round(value)}
      >
        <span className="ds-progress__fill" style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      {showValue && <span className="ds-progress__value ds-num">{Math.round(pct)}%</span>}
    </div>
  );
}
