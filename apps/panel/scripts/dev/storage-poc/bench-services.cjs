'use strict';

// POC de armazenamento · latência dos SERVIÇOS (prepareStoreAnalytics, getProductPerformance,
// reconcileProductPerformance, getOpportunities) sobre bancos já carregados por run.cjs --keep=1,
// comparando os modos de identidade de variante. Mesmo catálogo determinístico do gerador.
//
//   node --expose-gc scripts/dev/storage-poc/bench-services.cjs --db=oria_poc_mat_100k_usesul --modes=materialized,derived --products=105857 --mix=usesul

const path = require('node:path');
const fs = require('node:fs');
const { h, abrirBanco, crypto } = require('./poc-lib.cjs');
const { montarPlano, conectorFalso, idsObservadosGa4 } = require('./generator.cjs');

const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createConnectorRegistry } = h.sujeito('lib/connectors/registry.js');
const { createCommerceCatalogRepository } = h.sujeito('lib/product-analytics/commerce-catalog-repository.js');
const { createProductPerformanceService } = h.sujeito('lib/product-analytics/product-performance-service.js');
const { createReconciliationService } = h.sujeito('lib/product-analytics/reconciliation.js');
const { createOpportunityDiagnosticsService } = h.sujeito('lib/product-analytics/opportunity-diagnostics.js');

const PROVIDER = 'reserva_ink';
const ANALYTICS = 'ga4';

function lerArgs() {
  const a = {};
  for (const x of process.argv.slice(2)) { const m = /^--([^=]+)=(.*)$/.exec(x); if (m) a[m[1]] = m[2]; }
  return a;
}
const pct = (ms, p) => { const o = [...ms].sort((x, y) => x - y); return Math.round(o[Math.min(o.length - 1, Math.floor(p * o.length))]); };

function registryFinal(conector, linhas, org, store) {
  const r = createConnectorRegistry();
  r.register({
    domain: 'commerce', provider: PROVIDER, integrationProvider: PROVIDER, requiresStoreContext: true,
    capabilities: { products: false, variants: false, productsWithVariants: true, orders: true, refunds: false, productCosts: false },
    create: () => conector,
  });
  r.register({
    domain: 'analytics', provider: ANALYTICS, integrationProvider: ANALYTICS, requiresStoreContext: true,
    capabilities: { productMetrics: true, eventMetrics: false, realtime: false },
    create: () => ({ async getProductPerformance() { return linhas; }, async getCacheScope() { return null; } }),
  });
  return r;
}

async function main() {
  const a = lerArgs();
  const modos = (a.modes || 'materialized,derived').split(',');
  const rodadas = Number(a.rounds) || 8;
  const plano = montarPlano({ nProducts: Number(a.products), mix: a.mix || 'usesul' });
  const observados = idsObservadosGa4(plano);
  const linhas = observados.map((id, n) => ({
    externalProductId: id, externalProductName: `Produto ${id}`, itemsViewed: 50 + (n % 500), itemsAddedToCart: 5 + (n % 40),
    itemsCheckedOut: 2 + (n % 15), itemsPurchased: 1 + (n % 6), itemRevenue: 89.9 * (1 + (n % 6)), analyticsProvider: ANALYTICS,
  }));

  const { url } = await abrirBanco(a.db, { recriar: false });
  const sup = h.abrirPoolDescartavel(url, { max: 2 });
  const { rows: [{ id: ORG }] } = await sup.query('SELECT id FROM organizations LIMIT 1');
  const { rows: [{ id: STORE }] } = await sup.query('SELECT id FROM stores WHERE organization_id = $1 LIMIT 1', [ORG]);
  const role = `oria_app_bsv_${crypto.randomBytes(4).toString('hex')}`;
  const senha = crypto.randomBytes(16).toString('hex');
  for (const sql of sqlProvisionarAppRole({ role, senha, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  const real = h.abrirPoolDescartavel(h.urlComUsuario(url, role, senha), { max: 6 });
  const fachada = runtime.criarPoolTenant(real);
  const dentro = (fn) => runtime.comContexto({ organizationId: ORG, storeId: STORE, origem: 'bench-services' }, fn);
  const conector = conectorFalso({ plano, revisao: 1, nPedidos: 2000, org: ORG, store: STORE });
  const periodo = { startDate: '2026-09-01', endDate: '2026-09-20' };
  const base = { organizationId: ORG, storeId: STORE, analyticsProvider: ANALYTICS, ...periodo };

  const servicos = (modo) => {
    const rf = registryFinal(conector, linhas, ORG, STORE);
    const repo = createCommerceCatalogRepository({ pool: fachada });
    const pps = createProductPerformanceService({ pool: fachada, registry: rf, catalogRepository: repo, variantIdentityMode: modo });
    const recon = createReconciliationService({ registry: rf, productPerformanceService: pps });
    const opp = createOpportunityDiagnosticsService({ productPerformanceService: pps, reconciliationService: recon, catalogRepository: repo, analyticsProvider: ANALYTICS, commerceProvider: PROVIDER });
    return { pps, recon, opp };
  };
  const cenarios = {
    prepareStoreAnalytics: (s) => s.pps.prepareStoreAnalytics(base),
    getProductPerformance_pagina_50: (s) => s.pps.getProductPerformance({ ...base, pagination: { limit: 50 } }),
    reconcileProductPerformance_2000_pedidos: (s) => s.recon.reconcileProductPerformance({ ...base, commerceProvider: PROVIDER }),
    getOpportunities: (s) => s.opp.getOpportunities({ ...base, limit: 5 }),
  };

  const saida = { db: a.db, modos, rodadas, observados: observados.length, primeiraChamada: {}, quente: {} };
  // 1ª chamada por modo (persiste os aliases ga4.item_id se ainda não existem) — só a primeira DB/modo paga isso.
  const amostras = {};
  for (const modo of modos) {
    const t0 = process.hrtime.bigint();
    await dentro(() => cenarios.prepareStoreAnalytics(servicos(modo)));
    saida.primeiraChamada[modo] = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  for (let r = 0; r < rodadas + 1; r += 1) {
    for (const [nome, fn] of Object.entries(cenarios)) {
      for (const modo of modos) {
        const s = servicos(modo); // relatório GA4 sem cache: cada medida refaz a resolução
        const t0 = process.hrtime.bigint();
        await dentro(() => fn(s)); // eslint-disable-line no-await-in-loop
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (r >= 1) ((amostras[nome] ||= {})[modo] ||= []).push(ms);
      }
    }
  }
  for (const [nome, porModo] of Object.entries(amostras)) {
    saida.quente[nome] = Object.fromEntries(Object.entries(porModo).map(([m, ms]) => [m, { n: ms.length, minMs: pct(ms, 0), p50Ms: pct(ms, 0.5), p95Ms: pct(ms, 0.95), maxMs: pct(ms, 1) }]));
  }
  await real.end();
  await sup.query(`DROP OWNED BY ${role}`).catch(() => {});
  await sup.end();
  const adm = h.abrirPoolDescartavel(url.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  try { await adm.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {}); } finally { await adm.end(); }
  const p = a.out || path.join(__dirname, 'results', `bench-services-${a.db}-${modos.join('+')}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(saida, null, 2));
  console.log(JSON.stringify(saida, null, 1));
}

main().catch((e) => { console.error(e); process.exit(1); });
