'use strict';

// Fase 1 — INV-05, INV-06 e a coerência entre manifesto, código e documentação.
// (INV-04 e INV-07 estão em td001-rls-contract.test.js; os detectores têm negative control em
// tenancy-db-negative-controls.test.js.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const h = require('./harness');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const gates = h.sujeito('lib/platform/tenancy-gates.js');

let inspecao;
async function inspecionar() {
  if (!inspecao) {
    const banco = h.abrirPool();
    try { inspecao = await gates.inspecionarTenancy(banco, manifesto); } finally { await banco.end(); }
  }
  return inspecao;
}

test('INV-05 · toda UNIQUE/PK natural de tabela tenant-owned inclui organization_id (legadas declaradas)', async () => {
  assert.deepEqual((await inspecionar()).inv05, []);
});

test('PD-002 · uma Store ativa por Organization — garantido pelo banco, e o dado confere', async () => {
  assert.deepEqual((await inspecionar()).card1a1, []);
});

test('INV-05 · o manifesto não declara nenhuma UNIQUE global transitória', () => {
  assert.deepEqual(manifesto.TABELAS_TENANT.filter((x) => x.uniquesLegadas.length).map((x) => x.tabela), []);
});

test('INV-06 · nenhuma tabela tenant-owned é single-row', async () => {
  assert.deepEqual((await inspecionar()).inv06, []);
});

test('manifesto · 55 tabelas tenant-owned, uma regra cada, sem repetição', () => {
  const nomes = manifesto.nomesTenant();
  assert.equal(nomes.length, 55);
  assert.equal(new Set(nomes).size, nomes.length);
  for (const x of manifesto.TABELAS_TENANT) {
    assert.ok(manifesto.REGRAS.includes(x.regra), `${x.tabela}: regra ${x.regra}`);
    if (x.regra === 'pai') assert.ok(manifesto.porTabela(x.pai.tabela), `${x.tabela}: pai fora do manifesto`);
  }
  const legados = manifesto.TABELAS_TENANT.filter((x) => x.legado).map((x) => x.tabela).sort();
  assert.deepEqual(legados, [
    'origens_migration_city_uf_map', 'origens_migration_rules',
    'origens_migration_simulation_items', 'origens_migration_simulations',
  ]);
});

test('manifesto · LOJAS_LEGADAS é o mesmo enum que o server.js usa', () => {
  const server = fs.readFileSync(path.join(h.RAIZ_REPO, 'server.js'), 'utf8');
  const bloco = server.match(/^const LOJAS\s*=\s*\{([^}]*)\}/m);
  assert.ok(bloco, 'const LOJAS não encontrado no server.js');
  const chaves = [...bloco[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  assert.deepEqual(chaves, [...manifesto.LOJAS_LEGADAS]);
});

test('manifesto · docs/produtizacao-saas/tenant-owned-tables.md está gerado a partir do manifesto', () => {
  const r = spawnSync(process.execPath, [path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'gerar-manifesto.mjs'), '--check'], {
    cwd: h.RAIZ_REPO, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `documento desatualizado — rode node scripts/tenancy/gerar-manifesto.mjs\n${r.stdout}${r.stderr}`);
});
