import { useEffect, useMemo, useState } from 'react';
import { Icon, StatusBadge } from '../../components/ds';
import type { SegmentoResumo } from '../../api/clientes';
import { ESTILO_SEGMENTO, GRUPOS_LEGENDA, estiloDe, layoutTreemap } from './rfmSegmentos';
import { numero, pct } from './rfmTexto';
import { formatValor } from '../../lib/format';

export type MetricaMatriz = 'clientes' | 'receita';

// Proporção do desenho: mais larga no desktop, mais alta no celular (o treemap ocupa % do contêiner, então o
// layout é calculado para a proporção que o CSS realmente usa em cada faixa).
function useProporcao(): number {
  const consulta = '(max-width: 720px)';
  const [estreito, setEstreito] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(consulta).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(consulta);
    const atualizar = () => setEstreito(mq.matches);
    mq.addEventListener('change', atualizar);
    return () => mq.removeEventListener('change', atualizar);
  }, []);
  return estreito ? 5 / 6 : 16 / 7;
}

interface Props {
  segmentos: SegmentoResumo[];
  selecionados: string[];
  onToggle: (id: string) => void;
  metrica: MetricaMatriz;
}

// Treemap clicável dos segmentos. Cada célula é um <button aria-pressed> com nome, números e grupo em texto (a cor
// é reforço, não a única pista); células pequenas perdem o rótulo mas mantêm o aria-label, e TODO segmento — inclusive
// os de 0 clientes — também aparece na legenda clicável logo abaixo e na tabela de distribuição da página.
export function RfmMatriz({ segmentos, selecionados, onToggle, metrica }: Props) {
  const proporcao = useProporcao();
  const rects = useMemo(
    () => layoutTreemap(segmentos.map((s) => ({ id: s.id, valor: metrica === 'receita' ? s.receita : s.clientes })), proporcao),
    [segmentos, metrica, proporcao],
  );
  const porId = useMemo(() => new Map<string, SegmentoResumo>(segmentos.map((s) => [s.id, s])), [segmentos]);

  return (
    <div className="cli-matriz">
      <div className="cli-treemap" role="group" aria-label={`Segmentos RFM, tamanho proporcional a ${metrica === 'receita' ? 'receita' : 'clientes'}`}>
        {rects.map((r) => {
          const s = porId.get(r.id)!;
          const e = estiloDe(s.id);
          const marcado = selecionados.includes(s.id);
          const grande = r.w >= 13 && r.h >= 20;
          const alta = r.w >= 13 && r.h >= 32;
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={marcado}
              onClick={() => onToggle(s.id)}
              aria-label={`${s.nome}, ${e.grupo}: ${numero(s.clientes)} clientes, ${pct(s.pctBase)} da base, ${pct(s.pctReceita)} da receita`}
              title={`${s.nome} · ${numero(s.clientes)} clientes · ${pct(s.pctBase)} da base · ${pct(s.pctReceita)} da receita`}
              className={['cli-treemap__celula', marcado ? 'is-selecionada' : null, selecionados.length && !marcado ? 'is-esmaecida' : null].filter(Boolean).join(' ')}
              style={{
                left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%`,
                ['--cli-tint' as string]: e.tint, ['--cli-opac' as string]: String(e.opacidade), ['--cli-cor' as string]: e.cor,
              }}
            >
              {grande && (
                <span className="cli-treemap__texto">
                  <span className="cli-treemap__nome">{s.nome}</span>
                  {alta && (
                    <span className="cli-treemap__numeros">
                      {metrica === 'receita' ? (formatValor(s.receita) ?? '—') : `${numero(s.clientes)} clientes`}
                      <span className="cli-treemap__pct">{pct(metrica === 'receita' ? s.pctReceita : s.pctBase)}</span>
                    </span>
                  )}
                </span>
              )}
              {marcado && <Icon name="check-mark" size={14} className="cli-treemap__check" />}
            </button>
          );
        })}
      </div>

      <div className="cli-legenda" role="group" aria-label="Legenda e seleção dos segmentos">
        {GRUPOS_LEGENDA.map((grupo) => {
          const itens = segmentos.filter((s) => estiloDe(s.id).grupo === grupo);
          if (!itens.length) return null;
          return (
            <div key={grupo} className="cli-legenda__grupo">
              <span className="cli-legenda__titulo">{grupo}</span>
              <div className="cli-legenda__chips">
                {itens.map((s) => {
                  const e = ESTILO_SEGMENTO[s.id];
                  const marcado = selecionados.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={marcado}
                      className={['cli-chip', marcado ? 'is-ativo' : null].filter(Boolean).join(' ')}
                      onClick={() => onToggle(s.id)}
                    >
                      <span className="cli-chip__marca" style={{ background: e.tint, opacity: 0.4 + e.opacidade }} aria-hidden="true" />
                      {s.nome}
                      <span className="cli-chip__qtd">{numero(s.clientes)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GrupoBadge({ id }: { id: string }) {
  const g = estiloDe(id).grupo;
  const tom = g === 'Fidelidade' ? 'success' : g === 'Primeira compra' ? 'info' : g === 'Atenção' ? 'warning' : g === 'Risco' ? 'danger' : 'neutral';
  return <StatusBadge tone={tom} label={g} />;
}
