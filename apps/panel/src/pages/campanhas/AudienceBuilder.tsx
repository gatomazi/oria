import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Field, Input } from '../../components/ds';
import {
  previewAudiencia,
  UF_OPCOES,
  type AudienciaCampo,
  type AudienciaExclusoes,
  type AudienciaFiltro,
  type AudienciaFiltroRfmValor,
  type AudienciaOperador,
  type AudienciaPreviewResultado,
} from '../../api/campanhas';
import { AudienciaResumo, AvisoCorteDaAudiencia, RfmFiltroCard } from './AudienciaResumo';

// Construtor de audiência compartilhado entre Segmentos (Fase 3) e a Etapa 2 do wizard de Nova
// Campanha (Fase 4) — mesma UI, mesmo contrato de filtro/exclusão, só o estado é controlado por
// quem usa (segmento salva direto; campanha guarda no rascunho até a revisão final).

const CAMPO_LABEL: Record<AudienciaCampo, string> = {
  diasSemComprar: 'Dias desde a última compra',
  quantidadePedidos: 'Quantidade de pedidos',
  totalGasto: 'Total gasto (R$)',
  ticketMedio: 'Ticket médio (R$)',
  uf: 'Estado (UF) do cliente',
  optIn: 'Opt-in de marketing',
  temCarrinhoAbandonado: 'Tem carrinho abandonado',
  recebeuCampanha: 'Já recebeu a campanha',
  naoRecebeuCampanha: 'Nunca recebeu a campanha',
  recebeuCampanhaNosUltimosDias: 'Recebeu campanha nos últimos X dias',
  // Não aparece na lista de campos: o segmento RFM vem de Clientes e é exibido em cartão próprio (somente leitura).
  rfm: 'Segmento RFM',
};

const CAMPOS_NUMERICOS: AudienciaCampo[] = ['diasSemComprar', 'quantidadePedidos', 'totalGasto', 'ticketMedio'];
const CAMPOS_BOOLEANOS: AudienciaCampo[] = ['optIn', 'temCarrinhoAbandonado'];

const OPERADOR_LABEL: Record<AudienciaOperador, string> = {
  gt: 'maior que', gte: 'maior ou igual a', lt: 'menor que', lte: 'menor ou igual a', eq: 'igual a',
};

export interface FiltroForm {
  field: AudienciaCampo;
  op: AudienciaOperador;
  value: string;
}

export function filtroFormVazio(): FiltroForm {
  return { field: 'diasSemComprar', op: 'gte', value: '' };
}

// "59,6" (vírgula decimal, comum em input brasileiro) vira NaN em Number() puro — antes disso
// filtroFormParaApi descartava o filtro inteiro em silêncio (audiência calculada sem ele, sem
// nenhum aviso), o que é perigoso: um filtro "sumindo" pode alcançar gente que não devia.
function parseNumeroBr(valor: string): number {
  return Number(valor.trim().replace(',', '.'));
}

function filtroFormParaApi(f: FiltroForm): AudienciaFiltro | null {
  if (CAMPOS_NUMERICOS.includes(f.field)) {
    const n = parseNumeroBr(f.value);
    if (!f.value.trim() || Number.isNaN(n)) return null;
    return { field: f.field, op: f.op, value: n };
  }
  if (CAMPOS_BOOLEANOS.includes(f.field)) {
    return { field: f.field, value: f.value !== 'false' };
  }
  if (f.field === 'recebeuCampanhaNosUltimosDias') {
    const n = parseNumeroBr(f.value);
    if (!f.value.trim() || Number.isNaN(n)) return null;
    return { field: f.field, value: { dias: n } };
  }
  if (f.field === 'uf') {
    if (!f.value.trim()) return null;
    return { field: f.field, value: f.value.trim().toUpperCase() };
  }
  if (!f.value.trim()) return null;
  return { field: f.field, value: { campanhaId: f.value.trim() } };
}

export interface AudienceState {
  match: 'ALL' | 'ANY';
  // Segmento de origem RFM: condição OBRIGATÓRIA (vale mesmo com "Qualquer condição"), avaliada pelo servidor com a mesma
  // classificação da matriz de Clientes. Somente leitura aqui: nunca vira uma linha de texto que possa ser descartada.
  rfm: AudienciaFiltroRfmValor | null;
  filtros: FiltroForm[];
  semOptIn: boolean;
  numeroInvalido: boolean;
  compradoNosUltimosDias: string;
  recebeuCampanhaNasUltimasHoras: string;
}

export function audienceStateVazio(): AudienceState {
  return {
    match: 'ALL',
    rfm: null,
    filtros: [filtroFormVazio()],
    semOptIn: true,
    numeroInvalido: true,
    compradoNosUltimosDias: '',
    recebeuCampanhaNasUltimasHoras: '',
  };
}

export function audienceStateDeSalvo(match: 'ALL' | 'ANY', filtros: AudienciaFiltro[], exclusoes: AudienciaExclusoes): AudienceState {
  const filtroRfm = filtros.find((f) => f.field === 'rfm');
  const demais = filtros.filter((f) => f.field !== 'rfm');
  return {
    match,
    rfm: filtroRfm ? (filtroRfm.value as AudienciaFiltroRfmValor) : null,
    // Com segmento RFM e sem condições adicionais não há linha vazia: o cartão do segmento já é a audiência.
    filtros: demais.length
      ? demais.map((f) => ({
          field: f.field,
          op: (f.op as AudienciaOperador) || 'gte',
          value:
            typeof f.value === 'object' && f.value
              ? String((f.value as Record<string, unknown>).campanhaId ?? (f.value as Record<string, unknown>).dias ?? '')
              : String(f.value ?? ''),
        }))
      : filtroRfm ? [] : [filtroFormVazio()],
    semOptIn: exclusoes.semOptIn !== false,
    numeroInvalido: exclusoes.numeroInvalido !== false,
    compradoNosUltimosDias: exclusoes.compradoNosUltimosDias != null ? String(exclusoes.compradoNosUltimosDias) : '',
    recebeuCampanhaNasUltimasHoras: exclusoes.recebeuCampanhaNasUltimasHoras != null ? String(exclusoes.recebeuCampanhaNasUltimasHoras) : '',
  };
}

export function audienceStateParaApi(s: AudienceState): { match: 'ALL' | 'ANY'; filtros: AudienciaFiltro[]; exclusoes: AudienciaExclusoes } {
  return {
    match: s.match,
    filtros: [
      ...(s.rfm ? [{ field: 'rfm' as const, op: 'segmento' as unknown as AudienciaOperador, value: s.rfm }] : []),
      ...s.filtros.map(filtroFormParaApi).filter((f): f is AudienciaFiltro => f !== null),
    ],
    exclusoes: {
      semOptIn: s.semOptIn,
      numeroInvalido: s.numeroInvalido,
      compradoNosUltimosDias: s.compradoNosUltimosDias.trim() ? Number(s.compradoNosUltimosDias) : null,
      recebeuCampanhaNasUltimasHoras: s.recebeuCampanhaNasUltimasHoras.trim() ? Number(s.recebeuCampanhaNasUltimasHoras) : null,
    },
  };
}

function FiltroRow({ filtro, onChange, onRemove }: { filtro: FiltroForm; onChange: (f: FiltroForm) => void; onRemove: () => void }) {
  const numerico = CAMPOS_NUMERICOS.includes(filtro.field);
  const booleano = CAMPOS_BOOLEANOS.includes(filtro.field);
  return (
    <div className="ad-filtro-row">
      <select className="ds-select" aria-label="Campo do filtro" value={filtro.field} onChange={(e) => onChange({ ...filtroFormVazio(), field: e.target.value as AudienciaCampo })}>
        {Object.entries(CAMPO_LABEL).filter(([valor]) => valor !== 'rfm').map(([valor, label]) => (
          <option key={valor} value={valor}>{label}</option>
        ))}
      </select>
      {numerico && (
        <select className="ds-select" aria-label="Operador" value={filtro.op} onChange={(e) => onChange({ ...filtro, op: e.target.value as AudienciaOperador })}>
          {Object.entries(OPERADOR_LABEL).map(([valor, label]) => (
            <option key={valor} value={valor}>{label}</option>
          ))}
        </select>
      )}
      {booleano ? (
        <select className="ds-select" aria-label="Valor do filtro" value={filtro.value || 'true'} onChange={(e) => onChange({ ...filtro, value: e.target.value })}>
          <option value="true">Sim</option>
          <option value="false">Não</option>
        </select>
      ) : filtro.field === 'uf' ? (
        <select className="ds-select" aria-label="UF" value={filtro.value} onChange={(e) => onChange({ ...filtro, value: e.target.value })}>
          <option value="">selecione a UF</option>
          {UF_OPCOES.map((uf) => (
            <option key={uf} value={uf}>{uf}</option>
          ))}
        </select>
      ) : (
        <Input
          type={numerico || filtro.field === 'recebeuCampanhaNosUltimosDias' ? 'number' : 'text'}
          placeholder={filtro.field === 'recebeuCampanha' || filtro.field === 'naoRecebeuCampanha' ? 'ID da campanha' : 'valor'}
          value={filtro.value}
          onChange={(e) => onChange({ ...filtro, value: e.target.value })}
        />
      )}
      <Button variant="ghost" onClick={onRemove}>Remover</Button>
    </div>
  );
}

interface AudienceBuilderProps {
  loja: string;
  state: AudienceState;
  onChange: (s: AudienceState) => void;
  onPreview?: (p: AudienciaPreviewResultado | null) => void;
}

export function AudienceBuilder({ loja, state, onChange, onPreview }: AudienceBuilderProps) {
  const [preview, setPreview] = useState<AudienciaPreviewResultado | null>(null);
  const [previewErro, setPreviewErro] = useState('');
  const [previewCarregando, setPreviewCarregando] = useState(false);

  const apiPayload = useMemo(() => audienceStateParaApi(state), [state]);

  useEffect(() => {
    // `vigente` descarta respostas de uma configuração que já não é a atual (troca rápida de filtro, resposta lenta ou fora de
    // ordem): a tela nunca mostra a contagem de um filtro antigo sob o filtro novo.
    let vigente = true;
    const timer = setTimeout(() => {
      setPreviewCarregando(true);
      setPreviewErro('');
      previewAudiencia(apiPayload.match, apiPayload.filtros, apiPayload.exclusoes)
        .then((r) => {
          if (!vigente) return;
          setPreview(r);
          onPreview?.(r);
        })
        .catch((err: Error) => {
          if (!vigente) return;
          setPreview(null);
          setPreviewErro(err.message);
          onPreview?.(null);
        })
        .finally(() => { if (vigente) setPreviewCarregando(false); });
    }, 400);
    return () => { vigente = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loja, apiPayload.match, JSON.stringify(apiPayload.filtros), JSON.stringify(apiPayload.exclusoes)]);

  return (
    <div className="ad-segmento-form">
      {state.rfm && <RfmFiltroCard filtro={state.rfm} preview={preview} />}
      {state.rfm && <AvisoCorteDaAudiencia preview={preview} />}

      <Field label={state.rfm ? 'Condições adicionais' : 'Quem deve receber?'} hint={state.rfm ? 'O segmento RFM acima vale sempre; estas condições atuam sobre ele.' : undefined}>
        <select className="ds-select" value={state.match} onChange={(e) => onChange({ ...state, match: e.target.value as 'ALL' | 'ANY' })}>
          <option value="ALL">Todas as condições</option>
          <option value="ANY">Qualquer condição</option>
        </select>
      </Field>

      <div className="ad-filtros-lista">
        {state.filtros.map((f, i) => (
          <FiltroRow
            key={i}
            filtro={f}
            onChange={(novo) => onChange({ ...state, filtros: state.filtros.map((p, idx) => (idx === i ? novo : p)) })}
            onRemove={() => onChange({ ...state, filtros: state.filtros.filter((_, idx) => idx !== i) })}
          />
        ))}
        <Button variant="secondary" onClick={() => onChange({ ...state, filtros: [...state.filtros, filtroFormVazio()] })}>
          + Adicionar filtro
        </Button>
      </div>

      <Card title="Exclusões" className="ad-segmento-exclusoes">
        <label className="ad-checkbox-row">
          <input type="checkbox" checked={state.semOptIn} onChange={(e) => onChange({ ...state, semOptIn: e.target.checked })} />
          Sem opt-in de marketing
        </label>
        <label className="ad-checkbox-row">
          <input type="checkbox" checked={state.numeroInvalido} onChange={(e) => onChange({ ...state, numeroInvalido: e.target.checked })} />
          Números inválidos/sem telefone
        </label>
        <Field label="Comprou nos últimos X dias (opcional)">
          <Input type="number" placeholder="ex: 7" value={state.compradoNosUltimosDias} onChange={(e) => onChange({ ...state, compradoNosUltimosDias: e.target.value })} />
        </Field>
        <Field label="Recebeu qualquer campanha nas últimas X horas (opcional)">
          <Input
            type="number"
            placeholder="ex: 48"
            value={state.recebeuCampanhaNasUltimasHoras}
            onChange={(e) => onChange({ ...state, recebeuCampanhaNasUltimasHoras: e.target.value })}
          />
        </Field>
      </Card>

      <AudienciaResumo preview={preview} carregando={previewCarregando} erro={previewErro} />
    </div>
  );
}
