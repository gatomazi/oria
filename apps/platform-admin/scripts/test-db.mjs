#!/usr/bin/env node
// Postgres EFÊMERO para os testes do control plane.
//
// Mesma ideia do `apps/panel/scripts/test-db.mjs` (e os comentários de lá valem aqui), com duas
// diferenças deliberadas:
//
//   1. **Container próprio** (`oria-pa-test` por padrão): rodar a suíte do Admin não derruba o
//      banco de teste do painel, e vice-versa.
//   2. **SEM o mapeamento de tenancy do painel.** O harness do painel semeia três Organizations
//      (cenário A). O control plane precisa do contrário: um banco com **zero Organizations**, para
//      poder exercitar o gate de bootstrap do Tenant #1. Semear organizações aqui tornaria esse
//      teste impossível de escrever — e o teste é a prova de que o gate existe.
//
// As migrations vêm de `apps/panel/migrations`: o painel é o dono do schema. Este script as aplica
// com o node-pg-migrate que já está instalado lá.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAINEL = path.resolve(RAIZ, '..', 'panel');
const CONTAINER = process.env.TEST_PG_CONTAINER || 'oria-pa-test';
const IMAGEM = process.env.TEST_PG_IMAGE || 'postgres:16-alpine';
const SENHA = 'teste';
const BANCO = 'oria_admin_test';

const sh = (cmd, args, opcoes = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opcoes });
const docker = (...args) => sh('docker', args);

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function urlDoContainer() {
  const r = docker('port', CONTAINER, '5432/tcp');
  if (r.status !== 0) return null;
  const porta = (r.stdout || '').trim().split('\n')[0]?.split(':').pop();
  return porta ? `postgres://postgres:${SENHA}@127.0.0.1:${porta}/${BANCO}` : null;
}

function containerEmPe() {
  const r = docker('inspect', '-f', '{{.State.Running}}', CONTAINER);
  return r.status === 0 && (r.stdout || '').trim() === 'true';
}

async function esperarPronto(porta, limiteMs = 60000) {
  const ate = Date.now() + limiteMs;
  for (;;) {
    const r = docker('exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-d', BANCO, '-q');
    if (r.status === 0) break;
    if (!containerEmPe()) throw new Error('o container do Postgres de teste morreu durante a subida');
    if (Date.now() > ate) throw new Error(`Postgres de teste não ficou pronto em ${limiteMs}ms`);
    await new Promise((r2) => setTimeout(r2, 300));
  }
  const url = `postgres://postgres:${SENHA}@127.0.0.1:${porta}/${BANCO}`;
  for (;;) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch {
      await client.end().catch(() => {});
    }
    if (Date.now() > ate) throw new Error(`Postgres não respondeu pela porta ${porta} a partir do host`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
}

function aplicarMigrations(url) {
  const cli = path.join(PAINEL, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js');
  if (!fs.existsSync(cli)) {
    throw new Error(`node-pg-migrate não encontrado em ${cli} — rode \`npm --prefix ${PAINEL} ci\` antes`);
  }
  const r = sh(process.execPath, [
    cli,
    '--migrations-dir', path.join(PAINEL, 'migrations'),
    '--ignore-pattern', '(README\\.md|sql|sql/.*)',
    'up',
  ], { cwd: PAINEL, env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('migrations falharam no banco de teste');
}

async function start() {
  if (process.env.TEST_DATABASE_URL) {
    aplicarMigrations(process.env.TEST_DATABASE_URL);
    return process.env.TEST_DATABASE_URL;
  }
  if (containerEmPe()) {
    const url = urlDoContainer();
    aplicarMigrations(url);
    return url;
  }
  docker('rm', '-f', CONTAINER);
  const porta = await portaLivre();
  const r = docker(
    'run', '-d', '--rm',
    '--name', CONTAINER,
    '-e', `POSTGRES_PASSWORD=${SENHA}`,
    '-e', `POSTGRES_DB=${BANCO}`,
    '-p', `127.0.0.1:${porta}:5432`,
    IMAGEM,
    '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off'
  );
  if (r.status !== 0) throw new Error(`docker run falhou: ${r.stderr || r.stdout}`);
  await esperarPronto(porta);
  const url = `postgres://postgres:${SENHA}@127.0.0.1:${porta}/${BANCO}`;
  aplicarMigrations(url);
  return url;
}

function stop() {
  if (process.env.TEST_DATABASE_URL) return;
  docker('rm', '-f', CONTAINER);
}

async function main() {
  const [comando, ...resto] = process.argv.slice(2);
  if (comando === 'stop') { stop(); return 0; }
  if (comando === 'url') {
    const url = process.env.TEST_DATABASE_URL || urlDoContainer();
    if (!url) { console.error('nenhum banco de teste em pé'); return 1; }
    console.log(url);
    return 0;
  }
  if (comando === 'start') {
    console.log(await start());
    return 0;
  }
  if (comando === 'run') {
    const argv = resto[0] === '--' ? resto.slice(1) : resto;
    if (!argv.length) { console.error('uso: test-db.mjs run -- <comando>'); return 2; }
    const url = await start();
    const filho = spawn(argv[0], argv.slice(1), {
      cwd: RAIZ,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      // Cada arquivo de teste cria o SEU banco a partir deste (template), para não disputar estado.
      env: { ...process.env, ADMIN_TEST_DATABASE_URL: url },
    });
    const code = await new Promise((resolve) => filho.on('exit', (c) => resolve(c ?? 1)));
    if (!process.env.TEST_PG_KEEP) stop();
    return code;
  }
  console.error('comandos: start | stop | url | run -- <comando>');
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => { console.error(`[test-db] ${err.message}`); stop(); process.exit(1); }
);
