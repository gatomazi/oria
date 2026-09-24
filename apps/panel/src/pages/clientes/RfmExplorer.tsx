import { Fragment, useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { Disclosure, Icon, StatusBadge } from '../../components/ds';
import type { SegmentoResumo } from '../../api/clientes';
import { estiloDe } from './rfmSegmentos';
import { explicarZero, prepararDistribuicao, rotuloAria, type LinhaDistribuicao, type MetricaDistribuicao } from './rfmDistribuicao';
import { numero, pct } from './rfmTexto';
import { formatValor } from '../../lib/format';

export type MetricaMatriz = MetricaDistribuicao;

export function GrupoBadge({ id }: { id: string }) {
  const g = estiloDe(id).grupo;
  const tom = g === 'Fidelidade' ? 'success' : g === 'Primeira compra' ? 'info' : g === 'Atenção' ? 'warning' : g === 'Risco' ? 'danger' : 'neutral';
  return <StatusBadge tone={tom} label={g} />;
}

const moeda = (v: number) => formatValor(v) ?? '—';

interface Props {
  segmentos: SegmentoResumo[];
  selecionados: string[];
  onToggle: (id: string) => void;
  onLimparSelecao: () => void;
  metrica: MetricaMatriz;
  onMetrica: (m: MetricaMatriz) => void;
  historicoObservadoDias: number;
  limitePerdidosDias: number;
  // Metadados de contexto (data, regra, janela…) — ficam num bloco expansível, fora da dobra principal.
  contexto: ReactNode;
  resumoContexto: string;
  // Painel do segmento selecionado; no celular ele é renderizado logo abaixo da linha selecionada (uma única instância).
  painelInline: boolean;
  painel: ReactNode;
}

// RFM Explorer: 11 linhas com NOME COMPLETO, barra proporcional e números sempre visíveis — sem hover, sem toque, sem
// quadradinho anônimo. Agrupado por ciclo de vida (Fidelidade → Inativos). Cada linha é um botão real (aria-pressed).
export function RfmExplorer({
  segmentos, selecionados, onToggle, onLimparSelecao, metrica, onMetrica, historicoObservadoDias, limitePerdidosDias, contexto, resumoContexto, painelInline, painel,
}: Props) {
  // A escala da barra usa a largura real da trilha para decidir se um valor > 0 precisa de marca mínima.
  const trilha = useRef<HTMLSpanElement>(null);
  const [larguraTrilha, setLarguraTrilha] = useState(300);
  useEffect(() => {
    const el = trilha.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setLarguraTrilha(el.getBoundingClientRect().width || 300));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dist = useMemo(() => prepararDistribuicao(segmentos, metrica, larguraTrilha), [segmentos, metrica, larguraTrilha]);
  const selecionadoUnico = selecionados.length === 1 ? selecionados[0] : null;

  function linha(l: LinhaDistribuicao, primeira: boolean) {
    const e = estiloDe(l.id);
    const marcado = selecionados.includes(l.id);
    const valorPrincipal = metrica === 'receita' ? moeda(l.receita) : numero(l.clientes);
    const unidade = metrica === 'receita' ? '' : (l.clientes === 1 ? ' cliente' : ' clientes');
    const secundario = metrica === 'receita'
      ? `${numero(l.clientes)} ${l.clientes === 1 ? 'cliente' : 'clientes'} · ${pct(l.pctBase)} da base`
      : `${pct(l.pctReceita)} da receita`;
    return (
      <li key={l.id} className="rfmx-item">
        <button
          type="button"
          aria-pressed={marcado}
          aria-label={rotuloAria(l)}
          className={['rfmx-linha', marcado ? 'is-selecionada' : null, l.vazio ? 'is-vazia' : null].filter(Boolean).join(' ')}
          style={{ ['--rfmx-cor' as string]: e.tint, ['--rfmx-opac' as string]: String(e.opacidade) }}
          onClick={() => onToggle(l.id)}
        >
          <span className="rfmx-marca" aria-hidden="true">{marcado ? <Icon name="check-mark" size={12} /> : null}</span>
          <span className="rfmx-texto">
            <span className="rfmx-nome">{l.nome}</span>
            <span className="rfmx-desc">{l.vazio ? explicarZero(l.id, { historicoObservadoDias, limitePerdidosDias }) : l.descricao}</span>
          </span>
          <span className="rfmx-trilho" ref={primeira ? trilha : undefined} aria-hidden="true">
            <span
              className={['rfmx-barra', l.marcaMinima ? 'rfmx-barra--minima' : null].filter(Boolean).join(' ')}
              style={{ width: `${l.larguraPct}%` }}
            />
          </span>
          <span className="rfmx-numeros">
            <span className="rfmx-valor"><strong>{valorPrincipal}</strong>{unidade}</span>
            <span className="rfmx-sub">
              <span className="rfmx-pct">{pct(l.pctPrincipal)}</span>
              <span className="rfmx-sec"> · {secundario}</span>
            </span>
          </span>
        </button>
        {painelInline && selecionadoUnico === l.id && <div className="rfmx-inline">{painel}</div>}
      </li>
    );
  }

  let indice = 0;
  return (
    <div className="rfmx">
      <div className="rfmx-cabecalho">
        <div>
          <h2 className="rfmx-titulo">Distribuição RFM</h2>
          <p className="rfmx-base">
            <strong>{numero(dist.totalClientes)}</strong> compradores válidos classificados · {resumoContexto}
          </p>
        </div>
        <div className="rfmx-controles">
          <div className="cli-segmentado" role="group" aria-label="Medir por">
            {(['clientes', 'receita'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={metrica === m} className={metrica === m ? 'is-ativo' : ''} onClick={() => onMetrica(m)}>
                {m === 'clientes' ? 'Clientes' : 'Receita'}
              </button>
            ))}
          </div>
          {selecionados.length > 0 && (
            <button type="button" className="rfmx-limpar" onClick={onLimparSelecao}>Limpar seleção ({selecionados.length})</button>
          )}
        </div>
      </div>

      <Disclosure summary="Sobre esta classificação">{contexto}</Disclosure>

      <div className="rfmx-grupos" role="group" aria-label={`Segmentos RFM medidos por ${metrica === 'receita' ? 'receita' : 'número de clientes'}`}>
        {dist.grupos.map((g) => (
          <section key={g.grupo} className="rfmx-grupo" aria-label={g.grupo}>
            <h3 className="rfmx-grupo__titulo">
              <span>{g.grupo}</span>
              <span className="rfmx-grupo__desc">{g.descricao}</span>
              <span className="rfmx-grupo__soma">{numero(g.clientes)} {g.clientes === 1 ? 'cliente' : 'clientes'} · {pct(g.pctBase)}</span>
            </h3>
            <ul className="rfmx-lista">
              {g.linhas.map((l) => { const primeira = indice === 0; indice += 1; return <Fragment key={l.id}>{linha(l, primeira)}</Fragment>; })}
            </ul>
          </section>
        ))}
      </div>
      <p className="rfmx-rodape">
        Barras proporcionais ao valor mostrado (a maior ocupa a trilha inteira). Parcelas menores que a espessura mínima de 2 px aparecem como uma marca fina — o número ao lado é o dado. Segmentos com 0 cliente continuam listados.
      </p>
    </div>
  );
}
