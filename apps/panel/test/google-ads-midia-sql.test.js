'use strict';

// Gasto de mídia do Google Ads somado ao da Meta, contra Postgres real.
//
// O risco aqui é contar duas vezes. A tabela guarda a MESMA despesa em três recortes — nível de
// conta, nível de campanha, e uma linha por régua de conversão. Uma soma que não filtre os dois
// eixos infla o gasto e, como o gasto é subtraído do lucro, mostra prejuízo que não existe.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const URL_TESTE = process.env.GOOGLE_ADS_TEST_DATABASE_URL || process.env.META_TEST_DATABASE_URL;

if (!URL_TESTE) {
  test('mídia google ads em SQL (pulado: defina GOOGLE_ADS_TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const pool = new Pool({ connectionString: URL_TESTE });
  test.after(async () => { await pool.end(); });

  // Mesma consulta que o dashboard usa para o card "Mídia".
  const SOMA_DASHBOARD = `
    SELECT loja, dia, SUM(spend) AS spend FROM (
      SELECT g.loja_atribuida AS loja, to_char(i.data, 'YYYY-MM-DD') AS dia, i.custo AS spend
        FROM google_ads_insights_daily i
        JOIN google_ads_customers g ON g.customer_id = i.customer_id AND g.selecionada
       WHERE i.level = 'customer' AND i.contagem_conversao = 'conversions'
         AND g.loja_atribuida IS NOT NULL
         AND i.data >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($1::int - 1))
    ) t GROUP BY loja, dia ORDER BY dia`;

  const INSERT = `
    INSERT INTO google_ads_insights_daily
      (customer_id, level, entidade_id, data, campaign_id, impressoes, cliques, custo,
       conversoes, valor_conversoes, contagem_conversao)
    VALUES ($1,$2,$3,$4,$5,0,0,$6,0,0,$7)`;

  test.before(async () => {
    await pool.query('DELETE FROM google_ads_insights_daily');
    await pool.query('DELETE FROM google_ads_customers');
    await pool.query(
      `INSERT INTO google_ads_customers (customer_id, selecionada, loja_atribuida) VALUES ('1111111111', true, 'sul')`
    );
    const hoje = new Date().toISOString().slice(0, 10);
    // O MESMO gasto de R$ 100, nos recortes em que a API o devolve.
    await pool.query(INSERT, ['1111111111', 'customer', '1111111111', hoje, null, 100, 'conversions']);
    await pool.query(INSERT, ['1111111111', 'campaign', 'c1', hoje, 'c1', 60, 'conversions']);
    await pool.query(INSERT, ['1111111111', 'campaign', 'c2', hoje, 'c2', 40, 'conversions']);
    await pool.query(INSERT, ['1111111111', 'customer', '1111111111', hoje, null, 100, 'all_conversions']);
  });

  test('o gasto do dia é contado UMA vez, apesar dos quatro recortes', async () => {
    const { rows } = await pool.query(SOMA_DASHBOARD, [7]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].spend), 100,
      'somar conta + campanhas + a outra régua daria 300 de gasto que nunca existiu');
  });

  test('a soma é atribuída à loja da conta', async () => {
    const { rows } = await pool.query(SOMA_DASHBOARD, [7]);
    assert.equal(rows[0].loja, 'sul');
  });

  test('conta sem loja atribuída fica de fora, em vez de somar na loja errada', async () => {
    await pool.query('UPDATE google_ads_customers SET loja_atribuida = NULL WHERE customer_id = $1', ['1111111111']);
    const { rows } = await pool.query(SOMA_DASHBOARD, [7]);
    assert.equal(rows.length, 0, 'sem saber a quem atribuir, o certo é não somar');
    await pool.query('UPDATE google_ads_customers SET loja_atribuida = $2 WHERE customer_id = $1', ['1111111111', 'sul']);
  });

  test('conta não selecionada não entra no gasto', async () => {
    await pool.query('UPDATE google_ads_customers SET selecionada = false WHERE customer_id = $1', ['1111111111']);
    const { rows } = await pool.query(SOMA_DASHBOARD, [7]);
    assert.equal(rows.length, 0);
    await pool.query('UPDATE google_ads_customers SET selecionada = true WHERE customer_id = $1', ['1111111111']);
  });

  test('o consolidado soma o mesmo total que o dashboard', async () => {
    // As duas telas leem a mesma tabela por caminhos diferentes; divergir entre si seria pior que
    // um erro único, porque cada tela "confirmaria" um número diferente.
    const hoje = new Date().toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(custo), 0) AS custo FROM google_ads_insights_daily
        WHERE customer_id = $1 AND level = 'customer' AND contagem_conversao = 'conversions'
          AND data BETWEEN $2 AND $3`,
      ['1111111111', hoje, hoje]
    );
    const dash = await pool.query(SOMA_DASHBOARD, [7]);
    assert.equal(Number(rows[0].custo), Number(dash.rows[0].spend));
  });
}
