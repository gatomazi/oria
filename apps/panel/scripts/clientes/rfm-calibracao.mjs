#!/usr/bin/env node
// Calibração da RFM · relatório AGREGADO e ANONIMIZADO sobre `pedidos_ink`, SOMENTE LEITURA.
//
//   1) descobrir a Organization/Store (só ids e contagens, nenhum nome de loja nem de cliente):
//        DATABASE_URL=… node scripts/clientes/rfm-calibracao.mjs --listar-organizacoes
//   2) gerar o relatório:
//        DATABASE_URL=… node scripts/clientes/rfm-calibracao.mjs --organization <uuid> [--store <uuid>] \
//            [--as-of 2026-09-23T15:00:00Z] --json relatorios-privados/calibracao.json --md relatorios-privados/calibracao.md \
//            [--confirmo-host <host-do-banco>]     # OBRIGATÓRIO quando o host não é localhost (evita rodar no banco errado)
//
// Garantias:
//   · a sessão inteira é READ ONLY no servidor (`default_transaction_read_only=on` + BEGIN READ ONLY), e o script ABORTA se
//     `transaction_read_only` não vier `on`: nada grava, nem por engano;
//   · o escopo é a Organization e a Store informadas (mesmo predicado do painel); a RLS é ativada via
//     `set_config('app.current_organization_id', …)` quando a role é a da aplicação;
//   · só as colunas necessárias são lidas; nome/e-mail/telefone/documento nunca são selecionados nem impressos — documento,
//     telefone e e-mail entram só em memória para unir pedidos da mesma pessoa e não saem do processo;
//   · a saída é agregada (contagens, quantis, somas) e amostras com rótulo opaco aleatório (`c_ab12cd34`);
//   · a URL de conexão (segredo) NUNCA é impressa: só o host confirmado e o nome do banco;
//   · os arquivos de saída dentro do repositório só são gravados em caminho ignorado pelo Git (ex.: relatorios-privados/).
//
// Não há dado sintético aqui: se apontado para um banco vazio, o relatório sai vazio e diz isso.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { gerarRelatorio, paraMarkdown } = require('../../lib/clientes/calibracao.js');

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) throw new Error(`argumento inesperado: ${argv[i]}`);
    const k = argv[i].slice(2);
    a[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return a;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAIS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const a = args(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('defina DATABASE_URL (usuário somente leitura, de preferência réplica de leitura)');

// Alvo: só host e banco são exibidos (nunca usuário, senha ou a URL). Fora de localhost, o operador confirma o host.
const alvo = new URL(url);
const host = alvo.hostname;
const banco = decodeURIComponent(alvo.pathname.replace(/^\//, ''));
if (!LOCAIS.has(host) && a['confirmo-host'] !== host) {
  process.stderr.write(`Alvo: host "${host}", banco "${banco}".\nFora de localhost é preciso confirmar o host: repita com --confirmo-host ${host}\n`);
  process.exit(2);
}
process.stderr.write(`Alvo confirmado: host ${host}, banco ${banco} (sessão somente leitura)\n`);

// Saída dentro do repositório só em caminho ignorado pelo Git.
const RAIZ_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
function exigirCaminhoSeguro(arquivo) {
  const abs = path.resolve(String(arquivo));
  const dentro = abs === RAIZ_REPO || abs.startsWith(`${RAIZ_REPO}${path.sep}`);
  if (!dentro) return abs;
  try {
    execFileSync('git', ['-C', RAIZ_REPO, 'check-ignore', '-q', abs], { stdio: 'ignore' });
  } catch {
    throw new Error(`recuso gravar "${path.relative(RAIZ_REPO, abs)}": está dentro do repositório e NÃO é ignorado pelo Git. Use apps/panel/relatorios-privados/ ou um caminho fora do repositório.`);
  }
  return abs;
}
const saidaJson = a.json ? exigirCaminhoSeguro(a.json) : null;
const saidaMd = a.md ? exigirCaminhoSeguro(a.md) : null;
for (const s of [saidaJson, saidaMd]) if (s) fs.mkdirSync(path.dirname(s), { recursive: true });

const u = new URL(url);
u.searchParams.set('options', '-c default_transaction_read_only=on');
const client = new pg.Client({ connectionString: u.toString() });
await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const ro = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  if (ro !== 'on') throw new Error('a sessão não está em modo somente leitura; abortando sem ler nada');

  if (a['listar-organizacoes']) {
    // Só ids curtos e contagens; sem nome de loja/cliente. Com a role da aplicação e RLS, sem contexto de Organization pode vir vazio.
    const { rows } = await client.query(
      `SELECT o.id::text AS organization_id, count(DISTINCT s.id)::int AS stores,
              (SELECT count(*)::int FROM pedidos_ink p WHERE p.organization_id = o.id) AS pedidos
         FROM organizations o LEFT JOIN stores s ON s.organization_id = o.id GROUP BY o.id ORDER BY pedidos DESC`
    );
    await client.query('ROLLBACK');
    if (!rows.length) process.stdout.write('Nenhuma Organization visível para esta conexão (RLS sem contexto?). Use --organization <uuid> se você já o conhece.\n');
    for (const r of rows) process.stdout.write(`${r.organization_id}  stores=${r.stores}  pedidos_ink=${r.pedidos}\n`);
    process.exit(0);
  }

  if (!UUID.test(String(a.organization || ''))) throw new Error('--organization <uuid> é obrigatório (descubra com --listar-organizacoes)');
  if (a.store && !UUID.test(String(a.store))) throw new Error('--store deve ser um uuid');
  const asOf = a['as-of'] ? new Date(a['as-of']) : new Date();
  if (!Number.isFinite(asOf.getTime())) throw new Error('--as-of inválido');

  await client.query('SELECT set_config($1, $2, true)', ['app.current_organization_id', a.organization]);
  const stores = (await client.query('SELECT id, loja_legada FROM stores WHERE organization_id = $1 ORDER BY id', [a.organization])).rows;
  if (!stores.length) throw new Error('a Organization não tem Store visível para esta conexão (UUID errado ou RLS)');
  const store = a.store ? stores.find((s) => s.id === a.store) : (stores.length === 1 ? stores[0] : null);
  if (!store) throw new Error(`informe --store (a Organization tem ${stores.length} Stores)`);

  // Mesmo predicado de `escopoDaStore` do painel: Store canônica OU linha legada (sem store_id) da chave legada da Store.
  const t0 = performance.now();
  const { rows } = await client.query(
    `SELECT loja, ink_order_id, buyer_documento, buyer_telefone, buyer_email, payment_status, order_status, total_value, criado_em, is_troca, frete, descontos, items_count
       FROM pedidos_ink
      WHERE organization_id = $1
        AND (store_id = $2 OR ($3::text IS NOT NULL AND store_id IS NULL AND loja = $3))
      ORDER BY criado_em DESC, ink_order_id DESC`,
    [a.organization, store.id, store.loja_legada]
  );
  // Cobertura: só um backfill CONCLUÍDO confirma o intervalo lido (pedidos_backfill_jobs, somente leitura).
  const escopoJob = '(store_id = $2 OR ($3::text IS NOT NULL AND store_id IS NULL AND loja = $3))';
  const ultimo = (await client.query(`SELECT status FROM pedidos_backfill_jobs WHERE organization_id = $1 AND ${escopoJob} ORDER BY criado_em DESC LIMIT 1`, [a.organization, store.id, store.loja_legada])).rows[0];
  const concluido = (await client.query(`SELECT MIN(desde) AS desde FROM pedidos_backfill_jobs WHERE organization_id = $1 AND ${escopoJob} AND status = 'concluido'`, [a.organization, store.id, store.loja_legada])).rows[0];
  await client.query('ROLLBACK');
  const tLeituraMs = performance.now() - t0;

  const t1 = performance.now();
  const relatorio = gerarRelatorio(rows, {
    asOf, chaveDoContexto: store.loja_legada || store.id,
    backfill: { ultimoStatus: ultimo ? ultimo.status : null, concluidoDesde: concluido && concluido.desde ? concluido.desde : null },
  });
  // Volume e custo medidos NA MÁQUINA de quem executa (subsídio para decidir se snapshot persistido se justifica; não é a carga do servidor).
  relatorio.metodologia.desempenho = { pedidosLidos: rows.length, compradoresClassificados: relatorio.universo ? relatorio.universo.compradores : null, tempoDeLeituraMs: Math.round(tLeituraMs), tempoDeCalculoMs: Math.round(performance.now() - t1) };
  // Proveniência sem dado pessoal: prefixos curtos dos ids (não identificam clientes).
  relatorio.metodologia.origem = { linhasLidas: rows.length, organizacao: a.organization.slice(0, 8), store: store.id.slice(0, 8), hostConfirmado: host };
  const md = paraMarkdown(relatorio);
  if (saidaJson) fs.writeFileSync(saidaJson, `${JSON.stringify(relatorio, null, 2)}\n`);
  if (saidaMd) fs.writeFileSync(saidaMd, md);
  if (!saidaJson && !saidaMd) process.stdout.write(md);
  else process.stderr.write(`relatório gerado (${rows.length} linhas lidas) → ${[saidaJson, saidaMd].filter(Boolean).join(', ')}\n`);
} finally {
  await client.end();
}
