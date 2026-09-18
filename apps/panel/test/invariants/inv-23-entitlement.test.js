'use strict';

// INV-23 — falhar ao resolver o plano NEGA a feature.
// Classe crítica: entitlement.
//
// A violação que o negative control introduz é o código que está em produção hoje: um `catch` que
// devolve permissão, e um spread de defaults com tudo `true` (`server.js:13390`,
// `src/state/entitlements.ts:14-22`). A rota protegida responde 200 com a fonte de
// entitlements no chão — que é a definição de fail-open.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const h = require('./harness');
const { checkEntitlement, requireEntitlement, EntitlementDeniedError } =
  h.sujeito('lib/platform/entitlements.js');

const PLANO_OK = { creative_generator: true, whatsapp: true, financial: false };

test('INV-23 · fonte de entitlements no chão → nega', async () => {
  const fonteQuebrada = async () => { throw new Error('conexão recusada'); };
  await assert.rejects(
    () => checkEntitlement(fonteQuebrada, 'creative_generator'),
    EntitlementDeniedError,
    'erro ao carregar o plano precisa NEGAR — é o caso que o fail-open de hoje concede'
  );
});

test('INV-23 · plano nulo, vazio ou não-objeto → nega', async () => {
  for (const plano of [null, undefined, '', 0, 'tudo-liberado', []]) {
    await assert.rejects(() => checkEntitlement(async () => plano, 'creative_generator'), EntitlementDeniedError);
  }
});

test('INV-23 · feature AUSENTE do plano → nega (ausência nunca concede)', async () => {
  await assert.rejects(
    () => checkEntitlement(async () => PLANO_OK, 'feature_que_nao_existe'),
    EntitlementDeniedError
  );
  await assert.rejects(
    () => checkEntitlement(async () => ({}), 'creative_generator'),
    EntitlementDeniedError
  );
});

test('INV-23 · valores "quase true" não concedem', async () => {
  for (const valor of ['true', 1, 'sim', {}, [], 'on']) {
    await assert.rejects(
      () => checkEntitlement(async () => ({ creative_generator: valor }), 'creative_generator'),
      EntitlementDeniedError,
      `o valor ${JSON.stringify(valor)} não pode conceder — só o booleano true concede`
    );
  }
});

test('INV-23 · o estado correto continua funcionando', async () => {
  assert.equal(await checkEntitlement(async () => PLANO_OK, 'creative_generator'), true);
  await assert.rejects(() => checkEntitlement(async () => PLANO_OK, 'financial'), EntitlementDeniedError);
});

// ── A verificação que o plano pede literalmente: "derrubar a fonte de entitlements e verificar se
// a rota protegida ainda responde 200". Aqui ela é uma rota HTTP de verdade.
async function chamar(carregarPlano, feature) {
  const servidor = http.createServer((req, res) => {
    const mw = requireEntitlement(carregarPlano, feature);
    mw(req, {
      status(c) { this._c = c; return this; },
      json(o) { res.statusCode = this._c || 200; res.end(JSON.stringify(o)); },
    }, () => { res.statusCode = 200; res.end(JSON.stringify({ ok: true })); });
  });
  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const { port } = servidor.address();
  try {
    const resposta = await fetch(`http://127.0.0.1:${port}/protegida`);
    return { status: resposta.status, corpo: await resposta.text() };
  } finally {
    await new Promise((r) => servidor.close(r));
  }
}

test('INV-23 · rota protegida com a fonte no chão responde 403, nunca 200', async () => {
  const caiu = await chamar(async () => { throw new Error('postgres fora'); }, 'creative_generator');
  assert.equal(caiu.status, 403, 'a rota respondeu com a fonte de entitlements derrubada');
  assert.ok(!caiu.corpo.includes('postgres fora'), 'o motivo interno não vaza para o cliente');

  const liberado = await chamar(async () => PLANO_OK, 'creative_generator');
  assert.equal(liberado.status, 200);

  const negado = await chamar(async () => PLANO_OK, 'financial');
  assert.equal(negado.status, 403);
});
