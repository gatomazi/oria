'use strict';

// Fase 5c · TD-006 / INV-18 — lease persistente dos jobs, com processos de verdade.
//
// Duas (ou três) réplicas do scheduler, cada uma um processo Node com o runner e o lease reais,
// contra o mesmo Postgres descartável e sob a role da aplicação:
//   - largando juntas, cada Organization roda uma vez e cada item sai exatamente uma vez;
//   - dentro do intervalo, ninguém repete a rodada;
//   - uma réplica que cai com lease e itens na mão não duplica nem perde nada: o lease vence, a
//     próxima réplica assume, e o que ficou em andamento vira "interrompido" (não reenviado às cegas);
//   - lease indisponível não roda o job (fail-closed);
//   - a ordem das Organizations gira a cada rodada (justiça simples).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { createJobRunner } = h.sujeito('lib/platform/jobs.js');
const { createJobLeases } = h.sujeito('lib/platform/leases.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const WORKER = path.join(h.RAIZ_REPO, 'test', 'helpers', 'lease-worker.cjs');
const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const ORGS = [
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000003',
];
const ROLE = `oria_app_lease_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const silencioso = { error() {} };

let db;
let sup;
let urlApp;

function replica(env) {
  return new Promise((resolve) => {
    const filho = spawn(process.execPath, [WORKER], {
      env: { PATH: process.env.PATH, NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'), DATABASE_URL: urlApp, ROOT: h.RAIZ_SUJEITO, ...env },
    });
    let out = '';
    let err = '';
    filho.stdout.on('data', (b) => { out += b; });
    filho.stderr.on('data', (b) => { err += b; });
    filho.on('exit', (code) => resolve({ code, resultado: out ? JSON.parse(out) : null, err }));
  });
}

async function semear(porOrg, orgs = ORGS) {
  await sup.query('TRUNCATE lease_probe, lease_probe_done, lease_runs RESTART IDENTITY');
  for (const org of orgs) {
    await sup.query(`INSERT INTO lease_probe (organization_id, status) SELECT $1, 'pending' FROM generate_series(1, $2)`, [org, porOrg]);
  }
}

const q = async (sql, params = []) => (await sup.query(sql, params)).rows;

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_lease');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  // Tabelas de prova, fora do manifesto: só existem neste banco descartável.
  await sup.query(`
    CREATE TABLE lease_probe (id SERIAL PRIMARY KEY, organization_id UUID NOT NULL, status TEXT NOT NULL,
                              claimed_by TEXT, claimed_until TIMESTAMPTZ);
    CREATE TABLE lease_probe_done (item_id INT NOT NULL, worker TEXT NOT NULL);
    CREATE TABLE lease_runs (organization_id UUID NOT NULL, worker TEXT NOT NULL, em TIMESTAMPTZ NOT NULL DEFAULT now());
    GRANT SELECT, INSERT, UPDATE ON lease_probe, lease_probe_done, lease_runs TO ${ROLE};
    GRANT USAGE ON SEQUENCE lease_probe_id_seq TO ${ROLE};
  `);
  urlApp = h.urlComUsuario(db.url, ROLE, SENHA_ROLE);
});

test.after(async () => {
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

test('INV-18 · duas réplicas largando juntas: cada Organization roda uma vez e cada item sai exatamente uma vez', async () => {
  await semear(20);
  const inicio = String(Date.now() + 800);
  const [a, b] = await Promise.all([
    replica({ JOB: 'probe-exclusivo', WORKER: 'r1', START_AT: inicio, INTERVALO_MS: '60000' }),
    replica({ JOB: 'probe-exclusivo', WORKER: 'r2', START_AT: inicio, INTERVALO_MS: '60000' }),
  ]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.equal(a.resultado.executadas + b.resultado.executadas, 3, JSON.stringify([a.resultado, b.resultado]));
  assert.equal(a.resultado.puladas + b.resultado.puladas, 3);
  assert.deepEqual(await q(`SELECT organization_id, count(*)::int AS n FROM lease_runs GROUP BY 1 ORDER BY 1`),
    ORGS.map((o) => ({ organization_id: o, n: 1 })));
  assert.deepEqual(await q(`SELECT count(*)::int AS n FROM lease_probe_done GROUP BY item_id HAVING count(*) > 1`), []);
  assert.deepEqual(await q(`SELECT status, count(*)::int AS n FROM lease_probe GROUP BY 1`), [{ status: 'done', n: 60 }]);
  const leases = await q(`SELECT organization_id, dono, proxima_em > now() AS aguardando FROM job_leases WHERE job = 'probe-exclusivo' ORDER BY 1`);
  assert.deepEqual(leases.map((l) => [l.organization_id, l.dono, l.aguardando]), ORGS.map((o) => [o, null, true]));
});

test('INV-18 · dentro do intervalo nenhuma réplica repete a rodada', async () => {
  await semear(2);
  const r = await replica({ JOB: 'probe-exclusivo', WORKER: 'r3', INTERVALO_MS: '60000' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.resultado, { organizacoes: 3, executadas: 0, puladas: 3, falhas: 0 });
  assert.deepEqual(await q(`SELECT count(*)::int AS n FROM lease_probe_done`), [{ n: 0 }]);
  // Passado o intervalo, roda de novo.
  await sup.query(`UPDATE job_leases SET proxima_em = now() - interval '1 second' WHERE job = 'probe-exclusivo'`);
  const depois = await replica({ JOB: 'probe-exclusivo', WORKER: 'r4', INTERVALO_MS: '60000' });
  assert.equal(depois.resultado.executadas, 3);
  assert.deepEqual(await q(`SELECT count(*)::int AS n FROM lease_probe_done`), [{ n: 6 }]);
});

test('INV-18 · réplica cai com lease e itens na mão: nada duplica, nada some', async () => {
  await semear(10);
  const caiu = await replica({ JOB: 'probe-queda', WORKER: 'r-caiu', CRASH: '1', TTL_MS: '1000' });
  assert.equal(caiu.code, 3, caiu.err);
  const [{ n: presos }] = await q(`SELECT count(*)::int AS n FROM lease_probe WHERE status = 'claimed'`);
  assert.ok(presos > 0, 'a réplica caiu sem reivindicar nada — o teste não prova nada');
  const [leaseAntes] = await q(`SELECT organization_id, dono FROM job_leases WHERE job = 'probe-queda' AND dono IS NOT NULL`);
  assert.equal(leaseAntes.dono, 'r-caiu');

  // Enquanto o lease vale, a Organization dele não roda em outra réplica.
  const cedo = await replica({ JOB: 'probe-queda', WORKER: 'r-cedo', RECOVER: '1' });
  assert.equal(cedo.resultado.puladas, 1, JSON.stringify(cedo.resultado));
  assert.equal(cedo.resultado.executadas, 2);

  await new Promise((r) => setTimeout(r, 1300));
  const depois = await replica({ JOB: 'probe-queda', WORKER: 'r-depois', RECOVER: '1' });
  assert.equal(depois.code, 0, depois.err);
  assert.ok(depois.resultado.executadas >= 1, JSON.stringify(depois.resultado));

  assert.deepEqual(await q(`SELECT count(*)::int AS n FROM lease_probe_done GROUP BY item_id HAVING count(*) > 1`), []);
  const estados = Object.fromEntries((await q(`SELECT status, count(*)::int AS n FROM lease_probe GROUP BY 1`)).map((r) => [r.status, r.n]));
  assert.deepEqual(estados, { done: 30 - presos, interrompido: presos }, 'todo item terminou enviado ou visivelmente interrompido');
  const [{ n: feitos }] = await q(`SELECT count(*)::int AS n FROM lease_probe_done`);
  assert.equal(feitos, 30 - presos);
  assert.deepEqual(await q(`SELECT count(*)::int AS n FROM lease_probe_done d JOIN lease_probe p ON p.id = d.item_id WHERE p.status = 'interrompido'`), [{ n: 0 }]);
});

test('INV-38 · lease indisponível: o job não roda e a falha aparece', async () => {
  const pool = h.abrirPoolDescartavel(urlApp, { max: 1 });
  try {
    const leases = { adquirir: async () => { throw new Error('banco fora'); }, concluir: async () => true };
    const erros = [];
    const jobs = createJobRunner({ poolReal: pool, leases, logger: { error: (m) => erros.push(m) } });
    let rodou = 0;
    const r = await jobs.executarPorOrganizacao('probe-falha', async () => { rodou += 1; });
    assert.deepEqual(r, { organizacoes: 3, executadas: 0, puladas: 0, falhas: 3 });
    assert.equal(rodou, 0);
    assert.equal(erros.length, 3);
    assert.match(erros[0], /lease indisponível/);
  } finally {
    await pool.end();
  }
});

test('lease · nome de job e dono validados; outro dono não libera o lease alheio', async () => {
  const pool = h.abrirPoolDescartavel(urlApp, { max: 1 });
  try {
    const l1 = createJobLeases({ poolReal: pool, dono: 'd1' });
    const l2 = createJobLeases({ poolReal: pool, dono: 'd2' });
    await assert.rejects(l1.adquirir('Job Inválido', ORGS[0], 1000), /nome de job inválido/);
    assert.equal(await l1.adquirir('probe-dono', ORGS[0], 60000), true);
    assert.equal(await l2.adquirir('probe-dono', ORGS[0], 60000), false);
    assert.equal(await l2.concluir('probe-dono', ORGS[0], 0), false, 'd2 não libera o lease de d1');
    assert.equal(await l2.adquirir('probe-dono', ORGS[0], 60000), false);
    assert.equal(await l1.concluir('probe-dono', ORGS[0], 0), true);
    assert.equal(await l2.adquirir('probe-dono', ORGS[0], 60000), true);
    // A role da aplicação não lê a tabela de leases diretamente.
    await assert.rejects(pool.query('SELECT * FROM job_leases'), /permission denied/);
  } finally {
    await pool.end();
  }
});

test('lease · liberarForcado (kill switch da tela) libera IGNORANDO o dono — ao contrário de concluir', async () => {
  const pool = h.abrirPoolDescartavel(urlApp, { max: 1 });
  try {
    const l1 = createJobLeases({ poolReal: pool, dono: 'processo-morto' });
    const l2 = createJobLeases({ poolReal: pool, dono: 'quem-cancela-pela-tela' });
    assert.equal(await l1.adquirir('probe-forcado', ORGS[0], 60000), true);
    // concluir de outro dono não libera (mesmo teste acima) — liberarForcado sim, sem precisar dizer quem é.
    assert.equal(await l2.concluir('probe-forcado', ORGS[0], 0), false);
    assert.equal(await l2.adquirir('probe-forcado', ORGS[0], 60000), false);
    assert.equal(await l2.liberarForcado('probe-forcado', ORGS[0]), true);
    assert.equal(await l2.adquirir('probe-forcado', ORGS[0], 60000), true);
    // Nada pra liberar (nunca foi adquirido, ou já expirou) é um no-op seguro — nunca erro.
    assert.equal(await l2.liberarForcado('probe-nunca-existiu', ORGS[0]), false);
  } finally {
    await pool.end();
  }
});

test('justiça · a ordem das Organizations gira a cada rodada', async () => {
  const pool = h.abrirPoolDescartavel(urlApp, { max: 1 });
  try {
    const jobs = createJobRunner({ poolReal: pool, logger: silencioso });
    const primeiras = [];
    for (let i = 0; i < 4; i += 1) {
      const vistas = [];
      await jobs.executarPorOrganizacao('probe-rodizio', async (org) => { vistas.push(org.organizationId); });
      primeiras.push(vistas[0]);
      assert.deepEqual([...vistas].sort(), ORGS);
    }
    assert.deepEqual(primeiras, [ORGS[0], ORGS[1], ORGS[2], ORGS[0]]);
  } finally {
    await pool.end();
  }
});

test('INV-18 · estático: o scheduler do painel é criado com lease e todo job tem nome aceito pelo lease', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  assert.match(fonte, /createJobRunner\(\{\s*poolReal: pgPoolReal,\s*leases: pgPoolReal \? require\('\.\/lib\/platform\/leases'\)\.createJobLeases/);
  const nomes = [...fonte.matchAll(/JOBS\.agendar(?:UmaVez)?\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(nomes.length >= 15, `só ${nomes.length} jobs encontrados`);
  for (const nome of nomes) assert.match(nome, /^[a-z0-9:_-]{1,80}$/, nome);
  assert.doesNotMatch(fonte, /setInterval\(\s*(async\s*)?\(\)\s*=>\s*(processar|sincronizar|registrar|persistir|reconcile)/, 'job fora do scheduler');
});
