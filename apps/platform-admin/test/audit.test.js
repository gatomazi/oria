'use strict';

// Auditoria e não-vazamento (§22, §28 · bloco "Audit", §29 · "secret response").
//
// Dois testes aqui são do tipo "se alguém tirar o insert, isto reprova": `plan change sem audit` e
// `suspension sem audit`. Eles não olham o código — olham a tabela, depois da operação.

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./harness');

let db;
let app;
let org;

const contar = async (action, organizationId = null) => {
  const { rows } = await app.pool.query(
    `SELECT count(*)::int AS n FROM platform_audit_logs
      WHERE action = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
    [action, organizationId]
  );
  return rows[0].n;
};

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
  await h.criarAdmin(app.pool, { email: 'owner@exemplo.com', papel: 'platform_owner' });
  await app.cliente.login('owner@exemplo.com');
  const r = await app.cliente.post('/api/platform/organizations', {
    nome: 'Org da Auditoria',
    store: { nome: 'Store da Auditoria' },
    planoChave: 'internal',
    ownerEmail: 'dono@exemplo.com',
    idempotencyKey: h.chaveIdempotencia(),
    bootstrapInterno: true,
    passos: h.PASSOS_DE_TESTE,
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  org = r.corpo.organization;
});

test.after(async () => {
  await app.fechar();
  await db.destruir();
});

test('login e logout são auditados com sujeito real', async () => {
  assert.ok(await contar('admin.login') >= 1);
  const { rows } = await app.pool.query(
    `SELECT actor_admin_id, actor_email FROM platform_audit_logs WHERE action = 'admin.login' ORDER BY id DESC LIMIT 1`
  );
  assert.match(rows[0].actor_admin_id, /^[0-9a-f-]{36}$/);
  assert.equal(rows[0].actor_email, 'owner@exemplo.com');
});

test('plan change sem audit → teste falha (a auditoria é a asserção)', async () => {
  const antes = await contar('subscription.changed', org.id);
  await app.cliente.post('/api/platform/plans', { chave: 'outro', nome: 'Outro', features: ['financial'] });
  const r = await app.cliente.put(`/api/platform/organizations/${org.id}/subscription`,
    { planoChave: 'outro', motivo: 'auditoria obrigatória' });
  assert.equal(r.status, 200);

  const depois = await contar('subscription.changed', org.id);
  assert.equal(depois, antes + 1, 'a troca de plano aconteceu SEM registro de auditoria');

  const { rows } = await app.pool.query(
    `SELECT before, after, organization_id FROM platform_audit_logs
      WHERE action = 'subscription.changed' ORDER BY id DESC LIMIT 1`
  );
  assert.equal(rows[0].organization_id, org.id);
  assert.equal(rows[0].before.planoChave, 'internal');
  assert.equal(rows[0].after.planoChave, 'outro');
});

test('suspension sem audit → teste falha', async () => {
  const antes = await contar('organization.suspended', org.id);
  const r = await app.cliente.post(`/api/platform/organizations/${org.id}/suspend`, { motivo: 'auditoria obrigatória' });
  assert.equal(r.status, 200);
  assert.equal(await contar('organization.suspended', org.id), antes + 1,
    'a suspensão aconteceu SEM registro de auditoria');

  const antesR = await contar('organization.reactivated', org.id);
  await app.cliente.post(`/api/platform/organizations/${org.id}/reactivate`, { motivo: 'fim do teste' });
  assert.equal(await contar('organization.reactivated', org.id), antesR + 1);
});

test('override e remoção de override são auditados', async () => {
  const antes = await contar('entitlement.override_set', org.id);
  await app.cliente.put(`/api/platform/organizations/${org.id}/entitlements/whatsapp`,
    { permitido: true, motivo: 'teste' });
  assert.equal(await contar('entitlement.override_set', org.id), antes + 1);

  const antesR = await contar('entitlement.override_removed', org.id);
  await app.cliente.delete(`/api/platform/organizations/${org.id}/entitlements/whatsapp`);
  assert.equal(await contar('entitlement.override_removed', org.id), antesR + 1);
});

test('a auditoria da criação é ATÔMICA com a criação: se ela falhar, nada é criado', async () => {
  // O caminho honesto para provar atomicidade sem injetar defeito: uma auditoria que o guarda de
  // segredo RECUSA, dentro da mesma transação. O serviço não faz isso — mas o contrato de
  // `registrar` faz, e é ele que a criação usa.
  const { emTransacao } = h.sujeito('lib/db.js');
  const audit = h.sujeito('lib/audit.js');
  const { rows: [admin] } = await app.pool.query(`SELECT id, email FROM platform_admins LIMIT 1`);

  const antes = await app.pool.query('SELECT count(*)::int AS n FROM plans');
  await assert.rejects(
    () => emTransacao(app.pool, async (c) => {
      await c.query(`INSERT INTO plans (chave, nome) VALUES ('fantasma', 'Fantasma')`);
      await audit.registrar(c, {
        ator: { adminId: admin.id, email: admin.email },
        action: 'plan.created',
        entityType: 'plan',
        entityId: 'x',
        after: { access_token: 'segredo-que-nao-pode-entrar' },
      });
    }),
    /credencial/
  );
  const depois = await app.pool.query('SELECT count(*)::int AS n FROM plans');
  assert.equal(depois.rows[0].n, antes.rows[0].n, 'a transação não desfez o INSERT quando a auditoria falhou');
});

test('a auditoria RECUSA segredo, em qualquer profundidade, em vez de redigir em silêncio', () => {
  const { exigirSemSegredo, AuditError } = h.sujeito('lib/audit.js');
  const proibidos = [
    { token: 'x' },
    { access_token: 'x' },
    { senha: 'x' },
    { password: 'x' },
    { password_hash: 'x' },
    { api_key: 'x' },
    { Authorization: 'Bearer x' },
    { cookie: 'a=b' },
    { ciphertext: 'x' },
    { nested: { deep: [{ refresh_token: 'x' }] } },
  ];
  for (const v of proibidos) {
    assert.throws(() => exigirSemSegredo(v), AuditError, `aceitou ${JSON.stringify(v)}`);
  }
  // O que é legítimo passa.
  assert.doesNotThrow(() => exigirSemSegredo({ email: 'a@b.com', status: 'active', features: ['financial'] }));
});

test('ação fora do vocabulário é recusada', async () => {
  const audit = h.sujeito('lib/audit.js');
  const { emTransacao } = h.sujeito('lib/db.js');
  const { rows: [admin] } = await app.pool.query(`SELECT id, email FROM platform_admins LIMIT 1`);
  await assert.rejects(
    () => emTransacao(app.pool, (c) => audit.registrar(c, {
      ator: { adminId: admin.id, email: admin.email },
      action: 'plan.exploded',
      entityType: 'plan',
    })),
    /ação desconhecida/
  );
});

test('auditoria sem sujeito real é recusada', async () => {
  const audit = h.sujeito('lib/audit.js');
  const { emTransacao } = h.sujeito('lib/db.js');
  for (const ator of [null, {}, { adminId: 'admin', email: 'x@y.com' }, { adminId: null, email: 'x@y.com' }]) {
    await assert.rejects(
      () => emTransacao(app.pool, (c) => audit.registrar(c, {
        ator, action: 'admin.login', entityType: 'platform_admin',
      })),
      /sujeito/
    );
  }
});

test('o rastro sobrevive ao admin ser removido (actor_email é retrato)', async () => {
  const efêmero = await h.criarAdmin(app.pool, { email: 'efemero@exemplo.com', papel: 'platform_operator' });
  const cliente = h.criarCliente(app.base);
  await cliente.login('efemero@exemplo.com');
  await cliente.post(`/api/platform/organizations/${org.id}/suspend`, { motivo: 'antes de sumir' });
  await cliente.post(`/api/platform/organizations/${org.id}/reactivate`, { motivo: 'fim' });

  await app.pool.query('DELETE FROM platform_admins WHERE id = $1', [efêmero.id]);
  const { rows } = await app.pool.query(
    `SELECT actor_admin_id, actor_email FROM platform_audit_logs WHERE actor_email = 'efemero@exemplo.com' LIMIT 1`
  );
  assert.ok(rows.length, 'o rastro sumiu junto com o admin');
  assert.equal(rows[0].actor_admin_id, null);
  assert.equal(rows[0].actor_email, 'efemero@exemplo.com');
});

// ── secret response (§29) ────────────────────────────────────────────────────────────────────

test('nenhuma resposta da API carrega segredo, hash ou payload cru', async () => {
  // Uma integração com segredo e um webhook com PII: se algo vazar, vaza aqui.
  const { comOrganization } = h.sujeito('lib/db.js');
  await comOrganization(app.pool, org.id, async (c) => {
    const { rows: [i] } = await c.query(
      `INSERT INTO integrations (organization_id, provider, status, config)
       VALUES ($1, 'ink', 'connected', '{"conta":"12345","segredo_na_config":"nao-deveria-existir"}'::jsonb)
       RETURNING id`,
      [org.id]
    );
    await c.query(
      `INSERT INTO integration_secrets (integration_id, organization_id, tipo, ciphertext, key_version)
       VALUES ($1, $2, 'api_token', 'CIFRADO-SUPER-SECRETO', 1)`,
      [i.id, org.id]
    );
    await c.query(
      `INSERT INTO webhook_eventos (organization_id, verificado, loja, metodo_auth, event_name, headers, body)
       VALUES ($1, true, NULL, 'hmac', 'order.created',
               '{"authorization":"Bearer TOKEN-NO-HEADER"}'::jsonb,
               '{"cliente":{"cpf":"000.000.000-00","email":"pii@exemplo.com"}}'::jsonb)`,
      [org.id]
    );
    await c.query(
      `INSERT INTO job_leases (job, organization_id, dono, iniciado_em, ate, proxima_em)
       VALUES ('ink:sync', $1, 'worker-host-interno-01', now(), now() + interval '1 minute', now())`,
      [org.id]
    );
  });

  const proibido = /CIFRADO-SUPER-SECRETO|TOKEN-NO-HEADER|000\.000\.000-00|pii@exemplo\.com|worker-host-interno-01|segredo_na_config|password_hash|token_hash|scrypt\$/;

  const rotas = [
    '/health',
    '/api/platform/overview',
    '/api/platform/admins',
    '/api/platform/plans',
    '/api/platform/organizations',
    `/api/platform/organizations/${org.id}`,
    `/api/platform/organizations/${org.id}/entitlements`,
    `/api/platform/organizations/${org.id}/invites`,
    `/api/platform/organizations/${org.id}/members`,
    `/api/platform/organizations/${org.id}/integrations`,
    `/api/platform/organizations/${org.id}/subscription`,
    '/api/platform/users',
    '/api/platform/onboardings',
    '/api/platform/integrations',
    '/api/platform/jobs',
    '/api/platform/webhooks',
    '/api/platform/audit',
  ];
  for (const rota of rotas) {
    const r = await app.cliente.get(rota);
    assert.equal(r.status, 200, `${rota} respondeu ${r.status}`);
    assert.doesNotMatch(r.texto, proibido, `vazou segredo/PII em ${rota}`);
  }
});

test('os read models não expõem config de provider, payload de webhook nem dono de lease', async () => {
  const integracoes = await app.cliente.get('/api/platform/integrations');
  const i = integracoes.corpo.itens[0];
  assert.ok(i, 'o teste precisa de uma integração');
  assert.equal(i.provider, 'ink');
  assert.equal(i.status, 'connected');
  assert.ok(!('config' in i));
  assert.ok(!('secrets' in i));
  assert.ok(!('ciphertext' in i));

  const webhooks = await app.cliente.get('/api/platform/webhooks');
  const w = webhooks.corpo.itens[0];
  assert.ok(w);
  assert.equal(w.eventName, 'order.created');
  assert.ok(!('headers' in w));
  assert.ok(!('body' in w));

  const jobs = await app.cliente.get('/api/platform/jobs');
  const j = jobs.corpo.itens[0];
  assert.ok(j);
  assert.equal(j.job, 'ink:sync');
  assert.equal(j.ocupado, true);
  assert.ok(!('dono' in j), 'o read model de jobs expôs o identificador do worker');

  const users = await app.cliente.get('/api/platform/users');
  for (const u of users.corpo.itens) {
    assert.ok(!('password_hash' in u));
    assert.ok(!('passwordHash' in u));
  }
});

test('nenhuma resposta da API tem CAMPO com cara de credencial, em nenhuma profundidade', async () => {
  // O teste de conteúdo acima pega valor conhecido; este pega a FORMA. Um campo novo chamado
  // `tokenHash`, `apiKey` ou `passwordHash` reprova mesmo que o valor não case com nada conhecido —
  // que é como um vazamento realmente aparece (foi o que o controle `secret-response` mostrou).
  const PROIBIDO = /(token|secret|senha|password|passwd|hash|api_?key|private_?key|authorization|cookie|ciphertext|credential|bearer)/i;
  // `csrfToken` é a exceção declarada: é emitido para o cliente de propósito, é derivado da sessão
  // e não vale em outra. Ele aparece só nas respostas de login e de sessão.
  const PERMITIDO = new Set(['csrfToken']);

  const varrer = (valor, caminho, rota) => {
    if (Array.isArray(valor)) return valor.forEach((v, i) => varrer(v, `${caminho}[${i}]`, rota));
    if (!valor || typeof valor !== 'object') return;
    for (const [k, v] of Object.entries(valor)) {
      if (!PERMITIDO.has(k) && PROIBIDO.test(k)) {
        assert.fail(`campo com cara de credencial em ${rota}: ${caminho}.${k}`);
      }
      varrer(v, `${caminho}.${k}`, rota);
    }
  };

  const rotas = [
    '/api/platform/overview', '/api/platform/admins', '/api/platform/plans',
    '/api/platform/organizations', `/api/platform/organizations/${org.id}`,
    `/api/platform/organizations/${org.id}/entitlements`,
    `/api/platform/organizations/${org.id}/invites`,
    `/api/platform/organizations/${org.id}/members`,
    `/api/platform/organizations/${org.id}/integrations`,
    `/api/platform/organizations/${org.id}/subscription`,
    '/api/platform/users', '/api/platform/onboardings', '/api/platform/integrations',
    '/api/platform/jobs', '/api/platform/webhooks', '/api/platform/audit',
  ];
  for (const rota of rotas) {
    const r = await app.cliente.get(rota);
    assert.equal(r.status, 200, `${rota} respondeu ${r.status}`);
    varrer(r.corpo, '$', rota);
  }
});

test('filtro de auditoria com action inválida é 422', async () => {
  const r = await app.cliente.get('/api/platform/audit?action=nao.existe');
  assert.equal(r.status, 422);
  assert.equal(r.corpo.erro, 'action_desconhecida');
});
