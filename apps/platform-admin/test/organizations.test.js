'use strict';

// Criação de Organization, gate do Tenant #1, segurança de alvo, suspensão e membros.
//
// O teste decisivo deste arquivo é `alvo · A na rota + B forjada no corpo`: ele é o que reprova a
// classe de defeito em que um valor do cliente vira autoridade. Os outros são condições de contorno
// do fluxo que o usuário vai executar amanhã.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

let db;
let app;

const criarOrg = (cliente, extra = {}) => cliente.post('/api/platform/organizations', {
  nome: 'Organization de Teste',
  store: { nome: 'Store de Teste' },
  planoChave: 'internal',
  ownerEmail: 'dono@exemplo.com',
  idempotencyKey: h.chaveIdempotencia(),
  bootstrapInterno: true,
  passos: h.PASSOS_DE_TESTE,
  ...extra,
});

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
  await h.criarAdmin(app.pool, { email: 'owner@exemplo.com', papel: 'platform_owner' });
  // Um segundo owner para as instâncias auxiliares: o login revoga as outras sessões DO MESMO
  // admin (anti-fixation), então reusar o mesmo e-mail derrubaria a sessão principal no meio da
  // suíte — e o teste falharia por 401, escondendo o que ele deveria medir.
  await h.criarAdmin(app.pool, { email: 'owner2@exemplo.com', papel: 'platform_owner' });
  await app.cliente.login('owner@exemplo.com');
});

test.after(async () => {
  await app.fechar();
  await db.destruir();
});

test('o banco de teste começa SEM nenhuma Organization (é o que torna o gate testável)', async () => {
  const r = await app.cliente.get('/api/platform/organizations');
  assert.equal(r.status, 200);
  assert.deepEqual(r.corpo.itens, []);
  const o = await app.cliente.get('/api/platform/overview');
  assert.equal(o.corpo.organizations.total, 0);
  assert.equal(o.corpo.bootstrapInternoDisponivel, true);
  assert.equal(o.corpo.secondTenantEnabled, false);
});

test('sem bootstrapInterno e com SECOND_TENANT_ENABLED desligado, criar é 403', async () => {
  const r = await criarOrg(app.cliente, { bootstrapInterno: false });
  assert.equal(r.status, 403);
  assert.equal(r.corpo.erro, 'second_tenant_disabled');
});

test('criação · Organization + Store 1:1 + assinatura + convite + onboarding + auditoria, tudo de uma vez', async () => {
  const r = await criarOrg(app.cliente, { nome: 'Primeira Org', store: { nome: 'Primeira Store' } });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  const c = r.corpo;

  assert.equal(c.criada, true);
  assert.equal(c.organization.nome, 'Primeira Org');
  assert.equal(c.organization.status, 'active');
  assert.equal(c.store.nome, 'Primeira Store');
  assert.equal(c.subscription.plano.chave, 'internal');

  // O plano técnico `internal` concede exatamente as features COMERCIAIS do perfil do Tenant #1.
  const { FEATURES_INTERNAL } = h.sujeito('lib/entitlements.js');
  const ligadas = Object.entries(c.entitlements).filter(([, v]) => v).map(([k]) => k).sort();
  assert.deepEqual(ligadas, [...FEATURES_INTERNAL].sort());
  assert.equal(c.entitlements.instagram, false);
  assert.equal(c.entitlements.advancedAutomations, false);

  // Convite: token na resposta (uma vez só), hash no banco.
  assert.match(c.invite.token, /^[A-Za-z0-9_-]{43}$/);
  const { rows } = await app.pool.query('SELECT token_hash FROM organization_owner_invites WHERE id = $1', [c.invite.id]);
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].token_hash, c.invite.token);

  // Store 1:1 é a UNIQUE, não convenção.
  const { rows: stores } = await app.pool.query('SELECT count(*)::int AS n FROM stores WHERE organization_id = $1', [c.organization.id]);
  assert.equal(stores[0].n, 1);

  // Onboarding nasceu, com `owner` ainda pendente (há convite, não há owner).
  const passoOwner = c.onboarding.passos.find((p) => p.id === 'owner');
  assert.equal(passoOwner.status, 'pending');
  assert.equal(c.onboarding.passos.find((p) => p.id === 'org_store').status, 'complete');

  // Auditoria da criação, com a Organization.
  const { rows: auditoria } = await app.pool.query(
    `SELECT action, organization_id FROM platform_audit_logs WHERE action = 'organization.created'`
  );
  assert.equal(auditoria.length, 1);
  assert.equal(auditoria[0].organization_id, c.organization.id);

  // A resposta inteira não carrega hash nem segredo.
  assert.doesNotMatch(r.texto, /token_hash|password|ciphertext/i);
});

test('depois do Tenant #1, o bootstrap interno RECUSA para sempre', async () => {
  const r = await criarOrg(app.cliente, { nome: 'Segunda Org' });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro, 'bootstrap_interno_indisponivel');

  const o = await app.cliente.get('/api/platform/overview');
  assert.equal(o.corpo.bootstrapInternoDisponivel, false);
});

test('o gate NÃO olha o nome: "Use Origens" não é tratado de forma especial', async () => {
  const r = await criarOrg(app.cliente, { nome: 'Use Origens', store: { nome: 'Use Origens' } });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro, 'bootstrap_interno_indisponivel');
});

test('com SECOND_TENANT_ENABLED=1, criar tenant externo é permitido', async () => {
  const externo = await h.subirApp(db.url, { SECOND_TENANT_ENABLED: '1' });
  try {
    await externo.cliente.login('owner2@exemplo.com');
    const r = await criarOrg(externo.cliente, { nome: 'Org Externa', ownerEmail: 'externo@exemplo.com', bootstrapInterno: false });
    assert.equal(r.status, 201, JSON.stringify(r.corpo));
    assert.equal(r.corpo.organization.nome, 'Org Externa');
  } finally {
    await externo.fechar();
  }
});

test('idempotência · mesma chave + mesmo pedido devolve a MESMA Organization, sem criar outra', async () => {
  const externo = await h.subirApp(db.url, { SECOND_TENANT_ENABLED: '1' });
  try {
    await externo.cliente.login('owner2@exemplo.com');
    const chave = h.chaveIdempotencia();
    const pedido = {
      nome: 'Org Idempotente',
      store: { nome: 'Store Idempotente' },
      planoChave: 'internal',
      ownerEmail: 'idem@exemplo.com',
      idempotencyKey: chave,
      bootstrapInterno: false,
      passos: h.PASSOS_DE_TESTE,
    };
    const a = await externo.cliente.post('/api/platform/organizations', pedido);
    const b = await externo.cliente.post('/api/platform/organizations', pedido);
    assert.equal(a.status, 201);
    assert.equal(b.status, 200);
    assert.equal(b.corpo.criada, false);
    assert.equal(b.corpo.organization.id, a.corpo.organization.id);

    const { rows } = await externo.pool.query(`SELECT count(*)::int AS n FROM organizations WHERE nome = 'Org Idempotente'`);
    assert.equal(rows[0].n, 1);

    // Mesma chave, pedido diferente: conflito, não retorno.
    const c = await externo.cliente.post('/api/platform/organizations', { ...pedido, nome: 'Outro Nome' });
    assert.equal(c.status, 409);
    assert.equal(c.corpo.erro, 'idempotency_key_reutilizada');
  } finally {
    await externo.fechar();
  }
});

// O teste acima roda com SECOND_TENANT_ENABLED=1, que pula o gate — e foi por isso que o bug
// abaixo passou despercebido. Este cobre o caminho que realmente vai ser usado: bootstrap interno,
// gate ligado, e o operador reenviando o mesmo formulário.
test('idempotência · reenvio do bootstrap interno devolve a Organization, não 409 do gate', async () => {
  // Banco próprio: o gate de bootstrap só vale enquanto NÃO há Organization, e o banco desta
  // suíte já tem uma criada pelos testes anteriores.
  const limpo = await h.bancoNovo();
  const bootstrap = await h.subirApp(limpo.url);
  try {
    await h.criarAdmin(bootstrap.pool, { email: 'owner-bootstrap@exemplo.com', papel: 'platform_owner' });
    await bootstrap.cliente.login('owner-bootstrap@exemplo.com');
    const chave = h.chaveIdempotencia();
    const pedido = {
      nome: 'Org Bootstrap',
      store: { nome: 'Store Bootstrap' },
      planoChave: 'internal',
      ownerEmail: 'bootstrap@exemplo.com',
      idempotencyKey: chave,
      bootstrapInterno: true,
      passos: h.PASSOS_DE_TESTE,
    };
    const a = await bootstrap.cliente.post('/api/platform/organizations', pedido);
    assert.equal(a.status, 201);

    // Mesmo pedido de novo: é o clique duplo / refresh / retry de rede.
    const b = await bootstrap.cliente.post('/api/platform/organizations', pedido);
    assert.equal(b.status, 200, `esperava replay idempotente, veio ${b.status} ${b.corpo.erro || ''}`);
    assert.equal(b.corpo.criada, false);
    assert.equal(b.corpo.organization.id, a.corpo.organization.id);

    const { rows } = await bootstrap.pool.query(`SELECT count(*)::int AS n FROM organizations WHERE nome = 'Org Bootstrap'`);
    assert.equal(rows[0].n, 1);

    // O gate continua valendo para chave NOVA: a segunda Organization não nasce.
    const outra = await bootstrap.cliente.post('/api/platform/organizations', {
      ...pedido, nome: 'Org Bootstrap 2', idempotencyKey: h.chaveIdempotencia(),
    });
    assert.equal(outra.status, 409);
    assert.equal(outra.corpo.erro, 'bootstrap_interno_indisponivel');
  } finally {
    await bootstrap.fechar();
    await limpo.destruir();
  }
});

test('chave de idempotência ausente ou curta é recusada', async () => {
  const r = await criarOrg(app.cliente, { idempotencyKey: 'curta' });
  assert.equal(r.status, 400);
  assert.equal(r.corpo.erro, 'idempotency_key_invalida');
});

test('plano desconhecido e plano arquivado são recusados', async () => {
  const externo = await h.subirApp(db.url, { SECOND_TENANT_ENABLED: '1' });
  try {
    await externo.cliente.login('owner2@exemplo.com');
    const desconhecido = await criarOrg(externo.cliente, { planoChave: 'nao_existe', bootstrapInterno: false });
    assert.equal(desconhecido.status, 422);
    assert.equal(desconhecido.corpo.erro, 'plano_desconhecido');

    const plano = await externo.cliente.post('/api/platform/plans', { chave: 'arquivado', nome: 'Arquivado', features: [] });
    await externo.cliente.post(`/api/platform/plans/${plano.corpo.id}/archive`);
    const arquivado = await criarOrg(externo.cliente, { planoChave: 'arquivado', bootstrapInterno: false });
    assert.equal(arquivado.status, 422);
    assert.equal(arquivado.corpo.erro, 'plano_arquivado');
  } finally {
    await externo.fechar();
  }
});

test('sem configuração de passos, a criação é recusada — não existe plano padrão de onboarding', async () => {
  const externo = await h.subirApp(db.url, { SECOND_TENANT_ENABLED: '1' });
  try {
    await externo.cliente.login('owner2@exemplo.com');
    const r = await externo.cliente.post('/api/platform/organizations', {
      nome: 'Sem Passos',
      store: { nome: 'Sem Passos' },
      planoChave: 'internal',
      ownerEmail: 'sem@exemplo.com',
      idempotencyKey: h.chaveIdempotencia(),
      bootstrapInterno: false,
    });
    assert.equal(r.status, 409);
    assert.equal(r.corpo.erro, 'onboarding_config_required');
  } finally {
    await externo.fechar();
  }
});

// ── O teste decisivo (§28 · tenant safety) ───────────────────────────────────────────────────
test('alvo · Organization A na rota + Organization B forjada no corpo → B nunca vira autoridade', async () => {
  const lista = await app.cliente.get('/api/platform/organizations');
  const [a, b] = lista.corpo.itens;
  assert.ok(a && b, 'o teste precisa de duas Organizations');

  // 1. Forjar no corpo é 400 EXPLÍCITO — não "ignorado em silêncio".
  const forjado = await app.cliente.post(`/api/platform/organizations/${a.id}/suspend`, {
    motivo: 'teste de autoridade',
    organization_id: b.id,
  });
  assert.equal(forjado.status, 400);
  assert.equal(forjado.corpo.erro, 'organization_no_corpo');
  assert.deepEqual(forjado.corpo.detalhes.campos, ['organization_id']);

  // 2. E nenhuma das duas mudou de estado.
  for (const org of [a, b]) {
    const { rows } = await app.pool.query('SELECT status FROM platform_organization_resumo($1)', [org.id]);
    assert.equal(rows[0].status, 'active');
  }

  // 3. A rota legítima afeta SÓ a Organization da rota.
  const ok = await app.cliente.post(`/api/platform/organizations/${a.id}/suspend`, { motivo: 'teste de alvo' });
  assert.equal(ok.status, 200);
  const { rows: depoisA } = await app.pool.query('SELECT status FROM platform_organization_resumo($1)', [a.id]);
  const { rows: depoisB } = await app.pool.query('SELECT status FROM platform_organization_resumo($1)', [b.id]);
  assert.equal(depoisA[0].status, 'suspended');
  assert.equal(depoisB[0].status, 'active', 'a Organization B mudou de estado — o alvo vazou');

  await app.cliente.post(`/api/platform/organizations/${a.id}/reactivate`, { motivo: 'fim do teste' });
});

test('suspensão · A suspensa, B normal: efeito real e dados preservados', async () => {
  const lista = await app.cliente.get('/api/platform/organizations');
  const [a, b] = lista.corpo.itens;

  const antes = await app.cliente.get(`/api/platform/organizations/${a.id}`);
  const membrosAntes = antes.corpo.membros.length;

  const r = await app.cliente.post(`/api/platform/organizations/${a.id}/suspend`, { motivo: 'inadimplência simulada' });
  assert.equal(r.status, 200);
  assert.equal(r.corpo.status, 'suspended');

  // 1. Entitlements: TUDO negado para A, e a origem diz por quê.
  const entA = await app.cliente.get(`/api/platform/organizations/${a.id}/entitlements`);
  assert.ok(Object.values(entA.corpo.efetivos).every((v) => v === false));
  assert.ok(Object.values(entA.corpo.origem).every((o) => o === 'organization_suspensa'));

  // 2. B não foi afetada.
  const entB = await app.cliente.get(`/api/platform/organizations/${b.id}/entitlements`);
  assert.equal(entB.corpo.efetivos.financial, true);

  // 3. Os jobs/schedulers deixam de ver A.
  const { rows: ativas } = await app.pool.query('SELECT id FROM platform_organizations_ativas()');
  assert.ok(!ativas.some((o) => o.id === a.id), 'Organization suspensa continua na lista dos jobs');
  assert.ok(ativas.some((o) => o.id === b.id));

  // 4. Os dados ficam, e o Admin continua vendo.
  const depois = await app.cliente.get(`/api/platform/organizations/${a.id}`);
  assert.equal(depois.status, 200);
  assert.equal(depois.corpo.store.nome, antes.corpo.store.nome);
  assert.equal(depois.corpo.membros.length, membrosAntes);
  assert.equal(depois.corpo.suspensao.motivo, 'inadimplência simulada');

  // 5. Reativar restaura.
  await app.cliente.post(`/api/platform/organizations/${a.id}/reactivate`, { motivo: 'regularizado' });
  const voltou = await app.cliente.get(`/api/platform/organizations/${a.id}/entitlements`);
  assert.equal(voltou.corpo.efetivos.financial, true);
});

test('suspender de novo é idempotente e não duplica auditoria', async () => {
  const lista = await app.cliente.get('/api/platform/organizations');
  const a = lista.corpo.itens[0];
  await app.cliente.post(`/api/platform/organizations/${a.id}/suspend`, { motivo: 'motivo um' });
  const { rows: antes } = await app.pool.query(
    `SELECT count(*)::int AS n FROM platform_audit_logs WHERE organization_id = $1 AND action = 'organization.suspended'`, [a.id]
  );
  const repetido = await app.cliente.post(`/api/platform/organizations/${a.id}/suspend`, { motivo: 'motivo dois' });
  assert.equal(repetido.status, 200);
  assert.equal(repetido.corpo.mudou, false);
  const { rows: depois } = await app.pool.query(
    `SELECT count(*)::int AS n FROM platform_audit_logs WHERE organization_id = $1 AND action = 'organization.suspended'`, [a.id]
  );
  assert.equal(depois[0].n, antes[0].n);
  await app.cliente.post(`/api/platform/organizations/${a.id}/reactivate`, { motivo: 'fim' });
});

test('Organization inexistente e id malformado dão o MESMO 404', async () => {
  const inexistente = await app.cliente.get('/api/platform/organizations/00000000-0000-4000-8000-000000000000');
  const malformado = await app.cliente.get('/api/platform/organizations/nao-e-uuid');
  assert.equal(inexistente.status, 404);
  assert.equal(malformado.status, 404);
  assert.deepEqual(inexistente.corpo, malformado.corpo);
});

test('membros · o último owner ATIVO não pode ser removido', async () => {
  const lista = await app.cliente.get('/api/platform/organizations');
  const org = lista.corpo.itens[0];

  // Duas pessoas: uma owner, uma member. O membership é gravado sob o contexto da Organization.
  const { comOrganization } = h.sujeito('lib/db.js');
  const pessoas = [];
  for (const email of ['dono@org.com', 'membro@org.com']) {
    const { rows } = await app.pool.query(
      `INSERT INTO users (email, nome, password_hash) VALUES ($1, $1, 'scrypt$1$32768$8$1$AAAA$BBBB') RETURNING id`,
      [email]
    );
    pessoas.push(rows[0].id);
  }
  await comOrganization(app.pool, org.id, async (c) => {
    await c.query(`INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')`, [org.id, pessoas[0]]);
    await c.query(`INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'member')`, [org.id, pessoas[1]]);
  });

  // Remover o member: pode.
  const member = await app.cliente.delete(`/api/platform/organizations/${org.id}/members/${pessoas[1]}`);
  assert.equal(member.status, 204);

  // Remover o ÚNICO owner ativo: não pode.
  const owner = await app.cliente.delete(`/api/platform/organizations/${org.id}/members/${pessoas[0]}`);
  assert.equal(owner.status, 409);
  assert.equal(owner.corpo.erro, 'ultimo_owner');

  const { rows } = await app.pool.query('SELECT platform_owners_ativos($1) AS n', [org.id]);
  assert.equal(rows[0].n, 1, 'o owner foi removido apesar do 409');
});

test('paginação por cursor devolve cada Organization uma vez', async () => {
  const primeira = await app.cliente.get('/api/platform/organizations?limit=1');
  assert.equal(primeira.corpo.itens.length, 1);
  assert.ok(primeira.corpo.proximoCursor);
  const segunda = await app.cliente.get(`/api/platform/organizations?limit=1&cursor=${encodeURIComponent(primeira.corpo.proximoCursor)}`);
  assert.equal(segunda.corpo.itens.length, 1);
  assert.notEqual(segunda.corpo.itens[0].id, primeira.corpo.itens[0].id);

  const invalido = await app.cliente.get('/api/platform/organizations?cursor=%%%');
  assert.equal(invalido.status, 400);
  assert.equal(invalido.corpo.erro, 'cursor_invalido');
});
