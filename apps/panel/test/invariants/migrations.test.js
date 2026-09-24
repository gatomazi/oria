'use strict';

// Migrations (TD-010 · Fase 0) — as propriedades que precisam valer no pre-deploy do Railway.
//
// A mais importante é a última: **aplicar as migrations sobre a base que JÁ EXISTE em produção não
// pode destruir nada.** O baseline é o DDL que `bootstrapPostgres()` já rodava a cada subida, então
// o banco de produção está, hoje, no estado que a migration `0001` produz. Se aplicá-la ali
// apagasse ou recriasse uma tabela, o primeiro `npm run migrate:up` em produção seria uma perda de
// dados — e o teste que prova o contrário é este.
//
// Cada caso roda contra um banco NOVO, criado e derrubado aqui. Nenhum toca o banco compartilhado.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const h = require('./harness');
const { ddlBaseline, ddlCreativeCore } = require('../helpers/schema-sql');

const RAIZ = h.RAIZ_REPO;
const CLI = path.join(RAIZ, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js');

// `posicionais` vão DEPOIS do comando: é assim que a CLI 9.0.0 lê a contagem (`up 5`). Um
// `--count` antes do comando é aceito e ignorado em silêncio — não usar.
function migrar(url, comando = 'up', extra = [], posicionais = [], env = {}) {
  return spawnSync(
    process.execPath,
    [CLI, '--migrations-dir', path.join(RAIZ, 'migrations'),
      '--ignore-pattern', '(README\\.md|sql|sql/.*)', ...extra, comando, ...posicionais],
    { cwd: RAIZ, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, ...env }, timeout: 120000 }
  );
}

const MAPEAMENTO_A = path.join(RAIZ, 'test', 'fixtures', 'tenancy', 'cenario-a.json');

// Cria um banco descartável ao lado do banco de teste e devolve { url, destruir }.
async function bancoNovo() {
  const base = h.urlDoBanco();
  const nome = `oria_mig_${crypto.randomBytes(5).toString('hex')}`;
  const admin = h.abrirPoolDescartavel(base.replace(/\/[^/]+$/, '/postgres'));
  await admin.query(`CREATE DATABASE ${nome}`);
  const url = base.replace(/\/[^/]+$/, `/${nome}`);
  return {
    url,
    async destruir() {
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      await admin.end();
    },
  };
}

async function tabelas(pool) {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

test('migrations · do zero, num banco vazio, aplicam todas na ordem', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  const r = migrar(db.url);
  assert.equal(r.status, 0, `migrate up falhou:\n${r.stdout}${r.stderr}`);

  const pool = h.abrirPoolDescartavel(db.url);
  try {
    const { rows } = await pool.query('SELECT name FROM pgmigrations ORDER BY id');
    assert.deepEqual(rows.map((m) => m.name), [
      '1789509600000_baseline-schema',
      '1789509660000_backfill-pedidos-json',
      '1789509720000_backfill-payment-status-portugues',
      '1789509780000_backfill-public-token-media',
      '1789509840000_integration-secrets',
      '1789509900000_creative-core-schema',
      '1789600000000_tenancy-plataforma',
      '1789600060000_tenancy-colunas',
      '1789600120000_tenancy-mapeamento',
      '1789600180000_tenancy-backfill',
      '1789600240000_tenancy-constraints',
      '1789600300000_tenancy-triggers',
      '1789600360000_tenancy-rls',
      '1789600420000_tenancy-chaves',
      '1789700000000_auth-identidade',
      '1789800000000_tenant-context',
      '1789900000000_integrations',
      '1790000000000_whatsapp-inbound',
      '1790000060000_ink-webhook-token',
      '1790000120000_job-leases',
      '1790000300000_onboarding',
      '1790000400000_platform-admin',
      '1790000500000_convite-aceite',
      '1790000600000_store-id-connector-ink',
      '1790000800000_entitlement-canonico',
      '1790000900000_composicao-do-internal',
      '1790001000000_midia-store-id',
      '1790001100000_catalogo-ink-store-id',
      '1790001200000_ga4-store-id',
      '1790001300000_oauth-state-whatsapp',
      '1790001400000_campanhas-store-id',
      '1790001500000_reparar-loja-uuid-em-pedidos',
      '1790001600000_commerce-catalog',
      '1790001700000_product-external-identities',
      '1790001800000_entitlement-product-performance',
      // Fase C · Gerador de Criativos (renumeradas na integração para depois de entitlement-product-
      // performance — as duas branches usaram o mesmo intervalo de timestamps independentemente).
      '1790001900000_creative-trace',
      '1790002000000_creative-plan-v2',
      '1790002100000_creative-feedback',
      '1790002200000_creative-angles',
      '1790002300000_creative-angles-compat',
      '1790002400000_creative-enrichment',
      '1790002500000_creative-enrichment-provider-meta',
      '1790002600000_creative-enrichment-pilot-budget',
    ]);
    assert.ok((await tabelas(pool)).includes('integration_secrets'));
  } finally { await pool.end(); }
});

test('migrations · rodar de novo é no-op (é o que o pre-deploy faz a cada deploy)', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  assert.equal(migrar(db.url).status, 0);
  const pool = h.abrirPoolDescartavel(db.url);
  try {
    const antes = await tabelas(pool);
    for (let i = 0; i < 3; i += 1) {
      const r = migrar(db.url);
      assert.equal(r.status, 0, `a ${i + 2}ª aplicação falhou:\n${r.stdout}${r.stderr}`);
      assert.match(r.stdout, /No migrations to run!/);
    }
    assert.deepEqual(await tabelas(pool), antes, 'o schema mudou entre aplicações repetidas');
  } finally { await pool.end(); }
});

test('migrations · integration-secrets é revertível e reaplicável (critério de saída 1 da Fase 0)', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  // Para exatamente em integration-secrets (a 5ª): a seguinte, creative-core-schema, é irreversível
  // de propósito, e o `down` precisa mirar a migration reversível, não a última da pasta.
  assert.equal(migrar(db.url, 'up', [], ['5']).status, 0);
  const pool = h.abrirPoolDescartavel(db.url);
  try {
    assert.ok((await tabelas(pool)).includes('integration_secrets'));

    const down = migrar(db.url, 'down');
    assert.equal(down.status, 0, `migrate down falhou:\n${down.stdout}${down.stderr}`);
    const depoisDoDown = await tabelas(pool);
    assert.ok(!depoisDoDown.includes('integration_secrets'));
    assert.ok(!depoisDoDown.includes('integrations'));
    assert.ok(depoisDoDown.includes('pedidos_ink'), 'o down não pode levar o baseline junto');

    assert.equal(migrar(db.url).status, 0);
    const depois = await tabelas(pool);
    assert.ok(depois.includes('integration_secrets'));
    assert.ok(depois.includes('creative_generations'));
  } finally { await pool.end(); }
});

test('migrations · o baseline é irreversível e diz por quê, em vez de apagar o schema', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  assert.equal(migrar(db.url, 'up', [], ['1']).status, 0);
  const r = migrar(db.url, 'down');
  assert.notEqual(r.status, 0, 'reverter o baseline precisa FALHAR, não apagar o banco');
  assert.match(`${r.stdout}${r.stderr}`, /baseline-schema é irreversível/);

  const pool = h.abrirPoolDescartavel(db.url);
  try {
    assert.ok((await tabelas(pool)).includes('pedidos_ink'), 'o schema sobreviveu à tentativa de reverter');
  } finally { await pool.end(); }
});

test('migrations · creative-core-schema é irreversível e preserva as tabelas', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  // Para em creative-core-schema (a 6ª): as da Fase 1 depois dela são reversíveis.
  assert.equal(migrar(db.url, 'up', [], ['6']).status, 0);
  const r = migrar(db.url, 'down');
  assert.notEqual(r.status, 0, 'reverter creative-core-schema precisa FALHAR');
  assert.match(`${r.stdout}${r.stderr}`, /creative-core-schema é irreversível/);

  const pool = h.abrirPoolDescartavel(db.url);
  try {
    assert.ok((await tabelas(pool)).includes('creative_generations'));
  } finally { await pool.end(); }
});

test('migrations · aplicadas sobre a base que JÁ EXISTE em produção não destroem dados', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  const pool = h.abrirPoolDescartavel(db.url);
  try {
    // Reproduz o estado de produção: o DDL que `bootstrapPostgres()` já rodava a cada boot,
    // aplicado SEM nenhuma migration registrada — que é exatamente onde o banco real está hoje.
    await pool.query(ddlBaseline());
    // O DDL do Gerador de Criativos também rodava no boot (mount de routes/criativos.js).
    await pool.query(ddlCreativeCore());
    await pool.query(
      `INSERT INTO creative_settings (tenant_id, openai_key_last4) VALUES ('default', 'abcd')`
    );

    await pool.query(
      `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, buyer_nome, total_value, criado_em)
       VALUES ('sul', 1982524, 'Pago', 'Cliente Real', 199.90, now())`
    );
    // Mídia gravada ANTES de `public_token` existir — é o caso que o backfill 0004 atende.
    await pool.query(
      `INSERT INTO media_assets (loja, kind, filename, original_filename, mime_type, size_bytes, storage_key)
       VALUES ('sul','template_sample','amostra.png','amostra.png','image/png',1024,'uploads/amostra.png')`
    );
    await pool.query(
      `INSERT INTO app_config (chave, valor) VALUES ('entitlements', '{"criativos":true}'::jsonb)`
    );

    // Agora o primeiro `npm run migrate:up` da vida deste banco — com o mapeamento explícito de
    // tenancy que produção vai exigir (a base tem dado; sem ele a Fase 1 aborta).
    const r = migrar(db.url, 'up', [], [], { TENANCY_MAPPING_FILE: MAPEAMENTO_A });
    assert.equal(r.status, 0, `migrate up sobre base existente falhou:\n${r.stdout}${r.stderr}`);

    // Nada foi perdido...
    const { rows: pedidos } = await pool.query('SELECT buyer_nome, payment_status FROM pedidos_ink');
    assert.equal(pedidos.length, 1);
    assert.equal(pedidos[0].buyer_nome, 'Cliente Real');
    // ...e o backfill de payment_status fez o trabalho dele: "Pago" virou o enum canônico.
    assert.equal(pedidos[0].payment_status, 'paid',
      'a migration de backfill precisa normalizar o rótulo em português da linha já existente');

    const { rows: creative } = await pool.query('SELECT openai_key_last4, organization_id, tenant_id FROM creative_settings');
    // Fase 3 (INV-22): o rótulo da instalação ('default') virou o id da Organization dona.
    assert.deepEqual(creative, [{
      openai_key_last4: 'abcd',
      organization_id: 'a1000000-0000-4000-8000-000000000001',
      tenant_id: 'a1000000-0000-4000-8000-000000000001',
    }]);
    const { rows: donoPedido } = await pool.query('SELECT organization_id FROM pedidos_ink');
    assert.equal(donoPedido[0].organization_id, 'a1000000-0000-4000-8000-000000000001', 'pedido da loja sul → Organization da Sul');

    const { rows: cfg } = await pool.query(`SELECT valor FROM app_config WHERE chave = 'entitlements'`);
    assert.deepEqual(cfg[0].valor, { criativos: true });

    // O backfill de public_token preencheu a mídia que estava sem token.
    const { rows: midia } = await pool.query('SELECT public_token FROM media_assets');
    if (midia.length) {
      assert.ok(midia[0].public_token, 'a mídia sem public_token precisava ser preenchida');
      assert.match(midia[0].public_token, /^[0-9a-f]{48}$/);
    }

    // E as tabelas novas nasceram.
    assert.ok((await tabelas(pool)).includes('integration_secrets'));
  } finally { await pool.end(); }
});

// ── Concorrência e falha — provadas contra a versão INSTALADA, não pela documentação ─────────────
// node-pg-migrate 9.0.0 (dist/bundle): antes de ler `pgmigrations`, o runner faz
// `pg_try_advisory_lock(7241865325823964)`; em modo `fail` (default da CLI) lança se não obtiver, e
// a CLI sai com 1. Advisory lock é por banco, então o teste segura a chave no MESMO banco.
const PG_MIGRATE_LOCK_ID = '7241865325823964';

test('migrations · com o advisory lock ocupado, um segundo migrate:up falha e não aplica nada', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  const outro = h.abrirPoolDescartavel(db.url, { max: 1 });
  const conexao = await outro.connect();
  try {
    const { rows } = await conexao.query(`SELECT pg_try_advisory_lock(${PG_MIGRATE_LOCK_ID}) AS ok`);
    assert.equal(rows[0].ok, true, 'o teste precisa segurar o lock antes de migrar');

    const r = migrar(db.url);
    assert.notEqual(r.status, 0, 'migração concorrente precisa falhar, não rodar em paralelo');
    assert.match(`${r.stdout}${r.stderr}`, /Another migration is already running/);

    const { rows: controle } = await conexao.query(`SELECT to_regclass('public.pgmigrations') IS NOT NULL AS existe`);
    assert.equal(controle[0].existe, false, 'nada pode ter sido aplicado sem o lock');
  } finally {
    await conexao.query(`SELECT pg_advisory_unlock(${PG_MIGRATE_LOCK_ID})`);
    conexao.release();
    await outro.end();
  }

  // Lock liberado: a mesma chamada passa. Prova que a falha acima foi o lock, não outra coisa.
  assert.equal(migrar(db.url).status, 0);
});

test('migrations · nenhum script npm desliga o lock nem a transação única', () => {
  const { scripts } = require(path.join(RAIZ, 'package.json'));
  const migrate = Object.entries(scripts).filter(([, cmd]) => cmd.includes('node-pg-migrate'));
  assert.ok(migrate.some(([nome]) => nome === 'migrate:up'), 'migrate:up precisa existir (OPS-11)');
  for (const [nome, cmd] of migrate) {
    assert.doesNotMatch(cmd, /--no-lock|--lock[= ]false|--no-single-transaction|--single-transaction[= ]false/,
      `${nome} desliga uma proteção: ${cmd}`);
  }
});

test('migrations · migration que falha → exit ≠ 0 e rollback do lote inteiro', async (t) => {
  const db = await bancoNovo();
  t.after(() => db.destruir());

  const fs = require('node:fs');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-mig-quebrada-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '1_cria.js'),
    "exports.up = (pgm) => { pgm.sql('CREATE TABLE antes_da_falha (id int)'); };\n");
  fs.writeFileSync(path.join(dir, '2_quebra.js'),
    "exports.up = (pgm) => { pgm.sql('SELECT 1/0'); };\n");

  const r = spawnSync(process.execPath, [CLI, '--migrations-dir', dir, 'up'], {
    cwd: RAIZ, encoding: 'utf8', env: { ...process.env, DATABASE_URL: db.url }, timeout: 120000,
  });
  assert.notEqual(r.status, 0, `migration quebrada saiu com 0:\n${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /division by zero/);

  const pool = h.abrirPoolDescartavel(db.url);
  try {
    const nomes = await tabelas(pool);
    assert.ok(!nomes.includes('antes_da_falha'), 'single-transaction: a migration anterior do lote também volta');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pgmigrations');
    assert.equal(rows[0].n, 0, 'nenhuma migration pode ficar registrada como aplicada');
  } finally { await pool.end(); }
});

// Havia aqui um teste exigindo que migrations/README.md explicasse a diferença entre esta pasta e
// `scripts/migracao-*.mjs` (os nomes eram quase iguais). Aqueles scripts eram da migração de
// catálogo da Use Origens, pontual, e saíram do repositório junto com o site — não existe mais
// ambiguidade a desfazer, e o parágrafo do README saiu junto.

test('migrations · nenhum DDL nem backfill roda no boot (critério de saída 4 da Fase 0)', () => {
  const fs = require('node:fs');

  // Todo código carregado pelo processo do app, não só server.js: o DDL do Gerador de Criativos
  // escapou do primeiro corte justamente por morar em lib/creative-core/ e rodar no mount da rota.
  function arquivosJs(dir) {
    const abs = path.join(RAIZ, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile() && /\.(c|m)?js$/.test(e.name))
      .map((e) => path.join(e.parentPath ?? e.path, e.name));
  }
  const arquivos = [path.join(RAIZ, 'server.js'), ...['lib', 'routes', 'services'].flatMap(arquivosJs)];
  assert.ok(arquivos.length > 10, `varredura vazia demais: ${arquivos.length} arquivos`);

  // DDL de evolução de schema. Não pega `CREATE TEMP TABLE` (escopo de sessão, não é evolução).
  const ddl = /\b(CREATE\s+(UNIQUE\s+)?INDEX|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+(TABLE|INDEX|COLUMN)|CREATE\s+(EXTENSION|SCHEMA|TYPE)|ADD\s+COLUMN)\b/i;
  const nomesAntigos = [
    'bootstrapPostgres',
    'backfillPedidosSeNecessario',
    'backfillPaymentStatusPortugues',
    'backfillPublicTokenMedia',
    'bootstrapCreativeSchema',
  ];

  const violacoes = [];
  for (const arquivo of arquivos) {
    const linhas = fs.readFileSync(arquivo, 'utf8').split('\n');
    linhas.forEach((linha, i) => {
      const t = linha.trimStart();
      // Comentários CITAM os nomes antigos de propósito, para explicar o que saiu.
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('--')) return;
      if (ddl.test(linha) || nomesAntigos.some((n) => linha.includes(n))) {
        violacoes.push(`${path.relative(RAIZ, arquivo)}:${i + 1}: ${t.slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(violacoes, [], `DDL/backfill voltou ao código do app:\n${violacoes.join('\n')}`);
});
