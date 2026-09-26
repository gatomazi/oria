'use strict';

// POC de armazenamento · benchmark de LATÊNCIA da resolução, em rodadas ALTERNADAS entre os modos
// (materialized, derived) para que a deriva da máquina afete os dois igualmente. Roda sobre bancos
// já carregados por run.cjs (--keep=1).
//
//   node --expose-gc scripts/dev/storage-poc/bench.cjs --db=oria_poc_mat_100k_usesul --modes=materialized,derived --rounds=15
//   (banco com identities mecânicas apagadas: --db=oria_poc_der_100k_usesul --modes=derived)
//
// Conjuntos: produto 5k · variante 5k/20k · desconhecidos 20k · misto 20k (12k produto/6k variante/2k
// desconhecido) — o "misto" é o formato real de um relatório GA4 de loja com variantes.
// Também mede o frio (container reiniciado: shared_buffers vazio) e captura EXPLAIN (ANALYZE, BUFFERS)
// da consulta derivada.

const path = require('node:path');
const fs = require('node:fs');
const { h, abrirBanco, crypto, execAsync, CONTAINER, URL_BASE } = require('./poc-lib.cjs');

const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { resolveExternalIds } = h.sujeito('lib/product-analytics/product-identity-resolver.js');

function lerArgs() {
  const a = {};
  for (const x of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(x); if (m) a[m[1]] = m[2]; }
  return a;
}

const pct = (ms, p) => { const o = [...ms].sort((x, y) => x - y); return Math.round(o[Math.min(o.length - 1, Math.floor(p * o.length))]); };

async function esperarPg(url, limite = 90000) {
  const ate = Date.now() + limite;
  for (;;) {
    const p = h.abrirPoolDescartavel(url, { max: 1 });
    try { await p.query('SELECT 1'); await p.end(); return; } catch { await p.end().catch(() => {}); }
    if (Date.now() > ate) throw new Error('postgres não voltou');
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function main() {
  const a = lerArgs();
  const modos = (a.modes || 'materialized,derived').split(',');
  const rodadas = Number(a.rounds) || 15;
  const { url } = await abrirBanco(a.db, { recriar: false });
  const sup = h.abrirPoolDescartavel(url, { max: 2 });
  const { rows: [{ id: ORG }] } = await sup.query('SELECT id FROM organizations LIMIT 1');
  const { rows: [{ id: STORE }] } = await sup.query('SELECT id FROM stores WHERE organization_id = $1 LIMIT 1', [ORG]);
  const role = `oria_app_bench_${crypto.randomBytes(4).toString('hex')}`;
  const senha = crypto.randomBytes(16).toString('hex');
  for (const sql of sqlProvisionarAppRole({ role, senha, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);

  const amostrar = async (sql, n) => (await sup.query(sql, [n])).rows.map((r) => r.v);
  const idsProduto = await amostrar(`SELECT provider_product_id v FROM commerce_products WHERE abs(hashtext(provider_product_id)) % 5 = 0 LIMIT $1`, 20000);
  const idsVariante = await amostrar(`SELECT provider_variant_id v FROM commerce_product_variants WHERE abs(hashtext(provider_variant_id)) % 150 = 0 LIMIT $1`, 20000);
  const desconhecidos = Array.from({ length: 20000 }, (_, i) => String(900000000 + i));
  const conjuntos = {
    produto_5k: idsProduto.slice(0, 5000),
    variante_5k: idsVariante.slice(0, 5000),
    variante_20k: idsVariante.slice(0, 20000),
    desconhecidos_20k: desconhecidos,
    misto_20k: [...idsProduto.slice(0, 12000), ...idsVariante.slice(0, 6000), ...desconhecidos.slice(0, 2000)],
  };

  const abrir = () => {
    const real = h.abrirPoolDescartavel(h.urlComUsuario(url, role, senha), { max: 4 });
    return { real, fachada: runtime.criarPoolTenant(real) };
  };
  let { real, fachada } = abrir();
  const dentro = (fn) => runtime.comContexto({ organizationId: ORG, storeId: STORE, origem: 'storage-poc-bench' }, fn);
  const resolver = (modo, ids) => dentro(() => resolveExternalIds({ pool: fachada, variantIdentityMode: modo }, { organizationId: ORG, storeId: STORE, namespace: 'bench.item_id', externalIds: ids }));

  const saida = { db: a.db, modos, rodadas, conjuntos: Object.fromEntries(Object.entries(conjuntos).map(([k, v]) => [k, v.length])), quente: {}, frio: {}, explain: {}, corretude: {} };

  // Corretude: os modos precisam dar a MESMA resolução no mesmo banco.
  const ref = {};
  for (const [nome, ids] of Object.entries(conjuntos)) {
    const rs = {};
    for (const m of modos) {
      const r = await resolver(m, ids); // eslint-disable-line no-await-in-loop
      rs[m] = { resolved: r.resolved.length, conflicts: r.conflicts.length, unresolved: r.unresolved.length, mapa: r.resolved.map((x) => `${x.externalId}>${x.commerceProductId}`).sort().join('|') };
    }
    const base = rs[modos[0]];
    saida.corretude[nome] = { ...Object.fromEntries(modos.map((m) => [m, { resolved: rs[m].resolved, conflicts: rs[m].conflicts, unresolved: rs[m].unresolved }])), identico: modos.every((m) => rs[m].mapa === base.mapa) };
    ref[nome] = base;
  }

  // Quente: rodadas alternadas, 2 de aquecimento descartadas por modo/conjunto.
  const amostras = {};
  for (let r = 0; r < rodadas + 2; r += 1) {
    for (const [nome, ids] of Object.entries(conjuntos)) {
      for (const m of modos) {
        const t0 = process.hrtime.bigint();
        await resolver(m, ids); // eslint-disable-line no-await-in-loop
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (r >= 2) ((amostras[nome] ||= {})[m] ||= []).push(ms);
      }
    }
  }
  for (const [nome, porModo] of Object.entries(amostras)) {
    saida.quente[nome] = Object.fromEntries(Object.entries(porModo).map(([m, ms]) => [m, { n: ms.length, minMs: pct(ms, 0), p50Ms: pct(ms, 0.5), p95Ms: pct(ms, 0.95), maxMs: pct(ms, 1) }]));
  }

  // EXPLAIN da consulta derivada (plano + buffers).
  const sqlDerivada = `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
    WITH RECURSIVE providers(provider) AS (
       (SELECT provider FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 ORDER BY provider LIMIT 1)
       UNION ALL
       SELECT (SELECT provider FROM commerce_product_variants WHERE organization_id = $1 AND store_id = $2 AND provider > p.provider ORDER BY provider LIMIT 1)
         FROM providers p WHERE p.provider IS NOT NULL
     )
     SELECT provider_variant_id AS external_id, commerce_product_id, provider || '.variant_id' AS namespace
       FROM commerce_product_variants
      WHERE organization_id = $1 AND store_id = $2
        AND provider = ANY(ARRAY(SELECT provider FROM providers WHERE provider IS NOT NULL))
        AND provider_variant_id = ANY($3::text[])`;
  const plano = await sup.query(sqlDerivada, [ORG, STORE, conjuntos.variante_5k]);
  saida.explain.derivada_variante_5k = plano.rows.map((r) => r['QUERY PLAN']).join('\n');
  const planoAntigo = await sup.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT external_id, commerce_product_id, namespace FROM product_external_identities WHERE organization_id = $1 AND store_id = $2 AND namespace LIKE '%.variant_id' AND external_id = ANY($3::text[])`,
    [ORG, STORE, conjuntos.variante_5k]
  );
  saida.explain.identidade_variante_5k = planoAntigo.rows.map((r) => r['QUERY PLAN']).join('\n');

  // Frio: reinicia o container (shared_buffers vazio; o cache de página do SO da VM permanece).
  if (a.cold !== '0') {
    await real.end();
    await sup.end();
    await execAsync(`docker restart ${CONTAINER}`);
    await esperarPg(URL_BASE.replace(/\/[^/]+$/, '/postgres'));
    ({ real, fachada } = abrir());
    for (const m of modos) {
      for (const nome of ['misto_20k', 'variante_5k']) {
        // Um banco reiniciado por (modo, conjunto): garante que cada medição é a 1ª leitura fria.
        await execAsync(`docker restart ${CONTAINER}`); // eslint-disable-line no-await-in-loop
        await esperarPg(URL_BASE.replace(/\/[^/]+$/, '/postgres')); // eslint-disable-line no-await-in-loop
        await real.end().catch(() => {}); // eslint-disable-line no-await-in-loop
        ({ real, fachada } = abrir());
        const t0 = process.hrtime.bigint();
        await resolver(m, conjuntos[nome]); // eslint-disable-line no-await-in-loop
        (saida.frio[nome] ||= {})[m] = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    }
  }

  await real.end().catch(() => {});
  const saidaPath = a.out || path.join(__dirname, 'results', `bench-${a.db}-${modos.join('+')}.json`);
  fs.mkdirSync(path.dirname(saidaPath), { recursive: true });
  fs.writeFileSync(saidaPath, JSON.stringify(saida, null, 2));
  console.log(JSON.stringify({ corretude: saida.corretude, quente: saida.quente, frio: saida.frio }, null, 1));
  console.log(`→ ${saidaPath}`);

  const admin = h.abrirPoolDescartavel(url, { max: 1 });
  try { await admin.query(`DROP OWNED BY ${role}`).catch(() => {}); } finally { await admin.end(); }
  const adm2 = h.abrirPoolDescartavel(URL_BASE.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  try { await adm2.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {}); } finally { await adm2.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
