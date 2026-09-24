'use strict';

// Fase G · leitura do catálogo CANÔNICO já sincronizado (Fase D) — nunca ao vivo via
// CommerceConnector, nunca `produtos_ink`. `ProductPerformanceService` depende só disto, nunca de
// um provider concreto: o repositório não sabe o que é Ink.
//
// §6.10: seleciona só as colunas que a tela precisa (nunca `metadata` inteiro) e pagina no banco —
// com ~85 mil produtos de catálogo, carregar tudo em memória não é opção.

const COLUNAS = 'id, name, image_url, product_type, provider, provider_product_id';
const ORDENACOES = Object.freeze({ name: 'name', price: 'price', created_at: 'created_at', updated_at: 'updated_at' });

function mapLinha(r) {
  return Object.freeze({
    id: r.id, name: r.name, imageUrl: r.image_url, productType: r.product_type, provider: r.provider, providerProductId: r.provider_product_id,
  });
}

function createCommerceCatalogRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createCommerceCatalogRepository exige pool');

  /**
   * Página do catálogo ativo, ordenada por coluna do PRÓPRIO catálogo (nunca por métrica de
   * analytics — essa vive em memória, fora do banco; ver product-performance-service.js).
   */
  async function listPage({ organizationId, storeId, provider, cursor, limit = 100, sortBy = 'name', sortDir = 'asc' }) {
    if (!organizationId || !storeId) throw new TypeError('listPage exige organizationId e storeId');
    const coluna = ORDENACOES[sortBy];
    if (!coluna) throw new TypeError(`sortBy inválido: ${sortBy}`);
    const direcao = sortDir === 'desc' ? 'DESC' : 'ASC';
    const pagina = cursor ? Number(cursor) : 1;
    if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('cursor inválido');
    const tamanho = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const offset = (pagina - 1) * tamanho;

    const condProvider = provider ? 'AND provider = $3' : '';
    const params = provider ? [organizationId, storeId, provider] : [organizationId, storeId];
    const { rows: total } = await pool.query(
      `SELECT count(*)::int AS n FROM commerce_products WHERE organization_id = $1 AND store_id = $2 AND is_active ${condProvider}`,
      params
    );
    // `coluna`/`direcao` só vêm do whitelist ORDENACOES/do literal 'DESC'/'ASC' acima — nunca de
    // texto livre do chamador, então interpolar aqui não abre injeção.
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM commerce_products WHERE organization_id = $1 AND store_id = $2 AND is_active ${condProvider}
        ORDER BY ${coluna} ${direcao} NULLS LAST, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, tamanho, offset]
    );
    const totalCount = total[0].n;
    return {
      items: rows.map(mapLinha),
      nextCursor: offset + rows.length < totalCount ? String(pagina + 1) : null,
      totalCount,
    };
  }

  /** Busca um conjunto específico de produtos por id — usado quando a ordenação é por MÉTRICA (o
   * conjunto é o dos produtos com alguma identity resolvida, não o catálogo inteiro). */
  async function getByIds({ organizationId, storeId, ids }) {
    if (!organizationId || !storeId) throw new TypeError('getByIds exige organizationId e storeId');
    if (!ids || !ids.length) return [];
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM commerce_products WHERE organization_id = $1 AND store_id = $2 AND is_active AND id = ANY($3::uuid[])`,
      [organizationId, storeId, ids]
    );
    return rows.map(mapLinha);
  }

  return Object.freeze({ listPage, getByIds });
}

module.exports = { createCommerceCatalogRepository, ORDENACOES };
