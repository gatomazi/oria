#!/usr/bin/env node
// Classificação e particionamento da suíte do painel — a base do CI por shards.
//
// Por que existe: até aqui o job `painel (Node)` rodava a suíte INTEIRA duas vezes (uma com a role
// dona, outra sob `oria_app`) num único processo sequencial — 1057 s + 1053 s no run 35387660663.
// A otimização não é remover teste: é (1) não rodar duas vezes o que não depende da role do
// Postgres, (2) partir o resto em shards com Postgres isolado por job.
//
// Regras que este arquivo protege:
//   - todo arquivo de teste cai em EXATAMENTE um shard (verificado por `verify`);
//   - a classificação é FAIL-CLOSED: arquivo que toca banco e caia no grupo sem banco reprova alto
//     (o harness lança sem `INVARIANTS_DATABASE_URL`), nunca se pula em silêncio;
//   - nenhum shard compartilha banco com outro — quem garante é o runner/o workflow
//     (scripts/ci/panel-suite.mjs e .github/workflows/ci.yml).
//
// Uso:
//   node scripts/ci/suites.mjs plan [--shards 4] [--pure-shards 2] [--json]
//   node scripts/ci/suites.mjs list --group db --shards 4 --index 1
//   node scripts/ci/suites.mjs verify --shards 4 --pure-shards 2

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAIZ_PAINEL = path.join(RAIZ, 'apps', 'panel');

// Um arquivo é "db" quando abre conexão, cria banco descartável, sobe o servidor do painel (que
// exige banco) ou lê uma das URLs de teste. Falso positivo custa tempo; falso negativo reprova
// alto no grupo sem banco — nunca vira silêncio.
const PADRAO_DB = /(urlDoBanco|abrirPool|abrirPoolDescartavel|criarBancoDescartavel|subirProcessoDoPainel|DATABASE_URL|new Pool\(|\bmigrar\()/;

// Exceções: arquivos cuja necessidade de banco (ou ausência dela) o padrão não enxerga. Cada uma
// com motivo, e cada uma medida — `negative-controls` reprovou sem banco em 2026-09-18.
const EXCECOES = Object.freeze({
  // Roda OUTROS arquivos de invariant contra uma cópia defeituosa do lib/: quem precisa de banco
  // são os filhos, e o padrão não vê isso no texto deste arquivo.
  'test/invariants/negative-controls.test.js': 'db',
});

// ── Pesos ──────────────────────────────────────────────────────────────────────────────────────
// Só BALANCEIAM os shards; não são contrato. Peso errado deixa um shard mais lento, nunca deixa
// teste de fora. Os valores abaixo foram MEDIDOS arquivo a arquivo (macOS arm64, 2026-09-18) — os
// do grupo `db` incluem ~4-10 s de harness (subir/reaproveitar o Postgres e aplicar migrations).
// Em CI (ubuntu-latest) o tempo costuma ser ~1,5-2× maior; a proporção é o que importa aqui.
// Regerar depois de uma execução completa: `node scripts/ci/panel-suite.mjs --group <g> --report
// scripts/ci/weights.json` (se o arquivo existir, ele tem precedência sobre esta tabela).
const PESOS_MEDIDOS = Object.freeze({
  'test/arquivos-publicos.test.js': 1.8,
  'test/campanhas-atribuicao.test.js': 1.4,
  'test/creative-core.test.js': 3.2,
  'test/custos-precos.test.js': 1.3,
  'test/financeiro-consolidado.test.js': 1.4,
  'test/financeiro-despesas.test.js': 1.8,
  'test/google-ads-client.test.js': 2.3,
  'test/google-ads-metricas.test.js': 1.2,
  'test/google-ads-queries.test.js': 1.3,
  'test/ink-financeiro.test.js': 1.3,
  'test/meta-criativos.test.js': 2.9,
  'test/meta.test.js': 1.6,
  'test/recuperacao-compra.test.js': 1.9,
  'test/invariants/auth-password.test.js': 2.1,
  'test/invariants/fase3-static.test.js': 1.4,
  'test/invariants/fase6-tenant1-static.test.js': 1.2,
  'test/invariants/inv-15-webhook.test.js': 0.9,
  'test/invariants/inv-22-creative-tenant.test.js': 1.1,
  'test/invariants/inv-23-entitlement.test.js': 0.9,
  'test/invariants/inv-24-recuperacao.test.js': 1.0,
  'test/invariants/ops22-creative-dual-read.test.js': 1.6,
  'test/invariants/ops22-creative-release-b.test.js': 3.9,
  // Roda o gate.mjs ~10× em subprocessos, cada um com go vet/build/test num módulo sintético.
  // É o arquivo mais caro da suíte inteira, e não toca banco.
  'test/invariants/productization-gate.test.js': 213,
  'test/invariants/r19-whatsapp-forward-transicao.test.js': 1.7,
  'test/invariants/tenancy-mapping.test.js': 1.9,
  'test/invariants/trilha-c-whatsapp-forward.test.js': 0.8,
  'test/invariants/convite-aceite.test.js': 9.3,
  'test/invariants/fase5c-e2e-whatsapp.test.js': 18.2,
  'test/invariants/migrations.test.js': 17.5,
  'test/invariants/negative-controls.test.js': 66,
  'test/invariants/release-preflight.test.js': 4.5,
  'test/invariants/tenancy-db-negative-controls.test.js': 17.2,
  'test/invariants/tenancy-isolation.test.js': 9.4,
});
// Arquivos ainda não medidos um a um. 10 s é a ordem de grandeza dos medidos do grupo `db`; é
// deliberadamente um chute declarado, e some assim que `weights.json` existir.
const PESO_PADRAO = 10;

function pesos() {
  const arquivo = path.join(RAIZ, 'scripts', 'ci', 'weights.json');
  if (!fs.existsSync(arquivo)) return PESOS_MEDIDOS;
  try {
    return { ...PESOS_MEDIDOS, ...JSON.parse(fs.readFileSync(arquivo, 'utf8')) };
  } catch {
    return PESOS_MEDIDOS;
  }
}

export function arquivosDaSuite() {
  const de = (rel) => fs.readdirSync(path.join(RAIZ_PAINEL, rel))
    .filter((x) => x.endsWith('.test.js'))
    .map((x) => `${rel}/${x}`);
  return [...de('test'), ...de('test/invariants')].sort();
}

export function grupoDoArquivo(rel) {
  if (EXCECOES[rel]) return EXCECOES[rel];
  return PADRAO_DB.test(fs.readFileSync(path.join(RAIZ_PAINEL, rel), 'utf8')) ? 'db' : 'pure';
}

export function classificar() {
  const grupos = { pure: [], db: [] };
  for (const rel of arquivosDaSuite()) grupos[grupoDoArquivo(rel)].push(rel);
  return grupos;
}

// Longest-processing-time: determinístico (peso desc, depois nome) e melhor que round-robin quando
// um arquivo domina o grupo — que é exatamente o caso de productization-gate.test.js.
export function planejar(lista, shards) {
  const p = pesos();
  const baldes = Array.from({ length: shards }, () => ({ arquivos: [], peso: 0 }));
  const ordenada = [...lista].sort((a, b) => (p[b] ?? PESO_PADRAO) - (p[a] ?? PESO_PADRAO) || a.localeCompare(b));
  for (const rel of ordenada) {
    const menor = baldes.reduce((m, b) => (b.peso < m.peso ? b : m), baldes[0]);
    menor.arquivos.push(rel);
    menor.peso = Math.round((menor.peso + (p[rel] ?? PESO_PADRAO)) * 10) / 10;
  }
  for (const b of baldes) b.arquivos.sort();
  return baldes;
}

export function shardDe(grupo, shards, index) {
  const lista = classificar()[grupo];
  if (!lista) throw new Error(`grupo desconhecido: ${grupo}`);
  if (!(shards >= 1) || !(index >= 1) || index > shards) throw new Error(`shards/index inválidos: ${index}/${shards}`);
  return planejar(lista, shards)[index - 1].arquivos;
}

// A verificação que dá sentido ao sharding: a união dos shards é a suíte, sem sobra e sem repetição.
export function verificar({ shards = 4, pureShards = 2 } = {}) {
  const grupos = classificar();
  const problemas = [];
  const vistos = new Set();
  for (const [grupo, lista] of Object.entries(grupos)) {
    for (const parte of planejar(lista, grupo === 'db' ? shards : pureShards)) {
      if (!parte.arquivos.length) problemas.push(`${grupo}: shard vazio com ${grupo === 'db' ? shards : pureShards} shards`);
      for (const rel of parte.arquivos) {
        if (vistos.has(rel)) problemas.push(`${rel}: em mais de um shard`);
        vistos.add(rel);
      }
    }
  }
  for (const rel of arquivosDaSuite()) if (!vistos.has(rel)) problemas.push(`${rel}: em nenhum shard`);
  return problemas;
}

function main(argv) {
  const comando = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
  const opt = (nome, padrao) => {
    const i = argv.indexOf(`--${nome}`);
    return i === -1 ? padrao : argv[i + 1];
  };
  const shards = Number(opt('shards', '4'));
  const pureShards = Number(opt('pure-shards', '2'));

  if (comando === 'list') {
    const grupo = opt('group', 'db');
    const index = Number(opt('index', '1'));
    console.log(shardDe(grupo, grupo === 'db' ? shards : pureShards, index).join('\n'));
    return 0;
  }

  if (comando === 'verify') {
    const problemas = verificar({ shards, pureShards });
    if (problemas.length) {
      console.error(`[suites] particionamento inválido:\n  ${problemas.join('\n  ')}`);
      return 1;
    }
    const { pure, db } = classificar();
    console.log(`[suites] ok — ${pure.length + db.length} arquivos · ${pure.length} sem banco (${pureShards} shards) · ${db.length} com banco (${shards} shards)`);
    return 0;
  }

  if (comando === 'plan') {
    const { pure, db } = classificar();
    const partesPure = planejar(pure, pureShards);
    const partesDb = planejar(db, shards);
    if (argv.includes('--json')) {
      console.log(JSON.stringify({
        pure: partesPure.map((p) => ({ peso: p.peso, arquivos: p.arquivos })),
        db: partesDb.map((p) => ({ peso: p.peso, arquivos: p.arquivos })),
      }, null, 2));
      return 0;
    }
    partesPure.forEach((p, i) => console.log(`sem banco ${i + 1}/${pureShards} · ~${p.peso}s (${p.arquivos.length}):\n  ${p.arquivos.join('\n  ')}\n`));
    partesDb.forEach((p, i) => console.log(`com banco ${i + 1}/${shards} · ~${p.peso}s (${p.arquivos.length}):\n  ${p.arquivos.join('\n  ')}\n`));
    return 0;
  }

  console.error('comandos: plan | list --group pure|db [--shards N --index I] | verify');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
