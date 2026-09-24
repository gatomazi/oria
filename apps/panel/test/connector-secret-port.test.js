'use strict';

// Fase C · porta de segredos (lib/platform/connector-secret-port.js), com pool falso e um keyring
// real (cifra/decifra de verdade, chave-mestra gerada no processo do teste) — prova o round-trip,
// não só a forma da chamada. Sem banco.
//
// Premissa: 1 Organization = 1 Store (ORIA-TENANCY-STORE-01).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createConnectorSecretPort } = require('../lib/platform/connector-secret-port');
const { createSecretStore } = require('../lib/secrets/store');
const { createKeyring } = require('../lib/secrets/keyring');
const { comContexto } = require('../lib/platform/tenant-runtime');
const { ConnectorError, CODIGOS } = require('../lib/connectors/errors');
const F = require('./helpers/connector-fakes');

const MESTRA = crypto.randomBytes(32).toString('base64');
const keyring = () => createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA });

// Pool falso: uma tabela `integration_secrets` em memória, o bastante para o SQL real de
// lib/secrets/store.js (gravar + usarSegredo).
function poolFalso(seedLinhas = []) {
  const linhas = [...seedLinhas];
  const chamadas = [];
  return {
    linhas, chamadas,
    async query(sql, params) {
      chamadas.push({ sql, params });
      if (/INSERT INTO integration_secrets/.test(sql)) {
        const [integrationId, organizationId, tipo, ciphertext, keyVersion, last4v, expiresAt] = params;
        let linha = linhas.find((l) => l.integration_id === integrationId && l.tipo === tipo);
        if (!linha) { linha = { id: String(linhas.length + 1), integration_id: integrationId, tipo }; linhas.push(linha); }
        Object.assign(linha, { organization_id: organizationId, ciphertext, key_version: keyVersion, last4: last4v, expires_at: expiresAt, rotated_at: new Date() });
        return { rows: [{ id: linha.id, tipo: linha.tipo, last4: linha.last4, key_version: linha.key_version, expires_at: linha.expires_at, rotated_at: linha.rotated_at }] };
      }
      if (/SELECT ciphertext, key_version, expires_at FROM integration_secrets/.test(sql)) {
        const [integrationId, tipo, organizationId] = params;
        const achada = linhas.find((l) => l.integration_id === integrationId && l.tipo === tipo && (organizationId === null || l.organization_id === organizationId));
        return { rows: achada ? [{ ciphertext: achada.ciphertext, key_version: achada.key_version, expires_at: achada.expires_at }] : [] };
      }
      throw new Error(`SQL inesperado no fake pool de segredos: ${sql}`);
    },
  };
}

async function poolComToken({ integrationId = F.INT_INK_A, organizationId = F.ORG_A, token = 'ink-tok-secreto', expiresAt = null } = {}) {
  const pool = poolFalso();
  await createSecretStore({ pool, keyring: keyring() }).gravar({ integrationId, organizationId, tipo: 'api_token', valor: token, expiresAt, contexto: 'ink-api-token-v1' });
  return pool;
}

const integracaoInk = (extra = {}) => ({ integrationId: F.INT_INK_A, organizationId: F.ORG_A, storeId: F.STORE_A, integrationProvider: 'ink', status: 'connected', config: {}, ...extra });
const ctxA = { organizationId: F.ORG_A, storeId: F.STORE_A };
const emA = (fn) => comContexto({ organizationId: F.ORG_A, storeId: F.STORE_A, origem: 'teste' }, fn);
const rejeita = (promessa, codigo) => assert.rejects(promessa, (err) => err.codigo === codigo, `esperava ${codigo}`);

// ── Round-trip ──────────────────────────────────────────────────────────────────────────────────

test('C · use() entrega o plaintext ao callback e devolve o RESULTADO do callback, nunca o valor', () => emA(async () => {
  const pool = await poolComToken({ token: 'ink-tok-abc123' });
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  const secrets = port.forIntegration(ctxA, integracaoInk());
  const recebido = [];
  const r = await secrets.use('api_token', (token) => { recebido.push(token); return { usado: true, tamanho: token.length }; });
  assert.deepEqual(recebido, ['ink-tok-abc123']);
  assert.deepEqual(r, { usado: true, tamanho: 14 });
}));

test('C · has() diz que existe sem entregar o valor a ninguém', () => emA(async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  assert.equal(await port.forIntegration(ctxA, integracaoInk()).has('api_token'), true);
}));

test('C · has() é false para segredo ausente, sem lançar', () => emA(async () => {
  const pool = poolFalso();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  assert.equal(await port.forIntegration(ctxA, integracaoInk()).has('api_token'), false);
}));

test('C · has() é false para segredo vencido (sem aceitarVencido)', () => emA(async () => {
  const pool = await poolComToken({ expiresAt: new Date(Date.now() - 1000) });
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  assert.equal(await port.forIntegration(ctxA, integracaoInk()).has('api_token'), false);
}));

test('C · use() sem callback é erro de programação: o plaintext nunca é retornado', () => emA(async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  await assert.rejects(port.forIntegration(ctxA, integracaoInk()).use('api_token'), TypeError);
}));

// ── Whitelist de nome de segredo ────────────────────────────────────────────────────────────────

test('C · o connector escolhe só o nome do segredo: nome fora do whitelist do provider é erro, não consulta o banco', () => emA(async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  const secrets = port.forIntegration(ctxA, integracaoInk());
  const antes = pool.chamadas.length;
  await rejeita(secrets.use('senha_do_admin', () => {}), CODIGOS.INTEGRATION_INVALID);
  await rejeita(secrets.use('__proto__', () => {}), CODIGOS.INTEGRATION_INVALID);
  assert.equal(pool.chamadas.length, antes, 'não deveria ter consultado o banco');
}));

test('C · nome de segredo válido para OUTRO provider não é aceito num connector Ink', () => emA(async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  // 'refresh_token' existe para ga4/google_ads, não para ink.
  await rejeita(port.forIntegration(ctxA, integracaoInk()).use('refresh_token', () => {}), CODIGOS.INTEGRATION_INVALID);
}));

// ── Tenant: nunca outro tenant, integration ou provider ────────────────────────────────────────

test('C · integração de outra Organization é rejeitada antes de qualquer consulta', () => emA(async () => {
  const pool = await poolComToken({ organizationId: F.ORG_B });
  const antes = pool.chamadas.length;
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  assert.throws(() => port.forIntegration(ctxA, integracaoInk({ organizationId: F.ORG_B })), (err) => err instanceof ConnectorError && err.codigo === CODIGOS.INTEGRATION_TENANT_MISMATCH);
  assert.equal(pool.chamadas.length, antes, 'não deveria ter consultado o banco além do seed');
}));

test('C · integrationId do contexto diferente do da integração é rejeitado', () => emA(async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  assert.throws(() => port.forIntegration({ ...ctxA, integrationId: F.INT_GA4_A }, integracaoInk()), (err) => err.codigo === CODIGOS.INTEGRATION_TENANT_MISMATCH);
}));

test('C · leitura fora do contexto de Organization do processo falha fechada', async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  assert.throws(() => port.forIntegration(ctxA, integracaoInk()), (err) => err.codigo === 'TENANT_CONTEXT_REQUIRED');
});

test('C · processo com contexto de OUTRA Organization não lê o segredo de A, mesmo passando a integration de A à mão', () => comContexto({ organizationId: F.ORG_B, storeId: F.STORE_B, origem: 'teste' }, async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  assert.throws(() => port.forIntegration(ctxA, integracaoInk()), (err) => err.codigo === CODIGOS.INTEGRATION_TENANT_MISMATCH);
}));

test('C · o segredo de B nunca é lido por uma leitura de A: filtra integrationId E organizationId juntos', () => emA(async () => {
  const pool = await poolComToken({ integrationId: F.INT_INK_B, organizationId: F.ORG_B, token: 'ink-tok-de-B' });
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  // Mesmo se alguém (erroneamente) construísse uma "integration" com o id de B, a Organization não bate.
  assert.throws(() => port.forIntegration(ctxA, integracaoInk({ integrationId: F.INT_INK_B, organizationId: F.ORG_B })), (err) => err.codigo === CODIGOS.INTEGRATION_TENANT_MISMATCH);
}));

test('C · toda consulta ao banco leva integrationId E organizationId juntos, nunca um sozinho', () => emA(async () => {
  const pool = await poolComToken();
  const port = createConnectorSecretPort({ pool, keyring: keyring() });
  await port.forIntegration(ctxA, integracaoInk()).use('api_token', () => {});
  const leitura = pool.chamadas.find((c) => /SELECT ciphertext/.test(c.sql));
  assert.deepEqual(leitura.params, [F.INT_INK_A, 'api_token', F.ORG_A]);
  assert.match(leitura.sql, /integration_id = \$1 AND tipo = \$2 AND \(\$3::uuid IS NULL OR organization_id = \$3\)/);
}));

// ── Sem fallback de env ─────────────────────────────────────────────────────────────────────────

test('C · sem o segredo persistido, não há fallback nenhum: SECRET_MISSING, nunca variável de ambiente', () => emA(async () => {
  const antes = { ...process.env };
  process.env.INK_TOKEN_SUL = 'nao-deveria-ser-usado';
  process.env.ALLOW_LEGACY_INTEGRATION_ENV = '1';
  try {
    const pool = poolFalso();
    const port = createConnectorSecretPort({ pool, keyring: keyring() });
    await assert.rejects(port.forIntegration(ctxA, integracaoInk()).use('api_token', () => {}), (err) => err.codigo === 'SECRET_MISSING');
  } finally {
    process.env = antes;
  }
}));

test('C · o arquivo da porta não importa o resolver legado nem lê ALLOW_LEGACY_INTEGRATION_ENV/INK_TOKEN_ (guarda estática)', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'lib', 'platform', 'connector-secret-port.js'), 'utf8')
    .split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(fonte, /createIntegrationResolver|usarSegredo\(provider|ALLOW_LEGACY_INTEGRATION_ENV|INK_TOKEN_|ENV_LEGADO_INK|process\.env/);
  // Só o SecretStore de baixo nível e o keyring — nunca o módulo de integrations como resolver.
  assert.match(fonte, /require\(\s*'\.\.\/secrets\/store'\s*\)/);
});

// ── Resultado congelado / captura de referência ────────────────────────────────────────────────

test('C · forIntegration devolve um objeto congelado com só use/has', () => emA(async () => {
  const pool = await poolComToken();
  const secrets = createConnectorSecretPort({ pool, keyring: keyring() }).forIntegration(ctxA, integracaoInk());
  assert.deepEqual(Object.keys(secrets).sort(), ['has', 'use']);
  assert.ok(Object.isFrozen(secrets));
}));

test('C · pool ausente é erro de configuração, não silêncio', () => {
  assert.throws(() => createConnectorSecretPort({ pool: null }), /exige pool/);
});
