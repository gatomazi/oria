// Decomposição do faturamento do período numa barra só: o que foi para frete e descontos, para a
// produção (retido pela Reserva Ink), para a mídia e o que sobrou. É a mesma conta do "Resultado do
// período", só que em proporção — para o lojista ver de relance para onde foi cada real.
//
// Regras:
// - Mídia só entra quando a tela sabe quanto foi gasto (`temMidia`); sem isso a fatia não existe,
//   em vez de aparecer como zero (ver estadoMidia.ts).
// - Resultado negativo (prejuízo) não vira fatia negativa: a sobra fica zero e a barra se divide
//   pelo total das saídas, que nesse caso passa do faturamento. `prejuizo` avisa a tela.
// - Faturamento zero não tem barra (lista vazia).

export interface ResultadoParaDecompor {
  faturamento: number;
  /** Receita líquida: faturamento sem frete, já com descontos. */
  receitaLiquida: number;
  custoProducao: number;
  midia: number;
  /** O número que fecha a linha: lucro após mídia (com mídia) ou lucro bruto (sem). */
  resultado: number;
}

export type ChaveParte = 'frete' | 'producao' | 'midia' | 'sobra';

export interface ParteDecomposta {
  chave: ChaveParte;
  rotulo: string;
  valor: number;
  /** Fração da barra, de 0 a 1. As frações somam 1. */
  fracao: number;
}

export interface Decomposicao {
  partes: ParteDecomposta[];
  prejuizo: boolean;
}

const ROTULOS: Record<ChaveParte, string> = {
  frete: 'Frete e descontos',
  producao: 'Produção',
  midia: 'Mídia',
  sobra: 'Sobra',
};

export function decomporResultado(r: ResultadoParaDecompor, temMidia: boolean): Decomposicao {
  if (!(r.faturamento > 0)) return { partes: [], prejuizo: false };
  const brutas: [ChaveParte, number][] = [
    ['frete', Math.max(0, r.faturamento - r.receitaLiquida)],
    ['producao', Math.max(0, r.custoProducao)],
  ];
  if (temMidia) brutas.push(['midia', Math.max(0, r.midia)]);
  brutas.push(['sobra', Math.max(0, r.resultado)]);
  const total = brutas.reduce((s, [, v]) => s + v, 0) || 1;
  return {
    partes: brutas.filter(([, v]) => v > 0).map(([chave, valor]) => ({ chave, rotulo: ROTULOS[chave], valor, fracao: valor / total })),
    prejuizo: r.resultado < 0,
  };
}
