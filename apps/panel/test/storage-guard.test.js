'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { avaliarArmazenamento, createStorageGuard } = require('../lib/platform/storage-guard');

const GB = 1024 ** 3;

test('limiares: aviso > 70 %, crítico > 80 %, WAL alto', () => {
  assert.equal(avaliarArmazenamento({ dbBytes: 10 * GB, walBytes: 0.5 * GB, capacidadeBytes: 19 * GB }).nivel, 'ok');
  const aviso = avaliarArmazenamento({ dbBytes: 13.5 * GB, walBytes: 0.3 * GB, capacidadeBytes: 19 * GB });
  assert.equal(aviso.nivel, 'aviso');
  assert.equal(avaliarArmazenamento({ dbBytes: 15 * GB, walBytes: 1 * GB, capacidadeBytes: 19 * GB }).nivel, 'critico');
  const wal = avaliarArmazenamento({ dbBytes: 1 * GB, walBytes: 2 * GB, capacidadeBytes: 19 * GB });
  assert.equal(wal.nivel, 'aviso');
  assert.match(wal.alertas[0], /pg_wal/);
  assert.equal(avaliarArmazenamento({ dbBytes: 99 * GB, capacidadeBytes: 0 }).nivel, 'ok'); // sem capacidade configurada não inventa %
});

function poolFalso(respostas) {
  return { query: async (sql) => { for (const [re, rows] of respostas) { if (re.test(sql)) { if (rows instanceof Error) throw rows; return { rows }; } } throw new Error(`sql inesperado: ${sql}`); } };
}

test('verificarVolume: loga crítico e usa o teto do WAL quando a role não lê pg_ls_waldir', async () => {
  const linhas = { warn: [], error: [], log: [] };
  const logger = { warn: (m) => linhas.warn.push(m), error: (m) => linhas.error.push(m), log: (m) => linhas.log.push(m) };
  const pool = poolFalso([[/pg_database_size/, [{ bytes: String(15 * GB) }]], [/pg_ls_waldir/, new Error('permission denied')], [/pg_settings/, [{ bytes: String(1 * GB) }]]]);
  const r = await createStorageGuard({ pool, logger, capacidadeBytes: 19 * GB }).verificarVolume();
  assert.equal(r.nivel, 'critico');
  assert.equal(linhas.error.length, 1);
  assert.match(linhas.error[0], /wal=1\.00GB\(teto\)/);
});

test('verificarTenant: identity espelho só alerta no modo derived; órfãos sempre', async () => {
  const avisos = [];
  const logger = { warn: (m) => avisos.push(m), error() {}, log() {} };
  const pool = poolFalso([[/namespace LIKE/, [{ n: 4 }]], [/status = 'running'/, [{ n: 2 }]]]);
  const materialized = await createStorageGuard({ pool, logger, modoVariante: 'materialized' }).verificarTenant();
  assert.equal(materialized.espelho, null);
  assert.equal(materialized.alertas.length, 1);
  const derived = await createStorageGuard({ pool, logger, modoVariante: 'derived' }).verificarTenant();
  assert.equal(derived.espelho, 4);
  assert.equal(derived.alertas.length, 2);
});
