'use strict';

// Réplica de teste do scheduler (Fase 5c · INV-18). Roda UMA rodada de um job contra o banco de
// teste, com o runner e o lease reais (lib/ da raiz do sujeito), e imprime o resultado em JSON.
//
// env: DATABASE_URL (role da aplicação), ROOT, JOB, WORKER, START_AT (ms, barreira de largada),
//      INTERVALO_MS, TTL_MS, CRASH=1 (cai depois de reivindicar o primeiro lote), RECOVER=1
//      (marca como interrompido o que ficou reivindicado por réplica que caiu).

const path = require('node:path');
const pg = require('pg');

const root = process.env.ROOT;
const { createJobRunner } = require(path.join(root, 'lib/platform/jobs.js'));
const { createJobLeases } = require(path.join(root, 'lib/platform/leases.js'));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const worker = process.env.WORKER;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function processar(org) {
  const id = org.organizationId;
  if (process.env.RECOVER === '1') {
    await pool.query(
      `UPDATE lease_probe SET status = 'interrompido' WHERE organization_id = $1 AND status = 'claimed' AND claimed_until < now()`, [id]
    );
  }
  for (;;) {
    const { rows } = await pool.query(
      `WITH l AS (
         SELECT id FROM lease_probe WHERE organization_id = $1 AND status = 'pending' ORDER BY id LIMIT 3 FOR UPDATE SKIP LOCKED
       )
       UPDATE lease_probe p SET status = 'claimed', claimed_by = $2, claimed_until = now() + interval '1 second'
         FROM l WHERE p.id = l.id RETURNING p.id`,
      [id, worker]
    );
    if (!rows.length) break;
    if (process.env.CRASH === '1') process.exit(3);
    for (const r of rows) {
      await dormir(5);
      await pool.query('INSERT INTO lease_probe_done (item_id, worker) VALUES ($1, $2)', [r.id, worker]);
      await pool.query(`UPDATE lease_probe SET status = 'done' WHERE id = $1`, [r.id]);
    }
  }
  await pool.query('INSERT INTO lease_runs (organization_id, worker) VALUES ($1, $2)', [id, worker]);
}

(async () => {
  const jobs = createJobRunner({ poolReal: pool, leases: createJobLeases({ poolReal: pool, dono: worker }), logger: { error() {} } });
  const inicio = Number(process.env.START_AT || 0);
  if (inicio > Date.now()) await dormir(inicio - Date.now());
  const opcoes = { intervaloMs: Number(process.env.INTERVALO_MS || 0) };
  if (process.env.TTL_MS) opcoes.ttlMs = Number(process.env.TTL_MS);
  const r = await jobs.executarPorOrganizacao(process.env.JOB, processar, opcoes);
  process.stdout.write(JSON.stringify(r));
  await pool.end();
})().catch((err) => {
  process.stderr.write(String(err && err.stack));
  process.exit(1);
});
