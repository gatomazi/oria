'use strict';

// Fase F · Product Identity — liga um id OBSERVADO em algum provider ao produto CANÔNICO
// (commerce_products), nunca por nome/slug (§5.5 do comando: nunca fuzzy, nunca Levenshtein, nunca
// "parece o mesmo produto" — itemName é só diagnóstico manual).
//
//   Bootstrap (a partir do catálogo canônico da Fase D)
//     commerce_products.provider_product_id   → namespace `<provider>.product_id`
//     commerce_product_variants.provider_variant_id → namespace `<provider>.variant_id`
//     commerce_product_variants.sku (quando ÚNICO na Store) → namespace `sku`
//
//   Resolução de um id externo de analytics (ex.: GA4 item_id)
//     1. mapping já existente NESTE namespace       → matched (existing_mapping)
//     2. match exato contra `<provider>.product_id` → matched (product_id), persiste source=rule
//     3. match exato contra `<provider>.variant_id` → matched (variant_id), persiste source=rule
//        (variant_id.commerce_product_id JÁ é o produto canônico — §5.7 não exige código à parte)
//     4. match exato contra `sku`                   → matched (sku), persiste source=rule
//     5. nada                                        → unresolved
//   Mais de um candidato em qualquer passo           → conflict; NUNCA escolhe, NUNCA persiste.
//
// Modo de identidade de VARIANTE (`variantIdentityMode`, rodada de otimização de armazenamento):
//   materialized  (padrão, comportamento histórico) uma linha `<provider>.variant_id` por variante em
//                 product_external_identities — espelho 1:1 do commerce_product_variants
//   dual          continua gravando como `materialized`, mas resolve o passo 3 pelos DOIS caminhos,
//                 devolve o resultado do caminho materializado e reporta divergências (`onDivergence`)
//   derived       não grava mais a identity mecânica de variante; o passo 3 lê o índice único
//                 (organization, store, provider, provider_variant_id) do catálogo canônico. Linhas
//                 que NÃO são espelho (manual/regra/histórica) continuam na tabela e VENCEM o catálogo.
// Nada disso muda o contrato de resolução (ordem, conflito, unresolved) — só de onde vem o passo 3.
//
// Tudo aqui é `pool` (fachada tenant-scoped, lib/platform/tenant-runtime.js) — quem chama já está
// dentro de `comContexto`/`comOrganization` da Organization certa, mesmo padrão de
// lib/product-analytics/catalog-sync.js e lib/platform/connector-integration-port.js.

const NAMESPACE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const FONTES = Object.freeze(['commerce_sync', 'analytics_observed', 'manual', 'rule']);
const CONFIANCAS = Object.freeze(['exact', 'verified', 'inferred']);
const MODOS_VARIANTE = Object.freeze(['materialized', 'dual', 'derived']);
const MODO_VARIANTE_PADRAO = 'materialized';

function modoDeVariante(deps) {
  const modo = deps && deps.variantIdentityMode ? deps.variantIdentityMode : MODO_VARIANTE_PADRAO;
  if (!MODOS_VARIANTE.includes(modo)) throw new TypeError(`variantIdentityMode inválido: ${JSON.stringify(modo)} (permitidos: ${MODOS_VARIANTE.join(', ')})`);
  return modo;
}

function validarNamespace(namespace) {
  if (typeof namespace !== 'string' || namespace === 'id' || !NAMESPACE_RE.test(namespace)) {
    throw new TypeError(`namespace inválido: ${JSON.stringify(namespace)} (nunca o genérico "id")`);
  }
  return namespace;
}

function validarAlvo({ organizationId, storeId }) {
  if (!organizationId || !storeId) throw new TypeError('organizationId e storeId são obrigatórios');
}

// ── Bootstrap a partir do catálogo canônico ───────────────────────────────────────────────────

/**
 * Cria/atualiza as identities DETERMINÍSTICAS (product_id, variant_id, sku-quando-único) a partir
 * do catálogo canônico já sincronizado (Fase D). Idempotente: rodar de novo com o mesmo catálogo
 * não duplica nem cria linha nova além do necessário.
 *
 * @param {{pool}} deps
 * @param {{organizationId: string, storeId: string, provider: string}} alvo
 */
async function bootstrapCommerceIdentities(deps, { organizationId, storeId, provider }) {
  const { pool } = deps;
  if (!pool) throw new Error('bootstrapCommerceIdentities exige pool');
  const modoVariante = modoDeVariante(deps);
  validarAlvo({ organizationId, storeId });
  if (!provider) throw new TypeError('provider é obrigatório');

  // `ON CONFLICT ... DO UPDATE ... WHERE`: quando a condição é falsa (identity virou `manual`), a
  // linha não conta no rowCount — não precisa de CTE nem de contagem à parte para isso.
  const upProdutos = await pool.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence, last_verified_at)
     SELECT organization_id, store_id, id, $3 || '.product_id', provider_product_id, 'commerce_sync', 'exact', now()
       FROM commerce_products WHERE organization_id = $1 AND store_id = $2 AND provider = $3 AND is_active
     ON CONFLICT (organization_id, store_id, namespace, external_id) DO UPDATE SET
       commerce_product_id = EXCLUDED.commerce_product_id, last_verified_at = now(), updated_at = now()
       -- nunca reescreve uma identity que um humano confirmou por cima do bootstrap automático; e só
       -- reescreve quando o produto alvo MUDOU (sem isso cada sync regravava todas as linhas, não-HOT)
       WHERE product_external_identities.source = 'commerce_sync'
         AND product_external_identities.commerce_product_id IS DISTINCT FROM EXCLUDED.commerce_product_id`,
    [organizationId, storeId, provider]
  );

  // Modo `derived`: a identity mecânica de variante seria cópia exata de commerce_product_variants
  // (o passo 3 da resolução lê o catálogo direto) — não se grava mais.
  const upVariantes = modoVariante === 'derived'
    ? { rowCount: 0 }
    : await pool.query(
      `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence, last_verified_at)
       SELECT v.organization_id, v.store_id, v.commerce_product_id, $3 || '.variant_id', v.provider_variant_id, 'commerce_sync', 'exact', now()
         FROM commerce_product_variants v WHERE v.organization_id = $1 AND v.store_id = $2 AND v.provider = $3 AND v.is_active
       ON CONFLICT (organization_id, store_id, namespace, external_id) DO UPDATE SET
         commerce_product_id = EXCLUDED.commerce_product_id, last_verified_at = now(), updated_at = now()
         WHERE product_external_identities.source = 'commerce_sync'
           AND product_external_identities.commerce_product_id IS DISTINCT FROM EXCLUDED.commerce_product_id`,
      [organizationId, storeId, provider]
    );

  // SKU: só entra como identity quando é ÚNICO dentro da Store (entre TODOS os providers, porque SKU
  // costuma ser identificador do lojista, não do provider) — §5.4. Um SKU que deixou de ser único
  // desde o último bootstrap é REMOVIDO se a identity foi gerada automaticamente (nunca uma `manual`).
  const desativarAmbiguos = await pool.query(
    `DELETE FROM product_external_identities pei
      WHERE pei.organization_id = $1 AND pei.store_id = $2 AND pei.namespace = 'sku' AND pei.source = 'commerce_sync'
        AND pei.external_id IN (
          SELECT sku FROM commerce_product_variants
           WHERE organization_id = $1 AND store_id = $2 AND is_active AND sku IS NOT NULL AND btrim(sku) <> ''
           GROUP BY sku HAVING count(DISTINCT commerce_product_id) > 1
        )`,
    [organizationId, storeId]
  );
  const upSku = await pool.query(
    `WITH contagem AS (
       -- min()/max() não existem para uuid no Postgres; count(DISTINCT …) = 1 já garante que
       -- qualquer valor do grupo É o único, então array_agg(…)[1] pega ele sem exigir ordenação.
       SELECT sku, count(DISTINCT commerce_product_id) AS produtos, (array_agg(commerce_product_id))[1] AS unico
         FROM commerce_product_variants
        WHERE organization_id = $1 AND store_id = $2 AND is_active AND sku IS NOT NULL AND btrim(sku) <> ''
        GROUP BY sku
     )
     INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence, last_verified_at)
     SELECT $1, $2, unico, 'sku', sku, 'commerce_sync', 'exact', now() FROM contagem WHERE produtos = 1
     ON CONFLICT (organization_id, store_id, namespace, external_id) DO UPDATE SET
       commerce_product_id = EXCLUDED.commerce_product_id, last_verified_at = now(), updated_at = now()
       WHERE product_external_identities.source = 'commerce_sync'
         AND product_external_identities.commerce_product_id IS DISTINCT FROM EXCLUDED.commerce_product_id`,
    [organizationId, storeId]
  );

  return {
    productIdentities: upProdutos.rowCount,
    variantIdentities: upVariantes.rowCount,
    skuIdentities: upSku.rowCount,
    skuConflictsRemoved: desativarAmbiguos.rowCount,
  };
}

// ── Resolução ──────────────────────────────────────────────────────────────────────────────────

const CANDIDATOS = Object.freeze([
  ['product_id', '%.product_id'],
  ['variant_id', '%.variant_id'],
  ['sku', 'sku'],
]);

// Candidatos vindos de product_external_identities (namespace LIKE padrão).
async function candidatosPorIdentidade(pool, { organizationId, storeId, padrao, ids }) {
  const { rows } = await pool.query(
    `SELECT external_id, commerce_product_id, namespace, source FROM product_external_identities
      WHERE organization_id = $1 AND store_id = $2 AND namespace LIKE $3 AND external_id = ANY($4::text[])`,
    [organizationId, storeId, padrao, ids]
  );
  return rows;
}

// Candidatos derivados do catálogo canônico: o índice único (organization, store, provider,
// provider_variant_id) já É o mapeamento variante → produto. Os providers da Store saem do próprio
// índice (loose index scan recursivo: 1 sonda por provider, sem tabela auxiliar que possa ficar
// velha) e entram como ARRAY num init-plan: o Postgres usa as DUAS listas (provider e id) como
// condição do mesmo índice. Medido nas versões 16 e 18: um JOIN com o CTE virava Hash Join + Seq Scan
// da tabela inteira no 16 (e LATERAL/OFFSET 0 era até 5× mais lento nos ids sem correspondência).
// Não filtra `is_active`: a identity materializada nunca foi apagada quando a variante saía do
// catálogo (só deixava de ser atualizada), e o histórico continua resolvendo.
async function candidatosDoCatalogo(pool, { organizationId, storeId, ids }) {
  const { rows } = await pool.query(
    `WITH RECURSIVE providers(provider) AS (
       (SELECT provider FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 ORDER BY provider LIMIT 1)
       UNION ALL
       SELECT (SELECT provider FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 AND provider > p.provider ORDER BY provider LIMIT 1)
         FROM providers p WHERE p.provider IS NOT NULL
     )
     SELECT provider_variant_id AS external_id, commerce_product_id, provider || '.variant_id' AS namespace
       FROM commerce_product_variants
      WHERE organization_id = $1 AND store_id = $2
        AND provider = ANY(ARRAY(SELECT provider FROM providers WHERE provider IS NOT NULL))
        AND provider_variant_id = ANY($3::text[])`,
    [organizationId, storeId, ids]
  );
  return rows;
}

// Identity gravada (manual/regra/histórica) vence o catálogo no MESMO (namespace, external_id):
// é o que já acontecia quando o bootstrap não sobrescrevia uma identity `manual`.
function mesclarCandidatos(identidades, doCatalogo) {
  const gravadas = new Set(identidades.map((c) => `${c.namespace}\u0000${c.external_id}`));
  return [...identidades, ...doCatalogo.filter((c) => !gravadas.has(`${c.namespace}\u0000${c.external_id}`))];
}

function produtosPorId(candidatos) {
  const porId = new Map();
  for (const c of candidatos) {
    if (!porId.has(c.external_id)) porId.set(c.external_id, new Set());
    porId.get(c.external_id).add(c.commerce_product_id);
  }
  return porId;
}

// Passo 3 (variant id) nos três modos — ver o cabeçalho do arquivo.
async function candidatosDeVariante(deps, alvo, modo) {
  const { pool } = deps;
  const gravados = await candidatosPorIdentidade(pool, { ...alvo, padrao: '%.variant_id' });
  if (modo === 'materialized') return gravados;

  // Linhas `commerce_sync` são o ESPELHO do catálogo (bootstrap): no derived não valem nem enquanto
  // ainda existem (antes da poda) — uma linha espelho velha (variante que o provider passou para outro
  // produto) nunca pode vencer o catálogo, que é a verdade. Só manual/regra/etc. vencem o catálogo.
  const derivados = mesclarCandidatos(gravados.filter((c) => c.source !== 'commerce_sync'), await candidatosDoCatalogo(pool, alvo));
  if (modo === 'derived') return derivados;

  // dual: o resultado que vale continua sendo o materializado; o derivado só é comparado.
  if (typeof deps.onDivergence === 'function') {
    const antigo = produtosPorId(gravados);
    const novo = produtosPorId(derivados);
    const divergencias = [];
    for (const id of new Set([...antigo.keys(), ...novo.keys()])) {
      const a = [...(antigo.get(id) || [])].sort();
      const n = [...(novo.get(id) || [])].sort();
      if (a.length === n.length && a.every((v, i) => v === n[i])) continue;
      divergencias.push({ externalId: id, materialized: a, derived: n, kind: !a.length ? 'derived_only' : !n.length ? 'materialized_only' : 'different_product' });
    }
    // Uma chamada por resolução (nunca uma por id): quem loga agrega e nunca inunda o log.
    if (divergencias.length) deps.onDivergence(divergencias);
  }
  return gravados;
}

/**
 * Resolve uma lista de ids observados (ex.: GA4 item_id) contra as identities já conhecidas —
 * SOMENTE LEITURA, nunca persiste. Ordem determinística (§5.5): mapping existente → product id →
 * variant id → sku único → unresolved. Nunca fuzzy.
 */
async function resolveExternalIds(deps, { organizationId, storeId, namespace, externalIds }) {
  const { pool } = deps;
  if (!pool) throw new Error('resolveExternalIds exige pool');
  validarAlvo({ organizationId, storeId });
  validarNamespace(namespace);
  const modoVariante = modoDeVariante(deps);
  const ids = [...new Set((externalIds || []).map((v) => String(v ?? '').trim()).filter(Boolean))];
  if (!ids.length) return { resolved: [], conflicts: [], unresolved: [] };

  const { rows: existentes } = await pool.query(
    `SELECT external_id, commerce_product_id FROM product_external_identities
      WHERE organization_id = $1 AND store_id = $2 AND namespace = $3 AND external_id = ANY($4::text[])`,
    [organizationId, storeId, namespace, ids]
  );
  const resolved = existentes.map((r) => ({ externalId: r.external_id, commerceProductId: r.commerce_product_id, matchedVia: 'existing_mapping' }));
  const conflicts = [];
  let restantes = ids.filter((id) => !existentes.some((r) => r.external_id === id));

  for (const [classe, padrao] of CANDIDATOS) {
    if (!restantes.length) break;
    // eslint-disable-next-line no-await-in-loop
    const candidatos = classe === 'variant_id'
      ? await candidatosDeVariante(deps, { organizationId, storeId, ids: restantes }, modoVariante)
      : await candidatosPorIdentidade(pool, { organizationId, storeId, padrao, ids: restantes });
    const porId = produtosPorId(candidatos);
    const naoResolvidos = [];
    for (const id of restantes) {
      const produtos = porId.get(id);
      if (!produtos) { naoResolvidos.push(id); continue; }
      if (produtos.size > 1) { conflicts.push({ externalId: id, candidateCommerceProductIds: [...produtos], matchedVia: classe }); continue; }
      resolved.push({ externalId: id, commerceProductId: [...produtos][0], matchedVia: classe });
    }
    restantes = naoResolvidos;
  }

  return { resolved, conflicts, unresolved: restantes.map((externalId) => ({ externalId })) };
}

/**
 * Persiste como `source: 'rule', confidence: 'exact'` só os matches resolvidos por REGRA
 * determinística (nunca os que já eram `existing_mapping`, que não mudam). `ON CONFLICT DO NOTHING`:
 * nunca sobrescreve uma linha concorrente (conflito de verdade fica pra próxima resolução decidir).
 */
async function persistRuleMatches({ pool }, { organizationId, storeId, namespace }, resolved) {
  if (!pool) throw new Error('persistRuleMatches exige pool');
  validarAlvo({ organizationId, storeId });
  validarNamespace(namespace);
  const novos = (resolved || []).filter((r) => r.matchedVia && r.matchedVia !== 'existing_mapping');
  if (!novos.length) return { persisted: 0 };
  const { rowCount } = await pool.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence, last_verified_at)
     SELECT $1, $2, x.commerce_product_id, $3, x.external_id, 'rule', 'exact', now()
       FROM unnest($4::uuid[], $5::text[]) AS x(commerce_product_id, external_id)
     ON CONFLICT (organization_id, store_id, namespace, external_id) DO NOTHING`,
    [organizationId, storeId, namespace, novos.map((r) => r.commerceProductId), novos.map((r) => r.externalId)]
  );
  return { persisted: rowCount };
}

/**
 * Resolve E persiste num só passo — o caminho normal de uso (ex.: depois de um `getProductPerformance`
 * do GA4, resolver os `externalProductId` observados). Devolve a resolução (para diagnóstico/coverage)
 * já refletindo o que acabou de ser persistido.
 */
async function resolveAndPersist(deps, alvo) {
  const resolucao = await resolveExternalIds(deps, alvo);
  await persistRuleMatches(deps, alvo, resolucao.resolved);
  return resolucao;
}

// ── Coverage (§5.8) ────────────────────────────────────────────────────────────────────────────

/**
 * Puro — não toca banco. `resolucao` é o resultado de resolveExternalIds/resolveAndPersist;
 * `observedCount` é quantos ids distintos foram OBSERVADOS (pode ser maior que resolved+conflicts+
 * unresolved só se o chamador passou ids repetidos — normalmente serão iguais).
 */
function computeCoverage(resolucao, observedCount) {
  const observed = Number.isFinite(observedCount)
    ? observedCount
    : resolucao.resolved.length + resolucao.conflicts.length + resolucao.unresolved.length;
  if (observed <= 0) {
    return Object.freeze({ observedItemIds: 0, matchedItemIds: 0, unmatchedItemIds: 0, conflictedItemIds: 0, coverageRate: null, status: 'insufficient_data' });
  }
  const matched = resolucao.resolved.length;
  const conflicted = resolucao.conflicts.length;
  const unmatched = resolucao.unresolved.length;
  return Object.freeze({
    observedItemIds: observed, matchedItemIds: matched, unmatchedItemIds: unmatched, conflictedItemIds: conflicted,
    coverageRate: matched / observed, status: 'ok',
  });
}

module.exports = {
  FONTES, CONFIANCAS, MODOS_VARIANTE, NAMESPACE_RE, validarNamespace,
  bootstrapCommerceIdentities, resolveExternalIds, persistRuleMatches, resolveAndPersist, computeCoverage,
};
