'use strict';

// Fase E · troca refresh_token → access_token (lib/connectors/analytics/ga4/token-port.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { refreshAccessToken, GOOGLE_TOKEN_URL } = require('../lib/connectors/analytics/ga4/token-port');

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('E · refreshAccessToken faz POST form-encoded ao endpoint de token do Google, sem o refresh token na URL', async () => {
  const chamadas = [];
  const fetchImpl = async (url, init) => { chamadas.push({ url, init }); return jsonRes(200, { access_token: 'novo-token', expires_in: 3600 }); };
  const r = await refreshAccessToken({ refreshToken: 'rt-secreto', clientId: 'cid', clientSecret: 'csecret', fetchImpl });
  assert.equal(chamadas[0].url, GOOGLE_TOKEN_URL);
  assert.equal(chamadas[0].url.includes('rt-secreto'), false);
  assert.equal(chamadas[0].init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const params = new URLSearchParams(chamadas[0].init.body);
  assert.equal(params.get('refresh_token'), 'rt-secreto');
  assert.equal(params.get('grant_type'), 'refresh_token');
  assert.equal(r.accessToken, 'novo-token');
  assert.ok(r.expiresAt instanceof Date);
  assert.ok(r.expiresAt.getTime() > Date.now());
});

test('E · refreshAccessToken exige refreshToken e a credencial de plataforma (clientId/clientSecret)', async () => {
  await assert.rejects(refreshAccessToken({ clientId: 'a', clientSecret: 'b' }), TypeError);
  await assert.rejects(
    refreshAccessToken({ refreshToken: 'rt', clientId: undefined, clientSecret: undefined, fetchImpl: async () => jsonRes(200, {}) }),
    (err) => err.codigo === 'GOOGLE_PLATFORM_CREDENTIAL_MISSING',
  );
});

test('E · resposta sem access_token/expires_in é rejeitada, nunca devolve token incompleto', async () => {
  const fetchImpl = async () => jsonRes(200, { access_token: 'x' }); // sem expires_in
  await assert.rejects(
    refreshAccessToken({ refreshToken: 'rt', clientId: 'a', clientSecret: 'b', fetchImpl }),
    (err) => err.codigo === 'GOOGLE_TOKEN_RESPONSE_INVALID',
  );
});

test('E · erro do Google (ex.: invalid_grant) vem classificado, nunca o corpo bruto', async () => {
  const fetchImpl = async () => jsonRes(400, { error: 'invalid_grant' });
  await assert.rejects(refreshAccessToken({ refreshToken: 'rt', clientId: 'a', clientSecret: 'b', fetchImpl }), (err) => {
    assert.equal(err.codigo, 'RECONNECT_REQUIRED');
    return true;
  });
});

test('E · o refresh token nunca aparece na mensagem de erro', async () => {
  const fetchImpl = async () => jsonRes(401, { error: 'invalid_token' });
  await assert.rejects(refreshAccessToken({ refreshToken: 'rt-super-secreto', clientId: 'a', clientSecret: 'b', fetchImpl }), (err) => {
    assert.equal(err.message.includes('rt-super-secreto'), false);
    return true;
  });
});
