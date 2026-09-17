'use strict';

// Teste de integração do schema e das queries do módulo Meta contra um Postgres DE VERDADE
// (docs/meta-ads-analytics-integracao-v2.md §67). Sem banco, `npm test` pularia silenciosamente e
// um erro de SQL só apareceria em produção — por isso este arquivo exige META_TEST_DATABASE_URL
// para rodar e é pulado explicitamente (com aviso) quando ela não existe.
//
// Como rodar:
//   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=teste --name meta-pg postgres:16-alpine
//   META_TEST_DATABASE_URL=postgres://postgres:teste@localhost:55432/postgres npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { ddlBaseline } = require('./helpers/schema-sql');

const URL_TESTE = process.env.META_TEST_DATABASE_URL;

if (!URL_TESTE) {
  test('schema Meta (pulado: defina META_TEST_DATABASE_URL para rodar contra um Postgres real)', { skip: true }, () => {});
} else {
  const pool = new Pool({ connectionString: URL_TESTE });
  const CONTA = 'act_9999';

  test.after(async () => { await pool.end(); });

  // O baseline é validado num banco PRÓPRIO, criado e derrubado aqui. Antes da Fase 1 este teste
  // derrubava e recriava as tabelas Meta no banco compartilhado — com a tenancy, isso apagaria
  // organization_id e RLS delas no meio da suíte.
  async function comBancoDescartavel(fn) {
    const crypto = require('crypto');
    const nome = `oria_meta_${crypto.randomBytes(5).toString('hex')}`;
    const admin = new Pool({ connectionString: URL_TESTE.replace(/\/[^/]+$/, '/postgres') });
    admin.on('error', () => {});
    await admin.query(`CREATE DATABASE ${nome}`);
    const banco = new Pool({ connectionString: URL_TESTE.replace(/\/[^/]+$/, `/${nome}`) });
    banco.on('error', () => {});
    try {
      await fn(banco);
    } finally {
      await banco.end();
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      await admin.end();
    }
  }

  test('o DDL da migration baseline cria todas as tabelas Meta sem erro', async () => {
    // Desde a Fase 0 o schema mora em `migrations/`, não no boot do server.js — o teste roda contra
    // o DDL REAL que as migrations aplicam, nunca contra uma cópia que envelheceu.
    const sql = ddlBaseline();
    assert.ok(sql.includes('meta_insights_daily'), 'o baseline não contém as tabelas Meta');

    await comBancoDescartavel(async (banco) => {
      await banco.query(sql); // se qualquer DDL for inválido, isto estoura aqui
      const { rows } = await banco.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'meta_%' ORDER BY table_name`
      );
      assert.deepEqual(rows.map((r) => r.table_name), [
        'meta_ad_accounts', 'meta_ads', 'meta_adsets', 'meta_campaigns',
        'meta_connections', 'meta_creatives', 'meta_insights_daily', 'meta_sync_logs',
      ]);
    });
  });

  // A idempotência do baseline deixou de ser "o que acontece a cada boot" (não roda mais no boot)
  // e passou a ser o que garante que aplicá-lo sobre a base de produção já existente é um no-op.
  test('o DDL do baseline é idempotente — aplicar duas vezes não quebra', async () => {
    const sql = ddlBaseline();
    await comBancoDescartavel(async (banco) => {
      await banco.query(sql);
      await banco.query(sql);
    });
  });

  // Fase 1 (INV-06): a conexão deixou de ser "uma por instalação" (CHECK id = 1) e passou a ser
  // "uma por Organization". O dono vem do mapeamento explícito meta:* do banco de teste.
  test('meta_connections aceita uma conexão por Organization — a segunda da mesma é recusada', async () => {
    await pool.query('DELETE FROM meta_connections');
    await pool.query(`INSERT INTO meta_connections (id, status) VALUES (1, 'connected') ON CONFLICT (organization_id) DO UPDATE SET status = 'connected'`);
    await assert.rejects(
      () => pool.query(`INSERT INTO meta_connections (status) VALUES ('connected')`),
      /duplicate key value violates unique constraint "uq_meta_connections_org"/,
      'a UNIQUE (organization_id) é o que garante 1 Organization = 1 conexão'
    );
  });

  test('só uma conta de anúncios pode estar selecionada ao mesmo tempo', async () => {
    await pool.query('DELETE FROM meta_ad_accounts');
    await pool.query(`INSERT INTO meta_ad_accounts (meta_account_id, nome, selecionada) VALUES ($1,'Use Origens', true)`, [CONTA]);
    await assert.rejects(
      () => pool.query(`INSERT INTO meta_ad_accounts (meta_account_id, nome, selecionada) VALUES ('act_8888','Outra', true)`),
      /duplicate key value violates unique constraint/
    );
    // Trocar de conta funciona quando desmarca antes — que é o que a rota select-account faz numa transação.
    await pool.query('UPDATE meta_ad_accounts SET selecionada = false WHERE selecionada');
    await pool.query(`INSERT INTO meta_ad_accounts (meta_account_id, nome, selecionada) VALUES ('act_8888','Outra', true)`);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM meta_ad_accounts WHERE selecionada');
    assert.equal(rows[0].n, 1);
  });

  test('snapshot duplicado é impedido inclusive no nível account (onde campaign/adset/ad são NULL)', async () => {
    await pool.query('DELETE FROM meta_insights_daily');
    const inserir = () => pool.query(
      `INSERT INTO meta_insights_daily (meta_account_id, level, entidade_id, data, attribution_setting, spend)
       VALUES ($1,'account',$1,'2026-09-10','unified', 100)`,
      [CONTA]
    );
    await inserir();
    await assert.rejects(inserir, /duplicate key value violates unique constraint/,
      'sem a coluna entidade_id NOT NULL, os NULLs fariam o Postgres tratar as duas linhas como distintas');
  });

  test('upsert de insight atualiza em vez de duplicar, e RETURNING distingue criado de atualizado', async () => {
    await pool.query('DELETE FROM meta_insights_daily');
    const upsert = (spend) => pool.query(
      `INSERT INTO meta_insights_daily (meta_account_id, level, entidade_id, data, attribution_setting, spend, purchases, purchase_value)
       VALUES ($1,'ad','ad_1','2026-09-10','unified',$2, 2, 300)
       ON CONFLICT (organization_id, meta_account_id, level, entidade_id, data, attribution_setting)
       DO UPDATE SET spend = EXCLUDED.spend, atualizado_em = now()
       RETURNING (xmax = 0) AS inserido`,
      [CONTA, spend]
    );
    assert.equal((await upsert(100)).rows[0].inserido, true);
    assert.equal((await upsert(150)).rows[0].inserido, false, 'conversão tardia reescreve o dia, não cria linha nova');
    const { rows } = await pool.query('SELECT count(*)::int AS n, max(spend) AS spend FROM meta_insights_daily');
    assert.equal(rows[0].n, 1);
    assert.equal(Number(rows[0].spend), 150);
  });

  test('a query de soma por período devolve os totais certos', async () => {
    await pool.query('DELETE FROM meta_insights_daily');
    await pool.query(
      `INSERT INTO meta_insights_daily (meta_account_id, level, entidade_id, data, attribution_setting, impressions, clicks, spend, purchases, purchase_value) VALUES
        ($1,'account',$1,'2026-09-10','unified', 100, 10, 10, 1, 100),
        ($1,'account',$1,'2026-09-11','unified', 10000, 100, 190, 4, 300),
        ($1,'account',$1,'2026-08-01','unified', 999999, 999, 999, 99, 9999)`,
      [CONTA]
    );
    const { rows } = await pool.query(
      `SELECT SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(spend) AS spend,
              SUM(purchases) AS purchases, SUM(purchase_value) AS purchase_value
       FROM meta_insights_daily WHERE meta_account_id = $1 AND level = 'account' AND data BETWEEN $2 AND $3`,
      [CONTA, '2026-09-10', '2026-09-11']
    );
    const r = rows[0];
    assert.equal(Number(r.impressions), 10100, 'a linha de agosto não pode entrar no período de setembro');
    assert.equal(Number(r.clicks), 110);
    assert.equal(Number(r.spend), 200);
    assert.equal(Number(r.purchases), 5);
    assert.equal(Number(r.purchase_value), 400);
  });

  test('a query de entidades junta nome/status e agrupa sem erro de GROUP BY nos três níveis', async () => {
    await pool.query('DELETE FROM meta_insights_daily');
    await pool.query('DELETE FROM meta_ads');
    await pool.query('DELETE FROM meta_adsets');
    await pool.query('DELETE FROM meta_campaigns');
    await pool.query('DELETE FROM meta_creatives');
    await pool.query(`INSERT INTO meta_campaigns (meta_account_id, meta_campaign_id, nome, status, effective_status, objective) VALUES ($1,'c1','Cidades SC','ACTIVE','ACTIVE','OUTCOME_SALES')`, [CONTA]);
    await pool.query(`INSERT INTO meta_adsets (meta_account_id, meta_campaign_id, meta_adset_id, nome, status, effective_status, optimization_goal) VALUES ($1,'c1','s1','SC 25-45','ACTIVE','ACTIVE','OFFSITE_CONVERSIONS')`, [CONTA]);
    await pool.query(`INSERT INTO meta_creatives (meta_account_id, meta_creative_id, nome, thumbnail_url) VALUES ($1,'cr1','Criativo A','https://exemplo/t.jpg')`, [CONTA]);
    await pool.query(`INSERT INTO meta_ads (meta_account_id, meta_campaign_id, meta_adset_id, meta_creative_id, meta_ad_id, nome, status, effective_status) VALUES ($1,'c1','s1','cr1','a1','Anúncio A','ACTIVE','ACTIVE')`, [CONTA]);
    for (const [level, campanha, adset, ad] of [['campaign', 'c1', null, null], ['adset', 'c1', 's1', null], ['ad', 'c1', 's1', 'a1']]) {
      await pool.query(
        `INSERT INTO meta_insights_daily (meta_account_id, level, entidade_id, data, attribution_setting, meta_campaign_id, meta_adset_id, meta_ad_id, impressions, clicks, spend, purchases, purchase_value)
         VALUES ($1,$2,$3,'2026-09-10','unified',$4,$5,$6, 1000, 50, 120, 3, 480)`,
        [CONTA, level, ad || adset || campanha, campanha, adset, ad]
      );
    }

    const COLUNAS = ['impressions', 'clicks', 'spend', 'purchases', 'purchase_value'];
    const CFG = {
      campaign: {
        coluna: 'meta_campaign_id',
        joins: 'LEFT JOIN meta_campaigns e ON e.meta_campaign_id = i.meta_campaign_id',
        selecao: 'e.nome, e.status, e.effective_status, e.objective, NULL::text AS pai_id, NULL::text AS pai_nome, NULL::text AS thumbnail_url',
        agrupamento: 'e.nome, e.status, e.effective_status, e.objective',
      },
      adset: {
        coluna: 'meta_adset_id',
        joins: `LEFT JOIN meta_adsets e ON e.meta_adset_id = i.meta_adset_id
                LEFT JOIN meta_campaigns p ON p.meta_campaign_id = e.meta_campaign_id`,
        selecao: 'e.nome, e.status, e.effective_status, e.optimization_goal AS objective, p.meta_campaign_id AS pai_id, p.nome AS pai_nome, NULL::text AS thumbnail_url',
        agrupamento: 'e.nome, e.status, e.effective_status, e.optimization_goal, p.meta_campaign_id, p.nome',
      },
      ad: {
        coluna: 'meta_ad_id',
        joins: `LEFT JOIN meta_ads e ON e.meta_ad_id = i.meta_ad_id
                LEFT JOIN meta_adsets p ON p.meta_adset_id = e.meta_adset_id
                LEFT JOIN meta_creatives c ON c.meta_creative_id = e.meta_creative_id`,
        selecao: 'e.nome, e.status, e.effective_status, NULL::text AS objective, p.meta_adset_id AS pai_id, p.nome AS pai_nome, c.thumbnail_url',
        agrupamento: 'e.nome, e.status, e.effective_status, p.meta_adset_id, p.nome, c.thumbnail_url',
      },
    };

    for (const [level, cfg] of Object.entries(CFG)) {
      const { rows } = await pool.query(
        `SELECT i.${cfg.coluna} AS entidade_id, ${cfg.selecao}, ${COLUNAS.map((c) => `SUM(i.${c}) AS ${c}`).join(', ')}
         FROM meta_insights_daily i
         ${cfg.joins}
         WHERE i.meta_account_id = $1 AND i.level = $2 AND i.data BETWEEN $3 AND $4 AND i.${cfg.coluna} IS NOT NULL
         GROUP BY i.${cfg.coluna}, ${cfg.agrupamento}
         ORDER BY SUM(i.spend) DESC`,
        [CONTA, level, '2026-09-01', '2026-09-30']
      );
      assert.equal(rows.length, 1, `${level}: esperava 1 linha agregada`);
      assert.equal(Number(rows[0].spend), 120, `${level}: soma de gasto errada`);
      assert.ok(rows[0].nome, `${level}: o JOIN não trouxe o nome da entidade`);
    }
  });

  // ── Pipeline completo, com uma Meta falsa ────────────────────────────────────────────────
  // Este é o teste que prova que a integração funciona de ponta a ponta: sobe um servidor HTTP que
  // responde como a Graph API (inclusive paginando), passa pelo MetaClient de verdade, pelo
  // normalizador de verdade e grava no Postgres de verdade — e então lê de volta pelas mesmas
  // queries que as rotas do painel usam.

  test('ponta a ponta: Meta paginada → cliente → normalizador → Postgres → leitura do painel', async () => {
    const http = require('http');
    const { MetaClient } = require('../lib/meta/client');
    const { normalizarLinhaInsight, montarUpsertInsights, totalizarSomas } = require('../lib/meta/insights');

    // Dois dias em duas páginas, com os mesmos formatos chatos que a Meta usa de verdade:
    // números como string, outbound_clicks como array de ações, purchase repetido em três
    // action_type, e um dia sem vídeo nenhum.
    const PAGINAS = [
      {
        data: [{
          date_start: '2026-09-10', date_stop: '2026-09-10', campaign_id: 'c1', adset_id: 's1', ad_id: 'a1',
          impressions: '10000', reach: '7000', clicks: '250', unique_clicks: '210', inline_link_clicks: '200',
          outbound_clicks: [{ action_type: 'outbound_click', value: '190' }],
          spend: '300.50', ctr: '2.5', cpc: '1.202', cpm: '30.05',
          actions: [
            { action_type: 'purchase', value: '10' },
            { action_type: 'omni_purchase', value: '10' },
            { action_type: 'offsite_conversion.fb_pixel_purchase', value: '10' },
            { action_type: 'add_to_cart', value: '55' },
            { action_type: 'landing_page_view', value: '180' },
          ],
          action_values: [{ action_type: 'purchase', value: '1099.00' }],
          video_play_actions: [{ action_type: 'video_view', value: '400' }],
          video_p25_watched_actions: [{ action_type: 'video_view', value: '300' }],
        }],
        paging: { cursors: { after: 'PAG2' } },
      },
      {
        data: [{
          date_start: '2026-09-11', date_stop: '2026-09-11', campaign_id: 'c1', adset_id: 's1', ad_id: 'a1',
          impressions: '5000', reach: '4000', clicks: '100', spend: '150.00',
          actions: [{ action_type: 'purchase', value: '5' }],
          action_values: [{ action_type: 'purchase', value: '600.00' }],
        }],
      },
    ];

    let pagina = 0;
    const servidor = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(PAGINAS[pagina++] || { data: [] }));
    });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    const porta = servidor.address().port;

    try {
      const client = new MetaClient({ accessToken: 'token-de-teste' });
      // Aponta o cliente pro servidor falso sem mexer na lib: só a montagem da URL muda.
      client.url = (caminho, params = {}) => {
        const u = new URL(`http://127.0.0.1:${porta}/${caminho}`);
        for (const [k, v] of Object.entries(params)) {
          if (v === undefined || v === null || v === '') continue;
          u.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        }
        return u.toString();
      };

      const linhas = [];
      for await (const bruta of client.paginar(`${CONTA}/insights`, { level: 'ad', time_increment: 1 })) {
        linhas.push(normalizarLinhaInsight(bruta, { level: 'ad', attributionSetting: 'unified' }));
      }
      assert.equal(linhas.length, 2, 'a paginação deveria ter trazido os dois dias');
      assert.equal(linhas[0].purchases, 10, 'as três variantes de purchase não podem virar 30');

      await pool.query('DELETE FROM meta_insights_daily');
      const { sql, params } = montarUpsertInsights(CONTA, 'ad', linhas);
      const r1 = await pool.query(sql, params);
      assert.deepEqual(r1.rows.map((x) => x.inserido), [true, true]);

      // Rodar de novo é exatamente o que o backfill diário faz (spec §34): tem que atualizar,
      // nunca duplicar.
      const r2 = await pool.query(sql, params);
      assert.deepEqual(r2.rows.map((x) => x.inserido), [false, false]);

      // Agora lê de volta pela mesma query da rota de overview e confere cada valor.
      const COLS = ['impressions', 'reach', 'clicks', 'unique_clicks', 'inline_link_clicks',
        'outbound_clicks', 'unique_outbound_clicks', 'spend', 'landing_page_views', 'view_content',
        'add_to_cart', 'initiate_checkout', 'purchases', 'purchase_value',
        'video_plays', 'video_thruplays', 'video_25', 'video_50', 'video_75', 'video_95', 'video_100'];
      const { rows } = await pool.query(
        `SELECT ${COLS.map((c) => `SUM(${c}) AS ${c}`).join(', ')} FROM meta_insights_daily
         WHERE meta_account_id = $1 AND level = 'ad' AND data BETWEEN $2 AND $3`,
        [CONTA, '2026-09-10', '2026-09-11']
      );
      const b = rows[0];
      const total = totalizarSomas({
        impressions: b.impressions, reach: b.reach, clicks: b.clicks,
        uniqueClicks: b.unique_clicks, inlineLinkClicks: b.inline_link_clicks,
        outboundClicks: b.outbound_clicks, uniqueOutboundClicks: b.unique_outbound_clicks,
        spend: b.spend, landingPageViews: b.landing_page_views, viewContent: b.view_content,
        addToCart: b.add_to_cart, initiateCheckout: b.initiate_checkout,
        purchases: b.purchases, purchaseValue: b.purchase_value,
        videoPlays: b.video_plays, videoThruplays: b.video_thruplays,
        video25: b.video_25, video50: b.video_50, video75: b.video_75, video95: b.video_95, video100: b.video_100,
      });

      assert.equal(total.impressions, 15000);
      assert.equal(total.clicks, 350);
      assert.equal(total.spend, 450.5);
      assert.equal(total.purchases, 15);
      assert.equal(total.purchaseValue, 1699);
      assert.equal(total.outboundClicks, 190, 'array de ações tem que ter virado número no banco');
      assert.equal(total.landingPageViews, 180);
      assert.equal(total.addToCart, 55);
      assert.equal(total.roas, 1699 / 450.5);
      assert.equal(total.cpa, 450.5 / 15);
      assert.ok(Math.abs(total.ctr - (350 / 15000) * 100) < 1e-9);
      assert.equal(total.reach, null, 'alcance de período nunca sai somado como se fosse único');
      assert.equal(total.reachSomado, 11000);
      // Só o dia 10 tinha vídeo: a soma do período é 400, não null e não 0.
      assert.equal(total.videoPlays, 400);
      assert.equal(total.video25, 300);
      assert.equal(total.video100, null, 'métrica de vídeo que a Meta nunca mandou continua "sem dado"');

      // E a data volta como rótulo, sem escorregar um dia por causa de fuso.
      const { rows: serie } = await pool.query(
        `SELECT to_char(data, 'YYYY-MM-DD') AS data FROM meta_insights_daily WHERE meta_account_id = $1 ORDER BY data`,
        [CONTA]
      );
      assert.deepEqual(serie.map((x) => x.data), ['2026-09-10', '2026-09-11']);
    } finally {
      await new Promise((r) => servidor.close(r));
    }
  });

  test('as datas do sync log saem como texto AAAA-MM-DD, nunca como timestamp', async () => {
    // Regressão de um bug real (14/09/2026): date_from/date_to são colunas DATE, e deixar o driver
    // convertê-las em Date fazia "2026-06-17" virar meia-noite UTC. Com o servidor em UTC e o
    // navegador em BRT, a tela mostrava "16/06 21:00" — um dia a menos e uma hora inexistente.
    await pool.query('DELETE FROM meta_sync_logs');
    await pool.query(
      `INSERT INTO meta_sync_logs (meta_account_id, sync_type, status, date_from, date_to)
       VALUES ($1, 'INITIAL_IMPORT', 'sucesso', '2026-06-17', '2026-09-14')`,
      [CONTA]
    );
    const { rows } = await pool.query(
      `SELECT to_char(date_from, 'YYYY-MM-DD') AS date_from, to_char(date_to, 'YYYY-MM-DD') AS date_to
       FROM meta_sync_logs ORDER BY started_at DESC LIMIT 1`
    );
    assert.equal(typeof rows[0].date_from, 'string', 'veio como Date — o fuso do navegador vai deslocar o dia');
    assert.equal(rows[0].date_from, '2026-06-17');
    assert.equal(rows[0].date_to, '2026-09-14');
  });

  test('receita e custo do consolidado saem do MESMO conjunto de pedidos', async () => {
    // Regressão do bug visto em produção (15/09/2026): a tela mostrou R$ 61.467 de receita (377
    // pedidos) contra R$ 3.664 de custo (55 pedidos), porque SUM ignora NULL. Resultado: margem de
    // 6% onde a real é ~45%, Lucro após Mídia falsamente negativo e break-even de 16x.
    await pool.query('DELETE FROM pedidos_ink');
    // 2 pedidos com financeiro completo, 8 sem — a proporção que causou o estrago.
    for (let i = 0; i < 2; i += 1) {
      await pool.query(
        `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, custo_producao, lucro_operacional, is_troca)
         VALUES ('sul', $1, 'paid', 100, now(), 40, 60, false)`, [800 + i]
      );
    }
    for (let i = 0; i < 8; i += 1) {
      await pool.query(
        `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, is_troca)
         VALUES ('sul', $1, 'paid', 100, now(), false)`, [900 + i]
      );
    }
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS pedidos,
              COUNT(*) FILTER (WHERE lucro_operacional IS NOT NULL)::int AS com_financeiro,
              COALESCE(SUM(total_value), 0) AS receita_total,
              COALESCE(SUM(total_value) FILTER (WHERE lucro_operacional IS NOT NULL), 0) AS receita,
              COALESCE(SUM(custo_producao) FILTER (WHERE lucro_operacional IS NOT NULL), 0) AS custo,
              COALESCE(SUM(lucro_operacional) FILTER (WHERE lucro_operacional IS NOT NULL), 0) AS lucro
       FROM pedidos_ink WHERE loja = 'sul' AND payment_status = 'paid' AND is_troca IS NOT TRUE`
    );
    const r = rows[0];
    assert.equal(r.pedidos, 10);
    assert.equal(r.com_financeiro, 2);
    assert.equal(Number(r.receita_total), 1000, 'receita real da loja: os 10 pedidos');
    assert.equal(Number(r.receita), 200, 'receita do RESULTADO: só os 2 cobertos');
    assert.equal(Number(r.custo), 80);
    assert.equal(Number(r.lucro), 120);
    // A margem do recorte é 60% — a verdadeira. Sem o FILTER na receita seria 120/1000 = 12%.
    assert.equal((Number(r.lucro) / Number(r.receita)) * 100, 60);
  });

  test('o upsert monta um valor para cada coluna, sempre', () => {
    const { montarUpsertInsights, COLUNAS_INSIGHT } = require('../lib/meta/insights');
    const { sql, params } = montarUpsertInsights(CONTA, 'ad', [{ date: '2026-09-10', attributionSetting: 'unified' }, { date: '2026-09-11', attributionSetting: 'unified' }]);
    assert.equal(params.length, COLUNAS_INSIGHT.length * 2, 'sobrou ou faltou valor pra alguma coluna');
    assert.equal((sql.match(/\$\d+/g) || []).length, COLUNAS_INSIGHT.length * 2, 'placeholders não batem com os valores');
  });
}
