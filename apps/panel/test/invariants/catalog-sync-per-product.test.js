'use strict';

// Rodada de otimização de armazenamento · `variantSweep`: 'last_seen' (histórico) × 'per_product'
// (variante só é regravada se mudou; sumiço tratado por produto). Prova DIFERENCIAL: a mesma
// sequência de catálogos, rodada nas duas estratégias em providers diferentes, termina no MESMO
// estado (ativo/inativo, produto dono, campos) a cada passo; e per_product não regrava o que não
// mudou. Falha parcial: NADA é desativado (nem produto, nem variante) — igual ao last_seen.
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

const ORG_A = 'e5000000-0000-4000-8000-000000000001';
const ORG_B = 'e5000000-0000-4000-8000-000000000002';
const STORE_A = 'e6000000-0000-4000-8000-000000000001';
const STORE_B = 'e6000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_sw_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');

let db;
let sup;
let appPoolReal; // pg.Pool cru, role da aplicação — para leases (mesma convenção de server.js:183)
let leases;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_catalog_sweep');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });
  leases = createJobLeases({ poolReal: appPoolReal, dono: 'teste-catalog-sweep' });

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


const PROVEDORES = { last_seen: 'sw_last_seen', per_product: 'sw_per_product' };

async function rodarComo(pool, sweep, itens) {
  const provider = PROVEDORES[sweep];
  return em(ORG_A, STORE_A, () => runCatalogSync(
    { pool, registry: umaPagina(itens, provider), leases }, { organizationId: ORG_A, storeId: STORE_A, provider }, { variantSweep: sweep }
  ));
}

// Estado observável, sem ids internos: a estratégia nunca pode mudar o que o resto do sistema enxerga.
async function estado(provider) {
  const { rows: produtos } = await sup.query(
    `SELECT provider_product_id AS pid, name, is_active FROM commerce_products WHERE organization_id = $1 AND provider = $2 ORDER BY 1`, [ORG_A, provider]
  );
  const { rows: variantes } = await sup.query(
    `SELECT v.provider_variant_id AS vid, p.provider_product_id AS pid, v.sku, v.color, v.size, v.model, v.metadata, v.is_active
       FROM commerce_product_variants v JOIN commerce_products p ON p.id = v.commerce_product_id AND p.organization_id = v.organization_id
      WHERE v.organization_id = $1 AND v.provider = $2 ORDER BY 1`, [ORG_A, provider]
  );
  return { produtos, variantes };
}

async function passo(pool, itens) {
  const a = await rodarComo(pool, 'last_seen', itens);
  const b = await rodarComo(pool, 'per_product', itens);
  assert.equal(a.status, 'success');
  assert.equal(b.status, 'success');
  assert.deepEqual(await estado(PROVEDORES.per_product), await estado(PROVEDORES.last_seen));
  return { a, b };
}

const v = (n, over = {}) => variante(n, over);

test('SW · sequência de catálogos termina no MESMO estado nas duas estratégias a cada passo', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const p = (n, vs, over) => ({ product: produto(n, over), variants: vs });

  await passo(pool, [p(1, [v(101), v(102)]), p(2, [v(201), v(202), v(203)]), p(3, [v(301)])]);                       // 1 carga inicial
  await passo(pool, [p(1, [v(101), v(102)]), p(2, [v(201), v(202), v(203)]), p(3, [v(301)])]);                       // 2 nada mudou
  await passo(pool, [p(1, [v(101), v(102), v(104)]), p(2, [v(201), v(203)]), p(3, [v(301, { metadata: { q: 9 } })])]); // 3 variante nova, removida, alterada
  await passo(pool, [p(1, [v(101), v(102), v(104)]), p(2, [v(201), v(203)])]);                                          // 4 produto 3 some (e a variante dele)
  await passo(pool, [p(1, [v(101), v(102), v(104)]), p(2, [v(201), v(203)]), p(3, [v(301, { metadata: { q: 9 } })])]); // 5 produto 3 volta
  await passo(pool, [p(1, [v(101), v(102), v(104), v(203)]), p(2, [v(201)]), p(3, [v(301, { metadata: { q: 9 } })])]);  // 6 variante muda de produto
  await passo(pool, [p(1, []), p(2, [v(201)]), p(3, [v(301, { metadata: { q: 9 } })])]);                                // 7 produto fica sem nenhuma variante
  await passo(pool, [p(1, [v(101)]), p(2, [v(201)]), p(3, [v(301, { metadata: { q: 9 } })])]);                          // 8 variante 101 reativa
  const fim = await estado(PROVEDORES.per_product);
  assert.equal(fim.variantes.find((x) => x.vid === '102').is_active, false);
  assert.equal(fim.variantes.find((x) => x.vid === '101').is_active, true);
});

test('SW · per_product NÃO regrava variante que não mudou (mesma versão física da linha); last_seen regrava', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const itens = [{ product: produto(11), variants: [v(1101), v(1102)] }];
  const xmins = async (provider) => (await sup.query(`SELECT xmin::text AS x FROM commerce_product_variants WHERE organization_id = $1 AND provider = $2 ORDER BY provider_variant_id`, [ORG_A, provider])).rows.map((r) => r.x);
  await rodarComo(pool, 'last_seen', itens); await rodarComo(pool, 'per_product', itens);
  const antesLs = await xmins(PROVEDORES.last_seen); const antesPp = await xmins(PROVEDORES.per_product);
  const ls = await rodarComo(pool, 'last_seen', itens); const pp = await rodarComo(pool, 'per_product', itens);
  assert.deepEqual(await xmins(PROVEDORES.per_product), antesPp); // não tocou
  assert.notDeepEqual(await xmins(PROVEDORES.last_seen), antesLs); // tocou (comportamento histórico)
  assert.equal(pp.variantsUpdated, 0);
  assert.equal(pp.variantsSeen, 2);
  assert.equal(ls.variantsUpdated, 2);
});

test('SW · falha PARCIAL: nas DUAS estratégias nada é desativado — inclusive variante que sumiu de um produto já visitado', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  // Providers próprios: o estado dos outros testes deste arquivo não pode entrar na asserção.
  const provedor = { last_seen: 'sw_pf_last_seen', per_product: 'sw_pf_per_product' };
  const inicial = [{ product: produto(21), variants: [v(2101), v(2102)] }, { product: produto(22), variants: [v(2201)] }];
  const quebrado = (provider) => registryFake(provider, (pagina) => {
    if (pagina === 0) return { items: [{ product: produto(21), variants: [v(2101)] }], nextCursor: '2' }; // 21 perdeu a 2102; 22 só viria na pág. 2
    throw Object.assign(new Error('provider caiu'), { codigo: 'PROVIDER_DOWN' });
  });
  for (const sweep of ['last_seen', 'per_product']) {
    const provider = provedor[sweep];
    const alvo = { organizationId: ORG_A, storeId: STORE_A, provider };
    await em(ORG_A, STORE_A, () => runCatalogSync({ pool, registry: umaPagina(inicial, provider), leases }, alvo, { variantSweep: sweep }));
    await assert.rejects(em(ORG_A, STORE_A, () => runCatalogSync({ pool, registry: quebrado(provider), leases }, alvo, { variantSweep: sweep })));
  }
  const ls = await estado(provedor.last_seen);
  const pp = await estado(provedor.per_product);
  assert.equal(ls.produtos.every((x) => x.is_active), true);
  assert.equal(ls.variantes.every((x) => x.is_active), true);   // last_seen: nada desativado por falha
  assert.equal(pp.produtos.every((x) => x.is_active), true);     // per_product: produto NUNCA desativado por falha
  assert.equal(pp.variantes.every((x) => x.is_active), true);   // per_product: o tombstone da 2102 morre com o run
  assert.deepEqual(pp.variantes.map((x) => x.vid), ls.variantes.map((x) => x.vid));
});

test('SW · variante que muda de produto ou reaparece em outra página NÃO é desativada (tombstone cancelado)', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const provider = 'sw_move';
  const alvo = { organizationId: ORG_A, storeId: STORE_A, provider };
  const run = (paginas) => em(ORG_A, STORE_A, () => runCatalogSync(
    { pool, registry: registryFake(provider, (n) => ({ items: paginas[n] || [], nextCursor: paginas[n + 1] ? String(n + 2) : null })), leases }, alvo, { variantSweep: 'per_product' }
  ));
  const p = (n, vs) => ({ product: produto(n), variants: vs });
  await run([[p(41, [v(4101), v(4102)]), p(42, [v(4201)])]]);
  // Página 1 traz o produto 41 SEM a 4102 (tombstone); a página 2 traz a 4102 dentro do produto 42 (movida).
  await run([[p(41, [v(4101)])], [p(42, [v(4201), v(4102)])]]);
  const { rows } = await sup.query(
    `SELECT v.provider_variant_id AS vid, p.provider_product_id AS pid, v.is_active FROM commerce_product_variants v JOIN commerce_products p ON p.id = v.commerce_product_id WHERE v.organization_id = $1 AND v.provider = $2 ORDER BY 1`, [ORG_A, provider]
  );
  assert.deepEqual(rows, [{ vid: '4101', pid: '41', is_active: true }, { vid: '4102', pid: '42', is_active: true }, { vid: '4201', pid: '42', is_active: true }]);
  // E o caso simples continua valendo: sumiu de verdade → inativa só no sucesso.
  await run([[p(41, [v(4101)]), p(42, [v(4201)])]]);
  const { rows: [sumida] } = await sup.query(`SELECT is_active FROM commerce_product_variants WHERE organization_id = $1 AND provider = $2 AND provider_variant_id = '4102'`, [ORG_A, provider]);
  assert.equal(sumida.is_active, false);
});

test('SW · variantSweep inválido é recusado', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  await assert.rejects(em(ORG_A, STORE_A, () => runCatalogSync({ pool, registry: umaPagina([], 'sw_x'), leases }, { organizationId: ORG_A, storeId: STORE_A, provider: 'sw_x' }, { variantSweep: 'lazy' })), TypeError);
});

test('SW · isolamento: sync per_product da Org A nunca desativa variante da Org B com o mesmo provider/ids', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const cheio = [{ product: produto(31), variants: [v(3101), v(3102)] }];
  await em(ORG_B, STORE_B, () => runCatalogSync({ pool, registry: umaPagina(cheio, 'sw_iso'), leases }, { organizationId: ORG_B, storeId: STORE_B, provider: 'sw_iso' }, { variantSweep: 'per_product' }));
  await em(ORG_A, STORE_A, () => runCatalogSync({ pool, registry: umaPagina(cheio, 'sw_iso'), leases }, { organizationId: ORG_A, storeId: STORE_A, provider: 'sw_iso' }, { variantSweep: 'per_product' }));
  await em(ORG_A, STORE_A, () => runCatalogSync({ pool, registry: umaPagina([], 'sw_iso'), leases }, { organizationId: ORG_A, storeId: STORE_A, provider: 'sw_iso' }, { variantSweep: 'per_product' })); // A esvazia
  assert.equal(await contarAtivos('commerce_product_variants', ORG_A, STORE_A, 'sw_iso'), 0);
  assert.equal(await contarAtivos('commerce_product_variants', ORG_B, STORE_B, 'sw_iso'), 2); // B intacta
});
