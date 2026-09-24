import { Button, InfoTooltip } from '../../components/ds';
import type { EstadoSegmentoRfm, PredicadoRfm, ResumoClientes, SegmentoResumo } from '../../api/clientes';
import { formatValor } from '../../lib/format';
import { GrupoBadge } from './RfmExplorer';
import { GRUPOS_DESCRICAO } from './rfmDistribuicao';
import { estiloDe } from './rfmSegmentos';
import { decimal, numero, pct } from './rfmTexto';
import { rotuloCorte } from './AvisoSegmentoRfm';

const moeda = (v: number) => formatValor(v) ?? '—';
type Regra = ResumoClientes['rfm'];

// Critérios R/F/M do segmento, com os cortes EXATOS da regra vigente. Valor: informa qual medida é usada (soma na janela ou
// ticket) e que o corte é o percentil de hoje — nunca um R$ universal.
export function criteriosDoSegmento(p: PredicadoRfm | null, rfm: Regra): { chave: 'R' | 'F' | 'V'; rotulo: string; texto: string; nota?: string }[] {
  if (!p) return [];
  const r = p.recenciaDias;
  const recencia = r.max == null ? `há mais de ${numero(r.min - 1)} dias` : r.min === 0 ? `até ${numero(r.max)} dias atrás` : `entre ${numero(r.min)} e ${numero(r.max)} dias atrás`;
  const itens: { chave: 'R' | 'F' | 'V'; rotulo: string; texto: string; nota?: string }[] = [
    { chave: 'R', rotulo: 'Recência', texto: `Última compra ${recencia}` },
  ];
  if (p.frequencia) {
    const { min, max } = p.frequencia;
    const qtd = min != null && max != null ? (min === max ? `${min} ${min === 1 ? 'pedido' : 'pedidos'}` : `${min} a ${max} pedidos`) : min != null ? `${min} ou mais pedidos` : `até ${max} pedidos`;
    itens.push({ chave: 'F', rotulo: 'Frequência', texto: `${qtd} nos últimos ${numero(rfm.janelaFrequenciaDias)} dias` });
  } else {
    itens.push({ chave: 'F', rotulo: 'Frequência', texto: 'Qualquer (fora da janela de frequência)' });
  }
  if (p.valor) {
    const metrica = p.valor.metrica === 'ticket_medio' ? 'ticket médio por pedido' : `soma paga nos últimos ${numero(rfm.janelaFrequenciaDias)} dias`;
    const percentil = Math.round((rfm.configuracao?.percentilValorAlto ?? 0.75) * 100);
    itens.push({
      chave: 'V', rotulo: 'Valor',
      texto: `${metrica[0].toUpperCase()}${metrica.slice(1)} ${p.valor.min != null ? `a partir de ${moeda(p.valor.min)}` : `abaixo de ${moeda(p.valor.maxExclusivo ?? 0)}`}`,
      nota: `Corte vigente = P${percentil} da base em ${new Date(rfm.classificadoEm).toLocaleDateString('pt-BR', { timeZone: rfm.fuso })}; muda quando novos pedidos entram.`,
    });
  } else {
    itens.push({ chave: 'V', rotulo: 'Valor', texto: 'Não entra na regra deste segmento' });
  }
  return itens;
}

interface Props {
  rfm: Regra;
  selecionados: SegmentoResumo[];
  criando: boolean;
  estadosSalvos: EstadoSegmentoRfm[];
  onCriarCampanha: (s: SegmentoResumo) => void;
  onVerClientes: () => void;
  onExportar: () => void;
  onLimpar: () => void;
  // Sem nada selecionado: no desktop mostra uma dica; no celular não ocupa espaço.
  mostrarVazio: boolean;
}

function Estatistica({ rotulo, valor, sub }: { rotulo: string; valor: string; sub?: string }) {
  return (
    <div className="segp-estat">
      <dt>{rotulo}</dt>
      <dd><strong>{valor}</strong>{sub ? <span>{sub}</span> : null}</dd>
    </div>
  );
}

// Painel do segmento selecionado — leitura em ~10 s: quem é, quantos são, qual a regra, o que fazer.
export function SegmentoPanel({ rfm, selecionados, criando, estadosSalvos, onCriarCampanha, onVerClientes, onExportar, onLimpar, mostrarVazio }: Props) {
  if (!selecionados.length) {
    if (!mostrarVazio) return null;
    return (
      <aside className="segp segp--vazio" aria-label="Segmento selecionado">
        <h3 className="segp__titulo">Escolha um segmento</h3>
        <p className="segp__texto">Ao selecionar, aparecem aqui a regra exata (recência, frequência e valor), quantas pessoas entram e a ação para criar uma campanha. Dá para marcar vários e comparar.</p>
      </aside>
    );
  }

  const unico = selecionados.length === 1 ? selecionados[0] : null;
  const clientes = selecionados.reduce((a, s) => a + s.clientes, 0);
  const receita = selecionados.reduce((a, s) => a + s.receita, 0);
  const pedidos = selecionados.reduce((a, s) => a + s.pedidos, 0);
  const pctBase = selecionados.reduce((a, s) => a + s.pctBase, 0);
  const pctReceita = selecionados.reduce((a, s) => a + s.pctReceita, 0);
  const defasados = unico ? estadosSalvos.filter((e) => e.rfmSegmento === unico.id && e.divergente) : [];
  const dataClass = new Date(rfm.classificadoEm).toLocaleDateString('pt-BR', { timeZone: rfm.fuso });
  const grupo = unico ? estiloDe(unico.id).grupo : null;

  return (
    <aside className="segp" aria-label="Segmento selecionado" aria-live="polite">
      <header className="segp__topo">
        <div className="segp__ident">
          {unico ? <GrupoBadge id={unico.id} /> : null}
          <h3 className="segp__titulo">{unico ? unico.nome : `${selecionados.length} segmentos`}</h3>
          <p className="segp__texto">{unico ? (unico.descricao ?? '') : selecionados.map((s) => s.nome).join(' · ')}</p>
          {grupo && GRUPOS_DESCRICAO[grupo] ? <p className="segp__etapa">Etapa do ciclo: {GRUPOS_DESCRICAO[grupo].toLowerCase()}</p> : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onLimpar}>Limpar</Button>
      </header>

      <dl className="segp-estats">
        <Estatistica rotulo="Clientes" valor={numero(clientes)} />
        <Estatistica rotulo="% da base" valor={pct(pctBase)} />
        <Estatistica rotulo="% da receita" valor={pct(pctReceita)} />
      </dl>

      {unico && unico.predicado && (
        <ul className="segp-criterios" aria-label={`Regra do segmento ${unico.nome}`}>
          {criteriosDoSegmento(unico.predicado, rfm).map((c) => (
            <li key={c.chave}>
              <span className="segp-criterios__letra" aria-hidden="true">{c.chave}</span>
              <span className="segp-criterios__corpo">
                <strong>{c.rotulo}</strong> {c.texto}
                {c.nota ? <em>{c.nota}</em> : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="segp-metricas">
        <span>Ticket <strong>{pedidos ? moeda(receita / pedidos) : '—'}</strong><InfoTooltip content="Receita ÷ pedidos do segmento, no histórico observado." /></span>
        <span>Pedidos/cliente <strong>{clientes ? decimal(pedidos / clientes) : '—'}</strong><InfoTooltip content="Média de pedidos válidos por cliente, no histórico observado." /></span>
        {unico && (
          <span>Recência mediana <strong>{unico.recenciaMedianaDias == null ? '—' : `${numero(unico.recenciaMedianaDias)} d`}</strong><InfoTooltip content="Dias desde a última compra: metade dos clientes do segmento comprou há menos que isso." /></span>
        )}
      </p>

      {unico?.hipotese && (
        <p className="segp-hipotese"><strong>Hipótese de campanha</strong> {unico.hipotese} <em>É uma hipótese a testar, não previsão de conversão.</em></p>
      )}

      {defasados.length > 0 && unico && (
        <p className="segp-alerta" role="status">
          Já existe segmento salvo com corte defasado ({defasados.map((d) => `${rotuloCorte(d.salvo.corte)} → hoje ${rotuloCorte(d.atual.corte)}`).join('; ')}). O botão abaixo cria um segmento com o corte de hoje; o antigo não é alterado.
        </p>
      )}

      <div className="segp-acoes">
        {unico ? (
          <>
            <Button onClick={() => onCriarCampanha(unico)} disabled={criando || unico.clientes === 0} aria-describedby={unico.clientes === 0 ? 'segp-vazio-motivo' : undefined}>
              {criando ? 'Criando segmento…' : 'Criar campanha com este segmento'}
            </Button>
            {unico.clientes === 0 && <p id="segp-vazio-motivo" className="segp__nota">Sem clientes hoje: não há público para uma campanha.</p>}
          </>
        ) : (
          <p className="segp__nota">Para criar uma campanha, selecione um segmento por vez: o segmento salvo é uma regra única.</p>
        )}
        <div className="segp-acoes__sec">
          <Button variant="secondary" size="sm" onClick={onVerClientes} disabled={clientes === 0}>Ver clientes</Button>
          <Button variant="secondary" size="sm" onClick={onExportar} disabled={clientes === 0}>Exportar</Button>
        </div>
      </div>

      <p className="segp__nota">
        Público <strong>dinâmico</strong> (reavaliado a cada uso) com <strong>corte de valor fixo</strong> no segmento salvo · classificado em {dataClass} · regra {rfm.regraVersao}. Elegibilidade por canal (opt-in, número válido) é calculada na Audiência.
      </p>
    </aside>
  );
}
