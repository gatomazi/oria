import { Button, Field, Input, Select, Toolbar } from '../../components/ds';
import { PERIODOS_META, type PeriodoMeta } from '../../lib/meta';

interface MetaToolbarProps {
  label: string;
  periodo: PeriodoMeta;
  onPeriodo: (p: PeriodoMeta) => void;
  inicio: string;
  onInicio: (v: string) => void;
  fim: string;
  onFim: (v: string) => void;
  atualizando: boolean;
  onAtualizar: () => void;
  podeAtualizar: boolean;
}

// Filtros compartilhados pelas abas do Meta Ads — mesma anatomia da Ga4Toolbar, pra as duas telas
// de analytics não divergirem no comportamento do período personalizado.
export function MetaToolbar({
  label, periodo, onPeriodo, inicio, onInicio, fim, onFim, atualizando, onAtualizar, podeAtualizar,
}: MetaToolbarProps) {
  return (
    <Toolbar
      label={label}
      end={
        <Button variant="secondary" onClick={onAtualizar} disabled={!podeAtualizar || atualizando}>
          {atualizando ? 'Atualizando…' : 'Atualizar'}
        </Button>
      }
    >
      <Select aria-label="Período" value={periodo} onChange={(e) => onPeriodo(e.target.value as PeriodoMeta)}>
        {PERIODOS_META.map((p) => (
          <option key={p.valor} value={p.valor}>{p.rotulo}</option>
        ))}
      </Select>
      {periodo === 'custom' && (
        <>
          <Field label="De">
            <Input type="date" value={inicio} onChange={(e) => onInicio(e.target.value)} max={fim || undefined} />
          </Field>
          <Field label="Até">
            <Input type="date" value={fim} onChange={(e) => onFim(e.target.value)} min={inicio || undefined} />
          </Field>
        </>
      )}
    </Toolbar>
  );
}
