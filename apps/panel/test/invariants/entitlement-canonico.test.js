'use strict';

// Entitlement canônico — o painel lê a fonte do Control Plane, e não `app_config`.
//
// ── O bug que este arquivo trava ─────────────────────────────────────────────────────────────
// O Oria Admin concede plano gravando `organization_subscriptions` + `plan_features`. O painel lia
// `app_config` com a chave `entitlements`, escrita só por script de linha de comando. Uma
// Organization criada pela interface nascia com plano concedido e o painel enxergando NADA: toda
// rota com guard respondia 403, e a tela dizia "não incluído no plano".
//
// Aconteceu com o Tenant #1 em produção: `internal` ativo, 10 features no plano, zero linhas em
// `app_config`. O teste principal aqui reproduz exatamente esse estado — assinatura pelo caminho do
// Admin, `app_config` VAZIO — e exige acesso correto.
//
// A precedência conferida é a mesma do control plane: override > plano > false, e Organization
// suspensa ou sem assinatura ativa nega tudo.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { carregadorDaOrganizacao, estadoDoAcesso, planoEfetivo, checkEntitlement, EntitlementDeniedError } =
  h.sujeito('lib/platform/entitlements.js');

let db;
let sup;
let pool;

const ORG_A = 'c1000000-0000-4000-8000-00000000000a';
const ORG_B = 'c1000000-0000-4000-8000-00000000000b';

const em = (org, fn) => runtime.comContexto({ organizationId: org, storeId: null, loja: null }, fn);

async function criarOrganizationComPlano(org, nome, { features, planoChave, status = 'active', assinatura = 'active' }) {
  await sup.query('INSERT INTO organizations (id, nome, status) VALUES ($1, $2, $3)', [org, nome, status]);
  const { rows: [plano] } = await sup.query(
    'INSERT INTO plans (chave, nome, status) VALUES ($1, $2, $3) RETURNING id',
    [planoChave, nome, 'active']
  );
  for (const [feature, habilitada] of Object.entries(features)) {
    await sup.query('INSERT INTO plan_features (plan_id, feature, habilitada) VALUES ($1, $2, $3)',
      [plano.id, feature, habilitada]);
  }
  // O schema exige coerência: assinatura cancelada precisa de data de cancelamento.
  await sup.query(
    `INSERT INTO organization_subscriptions (organization_id, plan_id, status, cancelada_em)
     VALUES ($1, $2, $3, CASE WHEN $3 = 'canceled' THEN now() END)`,
    [org, plano.id, assinatura]
  );
  return plano.id;
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_ent_canon');
  assert.equal(h.migrar(db.url).status, 0);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  pool = runtime.criarPoolTenant(sup);

  // Exatamente o estado do Tenant #1: plano concedido pelo Admin, NADA em app_config.
  await criarOrganizationComPlano(ORG_A, 'Tenant Um', {
    planoChave: 'internal_teste',
    // `instagram` é feature comercial que o plano NÃO concede — o equivalente, no vocabulário
    // reclassificado, ao que `catalog` era antes de virar capacidade do connector.
    features: { whatsapp: true, financial: true, creative_generator: true, instagram: false },
  });
  await criarOrganizationComPlano(ORG_B, 'Outro Tenant', {
    planoChave: 'outro_teste',
    features: { whatsapp: true, advancedAutomations: true },
  });
});

test.after(async () => {
  await sup.end().catch(() => {});
  await db.destruir();
});

// ── O teste que prova o bug encontrado em produção ───────────────────────────────────────────

test('canônico · Organization criada pelo Admin tem acesso SEM nenhuma linha em app_config', async () => {
  const { rows } = await sup.query("SELECT count(*)::int AS n FROM app_config WHERE chave = 'entitlements'");
  assert.equal(rows[0].n, 0, 'o cenário exige app_config vazio — é o estado real do Tenant #1');

  const plano = await em(ORG_A, () => planoEfetivo(carregadorDaOrganizacao(pool)));
  assert.equal(plano.whatsapp, true, 'feature do plano precisa chegar ao painel sem seed');
  assert.equal(plano.financial, true);
  assert.equal(plano.creative_generator, true);
  assert.equal(plano.instagram, false, 'feature desabilitada no plano continua negada');
  assert.equal(plano.advancedAutomations, false, 'feature fora do plano é negada por ausência');
});

test('canônico · o guard de rota concede pelo plano e nega o que o plano não tem', async () => {
  await em(ORG_A, async () => {
    const carregar = carregadorDaOrganizacao(pool);
    assert.equal(await checkEntitlement(carregar, 'whatsapp'), true);
    await assert.rejects(() => checkEntitlement(carregar, 'instagram'), EntitlementDeniedError);
  });
});

// ── Precedência: override > plano > false ────────────────────────────────────────────────────

test('canônico · override false bloqueia feature concedida pelo plano', async () => {
  await sup.query(
    `INSERT INTO organization_entitlement_overrides (organization_id, feature, permitido, motivo)
     VALUES ($1, 'whatsapp', false, 'teste de precedência')`,
    [ORG_A]
  );
  try {
    const plano = await em(ORG_A, () => planoEfetivo(carregadorDaOrganizacao(pool)));
    assert.equal(plano.whatsapp, false, 'override negativo precisa vencer o plano');
    assert.equal(plano.financial, true, 'as demais não são afetadas');
  } finally {
    await sup.query('DELETE FROM organization_entitlement_overrides WHERE organization_id = $1', [ORG_A]);
  }
});

test('canônico · override true concede feature que o plano NÃO tem', async () => {
  await sup.query(
    `INSERT INTO organization_entitlement_overrides (organization_id, feature, permitido, motivo)
     VALUES ($1, 'instagram', true, 'teste de precedência')`,
    [ORG_A]
  );
  try {
    const plano = await em(ORG_A, () => planoEfetivo(carregadorDaOrganizacao(pool)));
    assert.equal(plano.instagram, true, 'override positivo concede fora do plano');
  } finally {
    await sup.query('DELETE FROM organization_entitlement_overrides WHERE organization_id = $1', [ORG_A]);
  }
});

// ── Estado da Organization e da assinatura ───────────────────────────────────────────────────

test('canônico · sem assinatura ativa, tudo é negado', async () => {
  const org = 'c1000000-0000-4000-8000-00000000000c';
  await criarOrganizationComPlano(org, 'Sem Assinatura', {
    planoChave: 'plano_inativo', features: { whatsapp: true }, assinatura: 'canceled',
  });
  const plano = await em(org, () => planoEfetivo(carregadorDaOrganizacao(pool)));
  assert.equal(plano.whatsapp, false, 'assinatura não ativa não concede nada');

  const estado = await em(org, () => estadoDoAcesso(pool));
  assert.equal(estado.assinaturaAtiva, false);
  assert.equal(estado.organizacaoAtiva, true, 'a Organization em si continua ativa — são causas diferentes');
});

test('canônico · Organization suspensa nega tudo, inclusive o que o override concede', async () => {
  const org = 'c1000000-0000-4000-8000-00000000000d';
  await criarOrganizationComPlano(org, 'Suspensa', {
    planoChave: 'plano_suspenso', features: { whatsapp: true }, status: 'suspended',
  });
  await sup.query(
    `INSERT INTO organization_entitlement_overrides (organization_id, feature, permitido, motivo)
     VALUES ($1, 'financial', true, 'não deve valer com a org suspensa')`,
    [org]
  );

  const plano = await em(org, () => planoEfetivo(carregadorDaOrganizacao(pool)));
  assert.equal(plano.whatsapp, false);
  assert.equal(plano.financial, false, 'suspensão vence o override');

  const estado = await em(org, () => estadoDoAcesso(pool));
  assert.equal(estado.organizacaoAtiva, false);
});

// ── Isolamento ───────────────────────────────────────────────────────────────────────────────

test('canônico · o plano de uma Organization não vaza para outra', async () => {
  const a = await em(ORG_A, () => planoEfetivo(carregadorDaOrganizacao(pool)));
  const b = await em(ORG_B, () => planoEfetivo(carregadorDaOrganizacao(pool)));
  assert.equal(a.financial, true);
  assert.equal(b.financial, false, 'B não tem financial no plano dela');
  assert.equal(b.advancedAutomations, true);
  assert.equal(a.advancedAutomations, false, 'A não tem advancedAutomations no plano dela');
});

test('canônico · sem contexto de Organization, o resolver recusa em vez de adivinhar', async () => {
  await assert.rejects(() => carregadorDaOrganizacao(pool)(), /contexto de Organization/);
  await assert.rejects(() => estadoDoAcesso(pool), /contexto de Organization/);
});

// ── app_config não é mais fonte ──────────────────────────────────────────────────────────────

test('canônico · linha em app_config NÃO concede nada por si só', async () => {
  const org = 'c1000000-0000-4000-8000-00000000000e';
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, 'So App Config']);
  await sup.query(
    `INSERT INTO app_config (organization_id, chave, valor)
     VALUES ($1, 'entitlements', '{"whatsapp": true, "financial": true}'::jsonb)`,
    [org]
  );

  const plano = await em(org, () => planoEfetivo(carregadorDaOrganizacao(pool)));
  assert.equal(plano.whatsapp, false,
    'app_config deixou de ser fonte de verdade: sem assinatura no Control Plane, não há acesso');
  assert.equal(plano.financial, false);
});

// ── Sob a role da aplicação ──────────────────────────────────────────────────────────────────

test('canônico · funciona sob oria_app, sem GRANT nas tabelas comerciais', async (t) => {
  const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
  const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
  const role = `oria_app_ent_${crypto.randomBytes(4).toString('hex')}`;
  const senha = crypto.randomBytes(12).toString('hex');
  for (const sql of sqlProvisionarAppRole({ role, senha, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const app = h.abrirPoolDescartavel(h.urlComUsuario(db.url, role, senha), { max: 2 });
  t.after(async () => { await app.end().catch(() => {}); });

  const fachada = runtime.criarPoolTenant(app);
  const plano = await em(ORG_A, () => planoEfetivo(carregadorDaOrganizacao(fachada)));
  assert.equal(plano.whatsapp, true, 'a role da aplicação precisa conseguir resolver o plano');

  // E continua SEM acesso direto às tabelas comerciais da plataforma.
  await assert.rejects(
    () => app.query('SELECT * FROM plan_features'),
    /permission denied/,
    'a role não pode ler o catálogo de planos da plataforma'
  );
});
