// Porte de statusBadge() em components.js. Emparelha com src/admin/design-system/status-map.js
// (portado em Fase 3, por recurso, conforme cada página é migrada).
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'premium';

export function StatusBadge({ tone = 'neutral', label }: { tone?: Tone; label: string }) {
  return <span className={`ds-badge ds-badge--${tone}`}>{label}</span>;
}
