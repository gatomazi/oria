#!/usr/bin/env node
'use strict';

// Snapshots podados do histórico legado do painel — geração e verificação.
//
// ── Por que existem ────────────────────────────────────────────────────────────────────────────
// Quatro contratos de rollout (RELEASE B, D0, produção e o painel de antes do endurecimento do
// repasse) só provam o que prometem se rodarem o código REAL daqueles commits: ler o diff não
// distingue "o script se comporta assim" de "eu li o script e acho que se comporta assim".
//
// Até a rodada 20 isso era feito com `git archive` no repositório legado do painel, em disco, ao
// lado do monorepo. O custo era alto e silencioso: um clone limpo do Oria não conseguia rodar a
// suíte, e o CI tinha de excluir os quatro arquivos — exclusão que é verde na saída, que é
// exatamente o modo de falha que a productização combate.
//
// A troca: o mesmo `git archive`, mas UMA VEZ, com o resultado versionado como fixture. O código
// executado continua sendo byte a byte o daqueles commits; o que sai é a dependência de ter o
// repositório antigo por perto.
//
// ── Determinismo ───────────────────────────────────────────────────────────────────────────────
// `git archive --format=tar` é determinístico (ordem de árvore, mtime do commit, uid/gid/modo
// fixos). A compressão é feita aqui com zlib nível 9 e mtime zerado — `--format=tar.gz` carimbaria
// a hora da geração no cabeçalho gzip e o `--check` nunca fecharia. Resultado: regerar em outra
// máquina, em outro dia, produz o MESMO sha256.
//
// ── Uso ────────────────────────────────────────────────────────────────────────────────────────
//   node scripts/fixtures/legacy-snapshots.mjs --repo <caminho do repositório legado>
//   node scripts/fixtures/legacy-snapshots.mjs --repo <caminho> --check
//
// Sem `--repo`, usa ORIA_LEGACY_PANEL_REPO. O `--check` é opcional por natureza: só quem tem o
// repositório legado em disco consegue rodá-lo. Os testes NÃO dependem dele — eles leem o tarball.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const DIR_FIXTURES = path.resolve(AQUI, '..', '..', 'test', 'fixtures', 'legacy');
export const CAMINHO_MANIFESTO = path.join(DIR_FIXTURES, 'manifest.json');

// ── Os snapshots ───────────────────────────────────────────────────────────────────────────────
// `paths` é o MENOR conjunto que faz o teste consumidor passar; cada entrada diz quem consome e
// por quê, para que ninguém amplie o escopo "por precaução" depois.
export const SNAPSHOTS = Object.freeze([
  {
    arquivo: 'ed5a5b0-criativos.tar.gz',
    commit: 'ed5a5b0',
    escopo: 'criativos',
    // Produção de então: tenant = CREATIVE_TENANT_ID || 'default'.
    paths: ['routes/criativos.js', 'lib/creative-core'],
    consumidores: ['test/invariants/ops22-creative-release-b.test.js'],
  },
  {
    arquivo: '31a7cdb-release-b.tar.gz',
    commit: '31a7cdb',
    escopo: 'release-b',
    // RELEASE B do runbook. Um único snapshot serve aos três consumidores: `lib` + `scripts` +
    // `migrations` + `package.json` (release/runbook) já contêm `lib/creative-core`; só
    // `routes/criativos.js` precisa ser somado por causa do OPS-22.
    paths: ['scripts', 'lib', 'migrations', 'package.json', 'routes/criativos.js'],
    consumidores: [
      'test/invariants/ops22-creative-release-b.test.js',
      'test/invariants/r19-release-b-contrato.test.js',
      'test/invariants/r19-runbook-dry-run.test.js',
    ],
  },
  {
    arquivo: '8c024d2-release-d0.tar.gz',
    commit: '8c024d2',
    escopo: 'release-d0',
    // `server.js` entra porque D0 é `c706da1^`, o commit imediatamente anterior ao endurecimento do
    // repasse: o contrato da transição compara a rota do webhook dele com a do painel testado, e
    // essa comparação é o que prova que a árvore exercitada é mesmo a candidata a D0.
    paths: ['scripts', 'lib', 'migrations', 'package.json', 'server.js'],
    consumidores: [
      'test/invariants/r19-runbook-dry-run.test.js',
      'test/invariants/r19-contrato-repasse-transicao.test.js',
    ],
  },
  {
    arquivo: 'bfd00a6-painel.tar.gz',
    commit: 'bfd00a6',
    escopo: 'painel',
    // Painel INTEIRO em processo: `server.js` sobe de verdade, com as migrations daquele commit e
    // a role da aplicação provisionada pelo contrato daquela árvore. O front (`admin/dist`,
    // `assets`, `src`) e os catálogos (`data`) ficam de fora: o teste só fala HTTP/JSON com o
    // painel, e os leitores de catálogo daquele commit já caem em fallback vazio sem o arquivo.
    // `test/fixtures/tenancy` (669 bytes) entra por necessidade: a migration de mapeamento daquela
    // árvore lê `cenario-a.json` via TENANCY_MAPPING_FILE e aborta sem ele.
    paths: ['server.js', 'lib', 'routes', 'migrations', 'scripts', 'package.json', 'test/fixtures/tenancy'],
    consumidores: ['test/invariants/r19-contrato-repasse-transicao.test.js'],
  },
]);

// ── git ────────────────────────────────────────────────────────────────────────────────────────
function git(repo, args, { encoding = 'utf8' } = {}) {
  return spawnSync('git', ['-C', repo, ...args], { encoding, maxBuffer: 512 * 1024 * 1024 });
}

function exigirRepo(repo) {
  if (!repo) {
    throw new Error('informe o repositório legado do painel com --repo <caminho> (ou ORIA_LEGACY_PANEL_REPO)');
  }
  const r = git(repo, ['rev-parse', '--git-dir']);
  if (r.status !== 0) throw new Error(`não é um repositório git: ${repo}`);
  return path.resolve(repo);
}

// tar determinístico do commit, podado aos `paths`, comprimido com mtime zerado.
function gerar(repo, snap) {
  const alvo = git(repo, ['rev-parse', `${snap.commit}^{commit}`]);
  if (alvo.status !== 0) throw new Error(`commit ${snap.commit} ausente em ${repo} (clone raso?)`);
  const r = git(repo, ['archive', '--format=tar', snap.commit, '--', ...snap.paths], { encoding: 'buffer' });
  assert.equal(r.status, 0, `git archive ${snap.commit}: ${r.stderr}`);
  return {
    commitCompleto: alvo.stdout.trim(),
    bytes: zlib.gzipSync(r.stdout, { level: 9, mtime: 0 }),
  };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function lerManifesto() {
  if (!fs.existsSync(CAMINHO_MANIFESTO)) return null;
  return JSON.parse(fs.readFileSync(CAMINHO_MANIFESTO, 'utf8'));
}

// ── Comandos ───────────────────────────────────────────────────────────────────────────────────
function escrever(repo) {
  fs.mkdirSync(DIR_FIXTURES, { recursive: true });
  const anterior = lerManifesto();
  const entradas = [];
  for (const snap of SNAPSHOTS) {
    const { commitCompleto, bytes } = gerar(repo, snap);
    const destino = path.join(DIR_FIXTURES, snap.arquivo);
    const hash = sha256(bytes);
    const antes = anterior?.snapshots?.find((s) => s.arquivo === snap.arquivo);
    const igual = antes?.sha256 === hash && fs.existsSync(destino);
    if (!igual) fs.writeFileSync(destino, bytes);
    entradas.push({
      arquivo: snap.arquivo,
      commit: snap.commit,
      commitCompleto,
      escopo: snap.escopo,
      paths: snap.paths,
      consumidores: snap.consumidores,
      bytes: bytes.length,
      sha256: hash,
      // A data só se move quando o conteúdo se move: regerar sem mudança não sujeita o diff.
      geradoEm: igual ? antes.geradoEm : new Date().toISOString().slice(0, 10),
    });
    process.stdout.write(`${igual ? 'inalterado' : 'gravado   '}  ${snap.arquivo}  ${(bytes.length / 1024).toFixed(0)} KB  ${hash.slice(0, 12)}\n`);
  }
  fs.writeFileSync(CAMINHO_MANIFESTO, `${JSON.stringify({
    descricao: 'Snapshots podados do histórico legado do painel, versionados para que a suíte rode em clone limpo. Regerar: node scripts/fixtures/legacy-snapshots.mjs --repo <caminho>',
    snapshots: entradas,
  }, null, 2)}\n`);
  return 0;
}

function conferir(repo) {
  const manifesto = lerManifesto();
  if (!manifesto) throw new Error(`manifesto ausente: ${CAMINHO_MANIFESTO}`);
  let falhas = 0;
  for (const snap of SNAPSHOTS) {
    const entrada = manifesto.snapshots.find((s) => s.arquivo === snap.arquivo);
    const destino = path.join(DIR_FIXTURES, snap.arquivo);
    const problemas = [];
    if (!entrada) problemas.push('sem entrada no manifesto');
    if (!fs.existsSync(destino)) problemas.push('tarball ausente');
    if (entrada && fs.existsSync(destino)) {
      const noDisco = sha256(fs.readFileSync(destino));
      if (noDisco !== entrada.sha256) problemas.push(`sha256 do disco ${noDisco.slice(0, 12)} ≠ manifesto ${entrada.sha256.slice(0, 12)}`);
      if (repo) {
        const { bytes, commitCompleto } = gerar(repo, snap);
        if (sha256(bytes) !== noDisco) problemas.push('regeração a partir do repositório legado diverge do tarball versionado');
        if (entrada.commitCompleto && entrada.commitCompleto !== commitCompleto) problemas.push(`commit completo ${commitCompleto} ≠ manifesto ${entrada.commitCompleto}`);
      }
    }
    if (problemas.length) falhas += 1;
    process.stdout.write(`${problemas.length ? 'FALHA' : 'ok   '}  ${snap.arquivo}${problemas.length ? `  — ${problemas.join('; ')}` : ''}\n`);
  }
  if (!repo) process.stdout.write('nota: sem --repo, só o sha256 do disco foi conferido contra o manifesto\n');
  return falhas === 0 ? 0 : 1;
}

function principal(argv) {
  const iRepo = argv.indexOf('--repo');
  const repoCru = iRepo >= 0 ? argv[iRepo + 1] : process.env.ORIA_LEGACY_PANEL_REPO;
  const check = argv.includes('--check');
  if (check) return conferir(repoCru ? exigirRepo(repoCru) : null);
  return escrever(exigirRepo(repoCru));
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exit(principal(process.argv.slice(2)));
  } catch (erro) {
    process.stderr.write(`${erro.message}\n`);
    process.exit(1);
  }
}
