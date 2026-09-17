'use strict';

// Fase 4 — integrações por Organization (INV-11, INV-12, INV-13).
//
// Duas execuções do mesmo resolver:
//   - sob a role da aplicação (NOSUPERUSER, NOBYPASSRLS): é como a app roda;
//   - sob o superusuário (ignora RLS): prova que o isolamento é da APLICAÇÃO também, não só da RLS
//     — é aí que os negative controls deste arquivo aparecem.
//
// Organizations do cenário A: A = sul, B = centro. X = Organization sem loja legada (tenant novo).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const express = require('express');

const h = require('./harness');
const { inserir, limparCache } = require('../helpers/linhas');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver, SEGREDOS } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring, VERSAO_LEGACY } = h.sujeito('lib/secrets/keyring.js');
const { createOAuthStates } = h.sujeito('lib/platform/oauth-state.js');
const { resolverMidiaDaOrganizacao } = h.sujeito('lib/financeiro/midia.js');
const secretGuard = h.sujeito('lib/platform/secret-guard.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const ORG_X = crypto.randomUUID();
const ROLE = `oria_app_f4_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_SESSAO_LEGADO = crypto.randomBytes(32).toString('base64url');
const silencioso = { log() {}, warn() {}, error() {} };

const TOKENS = {
  [ORG_A]: { ink: `ink-A-${crypto.randomUUID()}`, meta: `EAAG-A-${crypto.randomUUID()}`, google: `1//refresh-A-${crypto.randomUUID()}`, openai: `sk-A-${crypto.randomUUID()}` },
  [ORG_B]: { ink: `ink-B-${crypto.randomUUID()}`, meta: `EAAG-B-${crypto.randomUUID()}`, google: `1//refresh-B-${crypto.randomUUID()}`, openai: `sk-B-${crypto.randomUUID()}` },
};

let db;
let sup;
let appPool;
let app; // resolver sob oria_app
let semRls; // resolver sob superusuário

function resolver(pool, env = {}) {
  const fachada = runtime.criarPoolTenant(pool);
  const keyring = createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA, ...env });
  return createIntegrationResolver({
    pool: fachada,
    segredos: createSecretStore({ pool: fachada, keyring }),
    env,
    logger: silencioso,
  });
}

const em = (org, fn, loja) => runtime.comContexto({ organizationId: org, loja: loja === undefined ? { [ORG_A]: 'sul', [ORG_B]: 'centro' }[org] || null : loja }, fn);
const ler = (r, provider, tipo) => r.usarSegredo(provider, tipo, (v) => v);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_f4');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 4 });
  app = resolver(appPool);
  semRls = resolver(sup);
  await sup.query(`INSERT INTO organizations (id, nome) VALUES ($1, 'Tenant novo')`, [ORG_X]);
  await sup.query(`INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $1, 'Tenant novo', NULL)`, [ORG_X]);
  limparCache();

  // A primeiro, B depois (ordem importa para os negative controls de "primeira linha").
  for (const org of [ORG_A, ORG_B]) {
    await em(org, async () => {
      await app.gravarSegredo('ink', 'api_token', TOKENS[org].ink);
      await app.gravarSegredo('meta', 'access_token', TOKENS[org].meta);
      await app.gravarSegredo('google_ads', 'refresh_token', TOKENS[org].google);
      await app.gravarSegredo('ga4', 'refresh_token', `${TOKENS[org].google}-ga4`);
      await app.gravarSegredo('openai', 'api_key', TOKENS[org].openai);
    });
  }
});

test.after(async () => {
  await appPool?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

// ── INV-12 ─────────────────────────────────────────────────────────────────────────────────────

for (const [nome, r] of [['role da aplicação', () => app], ['sem RLS por baixo', () => semRls]]) {
  test(`INV-12 · cada Organization lê só a própria credencial (${nome})`, async () => {
    const res = r();
    for (const org of [ORG_A, ORG_B]) {
      await em(org, async () => {
        assert.equal(await ler(res, 'ink', 'api_token'), TOKENS[org].ink);
        assert.equal(await ler(res, 'meta', 'access_token'), TOKENS[org].meta);
        assert.equal(await ler(res, 'google_ads', 'refresh_token'), TOKENS[org].google);
        assert.equal(await ler(res, 'openai', 'api_key'), TOKENS[org].openai);
      });
    }
  });
}

test('INV-12 · requests intercaladas e concorrentes recebem cada uma a credencial da própria Organization', async () => {
  const pedidos = [];
  for (let i = 0; i < 30; i += 1) {
    const org = i % 3 === 0 ? ORG_B : ORG_A;
    const provider = ['ink', 'meta', 'openai'][i % 3];
    const tipo = SEGREDOS[provider].api_token ? 'api_token' : SEGREDOS[provider].access_token ? 'access_token' : 'api_key';
    pedidos.push(em(org, async () => {
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));
      return { org, provider, valor: await ler(semRls, provider, tipo) };
    }));
  }
  for (const { org, provider, valor } of await Promise.all(pedidos)) {
    const esperado = { ink: TOKENS[org].ink, meta: TOKENS[org].meta, openai: TOKENS[org].openai }[provider];
    assert.equal(valor, esperado, `${provider} de ${org}`);
  }
});

test('INV-12 · sem integração, sem contexto ou provider desconhecido: falha fechada', async () => {
  await em(ORG_X, async () => {
    await assert.rejects(ler(app, 'ink', 'api_token'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED');
    assert.equal(await app.temSegredo('meta', 'access_token'), false);
  }, null);
  await assert.rejects(ler(app, 'ink', 'api_token'), (e) => e.codigo === 'TENANT_CONTEXT_REQUIRED');
  await em(ORG_A, async () => {
    await assert.rejects(ler(app, 'tiktok', 'token'), /desconhecido/);
    await assert.rejects(ler(app, 'ink', 'senha'), /desconhecido/);
  });
});

test('INV-12 · mais de uma integração do provider é erro de integridade, nunca a primeira', async () => {
  const falso = {
    query: async (sql) => (/FROM integrations/.test(sql) ? { rows: [{ id: 1 }, { id: 2 }] } : { rows: [] }),
  };
  const r = createIntegrationResolver({ pool: falso, segredos: { usarSegredo: async () => 'x' }, logger: silencioso });
  await em(ORG_A, () => assert.rejects(ler(r, 'ink', 'api_token'), (e) => e.codigo === 'INTEGRATION_INTEGRITY_ERROR'));
});

test('INV-12 · segredo vencido é recusado; quem sabe renovar pede explicitamente', async () => {
  await em(ORG_B, async () => {
    await app.gravarSegredo('google_ads', 'access_token', 'ya29.vencido-B-000000', { expiresAt: new Date(Date.now() - 1000) });
    await assert.rejects(ler(app, 'google_ads', 'access_token'), (e) => e.codigo === 'SECRET_EXPIRED');
    const [valor, meta] = await app.usarSegredo('google_ads', 'access_token', (v, m) => [v, m], { aceitarVencido: true });
    assert.equal(valor, 'ya29.vencido-B-000000');
    assert.ok(new Date(meta.expiresAt) < new Date());
  });
});

test('INV-12 · fallback de env legado: desligado por padrão, e ligado só serve a loja legada da própria Store', async () => {
  const env = {
    INK_TOKEN_SUL: 'env-sul-000000000000',
    INK_TOKEN_CENTRO: 'env-centro-0000000000',
  };
  // Sem a flag: env não é lida por ninguém.
  const semFlag = resolver(sup, env);
  await em(ORG_X, () => assert.rejects(ler(semFlag, 'ink', 'api_token'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED'), null);

  const comFlag = resolver(sup, { ...env, ALLOW_LEGACY_INTEGRATION_ENV: '1' });
  // Tenant novo, sem loja legada: nenhuma variável é dele — nem "a única que existe".
  await em(ORG_X, () => assert.rejects(ler(comFlag, 'ink', 'api_token'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED'), null);
  // Organization da loja norte (sem variável): nada.
  await em('a1000000-0000-4000-8000-000000000003', () => assert.rejects(ler(comFlag, 'ink', 'api_token'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED'), 'norte');
  // O banco vence o env: A tem token importado.
  await em(ORG_A, async () => assert.equal(await ler(comFlag, 'ink', 'api_token'), TOKENS[ORG_A].ink));
  // Só o token Ink tem fallback — feed de A sem banco usa a variável DA loja sul, e só dela.
  await em(ORG_A, () => assert.rejects(ler(comFlag, 'ink', 'feed_url'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED'));
  const comFeed = resolver(sup, { INK_FEED_URL_CENTRO: 'https://feed.reserva.ink/centro', ALLOW_LEGACY_INTEGRATION_ENV: '1' });
  await em(ORG_A, () => assert.rejects(ler(comFeed, 'ink', 'feed_url'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED'));
  await em(ORG_B, async () => assert.equal(await ler(comFeed, 'ink', 'feed_url'), 'https://feed.reserva.ink/centro'));
  // Metadata diz de onde veio, sem o valor.
  await em(ORG_B, async () => {
    const m = await comFeed.metadata('ink');
    assert.deepEqual(m.viaEnvLegado, ['feed_url']);
    assert.ok(!JSON.stringify(m).includes('feed.reserva.ink'));
  });
});

test('INV-12 · desconectar A apaga só A (com e sem RLS por baixo)', async () => {
  for (const r of [app, semRls]) {
    await em(ORG_A, () => r.gravarSegredo('openai', 'api_key', TOKENS[ORG_A].openai));
    await em(ORG_A, async () => {
      const { apagados } = await r.desconectar('openai');
      assert.equal(apagados, 1);
      await assert.rejects(ler(r, 'openai', 'api_key'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED');
      assert.equal((await r.metadata('openai')).status, 'disconnected');
    });
    await em(ORG_B, async () => assert.equal(await ler(r, 'openai', 'api_key'), TOKENS[ORG_B].openai));
  }
  await em(ORG_A, () => app.gravarSegredo('openai', 'api_key', TOKENS[ORG_A].openai));
});

// ── PD-016: posse de recurso externo ───────────────────────────────────────────────────────────

test('PD-016 · recurso externo tem uma Organization dona; a outra recebe conflito, nunca transferência', async () => {
  const conta = `act_${crypto.randomBytes(4).toString('hex')}`;
  await em(ORG_A, () => app.reivindicarRecurso('meta', 'ad_account', conta));
  await em(ORG_A, () => app.reivindicarRecurso('meta', 'ad_account', conta)); // idempotente
  await em(ORG_B, () => assert.rejects(app.reivindicarRecurso('meta', 'ad_account', conta), (e) => e.codigo === 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE' && e.status === 409));
  // B não consegue liberar o que é de A.
  await em(ORG_B, async () => assert.equal(await app.liberarRecursos('meta', 'ad_account', conta), 0));
  await em(ORG_B, () => assert.rejects(app.reivindicarRecurso('meta', 'ad_account', conta), (e) => e.status === 409));
  // A desconecta: libera; B pode reivindicar.
  await em(ORG_A, () => app.desconectar('meta'));
  await em(ORG_B, () => app.reivindicarRecurso('meta', 'ad_account', conta));
  const { rows } = await sup.query('SELECT organization_id FROM external_resource_claims WHERE external_id = $1', [conta]);
  assert.deepEqual(rows, [{ organization_id: ORG_B }]);
  // A role da aplicação não lê o registro nem chama as funções fora de contexto.
  await assert.rejects(appPool.query('SELECT * FROM external_resource_claims'), /permission denied/);
  await assert.rejects(appPool.query(`SELECT integracao_reivindicar_recurso('meta', 'ad_account', 'x')`), /contexto de Organization/);
  await em(ORG_A, () => app.gravarSegredo('meta', 'access_token', TOKENS[ORG_A].meta));
});

// ── OAuth state ────────────────────────────────────────────────────────────────────────────────

async function pessoa(chave, orgs) {
  const { rows: [u] } = await sup.query(
    `INSERT INTO users (email, password_hash) VALUES ($1, 'scrypt$1$32768$8$1$x$y') RETURNING id`,
    [`f4-${chave}-${crypto.randomBytes(3).toString('hex')}@teste.oria`]
  );
  for (const org of orgs) {
    await sup.query(`INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'member')`, [org, u.id]);
  }
  const sessaoId = crypto.randomBytes(32).toString('hex');
  await sup.query(
    `INSERT INTO sessions (id, user_id, metodo, expira_em, active_organization_id) VALUES ($1, $2, 'senha', now() + interval '1 hour', $3)`,
    [sessaoId, u.id, orgs[0]]
  );
  return { userId: u.id, sessaoId };
}

test('OAuth · o callback pertence à Organization que iniciou, mesmo se a sessão trocar de workspace', async () => {
  const states = createOAuthStates({ poolReal: appPool });
  const c = await pessoa('c', [ORG_A, ORG_B]);
  const state = await states.criar({ provider: 'ga4', organizationId: ORG_A, auth: c, dados: { loja: 'sul' } });
  await sup.query('UPDATE sessions SET active_organization_id = $1 WHERE id = $2', [ORG_B, c.sessaoId]);
  const r = await states.consumir(state, ['ga4', 'google_ads']);
  assert.deepEqual([r.provider, r.organizationId, r.dados.loja], ['ga4', ORG_A, 'sul']);
  // Uso único.
  await assert.rejects(states.consumir(state, ['ga4']), (e) => e.motivo === 'desconhecido ou já usado');
  // No banco só o hash.
  const { rows } = await sup.query('SELECT id FROM oauth_states');
  assert.ok(rows.every((x) => x.id !== state && /^[0-9a-f]{64}$/.test(x.id)));
});

test('OAuth · callback falha se o membership, a sessão, o provider ou a validade não conferem', async () => {
  const states = createOAuthStates({ poolReal: appPool });
  const c = await pessoa('c2', [ORG_A, ORG_B]);

  const semMembership = await states.criar({ provider: 'meta', organizationId: ORG_A, auth: c });
  await sup.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [ORG_A, c.userId]);
  await assert.rejects(states.consumir(semMembership, ['meta']), (e) => e.motivo === 'sem acesso à organization', 'sem membership');

  const provider = await states.criar({ provider: 'meta', organizationId: ORG_B, auth: c });
  await assert.rejects(states.consumir(provider, ['ga4', 'google_ads']), (e) => e.motivo === 'provider diferente', 'provider');

  const revogada = await states.criar({ provider: 'meta', organizationId: ORG_B, auth: c });
  await sup.query('UPDATE sessions SET revogada_em = now() WHERE id = $1', [c.sessaoId]);
  await assert.rejects(states.consumir(revogada, ['meta']), (e) => e.motivo === 'sessão encerrada', 'sessão');

  const d = await pessoa('d', [ORG_B]);
  const curto = createOAuthStates({ poolReal: appPool, ttlMs: 1 });
  const vencido = await curto.criar({ provider: 'meta', organizationId: ORG_B, auth: d });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(states.consumir(vencido, ['meta']), (e) => ['vencido', 'desconhecido ou já usado'].includes(e.motivo), 'vencido');

  await assert.rejects(states.consumir('x'.repeat(43), ['meta']), (e) => e.motivo === 'desconhecido ou já usado');
  await assert.rejects(states.consumir('nao-e-state', ['meta']), (e) => e.motivo === 'formato');
  await assert.rejects(states.criar({ provider: 'tiktok', organizationId: ORG_B, auth: d }), /desconhecido/);
});

// ── Import e re-cifra ──────────────────────────────────────────────────────────────────────────

test('OPS-23/24 · import legado: dono explícito, re-cifra na versão corrente, idempotente, limpeza opcional', async () => {
  const { importarLegado } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'integrations', 'import-legacy.mjs')));
  const antigo = createKeyring({ ADMIN_SESSION_SECRET: SEGREDO_SESSAO_LEGADO, ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1' });
  const cifradoLegado = (texto, contexto) => {
    // Chave derivada de ADMIN_SESSION_SECRET (key_version 0), como produção antes da Fase 0.
    const k = Buffer.from(crypto.hkdfSync('sha256', SEGREDO_SESSAO_LEGADO, '', contexto, 32));
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const enc = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  };
  assert.equal(antigo.decrypt(cifradoLegado('ok', SEGREDOS.meta.access_token), { contexto: SEGREDOS.meta.access_token }), 'ok');

  // Organization norte (sem nada importado ainda) com colunas antigas e variável da loja.
  const ORG_N = 'a1000000-0000-4000-8000-000000000003';
  const metaAntigo = `EAAG-N-${crypto.randomUUID()}`;
  const gaAntigo = `1//ga-N-${crypto.randomUUID()}`;
  await sup.query(
    `INSERT INTO meta_connections (organization_id, id, access_token_encrypted, status) VALUES ($1, 1, $2, 'connected')`,
    [ORG_N, cifradoLegado(metaAntigo, SEGREDOS.meta.access_token)]
  );
  await sup.query(
    `INSERT INTO google_analytics_connections (organization_id, loja, refresh_token_encrypted, status) VALUES ($1, 'norte', $2, 'connected')`,
    [ORG_N, cifradoLegado(gaAntigo, SEGREDOS.ga4.refresh_token)]
  );
  const env = {
    ENCRYPTION_MASTER_KEY: MESTRA,
    ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1',
    ADMIN_SESSION_SECRET: SEGREDO_SESSAO_LEGADO,
    INK_TOKEN_NORTE: `ink-N-${crypto.randomUUID()}`,
    INK_FEED_URL_NORTE: 'https://feed.reserva.ink/norte',
    INK_WEBHOOK_SECRET_NORTE: `whsec-N-${crypto.randomUUID()}`,
  };

  const simulado = await importarLegado(db.url, { env, aplicar: false });
  const deN = simulado.organizations.find((o) => o.organizationId === ORG_N);
  assert.deepEqual(deN.segredos.map((s) => `${s.provider}/${s.tipo}:${s.resultado}`).sort(),
    ['ga4/refresh_token:a_importar', 'ink/api_token:a_importar', 'ink/feed_url:a_importar', 'ink/webhook_secret:a_importar', 'meta/access_token:a_importar']);
  assert.ok(!JSON.stringify(simulado).includes(metaAntigo), 'relatório não traz segredo');

  const aplicado = await importarLegado(db.url, { env, aplicar: true });
  assert.equal(aplicado.ilegiveis, 0);
  assert.ok(aplicado.importados >= 5);
  const { rows: versoes } = await sup.query(
    `SELECT DISTINCT s.key_version FROM integration_secrets s WHERE s.organization_id = $1`, [ORG_N]
  );
  assert.deepEqual(versoes.map((v) => v.key_version), [1], 'tudo re-cifrado na versão corrente');

  // Sem a chave legada, a app lê o que foi importado.
  const semLegado = resolver(appPool);
  await em(ORG_N, async () => {
    assert.equal(await ler(semLegado, 'meta', 'access_token'), metaAntigo);
    assert.equal(await ler(semLegado, 'ga4', 'refresh_token'), gaAntigo);
    assert.equal(await ler(semLegado, 'ink', 'api_token'), env.INK_TOKEN_NORTE);
  }, 'norte');

  // Rodar de novo não muda nada.
  const denovo = await importarLegado(db.url, { env, aplicar: true });
  assert.equal(denovo.importados, 0);
  assert.ok(denovo.organizations.find((o) => o.organizationId === ORG_N).segredos.every((s) => s.resultado === 'ja_importado'));

  // Variável de loja sem mapeamento para a Organization não entra (a sul é de A, que já tem token).
  const comSul = await importarLegado(db.url, { env: { ...env, INK_TOKEN_SUL: 'ink-errado-00000000000' }, aplicar: false });
  const deA = comSul.organizations.find((o) => o.organizationId === ORG_A);
  assert.ok(deA.segredos.some((s) => s.provider === 'ink' && s.resultado === 'a_importar'), 'sul pertence a A pelo mapeamento');
  assert.ok(!comSul.organizations.find((o) => o.organizationId === ORG_B).segredos.some((s) => s.provider === 'ink'));

  // Release N+1: limpa as colunas antigas.
  await importarLegado(db.url, { env, aplicar: true, limparColunas: true });
  const { rows: [meta] } = await sup.query('SELECT access_token_encrypted FROM meta_connections WHERE organization_id = $1', [ORG_N]);
  assert.equal(meta.access_token_encrypted, null);
  await em(ORG_N, async () => assert.equal(await ler(semLegado, 'meta', 'access_token'), metaAntigo), 'norte');
});

test('TD-004 · re-cifra de integration_secrets gravado na versão legacy', async () => {
  const { recifrar } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'integrations', 'reencrypt.mjs')));
  const legado = createKeyring({ ADMIN_SESSION_SECRET: SEGREDO_SESSAO_LEGADO, ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1', ENCRYPTION_MASTER_KEY: MESTRA });
  // Grava como a Fase 0 gravaria um segredo de produção ainda na chave de sessão.
  const k = Buffer.from(crypto.hkdfSync('sha256', SEGREDO_SESSAO_LEGADO, '', SEGREDOS.google_ads.refresh_token, 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const valor = `1//legado-B-${crypto.randomUUID()}`;
  const enc = Buffer.concat([c.update(valor, 'utf8'), c.final()]);
  const ct = Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  assert.equal(legado.decrypt(ct, { keyVersion: VERSAO_LEGACY, contexto: SEGREDOS.google_ads.refresh_token }), valor);
  await sup.query(
    `UPDATE integration_secrets SET ciphertext = $1, key_version = 0
      WHERE organization_id = $2 AND tipo = 'refresh_token'
        AND integration_id = (SELECT id FROM integrations WHERE organization_id = $2 AND provider = 'google_ads')`,
    [ct, ORG_B]
  );
  const semChaveLegada = resolver(appPool);
  await em(ORG_B, () => assert.rejects(ler(semChaveLegada, 'google_ads', 'refresh_token'), (e) => e.codigo === 'SECRET_UNREADABLE'));

  const r = await recifrar(db.url, { env: { ENCRYPTION_MASTER_KEY: MESTRA, ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1', ADMIN_SESSION_SECRET: SEGREDO_SESSAO_LEGADO } });
  assert.equal(r.pendentes, 0);
  assert.ok(r.recifrados >= 1);
  await em(ORG_B, async () => assert.equal(await ler(semChaveLegada, 'google_ads', 'refresh_token'), valor));
  const denovo = await recifrar(db.url, { env: { ENCRYPTION_MASTER_KEY: MESTRA } });
  assert.deepEqual([denovo.recifrados, denovo.pendentes], [0, 0]);
});

// ── INV-11: fonte única de mídia ───────────────────────────────────────────────────────────────

async function semearMidia() {
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  const idMeta = `act_m_${crypto.randomBytes(3).toString('hex')}`;
  const idAds = '9876543210';
  for (const [org, loja] of [[ORG_A, 'sul'], [ORG_B, 'centro']]) {
    await sup.query('UPDATE meta_ad_accounts SET selecionada = false WHERE organization_id = $1', [org]);
    await sup.query('UPDATE google_ads_customers SET selecionada = false WHERE organization_id = $1', [org]);
    await inserir(sup, 'meta_ad_accounts', { organization_id: org, meta_account_id: idMeta, selecionada: true, loja_atribuida: loja });
    await inserir(sup, 'meta_insights_daily', { organization_id: org, meta_account_id: idMeta, level: 'account', entidade_id: idMeta, data: dia, spend: org === ORG_A ? 100 : 7000 });
    // Mesmo customer id do Google Ads nas duas Organizations: a soma de A nunca pode incluir a de B.
    await inserir(sup, 'google_ads_customers', { organization_id: org, customer_id: idAds, selecionada: true, loja_atribuida: loja });
    await inserir(sup, 'google_ads_insights_daily', {
      organization_id: org, customer_id: idAds, level: 'customer', entidade_id: idAds, data: dia,
      contagem_conversao: 'conversions', custo: org === ORG_A ? 20 : 9000,
    });
  }
  return { dia, idMeta, idAds };
}

test('INV-11 · o gasto é só dos recursos da Organization atribuídos à loja dela; o resto sai e é sinalizado', async () => {
  const { dia, idAds } = await semearMidia();
  const fachadaSemRls = runtime.criarPoolTenant(sup);
  const consultar = (pool, org, loja) => runtime.comContexto({ organizationId: org, loja },
    () => resolverMidiaDaOrganizacao(pool, { organizationId: org, loja, from: dia, to: dia }));

  for (const pool of [runtime.criarPoolTenant(appPool), fachadaSemRls]) {
    const a = await consultar(pool, ORG_A, 'sul');
    assert.deepEqual(a.fontes.map((f) => [f.provider, f.spend, f.conectado]), [['meta', 100, true], ['google_ads', 20, true]]);
    assert.deepEqual(a.sinalizados, []);
    const b = await consultar(pool, ORG_B, 'centro');
    assert.deepEqual(b.fontes.map((f) => [f.provider, f.spend]), [['meta', 7000], ['google_ads', 9000]]);
  }

  // Customer sem loja atribuída: fora do total, sinalizado.
  await sup.query('UPDATE google_ads_customers SET loja_atribuida = NULL WHERE organization_id = $1 AND customer_id = $2', [ORG_A, idAds]);
  let a = await consultar(fachadaSemRls, ORG_A, 'sul');
  assert.deepEqual(a.fontes.find((f) => f.provider === 'google_ads'), { provider: 'google_ads', spend: null, conectado: false, relevante: true, motivo: 'sem_loja' });
  assert.deepEqual(a.sinalizados, [{ provider: 'google_ads', recurso: idAds, motivo: 'sem_loja' }]);
  assert.equal(a.porDia.filter((d) => d.provider === 'google_ads').length, 0);

  // Atribuído a outra loja: fora e sinalizado. Nenhum "a única loja é esta".
  await sup.query(`UPDATE google_ads_customers SET loja_atribuida = 'centro' WHERE organization_id = $1 AND customer_id = $2`, [ORG_A, idAds]);
  a = await consultar(fachadaSemRls, ORG_A, 'sul');
  assert.deepEqual(a.sinalizados, [{ provider: 'google_ads', recurso: idAds, motivo: 'outra_loja' }]);
  await sup.query(`UPDATE google_ads_customers SET loja_atribuida = 'sul' WHERE organization_id = $1 AND customer_id = $2`, [ORG_A, idAds]);

  // Sem conta selecionada: desconectado; o aviso do Google só se a Organization usa o canal.
  await sup.query('UPDATE google_ads_customers SET selecionada = false WHERE organization_id = $1', [ORG_A]);
  const semAds = await runtime.comContexto({ organizationId: ORG_A, loja: 'sul' }, () => resolverMidiaDaOrganizacao(fachadaSemRls, {
    organizationId: ORG_A, loja: 'sul', from: dia, to: dia, relevante: async (p) => p !== 'google_ads',
  }));
  assert.deepEqual(semAds.fontes.find((f) => f.provider === 'google_ads'), { provider: 'google_ads', spend: null, conectado: false, relevante: false });
  await sup.query('UPDATE google_ads_customers SET selecionada = true WHERE organization_id = $1 AND customer_id = $2', [ORG_A, idAds]);

  // Sem Organization ou sem loja: erro.
  await assert.rejects(resolverMidiaDaOrganizacao(fachadaSemRls, { organizationId: null, loja: 'sul', from: dia, to: dia }), /organization/);
  await assert.rejects(resolverMidiaDaOrganizacao(fachadaSemRls, { organizationId: ORG_A, loja: null, from: dia, to: dia }), /loja/);
});

test('INV-11 · duas contas selecionadas na mesma Organization é integridade, nunca a primeira', async () => {
  const falso = { query: async (sql) => (/SELECT meta_account_id/.test(sql) ? { rows: [{ id: 'a', loja_atribuida: 'sul' }, { id: 'b', loja_atribuida: 'sul' }] } : { rows: [] }) };
  await assert.rejects(resolverMidiaDaOrganizacao(falso, { organizationId: ORG_A, loja: 'sul', from: '2026-01-01', to: '2026-01-02' }), /integridade/);
});

// ── INV-13 ─────────────────────────────────────────────────────────────────────────────────────

test('INV-13 · segredo usado não sai em resposta HTTP', async () => {
  secretGuard.registrar(TOKENS[ORG_A].meta);
  const appHttp = express();
  appHttp.use(secretGuard.middlewareDeResposta(silencioso));
  appHttp.get('/json', (req, res) => res.json({ erro: `falha com token ${TOKENS[ORG_A].meta}`, aninhado: { t: TOKENS[ORG_A].meta } }));
  appHttp.get('/texto', (req, res) => res.send(`Bearer ${TOKENS[ORG_A].meta}`));
  appHttp.get('/limpo', (req, res) => res.json({ ok: true, last4: TOKENS[ORG_A].meta.slice(-4) }));
  const server = await new Promise((resolve) => { const s = appHttp.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const rota of ['/json', '/texto']) {
      const corpo = await (await fetch(base + rota)).text();
      assert.ok(!corpo.includes(TOKENS[ORG_A].meta), `${rota} vazou o segredo: ${corpo}`);
      assert.ok(corpo.includes(secretGuard.MASCARA));
    }
    assert.deepEqual(await (await fetch(`${base}/limpo`)).json(), { ok: true, last4: TOKENS[ORG_A].meta.slice(-4) });
  } finally {
    server.close();
  }
});

test('INV-13 · segredo usado não sai em log nem em erro logado', () => {
  secretGuard.registrar(TOKENS[ORG_B].openai);
  const escrito = [];
  const alvo = { error: (...a) => escrito.push(a), warn: (...a) => escrito.push(a), log: (...a) => escrito.push(a) };
  secretGuard.instalarNoConsole(alvo, ['error', 'warn', 'log']);
  alvo.error(`provider respondeu 401 para ${TOKENS[ORG_B].openai}`);
  alvo.warn(new Error(`chave ${TOKENS[ORG_B].openai} recusada`));
  alvo.log({ url: `https://api.exemplo/v1?key=${TOKENS[ORG_B].openai}` });
  const tudo = JSON.stringify(escrito.map((args) => args.map((x) => (x instanceof Error ? `${x.message}\n${x.stack}` : x))));
  assert.ok(!tudo.includes(TOKENS[ORG_B].openai), tudo);
  assert.ok(tudo.includes(secretGuard.MASCARA));
});

test('INV-13 · metadata das integrações não traz plaintext nem ciphertext', async () => {
  await em(ORG_A, async () => {
    for (const provider of Object.keys(SEGREDOS)) {
      const texto = JSON.stringify(await app.metadata(provider));
      for (const valor of Object.values(TOKENS[ORG_A])) assert.ok(!texto.includes(valor), `${provider} vazou`);
      assert.ok(!/ciphertext/i.test(texto));
    }
  });
});
