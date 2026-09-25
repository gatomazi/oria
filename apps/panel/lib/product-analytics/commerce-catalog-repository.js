'use strict';

// Fase G · leitura do catálogo CANÔNICO já sincronizado (Fase D) — nunca ao vivo via
// CommerceConnector, nunca `produtos_ink`. `ProductPerformanceService` depende só disto, nunca de
// um provider concreto: o repositório não sabe o que é Ink.
//
// §6.10: seleciona só as colunas que a tela precisa (nunca `metadata` inteiro) e pagina no banco —
// com ~85 mil produtos de catálogo, carregar tudo em memória não é opção.

const COLUNAS = "id, name, image_url, product_type, provider, provider_product_id, is_active, metadata->>'status' AS provider_status";
const ORDENACOES = Object.freeze({ name: 'name', price: 'price', created_at: 'created_at', updated_at: 'updated_at' });

// Situação do produto (rodada "Desempenho de Produtos: mais dados primeiro + filtros" → "busca por
// nome, reconciliação paginada"). Achado real: `is_active` é só "a Ink ainda lista o produto no último
// full sync" — e a Ink lista TAMBÉM os desativados/não publicados (por isso o cache de catálogo "inclui
// desativado, oculto e não aprovado"). O que o lojista chama de produto ATIVO é o que a tela Produtos
// mostra como "Publicado": o `status` da Ink, que o sync já grava em `metadata.status`.
//
//   active    listado no último sync E publicado — o padrão da Desempenho de Produtos
//   inactive  o contrário de active (não publicado, recusado, arte inválida… ou fora da Ink)
//   all       sem filtro de situação
//   synced    só `is_active` (o comportamento ANTERIOR) — detalhe do produto e Prioridades de hoje
//             continuam achando um produto mesmo não publicado
//
// Provider que não informa `status` conta como publicado (benefício da dúvida; hoje só a Ink existe).
// `metadata` é JSONB NOT NULL, então `metadata->>'status'` nunca falha; `oculto` (visible=false) é
// outra coisa e NÃO entra aqui.
const STATUS_VALIDOS = Object.freeze(['active', 'inactive', 'all', 'synced']);

/** Fragmento SQL (sem AND) da situação; '' quando não há filtro. `alias` só pra quem faz JOIN. */
function condicaoDeStatus(status, alias = '') {
  if (!STATUS_VALIDOS.includes(status)) throw new TypeError(`status inválido: ${status} (permitidos: ${STATUS_VALIDOS.join(', ')})`);
  const p = alias ? `${alias}.` : '';
  const ativo = `(${p}is_active AND COALESCE(${p}metadata->>'status', 'published') = 'published')`;
  if (status === 'active') return ativo;
  if (status === 'inactive') return `NOT ${ativo}`;
  if (status === 'synced') return `${p}is_active`;
  return '';
}

function mapLinha(r) {
  const publicado = (r.provider_status ?? 'published') === 'published';
  return Object.freeze({
    id: r.id, name: r.name, imageUrl: r.image_url, productType: r.product_type, provider: r.provider,
    providerProductId: r.provider_product_id,
    // Ativo no sentido do lojista (ver acima) — a tela rotula o resto de "Desativado".
    isActive: !!r.is_active && publicado,
    // `status` cru do provider (ex.: 'not_published'), pra a tela dizer O QUÊ em vez de só "desativado".
    providerStatus: r.provider_status ?? null,
  });
}

// Busca por nome: cada palavra precisa aparecer (E), sem diferenciar maiúscula. O texto do usuário
// nunca vira SQL — só parâmetro; `%`, `_` e `\` dele são escapados pra valerem como letra.
function condicoesDeBusca(termos, params) {
  const condicoes = [];
  for (const termo of termos || []) {
    params.push(`%${String(termo).replace(/[\\%_]/g, '\\$&')}%`);
    condicoes.push(`AND name ILIKE $${params.length} ESCAPE '\\'`);
  }
  return condicoes;
}

function createCommerceCatalogRepository({ pool }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createCommerceCatalogRepository exige pool');

  /**
   * Página do catálogo, ordenada por coluna do PRÓPRIO catálogo (nunca por métrica de analytics —
   * essa vive em memória, fora do banco; ver product-performance-service.js).
   *
   *   status      'active' (padrão) | 'inactive' | 'all' | 'synced' — ver `condicaoDeStatus`
   *   search      palavras do nome (todas precisam aparecer); a situação NÃO é filtrada pelo repositório
   *               por causa disso — quem chama a busca passa status 'all'
   *   onlyIds     restringe a um conjunto de ids (ex.: os que passaram num filtro de métrica, que só
   *               existe em memória) — o banco continua ordenando e paginando por coluna do catálogo
   *   excludeIds  tira um conjunto de ids (ex.: a "cauda" depois dos produtos com dado já rankeados)
   *   offset      posição inicial explícita (linhas); quando informado vence o `cursor` — usado pela
   *               cauda, cujo ponto de partida não é múltiplo do tamanho da página
   */
  async function listPage({
    organizationId, storeId, provider, cursor, limit = 100, sortBy = 'name', sortDir = 'asc',
    status = 'active', search, onlyIds, excludeIds, offset: offsetExplicito,
  }) {
    if (!organizationId || !storeId) throw new TypeError('listPage exige organizationId e storeId');
    const coluna = ORDENACOES[sortBy];
    if (!coluna) throw new TypeError(`sortBy inválido: ${sortBy}`);
    const filtroStatus = condicaoDeStatus(status);
    const condStatus = filtroStatus ? `AND ${filtroStatus}` : '';
    const direcao = sortDir === 'desc' ? 'DESC' : 'ASC';
    const pagina = cursor ? Number(cursor) : 1;
    if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('cursor inválido');
    const tamanho = Math.min(Math.max(Number(limit) || 100, 1), 500);
    if (offsetExplicito !== undefined && (!Number.isInteger(offsetExplicito) || offsetExplicito < 0)) throw new TypeError('offset inválido');
    const offset = offsetExplicito !== undefined ? offsetExplicito : (pagina - 1) * tamanho;

    const params = [organizationId, storeId];
    const condicoes = [];
    if (provider) { params.push(provider); condicoes.push(`AND provider = $${params.length}`); }
    condicoes.push(...condicoesDeBusca(search, params));
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
  // `status` padrão 'synced' (só `is_active`, o comportamento de sempre): quem chama sem dizer nada
  // — detalhe do produto, Prioridades de hoje — continua achando o produto mesmo não publicado.
  async function getByIds({ organizationId, storeId, ids, status = 'synced', provider, search }) {
    if (!organizationId || !storeId) throw new TypeError('getByIds exige organizationId e storeId');
    if (!ids || !ids.length) return [];
    const filtroStatus = condicaoDeStatus(status);
    const condStatus = filtroStatus ? `AND ${filtroStatus}` : '';
    const params = [organizationId, storeId, ids];
    const condicoes = [];
    if (provider) { params.push(provider); condicoes.push(`AND provider = $${params.length}`); }
    condicoes.push(...condicoesDeBusca(search, params));
    const { rows } = await pool.query(
      `SELECT ${COLUNAS} FROM commerce_products WHERE organization_id = $1 AND store_id = $2 ${condStatus} AND id = ANY($3::uuid[]) ${condicoes.join(' ')}`,
      params
    );
    return rows.map(mapLinha);
  }

  return Object.freeze({ listPage, getByIds });
}

module.exports = { createCommerceCatalogRepository, ORDENACOES, STATUS_VALIDOS, condicaoDeStatus };
