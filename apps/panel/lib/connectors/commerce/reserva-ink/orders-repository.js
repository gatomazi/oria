'use strict';

// Etapa 2 (rodada G.1/Orders) · repositório do cache OPERACIONAL de pedidos da Ink
// (`pedidos_ink`/`pedidos_ink_itens` — sync periódico e webhook continuam em server.js, INTOCADO).
//
// Não duplica o histórico nem bate na API da Ink: lê exatamente o que já está sincronizado
// localmente, o mesmo dado que hoje alimenta `clienteJaComprou`/o consolidado financeiro. Full
// fetch da API só faria sentido se a cobertura local fosse insuficiente — não é o caso: o sync
// horário + webhook em tempo real (server.js) já mantêm isso quente.
//
// `commerce_product_id` (Fase D) é resolvido por JOIN direto com o catálogo canônico por
// (organization_id, store_id, provider='reserva_ink', provider_product_id) — não é Product Identity
// (Fase F, que resolve id OBSERVADO em analytics): aqui o id já É o id do produto na Ink
// (`pedidos_ink_itens.produto_id`), casamento exato por definição, sem ambiguidade a resolver. Item
// cujo produto nunca passou por um catalog sync fica com commerce_product_id = null — diagnosticável
// no mapper (lib/connectors/commerce/reserva-ink/mapper.js), nunca inventado.
//
// `pedidos_ink`/`pedidos_ink_itens` são TABELAS_TENANT sob RLS (lib/platform/tenancy-manifest.js);
// o filtro explícito por organization_id/store_id abaixo é defesa em profundidade, não substitui a
// policy — mesmo padrão de lib/product-analytics/commerce-catalog-repository.js.

const PROVIDER = 'reserva_ink';

// `criado_em` é o único timestamp confiável no cache local (não há `pago_em`/`paid_at` próprio —
// ver mapper.js e reconciliation.js para a consequência disso). Período ISO puro (YYYY-MM-DD),
// mesma convenção de ProductPerformanceService/GA4 — nunca período relativo aqui.
function condicaoPeriodo(alias, params, startDate, endDate) {
  params.push(startDate, endDate);
  return `${alias}.criado_em >= $${params.length - 1} AND ${alias}.criado_em < ($${params.length}::date + INTERVAL '1 day')`;
}

async function buscarItensDosPedidos(pool, organizationId, storeId, inkOrderIds) {
  if (!inkOrderIds.length) return new Map();
  const { rows } = await pool.query(
    `SELECT oi.ink_order_id, oi.item_id, oi.produto_id, oi.produto_nome, oi.sku, oi.modelo, oi.cor, oi.tamanho,
            oi.quantidade, oi.valor_venda, oi.desconto_rateado, cp.id AS commerce_product_id
       FROM pedidos_ink_itens oi
       LEFT JOIN commerce_products cp
         ON cp.organization_id = oi.organization_id AND cp.store_id = oi.store_id
        AND cp.provider = $3 AND cp.provider_product_id = oi.produto_id::text
      WHERE oi.organization_id = $1 AND oi.store_id = $2 AND oi.ink_order_id = ANY($4::bigint[])`,
    [organizationId, storeId, PROVIDER, inkOrderIds]
  );
  const porPedido = new Map();
  for (const r of rows) {
    if (!porPedido.has(r.ink_order_id)) porPedido.set(r.ink_order_id, []);
    porPedido.get(r.ink_order_id).push(r);
  }
  return porPedido;
}

/**
 * @param {{pool}} deps
 */
function createInkOrdersRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createInkOrdersRepository exige pool');

  // 1 query de pedidos (paginada) + 1 query de itens (todos os pedidos da página, de uma vez) —
  // nunca 1 query de itens por pedido (mesmo princípio de "nunca N+1" do resto da Fase D/G).
  async function listOrders({ organizationId, storeId, startDate, endDate, cursor, limit = 50 }) {
    if (!organizationId || !storeId) throw new TypeError('listOrders exige organizationId e storeId');
    if (!startDate || !endDate) throw new TypeError('listOrders exige startDate e endDate');
    const pagina = cursor ? Number(cursor) : 1;
    if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('cursor inválido');
    const tamanho = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const offset = (pagina - 1) * tamanho;

    const paramsTotal = [organizationId, storeId];
    const condTotal = condicaoPeriodo('p', paramsTotal, startDate, endDate);
    const { rows: totalRows } = await pool.query(
      `SELECT count(*)::int AS n FROM pedidos_ink p WHERE p.organization_id = $1 AND p.store_id = $2 AND ${condTotal}`,
      paramsTotal
    );

    const params = [organizationId, storeId];
    const cond = condicaoPeriodo('p', params, startDate, endDate);
    params.push(tamanho, offset);
    const { rows: pedidos } = await pool.query(
      `SELECT p.id, p.ink_order_id, p.payment_status, p.order_status, p.total_value, p.criado_em, p.atualizado_em, p.is_troca
         FROM pedidos_ink p
        WHERE p.organization_id = $1 AND p.store_id = $2 AND ${cond}
        ORDER BY p.criado_em DESC, p.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const itensPorPedido = await buscarItensDosPedidos(pool, organizationId, storeId, pedidos.map((p) => p.ink_order_id));
    const totalCount = totalRows[0].n;
    return {
      items: pedidos.map((p) => ({ pedido: p, itens: itensPorPedido.get(p.ink_order_id) || [] })),
      nextCursor: offset + pedidos.length < totalCount ? String(pagina + 1) : null,
      totalCount,
    };
  }

  async function getOrder({ organizationId, storeId, providerOrderId }) {
    if (!organizationId || !storeId) throw new TypeError('getOrder exige organizationId e storeId');
    if (!providerOrderId) throw new TypeError('getOrder exige providerOrderId');
    const inkOrderId = Number(providerOrderId);
    if (!Number.isSafeInteger(inkOrderId)) throw new TypeError('getOrder: providerOrderId inválido (esperado o inteiro da Ink)');
    const { rows } = await pool.query(
      `SELECT id, ink_order_id, payment_status, order_status, total_value, criado_em, atualizado_em, is_troca
         FROM pedidos_ink WHERE organization_id = $1 AND store_id = $2 AND ink_order_id = $3`,
      [organizationId, storeId, inkOrderId]
    );
    if (!rows.length) return null;
    const pedido = rows[0];
    // Chave do Map é o que o driver devolve para BIGINT (string), nunca o `inkOrderId` (Number)
    // derivado do `providerOrderId` de entrada — os dois tipos nunca batem num Map.get() estrito;
    // usar a própria coluna da linha lida evita esse descompasso de tipo.
    const itensPorPedido = await buscarItensDosPedidos(pool, organizationId, storeId, [inkOrderId]);
    return { pedido, itens: itensPorPedido.get(pedido.ink_order_id) || [] };
  }

  return Object.freeze({ listOrders, getOrder });
}

module.exports = { createInkOrdersRepository };
