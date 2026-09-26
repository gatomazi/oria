'use strict';

// Limite de taxa (429) no full sync: a MESMA página é repetida com backoff que respeita Retry-After;
// esgotadas as tentativas o erro sobe (partial_failure) — e nunca vira retry infinito.

const test = require('node:test');
const assert = require('node:assert/strict');

const { comBackoffDeLimite, ehLimiteDeTaxa } = require('../lib/product-analytics/catalog-sync');
const { InkApiError, lerRetryAfterMs, createInkClient } = require('../lib/connectors/commerce/reserva-ink/client');

const semLog = { warn() {}, error() {}, log() {} };
const erro429 = (retryAfterMs) => new InkApiError('limite', { status: 429, retryAfterMs });

test('429 com Retry-After: espera exatamente o que o provider pediu e repete a página', async () => {
  const esperas = [];
  let chamadas = 0;
  const r = await comBackoffDeLimite(async () => { chamadas += 1; if (chamadas < 3) throw erro429(7000); return 'ok'; }, { dormir: async (ms) => esperas.push(ms), logger: semLog });
  assert.equal(r, 'ok');
  assert.deepEqual(esperas, [7000, 7000]);
});

test('429 sem Retry-After: backoff exponencial 2s, 4s, 8s… com teto de 60s', async () => {
  const esperas = [];
  await assert.rejects(comBackoffDeLimite(async () => { throw erro429(null); }, { tentativas: 7, dormir: async (ms) => esperas.push(ms), logger: semLog }));
  assert.deepEqual(esperas, [2000, 4000, 8000, 16000, 32000, 60000, 60000]);
});

test('esgotadas as tentativas o erro sobe; erro que não é 429 nunca é repetido', async () => {
  let n = 0;
  await assert.rejects(comBackoffDeLimite(async () => { n += 1; throw erro429(1); }, { tentativas: 2, dormir: async () => {}, logger: semLog }), (e) => e.status === 429);
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(comBackoffDeLimite(async () => { n += 1; throw new InkApiError('boom', { status: 500 }); }, { dormir: async () => {}, logger: semLog }));
  assert.equal(n, 1);
  assert.equal(ehLimiteDeTaxa({ codigo: 'INK_RATE_LIMITED' }), true);
});

test('Retry-After: segundos, data HTTP e lixo', () => {
  assert.equal(lerRetryAfterMs('7'), 7000);
  assert.equal(lerRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT')), 60000);
  assert.equal(lerRetryAfterMs('abc'), null);
  assert.equal(lerRetryAfterMs(null), null);
});

test('o client da Ink devolve retryAfterMs no erro 429 (sem expor o cabeçalho cru)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '3' : null) }, json: async () => ({}) });
  const client = createInkClient({ obterToken: (usar) => usar('t'), fetchImpl });
  // GET repete curto (400 ms/1,2 s) antes de subir: reduz a espera trocando o retry por POST (uma tentativa só).
  await assert.rejects(client.post('/x', {}), (e) => e.status === 429 && e.retryAfterMs === 3000);
});
