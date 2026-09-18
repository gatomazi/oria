#!/usr/bin/env node
// Autocontenção do monorepo Oria — o repositório roda sozinho, a partir de um clone limpo.
//
// O Oria nasceu de três repositórios (painel, serviço de WhatsApp, gerador de criativos). O risco
// residual dessa origem não é código faltando: é código que AINDA alcança as árvores antigas —
// um `git archive` num repositório vizinho, um caminho `/Users/...` numa configuração, um teste que
// só passa na máquina de quem fez a migração. Nada disso quebra localmente, e é exatamente por isso
// que passa despercebido até o primeiro clone limpo (ou o primeiro runner de CI).
//
// Este script falha quando encontra, em código executável ou configuração de teste:
//   1. caminho absoluto de máquina local (/Users/..., /private/tmp/..., C:\Users\...);
//   2. caminho que aponta para um dos repositórios de origem (dependência de repo vizinho);
//   3. dependência do repositório legado do painel via ORIA_LEGACY_PANEL_REPO.
//
// E confere mais duas coisas:
//   4. que os snapshots do histórico legado — que substituíram essa dependência — estão
//      versionados e batem com o manifesto;
//   5. que `apps/panel/admin/` não voltou a existir como um segundo app dentro do painel.
//
// O que NÃO é violação, e por isso não é procurado: o domínio de produção
// (`orgulhoregional.com.br`), o identificador do app desktop e o nome do serviço Go em comentários.
// São nomes de produto, não caminhos. A varredura é de caminhos justamente para não ter de manter
// uma lista de exceções — uma lista de exceções é onde a próxima dependência real se esconde.
//
// Documentação (`*.md`) e o manifesto de proveniência das fixtures citam a origem à vontade: é o
// registro de onde o código veio, e apagá-lo custaria mais do que ganha.
//
//   node scripts/repo-self-check.mjs [--verbose]

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

const EXTENSOES = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.go', '.py', '.json', '.yml', '.yaml', '.sh', '.toml']);

// Repositórios de origem, pelo nome de diretório. Procurados SÓ em forma de caminho.
const REPOS_DE_ORIGEM = ['orgulhoregional', 'whatsapp-webhook-go', 'estamparia-criativos', 'creative-lab'];

const REGRAS = [
  {
    id: 'caminho-absoluto-local',
    // `/Users/…`, `/private/tmp/…`, `C:\Users\…` — a máquina de quem escreveu, não o repositório.
    padrao: /(?:^|[\s'"`(,=:[])(?:\/Users\/|\/private\/tmp\/|\/home\/[\w.-]+\/(?:projects|dev|src)\/|[A-Za-z]:\\Users\\)/,
    mensagem: 'caminho absoluto de máquina local',
  },
  {
    id: 'repo-de-origem',
    // Qualquer caminho que desça até um dos repositórios antigos. Exige a barra (ou o `../`) para
    // não confundir com o domínio de produção nem com o nome do serviço em prosa.
    padrao: new RegExp(`(?:^|[\\s'"\`(,=:[])(?:\\.{1,2}\\/|\\/)(?:[\\w.-]+\\/)*(${REPOS_DE_ORIGEM.join('|')})(?![\\w.-])`),
    mensagem: 'caminho para um repositório de origem (dependência de repo vizinho)',
  },
  {
    id: 'repo-legado-por-env',
    padrao: /ORIA_LEGACY_PANEL_REPO/,
    mensagem: 'dependência do repositório legado do painel',
  },
];

// Exceções nominais, com motivo. Curtas de propósito: cada linha aqui é uma promessa.
const PERMITIDOS = new Map([
  // Este arquivo: os padrões que ele procura estão escritos nele.
  ['scripts/repo-self-check.mjs', ['caminho-absoluto-local', 'repo-de-origem', 'repo-legado-por-env']],
  // Ferramenta de REGENERAÇÃO das fixtures: só roda na mão, só para quem tem o repositório antigo,
  // e a suíte não depende dela. É o único lugar que pode nomear a variável de ambiente.
  ['apps/panel/scripts/fixtures/legacy-snapshots.mjs', ['repo-legado-por-env']],
  // Proveniência dos snapshots: commits, paths e sha256. É registro, não dependência.
  ['apps/panel/test/fixtures/legacy/manifest.json', ['repo-de-origem']],
]);

function arquivosVersionados() {
  const r = spawnSync('git', ['-C', RAIZ, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ls-files falhou: ${r.stderr}`);
  return r.stdout.split('\0').filter(Boolean);
}

function varrer() {
  const achados = [];
  let lidos = 0;
  for (const rel of arquivosVersionados()) {
    if (!EXTENSOES.has(path.extname(rel))) continue;
    if (rel.split('/').includes('node_modules')) continue;
    const absoluto = path.join(RAIZ, rel);
    if (!fs.existsSync(absoluto)) continue;
    const isentas = PERMITIDOS.get(rel) ?? [];
    const linhas = fs.readFileSync(absoluto, 'utf8').split('\n');
    lidos += 1;
    linhas.forEach((linha, i) => {
      for (const regra of REGRAS) {
        if (isentas.includes(regra.id)) continue;
        if (regra.padrao.test(linha)) achados.push({ rel, linha: i + 1, regra, trecho: linha.trim().slice(0, 160) });
      }
    });
  }
  return { achados, lidos };
}

// As fixtures que substituíram a dependência precisam existir e bater com o manifesto — senão a
// autocontenção é só ausência de menção ao repositório antigo.
function conferirSnapshots() {
  const dir = path.join(RAIZ, 'apps', 'panel', 'test', 'fixtures', 'legacy');
  const manifesto = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifesto)) return [`manifesto ausente: ${path.relative(RAIZ, manifesto)}`];
  const { snapshots } = JSON.parse(fs.readFileSync(manifesto, 'utf8'));
  const problemas = [];
  for (const s of snapshots) {
    const arquivo = path.join(dir, s.arquivo);
    if (!fs.existsSync(arquivo)) { problemas.push(`snapshot ausente: ${s.arquivo}`); continue; }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(arquivo)).digest('hex');
    if (sha !== s.sha256) problemas.push(`snapshot ${s.arquivo}: sha256 ${sha.slice(0, 12)} ≠ manifesto ${s.sha256.slice(0, 12)}`);
    else if (VERBOSE) process.stdout.write(`  ok  ${s.arquivo}  ${s.commit}  ${(s.bytes / 1024).toFixed(0)} KB\n`);
  }
  return problemas;
}

// `apps/panel` é UM deployable: um `package.json`, um lockfile, um build. Já foi dois — o frontend
// morava em `apps/panel/admin/`, com manifesto, lockfile e `dist` próprios, e o Railway construía o
// painel chamando um `npm install` aninhado por dentro do `postinstall`. Isso saiu de cena quando o
// SPA subiu para a raiz do painel.
//
// A reincidência é fácil e silenciosa: basta alguém rodar `npm create vite@latest admin` ali dentro
// para "separar o front", e nada quebra no mesmo dia — o Railway continua buildando, os testes
// continuam verdes, e só muito depois aparecem dois lockfiles divergindo e um `dist` que não é o
// que está no ar. Por isso a checagem é por CAMINHO VERSIONADO, e não por menção em texto: a
// documentação histórica (relatórios de rodada, manifesto de proveniência) fala do layout antigo à
// vontade, e deve mesmo.
//
// PASTA, não URL: a rota web `/admin` é o painel e continua existindo. O que não pode voltar é o
// diretório.
const CAMINHOS_PROIBIDOS = [
  ['apps/panel/admin/package.json', 'segundo manifesto npm dentro do painel'],
  ['apps/panel/admin/package-lock.json', 'segundo lockfile dentro do painel'],
  ['apps/panel/admin/src', 'frontend de volta para um subdiretório do painel'],
  ['apps/panel/admin/dist', 'segundo build dentro do painel'],
];

function conferirPainelUnico(versionados) {
  const problemas = [];
  for (const [caminho, motivo] of CAMINHOS_PROIBIDOS) {
    const reapareceu = versionados.some((rel) => rel === caminho || rel.startsWith(`${caminho}/`));
    if (reapareceu) problemas.push(`${caminho} voltou a existir — ${motivo}`);
    else if (VERBOSE) process.stdout.write(`  ok  sem ${caminho}\n`);
  }
  return problemas;
}

function main() {
  const versionados = arquivosVersionados();
  const { achados, lidos } = varrer();
  const problemasDeSnapshot = conferirSnapshots();
  const problemasDePainel = conferirPainelUnico(versionados);

  if (achados.length || problemasDeSnapshot.length || problemasDePainel.length) {
    process.stderr.write('[self-check] FAIL — o repositório não é autocontido\n');
    for (const a of achados) {
      process.stderr.write(`  ${a.rel}:${a.linha}  ${a.regra.mensagem}\n      ${a.trecho}\n`);
    }
    for (const p of problemasDeSnapshot) process.stderr.write(`  ${p}\n`);
    for (const p of problemasDePainel) process.stderr.write(`  ${p}\n`);
    process.stderr.write('\n  um clone limpo precisa rodar sem repositórios vizinhos nem caminhos da máquina de quem escreveu\n');
    process.stderr.write('  e `apps/panel` é um deployable só: um package.json, um lockfile, um build\n');
    return 1;
  }
  process.stdout.write(`[self-check] OK · ${lidos} arquivo(s) de código/config varridos · snapshots do histórico legado conferem com o manifesto · apps/panel é um deployable só\n`);
  return 0;
}

process.exit(main());
