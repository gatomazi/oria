'use strict';

// Fase D · runCatalogSync contra Postgres real: schema (RLS, FK, UNIQUE), idempotência, staleness/
// reativação, isolamento entre Organizations, concorrência (lease) e um catálogo "grande" de
// verdade. O connector é um FAKE registrado direto no registry (não a Ink real — essa parte já está
// coberta em test/connectors-commerce-reserva-ink-connector.test.js); aqui o que se prova é o que
// acontece nas tabelas depois do sync.
//
// Premissa: 1 Organization = 1 Store (ORIA-TENANCY-STORE-01). Nenhum cenário aqui tem duas Stores na
// mesma Organization.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createJobLeases } = h.sujeito('lib/platform/leases.js');
const { createConnectorRegistry } = h.sujeito('lib/connectors/registry.js');
const { runCatalogSync } = h.sujeito('lib/product-analytics/catalog-sync.js');

const ORG_A = 'e1000000-0000-4000-8000-000000000001';
const ORG_B = 'e1000000-0000-4000-8000-000000000002';
const STORE_A = 'e2000000-0000-4000-8000-000000000001';
const STORE_B = 'e2000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_cat_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');

let db;
let sup;
let appPoolReal; // pg.Pool cru, role da aplicação — para leases (mesma convenção de server.js:183)
let leases;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_catalog_sync');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });
  leases = createJobLeases({ poolReal: appPoolReal, dono: 'teste-catalog-sync' });

  for (const [org, store, nome] of [[ORG_A, STORE_A, 'Org A'], [ORG_B, STORE_B, 'Org B']]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
  }
});

test.after(async () => {
  await appPoolReal?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

// ── Connector fake, controlável por teste: `paginasPorTag` mapeia uma chave arbitrária (escolhida
// pelo teste) para a função geradora de páginas que aquele `runCatalogSync` deve usar. Isso permite
// registrar UM registry e ainda assim variar o catálogo "observado" entre chamadas sucessivas. ──

const produto = (n, over = {}) => ({
  providerProductId: String(n), name: `Produto ${n}`, slug: null, imageUrl: null, productUrl: null,
  productType: null, price: 10 + n, promotionalPrice: null, visible: true, metadata: { origem: 'teste' }, ...over,
});
const variante = (n, over = {}) => ({ providerVariantId: String(n), sku: `SKU-${n}`, color: null, size: null, model: null, metadata: {}, ...over });
const item = (n, variantes = [variante(1000 + n)]) => ({ product: produto(n), variants: variantes });

function registryFake(provider, fornecedorDePaginas) {
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider, integrationProvider: provider, requiresStoreContext: true,
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: false, refunds: false, productCosts: false },
    create: () => ({ listProductsWithVariants: async ({ cursor }) => fornecedorDePaginas(cursor ? Number(cursor) - 1 : 0) }),
  });
  return registry;
}

// Uma "chamada" = uma página só, com N itens fixos — cobre a maioria dos testes sem paginação real.
const umaPagina = (itens, provider = 'fake_commerce') => registryFake(provider, () => ({ items: itens, nextCursor: null }));

async function rodar(pool, registry, org, store, provider = 'fake_commerce') {
  return em(org, store, () => runCatalogSync({ pool, registry, leases }, { organizationId: org, storeId: store, provider }));
}

async function contarAtivos(tabela, org, store, provider = 'fake_commerce') {
  const { rows } = await sup.query(`SELECT count(*)::int AS n FROM ${tabela} WHERE organization_id=$1 AND store_id=$2 AND provider=$3 AND is_active`, [org, store, provider]);
  return rows[0].n;
}

// ── Sync básico ────────────────────────────────────────────────────────────────────────────────

test('D · 1 página: produto e variante novos inserem; log fecha success', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const registry = umaPagina([item(1), item(2)]);
  const r = await rodar(pool, registry, ORG_A, STORE_A);
  assert.equal(r.status, 'success');
  assert.equal(r.productsInserted, 2);
  assert.equal(r.variantsInserted, 2);
  assert.equal(await contarAtivos('commerce_products', ORG_A, STORE_A), 2);
  const { rows } = await sup.query('SELECT status, products_seen, variants_seen FROM commerce_catalog_sync_logs WHERE organization_id=$1 AND sync_run_id=$2', [ORG_A, r.syncRunId]);
  assert.deepEqual(rows[0], { status: 'success', products_seen: 2, variants_seen: 2 });
});

test('D · múltiplas páginas: nextCursor leva o sync até o fim', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const registry = registryFake('fake_commerce', (pagina) => (pagina < 3
    ? { items: [item(100 + pagina)], nextCursor: String(pagina + 2) }
    : { items: [item(103)], nextCursor: null }));
  const r = await rodar(pool, registry, ORG_A, STORE_A);
  assert.equal(r.pagesProcessed, 4);
  assert.equal(r.productsSeen, 4);
});

test('D · produto com variantes no MESMO payload: nenhuma chamada extra é necessária para persistir as duas', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const registry = umaPagina([item(5, [variante(50), variante(51)])]);
  const r = await rodar(pool, registry, ORG_A, STORE_A);
  assert.equal(r.variantsInserted, 2);
  const { rows } = await sup.query(
    `SELECT v.sku FROM commerce_product_variants v JOIN commerce_products p ON p.id = v.commerce_product_id
      WHERE p.organization_id = $1 AND p.store_id = $2 AND p.provider_product_id = '5' ORDER BY v.sku`,
    [ORG_A, STORE_A]
  );
  assert.deepEqual(rows.map((r2) => r2.sku), ['SKU-50', 'SKU-51']);
});

// ── Idempotência ───────────────────────────────────────────────────────────────────────────────

test('D · rodar o mesmo full sync duas vezes: mesma contagem, mesmos IDs canônicos, sem duplicidade', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const registry = umaPagina([item(10), item(11)], 'idem_provider');
  await rodar(pool, registry, ORG_A, STORE_A, 'idem_provider');
  const { rows: antes } = await sup.query(
    'SELECT id, provider_product_id FROM commerce_products WHERE organization_id=$1 AND store_id=$2 AND provider=$3 ORDER BY provider_product_id',
    [ORG_A, STORE_A, 'idem_provider']
  );
  const r2 = await rodar(pool, registry, ORG_A, STORE_A, 'idem_provider');
  const { rows: depois } = await sup.query(
    'SELECT id, provider_product_id FROM commerce_products WHERE organization_id=$1 AND store_id=$2 AND provider=$3 ORDER BY provider_product_id',
    [ORG_A, STORE_A, 'idem_provider']
  );
  assert.equal(r2.productsInserted, 0);
  assert.equal(r2.productsUpdated, 2);
  assert.deepEqual(depois, antes, 'commerce_products.id não pode mudar entre syncs');
  const { rows: [{ n }] } = await sup.query(
    "SELECT count(*)::int AS n FROM commerce_products WHERE organization_id=$1 AND store_id=$2 AND provider=$3",
    [ORG_A, STORE_A, 'idem_provider']
  );
  assert.equal(n, 2, 'sem duplicidade');
});

test('D · alteração de nome/preço no provider atualiza a MESMA linha, não cria outra', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  await rodar(pool, umaPagina([item(20, [])], 'update_provider'), ORG_A, STORE_A, 'update_provider');
  const antes = (await sup.query("SELECT id FROM commerce_products WHERE organization_id=$1 AND provider=$2 AND provider_product_id='20'", [ORG_A, 'update_provider'])).rows[0];

  await rodar(pool, umaPagina([{ product: produto(20, { name: 'Nome novo', price: 999 }), variants: [] }], 'update_provider'), ORG_A, STORE_A, 'update_provider');
  const { rows: [depois] } = await sup.query("SELECT id, name, price FROM commerce_products WHERE organization_id=$1 AND provider=$2 AND provider_product_id='20'", [ORG_A, 'update_provider']);
  assert.equal(depois.id, antes.id);
  assert.equal(depois.name, 'Nome novo');
  assert.equal(Number(depois.price), 999);
});

// ── Staleness / reativação ────────────────────────────────────────────────────────────────────

test('D · produto ausente após full sync BEM-SUCEDIDO vira inactive; a variante dele também', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  await rodar(pool, umaPagina([item(30), item(31)], 'stale_provider'), ORG_A, STORE_A, 'stale_provider');
  await rodar(pool, umaPagina([item(30)], 'stale_provider'), ORG_A, STORE_A, 'stale_provider'); // 31 sumiu
  const { rows: prods } = await sup.query(
    "SELECT provider_product_id, is_active FROM commerce_products WHERE organization_id=$1 AND provider=$2 ORDER BY provider_product_id",
    [ORG_A, 'stale_provider']
  );
  assert.deepEqual(prods, [{ provider_product_id: '30', is_active: true }, { provider_product_id: '31', is_active: false }]);
  const { rows: [variante31] } = await sup.query(
    "SELECT is_active FROM commerce_product_variants WHERE organization_id=$1 AND provider=$2 AND provider_variant_id='1031'",
    [ORG_A, 'stale_provider']
  );
  assert.equal(variante31.is_active, false);
});

test('D · produto ausente após sync que FALHOU continua active (nada é desativado numa falha)', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  await rodar(pool, umaPagina([item(40)], 'fail_provider'), ORG_A, STORE_A, 'fail_provider');
  const registryQuebrado = registryFake('fail_provider', (pagina) => {
    if (pagina === 0) return { items: [], nextCursor: '2' };
    throw Object.assign(new Error('provider caiu'), { codigo: 'PROVIDER_DOWN' });
  });
  await assert.rejects(rodar(pool, registryQuebrado, ORG_A, STORE_A, 'fail_provider'));
  const { rows: [p40] } = await sup.query("SELECT is_active FROM commerce_products WHERE organization_id=$1 AND provider=$2 AND provider_product_id='40'", [ORG_A, 'fail_provider']);
  assert.equal(p40.is_active, true);
});

test('D · produto reaparece depois de inativado: volta a active, mesmo id', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  await rodar(pool, umaPagina([item(50)], 'reaparece_provider'), ORG_A, STORE_A, 'reaparece_provider');
  await rodar(pool, umaPagina([], 'reaparece_provider'), ORG_A, STORE_A, 'reaparece_provider'); // some
  const antes = (await sup.query("SELECT id, is_active FROM commerce_products WHERE organization_id=$1 AND provider=$2 AND provider_product_id='50'", [ORG_A, 'reaparece_provider'])).rows[0];
  assert.equal(antes.is_active, false);

  await rodar(pool, umaPagina([item(50)], 'reaparece_provider'), ORG_A, STORE_A, 'reaparece_provider'); // volta
  const { rows: [depois] } = await sup.query("SELECT id, is_active FROM commerce_products WHERE organization_id=$1 AND provider=$2 AND provider_product_id='50'", [ORG_A, 'reaparece_provider']);
  assert.equal(depois.is_active, true);
  assert.equal(depois.id, antes.id);
});

// ── Isolamento entre Organizations e providers ───────────────────────────────────────────────

test('D · duas Organizations não cruzam catálogo, mesmo sincronizando na mesma hora', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  await Promise.all([
    rodar(pool, umaPagina([item(60)], 'iso_provider'), ORG_A, STORE_A, 'iso_provider'),
    rodar(pool, umaPagina([item(61), item(62)], 'iso_provider'), ORG_B, STORE_B, 'iso_provider'),
  ]);
  assert.equal(await contarAtivos('commerce_products', ORG_A, STORE_A, 'iso_provider'), 1);
  assert.equal(await contarAtivos('commerce_products', ORG_B, STORE_B, 'iso_provider'), 2);
  const cruzado = await sup.query(
    "SELECT 1 FROM commerce_products WHERE organization_id=$1 AND provider_product_id IN ('61','62')", [ORG_A]
  );
  assert.equal(cruzado.rowCount, 0);
});

test('D · provider diferente não colide, mesmo produto sob a mesma Organization+Store', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  await rodar(pool, umaPagina([item(70)], 'provider_x'), ORG_A, STORE_A, 'provider_x');
  await rodar(pool, umaPagina([item(70)], 'provider_y'), ORG_A, STORE_A, 'provider_y');
  const { rows } = await sup.query(
    "SELECT provider FROM commerce_products WHERE organization_id=$1 AND store_id=$2 AND provider_product_id='70' ORDER BY provider",
    [ORG_A, STORE_A]
  );
  assert.deepEqual(rows.map((r) => r.provider), ['provider_x', 'provider_y']);
});

// ── Concorrência ───────────────────────────────────────────────────────────────────────────────

test('D · segundo full sync simultâneo do mesmo tenant/store/provider é bloqueado (lease)', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  let liberar;
  const travado = new Promise((resolve) => { liberar = resolve; });
  const registryLento = registryFake('lock_provider', async () => { await travado; return { items: [item(80)], nextCursor: null }; });
  const primeiro = rodar(pool, registryLento, ORG_A, STORE_A, 'lock_provider');
  await new Promise((r) => setTimeout(r, 50)); // dá tempo do primeiro adquirir o lease
  const segundo = await rodar(pool, umaPagina([item(81)], 'lock_provider'), ORG_A, STORE_A, 'lock_provider');
  assert.equal(segundo.status, 'locked');
  liberar();
  const r1 = await primeiro;
  assert.equal(r1.status, 'success');
  // Só o produto do primeiro run persistiu — o segundo nem chegou a rodar.
  assert.equal(await contarAtivos('commerce_products', ORG_A, STORE_A, 'lock_provider'), 1);
});

test('D · providers diferentes da MESMA Organization não se bloqueiam entre si', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const [r1, r2] = await Promise.all([
    rodar(pool, umaPagina([item(90)], 'par_provider'), ORG_A, STORE_A, 'par_provider'),
    rodar(pool, umaPagina([item(91)], 'impar_provider'), ORG_A, STORE_A, 'impar_provider'),
  ]);
  assert.equal(r1.status, 'success');
  assert.equal(r2.status, 'success');
});

// ── Catálogo grande, de verdade ───────────────────────────────────────────────────────────────

test('D · catálogo grande (30 páginas x 100 produtos = 3000) persiste e reconcilia corretamente', { timeout: 60000 }, async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const PAGINAS = 30;
  const POR_PAGINA = 100;
  const gerar = (offset) => registryFake('grande_provider', (pagina) => ({
    items: Array.from({ length: POR_PAGINA }, (_, i) => item(offset + pagina * POR_PAGINA + i, [])),
    nextCursor: pagina + 1 < PAGINAS ? String(pagina + 2) : null,
  }));

  const r1 = await rodar(pool, gerar(0), ORG_A, STORE_A, 'grande_provider');
  assert.equal(r1.pagesProcessed, PAGINAS);
  assert.equal(r1.productsInserted, PAGINAS * POR_PAGINA);
  assert.equal(await contarAtivos('commerce_products', ORG_A, STORE_A, 'grande_provider'), PAGINAS * POR_PAGINA);

  // Segundo run com um OFFSET: metade do catálogo antigo some, metade nova aparece — prova
  // reconciliação em volume, não só com 2-3 produtos.
  const r2 = await rodar(pool, gerar(PAGINAS * POR_PAGINA / 2), ORG_A, STORE_A, 'grande_provider');
  assert.equal(r2.pagesProcessed, PAGINAS);
  assert.equal(r2.productsDeactivated, (PAGINAS * POR_PAGINA) / 2);
  assert.equal(await contarAtivos('commerce_products', ORG_A, STORE_A, 'grande_provider'), PAGINAS * POR_PAGINA);
});

// ── Negative controls: o banco recusa, não só o código ───────────────────────────────────────────
//
// Estes dois não passam por runCatalogSync de propósito: o alvo é provar que a CONSTRAINT recusa,
// não que o código de aplicação "se comporta bem". Um código que mudasse amanhã ainda esbarraria
// nisto.

test('NC · upsert não consegue reatribuir produto para Store de outra Organization (FK composta recusa)', () => em(ORG_A, STORE_A, async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const runId = crypto.randomUUID();
  // organization_id = ORG_A, mas store_id = STORE_B (de ORG_B): a FK composta
  // fk_commerce_products_store exige (store_id, organization_id) → stores (id, organization_id) —
  // essa combinação não existe.
  await assert.rejects(
    pool.query(
      `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
       VALUES ($1, $2, 'nc_provider', 'x', 'x', $3)`,
      [ORG_A, STORE_B, runId]
    ),
    (err) => { assert.equal(err.code, '23503'); return true; }, // foreign_key_violation
  );
}));

test('NC · variant não consegue apontar para product de outro tenant (FK composta recusa)', () => em(ORG_A, STORE_A, async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const runId = crypto.randomUUID();
  await rodar(runtime.criarPoolTenant(appPoolReal), umaPagina([item(200)], 'nc_provider'), ORG_A, STORE_A, 'nc_provider');
  const produtoDeB = await em(ORG_B, STORE_B, () => rodar(runtime.criarPoolTenant(appPoolReal), umaPagina([item(201)], 'nc_provider'), ORG_B, STORE_B, 'nc_provider'));
  void produtoDeB;
  const { rows: [{ id: idDoProdutoDeB }] } = await sup.query(
    "SELECT id FROM commerce_products WHERE organization_id=$1 AND provider=$2 AND provider_product_id='201'", [ORG_B, 'nc_provider']
  );
  // organization_id = ORG_A (o contexto desta query), commerce_product_id = produto de ORG_B: a FK
  // composta fk_commerce_product_variants_product exige (commerce_product_id, organization_id) →
  // commerce_products (id, organization_id) — essa combinação não existe (o produto é de ORG_B).
  await assert.rejects(
    pool.query(
      `INSERT INTO commerce_product_variants (organization_id, store_id, commerce_product_id, provider, provider_variant_id, last_seen_sync_id)
       VALUES ($1, $2, $3, 'nc_provider', 'x', $4)`,
      [ORG_A, STORE_A, idDoProdutoDeB, runId]
    ),
    (err) => { assert.equal(err.code, '23503'); return true; },
  );
}));
