'use strict';

// Gate A ("Jornada de Valor Operacional") · composition.js#catalogSyncNecessario — decide se UMA
// Organization precisa de um full sync agora, usado pelo scheduler automático (server.js) ANTES de
// disparar. Postgres real (não fake): a tabela-alvo (commerce_catalog_sync_logs) é o contrato real.
// Nenhum registry/connector precisa existir pra este teste — a função só lê o log, nunca resolve
// integração nenhuma.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const { createProductAnalyticsComposition, COMMERCE_PROVIDER } = h.sujeito('lib/product-analytics/composition.js');

const ORG_A = 'f1000000-0000-4000-8000-000000000001';
const ORG_B = 'f1000000-0000-4000-8000-000000000002';
// ORG_C/D/E: uma Organization POR teste que grava timestamp retroativo (startedAtOffsetMs) — nunca
// duas gravações retroativas na MESMA Organization. Motivo: ORDER BY started_at DESC LIMIT 1 pega a
// linha com o maior started_at — se um teste usa offset pequeno (ex.: 1ms) e outro, rodando alguns
// milissegundos DEPOIS na mesma Organization, usa offset grande (ex.: 5000ms), a linha do offset
// PEQUENO continua "mais recente" (started_at maior) mesmo tendo sido inserida antes — o teste do
// offset grande nunca seria o que `catalogSyncNecessario` realmente lê. Isolar por Organization
// remove essa dependência de timing entre testes por completo.
const ORG_C = 'f1000000-0000-4000-8000-000000000003';
const ORG_D = 'f1000000-0000-4000-8000-000000000004';
const ORG_E = 'f1000000-0000-4000-8000-000000000005';
const STORE_A = 'f2000000-0000-4000-8000-000000000001';
const STORE_B = 'f2000000-0000-4000-8000-000000000002';
const STORE_C = 'f2000000-0000-4000-8000-000000000003';
const STORE_D = 'f2000000-0000-4000-8000-000000000004';
const STORE_E = 'f2000000-0000-4000-8000-000000000005';
const ROLE = `oria_app_csn_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');

let db;
let sup;
let fachada;
let composicao;

const em = (org, store, fn) => runtime.comContexto({ organizationId: org, storeId: store, origem: 'teste' }, fn);

async function gravarLog(org, store, { status, startedAtOffsetMs = 0, finishedAtOffsetMs = null }) {
  const syncRunId = crypto.randomUUID();
  const startedAt = new Date(Date.now() - startedAtOffsetMs);
  await sup.query(
    `INSERT INTO commerce_catalog_sync_logs (organization_id, store_id, provider, sync_run_id, status, started_at, finished_at, pages_processed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
    [org, store, COMMERCE_PROVIDER, syncRunId, status, startedAt,
      finishedAtOffsetMs === null ? null : new Date(Date.now() - finishedAtOffsetMs)]
  );
  return syncRunId;
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_catalog_sync_necessario');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 6 });
  fachada = runtime.criarPoolTenant(appPoolReal);
  for (const [org, store, nome] of [
    [ORG_A, STORE_A, 'Org A'], [ORG_B, STORE_B, 'Org B'], [ORG_C, STORE_C, 'Org C'], [ORG_D, STORE_D, 'Org D'], [ORG_E, STORE_E, 'Org E'],
  ]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
  }
  // catalogSyncMaxAgeMs curto (200ms) pra não depender de horas reais de espera no teste — a lógica
  // testada é "mais velho que o limite", nunca um valor de produção específico.
  composicao = createProductAnalyticsComposition({
    pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }),
    catalogSyncMaxAgeMs: 200, catalogSyncLeaseTtlMs: 300,
  });
});

test.after(async () => {
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

test('A · nunca sincronizado (sem log nenhum) → precisa (cobre catálogo novo E recovery de instalação antiga)', () => em(ORG_A, STORE_A, async () => {
  const precisa = await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A });
  assert.equal(precisa, true);
}));

test('A · último run "running" RECENTE → NÃO precisa (em andamento de verdade; o lease de catalog-sync.js protege, o scheduler não dispara por cima)', () => em(ORG_C, STORE_C, async () => {
  await gravarLog(ORG_C, STORE_C, { status: 'running', startedAtOffsetMs: 1, finishedAtOffsetMs: null });
  const precisa = await composicao.catalogSyncNecessario({ organizationId: ORG_C, storeId: STORE_C });
  assert.equal(precisa, false);
}));

test('A · último run "running" ÓRFÃO (mais velho que o TTL do próprio lease) → precisa (achado da auditoria: processo caiu no meio do sync, fecharLog nunca roda, a linha fica "running" pra sempre sem este teto — o lease real já expirou há muito)', () => em(ORG_D, STORE_D, async () => {
  await gravarLog(ORG_D, STORE_D, { status: 'running', startedAtOffsetMs: 5000, finishedAtOffsetMs: null }); // 5s atrás, TTL do lease é 300ms nesta composição
  const precisa = await composicao.catalogSyncNecessario({ organizationId: ORG_D, storeId: STORE_D });
  assert.equal(precisa, true);
}));

test('A · maxRunningAgeMs por chamada sobrescreve o default (nunca hardcoded globalmente)', () => em(ORG_E, STORE_E, async () => {
  await gravarLog(ORG_E, STORE_E, { status: 'running', startedAtOffsetMs: 5000, finishedAtOffsetMs: null });
  // maxRunningAgeMs explícito bem maior que 5s: ainda dentro — não precisa.
  assert.equal(await composicao.catalogSyncNecessario({ organizationId: ORG_E, storeId: STORE_E }, { maxRunningAgeMs: 60000 }), false);
  // Default da composição (300ms): 5s atrás já é órfão — precisa.
  assert.equal(await composicao.catalogSyncNecessario({ organizationId: ORG_E, storeId: STORE_E }), true);
}));

test('A · último run "failed" → precisa (tenta de novo, mesmo recente)', () => em(ORG_A, STORE_A, async () => {
  await gravarLog(ORG_A, STORE_A, { status: 'failed', finishedAtOffsetMs: 10 });
  const precisa = await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A });
  assert.equal(precisa, true);
}));

test('A · último run "partial_failure" → precisa', () => em(ORG_A, STORE_A, async () => {
  await gravarLog(ORG_A, STORE_A, { status: 'partial_failure', finishedAtOffsetMs: 10 });
  const precisa = await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A });
  assert.equal(precisa, true);
}));

test('A · sucesso RECENTE (dentro do maxAgeMs) → não precisa', () => em(ORG_A, STORE_A, async () => {
  await gravarLog(ORG_A, STORE_A, { status: 'success', finishedAtOffsetMs: 1 }); // 1ms atrás, limite é 200ms
  const precisa = await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A });
  assert.equal(precisa, false);
}));

test('A · sucesso VENCIDO (mais velho que maxAgeMs) → precisa', () => em(ORG_A, STORE_A, async () => {
  await gravarLog(ORG_A, STORE_A, { status: 'success', finishedAtOffsetMs: 500 }); // 500ms atrás, limite é 200ms
  const precisa = await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A });
  assert.equal(precisa, true);
}));

test('A · maxAgeMs por chamada sobrescreve o default da composição (nunca hardcoded globalmente)', () => em(ORG_A, STORE_A, async () => {
  await gravarLog(ORG_A, STORE_A, { status: 'success', finishedAtOffsetMs: 50 });
  // Default da composição (200ms): 50ms atrás ainda está dentro — não precisa.
  assert.equal(await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A }), false);
  // maxAgeMs explícito de 10ms: 50ms atrás já venceu — precisa.
  assert.equal(await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A }, { maxAgeMs: 10 }), true);
}));

test('A · Organization isolation: log de A nunca decide o resultado de B', () => em(ORG_A, STORE_A, async () => {
  await gravarLog(ORG_A, STORE_A, { status: 'success', finishedAtOffsetMs: 1 }); // A: sincronizado recente
  await em(ORG_B, STORE_B, async () => {
    const precisaB = await composicao.catalogSyncNecessario({ organizationId: ORG_B, storeId: STORE_B });
    assert.equal(precisaB, true, 'B nunca sincronizou — precisa, independente do estado de A');
  });
  const precisaA = await composicao.catalogSyncNecessario({ organizationId: ORG_A, storeId: STORE_A });
  assert.equal(precisaA, false);
}));
