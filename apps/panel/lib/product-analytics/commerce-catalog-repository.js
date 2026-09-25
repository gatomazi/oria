'use strict';

// Fase G · leitura do catálogo CANÔNICO já sincronizado (Fase D) — nunca ao vivo via
// CommerceConnector, nunca `produtos_ink`. `ProductPerformanceService` depende só disto, nunca de
// um provider concreto: o repositório não sabe o que é Ink.
//
// §6.10: seleciona só as colunas que a tela precisa (nunca `metadata` inteiro) e pagina no banco —
// com ~85 mil produtos de catálogo, carregar tudo em memória não é opção.

const COLUNAS = 'id, name, image_url, product_type, provider, provider_product_id, is_active';
const ORDENACOES = Object.freeze({ name: 'name', price: 'price', created_at: 'created_at', updated_at: 'updated_at' });

// Rodada "Desempenho de Produtos: mais dados primeiro + filtros" · `is_active = false` é o que o
// full sync marca quando o produto deixou de aparecer na Ink (ver catalog-sync.js). Até esta rodada
// o repositório só devolvia ativos — "desativado" nunca aparecia na tela. O padrão continua sendo
// 'active' (nada muda pra quem já chamava sem `status`).
const STATUS_VALIDOS = Object.freeze(['active', 'inactive', 'all']);
const CONDICAO_STATUS = Object.freeze({ active: 'AND is_active', inactive: 'AND NOT is_active', all: '' });

function mapLinha(r) {
  return Object.freeze({
    id: r.id, name: r.name, imageUrl: r.image_url, productType: r.product_type, provider: r.provider,
    providerProductId: r.provider_product_id, isActive: r.is_active,
  });
}

function validarStatus(status) {
  if (!STATUS_VALIDOS.includes(status)) throw new TypeError(`status inválido: ${status} (permitidos: ${STATUS_VALIDOS.join(', ')})`);
  return CONDICAO_STATUS[status];
}

function createCommerceCatalogRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createCommerceCatalogRepository exige pool');

  /**
   * Página do catálogo, ordenada por coluna do PRÓPRIO catálogo (nunca por métrica de analytics —
   * essa vive em memória, fora do banco; ver product-performance-service.js).
   *
   *   status      'active' (padrão) | 'inactive' | 'all'
   *   onlyIds     restringe a um conjunto de ids (ex.: os que passaram num filtro de métrica, que só
   *               existe em memória) — o banco continua ordenando e paginando por coluna do catálogo
   *   excludeIds  tira um conjunto de ids (ex.: a "cauda" depois dos produtos com dado já rankeados)
   *   offset      posição inicial explícita (linhas); quando informado vence o `cursor` — usado pela
   *               cauda, cujo ponto de partida não é múltiplo do tamanho da página
   */
  async function listPage({
    organizationId, storeId, provider, cursor, limit = 100, sortBy = 'name', sortDir = 'asc',
    status = 'active', onlyIds, excludeIds, offset: offsetExplicito,
  }) {
    if (!organizationId || !storeId) throw new TypeError('listPage exige organizationId e storeId');
    const coluna = ORDENACOES[sortBy];
    if (!coluna) throw new TypeError(`sortBy inválido: ${sortBy}`);
    const condStatus = validarStatus(status);
    const direcao = sortDir === 'desc' ? 'DESC' : 'ASC';
    const pagina = cursor ? Number(cursor) : 1;
    if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('cursor inválido');
    const tamanho = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (offsetExplicito !== undefined && (!Number.isInteger(offsetExplicito) || offsetExplicito < 0)) throw new TypeError('offset inválido');
    const offset = offsetExplicito !== undefined ? offsetExplicito : (pagina - 1) * tamanho;

    const params = [organizationId, storeId];
    const condicoes = [];
    if (provider) { params.push(provider); condicoes.push(`AND provider = $${params.length}`); }
    if (onlyIds) {
      // Lista vazia é "nenhum produto passou no filtro", nunca "sem filtro" — não vai ao banco.
      if (!onlyIds.length) return { items: [], nextCursor: null, totalCount: 0 };
      params.push(onlyIds);
      condicoes.push(`AND id = ANY($${params.length}::uuid[])`);
    }
    if (excludeIds && excludeIds.length) {
      params.push(excludeIds);
      condicoes.push(`AND id <> ALL($${params.length}::uuid[])`);
    }
    const onde = `organization_id = $1 AND store_id = $2 ${condStatus} ${condicoes.join(' ')}`;

    const { rows: total } = await pool.query(`SELECT count(*)::int AS n FROM commerce_products WHERE ${onde}`, params);
    // `coluna`/`direcao` só vêm do whitelist ORDENACOES/do literal 'DESC'/'ASC' acima — nunca de
    // texto livre do chamador, então interpolar aqui não abre injeção.
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM commerce_products WHERE ${onde}
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
  async function getByIds({ organizationId, storeId, ids, status = 'active', provider }) {
    if (!organizationId || !storeId) throw new TypeError('getByIds exige organizationId e storeId');
    if (!ids || !ids.length) return [];
    const condStatus = validarStatus(status);
    const params = [organizationId, storeId, ids];
    let condProvider = '';
    if (provider) { params.push(provider); condProvider = `AND provider = $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM commerce_products WHERE organization_id = $1 AND store_id = $2 ${condStatus} AND id = ANY($3::uuid[]) ${condProvider}`,
      params
    );
    return rows.map(mapLinha);
  }

  return Object.freeze({ listPage, getByIds });
}

module.exports = { createCommerceCatalogRepository, ORDENACOES, STATUS_VALIDOS };
