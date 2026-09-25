'use strict';

// Rodada "Desempenho de Produtos: mais dados primeiro + filtros" · regra única dos filtros da
// listagem — a rota HTTP valida a entrada com isto e o ProductPerformanceService aplica com isto, pra
// nunca existirem duas definições do que "comprados ≥ 5" ou "somente com dados" significa.
//
//   status        'active' (padrão) | 'inactive' | 'all' — é `is_active` do catálogo canônico: o full
//                 sync marca inativo o produto que deixou de aparecer na Ink
//   min*          mínimo (>=) de cada contagem de item do período; 0 ou ausente = sem filtro. Métrica
//                 indisponível (null — a propriedade GA4 não suporta) NUNCA satisfaz um mínimo > 0
//   hasData       só produtos com alguma atividade observada no período (volume > 0)
//   provider      já existia (passthrough pro catálogo)
//
// Mínimos e hasData só existem em memória (o GA4 não vive no banco) — por isso o service os trata
// no caminho de "conjunto elegível" e nunca no de paginação direta do catálogo.

const STATUS_VALIDOS = Object.freeze(['active', 'inactive', 'all']);

// Pseudo-campo de ordenação "mais dados primeiro" (não é coluna do catálogo nem métrica): quem tem
// dado observado no período vem primeiro, do maior volume pro menor, e o resto do catálogo depois,
// por nome. Vive aqui pra rota (whitelist do `sort`) e service (o algoritmo) usarem O MESMO nome.
const CAMPO_MAIS_DADOS = 'data';

// chave do filtro → métrica de item que ele limita
const MINIMOS = Object.freeze({
  minViewed: 'itemsViewed',
  minAddedToCart: 'itemsAddedToCart',
  minCheckedOut: 'itemsCheckedOut',
  minPurchased: 'itemsPurchased',
  minRevenue: 'itemRevenue',
});

// As quatro contagens de item entram no "volume de dados" (receita não: é valor, não evento).
// Métrica indisponível conta como 0 aqui — o volume só decide ordem, nunca é mostrado como número.
const CONTAGENS = Object.freeze(['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased']);

function volumeDeDados(metrics) {
  if (!metrics) return 0;
  let total = 0;
  for (const nome of CONTAGENS) total += metrics[nome] || 0;
  return total;
}

/** Valida e normaliza os filtros. Lança TypeError (mensagem segura, sem dado do tenant). */
function normalizarFiltros(filters = {}) {
  const status = filters.status === undefined || filters.status === null ? 'active' : filters.status;
  if (!STATUS_VALIDOS.includes(status)) throw new TypeError(`status inválido: ${status} (permitidos: ${STATUS_VALIDOS.join(', ')})`);

  const minimos = [];
  for (const [chave, metrica] of Object.entries(MINIMOS)) {
    const valor = filters[chave];
    if (valor === undefined || valor === null) continue;
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < 0) throw new TypeError(`${chave} deve ser um número maior ou igual a 0`);
    if (valor > 0) minimos.push({ chave, metrica, minimo: valor });
  }
  const somenteComDados = filters.hasData === true;
  return Object.freeze({
    provider: filters.provider,
    status,
    minimos: Object.freeze(minimos),
    somenteComDados,
    temFiltroDeMetrica: minimos.length > 0 || somenteComDados,
  });
}

/** `acumulado` é { metrics } de um produto (ou undefined: nenhum dado). */
function passaNosFiltrosDeMetrica(acumulado, filtros) {
  if (!filtros.temFiltroDeMetrica) return true;
  const metrics = acumulado && acumulado.metrics;
  if (filtros.somenteComDados && !(volumeDeDados(metrics) > 0)) return false;
  for (const { metrica, minimo } of filtros.minimos) {
    const valor = metrics ? metrics[metrica] : null;
    if (valor === null || valor === undefined || valor < minimo) return false;
  }
  return true;
}

module.exports = { STATUS_VALIDOS, CAMPO_MAIS_DADOS, MINIMOS, CONTAGENS, volumeDeDados, normalizarFiltros, passaNosFiltrosDeMetrica };
