'use strict';

// Operação do full sync: linhas `running` órfãs são fechadas quando o lease é obtido, e o crawl da Ink
// (legado ou canônico) nunca roda em dobro — o lease compartilhado `commerce-scan:<provider>` devolve
// `locked` para quem chega depois. Também prova a criação da composição com o sync desabilitado.
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

const ORG_A = 'e7000000-0000-4000-8000-000000000001';
const ORG_B = 'e7000000-0000-4000-8000-000000000002';
const STORE_A = 'e8000000-0000-4000-8000-000000000001';
const STORE_B = 'e8000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_ops_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');

let db;
let sup;
let appPoolReal; // pg.Pool cru, role da aplicação — para leases (mesma convenção de server.js:183)
let leases;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_catalog_ops');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });
  leases = createJobLeases({ poolReal: appPoolReal, dono: 'teste-catalog-ops' });

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



const { createProductAnalyticsComposition } = h.sujeito('lib/product-analytics/composition.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');

test('OP · run anterior que ficou "running" sem processo é fechado como ABANDONED quando o lease é obtido', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const orfa = crypto.randomUUID();
  await sup.query(
    `INSERT INTO commerce_catalog_sync_logs (organization_id, store_id, provider, sync_run_id, status, started_at, pages_processed)
     VALUES ($1, $2, 'op_orfao', $3, 'running', now() - interval '5 hours', 67)`, [ORG_A, STORE_A, orfa]
  );
  const r = await em(ORG_A, STORE_A, () => runCatalogSync({ pool, registry: umaPagina([item(1)], 'op_orfao'), leases }, { organizationId: ORG_A, storeId: STORE_A, provider: 'op_orfao' }));
  assert.equal(r.status, 'success');
  const { rows } = await sup.query(`SELECT status, error_code FROM commerce_catalog_sync_logs WHERE sync_run_id = $1`, [orfa]);
  assert.deepEqual(rows, [{ status: 'failed', error_code: 'ABANDONED' }]);
  assert.equal(typeof r.walBytes === 'number' || r.walBytes === null, true); // medido, nunca quebra
});

test('OP · sem lease (teste/unitário) o run NÃO fecha linhas alheias', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const outra = crypto.randomUUID();
  await sup.query(
    `INSERT INTO commerce_catalog_sync_logs (organization_id, store_id, provider, sync_run_id, status, started_at) VALUES ($1, $2, 'op_sem_lease', $3, 'running', now())`, [ORG_A, STORE_A, outra]
  );
  await em(ORG_A, STORE_A, () => runCatalogSync({ pool, registry: umaPagina([item(2)], 'op_sem_lease'), leases: null }, { organizationId: ORG_A, storeId: STORE_A, provider: 'op_sem_lease' }));
  const { rows } = await sup.query(`SELECT status FROM commerce_catalog_sync_logs WHERE sync_run_id = $1`, [outra]);
  assert.equal(rows[0].status, 'running');
});

test('OP · varredura da Ink já em andamento (lease compartilhado) → syncCommerceCatalog devolve locked e não abre log', async () => {
  const pool = runtime.criarPoolTenant(appPoolReal);
  const outroDono = createJobLeases({ poolReal: appPoolReal, dono: 'legado-simulado' });
  const composicao = createProductAnalyticsComposition({ pool, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: crypto.randomBytes(32).toString('base64') }), leases });
  assert.equal(await outroDono.adquirir(`commerce-scan:${composicao.commerceProvider}`, ORG_B, 60000), true);
  try {
    const r = await em(ORG_B, STORE_B, () => composicao.syncCommerceCatalog({ organizationId: ORG_B, storeId: STORE_B }));
    assert.equal(r.status, 'locked');
    const { rows } = await sup.query('SELECT count(*)::int AS n FROM commerce_catalog_sync_logs WHERE organization_id = $1', [ORG_B]);
    assert.equal(rows[0].n, 0);
  } finally {
    await outroDono.concluir(`commerce-scan:${composicao.commerceProvider}`, ORG_B, 0);
  }
});

test('OP · valores inválidos de configuração derrubam a composição no boot', () => {
  const base = { pool: runtime.criarPoolTenant(appPoolReal), keyring: createKeyring({ ENCRYPTION_MASTER_KEY: crypto.randomBytes(32).toString('base64') }) };
  assert.throws(() => createProductAnalyticsComposition({ ...base, variantSweep: 'lazy' }), /variantSweep inválido/);
  assert.throws(() => createProductAnalyticsComposition({ ...base, variantIdentityMode: 'lazy' }), /variantIdentityMode inválido/);
});
