#!/usr/bin/env node
// O monorepo Oria precisa ser autocontido: um clone limpo de gatomazi/oria roda tudo sem os
// repositórios antigos ao lado e sem caminho da máquina de ninguém.
//
//   node scripts/self-check.mjs           confere (exit 1 se achar dependência externa)
//   node scripts/self-check.mjs --lista    imprime os arquivos varridos e sai
//
// O que reprova, em código executável e configuração de teste/CI:
//   1. caminho absoluto local (/Users/..., /home/..., C:\Users\...);
//   2. repositório de origem usado como CAMINHO ou alvo de comando git
//      (`../orgulhoregional`, `'whatsapp-webhook-go'`, `git -C <repo antigo>`);
//   3. caminho relativo que, resolvido, sai da raiz do monorepo.
//
// O que NÃO reprova, de propósito: o nome do produto/domínio (`orgulhoregional.com.br`), o nome do
// serviço em prosa e comentários ("o whatsapp-webhook-go repassa…"), rótulos históricos dentro dos
// contratos, e documentação. A regra é dependência, não vocabulário.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXTENSOES = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.go', '.py', '.json', '.yml', '.yaml', '.sh', '.sql']);

// Arquivos que registram a origem de propósito.
const ISENTOS = new Set([
  'docs/architecture/source-migration-manifest.md',
  'services/whatsapp/.env.example',
  // Este arquivo precisa citar os nomes que procura.
  'scripts/self-check.mjs',
]);

const REPOS_DE_ORIGEM = ['orgulhoregional', 'whatsapp-webhook-go', 'estamparia-criativos', 'creative-lab'];

const REGRAS = [
  {
    id: 'caminho-absoluto-local',
    descricao: 'caminho absoluto da máquina local',
    achar(linha) {
      return /(^|[\s"'`(=:,[])(\/Users\/[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\)/.test(linha);
    },
  },
  {
    id: 'repositorio-de-origem',
    descricao: 'repositório de origem usado como caminho ou alvo de comando',
    achar(linha) {
      const nomes = REPOS_DE_ORIGEM.join('|');
      // Como caminho: ../repo, /repo/, repo/ dentro de string; ou o nome sozinho entre aspas.
      // O domínio do produto (orgulhoregional.com.br) é conteúdo, não dependência de repositório.
      const comoCaminho = new RegExp(`(\\.{1,2}/|/)(${nomes})\\b(?!\\.[a-z])|\\b(${nomes})/|['"\`](${nomes})['"\`]`);
      // Como alvo de git: git -C <algo com o nome>, git --git-dir, git archive <commit> no repo antigo.
      const comoGit = new RegExp(`git[^\\n]*(${nomes})`);
      return comoCaminho.test(linha) || comoGit.test(linha);
    },
  },
  {
    id: 'sai-da-raiz',
    descricao: 'caminho relativo que sai da raiz do monorepo',
    achar(linha, rel) {
      const base = path.dirname(path.join(RAIZ, rel));
      for (const m of linha.matchAll(/['"`](\.\.\/[^'"`\n]*)['"`]/g)) {
        const alvo = path.resolve(base, m[1]);
        if (!alvo.startsWith(`${RAIZ}${path.sep}`) && alvo !== RAIZ) return true;
      }
      // path.resolve(x, '..', '..', '..') e afins: conta os saltos declarados em sequência.
      const saltos = linha.match(/(?:['"`]\.\.['"`]\s*,\s*){3,}/);
      return Boolean(saltos);
    },
  },
];

function arquivosVersionados() {
  const r = spawnSync('git', ['-C', RAIZ, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files falhou: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

function varrer() {
  const achados = [];
  const varridos = [];
  for (const rel of arquivosVersionados()) {
    if (ISENTOS.has(rel)) continue;
    if (!EXTENSOES.has(path.extname(rel))) continue;
    let conteudo;
    try { conteudo = fs.readFileSync(path.join(RAIZ, rel), 'utf8'); } catch { continue; }
    varridos.push(rel);
    conteudo.split('\n').forEach((linha, i) => {
      for (const regra of REGRAS) {
        if (regra.achar(linha, rel)) achados.push({ rel, linha: i + 1, regra, texto: linha.trim().slice(0, 140) });
      }
    });
  }
  return { achados, varridos };
}

function main() {
  const { achados, varridos } = varrer();
  if (process.argv.includes('--lista')) {
    console.log(varridos.join('\n'));
    console.log(`\n${varridos.length} arquivo(s) de código/config varridos`);
    return 0;
  }
  if (achados.length) {
    console.error('[self-check] FAIL — o repositório depende de algo fora dele:\n');
    for (const a of achados) {
      console.error(`  ${a.rel}:${a.linha}  [${a.regra.id}] ${a.regra.descricao}`);
      console.error(`      ${a.texto}`);
    }
    console.error(`\n${achados.length} ocorrência(s). Código executável e config não podem depender de caminho`);
    console.error('local, de repositório de origem nem de nada fora da raiz. Documentação pode citar.');
    return 1;
  }
  console.log(`[self-check] OK · ${varridos.length} arquivo(s) de código/config · nenhuma dependência externa`);
  console.log(`  regras: ${REGRAS.map((r) => r.id).join(' · ')}`);
  return 0;
}

process.exit(main());
