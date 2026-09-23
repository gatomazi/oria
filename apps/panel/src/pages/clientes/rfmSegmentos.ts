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

// ── Treemap "squarified" (Bruls, Huijsmans, van Wijk) ────────────────────────────────────────────────
// Devolve retângulos em PORCENTAGEM (0–100) do contêiner, sem sobreposição e cobrindo a área toda. Determinístico:
// mesma entrada, mesmo desenho (empate de valor desempata pelo id), então a matriz não "pisca" entre recargas.
export interface ItemTreemap { id: string; valor: number }
export interface RetanguloTreemap { id: string; x: number; y: number; w: number; h: number }

export function layoutTreemap(itens: ItemTreemap[], proporcao: number): RetanguloTreemap[] {
  const validos = itens.filter((i) => Number.isFinite(i.valor) && i.valor > 0).sort((a, b) => b.valor - a.valor || (a.id < b.id ? -1 : 1));
  const total = validos.reduce((acc, i) => acc + i.valor, 0);
  if (!validos.length || total <= 0) return [];

  // Trabalha num retângulo de largura `proporcao` e altura 1, e converte para % no fim.
  const alvoArea = proporcao;
  const escala = alvoArea / total;
  const itensArea = validos.map((i) => ({ id: i.id, area: i.valor * escala }));
  const saida: RetanguloTreemap[] = [];
  let livre = { x: 0, y: 0, w: proporcao, h: 1 };

  const pior = (linha: { area: number }[], lado: number) => {
    const soma = linha.reduce((a, i) => a + i.area, 0);
    const maxA = Math.max(...linha.map((i) => i.area));
    const minA = Math.min(...linha.map((i) => i.area));
    return Math.max((lado * lado * maxA) / (soma * soma), (soma * soma) / (lado * lado * minA));
  };

  const fecharLinha = (linha: { id: string; area: number }[]) => {
    const soma = linha.reduce((a, i) => a + i.area, 0);
    const horizontal = livre.w >= livre.h; // a linha corre pelo lado MENOR, empilhada no maior
    if (horizontal) {
      const largura = soma / livre.h;
      let y = livre.y;
      for (const i of linha) {
        const h = i.area / largura;
        saida.push({ id: i.id, x: livre.x, y, w: largura, h });
        y += h;
      }
      livre = { x: livre.x + largura, y: livre.y, w: livre.w - largura, h: livre.h };
    } else {
      const altura = soma / livre.w;
      let x = livre.x;
      for (const i of linha) {
        const w = i.area / altura;
        saida.push({ id: i.id, x, y: livre.y, w, h: altura });
        x += w;
      }
      livre = { x: livre.x, y: livre.y + altura, w: livre.w, h: livre.h - altura };
    }
  };

  let linha: { id: string; area: number }[] = [];
  for (const item of itensArea) {
    const lado = Math.min(livre.w, livre.h);
    if (!linha.length || pior([...linha, item], lado) <= pior(linha, lado)) {
      linha.push(item);
    } else {
      fecharLinha(linha);
      linha = [item];
    }
  }
  if (linha.length) fecharLinha(linha);

  return saida.map((r) => ({ id: r.id, x: (r.x / proporcao) * 100, y: r.y * 100, w: (r.w / proporcao) * 100, h: r.h * 100 }));
}
