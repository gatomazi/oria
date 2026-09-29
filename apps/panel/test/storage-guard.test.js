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

function loggerMudo() { return { warn() {}, error() {}, log() {} }; }

test('podeIniciarEscritaPesada: volume saudável e em aviso liberam; só o crítico (> 80 %) nega', async () => {
  const saudavel = poolFalso([[/pg_database_size/, [{ bytes: String(10 * GB) }]], [/pg_ls_waldir/, [{ bytes: String(0.5 * GB) }]]]);
  const emAviso = poolFalso([[/pg_database_size/, [{ bytes: String(13.5 * GB) }]], [/pg_ls_waldir/, [{ bytes: String(0.3 * GB) }]]]);
  const critico = poolFalso([[/pg_database_size/, [{ bytes: String(15 * GB) }]], [/pg_ls_waldir/, [{ bytes: String(1 * GB) }]]]);
  const de = (pool) => createStorageGuard({ pool, logger: loggerMudo(), capacidadeBytes: 19 * GB }).podeIniciarEscritaPesada();
  assert.equal((await de(saudavel)).permitido, true);
  const aviso = await de(emAviso);
  assert.equal(aviso.permitido, true);
  assert.equal(aviso.nivel, 'aviso');
  const negado = await de(critico);
  assert.equal(negado.permitido, false);
  assert.equal(negado.nivel, 'critico');
  assert.match(negado.motivo, /uso do volume/);
});

test('podeIniciarEscritaPesada: o mesmo vigia libera de novo depois que o volume normaliza', async () => {
  let bytes = 15 * GB;
  const pool = { query: async (sql) => (/pg_database_size/.test(sql) ? { rows: [{ bytes: String(bytes) }] } : { rows: [{ bytes: String(0.5 * GB) }] }) };
  const guard = createStorageGuard({ pool, logger: loggerMudo(), capacidadeBytes: 19 * GB });
  assert.equal((await guard.podeIniciarEscritaPesada()).permitido, false);
  bytes = 8 * GB;
  assert.equal((await guard.podeIniciarEscritaPesada()).permitido, true);
});

test('podeIniciarEscritaPesada: sem capacidade configurada libera sem consultar o banco e avisa que falta a variável', async () => {
  const linhas = [];
  const logger = { warn: (m) => linhas.push(m), error: (m) => linhas.push(m), log: (m) => linhas.push(m) };
  const pool = { query: async () => { throw new Error('não deveria consultar o banco'); } };
  const r = await createStorageGuard({ pool, logger, capacidadeBytes: 0 }).podeIniciarEscritaPesada();
  assert.equal(r.permitido, true);
  assert.equal(r.nivel, 'sem_capacidade');
  assert.match(linhas.join('\n'), /PG_VOLUME_CAPACITY_GB não configurada/);
});

test('podeIniciarEscritaPesada: falha ao ler o tamanho do banco libera e registra o motivo', async () => {
  const avisos = [];
  const logger = { warn: (m) => avisos.push(m), error() {}, log() {} };
  const pool = poolFalso([[/pg_database_size/, new Error('connection refused')]]);
  const r = await createStorageGuard({ pool, logger, capacidadeBytes: 19 * GB }).podeIniciarEscritaPesada();
  assert.equal(r.permitido, true);
  assert.equal(r.nivel, 'desconhecido');
  assert.match(avisos[0], /não foi possível medir o volume \(connection refused\)/);
});
