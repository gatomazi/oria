import { Button, Field, Input, Select, Toolbar } from '../../components/ds';
import { adminStores } from '../../state/adminStores';
import { PERIODOS_GA4, type PeriodoGa4 } from '../../lib/ga4';

interface Ga4ToolbarProps {
  label: string;
  lojasConectadas: string[];
  loja: string;
  onLoja: (loja: string) => void;
  periodo: PeriodoGa4;
  onPeriodo: (periodo: PeriodoGa4) => void;
  inicio: string;
  onInicio: (v: string) => void;
  fim: string;
  onFim: (v: string) => void;
  atualizando: boolean;
  onAtualizar: () => void;
  podeAtualizar: boolean;
}

// Filtros compartilhados das telas de GA4 (loja conectada + período + atualizar agora), pra as duas
// telas não divergirem nos rótulos nem no comportamento do período personalizado.
export function Ga4Toolbar({
  label, lojasConectadas, loja, onLoja, periodo, onPeriodo, inicio, onInicio, fim, onFim,
  atualizando, onAtualizar, podeAtualizar,
}: Ga4ToolbarProps) {
  return (
    <Toolbar
      label={label}
      end={
        <Button variant="secondary" onClick={onAtualizar} disabled={!podeAtualizar || atualizando}>
          {atualizando ? 'Atualizando…' : 'Atualizar agora'}
        </Button>
      }
    >
      {/* Com uma loja conectada só, um <select> de opção única seria um controle morto: o nome vira
          texto, que informa qual loja está sendo lida sem fingir que há escolha. */}
      {lojasConectadas.length > 1 ? (
        <Select aria-label="Loja" value={loja} onChange={(e) => onLoja(e.target.value)}>
          {lojasConectadas.map((id) => (
            <option key={id} value={id}>{adminStores.name(id)}</option>
          ))}
        </Select>
      ) : (
        <span className="ds-status-linha__meta">{adminStores.name(loja)}</span>
      )}
      <Select aria-label="Período" value={periodo} onChange={(e) => onPeriodo(e.target.value as PeriodoGa4)}>
        {PERIODOS_GA4.map((p) => (
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
