#!/usr/bin/env node
'use strict';

// Postgres EFÊMERO para testes e CI, com todas as migrations rodando do zero.
//
// Por que isto existe: até `8a7ea3d` havia 6 testes que se auto-pulavam por falta de
// `*_TEST_DATABASE_URL` — incluindo `creative-core-pg.test.js`, o único teste de isolamento por
// tenant do repositório. Um teste que se pula sozinho é indistinguível de um teste que passa, e
// esse é exatamente o modo de falha que o plano de productização chama de "silêncio".
//
// Uso:
//   node scripts/test-db.mjs start            # sobe o banco, roda migrations, imprime a URL
//   node scripts/test-db.mjs stop             # derruba
//   node scripts/test-db.mjs url              # imprime a URL do banco em pé
//   node scripts/test-db.mjs run -- npm test  # sobe, roda o comando com o env certo, derruba
//
// Em CI com Postgres de serviço, defina TEST_DATABASE_URL: o Docker é ignorado e o script só
// aplica as migrations e roda o comando.

import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createRequire } from 'node:module';
import { aplicarMapeamento } from './tenancy/aplicar-mapeamento.mjs';

const require = createRequire(import.meta.url);
const { sqlProvisionarAppRole } = require('../lib/platform/app-role.js');
const tenancyManifesto = require('../lib/platform/tenancy-manifest.js');

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTAINER = process.env.TEST_PG_CONTAINER || 'oria-test-pg';
const IMAGEM = process.env.TEST_PG_IMAGE || 'postgres:16-alpine';
const SENHA = 'teste';
const BANCO = 'oria_test';
// Role da aplicação em CI (TD-001): sem SUPERUSER, sem BYPASSRLS, não dona. Senha só de teste.
const APP_ROLE = 'oria_app';
const APP_SENHA = 'oria_app_teste_local';
// Mapeamento explícito do banco compartilhado: cenário A de PD-019 (três Organizations).
const MAPEAMENTO_DE_TESTE = path.join(RAIZ, 'test', 'fixtures', 'tenancy', 'cenario-a.json');

function sh(cmd, args, opcoes = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opcoes });
}

function docker(...args) {
  return sh('docker', args);
}

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
  if (!porta) return null;
  return `postgres://postgres:${SENHA}@127.0.0.1:${porta}/${BANCO}`;
}

function containerEmPe() {
  const r = docker('inspect', '-f', '{{.State.Running}}', CONTAINER);
  return r.status === 0 && (r.stdout || '').trim() === 'true';
}

// Duas verificações, e as duas são necessárias — e as duas precisam ser por TCP.
//
// Na primeira subida, o entrypoint da imagem roda um Postgres TEMPORÁRIO só em socket Unix para o
// init, derruba e sobe o definitivo. `pg_isready` sem `-h` responde "pronto" para o temporário, e
// migrar nesse intervalo dá "Connection terminated unexpectedly" (medido). Com `-h 127.0.0.1`, só o
// definitivo responde.
//
// Do lado do host, conectar no socket não basta: o docker-proxy aceita TCP mesmo sem nada atrás.
// Por isso a segunda verificação é um `SELECT 1` de verdade, pela porta publicada.
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
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
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

// Depois das migrations: o banco de teste precisa do mesmo que produção terá antes de receber
// tráfego — dono declarado para o que o código grava e a role com que a aplicação conecta.
async function prepararTenancy(url) {
  await aplicarMapeamento(url, MAPEAMENTO_DE_TESTE, { creativeTenant: 'default' });
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    for (const sql of sqlProvisionarAppRole({
      role: APP_ROLE, senha: APP_SENHA, tabelasSobRls: tenancyManifesto.nomesSobRls(),
    })) await client.query(sql);
  } finally {
    await client.end();
  }
}

function urlDaAplicacao(url) {
  const u = new URL(url);
  u.username = APP_ROLE;
  u.password = APP_SENHA;
  return u.toString();
}

async function prontoParaTestes(url) {
  aplicarMigrations(url);
  await prepararTenancy(url);
  return url;
}

async function start() {
  if (process.env.TEST_DATABASE_URL) return prontoParaTestes(process.env.TEST_DATABASE_URL);

  if (containerEmPe()) return prontoParaTestes(urlDoContainer());

  docker('rm', '-f', CONTAINER);
  const porta = await portaLivre();
  const r = docker(
    'run', '-d', '--rm',
    '--name', CONTAINER,
    '-e', `POSTGRES_PASSWORD=${SENHA}`,
    '-e', `POSTGRES_DB=${BANCO}`,
    '-p', `127.0.0.1:${porta}:5432`,
    IMAGEM,
    // fsync off: é um banco descartável, e o custo de durabilidade aqui é só lentidão no CI.
    '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off'
  );
  if (r.status !== 0) throw new Error(`docker run falhou: ${r.stderr || r.stdout}`);

  await esperarPronto(porta);
  return prontoParaTestes(`postgres://postgres:${SENHA}@127.0.0.1:${porta}/${BANCO}`);
}

function aplicarMigrations(url) {
  const r = sh(
    process.execPath,
    [path.join(RAIZ, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js'),
      '--migrations-dir', path.join(RAIZ, 'migrations'),
      // README.md e sql/ moram junto das migrations de propósito (o SQL do baseline é revisável
      // como SQL); o carregador do node-pg-migrate exige que sejam ignorados explicitamente.
      '--ignore-pattern', '(README\\.md|sql|sql/.*)',
      'up'],
    { cwd: RAIZ, env: { ...process.env, DATABASE_URL: url }, stdio: 'inherit' }
  );
  if (r.status !== 0) throw new Error('migrations falharam no banco de teste');
}

function stop() {
  if (process.env.TEST_DATABASE_URL) return;
  docker('rm', '-f', CONTAINER);
}

// As quatro variáveis que os testes existentes esperam apontam para o MESMO banco efêmero. Elas
// nasceram separadas porque cada teste subia seu próprio container à mão; com um banco só, todo o
// schema vem das migrations e nenhum teste se pula.
//
// TEST_APP_ROLE=1 (`npm run test:app-role`, §36 da rodada 18): as variáveis que os testes entregam
// ao CÓDIGO DA APLICAÇÃO passam a ser da role oria_app (NOSUPERUSER, NOBYPASSRLS, não dona), com
// DB_ENFORCE_APP_ROLE=1. Continuam donas, por declaração (test/invariants/app-role-suite.test.js):
//   INVARIANTS_DATABASE_URL / TEST_OWNER_DATABASE_URL  fixture e DDL (banco descartável, role, seed)
//                                                      — o equivalente de teste da role de migration
//   META_TEST_DATABASE_URL / GOOGLE_ADS_TEST_DATABASE_URL
//                                                      testes de schema/SQL copiado (DDL própria, sem
//                                                      contexto de tenant, sem código de request);
//                                                      a lista fechada desses arquivos mora no teste
function envDeTeste(url) {
  const app = urlDaAplicacao(url);
  const modoApp = process.env.TEST_APP_ROLE === '1';
  const daAplicacao = modoApp ? app : url;
  return {
    DATABASE_URL: daAplicacao,
    TEST_DATABASE_URL: daAplicacao,
    CREATIVE_TEST_DATABASE_URL: daAplicacao,
    META_TEST_DATABASE_URL: url,
    GOOGLE_ADS_TEST_DATABASE_URL: url,
    INVARIANTS_DATABASE_URL: url,
    INVARIANTS_APP_DATABASE_URL: app,
    TEST_OWNER_DATABASE_URL: url,
    ...(modoApp ? { TEST_APP_ROLE: '1', DB_ENFORCE_APP_ROLE: '1' } : {}),
  };
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
    const url = await start();
    console.error(`aplicação (oria_app): ${urlDaAplicacao(url)}`);
    console.log(url);
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
      env: { ...process.env, ...envDeTeste(url) },
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
