'use strict';

// Agregação de custo das APIs contra Postgres real.
//
// Roda de verdade porque o risco aqui é SQL, não aritmética: recorte de período no fuso de
// Brasília, FILTER para separar o que foi medido do que não foi, e SUM que ignora NULL em silêncio.
// Nenhuma dessas três coisas falha num mock — todas falham em produção.

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

const { custoGeracao, custoMensagens, mesclarPrecos, totalizarCustos } = require('../lib/custos/precos');

const URL_TESTE = process.env.META_TEST_DATABASE_URL;

if (!URL_TESTE) {
  test('custos de API em SQL (pulado: defina META_TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const pool = new Pool({ connectionString: URL_TESTE });
  // Fase 3 (INV-22): tenant_id do Creative Core é o id da Organization dona.
  const ORG_A = 'a1000000-0000-4000-8000-000000000001';
  const DESDE = `((now() AT TIME ZONE 'America/Sao_Paulo')::date - ($1::int - 1))`;

  test.after(async () => { await pool.end(); });

  test.before(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS creative_generations (
      creative_id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, job_id UUID NOT NULL,
      item_index INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      generation_attempt INTEGER NOT NULL DEFAULT 1, infra_retries INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), request JSONB NOT NULL,
      engine TEXT NOT NULL, product_mode TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await pool.query(`ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS modelo_imagem TEXT`);
    await pool.query(`ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada INTEGER`);
    await pool.query(`ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_saida INTEGER`);
    await pool.query(`ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada_cache INTEGER`);
    await pool.query(`ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada_texto INTEGER`);
    await pool.query(`ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada_imagem INTEGER`);
    await pool.query(`CREATE TABLE IF NOT EXISTS custos_api_precos (
      chave TEXT PRIMARY KEY, valor NUMERIC NOT NULL CHECK (valor >= 0),
      moeda TEXT NOT NULL DEFAULT 'USD', confianca TEXT NOT NULL DEFAULT 'confirmado',
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now())`);
  });

  async function semear(linhas) {
    await pool.query('DELETE FROM creative_generations');
    for (const [i, l] of linhas.entries()) {
      await pool.query(
        `INSERT INTO creative_generations
           (creative_id, tenant_id, job_id, item_index, request, engine, product_mode,
            modelo_imagem, tokens_entrada, tokens_entrada_texto, tokens_entrada_imagem,
            tokens_entrada_cache, tokens_saida, created_at, organization_id)
         VALUES (gen_random_uuid(), $9::text, gen_random_uuid(), $1, '{}', 'CLEAN_ANGLES', 'single',
                 $2, $3, $4, $5, $6, $7, now() - ($8 || ' days')::interval, $9::uuid)`,
        [i, l.modelo, l.entrada, l.texto, l.imagem, l.cache, l.saida, l.diasAtras || 0, ORG_A]
      );
    }
  }

  const AGREGACAO = `
    SELECT modelo_imagem,
           COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE tokens_saida IS NULL)::int AS sem_medicao,
           COALESCE(SUM(tokens_entrada), 0)::bigint AS entrada,
           COALESCE(SUM(tokens_entrada_texto), 0)::bigint AS entrada_texto,
           COALESCE(SUM(tokens_entrada_imagem), 0)::bigint AS entrada_imagem,
           COALESCE(SUM(tokens_entrada_cache), 0)::bigint AS entrada_cache,
           COALESCE(SUM(tokens_saida), 0)::bigint AS saida
      FROM creative_generations
     WHERE created_at >= ${DESDE}
     GROUP BY modelo_imagem`;

  test('geração sem medição é contada à parte, não somada como zero', async () => {
    await semear([
      { modelo: 'gpt-image-2', entrada: 1500, texto: 300, imagem: 1200, cache: 0, saida: 1584 },
      { modelo: 'gpt-image-2', entrada: null, texto: null, imagem: null, cache: null, saida: null },
    ]);
    const { rows } = await pool.query(AGREGACAO, [30]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].n, 2);
    assert.equal(rows[0].sem_medicao, 1, 'a não medida precisa aparecer separada');
    assert.equal(Number(rows[0].saida), 1584, 'SUM ignora NULL — só a medida entra');
  });

  test('o custo somado do período bate com o custo de cada geração', async () => {
    await semear([
      { modelo: 'gpt-image-2', entrada: 1500, texto: 300, imagem: 1200, cache: 0, saida: 1584 },
      { modelo: 'gpt-image-2', entrada: 900, texto: 100, imagem: 800, cache: 0, saida: 1000 },
    ]);
    const precos = mesclarPrecos([]);
    const { rows } = await pool.query(AGREGACAO, [30]);
    const agregado = custoGeracao({
      modeloImagem: rows[0].modelo_imagem,
      tokensEntrada: Number(rows[0].entrada),
      tokensEntradaTexto: Number(rows[0].entrada_texto),
      tokensEntradaImagem: Number(rows[0].entrada_imagem),
      tokensEntradaCache: Number(rows[0].entrada_cache),
      tokensSaida: Number(rows[0].saida),
    }, precos);

    const uma = custoGeracao({ modeloImagem: 'gpt-image-2', tokensEntrada: 1500, tokensEntradaTexto: 300, tokensEntradaImagem: 1200, tokensEntradaCache: 0, tokensSaida: 1584 }, precos);
    const outra = custoGeracao({ modeloImagem: 'gpt-image-2', tokensEntrada: 900, tokensEntradaTexto: 100, tokensEntradaImagem: 800, tokensEntradaCache: 0, tokensSaida: 1000 }, precos);
    assert.ok(Math.abs(agregado.total - (uma.total + outra.total)) < 1e-9,
      'somar tokens e precificar depois tem que dar o mesmo que precificar e somar');
  });

  test('geração fora do período não entra na conta', async () => {
    await semear([
      { modelo: 'gpt-image-2', entrada: 1500, texto: 300, imagem: 1200, cache: 0, saida: 1584, diasAtras: 0 },
      { modelo: 'gpt-image-2', entrada: 9999, texto: 9999, imagem: 0, cache: 0, saida: 99999, diasAtras: 60 },
    ]);
    const { rows } = await pool.query(AGREGACAO, [30]);
    assert.equal(Number(rows[0].saida), 1584, 'a de 60 dias atrás ficou fora da janela de 30');
  });

  test('período de 1 dia pega o que foi gerado hoje', async () => {
    await semear([{ modelo: 'gpt-image-2', entrada: 100, texto: 100, imagem: 0, cache: 0, saida: 200 }]);
    const { rows } = await pool.query(AGREGACAO, [1]);
    assert.equal(rows.length, 1, 'hoje no fuso de Brasília precisa entrar num período de 1 dia');
  });

  test('modelos diferentes são precificados separadamente, nunca somados em tokens', async () => {
    // Token de um modelo não tem o mesmo preço do de outro: somar antes de precificar inventaria custo.
    await semear([
      { modelo: 'gpt-image-2', entrada: 1000, texto: 1000, imagem: 0, cache: 0, saida: 1000 },
      { modelo: 'gpt-image-1', entrada: 1000, texto: 1000, imagem: 0, cache: 0, saida: 1000 },
    ]);
    const { rows } = await pool.query(AGREGACAO, [30]);
    assert.equal(rows.length, 2, 'GROUP BY modelo tem que separar');
  });

  test('preço editado pelo cliente sobrescreve o padrão na hora de calcular', async () => {
    await pool.query('DELETE FROM custos_api_precos');
    await pool.query(
      `INSERT INTO custos_api_precos (chave, valor, moeda) VALUES ('whatsapp.marketing', 0.34, 'BRL')`
    );
    const { rows } = await pool.query('SELECT chave, valor, moeda, confianca FROM custos_api_precos');
    const precos = mesclarPrecos(rows.map((r) => ({ ...r, valor: Number(r.valor) })));
    const c = custoMensagens('marketing', 100, precos);
    assert.ok(Math.abs(c.total - 34) < 1e-9);
    assert.equal(c.moeda, 'BRL');
    assert.equal(c.confianca, 'confirmado');
  });

  test('total com uma parte editada em BRL e outra em USD não vira um número só', async () => {
    const precos = mesclarPrecos([{ chave: 'whatsapp.marketing', valor: 0.34, moeda: 'BRL' }]);
    const t = totalizarCustos([
      custoMensagens('marketing', 10, precos),
      custoGeracao({ modeloImagem: 'gpt-image-2', tokensEntrada: 100, tokensSaida: 100 }, precos),
    ]);
    assert.equal(t.moedasMisturadas, true);
    assert.equal(t.moeda, null);
  });
}
