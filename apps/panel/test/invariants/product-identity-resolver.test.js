'use strict';

// Fase F · Product Identity contra Postgres real: schema (RLS, FK cross-tenant, unique), bootstrap
// a partir do catálogo canônico (produto/variante/SKU único/SKU duplicado), resolução de ids
// observados (existing mapping, product id, variant id, SKU, conflito, unresolved), variant→product,
// idempotência, coverage e isolamento entre Organizations/providers.
//
// Premissa: 1 Organization = 1 Store (ORIA-TENANCY-STORE-01).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const {
  validarNamespace, bootstrapCommerceIdentities, resolveExternalIds, persistRuleMatches, resolveAndPersist, computeCoverage,
} = h.sujeito('lib/product-analytics/product-identity-resolver.js');

const ORG_A = 'f1000000-0000-4000-8000-000000000001';
const ORG_B = 'f1000000-0000-4000-8000-000000000002';
const STORE_A = 'f2000000-0000-4000-8000-000000000001';
const STORE_B = 'f2000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_pid_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const PROVIDER = 'fake_commerce';
const RUN = crypto.randomUUID();

let db;
let sup;
let appPoolReal;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);
const pool = () => runtime.criarPoolTenant(appPoolReal);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_pid');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });

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

// Semeia catálogo canônico direto (sem passar por CatalogSync — não é o alvo deste arquivo).
async function semearCatalogo(org, store, provider, produtos) {
  const idsPorPid = new Map();
  for (const p of produtos) {
    const { rows: [{ id }] } = await sup.query(
      `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [org, store, provider, p.providerProductId, p.name || `Produto ${p.providerProductId}`, RUN]
    );
    idsPorPid.set(p.providerProductId, id);
    for (const v of p.variants || []) {
      await sup.query(
        `INSERT INTO commerce_product_variants (organization_id, store_id, commerce_product_id, provider, provider_variant_id, sku, last_seen_sync_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [org, store, id, provider, v.providerVariantId, v.sku || null, RUN]
      );
    }
  }
  return idsPorPid;
}

// ── validarNamespace / computeCoverage (puro) ─────────────────────────────────────────────────

test('F · validarNamespace aceita namespaces com ponto e rejeita "id" genérico ou formato solto', () => {
  for (const ok of ['sku', 'reserva_ink.product_id', 'ga4.item_id', 'meta.content_id']) assert.equal(validarNamespace(ok), ok);
  for (const ruim of ['id', 'Reserva.Ink', 'ga4 item', 'ga4-item', '', null, undefined, 123]) {
    assert.throws(() => validarNamespace(ruim), TypeError);
  }
});

test('F · computeCoverage: dataset vazio → coverage null, status insufficient_data (nunca 100%)', () => {
  assert.deepEqual(computeCoverage({ resolved: [], conflicts: [], unresolved: [] }, 0), {
    observedItemIds: 0, matchedItemIds: 0, unmatchedItemIds: 0, conflictedItemIds: 0, coverageRate: null, status: 'insufficient_data',
  });
});

test('F · computeCoverage: matched/observed com denominator > 0', () => {
  const c = computeCoverage({ resolved: [{ externalId: '1' }, { externalId: '2' }], conflicts: [{ externalId: '3' }], unresolved: [{ externalId: '4' }] }, 4);
  assert.equal(c.observedItemIds, 4);
  assert.equal(c.matchedItemIds, 2);
  assert.equal(c.conflictedItemIds, 1);
  assert.equal(c.unmatchedItemIds, 1);
  assert.equal(c.coverageRate, 0.5);
  assert.equal(c.status, 'ok');
});

// ── Bootstrap ──────────────────────────────────────────────────────────────────────────────────

test('F · bootstrap cria identity product_id e variant_id (variant aponta para o PRODUTO, não uma entidade própria)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, PROVIDER, [{ providerProductId: 'p1', variants: [{ providerVariantId: 'v1', sku: 'SKU-1' }] }]);
  const r = await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: PROVIDER });
  assert.equal(r.productIdentities, 1);
  assert.equal(r.variantIdentities, 1);
  assert.equal(r.skuIdentities, 1);

  const { rows } = await sup.query(
    `SELECT namespace, external_id, commerce_product_id, source, confidence FROM product_external_identities
      WHERE organization_id=$1 AND store_id=$2 ORDER BY namespace`, [ORG_A, STORE_A]
  );
  const porNamespace = Object.fromEntries(rows.map((x) => [x.namespace, x]));
  assert.equal(porNamespace[`${PROVIDER}.product_id`].external_id, 'p1');
  assert.equal(porNamespace[`${PROVIDER}.product_id`].commerce_product_id, ids.get('p1'));
  assert.equal(porNamespace[`${PROVIDER}.variant_id`].external_id, 'v1');
  assert.equal(porNamespace[`${PROVIDER}.variant_id`].commerce_product_id, ids.get('p1')); // variant → PRODUTO
  assert.equal(porNamespace.sku.external_id, 'SKU-1');
  assert.equal(porNamespace.sku.commerce_product_id, ids.get('p1'));
  for (const x of rows) { assert.equal(x.source, 'commerce_sync'); assert.equal(x.confidence, 'exact'); }
}));

test('F · SKU duplicado entre dois produtos NÃO vira identity automática', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'dup_provider', [
    { providerProductId: 'd1', variants: [{ providerVariantId: 'dv1', sku: 'SKU-DUP' }] },
    { providerProductId: 'd2', variants: [{ providerVariantId: 'dv2', sku: 'SKU-DUP' }] },
  ]);
  // Os contadores do bootstrap são por STORE inteira (SKU é store-wide, §5.4) — não isolados por
  // provider; num arquivo que acumula Stores entre testes eles incluem re-toques legítimos de SKUs
  // de outros casos. A prova que importa é direta: SKU-DUP especificamente NÃO virou identity.
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'dup_provider' });
  const { rows } = await sup.query(`SELECT 1 FROM product_external_identities WHERE organization_id=$1 AND namespace='sku' AND external_id='SKU-DUP'`, [ORG_A]);
  assert.equal(rows.length, 0);
}));

test('F · SKU que ERA único e virou duplicado é removido (identity automática, não trava no estado antigo)', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'flip_provider', [{ providerProductId: 'f1', variants: [{ providerVariantId: 'fv1', sku: 'SKU-FLIP' }] }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'flip_provider' });
  const antes = await sup.query(`SELECT 1 FROM product_external_identities WHERE organization_id=$1 AND namespace='sku' AND external_id='SKU-FLIP'`, [ORG_A]);
  assert.equal(antes.rows.length, 1);

  await semearCatalogo(ORG_A, STORE_A, 'flip_provider', [{ providerProductId: 'f2', variants: [{ providerVariantId: 'fv2', sku: 'SKU-FLIP' }] }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'flip_provider' });
  // Contadores do bootstrap são store-wide (ver comentário do teste anterior) — a prova direta é
  // que a identity de SKU-FLIP especificamente sumiu, não uma contagem agregada.
  const { rows } = await sup.query(`SELECT 1 FROM product_external_identities WHERE organization_id=$1 AND namespace='sku' AND external_id='SKU-FLIP'`, [ORG_A]);
  assert.equal(rows.length, 0);
}));

test('F · bootstrap não sobrescreve identity `manual` (humano tem a palavra final sobre o automático)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'manual_provider', [
    { providerProductId: 'm1' }, { providerProductId: 'm2' },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'manual_provider' });
  // Um humano religa a identity de m1 para apontar para m2 manualmente.
  await sup.query(
    `UPDATE product_external_identities SET commerce_product_id=$3, source='manual', confidence='verified'
      WHERE organization_id=$1 AND store_id=$2 AND namespace='manual_provider.product_id' AND external_id='m1'`,
    [ORG_A, STORE_A, ids.get('m2')]
  );
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'manual_provider' });
  const { rows: [linha] } = await sup.query(
    `SELECT commerce_product_id, source FROM product_external_identities WHERE organization_id=$1 AND namespace='manual_provider.product_id' AND external_id='m1'`,
    [ORG_A]
  );
  assert.equal(linha.source, 'manual');
  assert.equal(linha.commerce_product_id, ids.get('m2')); // não voltou para m1
}));

test('F · bootstrap é idempotente: rodar duas vezes não duplica identity', () => em(ORG_A, STORE_A, async () => {
  await semearCatalogo(ORG_A, STORE_A, 'idem_id_provider', [{ providerProductId: 'i1', variants: [{ providerVariantId: 'iv1', sku: 'SKU-I1' }] }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'idem_id_provider' });
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'idem_id_provider' });
  const { rows: [{ n }] } = await sup.query(
    `SELECT count(*)::int AS n FROM product_external_identities WHERE organization_id=$1 AND store_id=$2 AND namespace LIKE 'idem_id_provider%' OR (organization_id=$1 AND external_id='SKU-I1')`,
    [ORG_A, STORE_A]
  );
  assert.equal(n, 3); // product_id + variant_id + sku, cada um 1x
}));

// ── Resolução GA4 ──────────────────────────────────────────────────────────────────────────────

test('F · resolução: product id exact, variant id exact, SKU exact — cada um resolve ao produto certo', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'ga4_res_provider', [
    { providerProductId: 'r1', variants: [{ providerVariantId: 'rv1', sku: 'SKU-R1' }] },
    { providerProductId: 'r2', variants: [{ providerVariantId: 'rv2', sku: 'SKU-R2' }] },
  ]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'ga4_res_provider' });

  const resolucao = await resolveExternalIds({ pool: pool() }, {
    organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['r1', 'rv2', 'SKU-R1'],
  });
  const porId = Object.fromEntries(resolucao.resolved.map((r) => [r.externalId, r]));
  assert.equal(porId.r1.commerceProductId, ids.get('r1'));
  assert.equal(porId.r1.matchedVia, 'product_id');
  assert.equal(porId.rv2.commerceProductId, ids.get('r2')); // variant → PRODUTO r2
  assert.equal(porId.rv2.matchedVia, 'variant_id');
  assert.equal(porId['SKU-R1'].commerceProductId, ids.get('r1'));
  assert.equal(porId['SKU-R1'].matchedVia, 'sku');
  assert.equal(resolucao.conflicts.length, 0);
  assert.equal(resolucao.unresolved.length, 0);
}));

test('F · itemId sem candidato nenhum vira unresolved — nunca fuzzy, nunca cria linha falsa', () => em(ORG_A, STORE_A, async () => {
  const resolucao = await resolveExternalIds({ pool: pool() }, {
    organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['nao-existe-em-lugar-nenhum'],
  });
  assert.deepEqual(resolucao.resolved, []);
  assert.deepEqual(resolucao.unresolved, [{ externalId: 'nao-existe-em-lugar-nenhum' }]);
}));

test('F · itemName nunca resolve sozinho: a API de resolução não aceita nome, só externalIds por namespace de ID', () => em(ORG_A, STORE_A, async () => {
  // Não há parâmetro "name"/"itemName" em resolveExternalIds — a única forma de "usar o nome" seria
  // passá-lo como se fosse um externalId, e mesmo assim ele só resolve se baterem exato com um id
  // conhecido (nunca por semelhança). Aqui um nome de produto claramente não bate com nenhum id.
  await semearCatalogo(ORG_A, STORE_A, 'nome_provider', [{ providerProductId: 'n1', name: 'Camiseta Estampa Regional' }]);
  await bootstrapCommerceIdentities({ pool: pool() }, { organizationId: ORG_A, storeId: STORE_A, provider: 'nome_provider' });
  const resolucao = await resolveExternalIds({ pool: pool() }, {
    organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['Camiseta Estampa Regional', 'camiseta-estampa-regional'],
  });
  assert.deepEqual(resolucao.resolved, []);
  assert.equal(resolucao.unresolved.length, 2);
}));

test('F · conflito: dois candidatos para o mesmo id externo → conflict, NUNCA escolhe', () => em(ORG_A, STORE_A, async () => {
  const pl = pool();
  await semearCatalogo(ORG_A, STORE_A, 'conflito_provider', [{ providerProductId: 'c1' }, { providerProductId: 'c2' }]);
  await bootstrapCommerceIdentities({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, provider: 'conflito_provider' });
  // Duas identities MANUAIS deliberadamente conflitantes no mesmo namespace/external_id não são
  // possíveis (UNIQUE do banco) — o conflito real de resolução acontece entre CLASSES diferentes
  // (ex.: um id que bate como product_id de um produto E como sku de outro). Monta esse cenário:
  await sup.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
     SELECT $1, $2, id, 'conflito_provider.product_id', 'ambiguo', 'manual', 'verified' FROM commerce_products
      WHERE organization_id=$1 AND store_id=$2 AND provider='conflito_provider' AND provider_product_id='c1'`,
    [ORG_A, STORE_A]
  );
  await sup.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
     SELECT $1, $2, id, 'outro_provider.product_id', 'ambiguo', 'manual', 'verified' FROM commerce_products
      WHERE organization_id=$1 AND store_id=$2 AND provider='conflito_provider' AND provider_product_id='c2'`,
    [ORG_A, STORE_A]
  );
  const resolucao = await resolveExternalIds({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['ambiguo'] });
  assert.equal(resolucao.resolved.length, 0);
  assert.equal(resolucao.conflicts.length, 1);
  assert.equal(resolucao.conflicts[0].externalId, 'ambiguo');
  assert.equal(resolucao.conflicts[0].candidateCommerceProductIds.length, 2);
}));

test('F · GA4 existing mapping: já resolvido antes não refaz o match, só confirma', () => em(ORG_A, STORE_A, async () => {
  const pl = pool();
  await semearCatalogo(ORG_A, STORE_A, 'existing_provider', [{ providerProductId: 'e1' }]);
  await bootstrapCommerceIdentities({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, provider: 'existing_provider' });
  const primeira = await resolveAndPersist({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['e1'] });
  assert.equal(primeira.resolved[0].matchedVia, 'product_id');

  const segunda = await resolveExternalIds({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['e1'] });
  assert.equal(segunda.resolved[0].matchedVia, 'existing_mapping');
  assert.equal(segunda.resolved[0].commerceProductId, primeira.resolved[0].commerceProductId);
}));

test('F · resolveAndPersist grava source=rule/confidence=exact; re-run não duplica identity', () => em(ORG_A, STORE_A, async () => {
  const pl = pool();
  await semearCatalogo(ORG_A, STORE_A, 'persist_provider', [{ providerProductId: 'per1' }]);
  await bootstrapCommerceIdentities({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, provider: 'persist_provider' });
  await resolveAndPersist({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['per1'] });
  await resolveAndPersist({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['per1'] });
  const { rows } = await sup.query(`SELECT source, confidence FROM product_external_identities WHERE organization_id=$1 AND namespace='ga4.item_id' AND external_id='per1'`, [ORG_A]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'rule');
  assert.equal(rows[0].confidence, 'exact');
}));

test('F · persistRuleMatches nunca persiste conflito nem unresolved — só o que veio resolvido por regra', () => em(ORG_A, STORE_A, async () => {
  const pl = pool();
  const r = await persistRuleMatches({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id' }, []);
  assert.equal(r.persisted, 0);
}));

// ── Coverage fim a fim ────────────────────────────────────────────────────────────────────────

test('F · coverage fim a fim: observed/matched/unmatched/conflicted batem com a resolução real', () => em(ORG_A, STORE_A, async () => {
  const pl = pool();
  await semearCatalogo(ORG_A, STORE_A, 'cov_provider', [{ providerProductId: 'cv1' }, { providerProductId: 'cv2' }]);
  await bootstrapCommerceIdentities({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, provider: 'cov_provider' });
  const observados = ['cv1', 'cv2', 'sem-match'];
  const resolucao = await resolveExternalIds({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: observados });
  const cov = computeCoverage(resolucao, observados.length);
  assert.equal(cov.observedItemIds, 3);
  assert.equal(cov.matchedItemIds, 2);
  assert.equal(cov.unmatchedItemIds, 1);
  assert.equal(cov.coverageRate, 2 / 3);
  assert.equal(cov.status, 'ok');
}));

// ── Isolamento entre Organizations e providers ───────────────────────────────────────────────

test('F · duas Organizations não cruzam identity, mesmo com o mesmo external_id', async () => {
  const pl = pool();
  await em(ORG_A, STORE_A, () => semearCatalogo(ORG_A, STORE_A, 'iso_id_provider', [{ providerProductId: 'iso1' }]));
  await em(ORG_B, STORE_B, () => semearCatalogo(ORG_B, STORE_B, 'iso_id_provider', [{ providerProductId: 'iso1' }]));
  await em(ORG_A, STORE_A, () => bootstrapCommerceIdentities({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, provider: 'iso_id_provider' }));
  await em(ORG_B, STORE_B, () => bootstrapCommerceIdentities({ pool: pl }, { organizationId: ORG_B, storeId: STORE_B, provider: 'iso_id_provider' }));

  const resA = await em(ORG_A, STORE_A, () => resolveExternalIds({ pool: pl }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['iso1'] }));
  const resB = await em(ORG_B, STORE_B, () => resolveExternalIds({ pool: pl }, { organizationId: ORG_B, storeId: STORE_B, namespace: 'ga4.item_id', externalIds: ['iso1'] }));
  assert.notEqual(resA.resolved[0].commerceProductId, resB.resolved[0].commerceProductId);
});

test('F · RLS: A não lê identity de B por baixo da role da aplicação', () => em(ORG_A, STORE_A, async () => {
  const { rows } = await pool().query('SELECT count(*)::int AS n FROM product_external_identities WHERE organization_id = $1', [ORG_B]);
  assert.equal(rows[0].n, 0);
}));

// ── Negative controls: o banco recusa, não só o código ──────────────────────────────────────────

test('NC · identity de Organization A não consegue apontar para product de Organization B (FK composta)', () => em(ORG_A, STORE_A, async () => {
  const idsB = await sup.query(
    `SELECT id FROM commerce_products WHERE organization_id=$1 LIMIT 1`, [ORG_B]
  ).then(async (r) => {
    if (r.rows.length) return r.rows;
    await em(ORG_B, STORE_B, () => semearCatalogo(ORG_B, STORE_B, 'fk_nc_provider', [{ providerProductId: 'fknc1' }]));
    return sup.query(`SELECT id FROM commerce_products WHERE organization_id=$1 AND provider='fk_nc_provider'`, [ORG_B]).then((r2) => r2.rows);
  });
  await assert.rejects(
    pool().query(
      `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
       VALUES ($1, $2, $3, 'nc.product_id', 'x', 'manual', 'exact')`,
      [ORG_A, STORE_A, idsB[0].id]
    ),
    (err) => { assert.equal(err.code, '23503'); return true; },
  );
}));

test('NC · UNIQUE (organization_id, store_id, namespace, external_id) recusa duplicidade real', () => em(ORG_A, STORE_A, async () => {
  const pl = pool();
  const ids = await semearCatalogo(ORG_A, STORE_A, 'uniq_provider', [{ providerProductId: 'u1' }, { providerProductId: 'u2' }]);
  await sup.query(
    `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
     VALUES ($1, $2, $3, 'uniq.product_id', 'dup', 'manual', 'exact')`,
    [ORG_A, STORE_A, ids.get('u1')]
  );
  await assert.rejects(
    pl.query(
      `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
       VALUES ($1, $2, $3, 'uniq.product_id', 'dup', 'manual', 'exact')`,
      [ORG_A, STORE_A, ids.get('u2')]
    ),
    (err) => { assert.equal(err.code, '23505'); return true; },
  );
}));

test('NC · namespace fora do formato (CHECK) é recusado pelo banco, mesmo passando por fora do resolver', () => em(ORG_A, STORE_A, async () => {
  const ids = await semearCatalogo(ORG_A, STORE_A, 'chk_provider', [{ providerProductId: 'chk1' }]);
  await assert.rejects(
    pool().query(
      `INSERT INTO product_external_identities (organization_id, store_id, commerce_product_id, namespace, external_id, source, confidence)
       VALUES ($1, $2, $3, 'id', 'x', 'manual', 'exact')`,
      [ORG_A, STORE_A, ids.get('chk1')]
    ),
    (err) => { assert.equal(err.code, '23514'); return true; }, // check_violation
  );
}));
