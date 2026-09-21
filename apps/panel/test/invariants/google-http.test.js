'use strict';

// Google (OAuth/GA4) · retry, timeout e classificação de erro (lib/google/http.js).
// Repete só o que é transitório e idempotente; nunca em 400/401/403; e `invalid_grant` vira "reconecte",
// não um 500 com o texto do provider.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const g = h.sujeito('lib/google/http.js');

const resp = (status, corpo = {}, headers = {}) => new Response(JSON.stringify(corpo), { status, headers });
const semEspera = async () => {};

function roteiro(...respostas) {
  const chamadas = [];
  const fetchFn = async (url, init) => {
    chamadas.push({ url, metodo: init.method || 'GET', temSinal: !!init.signal });
    const proxima = respostas.shift();
    if (proxima instanceof Error) throw proxima;
    return proxima;
  };
  return { fetchFn, chamadas };
}

test('Given 429 seguido de 200, When GET, Then repete e devolve o sucesso', async () => {
  const { fetchFn, chamadas } = roteiro(resp(429), resp(200, { ok: true }));
  const r = await g.fetchGoogle('https://x.test/a', {}, { fetchFn, dormirFn: semEspera });
  assert.equal(r.status, 200);
  assert.equal(chamadas.length, 2);
  assert.ok(chamadas.every((c) => c.temSinal), 'toda tentativa tem timeout');
});

test('Given 503 persistente, When GET, Then para no teto de tentativas (sem loop infinito)', async () => {
  const { fetchFn, chamadas } = roteiro(resp(503), resp(503), resp(503), resp(503));
  const r = await g.fetchGoogle('https://x.test/a', {}, { fetchFn, dormirFn: semEspera });
  assert.equal(r.status, 503);
  assert.equal(chamadas.length, 3, '1 tentativa + 2 repetições');
});

test('Given 400, 401 e 403, When GET, Then NÃO repete (repetir não muda a resposta)', async () => {
  for (const status of [400, 401, 403]) {
    const { fetchFn, chamadas } = roteiro(resp(status), resp(200));
    const r = await g.fetchGoogle('https://x.test/a', {}, { fetchFn, dormirFn: semEspera });
    assert.equal(r.status, status);
    assert.equal(chamadas.length, 1, `status ${status}`);
  }
});

test('Given POST de escrita, When 503, Then NÃO repete; POST idempotente (relatório de leitura) repete', async () => {
  const escrita = roteiro(resp(503), resp(200));
  const r1 = await g.fetchGoogle('https://x.test/w', { method: 'POST' }, { fetchFn: escrita.fetchFn, dormirFn: semEspera });
  assert.equal(r1.status, 503);
  assert.equal(escrita.chamadas.length, 1);
  const leitura = roteiro(resp(503), resp(200));
  const r2 = await g.fetchGoogle('https://x.test/r', { method: 'POST' }, { fetchFn: leitura.fetchFn, dormirFn: semEspera, idempotente: true });
  assert.equal(r2.status, 200);
  assert.equal(leitura.chamadas.length, 2);
});

test('Given falha de rede transitória, When GET, Then repete; erro que não é de rede sobe direto', async () => {
  const rede = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
  const { fetchFn, chamadas } = roteiro(rede, resp(200));
  const r = await g.fetchGoogle('https://x.test/a', {}, { fetchFn, dormirFn: semEspera });
  assert.equal(r.status, 200);
  assert.equal(chamadas.length, 2);
  const outro = roteiro(new RangeError('bug do chamador'), resp(200));
  await assert.rejects(g.fetchGoogle('https://x.test/a', {}, { fetchFn: outro.fetchFn, dormirFn: semEspera }), /bug do chamador/);
  assert.equal(outro.chamadas.length, 1);
});

test('Given Retry-After, When 429, Then a espera respeita o cabeçalho, com teto', async () => {
  const esperas = [];
  const { fetchFn } = roteiro(resp(429, {}, { 'retry-after': '2' }), resp(429, {}, { 'retry-after': '999' }), resp(200));
  await g.fetchGoogle('https://x.test/a', {}, { fetchFn, dormirFn: async (ms) => { esperas.push(ms); } });
  assert.deepEqual(esperas, [2000, 5000]);
});

test('Given invalid_grant, token revogado ou 401, When classificar, Then RECONNECT_REQUIRED (409), sem corpo bruto', () => {
  for (const [status, corpo] of [[400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }], [401, {}], [403, { error: { status: 'UNAUTHENTICATED' } }]]) {
    const e = g.erroGoogle(status, corpo, 'renovação de token');
    assert.equal(e.codigo, 'RECONNECT_REQUIRED', `${status}`);
    assert.equal(e.status, 409);
    assert.doesNotMatch(e.message, /invalid_grant|expired or revoked|Token has been/);
  }
});

test('Given 403, 429 e 5xx, When classificar, Then código estável e mensagem de produto', () => {
  assert.equal(g.classificarErroGoogle(403, { error: { status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } }).codigo, 'PERMISSION_DENIED');
  assert.equal(g.classificarErroGoogle(429, {}).codigo, 'RATE_LIMITED');
  assert.equal(g.classificarErroGoogle(503, {}).codigo, 'PROVIDER_UNAVAILABLE');
  assert.equal(g.classificarErroGoogle(418, {}).codigo, 'PROVIDER_ERROR');
  for (const s of [403, 429, 503]) assert.doesNotMatch(g.erroGoogle(s, { error: { message: 'segredo interno do provider' } }).message, /segredo interno/);
});
