'use strict';

// POC de armazenamento · infraestrutura de medição. NUNCA aponta para produção: exige que o banco
// se chame `oria_poc_*` e que a instância seja a local (127.0.0.1) — qualquer outra coisa aborta.

const path = require('node:path');
const crypto = require('node:crypto');
const { exec } = require('node:child_process');
const { promisify } = require('node:util');

const execAsync = promisify(exec);
const RAIZ = path.resolve(__dirname, '..', '..', '..');
const h = require(path.join(RAIZ, 'test/invariants/harness.js'));

const CONTAINER = process.env.POC_PG_CONTAINER || 'oria-storage-poc-pg';
const URL_BASE = process.env.INVARIANTS_DATABASE_URL || 'postgres://postgres:poc@127.0.0.1:55432/oria_poc';
if (!process.env.INVARIANTS_DATABASE_URL) process.env.INVARIANTS_DATABASE_URL = URL_BASE;

function garantirLocal(url) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error(`POC só roda em Postgres local (recebi ${u.hostname})`);
}
garantirLocal(URL_BASE);

const TABELAS = ['commerce_product_variants', 'product_external_identities', 'commerce_products'];

const mb = (b) => Math.round((Number(b) / 1048576) * 10) / 10;

async function tamanhos(pool) {
  const { rows: tabelas } = await pool.query(
    `SELECT c.relname AS tabela, c.oid, pg_relation_size(c.oid) AS heap, pg_indexes_size(c.oid) AS indices,
            pg_total_relation_size(c.oid) AS total, (SELECT reltuples::bigint FROM pg_class WHERE oid = c.oid) AS linhas_est
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [TABELAS]
  );
  const out = {};
  for (const t of tabelas) {
    const { rows: idx } = await pool.query(
      `SELECT indexrelid::regclass::text AS nome, pg_relation_size(indexrelid) AS bytes FROM pg_index WHERE indrelid = $1 ORDER BY bytes DESC`,
      [t.oid]
    );
    out[t.tabela] = {
      heapMB: mb(t.heap), indicesMB: mb(t.indices), totalMB: mb(t.total), linhasEst: Number(t.linhas_est),
      indexesMB: Object.fromEntries(idx.map((i) => [i.nome, mb(i.bytes)])),
    };
  }
  const { rows: [{ n }] } = await pool.query(`SELECT count(*)::bigint AS n FROM product_external_identities`);
  const { rows: [{ v }] } = await pool.query(`SELECT count(*)::bigint AS v FROM commerce_product_variants`);
  const { rows: porNs } = await pool.query(`SELECT namespace, source, count(*)::bigint AS n FROM product_external_identities GROUP BY 1, 2 ORDER BY 3 DESC`);
  out._linhasReais = { identidades: Number(n), variantes: Number(v), identidadesPorNamespace: porNs.map((r) => ({ namespace: r.namespace, source: r.source, n: Number(r.n) })) };
  out._totalMB = Math.round(TABELAS.reduce((a, t) => a + (out[t]?.totalMB || 0), 0) * 10) / 10;
  return out;
}

async function wal(pool) {
  const { rows: [r] } = await pool.query(`SELECT pg_current_wal_lsn()::text AS lsn, w.wal_records::bigint AS rec, w.wal_fpi::bigint AS fpi, w.wal_bytes::numeric AS bytes FROM pg_stat_wal w`);
  return { lsn: r.lsn, rec: Number(r.rec), fpi: Number(r.fpi), bytes: Number(r.bytes) };
}

// Amostra a memória do container do Postgres (docker stats) enquanto a fase roda.
function amostrarMemoriaPg() {
  let pico = 0;
  let vivo = true;
  const laco = (async () => {
    while (vivo) {
      try {
        const { stdout } = await execAsync(`docker stats --no-stream --format '{{.MemUsage}}' ${CONTAINER}`);
        const m = /([\d.]+)\s*(MiB|GiB|KiB)/.exec(stdout);
        if (m) {
          const v = Number(m[1]) * ({ KiB: 1 / 1024, MiB: 1, GiB: 1024 }[m[2]]);
          if (v > pico) pico = v;
        }
      } catch { /* docker ocupado: ignora a amostra */ }
    }
  })();
  return { parar: async () => { vivo = false; await laco; return Math.round(pico); } };
}

/**
 * Executa `fn` medindo tempo, WAL (bytes/registros/full-page images), pico de heap do Node e pico de
 * memória do container do Postgres.
 */
async function fase(nome, sup, fn, { medirPg = true } = {}) {
  if (global.gc) global.gc();
  const w0 = await wal(sup);
  const memAntes = process.memoryUsage();
  let picoHeap = memAntes.heapUsed;
  let picoRss = memAntes.rss;
  const amostra = setInterval(() => {
    const m = process.memoryUsage();
    if (m.heapUsed > picoHeap) picoHeap = m.heapUsed;
    if (m.rss > picoRss) picoRss = m.rss;
  }, 50);
  const pg = medirPg ? amostrarMemoriaPg() : null;
  const t0 = process.hrtime.bigint();
  let resultado;
  try { resultado = await fn(); } finally { clearInterval(amostra); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const picoPgMB = pg ? await pg.parar() : null;
  const w1 = await wal(sup);
  const { rows: [{ diff }] } = await sup.query(`SELECT pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint AS diff`, [w1.lsn, w0.lsn]);
  return {
    nome, ms: Math.round(ms), resultado,
    walMB: mb(diff), walRegistros: w1.rec - w0.rec, walFullPageImages: w1.fpi - w0.fpi,
    nodeHeapPicoMB: mb(picoHeap), nodeRssPicoMB: mb(picoRss), postgresContainerPicoMB: picoPgMB,
  };
}

async function abrirBanco(nomeBanco, { recriar = true } = {}) {
  if (!/^oria_poc_[a-z0-9_]+$/.test(nomeBanco)) throw new Error(`nome de banco fora do padrão oria_poc_*: ${nomeBanco}`);
  const base = h.abrirPoolDescartavel(URL_BASE.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  if (recriar) await base.query(`DROP DATABASE IF EXISTS ${nomeBanco} WITH (FORCE)`);
  const { rows } = await base.query('SELECT 1 FROM pg_database WHERE datname = $1', [nomeBanco]);
  if (!rows.length) await base.query(`CREATE DATABASE ${nomeBanco}`);
  await base.end();
  const url = URL_BASE.replace(/\/[^/]+$/, `/${nomeBanco}`);
  return { nome: nomeBanco, url };
}

module.exports = { h, RAIZ, URL_BASE, CONTAINER, TABELAS, mb, tamanhos, wal, fase, abrirBanco, crypto, execAsync };
