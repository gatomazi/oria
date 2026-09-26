'use strict';
// Ensaio de rollback numa CÓPIA (banco oria_poc_*): regenera as identities espelho com o bootstrap `materialized`
// e imprime contagem/tempo/WAL. O hash do conjunto é conferido com scripts/ops/verify-mirror-equivalence.js.
const { h, fase, crypto, tamanhos } = require('./poc-lib.cjs');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { bootstrapCommerceIdentities } = h.sujeito('lib/product-analytics/product-identity-resolver.js');
(async () => {
  const db = process.argv[2];
  if (!/^oria_poc_[a-z0-9_]+$/.test(db || '')) throw new Error('banco precisa ser oria_poc_*');
  const base = process.env.INVARIANTS_DATABASE_URL.replace(/\/[^/]+$/, `/${db}`);
  const sup = h.abrirPoolDescartavel(base, { max: 2 });
  const { rows: [{ org, store }] } = await sup.query('SELECT o.id AS org, s.id AS store FROM organizations o JOIN stores s ON s.organization_id = o.id LIMIT 1');
  const role = `oria_app_rb_${crypto.randomBytes(4).toString('hex')}`; const senha = crypto.randomBytes(16).toString('hex');
  for (const sql of sqlProvisionarAppRole({ role, senha, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  const real = h.abrirPoolDescartavel(h.urlComUsuario(base, role, senha), { max: 4 });
  const fachada = runtime.criarPoolTenant(real);
  const f = await fase('rollback: bootstrap materialized', sup, () => runtime.comContexto({ organizationId: org, storeId: store, origem: 'rollback' }, () => bootstrapCommerceIdentities({ pool: fachada, variantIdentityMode: 'materialized' }, { organizationId: org, storeId: store, provider: 'reserva_ink' })));
  console.log(JSON.stringify({ ms: f.ms, walMB: f.walMB, resultado: f.resultado, tamanho: (await tamanhos(sup))._linhasReais.identidades }));
  await real.end(); await sup.query(`DROP OWNED BY ${role}`).catch(() => {}); await sup.end();
})().catch((e) => { console.error(e); process.exit(1); });
