'use strict';

// INV-13 — nenhum segredo em resposta, log ou erro.
// INV-14 — a chave de cifra é independente da de sessão e é versionada.
// Classe crítica: secrets.
//
// A violação que o negative control introduz é um handler ecoando o segredo semeado na resposta —
// que é, literalmente, o modo de falha recorrente que TD-004 cita como razão para o ciphertext
// morar numa tabela à parte.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { createKeyring, metadataDeSegredo, last4, CONTEXTO_META, CONTEXTO_GA4, VERSAO_LEGACY } =
  h.sujeito('lib/secrets/keyring.js');
const { createSecretStore, SegredoIndisponivelError } = h.sujeito('lib/secrets/store.js');

const SEGREDO = 'EAAG-token-de-producao-nao-vaze-isto-9f2c';
const CHAVE_V1 = h.chaveMestraDeTeste('1');
const CHAVE_V2 = h.chaveMestraDeTeste('2');

const pool = h.abrirPool();
test.after(async () => { await pool.end(); });

function ambiente(extra = {}) {
  return {
    ENCRYPTION_MASTER_KEY: CHAVE_V1,
    ENCRYPTION_KEY_VERSION: '1',
    ADMIN_SESSION_SECRET: 'segredo-de-sessao-que-nao-deve-cifrar-nada',
    ...extra,
  };
}

test.before(async () => { await h.limparIntegracoes(pool); });

// ── INV-13 ─────────────────────────────────────────────────────────────────────────────────────

test('INV-13 · a listagem que vai para a API não contém plaintext nem ciphertext', async () => {
  await h.limparIntegracoes(pool);
  const keyring = createKeyring(ambiente());
  const store = createSecretStore({ pool, keyring });
  const integrationId = await h.semearIntegracao(pool, { provider: 'meta', escopo: 'sul' });

  await store.gravar({ integrationId, tipo: 'access_token', valor: SEGREDO, contexto: CONTEXTO_META });

  const metadata = await store.listarMetadata(integrationId);
  const serializado = JSON.stringify(metadata);

  assert.ok(!serializado.includes(SEGREDO), 'o segredo em texto claro apareceu na resposta');
  assert.ok(!/ciphertext/i.test(serializado), 'o ciphertext apareceu na resposta');

  // E o que PODE aparecer, aparece — senão o teste passaria com uma resposta vazia.
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].tipo, 'access_token');
  assert.equal(metadata[0].last4, SEGREDO.slice(-4));
  assert.equal(metadata[0].keyVersion, 1);
  assert.equal(metadata[0].status, 'active');
});

test('INV-13 · o ciphertext não é alcançável por SELECT * em `integrations` (TD-004, Opção A)', async () => {
  await h.limparIntegracoes(pool);
  const keyring = createKeyring(ambiente());
  const store = createSecretStore({ pool, keyring });
  const integrationId = await h.semearIntegracao(pool, { provider: 'ink', escopo: 'sul' });
  await store.gravar({ integrationId, tipo: 'webhook_secret', valor: SEGREDO, contexto: CONTEXTO_META });

  const { rows } = await pool.query('SELECT * FROM integrations WHERE id = $1', [integrationId]);
  const serializado = JSON.stringify(rows);
  assert.ok(!serializado.includes(SEGREDO));
  assert.ok(!Object.prototype.hasOwnProperty.call(rows[0], 'ciphertext'));
});

test('INV-13 · o plaintext nunca é RETORNADO — só entregue a um callback', async () => {
  await h.limparIntegracoes(pool);
  const keyring = createKeyring(ambiente());
  const store = createSecretStore({ pool, keyring });
  const integrationId = await h.semearIntegracao(pool, { provider: 'meta', escopo: 'sul' });
  await store.gravar({ integrationId, tipo: 'access_token', valor: SEGREDO, contexto: CONTEXTO_META });

  await assert.rejects(
    () => store.usarSegredo({ integrationId, tipo: 'access_token', contexto: CONTEXTO_META }),
    TypeError,
    'sem callback, usarSegredo precisa recusar — devolver o valor é o caminho para ele vazar'
  );

  // Com callback: o valor chega a quem vai usá-lo, e o retorno é o resultado do USO.
  const resultado = await store.usarSegredo(
    { integrationId, tipo: 'access_token', contexto: CONTEXTO_META },
    (token) => {
      assert.equal(token, SEGREDO);
      return { status: 200 };
    }
  );
  assert.deepEqual(resultado, { status: 200 });
});

test('INV-13 · erro de segredo ilegível não carrega o segredo nem o ciphertext', async () => {
  await h.limparIntegracoes(pool);
  const gravador = createSecretStore({ pool, keyring: createKeyring(ambiente()) });
  const integrationId = await h.semearIntegracao(pool, { provider: 'meta', escopo: 'sul' });
  await gravador.gravar({ integrationId, tipo: 'access_token', valor: SEGREDO, contexto: CONTEXTO_META });

  // Outra chave mestra: o segredo vira ilegível.
  const leitorErrado = createSecretStore({
    pool,
    keyring: createKeyring(ambiente({ ENCRYPTION_MASTER_KEY: CHAVE_V2 })),
  });

  await assert.rejects(
    () => leitorErrado.usarSegredo({ integrationId, tipo: 'access_token', contexto: CONTEXTO_META }, () => 'nunca'),
    (err) => {
      assert.ok(err instanceof SegredoIndisponivelError);
      assert.ok(!err.message.includes(SEGREDO));
      assert.ok(!err.stack.includes(SEGREDO));
      return true;
    }
  );
});

test('INV-13 · last4 não é gerado para segredo curto demais', () => {
  assert.equal(last4('abc'), null);
  assert.equal(last4('1234567'), null);
  assert.equal(last4('12345678'), '5678');
  assert.equal(metadataDeSegredo(null), null);
});

// ── INV-14 ─────────────────────────────────────────────────────────────────────────────────────

test('INV-14 · rotacionar ADMIN_SESSION_SECRET não torna nenhum segredo ilegível', async () => {
  await h.limparIntegracoes(pool);
  const store = createSecretStore({ pool, keyring: createKeyring(ambiente()) });
  // Sem loja: desde a Fase 1 a integração precisa de dono explícito (Organization da Sul no banco de teste).
  const integrationId = await h.semearIntegracao(pool, {
    provider: 'google_ads', escopo: null, organizationId: 'a1000000-0000-4000-8000-000000000001',
  });
  await store.gravar({ integrationId, tipo: 'refresh_token', valor: SEGREDO, contexto: CONTEXTO_GA4 });

  // O segredo de SESSÃO muda por completo. O de integração precisa continuar legível.
  const depoisDaRotacao = createSecretStore({
    pool,
    keyring: createKeyring(ambiente({ ADMIN_SESSION_SECRET: 'segredo-de-sessao-COMPLETAMENTE-novo' })),
  });

  const lido = await depoisDaRotacao.usarSegredo(
    { integrationId, tipo: 'refresh_token', contexto: CONTEXTO_GA4 },
    (v) => v
  );
  assert.equal(lido, SEGREDO, 'rotacionar a chave de SESSÃO não pode afetar segredos de INTEGRAÇÃO');
});

test('INV-14 · sem ENCRYPTION_MASTER_KEY não se cifra — ADMIN_SESSION_SECRET não substitui', () => {
  const semChave = createKeyring({ ADMIN_SESSION_SECRET: 'tem-segredo-de-sessao-de-sobra' });
  assert.equal(semChave.disponivel(), false);
  assert.throws(() => semChave.encrypt('x', CONTEXTO_META), /ENCRYPTION_MASTER_KEY/);
});

test('INV-14 · key_version é persistida e a escrita usa sempre a corrente', async () => {
  await h.limparIntegracoes(pool);
  const store = createSecretStore({ pool, keyring: createKeyring(ambiente()) });
  const integrationId = await h.semearIntegracao(pool, { provider: 'meta', escopo: 'sul' });
  await store.gravar({ integrationId, tipo: 'access_token', valor: SEGREDO, contexto: CONTEXTO_META });

  const { rows } = await pool.query('SELECT key_version FROM integration_secrets WHERE integration_id = $1', [integrationId]);
  assert.equal(rows[0].key_version, 1);

  // Rotação: v2 é a corrente, v1 continua aceita para leitura.
  const rotacionado = createSecretStore({
    pool,
    keyring: createKeyring(ambiente({
      ENCRYPTION_MASTER_KEY: CHAVE_V2,
      ENCRYPTION_MASTER_KEY_PREV: CHAVE_V1,
      ENCRYPTION_KEY_VERSION: '2',
    })),
  });

  // Antes de re-cifrar, o segredo gravado em v1 já precisa ser legível — é o "sem downtime".
  assert.equal(
    await rotacionado.usarSegredo({ integrationId, tipo: 'access_token', contexto: CONTEXTO_META }, (v) => v),
    SEGREDO
  );

  const res = await rotacionado.recifrarPendentes({ contextoPorTipo: { access_token: CONTEXTO_META } });
  assert.deepEqual(res, { recifrados: 1, ilegiveis: 0 });

  const { rows: depois } = await pool.query('SELECT key_version FROM integration_secrets WHERE integration_id = $1', [integrationId]);
  assert.equal(depois[0].key_version, 2, 'a escrita usa sempre a versão corrente');

  // E o valor sobreviveu à re-cifra.
  assert.equal(
    await rotacionado.usarSegredo({ integrationId, tipo: 'access_token', contexto: CONTEXTO_META }, (v) => v),
    SEGREDO
  );
});

test('INV-14 · o fallback legacy (key_version 0) é OPT-IN e só de leitura', async () => {
  await h.limparIntegracoes(pool);
  const SESSAO = 'segredo-de-sessao-legado-em-producao';

  // Simula o que existe hoje em produção: ciphertext cifrado com a chave derivada da sessão.
  const legado = createKeyring({
    ENCRYPTION_MASTER_KEY: Buffer.from(require('crypto').hkdfSync('sha256', SESSAO, '', 'chave-mestra-simulada', 32)).toString('base64'),
    ENCRYPTION_KEY_VERSION: '1',
  });
  void legado;

  // Sem a flag, ADMIN_SESSION_SECRET não participa de nada.
  const semFlag = createKeyring({ ENCRYPTION_MASTER_KEY: CHAVE_V1, ADMIN_SESSION_SECRET: SESSAO });
  assert.equal(semFlag.legacyAtivo, false);
  assert.ok(!semFlag.versoesDeLeitura().includes(VERSAO_LEGACY),
    'sem a flag explícita, a versão legacy não pode nem ser tentada');

  // Com a flag, a versão 0 entra APENAS na leitura.
  const comFlag = createKeyring({
    ENCRYPTION_MASTER_KEY: CHAVE_V1,
    ADMIN_SESSION_SECRET: SESSAO,
    ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1',
  });
  assert.equal(comFlag.legacyAtivo, true);
  assert.ok(comFlag.versoesDeLeitura().includes(VERSAO_LEGACY));

  // Um ciphertext produzido pela chave legacy é lido...
  const cifradoPelaLegacy = (() => {
    const crypto = require('crypto');
    const chave = Buffer.from(crypto.hkdfSync('sha256', SESSAO, '', CONTEXTO_META, 32));
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', chave, iv);
    const enc = Buffer.concat([c.update(SEGREDO, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
  })();

  assert.equal(
    comFlag.decrypt(cifradoPelaLegacy, { keyVersion: VERSAO_LEGACY, contexto: CONTEXTO_META }),
    SEGREDO
  );
  // ...e a ESCRITA nunca volta para a versão 0.
  assert.equal(comFlag.encrypt(SEGREDO, CONTEXTO_META).keyVersion, 1);

  // Sem a flag, o mesmo ciphertext é ilegível — que é o comportamento desejado depois da janela.
  assert.equal(semFlag.decrypt(cifradoPelaLegacy, { keyVersion: VERSAO_LEGACY, contexto: CONTEXTO_META }), null);
});
