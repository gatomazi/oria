'use strict';

// Planos e entitlements (§10, §11, §28 · bloco "Plans").
//
// Os seis casos que o comando exige estão aqui, cada um como um teste:
//   unknown feature reject · two active subscriptions reject · plan change updates access
//   override > plan · remove override → inherit · no plan → deny

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

let db;
let app;
let org;
let entitlementsDaCriacao;

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
  await h.criarAdmin(app.pool, { email: 'owner@exemplo.com', papel: 'platform_owner' });
  await app.cliente.login('owner@exemplo.com');
  const r = await app.cliente.post('/api/platform/organizations', {
    nome: 'Org dos Planos',
    store: { nome: 'Store dos Planos' },
    planoChave: 'internal',
    ownerEmail: 'dono@exemplo.com',
    idempotencyKey: h.chaveIdempotencia(),
    bootstrapInterno: true,
    passos: h.PASSOS_DE_TESTE,
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  org = r.corpo.organization;
  entitlementsDaCriacao = r.corpo.entitlements;
});

test.after(async () => {
  await app.fechar();
  await db.destruir();
});

// ── Registry ─────────────────────────────────────────────────────────────────────────────────

test('registry · as TRÊS cópias do vocabulário de features batem (app, painel e banco)', async () => {
  const { FEATURES: doApp, FEATURES_DEPRECIADAS } = h.sujeito('lib/entitlements.js');

  // 1. O registry canônico do painel.
  const doPainel = require(require('node:path').join(
    h.RAIZ_REPO, '..', 'panel', 'lib', 'platform', 'entitlements.js'
  ));
  assert.deepEqual([...doApp].sort(), [...doPainel.FEATURES].sort(),
    'o vocabulário do control plane divergiu do registry canônico do painel');
  assert.deepEqual([...FEATURES_DEPRECIADAS].sort(), Object.keys(doPainel.FEATURES_DEPRECIADAS).sort(),
    'a lista de chaves depreciadas do control plane divergiu do painel');

  // 2. O domain `platform_feature` do banco.
  const { rows } = await app.pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = (SELECT conname FROM pg_constraint c
                         JOIN pg_type t ON t.oid = c.contypid
                        WHERE t.typname = 'platform_feature' LIMIT 1)`
  );
  // Dígitos entram na classe: `analytics_ga4` tem um, e sem eles a chave era descartada do parse
  // e parecia estar FALTANDO no domain — o teste reprovava por um defeito dele, não do banco.
  const doBanco = [...rows[0].def.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  // O domain AINDA aceita as chaves depreciadas. É deliberado: estreitar o domain é a última fase
  // da depreciação (Phase E), depois que nenhuma linha e nenhum ambiente carregarem mais as
  // chaves antigas. O que NÃO pode acontecer é o domain aceitar algo que não seja nem vocabulário
  // comercial nem chave declarada como depreciada — aí seria divergência de verdade.
  assert.deepEqual([...doBanco].sort(), [...doApp, ...FEATURES_DEPRECIADAS].sort(),
    'o domain platform_feature do banco divergiu do registry + depreciadas');
  // E o caminho contrário: feature do vocabulário que o banco não aceita seria plano impossível
  // de gravar. Foi o que aconteceu com meta_ads/google_ads/analytics_ga4 até a 0024.
  for (const f of doApp) assert.ok(doBanco.includes(f), `${f} está no vocabulário e o domain recusa`);
  for (const f of FEATURES_DEPRECIADAS) {
    assert.ok(!doApp.includes(f), `${f} está depreciada e no vocabulário comercial ao mesmo tempo`);
  }
});

test('registry · o plano `internal` é o declarado, e contém tudo que o perfil do Tenant #1 liga', async () => {
  const { FEATURES, FEATURES_INTERNAL, FEATURES_DEPRECIADAS } = h.sujeito('lib/entitlements.js');
  const { rows } = await app.pool.query(
    `SELECT f.feature::text AS feature FROM plans p JOIN plan_features f ON f.plan_id = p.id
      WHERE p.chave = 'internal' AND f.habilitada ORDER BY f.feature`
  );
  const noPlano = rows.map((r) => r.feature);

  // As quatro chaves depreciadas PODEM continuar gravadas: a migration 0024 é aditiva de propósito
  // (o código de produção atual ainda as lê do plano, e o pre-deploy roda antes da troca de
  // release), e a limpeza física é uma migration posterior. Elas são ruído — o que conta é o resto.
  const vigentes = noPlano.filter((f) => !FEATURES_DEPRECIADAS.includes(f));
  assert.deepEqual(vigentes, [...FEATURES_INTERNAL].sort(), 'a composição do internal divergiu do declarado');
  for (const f of noPlano) {
    assert.ok(FEATURES.includes(f) || FEATURES_DEPRECIADAS.includes(f),
      `${f} está no plano internal e não é vocabulário nem chave depreciada declarada`);
  }

  // As duas que o comando manda NÃO incluir automaticamente.
  assert.ok(!noPlano.some((f) => ['instagram', 'advancedAutomations'].includes(f)));
  // As três novas entraram.
  for (const f of ['meta_ads', 'google_ads', 'analytics_ga4']) {
    assert.ok(noPlano.includes(f), `${f} não entrou no plano internal`);
  }

  // O que importa para o acesso: uma chave depreciada gravada NUNCA vira entitlement efetivo.
  // Uma Organization criada agora sobre o `internal` recebe exatamente as features do vocabulário.
  const efetivas = Object.entries(entitlementsDaCriacao).filter(([, v]) => v).map(([k]) => k).sort();
  assert.deepEqual(efetivas, [...FEATURES_INTERNAL].sort());
  for (const f of FEATURES_DEPRECIADAS) {
    assert.ok(!(f in entitlementsDaCriacao), `${f} apareceu nos entitlements efetivos: ruído virou concessão`);
  }

  // Sem regressão para o Tenant #1: o plano contém tudo que o perfil legado liga. O perfil é
  // SUBCONJUNTO do plano — ele semeia app_config, que não decide mais nada (migration 0023).
  const perfil = require(require('node:path').join(
    h.RAIZ_REPO, '..', 'panel', 'config', 'entitlements', 'tenant1-entitlements.json'
  ));
  for (const f of perfil.features) {
    assert.ok(noPlano.includes(f), `o perfil liga ${f} e o plano internal não concede: seria regressão`);
  }
});

test('registry · chave reclassificada é recusada em plano e em override, com motivo', async () => {
  const { FEATURES_DEPRECIADAS } = h.sujeito('lib/entitlements.js');
  for (const [i, f] of FEATURES_DEPRECIADAS.entries()) {
    const plano = await app.cliente.post('/api/platform/plans', { chave: `reclassificada_${i}`, nome: 'X', features: [f] });
    assert.equal(plano.status, 422, `${f} foi aceita num plano`);
    assert.equal(plano.corpo.erro, 'feature_desconhecida');

    const over = await app.cliente.put(`/api/platform/organizations/${org.id}/entitlements/${f}`,
      { permitido: true, motivo: 'não deveria funcionar' });
    assert.equal(over.status, 422, `${f} aceitou override novo`);
  }
});

// ── Plans ────────────────────────────────────────────────────────────────────────────────────

test('unknown feature reject · criar plano com feature fora do vocabulário é 422', async () => {
  const r = await app.cliente.post('/api/platform/plans',
    { chave: 'invalido', nome: 'Inválido', features: ['financial', 'teletransporte'] });
  assert.equal(r.status, 422);
  assert.equal(r.corpo.erro, 'feature_desconhecida');
  assert.deepEqual(r.corpo.detalhes.features, ['teletransporte']);

  // E não sobrou plano meio-criado.
  const { rows } = await app.pool.query(`SELECT count(*)::int AS n FROM plans WHERE chave = 'invalido'`);
  assert.equal(rows[0].n, 0);
});

test('unknown feature reject · override de feature desconhecida é 422', async () => {
  const r = await app.cliente.put(`/api/platform/organizations/${org.id}/entitlements/teletransporte`,
    { permitido: true, motivo: 'não deveria funcionar' });
  assert.equal(r.status, 422);
  assert.equal(r.corpo.erro, 'feature_desconhecida');
});

test('unknown feature reject · o banco recusa mesmo com SQL direto', async () => {
  const { rows: [p] } = await app.pool.query(`SELECT id FROM plans WHERE chave = 'internal'`);
  await assert.rejects(
    () => app.pool.query(`INSERT INTO plan_features (plan_id, feature) VALUES ($1, 'teletransporte')`, [p.id]),
    /platform_feature|check/i
  );
});

test('two active subscriptions reject · o banco torna a segunda impossível', async () => {
  const { rows: [p] } = await app.pool.query(`SELECT id FROM plans WHERE chave = 'internal'`);
  await assert.rejects(
    () => app.pool.query(
      `INSERT INTO organization_subscriptions (organization_id, plan_id) VALUES ($1, $2)`, [org.id, p.id]
    ),
    (err) => err.code === '23505',
    'duas assinaturas ativas foram aceitas'
  );
});

test('plan change updates access · trocar de plano muda o acesso efetivo na hora', async () => {
  const magro = await app.cliente.post('/api/platform/plans',
    { chave: 'magro', nome: 'Magro', features: ['financial'] });
  assert.equal(magro.status, 201);

  const antes = await app.cliente.get(`/api/platform/organizations/${org.id}/entitlements`);
  assert.equal(antes.corpo.efetivos.whatsapp, true);

  const troca = await app.cliente.put(`/api/platform/organizations/${org.id}/subscription`,
    { planoChave: 'magro', motivo: 'teste de troca' });
  assert.equal(troca.status, 200);
  assert.equal(troca.corpo.plano.chave, 'magro');
  assert.equal(troca.corpo.entitlements.efetivos.whatsapp, false);
  assert.equal(troca.corpo.entitlements.efetivos.financial, true);
  assert.equal(troca.corpo.entitlements.origem.whatsapp, 'ausente');

  // A antiga foi cancelada, não deletada: o histórico fica.
  const hist = await app.cliente.get(`/api/platform/organizations/${org.id}/subscription`);
  assert.equal(hist.corpo.historico.length, 2);
  assert.equal(hist.corpo.historico.filter((s) => s.status === 'active').length, 1);
  assert.ok(hist.corpo.historico.some((s) => s.status === 'canceled' && s.plano.chave === 'internal'));
});

test('trocar para o MESMO plano não muda nada e não gera auditoria nova', async () => {
  const { rows: antes } = await app.pool.query(
    `SELECT count(*)::int AS n FROM platform_audit_logs WHERE action IN ('subscription.changed', 'subscription.created')`
  );
  const r = await app.cliente.put(`/api/platform/organizations/${org.id}/subscription`, { planoChave: 'magro' });
  assert.equal(r.status, 200);
  const { rows: depois } = await app.pool.query(
    `SELECT count(*)::int AS n FROM platform_audit_logs WHERE action IN ('subscription.changed', 'subscription.created')`
  );
  assert.equal(depois[0].n, antes[0].n);
});

// ── Override ─────────────────────────────────────────────────────────────────────────────────

test('override > plan · o override CONCEDE o que o plano não dá', async () => {
  const r = await app.cliente.put(`/api/platform/organizations/${org.id}/entitlements/whatsapp`,
    { permitido: true, motivo: 'liberado para a operação interna' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.efetivos.whatsapp, true);
  assert.equal(r.corpo.origem.whatsapp, 'override');
});

test('override > plan · o override também NEGA o que o plano dá', async () => {
  const r = await app.cliente.put(`/api/platform/organizations/${org.id}/entitlements/financial`,
    { permitido: false, motivo: 'suspenso temporariamente' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.efetivos.financial, false);
  assert.equal(r.corpo.origem.financial, 'override');
  // Sem `permitido: false` o override seria só "conceder"; a precedência precisa valer nos dois
  // sentidos, senão a plataforma não consegue cortar acesso sem trocar o plano da Organization.
});

test('remove override → inherit · remover devolve a decisão ao PLANO, não a false', async () => {
  const remover = await app.cliente.delete(`/api/platform/organizations/${org.id}/entitlements/financial`);
  assert.equal(remover.status, 200);
  assert.equal(remover.corpo.efetivos.financial, true, 'voltou false em vez de herdar do plano');
  assert.equal(remover.corpo.origem.financial, 'plano');

  const outro = await app.cliente.delete(`/api/platform/organizations/${org.id}/entitlements/whatsapp`);
  assert.equal(outro.status, 200);
  assert.equal(outro.corpo.efetivos.whatsapp, false);
  assert.equal(outro.corpo.origem.whatsapp, 'ausente');
});

test('remover override inexistente é 404', async () => {
  const r = await app.cliente.delete(`/api/platform/organizations/${org.id}/entitlements/instagram`);
  assert.equal(r.status, 404);
});

// ── Ausência nega ────────────────────────────────────────────────────────────────────────────

test('no plan → deny · sem assinatura ativa, TUDO é negado (inclusive com override true)', async () => {
  await app.cliente.put(`/api/platform/organizations/${org.id}/entitlements/financial`,
    { permitido: true, motivo: 'override que não deve sobreviver ao cancelamento' });

  await app.pool.query(
    `UPDATE organization_subscriptions SET status = 'canceled', cancelada_em = now()
      WHERE organization_id = $1 AND status = 'active'`,
    [org.id]
  );

  const r = await app.cliente.get(`/api/platform/organizations/${org.id}/entitlements`);
  assert.equal(r.status, 200);
  assert.ok(Object.values(r.corpo.efetivos).every((v) => v === false), 'sem assinatura, algo continuou liberado');
  assert.ok(Object.values(r.corpo.origem).every((o) => o === 'sem_assinatura'));
  // O override continua GRAVADO — ele só não tem efeito sem assinatura.
  assert.ok(r.corpo.overrides.some((o) => o.feature === 'financial' && o.permitido === true));
});

test('o resolver puro nega por ausência, por suspensão e por falta de assinatura', () => {
  const { resolverAcessoEfetivo, FEATURES } = h.sujeito('lib/entitlements.js');

  const completo = (r) => {
    // Nunca devolve objeto parcial: objeto parcial é o que convida ao `{...DEFAULTS, ...plano}`.
    assert.deepEqual(Object.keys(r.efetivos).sort(), [...FEATURES].sort());
  };

  const semNada = resolverAcessoEfetivo({ organizationStatus: 'active', assinaturaAtiva: true });
  completo(semNada);
  assert.ok(Object.values(semNada.efetivos).every((v) => v === false));

  const suspensa = resolverAcessoEfetivo({
    organizationStatus: 'suspended', assinaturaAtiva: true,
    featuresDoPlano: { financial: true }, overrides: { whatsapp: true },
  });
  assert.equal(suspensa.efetivos.financial, false);
  assert.equal(suspensa.efetivos.whatsapp, false);

  const semAssinatura = resolverAcessoEfetivo({
    organizationStatus: 'active', assinaturaAtiva: false, featuresDoPlano: { financial: true },
  });
  assert.equal(semAssinatura.efetivos.financial, false);

  // E o caso feliz, para o teste não passar por estar sempre negando.
  const ok = resolverAcessoEfetivo({
    organizationStatus: 'active', assinaturaAtiva: true,
    featuresDoPlano: { financial: true, instagram: false }, overrides: { instagram: true, financial: false },
  });
  assert.equal(ok.efetivos.financial, false, 'o override nega o que o plano concede');
  assert.equal(ok.efetivos.instagram, true);
  assert.equal(ok.origem.instagram, 'override');
  assert.equal(ok.efetivos.financial, false);
  assert.equal(ok.origem.financial, 'override');
});

// ── Papéis ───────────────────────────────────────────────────────────────────────────────────

test('platform_operator lê planos mas não cria nem arquiva', async () => {
  await h.criarAdmin(app.pool, { email: 'operador@exemplo.com', papel: 'platform_operator' });
  const operador = h.criarCliente(app.base);
  await operador.login('operador@exemplo.com');

  assert.equal((await operador.get('/api/platform/plans')).status, 200);

  const criar = await operador.post('/api/platform/plans', { chave: 'do_operador', nome: 'X', features: [] });
  assert.equal(criar.status, 403);
  assert.equal(criar.corpo.erro, 'papel_insuficiente');

  // Mas ele PODE operar Organization: suspender, override, convite, troca de plano.
  const suspender = await operador.post(`/api/platform/organizations/${org.id}/suspend`, { motivo: 'teste de papel' });
  assert.equal(suspender.status, 200);
  await operador.post(`/api/platform/organizations/${org.id}/reactivate`, { motivo: 'fim do teste' });
});

test('arquivar plano em uso é recusado', async () => {
  const { rows: [p] } = await app.pool.query(`SELECT id FROM plans WHERE chave = 'magro'`);
  // Devolve a assinatura para o `magro` antes de tentar arquivar.
  await app.cliente.put(`/api/platform/organizations/${org.id}/subscription`, { planoChave: 'magro' });
  const r = await app.cliente.post(`/api/platform/plans/${p.id}/archive`);
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro, 'plano_com_assinatura_ativa');
});
