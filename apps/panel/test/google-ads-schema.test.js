'use strict';

// Schema do Google Ads contra Postgres real.
//
// O que está sob teste são as INVARIANTES que o banco precisa garantir sozinho, porque disciplina
// de código não sobrevive a um caminho novo escrito daqui a seis meses: nunca duas contas
// selecionadas, sync idempotente (rodar duas vezes não duplica gasto), e conversão fracionária
// sobrevivendo ao round-trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const URL_TESTE = process.env.GOOGLE_ADS_TEST_DATABASE_URL || process.env.META_TEST_DATABASE_URL;

if (!URL_TESTE) {
  test('schema google ads (pulado: defina GOOGLE_ADS_TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const pool = new Pool({ connectionString: URL_TESTE });
  test.after(async () => { await pool.end(); });

  // O schema vem das migrations (scripts/test-db.mjs aplica todas). Este arquivo reaplicava o
  // trecho do baseline no banco compartilhado — o que, depois da Fase 1, recriava a UNIQUE global
  // de "conta selecionada" que a migration de chaves removeu. Pego pelo gate INV-05.

  async function limpar() {
    await pool.query('DELETE FROM google_ads_insights_daily');
    await pool.query('DELETE FROM google_ads_customers');
  }

  // ── Conta selecionada ─────────────────────────────────────────────────────────────────────

  test('nunca duas contas selecionadas ao mesmo tempo', async () => {
    await limpar();
    await pool.query(`INSERT INTO google_ads_customers (customer_id, selecionada) VALUES ('1111111111', true)`);
    await assert.rejects(
      () => pool.query(`INSERT INTO google_ads_customers (customer_id, selecionada) VALUES ('2222222222', true)`),
      /uq_google_ads_customers_selecionada|duplicate key/,
      'o "só uma principal" precisa ser invariante do banco, não disciplina de código'
    );
  });

  test('várias contas NÃO selecionadas convivem', async () => {
    await limpar();
    await pool.query(`INSERT INTO google_ads_customers (customer_id, selecionada) VALUES ('1111111111', false)`);
    await pool.query(`INSERT INTO google_ads_customers (customer_id, selecionada) VALUES ('2222222222', false)`);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM google_ads_customers');
    assert.equal(rows[0].n, 2, 'o índice é parcial: só restringe quem está selecionada');
  });

  test('a mesma conta não entra duas vezes', async () => {
    await limpar();
    await pool.query(`INSERT INTO google_ads_customers (customer_id) VALUES ('1111111111')`);
    await assert.rejects(
      () => pool.query(`INSERT INTO google_ads_customers (customer_id) VALUES ('1111111111')`),
      /duplicate key/
    );
  });

  // ── Sync idempotente ──────────────────────────────────────────────────────────────────────

  const UPSERT = `
    INSERT INTO google_ads_insights_daily
      (customer_id, level, entidade_id, data, campaign_id, impressoes, cliques, custo,
       conversoes, valor_conversoes, contagem_conversao)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (organization_id, customer_id, level, entidade_id, data, contagem_conversao) DO UPDATE SET
      impressoes = EXCLUDED.impressoes, cliques = EXCLUDED.cliques, custo = EXCLUDED.custo,
      conversoes = EXCLUDED.conversoes, valor_conversoes = EXCLUDED.valor_conversoes,
      atualizado_em = now()
    RETURNING (xmax = 0) AS inserido`;

  test('rodar o sync duas vezes não duplica gasto', async () => {
    await limpar();
    const args = ['1111111111', 'customer', '1111111111', '2026-09-10', null, 1000, 17, 8.5, 2, 300, 'conversions'];
    const a = await pool.query(UPSERT, args);
    assert.equal(a.rows[0].inserido, true);
    const b = await pool.query(UPSERT, args);
    assert.equal(b.rows[0].inserido, false, 'a segunda passada atualiza, não insere');

    const { rows } = await pool.query('SELECT count(*)::int AS n, sum(custo) AS custo FROM google_ads_insights_daily');
    assert.equal(rows[0].n, 1);
    assert.equal(Number(rows[0].custo), 8.5, 'gasto dobrado num painel financeiro é o pior tipo de bug');
  });

  test('re-sincronizar um dia corrige o valor em vez de somar', async () => {
    await limpar();
    const base = ['1111111111', 'customer', '1111111111', '2026-09-10', null];
    await pool.query(UPSERT, [...base, 1000, 17, 8.5, 2, 300, 'conversions']);
    // O Google revisa números por alguns dias; a re-sincronização precisa refletir a correção.
    await pool.query(UPSERT, [...base, 1100, 19, 9.2, 3, 420, 'conversions']);
    const { rows } = await pool.query('SELECT custo, conversoes, valor_conversoes FROM google_ads_insights_daily');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].custo), 9.2);
    assert.equal(Number(rows[0].valor_conversoes), 420);
  });

  test('contagens de conversão diferentes convivem no mesmo dia', async () => {
    await limpar();
    const base = ['1111111111', 'customer', '1111111111', '2026-09-10', null];
    await pool.query(UPSERT, [...base, 1000, 17, 8.5, 2, 300, 'conversions']);
    await pool.query(UPSERT, [...base, 1000, 17, 8.5, 3.5, 450, 'all_conversions']);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM google_ads_insights_daily');
    assert.equal(rows[0].n, 2, 'são réguas diferentes do mesmo dia, não duplicata');

    // E somar as duas é justamente o erro que a régua na chave existe para tornar visível.
    const { rows: soma } = await pool.query(
      `SELECT sum(conversoes) AS todas,
              sum(conversoes) FILTER (WHERE contagem_conversao = 'conversions') AS so_primarias
         FROM google_ads_insights_daily`
    );
    assert.equal(Number(soma[0].todas), 5.5, 'somar as duas réguas dá um número que não existe');
    assert.equal(Number(soma[0].so_primarias), 2, 'a leitura sempre filtra uma régua só');
  });

  // ── Tipos ─────────────────────────────────────────────────────────────────────────────────

  test('conversão fracionária sobrevive ao banco', async () => {
    await limpar();
    await pool.query(UPSERT, ['1111111111', 'customer', '1111111111', '2026-09-10', null, 0, 0, 0, 0.5, 50, 'conversions']);
    const { rows } = await pool.query('SELECT conversoes FROM google_ads_insights_daily');
    assert.equal(Number(rows[0].conversoes), 0.5, 'BIGINT aqui arredondaria meia venda para zero');
  });

  test('custo guarda centavos sem perder precisão', async () => {
    await limpar();
    // 12.345678 micros-derived: NUMERIC não pode truncar como um INTEGER faria.
    await pool.query(UPSERT, ['1111111111', 'customer', '1111111111', '2026-09-10', null, 0, 0, 12.345678, 0, 0, 'conversions']);
    const { rows } = await pool.query('SELECT custo FROM google_ads_insights_daily');
    assert.equal(Number(rows[0].custo), 12.345678);
  });

  test('vídeo ausente fica NULL, não zero', async () => {
    await limpar();
    await pool.query(UPSERT, ['1111111111', 'customer', '1111111111', '2026-09-10', null, 0, 0, 0, 0, 0, 'conversions']);
    const { rows } = await pool.query('SELECT video_views FROM google_ads_insights_daily');
    assert.equal(rows[0].video_views, null, '"0 visualizações" sugere vídeo que ninguém viu');
  });

  test('a data volta como dia, sem hora fantasma de fuso', async () => {
    await limpar();
    await pool.query(UPSERT, ['1111111111', 'customer', '1111111111', '2026-09-10', null, 0, 0, 0, 0, 0, 'conversions']);
    // DATE lida como timestamp vira meia-noite UTC e, em BRT, o dia anterior — armadilha já vista
    // no log de sync do Meta. to_char é o que garante o dia certo.
    const { rows } = await pool.query(`SELECT to_char(data, 'YYYY-MM-DD') AS dia FROM google_ads_insights_daily`);
    assert.equal(rows[0].dia, '2026-09-10');
  });
}
