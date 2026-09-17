'use strict';

// Normalização das métricas da Google Ads API. Puro de propósito (nenhum require, nenhum I/O), pelo
// mesmo motivo de lib/meta/actions.js: é a única forma de testar estas regras sem subir o server.
//
// Três armadilhas específicas da Google Ads API, todas capazes de produzir um número plausível e
// errado — o pior tipo de bug num painel financeiro:
//
// 1. MICROS. `cost_micros` vem em milionésimos da moeda da conta: R$ 12,50 chega como 12500000.
//    Mas `conversions_value` vem em moeda normal, como double. Tratar os dois igual erra o gasto
//    em 1.000.000x ou divide a receita por um milhão. Por isso existe UMA lista de campos em
//    micros, e nada converte por conta própria.
//
// 2. CONVERSÃO É FRACIONÁRIA. `metrics.conversions` é double, não inteiro — atribuição parcial faz
//    uma venda valer 0,5. Arredondar para int perde ou infla vendas.
//
// 3. conversions × all_conversions. São o mesmo evento contado por critérios diferentes:
//    `conversions` conta só as ações marcadas como principais; `all_conversions` conta todas.
//    Somar os dois duplica — é o mesmo erro que no Meta somar `purchase` com `omni_purchase`.
//    Aqui a regra é idêntica: escolher uma, nunca somar.

// ── Micros ──────────────────────────────────────────────────────────────────────────────────

const MICROS = 1e6;

// Campos que a API devolve em micros. Manter a lista explícita (em vez de confiar no sufixo
// "_micros") porque nem todo campo monetário tem o sufixo no nome que usamos internamente, e
// porque um campo novo tratado como micros por engano erraria em um milhão de vezes calado.
const CAMPOS_MICROS = new Set([
  'cost_micros',
  'average_cpc',
  'average_cpm',
  'average_cpv',
  'cost_per_conversion',
  'cost_per_all_conversions',
]);

function ehMicros(campo) {
  return CAMPOS_MICROS.has(campo);
}

// Converte micros para a moeda da conta. Devolve null para ausência real — o painel precisa
// distinguir "não veio" de "custou zero", senão mostra R$ 0,00 de gasto num dia sem dados.
function deMicros(valor) {
  const n = parseNumero(valor);
  return n === null ? null : n / MICROS;
}

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────

// A API devolve int64 como string em JSON (precisão), e omite campos zerados em algumas respostas.
// null = ausente de verdade; ≠ zero.
function parseNumero(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim());
  return Number.isFinite(n) ? n : null;
}

function parseNumeroOuZero(valor) {
  const n = parseNumero(valor);
  return n === null ? 0 : n;
}

// Conversões são DOUBLE de propósito: atribuição fracionária faz uma venda valer 0,5 em cada um de
// dois anúncios. Nunca arredondar — quem arredonda perde metade das vendas ou infla o total.
function parseConversoes(valor) {
  return parseNumeroOuZero(valor);
}

// ── Escolha de conversão ────────────────────────────────────────────────────────────────────

// Qual contagem de conversão o painel usa. 'conversions' é o padrão porque é o número que a
// própria interface do Google Ads mostra como "Conversões" — manter a mesma escolha evita o
// usuário comparar painel com Google Ads e ver divergência, que foi exatamente o cuidado que fez
// os números do Meta baterem.
const CONTAGENS_CONVERSAO = ['conversions', 'all_conversions'];
const CONTAGEM_PADRAO = 'conversions';

// Devolve a contagem escolhida e o valor correspondente, NUNCA a soma das duas.
function escolherConversao(linha, contagem = CONTAGEM_PADRAO) {
  const m = (linha && linha.metrics) || {};
  if (contagem === 'all_conversions') {
    return {
      conversoes: parseConversoes(m.all_conversions ?? m.allConversions),
      valorConversoes: parseNumeroOuZero(m.all_conversions_value ?? m.allConversionsValue),
      contagem: 'all_conversions',
    };
  }
  return {
    conversoes: parseConversoes(m.conversions),
    // conversions_value é double em moeda da conta — NÃO é micros.
    valorConversoes: parseNumeroOuZero(m.conversions_value ?? m.conversionsValue),
    contagem: 'conversions',
  };
}

// ── Linha de insight ────────────────────────────────────────────────────────────────────────

// Converte uma linha crua do GAQL nos campos que a tabela guarda. Só contadores brutos: nenhuma
// taxa é lida da API (ver `totalizar`).
function normalizarLinha(linha, { contagem = CONTAGEM_PADRAO } = {}) {
  const m = (linha && linha.metrics) || {};
  const seg = (linha && linha.segments) || {};
  const conv = escolherConversao(linha, contagem);
  return {
    data: seg.date || null,
    impressoes: parseNumeroOuZero(m.impressions),
    cliques: parseNumeroOuZero(m.clicks),
    // O único campo monetário em micros desta linha.
    custo: deMicros(m.cost_micros ?? m.costMicros) ?? 0,
    conversoes: conv.conversoes,
    valorConversoes: conv.valorConversoes,
    contagemConversao: conv.contagem,
    // Ausência é significativa: campanha de rede de pesquisa não tem impressão de vídeo, e mostrar
    // "0 views" seria enganoso. Por isso null, não zero.
    videoViews: parseNumero(m.video_views ?? m.videoViews),
  };
}

// ── Totalização ─────────────────────────────────────────────────────────────────────────────

// Soma um conjunto de linhas e RECALCULA as taxas a partir dos numeradores e denominadores
// somados. Nunca faz média de taxa: a média de CTR de sete dias não é o CTR da semana, e a API
// devolve `ctr` como fração (0,0171), não como pontos — depender dela é errar de duas formas ao
// mesmo tempo. Recalcular dispensa as duas preocupações.
function totalizar(linhas) {
  const total = {
    impressoes: 0, cliques: 0, custo: 0, conversoes: 0, valorConversoes: 0, dias: 0,
    videoViews: null,
  };
  for (const l of linhas || []) {
    total.impressoes += l.impressoes || 0;
    total.cliques += l.cliques || 0;
    total.custo += l.custo || 0;
    total.conversoes += l.conversoes || 0;
    total.valorConversoes += l.valorConversoes || 0;
    total.dias += 1;
    if (l.videoViews !== null && l.videoViews !== undefined) {
      total.videoViews = (total.videoViews || 0) + l.videoViews;
    }
  }
  return { ...total, ...derivadas(total) };
}

// ── Métricas derivadas ──────────────────────────────────────────────────────────────────────

// Devolve null quando o denominador é zero ou ausente, nunca 0 nem Infinity — o painel mostra "—",
// que é honesto, em vez de "ROAS 0" para quem nunca teve base para converter.
function dividir(numerador, denominador) {
  const n = parseNumero(numerador);
  const d = parseNumero(denominador);
  if (n === null || d === null || d === 0) return null;
  const r = n / d;
  return Number.isFinite(r) ? r : null;
}

// CTR em PONTOS (1.71), não em fração (0.0171) — mesma unidade do módulo do Meta, para as duas
// integrações caírem no mesmo formatador do front sem conversão no meio do caminho.
const metricas = {
  ctr: (cliques, impressoes) => {
    const r = dividir(cliques, impressoes);
    return r === null ? null : r * 100;
  },
  cpc: (custo, cliques) => dividir(custo, cliques),
  cpm: (custo, impressoes) => {
    const r = dividir(custo, impressoes);
    return r === null ? null : r * 1000;
  },
  cpa: (custo, conversoes) => dividir(custo, conversoes),
  roas: (valorConversoes, custo) => dividir(valorConversoes, custo),
  taxaConversao: (conversoes, cliques) => {
    const r = dividir(conversoes, cliques);
    return r === null ? null : r * 100;
  },
};

function derivadas(t) {
  return {
    ctr: metricas.ctr(t.cliques, t.impressoes),
    cpc: metricas.cpc(t.custo, t.cliques),
    cpm: metricas.cpm(t.custo, t.impressoes),
    cpa: metricas.cpa(t.custo, t.conversoes),
    roas: metricas.roas(t.valorConversoes, t.custo),
    taxaConversao: metricas.taxaConversao(t.conversoes, t.cliques),
  };
}

// ── Customer ID ─────────────────────────────────────────────────────────────────────────────

// A interface do Google Ads mostra "123-456-7890"; a API exige "1234567890". Aceitar as duas formas
// aqui evita o usuário colar o que vê e receber um erro sem explicação.
function normalizarCustomerId(valor) {
  const so = String(valor == null ? '' : valor).replace(/\D/g, '');
  return /^\d{10}$/.test(so) ? so : null;
}

function formatarCustomerId(valor) {
  const so = normalizarCustomerId(valor);
  return so ? `${so.slice(0, 3)}-${so.slice(3, 6)}-${so.slice(6)}` : null;
}

module.exports = {
  MICROS,
  CAMPOS_MICROS,
  CONTAGENS_CONVERSAO,
  CONTAGEM_PADRAO,
  ehMicros,
  deMicros,
  parseNumero,
  parseNumeroOuZero,
  parseConversoes,
  escolherConversao,
  normalizarLinha,
  totalizar,
  dividir,
  derivadas,
  metricas,
  normalizarCustomerId,
  formatarCustomerId,
};
