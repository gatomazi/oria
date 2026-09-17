import { PERIODOS, type PeriodoId } from './dashboardData';

interface Props {
  value: PeriodoId;
  onChange: (value: PeriodoId) => void;
}

export function DashboardPeriodSelect({ value, onChange }: Props) {
  return (
    <select className="ds-select ad-periodo-select" aria-label="Período" value={value} onChange={(e) => onChange(e.target.value as PeriodoId)}>
      {PERIODOS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </select>
  );
}
