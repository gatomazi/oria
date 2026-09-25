import type { Distribuicao, LinhaDistribuicao } from './rfmDistribuicao';

// Layout PURO do treemap da visão "Visual" da Distribuição RFM (testado em test/clientes-rfm-treemap.test.js): sem React, sem DOM.
//
// Regras que não mudam com a estética:
//   · a área de cada bloco é proporcional ao valor mostrado (clientes ou receita); só há UM ajuste, declarado: um bloco com valor > 0
//     mas < PISO_AREA do total é desenhado com essa área mínima (para não virar um ponto impossível de identificar/clicar) — o número ao
//     lado é o dado, como a "marca mínima" da barra da Lista;
//   · segmento com valor 0 NÃO recebe área (não se fabrica área para 0): continua na legenda, legível e clicável;
//   · TODO segmento do servidor aparece: com bloco (valor > 0) ou na legenda (sempre);
//   · números e percentuais vêm do servidor; nada aqui recalcula contagem.

export const PISO_AREA = 0.012; // 1,2% da área total

export interface ItemTreemap { id: string; valor: number }
export interface Retangulo { id: string; x: number; y: number; w: number; h: number }

// Squarified treemap (Bruls, Huizing, van Wijk). Devolve retângulos que ocupam exatamente `largura × altura`, na ordem decrescente de
// valor (empate: ordem de entrada). Itens com valor <= 0 ou inválido são ignorados.
export function layoutTreemap(itens: ItemTreemap[], largura: number, altura: number): Retangulo[] {
  const validos = itens
    .map((it, i) => ({ ...it, i }))
    .filter((it) => Number.isFinite(it.valor) && it.valor > 0)
    .sort((a, b) => b.valor - a.valor || a.i - b.i);
  const total = validos.reduce((a, it) => a + it.valor, 0);
  if (!validos.length || !(largura > 0) || !(altura > 0) || total <= 0) return [];
  const escala = (largura * altura) / total;
  const areas = validos.map((it) => ({ id: it.id, area: it.valor * escala }));

  const saida: Retangulo[] = [];
  let x = 0; let y = 0; let w = largura; let h = altura;

  const pior = (linha: number[], lado: number) => {
    const soma = linha.reduce((a, v) => a + v, 0);
    const maior = Math.max(...linha);
    const menor = Math.min(...linha);
    return Math.max((lado * lado * maior) / (soma * soma), (soma * soma) / (lado * lado * menor));
  };

  let linha: { id: string; area: number }[] = [];
  let k = 0;
  while (k < areas.length) {
    const lado = Math.min(w, h);
    const candidato = areas[k];
    const atuais = linha.map((l) => l.area);
    if (!linha.length || pior([...atuais, candidato.area], lado) <= pior(atuais, lado)) {
      linha.push(candidato);
      k += 1;
      continue;
    }
    // fecha a linha ao longo do lado menor
    const soma = linha.reduce((a, l) => a + l.area, 0);
    if (w >= h) { // coluna à esquerda
      const largCol = soma / h;
      let yy = y;
      for (const l of linha) { const alt = l.area / largCol; saida.push({ id: l.id, x, y: yy, w: largCol, h: alt }); yy += alt; }
      x += largCol; w -= largCol;
    } else { // faixa no topo
      const altFaixa = soma / w;
      let xx = x;
      for (const l of linha) { const larg = l.area / altFaixa; saida.push({ id: l.id, x: xx, y, w: larg, h: altFaixa }); xx += larg; }
      y += altFaixa; h -= altFaixa;
    }
    linha = [];
  }
  if (linha.length) {
    const soma = linha.reduce((a, l) => a + l.area, 0);
    if (w >= h) {
      const largCol = soma / h;
      let yy = y;
      for (const l of linha) { const alt = l.area / largCol; saida.push({ id: l.id, x, y: yy, w: largCol, h: alt }); yy += alt; }
    } else {
      const altFaixa = soma / w;
      let xx = x;
      for (const l of linha) { const larg = l.area / altFaixa; saida.push({ id: l.id, x: xx, y, w: larg, h: altFaixa }); xx += larg; }
    }
  }
  return saida;
}

export interface BlocoVisual {
  linha: LinhaDistribuicao;
  x: number; y: number; w: number; h: number; // unidades do layout (largura 100)
  pisoAplicado: boolean; // valor > 0 desenhado com a área mínima
}

export interface VisualPreparado {
  blocos: BlocoVisual[];
  semArea: LinhaDistribuicao[]; // valor 0: só na legenda
  altura: number;
}

// `altura`: altura do layout para largura 100 (ex.: 46 no desktop, 100 no celular).
export function prepararVisual(dist: Distribuicao, altura: number): VisualPreparado {
  const total = dist.linhas.reduce((a, l) => a + l.valor, 0);
  const piso = total * PISO_AREA;
  const itens = dist.linhas.filter((l) => l.valor > 0).map((l) => ({ id: l.id, valor: Math.max(l.valor, piso) }));
  const ret = new Map(layoutTreemap(itens, 100, altura).map((r) => [r.id, r]));
  const blocos: BlocoVisual[] = [];
  for (const l of dist.linhas) {
    const r = ret.get(l.id);
    if (r) blocos.push({ linha: l, x: r.x, y: r.y, w: r.w, h: r.h, pisoAplicado: l.valor < piso });
  }
  return { blocos, semArea: dist.linhas.filter((l) => l.valor <= 0), altura };
}

export type NivelRotulo = 'completo' | 'nome' | 'valor' | 'marcador';

// O que cabe dentro do bloco, em px. O nome COMPLETO sempre existe (legenda, aria-label e tooltip): aqui só se decide o que é
// desenhado dentro do bloco.
export function nivelDeRotulo(larguraPx: number, alturaPx: number): NivelRotulo {
  if (larguraPx >= 120 && alturaPx >= 64) return 'completo';
  if (larguraPx >= 84 && alturaPx >= 42) return 'nome';
  if (larguraPx >= 26 && alturaPx >= 20) return 'valor';
  return 'marcador';
}
