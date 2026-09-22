'use strict';

// Fase C · cliente HTTP da Ink (lib/connectors/commerce/reserva-ink/client.js): header, sem token na
// URL, erro normalizado, retry de leitura (o mesmo lib/ink/retry.js que o legado usa), DELETE 204.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createInkClient, InkApiError, INK_API_BASE } = require('../lib/connectors/commerce/reserva-ink/client');

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const obterTokenDe = (token) => (usar) => usar(token);

function fetchFalso(respostas) {
  const chamadas = [];
  const fila = [...respostas];
  return {
    chamadas,
    fetchImpl: async (url, init) => {
      chamadas.push({ url, init });
      const proxima = fila.shift();
      if (!proxima) throw new Error('fetch falso sem resposta programada');
      return typeof proxima === 'function' ? proxima(url, init) : proxima;
    },
  };
}

test('C · get() usa Authorization: Bearer e NUNCA põe o token na URL', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(200, { ok: true })]);
  const client = createInkClient({ obterToken: obterTokenDe('tok-secreto-abc'), fetchImpl });
  await client.get('/v1/stores/products?page=1');
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].url, `${INK_API_BASE}/v1/stores/products?page=1`);
  assert.equal(chamadas[0].init.headers.Authorization, 'Bearer tok-secreto-abc');
  assert.equal(chamadas[0].url.includes('tok-secreto-abc'), false);
});

test('C · post() envia Content-Type e o body serializado; GET não envia body', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(201, { id: 1 })]);
  const client = createInkClient({ obterToken: obterTokenDe('t'), fetchImpl });
  await client.post('/v1/stores/exchanges', { motivo: 'defeito' }, { 'Idempotency-Key': 'k1' });
  assert.equal(chamadas[0].init.headers['Content-Type'], 'application/json');
  assert.equal(chamadas[0].init.headers['Idempotency-Key'], 'k1');
  assert.equal(chamadas[0].init.body, JSON.stringify({ motivo: 'defeito' }));

  const { fetchImpl: fGet, chamadas: cGet } = fetchFalso([jsonRes(200, {})]);
  await createInkClient({ obterToken: obterTokenDe('t'), fetchImpl: fGet }).get('/v1/stores/products');
  assert.equal(cGet[0].init.body, undefined);
  assert.equal('Content-Type' in cGet[0].init.headers, false);
});

test('C · DELETE 204 devolve objeto vazio sem tentar parsear corpo', async () => {
  const { fetchImpl } = fetchFalso([{ ok: true, status: 204, json: async () => { throw new Error('não deveria chamar json()'); } }]);
  const client = createInkClient({ obterToken: obterTokenDe('t'), fetchImpl });
  assert.deepEqual(await client.delete('/v1/stores/exchanges/1'), {});
});

for (const status of [400, 401, 403, 404]) {
  test(`C · erro ${status} vira InkApiError com o status e não repete (não é transitório)`, async () => {
    const { fetchImpl, chamadas } = fetchFalso([jsonRes(status, { error: `falhou ${status}` })]);
    const client = createInkClient({ obterToken: obterTokenDe('t'), fetchImpl });
    await assert.rejects(client.get('/v1/stores/products/1'), (err) => err instanceof InkApiError && err.status === status);
    assert.equal(chamadas.length, 1);
  });
}

test('C · 429 num GET repete e, esgotadas as tentativas, sai com mensagem de produto e código estável', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(429, {}), jsonRes(429, {}), jsonRes(429, {})]);
  const client = createInkClient({ obterToken: obterTokenDe('t'), fetchImpl });
  await assert.rejects(client.get('/v1/stores/products'), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.codigo, 'INK_RATE_LIMITED');
    assert.match(err.message, /limitando/);
    return true;
  });
  assert.equal(chamadas.length, 3);
});

test('C · 429 num POST NÃO repete (escrita não é idempotente por conta própria)', async () => {
  const { fetchImpl, chamadas } = fetchFalso([jsonRes(429, {})]);
  const client = createInkClient({ obterToken: obterTokenDe('t'), fetchImpl });
  await assert.rejects(client.post('/v1/stores/exchanges', {}), (err) => err.status === 429);
  assert.equal(chamadas.length, 1);
});

test('C · erro de escrita carrega details; erro de leitura não', async () => {
  const { fetchImpl: fPost } = fetchFalso([jsonRes(422, { errors: ['sku duplicado'] })]);
  await assert.rejects(
    createInkClient({ obterToken: obterTokenDe('t'), fetchImpl: fPost }).post('/v1/stores/exchanges', {}),
    (err) => err.message === 'sku duplicado' && Array.isArray(err.details?.errors),
  );
  const { fetchImpl: fGet } = fetchFalso([jsonRes(500, { error: 'falhou' })]);
  await assert.rejects(
    createInkClient({ obterToken: obterTokenDe('t'), fetchImpl: fGet }).get('/v1/stores/products'),
    (err) => err.details === undefined,
  );
});

test('C · o token nunca aparece na mensagem nem nos details do erro', async () => {
  const { fetchImpl } = fetchFalso([jsonRes(401, { error: 'unauthorized' })]);
  const client = createInkClient({ obterToken: obterTokenDe('tok-super-secreto'), fetchImpl });
  await assert.rejects(client.get('/v1/stores/products'), (err) => {
    assert.equal(JSON.stringify({ message: err.message, details: err.details }).includes('tok-super-secreto'), false);
    return true;
  });
});

test('C · createInkClient exige obterToken', () => {
  assert.throws(() => createInkClient({}), /obterToken/);
});
