'use strict';

// Retry curto de leitura na Reserva Ink (lib/ink/retry.js) — achado do smoke em produção: o 429 da
// varredura do catálogo chegava cru à tela de Categorias.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { comRetryDeLeitura, MENSAGEM_LIMITE } = h.sujeito('lib/ink/retry.js');

const erro = (status, mensagem = 'INK API respondeu') => Object.assign(new Error(mensagem), { status });
const semEspera = { dormirFn: async () => {} };

test('GET com 429 transitório é repetido e o usuário não vê nada', async () => {
  let chamadas = 0;
  const r = await comRetryDeLeitura('GET', async () => { chamadas += 1; if (chamadas < 3) throw erro(429); return { ok: true }; }, semEspera);
  assert.deepEqual(r, { ok: true });
  assert.equal(chamadas, 3, 'duas repetições, como declarado');
});

test('GET que continua limitado sai com texto de produto e código estável, sem o corpo cru da Ink', async () => {
  let chamadas = 0;
  await assert.rejects(
    comRetryDeLeitura('GET', async () => { chamadas += 1; throw erro(429, 'raw: too many requests for token abc'); }, semEspera),
    (err) => err.status === 429 && err.codigo === 'INK_RATE_LIMITED' && err.message === MENSAGEM_LIMITE && !/abc|raw/.test(err.message)
  );
  assert.equal(chamadas, 3);
});

test('escrita (POST/PATCH/PUT/DELETE) nunca é repetida aqui', async () => {
  for (const metodo of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    let chamadas = 0;
    await assert.rejects(comRetryDeLeitura(metodo, async () => { chamadas += 1; throw erro(429); }, semEspera));
    assert.equal(chamadas, 1, `${metodo} foi repetido`);
  }
});

test('erro definitivo (401, 404, 422) não é repetido nem reescrito', async () => {
  for (const status of [401, 403, 404, 422]) {
    let chamadas = 0;
    await assert.rejects(
      comRetryDeLeitura('GET', async () => { chamadas += 1; throw erro(status, 'mensagem original'); }, semEspera),
      (err) => err.status === status && err.message === 'mensagem original' && !err.codigo
    );
    assert.equal(chamadas, 1);
  }
});

test('5xx transitório em GET é repetido; erro de rede sem status não é reescrito', async () => {
  let chamadas = 0;
  assert.deepEqual(await comRetryDeLeitura('GET', async () => { chamadas += 1; if (chamadas === 1) throw erro(503); return 1; }, semEspera), 1);
  await assert.rejects(comRetryDeLeitura('GET', async () => { throw new Error('ECONNRESET'); }, semEspera), /ECONNRESET/);
});

test('o núcleo do cliente Ink usa o retry de leitura e o server.js não perdeu a fonte única', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const fonte = fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'server.js'), 'utf8');
  assert.match(fonte, /require\('\.\/lib\/ink\/retry'\)/);
  assert.match(fonte, /return comRetryDeLeitura\(metodo, \(\) => inkRequisitarUma\(/);
});
