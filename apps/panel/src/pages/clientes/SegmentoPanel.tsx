import { Button, Callout } from '../../components/ds';
import type { ResumoClientes, SegmentoResumo } from '../../api/clientes';
import { formatValor } from '../../lib/format';
import { GrupoBadge } from './RfmMatriz';
import { decimal, descreverPredicado, numero, pct } from './rfmTexto';
import { rotuloCorte } from './AvisoSegmentoRfm';

interface Props {
  rfm: ResumoClientes['rfm'];
  selecionados: SegmentoResumo[];
  criando: boolean;
  onCriarCampanha: (s: SegmentoResumo) => void;
  onVerClientes: () => void;
  onExportar: () => void;
  onLimpar: () => void;
}

function Par({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="cli-par">
      <dt>{rotulo}</dt>
      <dd>{valor}</dd>
    </div>
  );
}

// Detalhe do(s) segmento(s) selecionado(s): definição REAL (a regra numérica que o servidor usa), números, hipótese de
// campanha e as ações. A ação primária só vale para um segmento por vez (a definição salva é uma regra, não uma união).
export function SegmentoPanel({ rfm, selecionados, criando, onCriarCampanha, onVerClientes, onExportar, onLimpar }: Props) {
  if (!selecionados.length) {
    return (
      <aside className="cli-detalhe cli-detalhe--vazio" aria-live="polite">
        <h3 className="cli-detalhe__titulo">Selecione um segmento</h3>
        <p className="cli-detalhe__texto">
          Clique na matriz ou na legenda para ver a regra do segmento, quantas pessoas ele reúne e criar uma campanha. Dá para marcar vários e comparar; a lista abaixo passa a mostrar só esse público.
        </p>
        <p className="cli-detalhe__nota">
          Classificação <strong>{rfm.regraVersao}</strong> em {new Date(rfm.classificadoEm).toLocaleDateString('pt-BR', { timeZone: rfm.fuso })}, sobre {numero(rfm.universo)} clientes com compra válida. Janela de frequência: {rfm.janelaFrequenciaDias} dias.
        </p>
      </aside>
    );
  }

  const unico = selecionados.length === 1 ? selecionados[0] : null;
  const clientes = selecionados.reduce((acc, s) => acc + s.clientes, 0);
  const receita = selecionados.reduce((acc, s) => acc + s.receita, 0);
  const pedidos = selecionados.reduce((acc, s) => acc + s.pedidos, 0);
  const pctBase = selecionados.reduce((acc, s) => acc + s.pctBase, 0);
  const pctReceita = selecionados.reduce((acc, s) => acc + s.pctReceita, 0);

  return (
    <aside className="cli-detalhe" aria-live="polite">
      <div className="cli-detalhe__cabecalho">
        <div>
          <h3 className="cli-detalhe__titulo">{unico ? unico.nome : `${selecionados.length} segmentos selecionados`}</h3>
          {unico && <GrupoBadge id={unico.id} />}
        </div>
        <Button variant="ghost" size="sm" onClick={onLimpar}>Limpar seleção</Button>
      </div>

      {unico ? <p className="cli-detalhe__texto">{unico.descricao}</p> : <p className="cli-detalhe__texto">{selecionados.map((s) => s.nome).join(' · ')}</p>}

      {unico?.predicado && (
        <dl className="cli-regra" aria-label={`Regra do segmento ${unico.nome}`}>
          {descreverPredicado(unico.predicado).map((l) => <Par key={l.rotulo} rotulo={l.rotulo} valor={l.texto} />)}
        </dl>
      )}

      <dl className="cli-numeros">
        <Par rotulo="Pessoas" valor={numero(clientes)} />
        <Par rotulo="% da base" valor={pct(pctBase)} />
        <Par rotulo="% da receita" valor={pct(pctReceita)} />
        <Par rotulo="Pedidos por cliente" valor={clientes ? decimal(pedidos / clientes) : '—'} />
        <Par rotulo="Ticket médio" valor={pedidos ? (formatValor(receita / pedidos) ?? '—') : '—'} />
        <Par rotulo="Receita" valor={formatValor(receita) ?? '—'} />
        {unico && <Par rotulo="Recência (mediana)" valor={unico.recenciaMedianaDias == null ? '—' : `${numero(unico.recenciaMedianaDias)} dias`} />}
      </dl>

      {unico?.hipotese && (
        <p className="cli-detalhe__hipotese"><strong>Hipótese de campanha:</strong> {unico.hipotese} <span>É uma sugestão, não prova de intenção de compra.</span></p>
      )}

      <div className="cli-detalhe__acoes">
        {unico ? (
          <Button onClick={() => onCriarCampanha(unico)} disabled={criando}>{criando ? 'Criando segmento…' : 'Criar campanha com este segmento'}</Button>
        ) : (
          <Callout tone="info">Para criar uma campanha, selecione um segmento por vez: o segmento salvo é uma regra única.</Callout>
        )}
        <div className="cli-detalhe__secundarias">
          <Button variant="secondary" size="sm" onClick={onVerClientes}>Ver clientes</Button>
          <Button variant="secondary" size="sm" onClick={onExportar}>Exportar</Button>
        </div>
      </div>
      {unico && (
        <p className="cli-detalhe__nota">
          O segmento salvo tem <strong>pessoas dinâmicas</strong> (a audiência é reavaliada a cada uso) e <strong>corte de valor fixado</strong>
          {unico.predicado?.valor ? ` em ${rotuloCorte({ metrica: unico.predicado.valor.metrica ?? 'ltv_janela', valor: (unico.predicado.valor.min ?? unico.predicado.valor.maxExclusivo) as number, sentido: unico.predicado.valor.min != null ? 'a_partir_de' : 'abaixo_de' })} (P{Math.round((rfm.configuracao?.percentilValorAlto ?? 0.75) * 100)} de {new Date(rfm.classificadoEm).toLocaleDateString('pt-BR', { timeZone: rfm.fuso })})` : ' (este segmento não usa corte de valor)'}
          , regra {rfm.regraVersao}. Se novos pedidos moverem o percentil, o segmento salvo mantém o corte até você criar outro; a Audiência mostra a divergência. Elegibilidade por canal (opt-in, número válido) é conferida na campanha.
        </p>
      )}
    </aside>
  );
}
