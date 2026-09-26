'use strict';

// POC de armazenamento · Gate D. Mede, num FORK do banco da POC (nunca produção), como podar as
// identities mecânicas de variante e como desfazer — SÓ pelo caminho que a política do repositório
// permite (gate `no-unsafe-truncate`: nada de truncar tabela de tenant — atingiria todas as
// Organizations):
//
//   P1   DELETE em lotes, POR ORGANIZATION, + VACUUM         (o espaço só é reaproveitado, o arquivo não encolhe)
//   P1b  VACUUM FULL depois do DELETE (poucas linhas sobram, então é rápido) — devolve o espaço ao volume
//   P5   quanto tempo uma leitura de resolução concorrente espera durante o VACUUM FULL
//   P4   o sync/bootstrap seguinte NÃO recria as linhas (modo derived) — controle exigido pelo Gate D
//   P3   rollback: regenerar as linhas mecânicas com o bootstrap `materialized` e conferir o md5
//
//   node --expose-gc scripts/dev/storage-poc/prune-poc.cjs --source=oria_poc_mat_100k_usesul --confirm-poc-fork
//
// Só roda em bancos `oria_poc_*` da instância local e exige --confirm-poc-fork.

const path = require('node:path');
const fs = require('node:fs');
const {
  h, tamanhos, fase, crypto, URL_BASE,
} = require('./poc-lib.cjs');

const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { bootstrapCommerceIdentities, resolveExternalIds } = h.sujeito('lib/product-analytics/product-identity-resolver.js');

function lerArgs() {
  const a = {};
  for (const x of process.argv.slice(2)) { const m = /^--([^=]+)(?:=(.*))?$/.exec(x); if (m) a[m[1]] = m[2] === undefined ? '1' : m[2]; }
  return a;
}

async function fork(origem, destino) {
  const admin = h.abrirPoolDescartavel(URL_BASE.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${destino} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${destino} TEMPLATE ${origem}`);
  } finally { await admin.end(); }
  return URL_BASE.replace(/\/[^/]+$/, `/${destino}`);
}

const MECANICA = `source = 'commerce_sync' AND namespace LIKE '%.variant_id'`;

async function main() {
  const a = lerArgs();
  if (!a['confirm-poc-fork']) throw new Error('exige --confirm-poc-fork');
  if (!/^oria_poc_[a-z0-9_]+$/.test(a.source || '')) throw new Error('--source precisa ser um banco oria_poc_*');
  const relatorio = { fonte: a.source, geradoEm: new Date().toISOString(), experimentos: {} };
  const passo = 50000;
  const destino = 'oria_poc_prune_fork';

  const url = await fork(a.source, destino);
  const sup = h.abrirPoolDescartavel(url, { max: 6 });
  const { rows: [{ id: ORG }] } = await sup.query('SELECT id FROM organizations LIMIT 1');
  const { rows: [{ id: STORE }] } = await sup.query('SELECT id FROM stores WHERE organization_id = $1 LIMIT 1', [ORG]);
  const role = `oria_app_prune_${crypto.randomBytes(4).toString('hex')}`;
  const senha = crypto.randomBytes(16).toString('hex');
  for (const sql of sqlProvisionarAppRole({ role, senha, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  const appPool = h.abrirPoolDescartavel(h.urlComUsuario(url, role, senha), { max: 4 });
  const fachada = runtime.criarPoolTenant(appPool);
  const dentro = (fn) => runtime.comContexto({ organizationId: ORG, storeId: STORE, origem: 'prune-poc' }, fn);
  const alvo = { organizationId: ORG, storeId: STORE, provider: 'reserva_ink' };

  const antes = await tamanhos(sup);
  // md5 do conjunto mecânico ANTES: prova que o rollback regenera exatamente o mesmo.
  const { rows: [{ h: hashAntes }] } = await sup.query(`SELECT md5(string_agg(external_id || ':' || commerce_product_id::text, ',' ORDER BY external_id)) AS h FROM product_external_identities WHERE ${MECANICA}`);

  // ── P1: DELETE em lotes, por Organization ──────────────────────────────────────────────────────
  let lotes = 0;
  const f1 = await fase('P1 DELETE em lotes de 50k (por Organization)', sup, async () => {
    for (;;) {
      const r = await sup.query(
        `DELETE FROM product_external_identities WHERE organization_id = $1 AND id IN (SELECT id FROM product_external_identities WHERE organization_id = $1 AND ${MECANICA} LIMIT ${passo})`, [ORG]
      );
      lotes += 1;
      if (r.rowCount === 0) break;
    }
  });
  const logo = await tamanhos(sup);
  const v = await fase('P1 VACUUM (ANALYZE)', sup, () => sup.query('VACUUM (ANALYZE) product_external_identities'), { medirPg: false });
  const depoisVacuum = await tamanhos(sup);
  relatorio.experimentos.P1_delete_em_lotes = {
    lotes, delete: f1, vacuum: v, antesMB: antes.product_external_identities.totalMB, logoAposDeleteMB: logo.product_external_identities.totalMB,
    aposVacuumMB: depoisVacuum.product_external_identities.totalMB, linhasRestantes: depoisVacuum._linhasReais.identidades,
  };
  console.log(`P1: ${lotes} lotes · ${(f1.ms / 1000).toFixed(1)}s · WAL ${f1.walMB}MB · tabela ${antes.product_external_identities.totalMB}MB → ${logo.product_external_identities.totalMB}MB → (vacuum) ${depoisVacuum.product_external_identities.totalMB}MB — o arquivo NÃO encolhe`);

  // ── P1b + P5: VACUUM FULL com uma leitura de resolução concorrente ─────────────────────────────
  let esperaLeituraMs = null;
  let leitura;
  const f1b = await fase('P1b VACUUM FULL após o DELETE', sup, async () => {
    const t0 = process.hrtime.bigint();
    const cheio = sup.query('VACUUM FULL product_external_identities');
    await new Promise((r) => setTimeout(r, 30));
    leitura = dentro(() => resolveExternalIds({ pool: fachada, variantIdentityMode: 'derived' }, { organizationId: ORG, storeId: STORE, namespace: 'ga4.item_id', externalIds: ['3900001', '3900002'] }))
      .then(() => { esperaLeituraMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6); });
    await cheio;
    await leitura;
  }, { medirPg: false });
  const fim = await tamanhos(sup);
  relatorio.experimentos.P1b_vacuum_full_apos_delete = { fase: f1b, tabelaMB: fim.product_external_identities.totalMB };
  relatorio.experimentos.P5_espera_da_leitura_concorrente_ms = esperaLeituraMs;
  console.log(`P1b: VACUUM FULL ${(f1b.ms / 1000).toFixed(1)}s · WAL ${f1b.walMB}MB · tabela → ${fim.product_external_identities.totalMB}MB · leitura concorrente terminou após ${esperaLeituraMs}ms`);

  // ── P4: o bootstrap derived NÃO recria as linhas ────────────────────────────────────────────────
  const b = await fase('P4 bootstrap derived pós-poda', sup, () => dentro(() => bootstrapCommerceIdentities({ pool: fachada, variantIdentityMode: 'derived' }, alvo)));
  const p4 = await tamanhos(sup);
  relatorio.experimentos.P4_bootstrap_derived_apos_poda = { fase: b, linhasIdentidades: p4._linhasReais.identidades, tabelaMB: p4.product_external_identities.totalMB };
  console.log(`P4: bootstrap derived ${(b.ms / 1000).toFixed(1)}s · WAL ${b.walMB}MB · identidades=${p4._linhasReais.identidades} (não recriou)`);

  // ── P3: rollback = regenerar ────────────────────────────────────────────────────────────────────
  const rb = await fase('P3 rollback: bootstrap materialized regenera as linhas', sup, () => dentro(() => bootstrapCommerceIdentities({ pool: fachada, variantIdentityMode: 'materialized' }, alvo)));
  const p3 = await tamanhos(sup);
  const { rows: [{ h: hashDepois }] } = await sup.query(`SELECT md5(string_agg(external_id || ':' || commerce_product_id::text, ',' ORDER BY external_id)) AS h FROM product_external_identities WHERE ${MECANICA}`);
  relatorio.experimentos.P3_rollback_regenera = { fase: rb, identidades: p3._linhasReais.identidades, tabelaMB: p3.product_external_identities.totalMB, hashIdenticoAoOriginal: hashAntes === hashDepois };
  console.log(`P3: regenerou em ${(rb.ms / 1000).toFixed(1)}s · WAL ${rb.walMB}MB · identidades=${p3._linhasReais.identidades} · tabela ${p3.product_external_identities.totalMB}MB · hash idêntico ao original: ${hashAntes === hashDepois}`);

  await appPool.end();
  await sup.query(`DROP OWNED BY ${role}`).catch(() => {});
  await sup.end();
  const saida = path.join(__dirname, 'results', `prune-${a.source}.json`);
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, JSON.stringify(relatorio, null, 2));
  console.log(`→ ${saida}`);
  const admin = h.abrirPoolDescartavel(URL_BASE.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${destino} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
  } finally { await admin.end(); }
}

main().catch((e) => { console.error(e); process.exit(1); });
