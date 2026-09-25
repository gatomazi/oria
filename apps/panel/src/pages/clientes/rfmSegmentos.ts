import type { SegmentoRfmId } from '../../api/clientes';

// Apresentação dos segmentos RFM. A cor segue a regra semântica do design system (DESIGN.md › Semantic-Only):
// verde = fidelidade, ciano = primeira compra/aguardando, âmbar = atenção, vermelho = risco; inativos e
// "dados insuficientes" ficam em neutro. Estágios vizinhos do mesmo tom se distinguem por OPACIDADE, e cada
// célula também carrega o NOME e o grupo em texto: a cor nunca é a única pista.
export interface EstiloSegmento {
  grupo: 'Fidelidade' | 'Primeira compra' | 'Atenção' | 'Risco' | 'Inativos' | 'Sem classificação';
  cor: string;
  tint: string; // fundo da célula
  opacidade: number;
}

const OK = { cor: 'var(--success)', tint: 'var(--success)' };
const INFO = { cor: 'var(--info)', tint: 'var(--info)' };
const WARN = { cor: 'var(--warning)', tint: 'var(--warning)' };
const RISK = { cor: 'var(--danger)', tint: 'var(--danger)' };
const NEUTRO = { cor: 'var(--text-secondary)', tint: 'var(--chart-neutral)' };

export const ESTILO_SEGMENTO: Record<SegmentoRfmId, EstiloSegmento> = {
  campeoes: { grupo: 'Fidelidade', ...OK, opacidade: 0.34 },
  leais: { grupo: 'Fidelidade', ...OK, opacidade: 0.24 },
  potenciais_leais: { grupo: 'Fidelidade', ...OK, opacidade: 0.16 },
  primeira_alto_valor: { grupo: 'Primeira compra', ...INFO, opacidade: 0.3 },
  novos: { grupo: 'Primeira compra', ...INFO, opacidade: 0.2 },
  aguardando_recompra: { grupo: 'Primeira compra', ...INFO, opacidade: 0.13 },
  precisam_atencao: { grupo: 'Atenção', ...WARN, opacidade: 0.26 },
  prestes_a_dormir: { grupo: 'Atenção', ...WARN, opacidade: 0.16 },
  em_risco: { grupo: 'Risco', ...RISK, opacidade: 0.26 },
  hibernando: { grupo: 'Inativos', ...NEUTRO, opacidade: 0.34 },
  perdidos: { grupo: 'Inativos', ...NEUTRO, opacidade: 0.2 },
  dados_insuficientes: { grupo: 'Sem classificação', ...NEUTRO, opacidade: 0.14 },
};

export const GRUPOS_LEGENDA: EstiloSegmento['grupo'][] = ['Fidelidade', 'Primeira compra', 'Atenção', 'Risco', 'Inativos'];

export function estiloDe(id: string): EstiloSegmento {
  return ESTILO_SEGMENTO[id as SegmentoRfmId] ?? ESTILO_SEGMENTO.dados_insuficientes;
}
