'use strict';

// Convite do owner (§15) e o invariante "nunca deixar a Organization sem owner ativo".

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const h = require('./harness');

let db;
let app;
let org;
let conviteInicial;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

test.before(async () => {
  db = await h.bancoNovo();
  app = await h.subirApp(db.url);
  await h.criarAdmin(app.pool, { email: 'owner@exemplo.com', papel: 'platform_owner' });
  await app.cliente.login('owner@exemplo.com');
  const r = await app.cliente.post('/api/platform/organizations', {
    nome: 'Org dos Convites',
    store: { nome: 'Store dos Convites' },
    planoChave: 'internal',
    ownerEmail: 'primeiro.dono@exemplo.com',
    idempotencyKey: h.chaveIdempotencia(),
    bootstrapInterno: true,
    passos: h.PASSOS_DE_TESTE,
  });
  assert.equal(r.status, 201, JSON.stringify(r.corpo));
  org = r.corpo.organization;
  conviteInicial = r.corpo.invite;
});

test.after(async () => {
  await app.fechar();
  await db.destruir();
});

test('o token cru só existe na resposta; no banco fica o SHA-256', async () => {
  assert.match(conviteInicial.token, /^[A-Za-z0-9_-]{43}$/);
  const { rows } = await app.pool.query(
    'SELECT token_hash FROM organization_owner_invites WHERE id = $1', [conviteInicial.id]
  );
  assert.equal(rows[0].token_hash, sha256(conviteInicial.token));
});

test('a listagem de convites NUNCA devolve token nem hash', async () => {
  const r = await app.cliente.get(`/api/platform/organizations/${org.id}/invites`);
  assert.equal(r.status, 200);
  assert.equal(r.corpo.itens.length, 1);
  const c = r.corpo.itens[0];
  assert.equal(c.estado, 'pendente');
  assert.equal(c.papel, 'owner');
  assert.ok(!('token' in c));
  assert.ok(!('tokenHash' in c));
  assert.doesNotMatch(r.texto, new RegExp(conviteInicial.token.slice(0, 20)));
});

test('convite não cria senha nem usuário — só o convite', async () => {
  const { rows } = await app.pool.query(`SELECT count(*)::int AS n FROM users WHERE email = 'primeiro.dono@exemplo.com'`);
  assert.equal(rows[0].n, 0, 'o convite criou usuário; ele deveria só convidar');
});

test('não existem dois convites PENDENTES para o mesmo e-mail na mesma Organization', async () => {
  const r = await app.cliente.post(`/api/platform/organizations/${org.id}/invites`,
    { email: 'primeiro.dono@exemplo.com', papel: 'owner' });
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro, 'convite_pendente_existe');
});

test('reissue revoga o anterior e emite um token NOVO', async () => {
  const r = await app.cliente.post(
    `/api/platform/organizations/${org.id}/invites/${conviteInicial.id}/reissue`, { validadeHoras: 24 }
  );
  assert.equal(r.status, 200);
  assert.notEqual(r.corpo.token, conviteInicial.token);
  assert.notEqual(r.corpo.id, conviteInicial.id);
  assert.equal(r.corpo.email, 'primeiro.dono@exemplo.com');

  const lista = await app.cliente.get(`/api/platform/organizations/${org.id}/invites`);
  const antigo = lista.corpo.itens.find((c) => c.id === conviteInicial.id);
  const novo = lista.corpo.itens.find((c) => c.id === r.corpo.id);
  assert.equal(antigo.estado, 'revogado');
  assert.equal(novo.estado, 'pendente');
  conviteInicial = r.corpo;
});

test('reissue de convite já revogado é 409', async () => {
  const r = await app.cliente.post(
    `/api/platform/organizations/${org.id}/invites/${conviteInicial.id}/reissue`, {}
  );
  assert.equal(r.status, 200);
  const novoId = r.corpo.id;
  const denovo = await app.cliente.post(
    `/api/platform/organizations/${org.id}/invites/${r.corpo.id}/reissue`, {}
  );
  assert.equal(denovo.status, 200);
  const terceira = await app.cliente.post(`/api/platform/organizations/${org.id}/invites/${novoId}/reissue`, {});
  assert.equal(terceira.status, 409);
  assert.equal(terceira.corpo.erro, 'convite_ja_revogado');
  conviteInicial = denovo.corpo;
});

test('revogar o ÚNICO caminho para owner é recusado (a Organization ficaria sem owner)', async () => {
  const { rows } = await app.pool.query('SELECT platform_owners_ativos($1) AS n', [org.id]);
  assert.equal(rows[0].n, 0, 'o teste depende de a Organization ainda não ter owner ativo');

  const r = await app.cliente.post(
    `/api/platform/organizations/${org.id}/invites/${conviteInicial.id}/revoke`, { motivo: 'não deveria passar' }
  );
  assert.equal(r.status, 409);
  assert.equal(r.corpo.erro, 'ultimo_owner');

  const lista = await app.cliente.get(`/api/platform/organizations/${org.id}/invites`);
  assert.equal(lista.corpo.itens.find((c) => c.id === conviteInicial.id).estado, 'pendente');
});

test('com OUTRO convite de owner pendente, revogar passa', async () => {
  const outro = await app.cliente.post(`/api/platform/organizations/${org.id}/invites`,
    { email: 'segundo.dono@exemplo.com', papel: 'owner' });
  assert.equal(outro.status, 201);

  const r = await app.cliente.post(
    `/api/platform/organizations/${org.id}/invites/${conviteInicial.id}/revoke`, { motivo: 'trocamos de pessoa' }
  );
  assert.equal(r.status, 200);
  assert.equal(r.corpo.estado, 'revogado');

  // E agora o outro vira o único: revogar ELE é recusado.
  const ultimo = await app.cliente.post(
    `/api/platform/organizations/${org.id}/invites/${outro.corpo.id}/revoke`, { motivo: 'nem esse' }
  );
  assert.equal(ultimo.status, 409);
  assert.equal(ultimo.corpo.erro, 'ultimo_owner');
});

test('com owner ATIVO, revogar o convite pendente passa', async () => {
  const { comOrganization } = h.sujeito('lib/db.js');
  const { rows: [u] } = await app.pool.query(
    `INSERT INTO users (email, nome, password_hash) VALUES ('dono.ativo@exemplo.com', 'Dono', 'scrypt$1$32768$8$1$AAAA$BBBB')
     RETURNING id`
  );
  await comOrganization(app.pool, org.id, (c) => c.query(
    `INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')`, [org.id, u.id]
  ));

  const lista = await app.cliente.get(`/api/platform/organizations/${org.id}/invites`);
  const pendente = lista.corpo.itens.find((c) => c.estado === 'pendente');
  assert.ok(pendente);
  const r = await app.cliente.post(
    `/api/platform/organizations/${org.id}/invites/${pendente.id}/revoke`, { motivo: 'já tem owner' }
  );
  assert.equal(r.status, 200);
});

test('convite de OUTRA Organization dá 404, não 403 (não confirma que o id existe)', async () => {
  const externo = await h.subirApp(db.url, { SECOND_TENANT_ENABLED: '1' });
  try {
    await h.criarAdmin(app.pool, { email: 'owner2@exemplo.com', papel: 'platform_owner' });
    await externo.cliente.login('owner2@exemplo.com');
    const outra = await externo.cliente.post('/api/platform/organizations', {
      nome: 'Outra Org',
      store: { nome: 'Outra Store' },
      planoChave: 'internal',
      ownerEmail: 'outro@exemplo.com',
      idempotencyKey: h.chaveIdempotencia(),
      bootstrapInterno: false,
      passos: h.PASSOS_DE_TESTE,
    });
    assert.equal(outra.status, 201, JSON.stringify(outra.corpo));

    // Convite da Organization B, pedido pela rota da Organization A.
    const cruzado = await externo.cliente.post(
      `/api/platform/organizations/${org.id}/invites/${outra.corpo.invite.id}/revoke`, { motivo: 'cruzado' }
    );
    assert.equal(cruzado.status, 404);

    // E o convite de B continua pendente.
    const lista = await externo.cliente.get(`/api/platform/organizations/${outra.corpo.organization.id}/invites`);
    assert.equal(lista.corpo.itens[0].estado, 'pendente');
  } finally {
    await externo.fechar();
  }
});

test('convite expirado aparece como expirado e o consumo o recusa', async () => {
  const novo = await app.cliente.post(`/api/platform/organizations/${org.id}/invites`,
    { email: 'expira@exemplo.com', papel: 'member', validadeHoras: 1 });
  assert.equal(novo.status, 201);
  await app.pool.query(
    `UPDATE organization_owner_invites SET criado_em = now() - interval '2 days', expira_em = now() - interval '1 minute'
      WHERE id = $1`,
    [novo.corpo.id]
  );

  const lista = await app.cliente.get(`/api/platform/organizations/${org.id}/invites`);
  assert.equal(lista.corpo.itens.find((c) => c.id === novo.corpo.id).estado, 'expirado');

  const { rows } = await app.pool.query('SELECT * FROM platform_consumir_convite($1, NULL)', [sha256(novo.corpo.token)]);
  assert.equal(rows[0].motivo, 'expirado');
});

test('consumo do convite é de uso ÚNICO', async () => {
  const novo = await app.cliente.post(`/api/platform/organizations/${org.id}/invites`,
    { email: 'uso.unico@exemplo.com', papel: 'member' });
  const { rows: [u] } = await app.pool.query(
    `INSERT INTO users (email, nome, password_hash) VALUES ('uso.unico@exemplo.com', 'U', 'scrypt$1$32768$8$1$AAAA$BBBB')
     RETURNING id`
  );
  const hash = sha256(novo.corpo.token);

  const primeira = await app.pool.query('SELECT * FROM platform_consumir_convite($1, $2)', [hash, u.id]);
  assert.equal(primeira.rows[0].motivo, 'ok');
  assert.equal(primeira.rows[0].organization_id, org.id);

  const segunda = await app.pool.query('SELECT * FROM platform_consumir_convite($1, $2)', [hash, u.id]);
  assert.equal(segunda.rows[0].motivo, 'usado');

  const desconhecido = await app.pool.query('SELECT * FROM platform_consumir_convite($1, $2)', [sha256('nao-existe'), u.id]);
  assert.equal(desconhecido.rows[0].motivo, 'desconhecido');
});

test('validade fora do intervalo é recusada', async () => {
  for (const validadeHoras of [0, 169, -1]) {
    const r = await app.cliente.post(`/api/platform/organizations/${org.id}/invites`,
      { email: 'validade@exemplo.com', validadeHoras });
    assert.equal(r.status, 400, `validade ${validadeHoras} foi aceita`);
  }
});

test('convite e reissue são auditados, e o token não entra na auditoria', async () => {
  const { rows } = await app.pool.query(
    `SELECT action, after FROM platform_audit_logs WHERE action IN ('invite.issued', 'invite.reissued', 'invite.revoked')`
  );
  assert.ok(rows.length >= 3);
  for (const r of rows) {
    assert.ok(!('token' in (r.after || {})));
    assert.doesNotMatch(JSON.stringify(r.after), /[A-Za-z0-9_-]{43}/);
  }
});
