'use strict';
// POC · compara FORMAS da consulta derivada (variante → produto) na mesma base: latência (mediana de N
// execuções alternadas) e tipo de plano. Uso: node sqlplans.cjs --db=<banco> [--url=postgres://…]
const { Pool } = require('pg');
const a = Object.fromEntries(process.argv.slice(2).map((x) => { const m = /^--([^=]+)=(.*)$/.exec(x); return [m[1], m[2]]; }));
const URL = (a.url || 'postgres://postgres:poc@127.0.0.1:55432/oria_poc').replace(/\/[^/]+$/, `/${a.db}`);

const PROV = `WITH RECURSIVE providers(provider) AS (
  (SELECT provider FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 ORDER BY provider LIMIT 1)
  UNION ALL
  SELECT (SELECT provider FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 AND provider > p.provider ORDER BY provider LIMIT 1) FROM providers p WHERE p.provider IS NOT NULL)`;
const FORMAS = {
  a_hashjoin_cte: `${PROV} SELECT v.provider_variant_id, v.commerce_product_id, v.provider || '.variant_id' AS namespace FROM providers p JOIN commerce_product_variants v ON v.organization_id = $1 AND v.store_id = $2 AND v.provider = p.provider AND v.provider_variant_id = ANY($3::text[]) WHERE p.provider IS NOT NULL`,
  b_lateral_offset0: `${PROV} SELECT v.provider_variant_id, v.commerce_product_id, v.provider || '.variant_id' AS namespace FROM providers p CROSS JOIN LATERAL (SELECT provider, provider_variant_id, commerce_product_id FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 AND provider = p.provider AND provider_variant_id = ANY($3::text[]) OFFSET 0) v WHERE p.provider IS NOT NULL`,
  c_sem_provider: `SELECT provider_variant_id, commerce_product_id, provider || '.variant_id' AS namespace FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 AND provider_variant_id = ANY($3::text[])`,
  d_array_initplan: `${PROV} SELECT provider_variant_id, commerce_product_id, provider || '.variant_id' AS namespace FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 AND provider = ANY(ARRAY(SELECT provider FROM providers WHERE provider IS NOT NULL)) AND provider_variant_id = ANY($3::text[])`,
};

(async () => {
  const pool = new Pool({ connectionString: URL, max: 1 });
  const { rows: [{ id: org }] } = await pool.query('SELECT id FROM organizations LIMIT 1');
  const { rows: [{ id: store }] } = await pool.query('SELECT id FROM stores LIMIT 1');
  const vars = (await pool.query(`SELECT provider_variant_id v FROM commerce_product_variants WHERE abs(hashtext(provider_variant_id)) % 150 = 0 LIMIT 20000`)).rows.map((r) => r.v);
  const unk = Array.from({ length: 20000 }, (_, i) => String(900000000 + i));
  const conj = { variante_5k: vars.slice(0, 5000), variante_20k: vars.slice(0, 20000), desconhecidos_20k: unk };
  const out = {};
  for (const [cn, ids] of Object.entries(conj)) {
    const t = Object.fromEntries(Object.keys(FORMAS).map((k) => [k, []]));
    for (let r = 0; r < 12; r += 1) for (const [k, sql] of Object.entries(FORMAS)) {
      const t0 = process.hrtime.bigint();
      const res = await pool.query(sql, [org, store, ids]); // eslint-disable-line no-await-in-loop
      if (r >= 2) t[k].push(Number(process.hrtime.bigint() - t0) / 1e6);
      if (r === 0 && k === 'a_hashjoin_cte') out[`${cn}_rows`] = res.rows.length;
    }
    out[cn] = Object.fromEntries(Object.entries(t).map(([k, ms]) => { const o = [...ms].sort((x, y) => x - y); return [k, `p50=${Math.round(o[5])} min=${Math.round(o[0])}`]; }));
  }
  const plano = {};
  for (const [k, sql] of Object.entries(FORMAS)) {
    const r = await pool.query(`EXPLAIN (COSTS OFF) ${sql}`, [org, store, conj.variante_5k]); // eslint-disable-line no-await-in-loop
    const txt = r.rows.map((x) => x['QUERY PLAN']).join('\n');
    plano[k] = /Seq Scan on commerce_product_variants v?\b/.test(txt.replace(/Index Only Scan[^\n]*/g, '')) && /Seq Scan on commerce_product_variants/.test(txt) ? 'SEQ SCAN' : (/Nested Loop/.test(txt) ? 'nested loop + index' : 'index');
  }
  console.log(JSON.stringify({ db: a.db, ...out, plano }, null, 1));
  await pool.end();
})();
