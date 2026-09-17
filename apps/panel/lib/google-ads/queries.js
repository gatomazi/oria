'use strict';

// Montagem das consultas GAQL. Mora aqui, e não no server.js, por um motivo aprendido caro: uma
// consulta escrita direto na rota não é alcançável por teste, e cada campo inventado só aparecia
// como erro em produção — um deploy por engano.
//
// A regra deste arquivo: **todo campo usado precisa estar declarado numa lista**. Um campo que não
// existe derruba a consulta INTEIRA, não só a coluna dele, então "no pior caso vem vazio" não é
// verdade aqui — no pior caso não vem nada.
//
// Lista curta de propósito. Só o que é núcleo de gasto e conversão; qualquer campo novo entra
// depois de conferido contra a conta real, um de cada vez.

// Campos de métrica. Cada um já foi aceito pela API numa consulta real.
const METRICAS = [
  'metrics.impressions',
  'metrics.clicks',
  // Único campo monetário em micros da resposta (ver lib/google-ads/metricas.js).
  'metrics.cost_micros',
  'metrics.conversions',
  'metrics.conversions_value',
  // A régua alternativa. Guardada junto para poder trocar sem re-sincronizar — nunca somada com a
  // de cima, que seria contar a mesma venda duas vezes.
  'metrics.all_conversions',
  'metrics.all_conversions_value',
];

// Campos que NÃO existem (ou deixaram de existir) e já quebraram uma consulta. Ficam registrados
// para que a intenção de usá-los volte como erro de teste, não como sync quebrado em produção.
const CAMPOS_RECUSADOS = new Set([
  // "Unrecognized field in the query" na v25 — devolvido pela API em 15/09/2026.
  'metrics.video_views',
]);

const NIVEIS = {
  customer: { recurso: 'customer', chaves: ['customer.id'] },
  campaign: { recurso: 'campaign', chaves: ['campaign.id', 'campaign.name'] },
};

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Uma linha por dia: sem `segments.date` a API devolveria o período inteiro somado numa linha só, e
// não existiria série diária nenhuma.
function queryInsights(nivel, de, ate) {
  const cfg = NIVEIS[nivel];
  if (!cfg) throw new Error(`nível desconhecido: ${nivel}`);
  // As datas entram numa string de consulta. Validar o formato aqui é o que garante que nada além
  // de uma data possa ser concatenado.
  if (!DATA_RE.test(de) || !DATA_RE.test(ate)) throw new Error('datas precisam estar em AAAA-MM-DD');

  const campos = [...cfg.chaves, 'segments.date', ...METRICAS];
  for (const campo of campos) {
    if (CAMPOS_RECUSADOS.has(campo)) throw new Error(`campo recusado pela API: ${campo}`);
  }
  return `SELECT ${campos.join(', ')} FROM ${cfg.recurso} `
    + `WHERE segments.date BETWEEN '${de}' AND '${ate}'`;
}

// Detalhes da conta. `customer_client` é a segunda tentativa: consultar a conta diretamente falha
// quando ela é acessada através de uma conta de administrador.
function queryConta() {
  return 'SELECT customer.id, customer.descriptive_name, customer.currency_code, '
    + 'customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1';
}

function queryContaCliente(customerId) {
  const id = String(customerId).replace(/\D/g, '');
  if (!/^\d{10}$/.test(id)) throw new Error('customer id precisa ter 10 dígitos');
  return 'SELECT customer_client.id, customer_client.descriptive_name, '
    + 'customer_client.currency_code, customer_client.time_zone, customer_client.manager, '
    + `customer_client.test_account FROM customer_client WHERE customer_client.id = ${id}`;
}

module.exports = { METRICAS, CAMPOS_RECUSADOS, NIVEIS, queryInsights, queryConta, queryContaCliente };
