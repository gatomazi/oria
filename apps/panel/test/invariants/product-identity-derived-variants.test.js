'use strict';

// Rodada de otimização de armazenamento · teste DIFERENCIAL do resolvedor de identidade:
// `materialized` (uma linha `<provider>.variant_id` por variante, o comportamento histórico) contra
// `derived` (passo 3 lê o catálogo canônico; as linhas mecânicas não existem mais). Para cada
// cenário o resultado precisa ser IGUAL — a exceção única e documentada é a variante que o
// bootstrap nunca viu (derived a resolve, materialized ainda não).
//
// Também prova: o modo `dual` (devolve o antigo e reporta divergência), a ausência de vazamento
// entre Organizations (mesmo id de variante em duas Organizations), e que valor inválido de modo
// nunca é aceito em silêncio.
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
  bootstrapCommerceIdentities, resolveExternalIds, resolveAndPersist, MODOS_VARIANTE,
} = h.sujeito('lib/product-analytics/product-identity-resolver.js');

const ORG_A = 'f3000000-0000-4000-8000-000000000001';
const ORG_B = 'f3000000-0000-4000-8000-000000000002';
const STORE_A = 'f4000000-0000-4000-8000-000000000001';
const STORE_B = 'f4000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_dv_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const RUN = crypto.randomUUID();

let db;
let sup;
let appPoolReal;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);
const pool = () => runtime.criarPoolTenant(appPoolReal);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_dv');
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

async function semear(org, store, provider, produtos) {
  const idsPorPid = new Map();
  for (const p of produtos) {
    const { rows: [{ id }] } = await sup.query(
      `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [org, store, provider, p.providerProductId, `Produto ${p.providerProductId}`, RUN]
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

const bootstrap = (org, store, provider, modo) => bootstrapCommerceIdentities({ pool: pool(), variantIdentityMode: modo }, { organizationId: org, storeId: store, provider });
const resolver = (org, store, ids, modo, extra = {}) => resolveExternalIds(
  { pool: pool(), variantIdentityMode: modo, ...extra }, { organizationId: org, storeId: store, namespace: 'ga4.item_id', externalIds: ids }
);

// Simula o estado PÓS-poda: só as linhas mecânicas (bootstrap) de variante somem; manual/regra ficam.
const podarMecanicas = (org, store) => sup.query(
  `DELETE FROM product_external_identities WHERE organization_id = $1 AND store_id = $2 AND source = 'commerce_sync' AND namespace LIKE '%.variant_id'`,
  [org, store]
);

// Forma canônica para comparar (a ordem dos arrays não faz parte do contrato).
function normalizar(r) {
  const porId = (a, b) => a.externalId.localeCompare(b.externalId);
  return {
    resolved: [...r.resolved].sort(porId),
    conflicts: r.conflicts.map((c) => ({ ...c, candidateCommerceProductIds: [...c.candidateCommerceProductIds].sort() })).sort(porId),
    unresolved: [...r.unresolved].sort(porId),
  };
}

// Roda antigo (materializado, com as linhas espelho) → poda → roda novo e exige igualdade.
async function diferencial(org, store, provider, ids) {
  const antigo = await resolver(org, store, ids, 'materialized');
  const dual = await resolver(org, store, ids, 'dual', { onDivergence: () => assert.fail('dual não deveria divergir aqui') });
  await podarMecanicas(org, store);
  const novo = await resolver(org, store, ids, 'derived');
  assert.deepEqual(normalizar(novo), normalizar(antigo));
  assert.deepEqual(normalizar(dual), normalizar(antigo));
  return { antigo, novo };
}

// ── Os 9 cenários exigidos ──────────────────────────────────────────────────────────────────────

test('DV · 1 igualdade de product id: derived == materialized', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dv1', [{ providerProductId: 'dv1-p1', variants: [{ providerVariantId: 'dv1-v1' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dv1', 'materialized');
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv1', ['dv1-p1']);
  assert.equal(novo.resolved[0].commerceProductId, ids.get('dv1-p1'));
  assert.equal(novo.resolved[0].matchedVia, 'product_id');
}));

test('DV · 2 igualdade de variant id: derived resolve ao PRODUTO da variante, igual ao materializado', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dv2', [
    { providerProductId: 'dv2-p1', variants: [{ providerVariantId: 'dv2-v1' }, { providerVariantId: 'dv2-v2' }] },
    { providerProductId: 'dv2-p2', variants: [{ providerVariantId: 'dv2-v3' }] },
  ]);
  await bootstrap(ORG_A, STORE_A, 'dv2', 'materialized');
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv2', ['dv2-v1', 'dv2-v2', 'dv2-v3']);
  const porId = Object.fromEntries(novo.resolved.map((r) => [r.externalId, r]));
  assert.equal(porId['dv2-v1'].commerceProductId, ids.get('dv2-p1'));
  assert.equal(porId['dv2-v2'].commerceProductId, ids.get('dv2-p1'));
  assert.equal(porId['dv2-v3'].commerceProductId, ids.get('dv2-p2'));
  for (const r of novo.resolved) assert.equal(r.matchedVia, 'variant_id');
}));

test('DV · 3 SKU único: continua identity gravada (bootstrap) e resolve igual nos dois modos', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dv3', [{ providerProductId: 'dv3-p1', variants: [{ providerVariantId: 'dv3-v1', sku: 'DV3-SKU-UNICO' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dv3', 'materialized');
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv3', ['DV3-SKU-UNICO']);
  assert.equal(novo.resolved[0].commerceProductId, ids.get('dv3-p1'));
  assert.equal(novo.resolved[0].matchedVia, 'sku');
}));

test('DV · 4 SKU duplicado: nunca vira identity, unresolved nos dois modos', () => em(ORG_A, STORE_A, async () => {
  await semear(ORG_A, STORE_A, 'dv4', [
    { providerProductId: 'dv4-p1', variants: [{ providerVariantId: 'dv4-v1', sku: 'DV4-SKU-DUP' }] },
    { providerProductId: 'dv4-p2', variants: [{ providerVariantId: 'dv4-v2', sku: 'DV4-SKU-DUP' }] },
  ]);
  await bootstrap(ORG_A, STORE_A, 'dv4', 'materialized');
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv4', ['DV4-SKU-DUP']);
  assert.deepEqual(novo.unresolved, [{ externalId: 'DV4-SKU-DUP' }]);
}));

test('DV · 5 alias manual tem prioridade sobre o catálogo (variante reapontada por humano)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dv5', [
    { providerProductId: 'dv5-p1', variants: [{ providerVariantId: 'dv5-v1' }] },
    { providerProductId: 'dv5-p2' },
  ]);
  await bootstrap(ORG_A, STORE_A, 'dv5', 'materialized');
  await sup.query(
    `UPDATE product_external_identities SET commerce_product_id = $3, source = 'manual', confidence = 'verified'
      WHERE organization_id = $1 AND store_id = $2 AND namespace = 'dv5.variant_id' AND external_id = 'dv5-v1'`,
    [ORG_A, STORE_A, ids.get('dv5-p2')]
  );
  const { antigo, novo } = await diferencial(ORG_A, STORE_A, 'dv5', ['dv5-v1']);
  assert.equal(antigo.resolved[0].commerceProductId, ids.get('dv5-p2'));
  assert.equal(novo.resolved[0].commerceProductId, ids.get('dv5-p2')); // o manual venceu o catálogo (que diria p1)
  // E um bootstrap `derived` posterior não desfaz o manual.
  await bootstrap(ORG_A, STORE_A, 'dv5', 'derived');
  const depois = await resolver(ORG_A, STORE_A, ['dv5-v1'], 'derived');
  assert.equal(depois.resolved[0].commerceProductId, ids.get('dv5-p2'));
}));

test('DV · 6 identidade histórica/inativa: variante e produto desativados continuam resolvendo (nunca some do histórico)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dv6', [{ providerProductId: 'dv6-p1', variants: [{ providerVariantId: 'dv6-v1' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dv6', 'materialized');
  await sup.query(`UPDATE commerce_product_variants SET is_active = false WHERE organization_id = $1 AND provider = 'dv6'`, [ORG_A]);
  await sup.query(`UPDATE commerce_products SET is_active = false WHERE organization_id = $1 AND provider = 'dv6'`, [ORG_A]);
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv6', ['dv6-v1', 'dv6-p1']);
  assert.equal(novo.resolved.length, 2);
  for (const r of novo.resolved) assert.equal(r.commerceProductId, ids.get('dv6-p1'));
}));

test('DV · 7 colisão entre providers: o mesmo id de variante em dois providers é CONFLITO nos dois modos, nunca escolhe', () => em(ORG_A, STORE_A, async () => {
  const a = await semear(ORG_A, STORE_A, 'dv7a', [{ providerProductId: 'dv7a-p', variants: [{ providerVariantId: 'DV7-COLISAO' }] }]);
  const b = await semear(ORG_A, STORE_A, 'dv7b', [{ providerProductId: 'dv7b-p', variants: [{ providerVariantId: 'DV7-COLISAO' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dv7a', 'materialized');
  await bootstrap(ORG_A, STORE_A, 'dv7b', 'materialized');
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv7', ['DV7-COLISAO']);
  assert.equal(novo.resolved.length, 0);
  assert.equal(novo.conflicts.length, 1);
  assert.deepEqual([...novo.conflicts[0].candidateCommerceProductIds].sort(), [a.get('dv7a-p'), b.get('dv7b-p')].sort());
  // resolveAndPersist nunca grava conflito.
  await resolveAndPersist({ pool: pool(), variantIdentityMode: 'derived' }, { organizationId: ORG_A, storeId: STORE_A, namespace: 'ga4.item_id', externalIds: ['DV7-COLISAO'] });
  const { rows } = await sup.query(`SELECT 1 FROM product_external_identities WHERE organization_id = $1 AND namespace = 'ga4.item_id' AND external_id = 'DV7-COLISAO'`, [ORG_A]);
  assert.equal(rows.length, 0);
}));

test('DV · 8 itemId observado sem correspondência: unresolved nos dois modos', () => em(ORG_A, STORE_A, async () => {
  await semear(ORG_A, STORE_A, 'dv8', [{ providerProductId: 'dv8-p1', variants: [{ providerVariantId: 'dv8-v1' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dv8', 'materialized');
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv8', ['dv8-nao-existe', '999999999']);
  assert.equal(novo.unresolved.length, 2);
  assert.equal(novo.resolved.length, 0);
}));

test('DV · 9 nunca resolve por aproximação: caixa diferente, prefixo, sufixo e id parcial não casam em nenhum modo', () => em(ORG_A, STORE_A, async () => {
  await semear(ORG_A, STORE_A, 'dv9', [{ providerProductId: 'dv9-P1', variants: [{ providerVariantId: 'dv9-V1' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dv9', 'materialized');
  const quase = ['DV9-p1', 'dv9-p1', 'dv9-V', 'dv9-V10', 'xdv9-V1', 'dv9-v1', '%', '_', 'dv9-V1%'];
  const { novo } = await diferencial(ORG_A, STORE_A, 'dv9', quase);
  assert.equal(novo.resolved.length, 0);
  assert.equal(novo.unresolved.length, quase.length);
}));

// ── Modos, superconjunto documentado, dual ──────────────────────────────────────────────────────

test('DV · bootstrap derived não grava identity de variante, mas grava product id e SKU único', () => em(ORG_A, STORE_A, async () => {
  await semear(ORG_A, STORE_A, 'dvb', [{ providerProductId: 'dvb-p1', variants: [{ providerVariantId: 'dvb-v1', sku: 'DVB-SKU' }, { providerVariantId: 'dvb-v2', sku: 'DVB-SKU2' }] }]);
  const r = await bootstrap(ORG_A, STORE_A, 'dvb', 'derived');
  assert.equal(r.variantIdentities, 0);
  assert.equal(r.productIdentities >= 1, true);
  const { rows } = await sup.query(`SELECT namespace FROM product_external_identities WHERE organization_id = $1 AND (namespace LIKE 'dvb.%' OR external_id LIKE 'DVB-SKU%')`, [ORG_A]);
  const ns = rows.map((x) => x.namespace).sort();
  assert.deepEqual(ns, ['dvb.product_id', 'sku', 'sku']);
  // e resolve a variante mesmo assim
  const res = await resolver(ORG_A, STORE_A, ['dvb-v1', 'dvb-v2'], 'derived');
  assert.equal(res.resolved.length, 2);
}));

test('DV · única diferença aceita: variante que o bootstrap nunca viu — derived resolve, materialized ainda não (dual reporta derived_only e devolve o antigo)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dvn', [{ providerProductId: 'dvn-p1', variants: [{ providerVariantId: 'dvn-v1' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dvn', 'materialized');
  await sup.query(
    `INSERT INTO commerce_product_variants (organization_id, store_id, commerce_product_id, provider, provider_variant_id, last_seen_sync_id) VALUES ($1, $2, $3, 'dvn', 'dvn-v-novo', $4)`,
    [ORG_A, STORE_A, ids.get('dvn-p1'), RUN]
  );
  const antigo = await resolver(ORG_A, STORE_A, ['dvn-v-novo'], 'materialized');
  assert.equal(antigo.unresolved.length, 1);
  const eventos = [];
  const dual = await resolver(ORG_A, STORE_A, ['dvn-v-novo', 'dvn-v1'], 'dual', { onDivergence: (d) => eventos.push(...d) });
  assert.deepEqual(dual.resolved.map((r) => r.externalId), ['dvn-v1']); // devolveu o antigo
  assert.deepEqual(eventos.map((e) => [e.externalId, e.kind]), [['dvn-v-novo', 'derived_only']]);
  const novo = await resolver(ORG_A, STORE_A, ['dvn-v-novo'], 'derived');
  assert.equal(novo.resolved[0].commerceProductId, ids.get('dvn-p1'));
}));

test('DV · linha espelho VELHA não vence o catálogo no derived (variante que o provider mudou de produto, antes da poda)', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dvs', [
    { providerProductId: 'dvs-p1', variants: [{ providerVariantId: 'dvs-v1' }] },
    { providerProductId: 'dvs-p2' },
  ]);
  await bootstrap(ORG_A, STORE_A, 'dvs', 'materialized'); // espelho: dvs-v1 → p1
  await sup.query(`UPDATE commerce_product_variants SET commerce_product_id = $2 WHERE organization_id = $1 AND provider = 'dvs' AND provider_variant_id = 'dvs-v1'`, [ORG_A, ids.get('dvs-p2')]);
  const eventos = [];
  const dual = await resolver(ORG_A, STORE_A, ['dvs-v1'], 'dual', { onDivergence: (d) => eventos.push(...d) });
  assert.equal(dual.resolved[0].commerceProductId, ids.get('dvs-p1'));   // o antigo (espelho velho) ainda vale no dual
  assert.equal(eventos[0].kind, 'different_product');                    // e o dual DENUNCIA a diferença
  const novo = await resolver(ORG_A, STORE_A, ['dvs-v1'], 'derived');
  assert.equal(novo.resolved[0].commerceProductId, ids.get('dvs-p2'));   // derived segue o catálogo, sem poda
}));

test('DV · dual reporta materialized_only quando a linha gravada não tem variante correspondente no catálogo', () => em(ORG_A, STORE_A, async () => {
  await semear(ORG_A, STORE_A, 'dvm', [{ providerProductId: 'dvm-p1', variants: [{ providerVariantId: 'dvm-v1' }] }]);
  await bootstrap(ORG_A, STORE_A, 'dvm', 'materialized');
  await sup.query(`DELETE FROM commerce_product_variants WHERE organization_id = $1 AND provider = 'dvm'`, [ORG_A]);
  const eventos = [];
  const dual = await resolver(ORG_A, STORE_A, ['dvm-v1'], 'dual', { onDivergence: (d) => eventos.push(...d) });
  assert.equal(dual.resolved.length, 1); // o antigo continua valendo
  assert.equal(eventos[0].kind, 'materialized_only');
}));

test('DV · vários providers na mesma Store: a busca recursiva de providers acha todos (nenhum fica de fora)', () => em(ORG_A, STORE_A, async () => {
  const provs = ['dvp-a', 'dvp-b', 'dvp-c', 'dvp-d'];
  const ids = [];
  for (const p of provs) {
    const m = await semear(ORG_A, STORE_A, p, [{ providerProductId: `${p}-p`, variants: [{ providerVariantId: `${p}-v` }] }]);
    ids.push([`${p}-v`, m.get(`${p}-p`)]);
  }
  const res = await resolver(ORG_A, STORE_A, ids.map(([v]) => v), 'derived');
  assert.equal(res.resolved.length, provs.length);
  for (const [v, produto] of ids) assert.equal(res.resolved.find((r) => r.externalId === v).commerceProductId, produto);
}));

// ── Tenancy ─────────────────────────────────────────────────────────────────────────────────────

test('DV · duas Organizations com o MESMO id de variante: cada uma resolve o próprio produto e nunca o do outro (derived)', async () => {
  const a = await em(ORG_A, STORE_A, () => semear(ORG_A, STORE_A, 'dvt', [{ providerProductId: 'dvt-pa', variants: [{ providerVariantId: 'DVT-MESMO' }] }]));
  const b = await em(ORG_B, STORE_B, () => semear(ORG_B, STORE_B, 'dvt', [{ providerProductId: 'dvt-pb', variants: [{ providerVariantId: 'DVT-MESMO' }] }]));
  const ra = await em(ORG_A, STORE_A, () => resolver(ORG_A, STORE_A, ['DVT-MESMO'], 'derived'));
  const rb = await em(ORG_B, STORE_B, () => resolver(ORG_B, STORE_B, ['DVT-MESMO'], 'derived'));
  assert.equal(ra.resolved[0].commerceProductId, a.get('dvt-pa'));
  assert.equal(rb.resolved[0].commerceProductId, b.get('dvt-pb'));
  assert.notEqual(ra.resolved[0].commerceProductId, rb.resolved[0].commerceProductId);
  // Contexto B pedindo explicitamente a Organization A: o RLS do banco devolve nada.
  const cruzado = await em(ORG_B, STORE_B, () => resolver(ORG_A, STORE_A, ['DVT-MESMO'], 'derived'));
  assert.equal(cruzado.resolved.length, 0);
  assert.equal(cruzado.unresolved.length, 1);
  // Nem o modo dual vaza.
  const dualCruzado = await em(ORG_B, STORE_B, () => resolver(ORG_A, STORE_A, ['DVT-MESMO'], 'dual', { onDivergence: () => assert.fail('sem divergência esperada') }));
  assert.equal(dualCruzado.resolved.length, 0);
});

test('DV · modo inválido nunca é aceito em silêncio', () => em(ORG_A, STORE_A, async () => {
  assert.deepEqual([...MODOS_VARIANTE], ['materialized', 'dual', 'derived']);
  await assert.rejects(resolver(ORG_A, STORE_A, ['x'], 'lazy'), TypeError);
  await assert.rejects(bootstrap(ORG_A, STORE_A, 'dv1', 'lazy'), TypeError);
}));

// ── Bootstrap sem regravar o que não mudou ─────────────────────────────────────────────────────

test('DV · bootstrap repetido não regrava identity nenhuma (mesma versão física); mudou o produto alvo → só essa linha é atualizada', () => em(ORG_A, STORE_A, async () => {
  const ids = await semear(ORG_A, STORE_A, 'dvr', [
    { providerProductId: 'dvr-p1', variants: [{ providerVariantId: 'dvr-v1', sku: 'DVR-SKU-1' }] },
    { providerProductId: 'dvr-p2', variants: [{ providerVariantId: 'dvr-v2', sku: 'DVR-SKU-2' }] },
  ]);
  const versoes = async () => (await sup.query(
    `SELECT namespace || ':' || external_id AS k, xmin::text AS x FROM product_external_identities WHERE organization_id = $1 AND (namespace LIKE 'dvr.%' OR external_id LIKE 'DVR-SKU%') ORDER BY 1`, [ORG_A]
  )).rows;
  await bootstrap(ORG_A, STORE_A, 'dvr', 'derived');
  const antes = await versoes();
  assert.equal(antes.length, 4); // 2 product_id + 2 sku únicos
  const r2 = await bootstrap(ORG_A, STORE_A, 'dvr', 'derived');
  assert.equal(r2.productIdentities, 0);
  assert.equal(r2.skuIdentities, 0);
  assert.deepEqual(await versoes(), antes); // nenhuma linha regravada
  // o provider passa a variante/produto para outro dono: o SKU único aponta para o novo produto
  await sup.query(`UPDATE commerce_product_variants SET commerce_product_id = $2 WHERE organization_id = $1 AND provider = 'dvr' AND provider_variant_id = 'dvr-v1'`, [ORG_A, ids.get('dvr-p2')]);
  const r3 = await bootstrap(ORG_A, STORE_A, 'dvr', 'derived');
  assert.equal(r3.skuIdentities, 1);
  const { rows: [sku1] } = await sup.query(`SELECT commerce_product_id FROM product_external_identities WHERE organization_id = $1 AND namespace = 'sku' AND external_id = 'DVR-SKU-1'`, [ORG_A]);
  assert.equal(sku1.commerce_product_id, ids.get('dvr-p2'));
}));
