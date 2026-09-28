import type { ReactNode } from 'react';
import { Button, Input, Select, StatusBadge } from '../../components/ds';
import {
  EXPLICACAO_DATAS, ROTULOS_DE_PERIODO, ROTULOS_SAUDE, dataCurta, intervaloDoPreset, type PresetDePeriodo,
} from '../../lib/parcerias';

// Peças compartilhadas das telas de Parcerias. Sem regra de negócio: só apresentação.

export function Saude({ flags }: { flags: string[] }) {
  if (!flags.length) return <span className="pa-muted">Sem pendências</span>;
  return (
    <span className="pa-badges">
      {flags.map((f) => {
        const r = ROTULOS_SAUDE[f] ?? { label: f, tone: 'neutral' as const };
        return <StatusBadge key={f} tone={r.tone} label={r.label} />;
      })}
    </span>
  );
}

export function Definicao({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="pa-kv__item">
      <dt>{rotulo}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// Filtro de período + tipo de data, sempre EXPLÍCITO: mostra o período ativo, o fuso da loja e o significado do tipo de data escolhido.
export interface EstadoDePeriodo { range: string; from: string; to: string; dateType: string }

interface FiltroDePeriodoProps<D extends string> {
  estado: EstadoDePeriodo;
  tz: string;
  tiposDeData: Record<D, string>;
  explicacoes?: Partial<Record<D, string>>;
  onChange: (patch: Partial<EstadoDePeriodo>) => void;
  onLimpar: () => void;
  ativos: number;
  children?: ReactNode;
  fim?: ReactNode;
}

export function FiltroDePeriodo<D extends string>({ estado, tz, tiposDeData, explicacoes, onChange, onLimpar, ativos, children, fim }: FiltroDePeriodoProps<D>) {
  const preset = (estado.range || '30d') as PresetDePeriodo;
  const rotuloAtivo = estado.from && estado.to ? `${dataCurta(`${estado.from}T12:00:00Z`, 'UTC')} a ${dataCurta(`${estado.to}T12:00:00Z`, 'UTC')}` : ROTULOS_DE_PERIODO[preset] ?? '';
  const explicacao = explicacoes ? (explicacoes as Record<string, string>)[estado.dateType] : EXPLICACAO_DATAS[estado.dateType as keyof typeof EXPLICACAO_DATAS];

  function escolherPreset(v: PresetDePeriodo) {
    if (v === 'custom') {
      const base = estado.from && estado.to ? { from: estado.from, to: estado.to } : intervaloDoPreset('30d', tz);
      onChange({ range: 'custom', ...base });
    } else {
      const { from, to } = intervaloDoPreset(v, tz);
      onChange({ range: v, from, to });
    }
  }

  return (
    <div className="pa-filtros">
      <div className="ds-toolbar" role="search" aria-label="Filtros de período">
        <Select aria-label="Período" controlSize="sm" value={preset} onChange={(e) => escolherPreset(e.target.value as PresetDePeriodo)}>
          {(Object.keys(ROTULOS_DE_PERIODO) as PresetDePeriodo[]).map((p) => <option key={p} value={p}>{ROTULOS_DE_PERIODO[p]}</option>)}
        </Select>
        {preset === 'custom' && (
          <>
            <Input type="date" controlSize="sm" aria-label="De" value={estado.from} max={estado.to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
            <Input type="date" controlSize="sm" aria-label="Até" value={estado.to} min={estado.from || undefined} onChange={(e) => onChange({ to: e.target.value })} />
          </>
        )}
        <Select aria-label="Tipo de data" controlSize="sm" value={estado.dateType} onChange={(e) => onChange({ dateType: e.target.value })}>
          {(Object.keys(tiposDeData) as D[]).map((d) => <option key={d} value={d}>{tiposDeData[d]}</option>)}
        </Select>
        {children}
        <div className="ds-toolbar__end">
          {fim}
          {ativos > 0 && <Button variant="ghost" size="sm" onClick={onLimpar}>Limpar filtros ({ativos})</Button>}
        </div>
      </div>
      <p className="pa-periodo" aria-live="polite">
        <strong>Período:</strong> {rotuloAtivo} · <strong>Tipo de data:</strong> {tiposDeData[estado.dateType as D] ?? estado.dateType} · fuso {tz}
        {explicacao ? <span className="pa-muted"> — {explicacao}</span> : null}
      </p>
    </div>
  );
}
