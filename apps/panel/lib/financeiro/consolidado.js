'use strict';

// Consolidado financeiro (docs/meta-ads-analytics-integracao-v2.md §53A-53AC, §76).
//
// A premissa central da spec, e a razão deste arquivo existir separado: **atribuição não fecha o
// caixa** (§53D). Existem duas perguntas diferentes e elas não se misturam:
//
//   FINANCEIRO  — quanto entrou, custou e sobrou. Usa receita real da loja, custo real de produção
//                 (webhook da Ink) e gasto real reportado por cada plataforma de mídia.
//   ATRIBUIÇÃO  — de onde veio a venda. Usa o que Meta e GA4 dizem ter gerado.
//
// Misturar as duas é o erro que produz lucro inflado. Por isso a receita atribuída pela Meta NUNCA
// entra numa conta de resultado aqui — ela só aparece lado a lado, para comparação (§17, §89).

const { parseNumero, dividir } = require('../meta/actions');

// Provedores de mídia previstos. A camada é provider-agnostic de propósito (§53P): quando o Google
// Ads entrar, ele vira mais uma chave aqui e mais uma linha no total, sem mudar fórmula nenhuma.
const PROVEDORES = ['meta', 'google_ads', 'tiktok_ads', 'pinterest_ads', 'outro'];

const PROVEDOR_ROTULO = {
  meta: 'Meta Ads',
  google_ads: 'Google Ads',
  tiktok_ads: 'TikTok Ads',
  pinterest_ads: 'Pinterest Ads',
  outro: 'Outros canais',
};

// Soma o gasto real de mídia de todos os provedores conectados. `fontes` é uma lista de
// { provider, spend, conectado } — quem não está conectado entra com conectado:false e NÃO vira
// zero silencioso: a ausência dele é reportada, pra tela poder dizer que o resultado está parcial
// em vez de exibir um lucro alto demais (§53AB, §53AA).
// `faltando` lista só provedor que a operação DE FATO usa e não está conectado. Um canal que a loja
// nunca anunciou não é lacuna: avisar sobre ele em toda consulta vira ruído fixo no topo da tela
// mais importante do painel, e ruído fixo é ruído ignorado — inclusive quando virar aviso de verdade.
// Quem sabe se o canal é usado é quem chama: passa `relevante: false` pra silenciar.
function totalizarMidia(fontes) {
  const porProvedor = {};
  let total = 0;
  const faltando = [];
  for (const f of fontes || []) {
    const gasto = parseNumero(f && f.spend);
    if (!f.conectado) {
      if (f.relevante !== false) faltando.push(f.provider);
      continue;
    }
    porProvedor[f.provider] = gasto === null ? 0 : gasto;
    total += porProvedor[f.provider];
  }
  return { porProvedor, total, faltando };
}

// ── Resultado progressivo (§53F) ────────────────────────────────────────────────────────────
// Nível 1 Receita → Nível 2 Produção → Nível 3 Aquisição → Nível 4 Operacional.
// Cada nível subtrai só o que é dele. O gasto de mídia é descontado UMA vez, no nível 3 (§53E).
//
// `loja` traz o que veio de pedidos_ink: receita real, custo real de produção e o lucro do produto,
// que na Ink é o próprio kickback_value — não recalculado aqui (ver lib/ink/financeiro.js).
// `coberturaCompleta` decide o que pode ser afirmado. Quando o custo de produção só existe para
// parte dos pedidos, RATES continuam válidas (a margem % do recorte estima bem a margem da loja),
// mas VALORES ABSOLUTOS derivados dela, não: subtrair o gasto de mídia de TODO o tráfego de uma
// margem que cobre 15% dos pedidos dá um prejuízo que não existe. Esses vêm null.
function montarResultado({ loja, midia, despesas, coberturaCompleta = true }) {
  const receita = parseNumero(loja && loja.receita) || 0;
  const custoProducao = parseNumero(loja && loja.custoProducao) || 0;
  const pedidos = parseNumero(loja && loja.pedidos) || 0;

  // Lucro do Produto vem pronto da Ink quando existe (kickback_value, já líquido de desconto).
  // A subtração é o caminho de reserva — e as duas devem bater; quando não batem, é sinal de
  // pedido sem financeiro gravado, o que a camada de qualidade reporta.
  const lucroProduto = loja && loja.lucroProduto != null
    ? parseNumero(loja.lucroProduto)
    : receita - custoProducao;

  const totalMidia = parseNumero(midia && midia.total) || 0;
  const lucroAposMidia = coberturaCompleta ? lucroProduto - totalMidia : null;

  const despesasTotal = parseNumero(despesas && despesas.total);
  // Sem despesas cadastradas, o Lucro Operacional NÃO é igual ao Lucro após Mídia: ele é
  // desconhecido. Devolver null obriga a tela a dizer isso em vez de mostrar um número que
  // parece o resultado final e não é (§53AB).
  const lucroOperacional = despesasTotal === null || lucroAposMidia === null ? null : lucroAposMidia - despesasTotal;

  return {
    receita,
    custoProducao,
    lucroProduto,
    margemProduto: pct(lucroProduto, receita),

    totalMidia,
    midiaPorProvedor: (midia && midia.porProvedor) || {},
    lucroAposMidia,
    margemAposMidia: lucroAposMidia === null ? null : pct(lucroAposMidia, receita),

    despesas: despesasTotal,
    lucroOperacional,
    margemOperacional: lucroOperacional === null ? null : pct(lucroOperacional, receita),
    coberturaCompleta,

    pedidos,
    ticketMedio: dividir(receita, pedidos),
  };
}

function pct(parte, todo) {
  const r = dividir(parte, todo);
  return r === null ? null : r * 100;
}

// ── Indicadores de eficiência (§53I, §53K, §53M, §53N) ──────────────────────────────────────

// MER: receita REAL sobre gasto REAL de mídia. Independe de atribuição por construção — é esse o
// ponto dele. Nome completo é "MER observado" porque o denominador só considera as fontes de mídia
// conectadas hoje (§53I).
function mer(receitaReal, totalMidia) {
  return dividir(receitaReal, totalMidia);
}

// ROAS de margem (§53K): quanto de MARGEM cada real de mídia gerou. Mais útil que o ROAS de receita
// porque o painel conhece o custo real de produção — R$ 5 de receita com R$ 4 de custo não é o
// mesmo negócio que R$ 5 com R$ 1.
function roasDeMargem(lucroProduto, totalMidia) {
  return dividir(lucroProduto, totalMidia);
}

// Resultado por real de mídia (§53L). Nome explícito de propósito: é diferente de ROAS e confundir
// os dois leva a decisão errada.
function resultadoPorRealDeMidia(lucroAposMidia, totalMidia) {
  return dividir(lucroAposMidia, totalMidia);
}

// Break-even ROAS (§53M): abaixo disso, a mídia consome toda a margem do produto. Derivado da
// margem real, nunca de um percentual chutado. margemProduto vem em % (0-100).
function breakEvenRoas(margemProdutoPct) {
  const m = parseNumero(margemProdutoPct);
  if (m === null || m <= 0) return null;
  return dividir(1, m / 100);
}

// Blended CAC (§53N): TODO o gasto de mídia sobre TODOS os pedidos do período, inclusive os
// orgânicos. Não é o CPA da Meta e a UI precisa dizer isso — são perguntas diferentes.
function blendedCac(totalMidia, pedidosReais) {
  return dividir(totalMidia, pedidosReais);
}

// ── Qualidade do dado (§53AB, §53AA) ────────────────────────────────────────────────────────
// Um lucro alto pode ser só gasto faltando. A tela precisa poder dizer "parcial" e por quê, em vez
// de apresentar o número como se fosse fechado.

const QUALIDADE = { COMPLETO: 'completo', PARCIAL: 'parcial', SEM_DADO: 'sem_dado' };

function avaliarQualidade({ pedidosSemFinanceiro = 0, pedidos = 0, provedoresFaltando = [], despesasCadastradas = false, despesasNoPeriodo = null, midiaSincronizadaEm = null }) {
  const avisos = [];
  if (pedidos === 0) {
    return { nivel: QUALIDADE.SEM_DADO, avisos: ['nenhum pedido pago no período'] };
  }
  // Pedido de antes das colunas financeiras existirem não tem custo gravado. A primeira versão
  // deste aviso dizia que o lucro "aparece maior que o real" — está errado, e o erro apareceu em
  // produção: como a receita vinha de TODOS os pedidos e o custo só dos cobertos, a margem saía
  // menor (6% onde o real era ~45%) e o Lucro após Mídia ficava falsamente negativo.
  // Hoje o resultado é calculado só sobre os pedidos cobertos, então o aviso mudou de natureza:
  // não é mais sobre o número estar errado, é sobre o RECORTE que ele representa.
  if (pedidosSemFinanceiro > 0) {
    const cobertos = pedidos - pedidosSemFinanceiro;
    avisos.push(
      `o resultado abaixo cobre ${cobertos} de ${pedidos} ${cobertos === 1 ? 'pedido' : 'pedidos'} — os outros ${pedidosSemFinanceiro} ainda não têm custo de produção gravado. ` +
      'Rode o backfill de pedidos em Integrações para completar.'
    );
  }
  for (const p of provedoresFaltando) {
    avisos.push(`${PROVEDOR_ROTULO[p] || p} não conectado — o gasto dele não entra no total de mídia`);
  }
  if (!despesasCadastradas) {
    avisos.push('sem despesas operacionais cadastradas — o Lucro Operacional não é calculado');
  } else if (despesasNoPeriodo === 0) {
    // Despesa recorrente é lançada no dia da cobrança. Num período curto que não contém esse dia,
    // o total é zero e o Lucro Operacional fica igual ao Lucro após Mídia — matematicamente certo,
    // mas lê como "a operação não tem custo fixo", que é falso. O aviso existe pra essa leitura.
    avisos.push('nenhuma despesa cadastrada incide neste período — o Lucro Operacional não inclui custos fixos lançados em outras datas');
  }
  if (!midiaSincronizadaEm) {
    avisos.push('gasto de mídia nunca sincronizado');
  }
  return { nivel: avisos.length ? QUALIDADE.PARCIAL : QUALIDADE.COMPLETO, avisos };
}

// ── Comparação de atribuição (§52, §54, §89) ────────────────────────────────────────────────
// As três fontes medem coisas diferentes e a tela nunca deve sugerir equivalência. Cada linha diz
// o que a fonte sabe e o que ela NÃO sabe — campo não medido vem null, jamais zero.
function compararAtribuicao({ loja, meta, ga4 }) {
  return [
    {
      origem: 'loja',
      rotulo: 'Loja (real)',
      // A loja é a única fonte financeira: é dela que sai o dinheiro que de fato entrou.
      fonte: 'pedidos pagos da Reserva Ink',
      sessoes: null,
      cliques: null,
      compras: loja ? parseNumero(loja.pedidos) : null,
      receita: loja ? parseNumero(loja.receita) : null,
    },
    {
      origem: 'meta',
      rotulo: 'Meta (atribuído)',
      fonte: 'janela de atribuição da Meta',
      sessoes: null,
      cliques: meta ? parseNumero(meta.clicks) : null,
      compras: meta ? parseNumero(meta.purchases) : null,
      receita: meta ? parseNumero(meta.purchaseValue) : null,
    },
    {
      origem: 'ga4',
      rotulo: 'GA4 (atribuído)',
      fonte: 'último clique não direto, no GA4',
      sessoes: ga4 ? parseNumero(ga4.sessions) : null,
      cliques: null,
      compras: ga4 ? parseNumero(ga4.purchases) : null,
      receita: ga4 ? parseNumero(ga4.revenue) : null,
    },
  ];
}

module.exports = {
  PROVEDORES,
  PROVEDOR_ROTULO,
  QUALIDADE,
  totalizarMidia,
  montarResultado,
  mer,
  roasDeMargem,
  resultadoPorRealDeMidia,
  breakEvenRoas,
  blendedCac,
  avaliarQualidade,
  compararAtribuicao,
};
