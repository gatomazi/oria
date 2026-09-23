#!/usr/bin/env node
// Calibração da RFM · relatório AGREGADO e ANONIMIZADO sobre `pedidos_ink`, SOMENTE LEITURA.
//
//   DATABASE_URL=postgres://… node scripts/clientes/rfm-calibracao.mjs --organization <uuid> [--store <uuid>]
//                                                  [--as-of 2026-09-23T15:00:00Z] [--json saida.json] [--md saida.md]
//
// Garantias:
//   · a sessão inteira é READ ONLY no servidor (`default_transaction_read_only=on` + BEGIN READ ONLY): nada grava;
//   · o escopo é a Organization e a Store informadas (mesmo predicado do painel), e a RLS é ativada via
//     `set_config('app.current_organization_id', …)` quando a role é a da aplicação;
//   · só as colunas necessárias são lidas, e nome/e-mail/telefone/documento nunca são selecionados nem impressos —
//     o documento, o telefone e o e-mail entram só em memória para unir pedidos da mesma pessoa e não saem do processo;
//   · a saída é agregada (contagens, quantis, somas) e amostras com rótulo opaco aleatório (`c_ab12cd34`).
//
// Não há dado sintético aqui: se apontado para um banco vazio, o relatório sai vazio e diz isso.
import fs from 'node:fs';
import { createRequire } from 'node:module';
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

const a = args(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) throw new Error('defina DATABASE_URL (usuário somente leitura, de preferência)');
if (!UUID.test(String(a.organization || ''))) throw new Error('--organization <uuid> é obrigatório');
if (a.store && !UUID.test(String(a.store))) throw new Error('--store deve ser um uuid');
const asOf = a['as-of'] ? new Date(a['as-of']) : new Date();
if (!Number.isFinite(asOf.getTime())) throw new Error('--as-of inválido');

const u = new URL(url);
u.searchParams.set('options', '-c default_transaction_read_only=on');
const client = new pg.Client({ connectionString: u.toString() });
await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  await client.query('SELECT set_config($1, $2, true)', ['app.current_organization_id', a.organization]);

  const stores = (await client.query('SELECT id, loja_legada FROM stores WHERE organization_id = $1 ORDER BY id', [a.organization])).rows;
  if (!stores.length) throw new Error('a Organization não tem Store visível para esta conexão');
  const store = a.store ? stores.find((s) => s.id === a.store) : (stores.length === 1 ? stores[0] : null);
  if (!store) throw new Error(`informe --store (a Organization tem ${stores.length} Stores)`);

  // Mesmo predicado de `escopoDaStore` do painel: Store canônica OU linha legada (sem store_id) da chave legada da Store.
  const { rows } = await client.query(
    `SELECT loja, ink_order_id, buyer_documento, buyer_telefone, buyer_email, payment_status, order_status, total_value, criado_em, is_troca, frete, descontos, items_count
       FROM pedidos_ink
      WHERE organization_id = $1
        AND (store_id = $2 OR ($3::text IS NOT NULL AND store_id IS NULL AND loja = $3))
      ORDER BY criado_em DESC, ink_order_id DESC`,
    [a.organization, store.id, store.loja_legada]
  );
  await client.query('ROLLBACK');

  const relatorio = gerarRelatorio(rows, { asOf, chaveDoContexto: store.loja_legada || store.id });
  // Cabeçalho de proveniência (ids da Organization/Store não são dado pessoal, mas ficam só como hash curto).
  relatorio.metodologia.origem = { linhasLidas: rows.length, organizacao: a.organization.slice(0, 8), store: store.id.slice(0, 8) };
  const md = paraMarkdown(relatorio);
  if (a.json) fs.writeFileSync(String(a.json), `${JSON.stringify(relatorio, null, 2)}\n`);
  if (a.md) fs.writeFileSync(String(a.md), md);
  if (!a.json && !a.md) process.stdout.write(md);
  else process.stderr.write(`relatório gerado (${rows.length} linhas lidas)\n`);
} finally {
  await client.end();
}
