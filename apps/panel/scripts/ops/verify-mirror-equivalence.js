// Equivalência EXAUSTIVA (somente leitura): identity espelho <provider>.variant_id ↔ commerce_product_variants, nos dois sentidos,
// lotes de 50 mil, tenant-scoped. Uso: DATABASE_URL=... node scripts/ops/verify-mirror-equivalence.js (provider fixo: reserva_ink).
// Critério de poda: exceptions vazio e n/has_*/same_product iguais. Imprime o SHA-256 do conjunto espelho (baseline para rollback).
const { Client } = require('pg');
const crypto = require('crypto');
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, application_name: 'exhaustive-equivalence-readonly' });
  await c.connect();
  await c.query('SET default_transaction_read_only = on');
  await c.query("SET statement_timeout = '60s'");
  await c.query("SET lock_timeout = '2s'");
  const out = { batches: 0, orgs: [] };
  const { rows: orgs } = await c.query('SELECT o.id AS org, s.id AS store FROM organizations o JOIN stores s ON s.organization_id = o.id');
  const B = 50000;
  for (const { org, store } of orgs) {
    const r = { org, identity_to_variant: { n: 0, has_variant: 0, same_product: 0, variant_active: 0 }, variant_to_identity: { n: 0, has_identity: 0, same_product: 0, mirror_source: 0 }, exceptions: [] };
    const hash = crypto.createHash('sha256');
    let last = '';
    for (;;) {
      const t0 = Date.now();
      const { rows: [x] } = await c.query(
        `WITH b AS (SELECT external_id, commerce_product_id FROM product_external_identities WHERE organization_id=$1 AND store_id=$2 AND namespace='reserva_ink.variant_id' AND source='commerce_sync' AND external_id > $3 ORDER BY external_id LIMIT ${B})
         SELECT count(*)::int n, count(v.id)::int has_v, count(*) FILTER (WHERE v.commerce_product_id = b.commerce_product_id)::int same, count(*) FILTER (WHERE v.is_active)::int act, max(b.external_id) last,
                md5(string_agg(b.external_id || ':' || b.commerce_product_id::text, ',' ORDER BY b.external_id)) h
           FROM b LEFT JOIN commerce_product_variants v ON v.organization_id=$1 AND v.store_id=$2 AND v.provider='reserva_ink' AND v.provider_variant_id=b.external_id`, [org, store, last]);
      if (x.n === 0) break;
      r.identity_to_variant.n += x.n; r.identity_to_variant.has_variant += x.has_v; r.identity_to_variant.same_product += x.same; r.identity_to_variant.variant_active += x.act;
      if (x.has_v !== x.n || x.same !== x.n) r.exceptions.push({ dir: 'identity->variant', after: last, n: x.n, has_v: x.has_v, same: x.same });
      hash.update(x.h); last = x.last; out.batches += 1;
      await new Promise((res) => setTimeout(res, Math.min(2000, (Date.now() - t0)))); // pausa proporcional ao custo do lote
    }
    r.identity_set_sha256 = hash.digest('hex');
    last = '';
    for (;;) {
      const t0 = Date.now();
      const { rows: [x] } = await c.query(
        `WITH b AS (SELECT provider_variant_id, commerce_product_id FROM commerce_product_variants WHERE organization_id=$1 AND store_id=$2 AND provider='reserva_ink' AND provider_variant_id > $3 ORDER BY provider_variant_id LIMIT ${B})
         SELECT count(*)::int n, count(i.id)::int has_i, count(*) FILTER (WHERE i.commerce_product_id = b.commerce_product_id)::int same, count(*) FILTER (WHERE i.source='commerce_sync' AND i.confidence='exact')::int mirror, max(b.provider_variant_id) last
           FROM b LEFT JOIN product_external_identities i ON i.organization_id=$1 AND i.store_id=$2 AND i.namespace='reserva_ink.variant_id' AND i.external_id=b.provider_variant_id`, [org, store, last]);
      if (x.n === 0) break;
      r.variant_to_identity.n += x.n; r.variant_to_identity.has_identity += x.has_i; r.variant_to_identity.same_product += x.same; r.variant_to_identity.mirror_source += x.mirror;
      if (x.has_i !== x.n || x.same !== x.n) r.exceptions.push({ dir: 'variant->identity', after: last, n: x.n, has_i: x.has_i, same: x.same });
      last = x.last; out.batches += 1;
      await new Promise((res) => setTimeout(res, Math.min(2000, (Date.now() - t0))));
    }
    const { rows: [m] } = await c.query(`SELECT count(*) FILTER (WHERE source<>'commerce_sync')::int non_mirror_in_variant_ns FROM product_external_identities WHERE organization_id=$1 AND store_id=$2 AND namespace LIKE '%.variant_id'`, [org, store]);
    r.non_mirror_variant_namespace_rows = m.non_mirror_in_variant_ns;
    const { rows: [v] } = await c.query(`SELECT count(*) FILTER (WHERE NOT is_active)::int inactive_variants, count(DISTINCT provider)::int providers FROM commerce_product_variants WHERE organization_id=$1 AND store_id=$2`, [org, store]);
    r.inactive_variants = v.inactive_variants; r.providers = v.providers;
    out.orgs.push(r);
  }
  await c.end();
  console.log(JSON.stringify(out));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
