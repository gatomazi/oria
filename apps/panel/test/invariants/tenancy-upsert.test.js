'use strict';

// Fase 1 — os upserts do código depois das chaves por Organization (INV-05).
//
// Cada família abaixo é uma tabela com o MESMO alvo de ON CONFLICT que o código usa (server.js e
// lib/). A escrita de A tem a forma do código atual: sem organization_id, que o trigger de tenancy
// resolve ANTES da arbitragem. A escrita de B informa organization_id, como o código da Fase 3 fará.
//
// Para cada família:
//   A insere (xmax = 0) · A repete a chave → atualiza a própria linha
//   B com a mesma chave lógica → linha NOVA, independente · B repete → atualiza só a de B
//   a linha de A não muda quando B escreve; e, sob RLS, A nunca alcança a linha de B.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const h = require('./harness');
const { inserir } = require('../helpers/linhas');
const { comOrganization } = h.sujeito('lib/platform/tenant-db.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
// Fase 3 (INV-22): tenant_id do Creative Core é o próprio id da Organization.
const A = { id: 'a1000000-0000-4000-8000-000000000001', loja: 'sul', tenant: 'a1000000-0000-4000-8000-000000000001' };
const B = { id: 'a1000000-0000-4000-8000-000000000002', loja: 'centro', tenant: 'a1000000-0000-4000-8000-000000000002' };
const ROLE = `oria_app_up_${crypto.randomBytes(4).toString('hex')}`;
const SENHA = crypto.randomBytes(16).toString('hex');

let db;
let sup;
let app;
const pais = { A: {}, B: {} };

// tabela · alvo do código · coluna atualizada · valores fixos da chave lógica · colunas de loja
const FAMILIAS = [
  { tabela: 'app_config', alvo: ['chave'], muda: 'valor', chave: { chave: 'k' }, v: (n) => JSON.stringify({ n }) },
  { tabela: 'custos_api_precos', alvo: ['chave'], muda: 'valor', chave: { chave: 'whatsapp.marketing' }, v: (n) => n },
  { tabela: 'produtos_feed', alvo: ['loja', 'produto_id'], muda: 'titulo', chave: { produto_id: 101 }, loja: true },
  { tabela: 'produtos_feed_sync', alvo: ['loja'], muda: 'erro', chave: {}, loja: true },
  { tabela: 'produtos_ink', alvo: ['loja', 'produto_id'], muda: 'name', chave: { produto_id: 101 }, loja: true },
  { tabela: 'produtos_ink_sync', alvo: ['loja'], muda: 'erro', chave: {}, loja: true },
  { tabela: 'sync_estado', alvo: ['loja'], muda: 'ultimo_sync_em', chave: {}, loja: true, v: (n) => new Date(Date.UTC(2026, 0, n)).toISOString() },
  { tabela: 'google_analytics_connections', alvo: ['loja'], muda: 'last_error', chave: {}, loja: true },
  { tabela: 'ga4_performance_cache', alvo: ['loja', 'periodo'], muda: 'dados', chave: { periodo: '30d' }, loja: true, v: (n) => JSON.stringify({ n }) },
  { tabela: 'origens_migration_city_uf_map', alvo: ['loja', 'cidade_normalizada'], chave: { cidade_normalizada: 'joinville' }, loja: true, nada: true },
  { tabela: 'pedidos_ink_itens', alvo: ['loja', 'item_id'], chave: { item_id: 77 }, loja: true, nada: true },
  { tabela: 'pedidos_ink', alvo: ['loja', 'ink_order_id'], muda: 'buyer_nome', chave: { ink_order_id: 1982524 }, loja: true },
  { tabela: 'campaign_recipients', alvo: ['campaign_id', 'customer_key'], chave: { customer_key: 'cliente-1' }, pai: 'campaigns', nada: true },
  // Conexão: uma por Organization. O código grava id = 1; o árbitro é a UNIQUE (organization_id).
  { tabela: 'meta_connections', alvo: [], muda: 'status', chave: { id: 1 } },
  { tabela: 'google_ads_connections', alvo: [], muda: 'status', chave: { id: 1 } },
  { tabela: 'meta_ad_accounts', alvo: ['meta_account_id'], muda: 'nome', chave: { meta_account_id: 'act_1' } },
  { tabela: 'meta_campaigns', alvo: ['meta_campaign_id'], muda: 'nome', chave: { meta_campaign_id: 'c1' } },
  { tabela: 'meta_adsets', alvo: ['meta_adset_id'], muda: 'nome', chave: { meta_adset_id: 's1' } },
  { tabela: 'meta_creatives', alvo: ['meta_creative_id'], muda: 'nome', chave: { meta_creative_id: 'cr1' } },
  { tabela: 'meta_ads', alvo: ['meta_ad_id'], muda: 'nome', chave: { meta_ad_id: 'a1' } },
  { tabela: 'google_ads_customers', alvo: ['customer_id'], muda: 'nome', chave: { customer_id: '1111111111' } },
  { tabela: 'google_ads_campaigns', alvo: ['customer_id', 'campaign_id'], muda: 'nome', chave: { customer_id: '1111111111', campaign_id: 'g1' } },
  {
    tabela: 'google_ads_insights_daily',
    alvo: ['customer_id', 'level', 'entidade_id', 'data', 'contagem_conversao'],
    muda: 'custo',
    chave: { customer_id: '1111111111', level: 'customer', entidade_id: '1111111111', data: '2026-09-10', contagem_conversao: 'conversions' },
    v: (n) => n,
  },
  {
    tabela: 'meta_insights_daily',
    alvo: ['meta_account_id', 'level', 'entidade_id', 'data', 'attribution_setting'],
    muda: 'spend',
    chave: { meta_account_id: 'act_1', level: 'account', entidade_id: 'act_1', data: '2026-09-10', attribution_setting: 'unified' },
    v: (n) => n,
  },
  { tabela: 'creative_settings', alvo: [], muda: 'openai_key_last4', chave: {}, creative: true },
  { tabela: 'integration_secrets', alvo: ['integration_id', 'tipo'], muda: 'last4', chave: { tipo: 'access_token' }, pai: 'integrations' },
];

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_upsert');
  assert.equal(h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } }).status, 0);
  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  await sup.query(`INSERT INTO tenancy_mapeamentos (tipo, chave, organization_id) VALUES ('creative_tenant', $1, $2)`, [B.tenant, B.id]);
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  app = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA), { max: 1 });
  for (const [k, o] of [['A', A], ['B', B]]) {
    pais[k].campaigns = (await inserir(sup, 'campaigns', { loja: o.loja, organization_id: o.id })).id;
    pais[k].integrations = (await inserir(sup, 'integrations', { escopo: o.loja, provider: `p-${k}`, organization_id: o.id })).id;
  }
});

test.after(async () => {
  await app?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

// Monta o upsert com o alvo do código, prefixado por organization_id (a troca da rodada 12).
async function upsert(client, f, org, n, { explicito }) {
  const valores = { ...f.chave };
  if (f.loja) valores.loja = org.loja;
  if (f.creative) valores.tenant_id = org.tenant;
  if (f.pai) valores[f.pai === 'campaigns' ? 'campaign_id' : 'integration_id'] = pais[org === A ? 'A' : 'B'][f.pai];
  if (f.muda) valores[f.muda] = f.v ? f.v(n) : `v${n}`;
  // Creative Core (Fase 3 · INV-22): o código grava sempre o dono explícito (tenant_id = organization_id).
  const comDono = explicito || f.creative;
  valores.organization_id = comDono ? org.id : null;

  // Colunas obrigatórias sem default que a família não fixou: gera uma vez e reaproveita.
  const cols = await sup.query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`,
    [f.tabela]
  );
  for (const c of cols.rows) {
    if (c.column_name in valores) continue;
    valores[c.column_name] = c.data_type === 'uuid' ? crypto.randomUUID()
      : ['integer', 'bigint', 'smallint', 'numeric'].includes(c.data_type) ? 1
        : ['jsonb', 'json'].includes(c.data_type) ? '{}'
          : c.data_type.startsWith('timestamp') ? new Date().toISOString() : `${c.column_name}-fixo`;
  }
  const nomes = Object.keys(valores).filter((k) => !(k === 'organization_id' && !comDono));
  const alvo = ['organization_id', ...f.alvo].join(', ');
  const acao = f.nada ? 'DO NOTHING' : `DO UPDATE SET ${f.muda} = EXCLUDED.${f.muda}`;
  const { rows } = await client.query(
    `INSERT INTO ${f.tabela} (${nomes.join(', ')}) VALUES (${nomes.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT (${alvo}) ${acao}
     RETURNING organization_id, (xmax = 0) AS inserido${f.muda ? `, ${f.muda}::text AS valor` : ''}`,
    nomes.map((k) => valores[k])
  );
  return rows[0] || null; // DO NOTHING em conflito não devolve linha
}

const filtroChave = (f, org) => {
  const cond = { organization_id: org.id, ...f.chave };
  if (f.loja) cond.loja = org.loja;
  const ks = Object.keys(cond);
  return { onde: ks.map((k, i) => `${k} = $${i + 1}`).join(' AND '), params: ks.map((k) => cond[k]) };
};

for (const f of FAMILIAS) {
  test(`upsert · ${f.tabela} · ON CONFLICT (organization_id${f.alvo.length ? `, ${f.alvo.join(', ')}` : ''})`, async () => {
    // A — forma do código atual (sem organization_id): o trigger resolve antes da arbitragem.
    const a1 = await upsert(sup, f, A, 1, { explicito: false });
    assert.equal(a1.inserido, true);
    assert.equal(a1.organization_id, A.id);
    const a2 = await upsert(sup, f, A, 2, { explicito: false });
    if (f.nada) assert.equal(a2, null, 'DO NOTHING: a segunda escrita de A conflita com a primeira');
    else assert.deepEqual([a2.inserido, a2.organization_id], [false, A.id], 'A repetiu a chave e não atualizou');

    // B — mesma chave lógica, dono explícito: linha nova, não conflita com A.
    const b1 = await upsert(sup, f, B, 3, { explicito: true });
    assert.ok(b1, `${f.tabela}: B foi barrado pela chave de A — ainda existe restrição global`);
    assert.deepEqual([b1.inserido, b1.organization_id], [true, B.id]);
    const b2 = await upsert(sup, f, B, 4, { explicito: true });
    if (!f.nada) assert.deepEqual([b2.inserido, b2.organization_id], [false, B.id]);

    // Uma linha por Organization, e a de A intacta depois das escritas de B.
    for (const [org, esperado] of [[A, '2'], [B, '4']]) {
      const { onde, params } = filtroChave(f, org);
      const { rows } = await sup.query(`SELECT ${f.muda ? `${f.muda}::text AS valor` : '1'} FROM ${f.tabela} WHERE ${onde}`, params);
      assert.equal(rows.length, 1, `${f.tabela}: esperava exatamente 1 linha de ${org.loja}`);
      if (f.muda && !f.v) assert.equal(rows[0].valor, `v${esperado}`);
    }

    // Sob RLS: A, com a chave de B e o dono de A, nunca alcança a linha de B.
    await comOrganization(app, A.id, (c) => upsert(c, f, A, 5, { explicito: true }));
    const { onde, params } = filtroChave(f, B);
    const { rows } = await sup.query(`SELECT ${f.muda ? `${f.muda}::text AS valor` : '1'} FROM ${f.tabela} WHERE ${onde}`, params);
    assert.equal(rows.length, 1);
    if (f.muda && !f.v) assert.equal(rows[0].valor, 'v4', `${f.tabela}: a escrita de A mudou a linha de B`);
  });
}

// OPS-17 (deploy em dois passos): o código com os alvos novos sobe ANTES da migration de chaves.
// Todo alvo precisa ter árbitro também no schema de expand (até 1789600360000_tenancy-rls).
test('upsert · pré-contract: todo alvo novo já tem árbitro no schema de expand', async (t) => {
  const pre = await h.criarBancoDescartavel('oria_upsert_pre');
  t.after(() => pre.destruir());
  const r = h.migrar(pre.url, { posicionais: ['13'], env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  const banco = h.abrirPoolDescartavel(pre.url, { max: 1 });
  t.after(() => banco.end());
  const { rows: ult } = await banco.query('SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1');
  assert.equal(ult[0].name, '1789600360000_tenancy-rls');
  const paisPre = {
    campaigns: (await inserir(banco, 'campaigns', { loja: A.loja, organization_id: A.id })).id,
    integrations: (await inserir(banco, 'integrations', { escopo: A.loja, provider: 'p-pre', organization_id: A.id })).id,
  };
  for (const f of FAMILIAS) {
    const valores = { ...f.chave };
    if (f.loja) valores.loja = A.loja;
    if (f.creative) Object.assign(valores, { tenant_id: A.tenant, organization_id: A.id });
    if (f.pai) valores[f.pai === 'campaigns' ? 'campaign_id' : 'integration_id'] = paisPre[f.pai];
    if (f.muda) valores[f.muda] = f.v ? f.v(1) : 'v1';
    const { rows: obrig } = await banco.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL
          AND column_name <> 'organization_id'`,
      [f.tabela]
    );
    for (const c of obrig) {
      if (c.column_name in valores) continue;
      valores[c.column_name] = c.data_type === 'uuid' ? crypto.randomUUID()
        : ['integer', 'bigint', 'smallint', 'numeric'].includes(c.data_type) ? 1
          : ['jsonb', 'json'].includes(c.data_type) ? '{}'
            : c.data_type.startsWith('timestamp') ? new Date().toISOString() : `${c.column_name}-fixo`;
    }
    const nomes = Object.keys(valores);
    const acao = f.nada ? 'DO NOTHING' : `DO UPDATE SET ${f.muda} = EXCLUDED.${f.muda}`;
    const sql = `INSERT INTO ${f.tabela} (${nomes.join(', ')}) VALUES (${nomes.map((_, i) => `$${i + 1}`).join(', ')})
      ON CONFLICT (${['organization_id', ...f.alvo].join(', ')}) ${acao}`;
    await banco.query(sql, nomes.map((k) => valores[k]));
    await banco.query(sql, nomes.map((k) => valores[k])); // segunda vez: arbitra, não duplica
  }
});

test('upsert · a lista cobre toda tabela com ON CONFLICT com alvo no código', () => {
  const fs = require('node:fs');
  const arquivos = [path.join(h.RAIZ_REPO, 'server.js'),
    ...['lib', 'routes'].flatMap((d) => fs.readdirSync(path.join(h.RAIZ_REPO, d), { recursive: true })
      .filter((x) => x.endsWith('.js')).map((x) => path.join(h.RAIZ_REPO, d, x)))];
  const tabelas = new Set();
  for (const arq of arquivos) {
    const texto = fs.readFileSync(arq, 'utf8');
    for (const m of texto.matchAll(/INSERT INTO (\w+)[\s\S]{0,1500}?ON CONFLICT \(/g)) {
      if (manifesto.porTabela(m[1])) tabelas.add(m[1]);
    }
  }
  const cobertas = new Set(FAMILIAS.map((f) => f.tabela));
  assert.deepEqual([...tabelas].filter((t) => !cobertas.has(t)).sort(), []);
});

test('upsert · todo ON CONFLICT com alvo em tabela tenant-owned começa por organization_id', () => {
  const fs = require('node:fs');
  const arquivos = [path.join(h.RAIZ_REPO, 'server.js'),
    ...['lib', 'routes'].flatMap((d) => fs.readdirSync(path.join(h.RAIZ_REPO, d), { recursive: true })
      .filter((x) => x.endsWith('.js')).map((x) => path.join(h.RAIZ_REPO, d, x)))];
  const ruins = [];
  let total = 0;
  for (const arq of arquivos) {
    const linhas = fs.readFileSync(arq, 'utf8').split('\n');
    linhas.forEach((l, i) => {
      if (l.trimStart().startsWith('//')) return;
      const m = l.match(/ON CONFLICT \(([^)]*)\)/);
      if (!m) return;
      if (arq.endsWith('tenancy-mapping.js')) return; // tabelas de plataforma/mapeamento, não tenant-owned
      total += 1;
      if (!/^\s*organization_id\b/.test(m[1]) && !/ALVO_CONFLITO_INSIGHT/.test(m[1])) {
        ruins.push(`${path.relative(h.RAIZ_REPO, arq)}:${i + 1}: ${l.trim()}`);
      }
    });
  }
  // 31 em tabelas tenant-owned + 1 em organization_members (lib/auth/router.js, Fase 2).
  // Fase 4: o upsert de creative_settings saiu (a OpenAI key é integration_secrets).
  // Fase 7: + app_config 'entitlements' no seed de plataforma do onboarding (lib/platform/onboarding.js).
  // Aceite de convite: + organization_members em lib/auth/invites.js (mesmo alvo da Fase 2).
  // Fase C: + creative_feedback em lib/creative-core/pgFeedback.js (tabela de plataforma; organization_id primeiro).
  // Fase D: + commerce_products e commerce_product_variants (lib/product-analytics/catalog-sync.js),
  // ambos ON CONFLICT (organization_id, store_id, provider, provider_product_id/provider_variant_id).
  // Fase F: + 4 em lib/product-analytics/product-identity-resolver.js — bootstrap (product_id,
  // variant_id, sku) e persistRuleMatches, todos ON CONFLICT (organization_id, store_id, namespace, external_id).
  assert.equal(total, 41, 'número de alvos mudou — revise a lista de famílias');
  assert.deepEqual(ruins, []);
});

test('upsert · código real: montarUpsertInsights, secret store e Creative Core', async () => {
  const { montarUpsertInsights, normalizarLinhaInsight } = h.sujeito('lib/meta/insights.js');
  const { createSecretStore } = h.sujeito('lib/secrets/store.js');
  const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
  const { createPgStore } = h.sujeito('lib/creative-core/pgStore.js');

  // Meta insights: o mesmo SQL que o sync grava, duas vezes → atualiza.
  const linha = normalizarLinhaInsight(
    { date_start: '2026-09-11', impressions: '10', clicks: '1', spend: '10.00' },
    { level: 'account', attributionSetting: 'unified' }
  );
  const { sql, params } = montarUpsertInsights('act_real', 'account', [linha]);
  assert.deepEqual((await sup.query(sql, params)).rows.map((r) => r.inserido), [true]);
  assert.deepEqual((await sup.query(sql, params)).rows.map((r) => r.inserido), [false]);

  // Secret store: gravar duas vezes o mesmo tipo na mesma integração → uma linha.
  const store = createSecretStore({ pool: sup, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: crypto.randomBytes(32).toString('base64') }) });
  await store.gravar({ integrationId: pais.A.integrations, tipo: 'refresh_token', valor: 'segredo-000001', contexto: 'x' });
  await store.gravar({ integrationId: pais.A.integrations, tipo: 'refresh_token', valor: 'segredo-000002', contexto: 'x' });
  const { rows: sec } = await sup.query(`SELECT count(*)::int AS n FROM integration_secrets WHERE integration_id = $1 AND tipo = 'refresh_token'`, [pais.A.integrations]);
  assert.equal(sec[0].n, 1);

  // Creative Core: desde a Fase 4 a OpenAI key é da integração 'openai' (secret store acima), não
  // de creative_settings — o store do Creative Core não tem mais upsert de chave.
  assert.equal(createPgStore(sup).saveOpenAiKey, undefined);
});
