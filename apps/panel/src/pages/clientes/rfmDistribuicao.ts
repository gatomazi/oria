import type { SegmentoResumo } from '../../api/clientes';
import { GRUPOS_LEGENDA, estiloDe } from './rfmSegmentos';

// Transformações PURAS do RFM Explorer (testadas em test/clientes-rfm-distribuicao.test.js): sem React, sem DOM.
//
// Regras que não mudam com a estética:
//   · TODO segmento devolvido pelo servidor vira uma linha — inclusive 0 cliente e < 1% (nada é filtrado nem escondido);
//   · a barra é PROPORCIONAL ao valor (linear, base = maior valor visível); só ganha uma "marca mínima" de 2 px quando o
//     valor é > 0 e a barra ficaria invisível, e essa marca é declarada (`marcaMinima`), nunca uma área fabricada;
//   · a ordem é a da regra (precedência) agrupada por ciclo de vida e NÃO muda ao alternar Clientes/Receita — a linha
//     não "pula" quando o usuário troca a métrica;
//   · números e percentuais vêm do servidor: nada aqui recalcula contagem.

export type MetricaDistribuicao = 'clientes' | 'receita';

export const GRUPOS_DESCRICAO: Record<string, string> = {
  Fidelidade: 'Compram de novo',
  'Primeira compra': 'Compraram uma vez, há pouco',
  Atenção: 'Esfriando',
  Risco: 'Recorrentes que pararam',
  Inativos: 'Sem comprar há muito tempo',
  'Sem classificação': 'Base ou histórico insuficientes',
};

export interface LinhaDistribuicao {
  id: string;
  nome: string;
  grupo: string;
  valor: number; // clientes ou receita, conforme a métrica
  clientes: number;
  receita: number;
  pctBase: number; // 0–1, do servidor
  pctReceita: number; // 0–1, do servidor
  pctPrincipal: number; // 0–1 da métrica escolhida
  pctSecundario: number; // 0–1 da outra métrica
  larguraPct: number; // 0–100: valor / maior valor visível
  marcaMinima: boolean; // barra desenhada com largura mínima só para não sumir (valor > 0 e < 2 px)
  vazio: boolean;
  abaixoDeUmPorCento: boolean; // 0 < pctPrincipal < 1%
  descricao: string | null;
}

export interface GrupoDistribuicao {
  grupo: string;
  descricao: string;
  linhas: LinhaDistribuicao[];
  clientes: number;
  receita: number;
  pctBase: number;
  pctReceita: number;
}

export interface Distribuicao {
  metrica: MetricaDistribuicao;
  grupos: GrupoDistribuicao[];
  linhas: LinhaDistribuicao[];
  totalClientes: number;
  totalReceita: number;
  maiorValor: number;
}

// `larguraPx` (opcional): largura em px da trilha, para decidir a marca mínima; sem ela, considera 100% = 300 px.
export function prepararDistribuicao(segmentos: SegmentoResumo[], metrica: MetricaDistribuicao, larguraPx = 300): Distribuicao {
  const totalClientes = segmentos.reduce((a, s) => a + s.clientes, 0);
  const totalReceita = segmentos.reduce((a, s) => a + s.receita, 0);
  const valorDe = (s: SegmentoResumo) => (metrica === 'receita' ? s.receita : s.clientes);
  const maiorValor = segmentos.reduce((m, s) => Math.max(m, valorDe(s)), 0);

  const linhas: LinhaDistribuicao[] = segmentos.map((s) => {
    const valor = valorDe(s);
    const larguraPct = maiorValor > 0 ? (valor / maiorValor) * 100 : 0;
    const pctPrincipal = metrica === 'receita' ? s.pctReceita : s.pctBase;
    return {
      id: s.id, nome: s.nome, grupo: estiloDe(s.id).grupo, valor, clientes: s.clientes, receita: s.receita,
      pctBase: s.pctBase, pctReceita: s.pctReceita, pctPrincipal, pctSecundario: metrica === 'receita' ? s.pctBase : s.pctReceita,
      larguraPct,
      marcaMinima: valor > 0 && (larguraPct / 100) * larguraPx < 2,
      vazio: s.clientes === 0,
      abaixoDeUmPorCento: pctPrincipal > 0 && pctPrincipal < 0.01,
      descricao: s.descricao,
    };
  });

  // Agrupa por ciclo de vida preservando a ordem de precedência da regra dentro de cada grupo.
  const ordemGrupos = [...GRUPOS_LEGENDA, 'Sem classificação'] as string[];
  const grupos: GrupoDistribuicao[] = [];
  for (const nome of ordemGrupos) {
    const doGrupo = linhas.filter((l) => l.grupo === nome);
    if (!doGrupo.length) continue;
    const clientes = doGrupo.reduce((a, l) => a + l.clientes, 0);
    const receita = doGrupo.reduce((a, l) => a + l.receita, 0);
    grupos.push({
      grupo: nome, descricao: GRUPOS_DESCRICAO[nome] ?? '', linhas: doGrupo, clientes, receita,
      pctBase: totalClientes ? clientes / totalClientes : 0, pctReceita: totalReceita ? receita / totalReceita : 0,
    });
  }
  return { metrica, grupos, linhas: grupos.flatMap((g) => g.linhas), totalClientes, totalReceita, maiorValor };
}

// Alternar um segmento na seleção: adiciona se ausente, remove se presente; mantém a ordem de inserção e nunca duplica.
export function alternarSelecao(atuais: string[], id: string): string[] {
  return atuais.includes(id) ? atuais.filter((x) => x !== id) : [...atuais, id];
}

export interface ContextoZero {
  historicoObservadoDias: number;
  limitePerdidosDias: number; // 4º limite de recência (ex.: 365)
}

// Por que um segmento pode estar em 0 — sem fingir que "a loja não tem esse comportamento" quando falta histórico.
export function explicarZero(id: string, ctx: ContextoZero): string {
  if (id === 'perdidos' && ctx.historicoObservadoDias <= ctx.limitePerdidosDias) {
    return `Ainda não pode existir: só ${ctx.historicoObservadoDias} dias de histórico (precisa de mais de ${ctx.limitePerdidosDias}).`;
  }
  if (id === 'dados_insuficientes') return 'Sem clientes nesta categoria.';
  return 'Nenhum cliente atende à regra hoje.';
}

export function rotuloAria(l: LinhaDistribuicao): string {
  const pct = (v: number) => `${(v * 100).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
  const clientes = `${l.clientes.toLocaleString('pt-BR')} ${l.clientes === 1 ? 'cliente' : 'clientes'}`;
  return `${l.nome}, ${l.grupo}: ${clientes}, ${pct(l.pctBase)} da base, ${pct(l.pctReceita)} da receita`;
}
