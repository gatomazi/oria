'use strict';

// Fase D · Canonical Commerce Catalog Sync.
//
// Full snapshot PAGINADO — não incremental. Sem `updated_since` confiável/documentado na Ink
// (docs/features/… V2 §9), a única fonte de verdade de "o que ainda existe no provider" é varrer
// todas as páginas de novo a cada execução. `cursor` é só paginação, não um marcador de data.
//
//   page 1 → upsert  ┐
//   page 2 → upsert  ├─ cada página persiste e sai da memória; nunca acumula o catálogo inteiro
//   page N → upsert  ┘
//   TODAS as páginas OK → desativa o que não foi visto nesta execução (nunca antes disso)
//
// Dependência SEMPRE por CommerceConnector, nunca por provider concreto:
//
//   CatalogSync → registry.resolve('commerce', provider, ctx) → CommerceConnector
//
// nunca `CatalogSync → ReservaInkCommerceConnector`. `runCatalogSync` não sabe o que é Ink — recebe
// `provider` como dado e pede ao registry o connector, exatamente como Fase B prevê.
//
// Sem N+1 de variantes: o sync exige a capability `productsWithVariants` (produto + variantes no
// MESMO payload de página — ver lib/connectors/commerce/reserva-ink/connector.js) e usa só
// `listProductsWithVariants`. Nunca chama `listProductVariants` por produto aqui — esse método
// continua existindo só para consulta pontual, fora do full sync.
//
// Concorrência: um lease por (job, organizationId) — `commerce-catalog-sync:<provider>` — impede
// dois full syncs simultâneos da mesma Organization+Store+provider (1 Organization = 1 Store,
// ORIA-TENANCY-STORE-01, então a Store já está implícita na Organization). Evita duas execuções
// marcando `last_seen_sync_id` uma da outra como ausente.
//
// Falha parcial: se uma página falhar, os upserts das páginas anteriores FICAM (não há rollback
// deliberado de página bem-sucedida), mas a fase de desativação NUNCA roda — nada vira inativo por
// causa de uma falha de API. O log do run fecha como 'partial_failure' (se alguma página processou)
// ou 'failed' (se nenhuma), e o erro sobe para o chamador decidir (mesma convenção de
// lib/platform/jobs.js: falha de uma Organization não impede as outras).

const crypto = require('node:crypto');
const { ttlPara } = require('../platform/leases');

const CODIGO_ERRO_PADRAO = 'CATALOG_SYNC_FAILED';
const CODIGO_ERRO_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
const MAX_PAGINAS = 100000; // teto de segurança contra paginação que nunca termina (bug do provider)

function jobDoSync(provider) {
  return `commerce-catalog-sync:${provider}`;
}

function codigoDeErro(err) {
  if (err && typeof err.codigo === 'string' && CODIGO_ERRO_RE.test(err.codigo)) return err.codigo;
  return CODIGO_ERRO_PADRAO;
}

function contadoresVazios() {
  return {
    productsSeen: 0, productsInserted: 0, productsUpdated: 0, productsDeactivated: 0,
    variantsSeen: 0, variantsInserted: 0, variantsUpdated: 0, variantsDeactivated: 0,
  };
}

// ── Upsert em lote ──────────────────────────────────────────────────────────────────────────────
//
// 1 INSERT ... ON CONFLICT por página para produtos, outro para variantes — nunca 1 por linha.
// `(xmax = 0) AS inserted` é o jeito padrão de distinguir INSERT de UPDATE dentro do MESMO upsert,
// sem round-trip extra: xmax = 0 só é verdade para a versão da linha que este comando acabou de criar.

function montarUpsertProdutos({ organizationId, storeId, provider, syncRunId }, produtos) {
  const p = produtos.map((x) => ({
    providerProductId: x.providerProductId,
    name: x.name,
    slug: x.slug ?? null,
    imageUrl: x.imageUrl ?? null,
    productUrl: x.productUrl ?? null,
    productType: x.productType ?? null,
    price: x.price ?? null,
    promotionalPrice: x.promotionalPrice ?? null,
    visible: x.visible ?? null,
    metadata: JSON.stringify(x.metadata ?? {}),
  }));
  return {
    text: `
      INSERT INTO commerce_products (
        organization_id, store_id, provider, provider_product_id,
        name, slug, image_url, product_url, product_type,
        price, promotional_price, visible, metadata,
        is_active, last_seen_sync_id, synced_at, updated_at
      )
      SELECT $1, $2, $3, x.provider_product_id,
             x.name, x.slug, x.image_url, x.product_url, x.product_type,
             x.price, x.promotional_price, x.visible, x.metadata,
             true, $4, now(), now()
        FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
                     $11::numeric[], $12::numeric[], $13::boolean[], $14::jsonb[])
          AS x(provider_product_id, name, slug, image_url, product_url, product_type,
               price, promotional_price, visible, metadata)
      ON CONFLICT (organization_id, store_id, provider, provider_product_id) DO UPDATE SET
        name = EXCLUDED.name, slug = EXCLUDED.slug, image_url = EXCLUDED.image_url,
        product_url = EXCLUDED.product_url, product_type = EXCLUDED.product_type,
        price = EXCLUDED.price, promotional_price = EXCLUDED.promotional_price, visible = EXCLUDED.visible,
        metadata = EXCLUDED.metadata, is_active = true, last_seen_sync_id = EXCLUDED.last_seen_sync_id,
        synced_at = now(), updated_at = now()
      RETURNING id, provider_product_id, (xmax = 0) AS inserted`,
    values: [
      organizationId, storeId, provider, syncRunId,
      p.map((x) => x.providerProductId), p.map((x) => x.name), p.map((x) => x.slug),
      p.map((x) => x.imageUrl), p.map((x) => x.productUrl), p.map((x) => x.productType),
      p.map((x) => x.price), p.map((x) => x.promotionalPrice), p.map((x) => x.visible),
      p.map((x) => x.metadata),
    ],
  };
}

function montarUpsertVariantes({ organizationId, storeId, provider, syncRunId }, variantes) {
  const v = variantes.map((x) => ({
    commerceProductId: x.commerceProductId,
    providerVariantId: x.providerVariantId,
    sku: x.sku ?? null,
    color: x.color ?? null,
    size: x.size ?? null,
    model: x.model ?? null,
    metadata: JSON.stringify(x.metadata ?? {}),
  }));
  return {
    text: `
      INSERT INTO commerce_product_variants (
        organization_id, store_id, commerce_product_id, provider, provider_variant_id,
        sku, color, size, model, metadata,
        is_active, last_seen_sync_id, synced_at, updated_at
      )
      SELECT $1, $2, x.commerce_product_id, $3, x.provider_variant_id,
             x.sku, x.color, x.size, x.model, x.metadata,
             true, $4, now(), now()
        FROM unnest($5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::jsonb[])
          AS x(commerce_product_id, provider_variant_id, sku, color, size, model, metadata)
      ON CONFLICT (organization_id, store_id, provider, provider_variant_id) DO UPDATE SET
        commerce_product_id = EXCLUDED.commerce_product_id,
        sku = EXCLUDED.sku, color = EXCLUDED.color, size = EXCLUDED.size, model = EXCLUDED.model,
        metadata = EXCLUDED.metadata, is_active = true, last_seen_sync_id = EXCLUDED.last_seen_sync_id,
        synced_at = now(), updated_at = now()
      RETURNING id, (xmax = 0) AS inserted`,
    values: [
      organizationId, storeId, provider, syncRunId,
      v.map((x) => x.commerceProductId), v.map((x) => x.providerVariantId), v.map((x) => x.sku),
      v.map((x) => x.color), v.map((x) => x.size), v.map((x) => x.model), v.map((x) => x.metadata),
    ],
  };
}

function montarDesativacao(tabela, { organizationId, storeId, provider, syncRunId }) {
  return {
    text: `
      WITH alvo AS (
        UPDATE ${tabela} SET is_active = false, updated_at = now()
         WHERE organization_id = $1 AND store_id = $2 AND provider = $3
           AND is_active = true AND last_seen_sync_id <> $4
        RETURNING id
      )
      SELECT count(*)::int AS n FROM alvo`,
    values: [organizationId, storeId, provider, syncRunId],
  };
}

async function upsertPagina(pool, ctx, itens) {
  const contadores = contadoresVazios();
  if (!itens.length) return contadores;

  contadores.productsSeen = itens.length;
  const upProdutos = montarUpsertProdutos(ctx, itens.map((it) => it.product));
  const { rows: linhasProduto } = await pool.query(upProdutos.text, upProdutos.values);
  for (const l of linhasProduto) (l.inserted ? contadores.productsInserted++ : contadores.productsUpdated++);

  // provider_product_id → id canônico, resolvido DESTA página — nunca uma consulta a mais por item.
  const idPorProviderProductId = new Map(linhasProduto.map((l) => [l.provider_product_id, l.id]));
  const variantes = [];
  for (const it of itens) {
    const commerceProductId = idPorProviderProductId.get(it.product.providerProductId);
    for (const v of it.variants) variantes.push({ ...v, commerceProductId });
  }
  contadores.variantsSeen = variantes.length;
  if (variantes.length) {
    const upVariantes = montarUpsertVariantes(ctx, variantes);
    const { rows: linhasVariante } = await pool.query(upVariantes.text, upVariantes.values);
    for (const l of linhasVariante) (l.inserted ? contadores.variantsInserted++ : contadores.variantsUpdated++);
  }
  return contadores;
}

function somar(a, b) {
  const r = { ...a };
  for (const chave of Object.keys(b)) r[chave] = (r[chave] || 0) + b[chave];
  return r;
}

// ── Log do run (observabilidade — ver cabeçalho e migration 0031) ────────────────────────────────

async function abrirLog(pool, { organizationId, storeId, provider, syncRunId }) {
  await pool.query(
    `INSERT INTO commerce_catalog_sync_logs (organization_id, store_id, provider, sync_run_id, status)
     VALUES ($1, $2, $3, $4, 'running')`,
    [organizationId, storeId, provider, syncRunId]
  );
}

async function fecharLog(pool, { organizationId, syncRunId }, { status, pagesProcessed, contadores, errorCode = null }) {
  // `AND status = 'running'`: nunca reabre por cima de uma linha que um cancelamento (tela) já
  // fechou como 'cancelled' — o run original, se ainda estiver vivo, chega aqui DEPOIS e não deve
  // reescrever o resultado que a pessoa já viu.
  await pool.query(
    `UPDATE commerce_catalog_sync_logs SET
       status = $3, finished_at = now(), pages_processed = $4,
       products_seen = $5, products_inserted = $6, products_updated = $7, products_deactivated = $8,
       variants_seen = $9, variants_inserted = $10, variants_updated = $11, variants_deactivated = $12,
       error_code = $13
     WHERE organization_id = $1 AND sync_run_id = $2 AND status = 'running'`,
    [
      organizationId, syncRunId, status, pagesProcessed,
      contadores.productsSeen, contadores.productsInserted, contadores.productsUpdated, contadores.productsDeactivated,
      contadores.variantsSeen, contadores.variantsInserted, contadores.variantsUpdated, contadores.variantsDeactivated,
      errorCode,
    ]
  );
}

// Progresso ao vivo (observabilidade — achado real de dogfooding, Use Sul 2026-09-24: um catálogo
// grande contra a API real pode levar dezenas de minutos, e até agora `pages_processed`/
// `products_seen` só existiam depois que o run inteiro terminava). Chamado a cada página — nunca
// toca `products_deactivated`/`variants_deactivated` (só fazem sentido depois que TODAS as páginas
// terminaram) nem `status`/`finished_at`/`error_code` (isso é `fecharLog`).
//
// Devolve `cancelado: true` quando a linha NÃO estava mais 'running' (alguém cancelou pela tela
// enquanto este run seguia rodando) — é o sinal cooperativo que o loop principal usa pra parar sem
// esperar a página inteira seguinte terminar, sem sobrescrever o 'cancelled' que a tela já gravou.
async function atualizarProgresso(pool, { organizationId, syncRunId }, { pages, pagesTotal, contadores }) {
  const { rowCount } = await pool.query(
    `UPDATE commerce_catalog_sync_logs SET
       pages_processed = $3, pages_total = $4,
       products_seen = $5, products_inserted = $6, products_updated = $7,
       variants_seen = $8, variants_inserted = $9, variants_updated = $10
     WHERE organization_id = $1 AND sync_run_id = $2 AND status = 'running'`,
    [
      organizationId, syncRunId, pages, pagesTotal ?? null,
      contadores.productsSeen, contadores.productsInserted, contadores.productsUpdated,
      contadores.variantsSeen, contadores.variantsInserted, contadores.variantsUpdated,
    ]
  );
  return { cancelado: rowCount === 0 };
}

// Kill switch (tela) · libera um sync travado sem precisar esperar o TTL do lease nem mexer no
// banco na mão. Marca a(s) linha(s) 'running' desta Organization+Store+provider como 'cancelled' —
// mais de uma só existe se runs anteriores já ficaram órfãos (processo caiu sem fechar o log); todas
// são fechadas juntas, nunca só a mais recente. NUNCA mata o processo Node que ainda estiver vivo —
// só libera a trava (lease) e marca a linha; um processo genuinamente vivo nota o cancelamento no
// próprio próximo `atualizarProgresso` (cooperativo) e para sozinho, ou — se estiver preso numa
// chamada de rede sem checar entre páginas — eventualmente termina e a atualização final dele vira
// no-op (fecharLog também exige `status = 'running'`).
async function cancelarCatalogSync({ pool, leases }, { organizationId, storeId, provider }) {
  if (!pool) throw new Error('cancelarCatalogSync exige pool');
  if (!organizationId || !storeId || !provider) throw new Error('cancelarCatalogSync exige organizationId, storeId e provider');
  const { rows } = await pool.query(
    `UPDATE commerce_catalog_sync_logs SET status = 'cancelled', finished_at = now(), error_code = 'CANCELLED_BY_ADMIN'
      WHERE organization_id = $1 AND store_id = $2 AND provider = $3 AND status = 'running'
      RETURNING sync_run_id`,
    [organizationId, storeId, provider]
  );
  const leaseLiberado = leases ? await leases.liberarForcado(jobDoSync(provider), organizationId) : false;
  return {
    status: rows.length ? 'cancelled' : 'nothing_to_cancel',
    syncRunIds: rows.map((r) => r.sync_run_id),
    leaseLiberado,
  };
}

/**
 * Full catalog sync de UMA Organization/Store/provider. `pool` é a fachada tenant-scoped
 * (lib/platform/tenant-runtime.js) — chamar de dentro de `comContexto`/`comOrganization` da
 * Organization certa é responsabilidade de quem chama (mesmo contrato do registry/porta B.1).
 *
 * @param {{pool, registry: import('../connectors/registry').ConnectorRegistry, leases?, logger?}} deps
 * @param {{organizationId: string, storeId: string, provider: string}} alvo
 * @param {{ttlMs?: number}} [opcoes]
 */
async function runCatalogSync({ pool, registry, leases = null, logger = console }, { organizationId, storeId, provider }, { ttlMs = ttlPara(0) } = {}) {
  if (!pool) throw new Error('runCatalogSync exige pool');
  if (!registry) throw new Error('runCatalogSync exige registry');
  if (!organizationId || !storeId || !provider) throw new Error('runCatalogSync exige organizationId, storeId e provider');

  const job = jobDoSync(provider);
  if (leases) {
    const obtido = await leases.adquirir(job, organizationId, ttlMs);
    if (!obtido) {
      logger.warn(`[CATALOG_SYNC] ${provider}: já existe um full sync em andamento para esta organization — pulado`);
      return { status: 'locked', syncRunId: null, pagesProcessed: 0, ...contadoresVazios() };
    }
  }

  const syncRunId = crypto.randomUUID();
  const ctx = { organizationId, storeId, provider, syncRunId };
  let pages = 0;
  let contadores = contadoresVazios();
  try {
    await abrirLog(pool, ctx);

    const resolvido = registry.resolve('commerce', provider, { organizationId, storeId });
    // Falha cedo, com código estável: nunca cai para 1 chamada de variantes por produto.
    resolvido.require('productsWithVariants');

    let cursor = null;
    let pagesTotal = null;
    do {
      if (pages >= MAX_PAGINAS) throw Object.assign(new Error('paginação do catalog sync não terminou'), { codigo: 'CATALOG_SYNC_PAGINATION_RUNAWAY' });
      // eslint-disable-next-line no-await-in-loop
      const pagina = await resolvido.connector.listProductsWithVariants({ cursor, limit: 100 });
      pages += 1;
      if (Number.isInteger(pagina.totalPages) && pagina.totalPages > 0) pagesTotal = pagina.totalPages;
      // eslint-disable-next-line no-await-in-loop
      contadores = somar(contadores, await upsertPagina(pool, ctx, pagina.items));
      // eslint-disable-next-line no-await-in-loop
      const { cancelado } = await atualizarProgresso(pool, ctx, { pages, pagesTotal, contadores });
      if (cancelado) {
        logger.warn(`[CATALOG_SYNC] ${provider}: cancelado pela tela na página ${pages} — parando sem fechar o log de novo`);
        return { status: 'cancelled', syncRunId, pagesProcessed: pages, ...contadores };
      }
      cursor = pagina.nextCursor;
    } while (cursor);

    // Só depois que TODAS as páginas terminaram com sucesso: o que não apareceu neste run vira inativo.
    const desativarProdutos = montarDesativacao('commerce_products', ctx);
    const { rows: [{ n: prodDesativados }] } = await pool.query(desativarProdutos.text, desativarProdutos.values);
    const desativarVariantes = montarDesativacao('commerce_product_variants', ctx);
    const { rows: [{ n: variantDesativados }] } = await pool.query(desativarVariantes.text, desativarVariantes.values);
    contadores.productsDeactivated = prodDesativados;
    contadores.variantsDeactivated = variantDesativados;

    await fecharLog(pool, ctx, { status: 'success', pagesProcessed: pages, contadores });
    return { status: 'success', syncRunId, pagesProcessed: pages, ...contadores };
  } catch (err) {
    const errorCode = codigoDeErro(err);
    await fecharLog(pool, ctx, { status: pages > 0 ? 'partial_failure' : 'failed', pagesProcessed: pages, contadores, errorCode })
      .catch((erroLog) => logger.error(`[CATALOG_SYNC] ${provider}: falha ao fechar o log do run ${syncRunId}: ${erroLog.message}`));
    throw err;
  } finally {
    if (leases) {
      await leases.concluir(job, organizationId, 0).catch((erroLease) => {
        logger.error(`[CATALOG_SYNC] ${provider}: falha ao liberar o lease: ${erroLease.message}`);
      });
    }
  }
}

module.exports = {
  runCatalogSync, cancelarCatalogSync, jobDoSync, contadoresVazios,
  montarUpsertProdutos, montarUpsertVariantes, montarDesativacao,
};
