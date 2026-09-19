#!/usr/bin/env node
// Quais partes do monorepo o diff afeta — entrada do job `changes` do CI.
//
// Regra de projeto: na dúvida, RODAR. Um filtro que erra para menos transforma verde em silêncio, e
// silêncio é o modo de falha que a productização inteira combate. Por isso:
//   - qualquer mudança em scripts de CI, workflows, package.json da raiz ou caminho desconhecido
//     liga TUDO;
//   - migrations, manifesto de tenancy, RLS, segredos de integração e identidade de Store ligam a
//     VERIFICAÇÃO COMPLETA do painel (as duas roles, migrations, dry-run, controles negativos);
//   - contratos ligam os dois consumidores reais (painel e serviço Go).
//
// Uso:
//   node scripts/ci/changes.mjs --base <sha> --head <sha>     # usa git diff
//   node scripts/ci/changes.mjs --files arquivo1 arquivo2      # lista explícita (testes)
//   node scripts/ci/changes.mjs ... --github-output            # escreve em $GITHUB_OUTPUT

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const AREAS = ['panel', 'panel_full', 'platform_admin', 'creatives', 'whatsapp', 'contracts', 'docs_only'];

// Caminhos cuja mudança exige a verificação completa do painel (D13): schema, tenancy, RLS,
// segredos de integração e identidade de Store.
const GATILHOS_FULL = [
  'apps/panel/migrations/',
  'apps/panel/lib/platform/tenancy-manifest',
  'apps/panel/lib/platform/app-role',
  'apps/panel/lib/platform/integrations',
  'apps/panel/lib/secrets',
  'apps/panel/scripts/tenancy/',
  'apps/panel/scripts/tenant1/',
  'apps/panel/server.js',
];

export function classificarArquivos(arquivos) {
  const ligadas = new Set();
  const tudo = () => { for (const a of AREAS) if (a !== 'docs_only') ligadas.add(a); };

  for (const arquivo of arquivos) {
    const f = arquivo.replace(/\\/g, '/');
    if (GATILHOS_FULL.some((g) => f.startsWith(g))) { ligadas.add('panel'); ligadas.add('panel_full'); ligadas.add('platform_admin'); continue; }
    if (f.startsWith('apps/panel/')) { ligadas.add('panel'); continue; }
    if (f.startsWith('apps/platform-admin/')) { ligadas.add('platform_admin'); continue; }
    if (f.startsWith('apps/creative-generator/')) { ligadas.add('creatives'); ligadas.add('panel'); continue; }
    if (f.startsWith('services/whatsapp/')) { ligadas.add('whatsapp'); ligadas.add('panel'); continue; }
    // Contrato cross-service: os consumidores são o painel (fixtures) e o Go (testdata).
    if (f.startsWith('contracts/')) { ligadas.add('contracts'); ligadas.add('panel'); ligadas.add('whatsapp'); continue; }
    // A suíte do painel lê documentos (runbook de rollout, tabelas por tenant, aceite de convite).
    if (f.startsWith('docs/')) { ligadas.add('docs_only'); ligadas.add('panel'); continue; }
    // Infra de CI, scripts compartilhados, package.json da raiz, qualquer coisa desconhecida.
    tudo();
  }

  // `docs_only` só vale quando NADA além de docs mudou.
  if (ligadas.has('docs_only') && [...ligadas].some((a) => !['docs_only', 'panel'].includes(a))) ligadas.delete('docs_only');
  // Contratos são baratos (~7 s) e provam autocontenção: rodam sempre que algo roda.
  if (ligadas.size) ligadas.add('contracts');
  return ligadas;
}

function arquivosDoDiff(base, head) {
  const r = spawnSync('git', ['diff', '--name-only', `${base}...${head}`], { encoding: 'utf8' });
  if (r.status !== 0) {
    // Sem base confiável (push direto, shallow clone, primeiro commit): roda tudo.
    console.error('[changes] git diff falhou — assumindo que tudo mudou');
    return ['__desconhecido__'];
  }
  return r.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
}

function main(argv) {
  const opt = (nome) => { const i = argv.indexOf(`--${nome}`); return i === -1 ? null : argv[i + 1]; };
  let arquivos;
  const iFiles = argv.indexOf('--files');
  if (iFiles !== -1) {
    arquivos = argv.slice(iFiles + 1).filter((a) => !a.startsWith('--'));
  } else {
    const base = opt('base');
    const head = opt('head') || 'HEAD';
    arquivos = base ? arquivosDoDiff(base, head) : ['__desconhecido__'];
  }

  const ligadas = classificarArquivos(arquivos);
  const linhas = AREAS.map((a) => `${a}=${ligadas.has(a)}`);
  for (const l of linhas) console.log(l);
  if (argv.includes('--github-output') && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `${linhas.join('\n')}\n`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
