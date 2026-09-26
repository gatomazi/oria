'use strict';

// POC de armazenamento · um experimento = (arm × escala × mix × sku). Roda o CÓDIGO REAL
// (runCatalogSync, bootstrapCommerceIdentities, resolveExternalIds, serviços de analytics) contra
// um Postgres 18 isolado, com catálogo sintético fiel à Use Sul, e mede bytes/tempo/WAL/memória/
// latência antes e depois.
//
//   node --expose-gc scripts/dev/storage-poc/run.cjs --arm=materialized --products=10000 --mix=usesul
//   node --expose-gc scripts/dev/storage-poc/run.cjs --arm=derived --products=100000 --mix=usesul --keep=1
//
// arm: materialized (comportamento atual) | derived (sem identity mecânica de variante)
// Flags: --sku=shared|unique  --churn=0.1  --bench=1  --compact=1  --keep=1 (mantém o banco p/ forks)
//        --out=<arquivo.json>  --label=<texto>
// Nunca toca produção: poc-lib.cjs recusa qualquer host que não seja 127.0.0.1 e banco fora de oria_poc_*.

const path = require('node:path');
const fs = require('node:fs');
const {
  h, tamanhos, fase, abrirBanco, crypto, mb,
} = require('./poc-lib.cjs');
const { montarPlano, conectorFalso, idsObservadosGa4 } = require('./generator.cjs');

const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createConnectorRegistry } = h.sujeito('lib/connectors/registry.js');
const { createJobLeases } = h.sujeito('lib/platform/leases.js');
const { runCatalogSync } = h.sujeito('lib/product-analytics/catalog-sync.js');
const { bootstrapCommerceIdentities, resolveExternalIds } = h.sujeito('lib/product-analytics/product-identity-resolver.js');
const { createCommerceCatalogRepository } = h.sujeito('lib/product-analytics/commerce-catalog-repository.js');
const { createProductPerformanceService } = h.sujeito('lib/product-analytics/product-performance-service.js');
const { createReconciliationService } = h.sujeito('lib/product-analytics/reconciliation.js');
const { createOpportunityDiagnosticsService } = h.sujeito('lib/product-analytics/opportunity-diagnostics.js');

const PROVIDER = 'reserva_ink';
const ANALYTICS = 'ga4';

async function sup0(url, sql) {
  const p = h.abrirPoolDescartavel(url, { max: 1 });
  try { await p.query(sql); } finally { await p.end(); }
}

function lerArgs() {
  const a = {};
  for (const x of process.argv.slice(2)) {
    const m = /^--([^=]+)=(.*)$/.exec(x);
    if (m) a[m[1]] = m[2];
  }
  return a;
}

const semLog = { warn() {}, error(m) { console.error(m); } };

function percentis(ms) {
  const o = [...ms].sort((x, y) => x - y);
  const q = (p) => o[Math.min(o.length - 1, Math.floor(p * o.length))];
  return { n: o.length, minMs: Math.round(o[0]), p50Ms: Math.round(q(0.5)), p95Ms: Math.round(q(0.95)), maxMs: Math.round(o[o.length - 1]) };
}

async function medir(fn, { aquecer = 2, vezes = 10 } = {}) {
  for (let i = 0; i < aquecer; i += 1) await fn(); // eslint-disable-line no-await-in-loop
  const ms = [];
  for (let i = 0; i < vezes; i += 1) {
    const t0 = process.hrtime.bigint();
    await fn(); // eslint-disable-line no-await-in-loop
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return percentis(ms);
}

function registryComercio(conector) {
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: true, refunds: false, productCosts: false },
    create: () => conector,
  });
  return registry;
}

function registryAnalyticsFake(idsObservados) {
  const linhas = idsObservados.map((id, n) => ({
    externalProductId: id, externalProductName: `Produto ${id}`,
    itemsViewed: 50 + (n % 500), itemsAddedToCart: 5 + (n % 40), itemsCheckedOut: 2 + (n % 15), itemsPurchased: 1 + (n % 6),
    itemRevenue: 89.9 * (1 + (n % 6)), analyticsProvider: ANALYTICS,
  }));
  const chamadas = { n: 0 };
  const registry = createConnectorRegistry();
  registry.register({
    domain: 'analytics', provider: ANALYTICS, integrationProvider: ANALYTICS, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({ async getProductPerformance() { chamadas.n += 1; return linhas; }, async getCacheScope() { return null; } }),
  });
  return { registry, chamadas };
}

// Une commerce + analytics num registry só (os serviços resolvem os dois domínios).
function registryFinal(rc, ra, org, store) {
  const r = createConnectorRegistry();
  r.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: true, refunds: false, productCosts: false },
    create: () => rc.resolve('commerce', PROVIDER, { organizationId: org, storeId: store }).connector,
  });
  r.register({
    domain: 'analytics', provider: ANALYTICS, integrationProvider: ANALYTICS, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ra.resolve('analytics', ANALYTICS, { organizationId: org, storeId: store }).connector,
  });
  return r;
}

async function coletarIdsDeVariante(plano, skuMode, alvo) {
  const c = conectorFalso({ plano, skuMode });
  const passo = Math.max(1, Math.floor(c.totalVariants / alvo));
  const ids = [];
  let k = 0;
  let cursor = null;
  do {
    const p = await c.listProductsWithVariants({ cursor }); // eslint-disable-line no-await-in-loop
    for (const it of p.items) for (const v of it.variants) { if (k % passo === 0 && ids.length < alvo) ids.push(v.providerVariantId); k += 1; }
    cursor = p.nextCursor;
  } while (cursor);
  return ids;
}

async function main() {
  const a = lerArgs();
  const arm = a.arm || 'materialized';
  if (!['materialized', 'derived'].includes(arm)) throw new Error(`arm inválido: ${arm}`);
  const nProdutos = Number(a.products) || 10000;
  const mix = a.mix || 'usesul';
  const skuMode = a.sku || 'shared';
  const churn = a.churn !== undefined ? Number(a.churn) : 0.1;
  const sweep = a.sweep || 'last_seen';
  const rodarBench = a.bench !== '0';
  const rodarCompactacao = a.compact !== '0';
  const rotulo = a.label || `${arm}-${nProdutos}-${mix}-${skuMode}`;
  const nomeBanco = `oria_poc_${rotulo.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);

  console.log(`\n=== POC armazenamento · ${rotulo} ===`);
  const plano = montarPlano({ nProducts: nProdutos, mix });
  const totalVariantes = plano.reduce((s, x) => s + x.nVariants, 0);
  const observados = idsObservadosGa4(plano);
  console.log(`catálogo: ${plano.length} produtos · ${totalVariantes} variantes (${(totalVariantes / plano.length).toFixed(1)}/produto) · ${observados.length} ids GA4 · sku=${skuMode} · arm=${arm}`);

  const db = await abrirBanco(nomeBanco);
  const r = h.migrar(db.url);
  if (r.status !== 0) throw new Error(`migrations falharam: ${r.stdout}${r.stderr}`);
  // Arm E (índices): descarta os dois índices secundários de variante que nenhuma consulta usa (sync_run e
  // ativos — nunca a PK, o UNIQUE nem o índice de produto que sustenta o ON DELETE CASCADE). SÓ no banco da POC.
  if (a.dropidx === '1') {
    await sup0(db.url, 'DROP INDEX idx_commerce_product_variants_sync_run');
    await sup0(db.url, 'DROP INDEX idx_commerce_product_variants_ativos');
  }
  if (a.vff) await sup0(db.url, `ALTER TABLE commerce_product_variants SET (fillfactor = ${Number(a.vff)})`);
  const role = `oria_app_poc_${crypto.randomBytes(4).toString('hex')}`;
  const senha = crypto.randomBytes(16).toString('hex');
  const sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role, senha, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  const appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, role, senha), { max: 8 });
  const fachada = runtime.criarPoolTenant(appPool);
  const leases = createJobLeases({ poolReal: appPool, dono: 'storage-poc' });

  const ORG = crypto.randomUUID();
  const STORE = crypto.randomUUID();
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG, 'POC']);
  await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [STORE, ORG, 'POC']);
  const alvo = { organizationId: ORG, storeId: STORE, provider: PROVIDER };
  const dentro = (fn) => runtime.comContexto({ organizationId: ORG, storeId: STORE, origem: 'storage-poc' }, fn);

  const rel = {
    rotulo, arm, sweep, dropidx: a.dropidx === '1', vff: a.vff || null, produtos: plano.length, variantes: totalVariantes, mix, skuMode, churn, geradoEm: new Date().toISOString(),
    pg: (await sup.query('select version() v')).rows[0].v, fases: [], tamanhos: {}, bench: {},
  };
  const guardarTamanhos = async (chave) => { rel.tamanhos[chave] = await tamanhos(sup); return rel.tamanhos[chave]; };

  await guardarTamanhos('vazio');

  // ── Carga 1 (primeiro full sync + bootstrap) ────────────────────────────────────────────────────
  const conector0 = conectorFalso({ plano, revisao: 0, churn, skuMode, nPedidos: 2000, org: ORG, store: STORE });
  const reg0 = registryComercio(conector0);
  const f1 = await fase('sync#1 (full sync, carga inicial)', sup, () => dentro(() => runCatalogSync(
    { pool: fachada, registry: reg0, leases, logger: semLog }, alvo, { variantSweep: sweep }
  )));
  rel.fases.push(f1);
  console.log(`✔ ${f1.nome}: ${(f1.ms / 1000).toFixed(1)}s · status=${f1.resultado.status} · WAL ${f1.walMB}MB · pg pico ${f1.postgresContainerPicoMB}MB`);
  if (f1.resultado.status !== 'success') throw new Error(`sync#1 não terminou com sucesso: ${f1.resultado.status}`);

  const b1 = await fase('bootstrap#1 (identities)', sup, () => dentro(() => bootstrapCommerceIdentities({ pool: fachada, variantIdentityMode: arm }, alvo)));
  rel.fases.push(b1);
  console.log(`✔ ${b1.nome}: ${(b1.ms / 1000).toFixed(1)}s · ${JSON.stringify(b1.resultado)} · WAL ${b1.walMB}MB · pg pico ${b1.postgresContainerPicoMB}MB`);
  await guardarTamanhos('apos_carga_1_sem_vacuum');

  const v1 = await fase('VACUUM (ANALYZE) após carga 1', sup, async () => { for (const t of ['commerce_products', 'commerce_product_variants', 'product_external_identities']) await sup.query(`VACUUM (ANALYZE) ${t}`); }, { medirPg: false });
  rel.fases.push(v1);
  await guardarTamanhos('apos_carga_1_estavel');

  if (a['load-only'] === '1') {
    // Só carrega e estabiliza (para forks: prune-poc.cjs, bench.cjs): sem 2º ciclo, sem benchmarks.
    rel.resumo = { apos_carga_1_estavel: rel.tamanhos.apos_carga_1_estavel._totalMB };
    const saidaLo = a.out || path.join(__dirname, 'results', `${rotulo}.json`);
    fs.mkdirSync(path.dirname(saidaLo), { recursive: true });
    fs.writeFileSync(saidaLo, JSON.stringify(rel, null, 2));
    console.log(`carga concluída (load-only): ${JSON.stringify(rel.resumo)}`);
    await appPool.end();
    await sup.query(`DROP OWNED BY ${role}`).catch(() => {});
    await sup.end();
    const adm = h.abrirPoolDescartavel(h.urlDoBanco().replace(/\/[^/]+$/, '/postgres'), { max: 1 });
    try { await adm.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {}); } finally { await adm.end(); }
    console.log(`→ ${saidaLo}`);
    return;
  }

  // ── Carga 2 (segundo ciclo: o que o scheduler fará em produção) ─────────────────────────────────
  const conector1 = conectorFalso({ plano, revisao: 1, churn, skuMode, nPedidos: 2000, org: ORG, store: STORE });
  const reg1 = registryComercio(conector1);
  const f2 = await fase('sync#2 (segundo full sync, churn)', sup, () => dentro(() => runCatalogSync(
    { pool: fachada, registry: reg1, leases, logger: semLog }, alvo, { variantSweep: sweep }
  )));
  rel.fases.push(f2);
  console.log(`✔ ${f2.nome}: ${(f2.ms / 1000).toFixed(1)}s · variantes atualizadas=${f2.resultado.variantsUpdated} · WAL ${f2.walMB}MB`);
  const b2 = await fase('bootstrap#2 (re-upsert das identities)', sup, () => dentro(() => bootstrapCommerceIdentities({ pool: fachada, variantIdentityMode: arm }, alvo)));
  rel.fases.push(b2);
  console.log(`✔ ${b2.nome}: ${(b2.ms / 1000).toFixed(1)}s · ${JSON.stringify(b2.resultado)} · WAL ${b2.walMB}MB · pg pico ${b2.postgresContainerPicoMB}MB`);
  await guardarTamanhos('apos_carga_2_pico_sem_vacuum');

  const v2 = await fase('VACUUM (ANALYZE) após carga 2', sup, async () => { for (const t of ['commerce_products', 'commerce_product_variants', 'product_external_identities']) await sup.query(`VACUUM (ANALYZE) ${t}`); }, { medirPg: false });
  rel.fases.push(v2);
  await guardarTamanhos('apos_carga_2_estavel');
  const { rows: st } = await sup.query(`SELECT relname, n_tup_ins, n_tup_upd, n_tup_hot_upd, n_tup_del, n_dead_tup FROM pg_stat_user_tables WHERE relname IN ('commerce_product_variants','product_external_identities','commerce_products')`);
  rel.estatisticasDeEscrita = st;

  // Ciclos extras (3, 4, …): o que o scheduler diário faz depois — cada um com VACUUM no fim, como o
  // autovacuum faria. Mostra se o tamanho ESTABILIZA (espaço morto reaproveitado) ou continua crescendo.
  const ciclos = Number(a.cycles) || 2;
  for (let c = 3; c <= ciclos; c += 1) {
    const conectorC = conectorFalso({ plano, revisao: c - 1, churn, skuMode, nPedidos: 2000, org: ORG, store: STORE });
    const regC = registryComercio(conectorC);
    const fs_ = await fase(`sync#${c}`, sup, () => dentro(() => runCatalogSync({ pool: fachada, registry: regC, leases, logger: semLog }, alvo, { variantSweep: sweep })));
    const bs_ = await fase(`bootstrap#${c}`, sup, () => dentro(() => bootstrapCommerceIdentities({ pool: fachada, variantIdentityMode: arm }, alvo)));
    rel.fases.push(fs_, bs_);
    await guardarTamanhos(`apos_carga_${c}_pico_sem_vacuum`);
    const vv = await fase(`VACUUM (ANALYZE) após carga ${c}`, sup, async () => { for (const t of ['commerce_products', 'commerce_product_variants', 'product_external_identities']) await sup.query(`VACUUM (ANALYZE) ${t}`); }, { medirPg: false });
    rel.fases.push(vv);
    await guardarTamanhos(`apos_carga_${c}_estavel`);
    console.log(`✔ ciclo ${c}: sync ${(fs_.ms / 1000).toFixed(1)}s WAL ${fs_.walMB}MB · bootstrap ${(bs_.ms / 1000).toFixed(1)}s WAL ${bs_.walMB}MB · total ${rel.tamanhos[`apos_carga_${c}_pico_sem_vacuum`]._totalMB}MB`);
  }

  // ── Benchmarks de leitura ───────────────────────────────────────────────────────────────────────
  if (rodarBench) {
    console.log('… benchmarks de resolução e serviços');
    const idsProduto = plano.map((_, i) => String(3900000 + i));
    const idsVariante20k = await coletarIdsDeVariante(plano, skuMode, 20000);
    const desconhecidos = Array.from({ length: 20000 }, (_, i) => String(900000000 + i));
    const pegar = (arr, n) => arr.slice(0, Math.min(n, arr.length));
    const misto = [...pegar(idsProduto, 12000), ...pegar(idsVariante20k, 6000), ...pegar(desconhecidos, 2000)];
    const rr = (ids) => () => dentro(() => resolveExternalIds({ pool: fachada, variantIdentityMode: arm }, { organizationId: ORG, storeId: STORE, namespace: 'bench.item_id', externalIds: ids }));
    rel.bench.resolver = {
      produto_5k: await medir(rr(pegar(idsProduto, 5000))),
      variante_5k: await medir(rr(pegar(idsVariante20k, 5000))),
      variante_20k: await medir(rr(idsVariante20k)),
      desconhecidos_20k: await medir(rr(desconhecidos)),
      misto_20k: await medir(rr(misto)),
    };
    // Corretude do bench: o que resolveu (mesmos números nos dois arms).
    const amostra = await rr(misto)();
    rel.bench.resolverAmostra = { resolved: amostra.resolved.length, conflicts: amostra.conflicts.length, unresolved: amostra.unresolved.length };

    const ga = registryAnalyticsFake(observados);
    const rf = registryFinal(reg1, ga.registry, ORG, STORE);
    const catalogRepository = createCommerceCatalogRepository({ pool: fachada });
    const pps = createProductPerformanceService({ pool: fachada, registry: rf, catalogRepository, variantIdentityMode: arm });
    const recon = createReconciliationService({ registry: rf, productPerformanceService: pps });
    const opp = createOpportunityDiagnosticsService({ productPerformanceService: pps, reconciliationService: recon, catalogRepository, analyticsProvider: ANALYTICS, commerceProvider: PROVIDER });
    const periodo = { startDate: '2026-09-01', endDate: '2026-09-20' };
    const base = { organizationId: ORG, storeId: STORE, analyticsProvider: ANALYTICS, ...periodo };

    const t = async (fn) => { const t0 = process.hrtime.bigint(); const out = await fn(); return { ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), out }; };
    const prep1 = await t(() => dentro(() => pps.prepareStoreAnalytics(base)));
    // 2ª chamada com cache de relatório vazio de novo (resolve tudo por existing_mapping agora).
    const prepAquecido = await medir(() => dentro(() => pps.prepareStoreAnalytics(base)), { aquecer: 1, vezes: 8 });
    const perf = await medir(() => dentro(() => pps.getProductPerformance({ ...base, pagination: { limit: 50 } })), { aquecer: 1, vezes: 8 });
    const reconciliacao = await medir(() => dentro(() => recon.reconcileProductPerformance({ ...base, commerceProvider: PROVIDER })), { aquecer: 1, vezes: 5 });
    const opFria = await t(() => dentro(() => opp.getOpportunities({ ...base, limit: 5 })));
    const opQuente = await medir(() => dentro(() => opp.getOpportunities({ ...base, limit: 5 })), { aquecer: 1, vezes: 6 });
    rel.bench.servicos = {
      prepareStoreAnalytics_primeira_chamada_ms: prep1.ms,
      prepareStoreAnalytics_coverage: prep1.out.coverage,
      prepareStoreAnalytics_com_identidades_persistidas: prepAquecido,
      getProductPerformance_pagina_50: perf,
      reconcileProductPerformance_2000_pedidos: reconciliacao,
      getOpportunities_primeira_chamada_ms: opFria.ms,
      getOpportunities_quente: opQuente,
    };
    console.log(`✔ bench: resolver misto_20k p50=${rel.bench.resolver.misto_20k.p50Ms}ms · prepare(1ª)=${prep1.ms}ms · opportunities quente p50=${opQuente.p50Ms}ms`);
    await guardarTamanhos('apos_bench'); // GA4 persistiu ~19k aliases
  }

  // ── Potencial de compactação (só possível aqui: no POC podemos reconstruir) ─────────────────────
  if (rodarCompactacao) {
    const ri = await fase('REINDEX das 3 tabelas', sup, async () => { for (const t of ['commerce_products', 'commerce_product_variants', 'product_external_identities']) await sup.query(`REINDEX TABLE ${t}`); }, { medirPg: false });
    rel.fases.push(ri);
    await guardarTamanhos('apos_reindex');
    const vf = await fase('VACUUM FULL das 3 tabelas', sup, async () => { for (const t of ['commerce_products', 'commerce_product_variants', 'product_external_identities']) await sup.query(`VACUUM FULL ${t}`); }, { medirPg: false });
    rel.fases.push(vf);
    await guardarTamanhos('apos_vacuum_full');
  }

  rel.resumo = {};
  for (const k of Object.keys(rel.tamanhos)) rel.resumo[k] = rel.tamanhos[k]._totalMB;

  const saida = a.out || path.join(__dirname, 'results', `${rotulo}.json`);
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, JSON.stringify(rel, null, 2));
  console.log(`\nresumo MB (3 tabelas, dados+índices): ${JSON.stringify(rel.resumo)}\n→ ${saida}`);

  await appPool.end();
  await sup.query(`DROP OWNED BY ${role}`).catch(() => {});
  await sup.end();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco().replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  try {
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    if (a.keep !== '1') await admin.query(`DROP DATABASE IF EXISTS ${db.nome} WITH (FORCE)`);
  } finally { await admin.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
