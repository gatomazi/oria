'use strict';

// Rodada K (Journey Analytics) · getCampaignPerformance contra Postgres real: RLS de
// meta_ad_accounts/meta_campaigns/meta_insights_daily (migrations/sql/0007/0009), nunca um fake de
// tenancy — é exatamente o que o resto do isolamento tenant-safe deste repo audita.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { getCampaignPerformance } = h.sujeito('lib/meta/campaign-performance.js');

const ORG_A = 'ae000000-0000-4000-8000-000000000001';
const ORG_B = 'ae000000-0000-4000-8000-000000000002';
const ROLE = `oria_app_meta_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');

let db;
let sup;
let appPoolReal;

const poolDe = (organizationId) => runtime.criarPoolTenant(appPoolReal);
const em = (organizationId, fn) => runtime.comContexto({ organizationId, storeId: null, origem: 'teste' }, fn);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_meta_camp');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2), ($3, $4)', [ORG_A, 'Org A', ORG_B, 'Org B']);

  // Org A: conta selecionada, 2 campanhas, 2 dias cada.
  await sup.query('INSERT INTO meta_ad_accounts (organization_id, meta_account_id, nome, currency, selecionada) VALUES ($1, $2, $3, $4, true)', [ORG_A, 'act_A1', 'Conta A', 'BRL']);
  await sup.query('INSERT INTO meta_campaigns (organization_id, meta_account_id, meta_campaign_id, nome) VALUES ($1, $2, $3, $4), ($1, $2, $5, $6)', [ORG_A, 'act_A1', 'camp_1', 'Campanha Verão', 'camp_2', 'Campanha Inverno']);
  const inserirInsight = (org, conta, campanha, data, valores) => sup.query(
    `INSERT INTO meta_insights_daily (organization_id, meta_account_id, level, entidade_id, data, meta_campaign_id, impressions, clicks, spend, purchases, purchase_value)
     VALUES ($1,$2,'campaign',$3,$4,$3,$5,$6,$7,$8,$9)`,
    [org, conta, campanha, data, ...valores]
  );
  await inserirInsight(ORG_A, 'act_A1', 'camp_1', '2026-09-01', [1000, 50, '100.00', 3, '300.00']);
  await inserirInsight(ORG_A, 'act_A1', 'camp_1', '2026-09-02', [1000, 50, '100.00', 2, '200.00']);
  await inserirInsight(ORG_A, 'act_A1', 'camp_2', '2026-09-01', [500, 10, '20.00', 0, '0']);
  // Fora do período pedido nos testes (não deve entrar na soma).
  await inserirInsight(ORG_A, 'act_A1', 'camp_1', '2026-08-01', [999999, 999999, '999999', 999999, '999999']);

  // Org B: nenhuma conta selecionada — prova `connected:false`, nunca herda o zero da Org A.
});

test.after(async () => {
  await appPoolReal?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  await admin.query(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => {});
  await admin.end();
});

test('K · getCampaignPerformance: soma por campanha dentro do período pedido, ignora dia fora do período', () => em(ORG_A, async () => {
  const resultado = await getCampaignPerformance({ pool: poolDe(ORG_A), startDate: '2026-09-01', endDate: '2026-09-02' });
  assert.equal(resultado.connected, true);
  assert.equal(resultado.campaigns.length, 2);
  const c1 = resultado.campaigns.find((c) => c.externalId === 'camp_1');
  assert.equal(c1.name, 'Campanha Verão');
  assert.equal(c1.impressions, 2000);
  assert.equal(c1.clicks, 100);
  assert.equal(c1.spend, 200);
  assert.equal(c1.purchases, 5); // 3 + 2, nunca soma uma variante duas vezes (totalizarSomas já garante isso)
  assert.equal(c1.revenue, 500);
  const c2 = resultado.campaigns.find((c) => c.externalId === 'camp_2');
  assert.equal(c2.purchases, 0);
  assert.equal(c2.spend, 20);
}));

test('K · getCampaignPerformance: connected:false quando a Organization não tem conta Meta selecionada — nunca confundido com zero campanhas', () => em(ORG_B, async () => {
  const resultado = await getCampaignPerformance({ pool: poolDe(ORG_B), startDate: '2026-09-01', endDate: '2026-09-02' });
  assert.deepEqual(resultado, { connected: false, campaigns: [] });
}));

test('K · getCampaignPerformance: isolamento — Org B nunca vê campanha/insight da Org A (RLS)', () => em(ORG_B, async () => {
  const { rows } = await poolDe(ORG_B).query('SELECT * FROM meta_campaigns');
  assert.deepEqual(rows, []);
}));

test('K · getCampaignPerformance exige pool/startDate/endDate; startDate <= endDate', () => em(ORG_A, async () => {
  await assert.rejects(getCampaignPerformance({ startDate: '2026-09-01', endDate: '2026-09-02' }), /exige pool/);
  await assert.rejects(getCampaignPerformance({ pool: poolDe(ORG_A), endDate: '2026-09-02' }), TypeError);
  await assert.rejects(getCampaignPerformance({ pool: poolDe(ORG_A), startDate: '2026-09-02', endDate: '2026-09-01' }), TypeError);
}));
