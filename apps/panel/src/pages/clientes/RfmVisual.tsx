import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../components/ds';
import { estiloDe } from './rfmSegmentos';
import { explicarZero, rotuloAria, type Distribuicao, type LinhaDistribuicao } from './rfmDistribuicao';
import { PISO_AREA, nivelDeRotulo, prepararVisual, type BlocoVisual } from './rfmTreemap';
import { numero, pct } from './rfmTexto';
import { formatValor } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';

const moeda = (v: number) => formatValor(v) ?? '—';

interface Props {
  dist: Distribuicao;
  selecionados: string[];
  onToggle: (id: string) => void;
  historicoObservadoDias: number;
  limitePerdidosDias: number;
  // Mesmo painel do segmento da Lista: no celular, uma única instância logo abaixo da legenda do segmento selecionado.
  painelInline: boolean;
  painel: ReactNode;
}

// Visão "Visual" da Distribuição RFM: treemap proporcional + LEGENDA completa. O mapa é o resumo visual (clicável com o dedo/mouse);
// a legenda é a interface acessível: 11 botões reais com nome completo, número e %, inclusive os de 0 cliente e os < 1%.
export function RfmVisual({ dist, selecionados, onToggle, historicoObservadoDias, limitePerdidosDias, painelInline, painel }: Props) {
  const celular = useMediaQuery('(max-width: 720px)');
  const altura = celular ? 100 : 46; // altura do layout para largura 100 (mapa mais alto no celular: blocos maiores para o toque)
  const visual = useMemo(() => prepararVisual(dist, altura), [dist, altura]);

  const mapa = useRef<HTMLDivElement>(null);
  const [larguraPx, setLarguraPx] = useState(640);
  useEffect(() => {
    const el = mapa.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setLarguraPx(el.getBoundingClientRect().width || 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Ligação bloco ↔ legenda: passar o mouse/foco num lado destaca o outro (ajuda a achar os blocos pequenos, que não cabem nome).
  const [destaque, setDestaque] = useState<string | null>(null);
  const selecionadoUnico = selecionados.length === 1 ? selecionados[0] : null;
  const metrica = dist.metrica;
  const principal = (l: LinhaDistribuicao) => (metrica === 'receita' ? moeda(l.receita) : numero(l.clientes));
  const unidade = (l: LinhaDistribuicao) => (metrica === 'receita' ? '' : (l.clientes === 1 ? ' cliente' : ' clientes'));
  const cor = (id: string) => {
    const e = estiloDe(id);
    return { ['--rfmx-cor' as string]: e.tint, ['--rfmx-opac' as string]: String(e.opacidade) };
  };

  function bloco(b: BlocoVisual) {
    const l = b.linha;
    const marcado = selecionados.includes(l.id);
    const wPx = (b.w / 100) * larguraPx;
    const hPx = (b.h / 100) * larguraPx; // o layout tem largura 100 e altura `altura`: 1 unidade = larguraPx/100 nos dois eixos
    const nivel = nivelDeRotulo(wPx, hPx);
    return (
      <div
        key={l.id}
        className={['rfmv-bloco', `rfmv-bloco--${nivel}`, marcado ? 'is-selecionado' : null, destaque === l.id ? 'is-destaque' : null].filter(Boolean).join(' ')}
        style={{ left: `${b.x}%`, top: `${(b.y / altura) * 100}%`, width: `${b.w}%`, height: `${(b.h / altura) * 100}%`, ...cor(l.id) }}
        title={`${l.nome}: ${principal(l)}${unidade(l)} · ${pct(l.pctPrincipal)}`}
        data-segmento={l.id}
        data-nivel={nivel}
        // Ponteiro/toque; teclado e leitor de tela usam a legenda (mesmo estado, mesmos botões reais).
        aria-hidden="true"
        onClick={() => onToggle(l.id)}
        onMouseEnter={() => setDestaque(l.id)}
        onMouseLeave={() => setDestaque(null)}
      >
        <span className="rfmv-bloco__interno">
          {marcado && nivel !== 'marcador' && <span className="rfmv-bloco__check"><Icon name="check-mark" size={11} /></span>}
          {(nivel === 'completo' || nivel === 'nome') && <span className="rfmv-bloco__nome">{l.nome}</span>}
          {nivel !== 'marcador' && <span className="rfmv-bloco__valor">{principal(l)}{nivel === 'completo' ? unidade(l) : ''}</span>}
          {nivel === 'completo' && <span className="rfmv-bloco__pct">{pct(l.pctPrincipal)}{b.pisoAplicado ? ' · área mínima' : ''}</span>}
        </span>
      </div>
    );
  }

  function itemLegenda(l: LinhaDistribuicao) {
    const marcado = selecionados.includes(l.id);
    const secundario = metrica === 'receita' ? `${numero(l.clientes)} ${l.clientes === 1 ? 'cliente' : 'clientes'}` : `${pct(l.pctReceita)} da receita`;
    return (
      <li key={l.id} className="rfmv-legenda__item">
        <button
          type="button"
          aria-pressed={marcado}
          aria-label={rotuloAria(l)}
          className={['rfmv-chip', marcado ? 'is-selecionada' : null, l.vazio ? 'is-vazia' : null, destaque === l.id ? 'is-destaque' : null].filter(Boolean).join(' ')}
          style={cor(l.id)}
          onClick={() => onToggle(l.id)}
          onMouseEnter={() => setDestaque(l.id)}
          onMouseLeave={() => setDestaque(null)}
          onFocus={() => setDestaque(l.id)}
          onBlur={() => setDestaque(null)}
        >
          <span className="rfmv-chip__cor" aria-hidden="true">{marcado ? <Icon name="check-mark" size={11} /> : null}</span>
          <span className="rfmv-chip__texto">
            <span className="rfmv-chip__nome">{l.nome}</span>
            <span className="rfmv-chip__sub">
              {l.vazio ? explicarZero(l.id, { historicoObservadoDias, limitePerdidosDias }) : `${pct(l.pctPrincipal)} · ${secundario}`}
            </span>
          </span>
          <span className="rfmv-chip__valor"><strong>{principal(l)}</strong>{unidade(l)}</span>
        </button>
        {painelInline && selecionadoUnico === l.id && <div className="rfmx-inline">{painel}</div>}
      </li>
    );
  }

  return (
    <div className="rfmv">
      <div
        ref={mapa}
        className="rfmv-mapa"
        style={{ aspectRatio: `100 / ${altura}` }}
        aria-hidden={visual.blocos.length === 0 ? 'true' : undefined}
      >
        {visual.blocos.length === 0 ? <p className="rfmv-vazio">Nenhum segmento tem clientes ainda.</p> : visual.blocos.map(bloco)}
      </div>
      <p className="rfmv-nota">
        Área proporcional ao valor mostrado. Blocos abaixo de {(PISO_AREA * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% usam uma área mínima ("área mínima") para continuarem visíveis e clicáveis —
        o número é o dado. Segmentos com 0 cliente não têm bloco. <strong>Todos os segmentos estão na legenda abaixo.</strong>
      </p>
      <div className="rfmv-legenda" role="group" aria-label={`Legenda dos segmentos RFM, medidos por ${metrica === 'receita' ? 'receita' : 'número de clientes'}`}>
        {dist.grupos.map((g) => (
          <section key={g.grupo} className="rfmv-grupo" aria-label={g.grupo}>
            <h3 className="rfmx-grupo__titulo">
              <span>{g.grupo}</span>
              <span className="rfmx-grupo__soma">{numero(g.clientes)} {g.clientes === 1 ? 'cliente' : 'clientes'} · {pct(g.pctBase)}</span>
            </h3>
            <ul className="rfmv-legenda__lista">
              {g.linhas.map((l) => <Fragment key={l.id}>{itemLegenda(l)}</Fragment>)}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
