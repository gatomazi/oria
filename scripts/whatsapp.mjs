#!/usr/bin/env node
// Serviço de WhatsApp (services/whatsapp) a partir da raiz do monorepo.
//
//   node scripts/whatsapp.mjs build   go vet + go build
//   node scripts/whatsapp.mjs test    go vet + go build + go test -race, com Postgres descartável
//
// Os testes de banco do Go exigem WEBHOOK_TEST_DATABASE_URL. Sem ela, este script sobe um Postgres
// efêmero no Docker e o derruba no fim — nunca deixa o teste se pular em silêncio.
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICO = path.join(RAIZ, 'services', 'whatsapp');
const IMAGEM = process.env.TEST_PG_IMAGE || 'postgres:16-alpine';
const SENHA = 'teste';

function go(args, env = {}) {
  return spawnSync('go', args, { cwd: SERVICO, stdio: 'inherit', env: { ...process.env, ...env } });
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

async function comBanco(fn) {
  if (process.env.WEBHOOK_TEST_DATABASE_URL) return fn(process.env.WEBHOOK_TEST_DATABASE_URL);
  const nome = `oria-wa-test-${crypto.randomBytes(3).toString('hex')}`;
  const porta = await portaLivre();
  const run = spawnSync('docker', ['run', '-d', '--rm', '--name', nome,
    '-e', `POSTGRES_PASSWORD=${SENHA}`, '-p', `127.0.0.1:${porta}:5432`, IMAGEM,
    '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off'], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`docker run falhou: ${run.stderr || run.stdout}`);
  try {
    const ate = Date.now() + 60000;
    for (;;) {
      const pronto = spawnSync('docker', ['exec', nome, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres', '-q']);
      if (pronto.status === 0) break;
      if (Date.now() > ate) throw new Error('Postgres do Go não ficou pronto em 60s');
      spawnSync('sleep', ['0.3']);
    }
    return await fn(`postgres://postgres:${SENHA}@127.0.0.1:${porta}/postgres`);
  } finally {
    spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
  }
}

async function main() {
  const comando = process.argv[2] || 'test';
  if (!['test', 'build'].includes(comando)) {
    console.error('uso: node scripts/whatsapp.mjs test|build');
    return 64;
  }
  console.log(`[whatsapp] go vet / go build (${path.relative(RAIZ, SERVICO)})`);
  if (go(['vet', './...']).status !== 0) return 1;
  if (go(['build', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '.']).status !== 0) return 1;
  if (comando === 'build') return 0;
  return comBanco((url) => {
    console.log('[whatsapp] go test -race ./...');
    return go(['test', '-race', '-count=1', './...'], { WEBHOOK_TEST_DATABASE_URL: url }).status ?? 1;
  });
}

main().then((c) => process.exit(c), (err) => { console.error(`[whatsapp] ${err.message}`); process.exit(1); });
