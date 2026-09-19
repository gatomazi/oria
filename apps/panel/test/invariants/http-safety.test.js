'use strict';

// Handlers async do Express 4 + mapeamento central de erros (lib/platform/http-safety.js).
//
// O defeito histórico: `throw` num handler `async` não chegava a nenhum middleware de erro. Virava
// `unhandledRejection`, a resposta nunca saía, e a tela do cliente ficava em "Carregando" para
// sempre. Estes testes sobem um Express real numa porta local e provam, pela rede, que:
//   - a falha vira resposta HTTP controlada (e nunca um request pendurado);
//   - nenhum `unhandledRejection` é emitido;
//   - o corpo da resposta não carrega stack, caminho de arquivo nem mensagem de erro desconhecido.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const h = require('./harness');
// O sujeito vem do harness: o negative control roda ESTE arquivo contra uma cópia defeituosa.
const httpSafety = h.sujeito('lib/platform/http-safety.js');
const { TenantRuntimeError } = h.sujeito('lib/platform/tenant-runtime.js');

httpSafety.instalarSegurancaAsync();

const rejeicoes = [];
const aoRejeitar = (motivo) => rejeicoes.push(motivo);
process.on('unhandledRejection', aoRejeitar);
test.after(() => process.off('unhandledRejection', aoRejeitar));

// App descartável com as rotas do cenário; o logger é capturado para provar "loga uma vez".
async function subir(montar) {
  const logs = [];
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  montar(app);
  app.use(httpSafety.criarErroCentral({ logger: { error: (m) => logs.push(String(m)) } }));
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${servidor.address().port}`;
  return {
    base,
    logs,
    fechar: () => new Promise((resolve) => servidor.close(resolve)),
    // Timeout curto: o defeito original era justamente "sem resposta".
    pedir: async (caminho, init = {}) => {
      const res = await fetch(base + caminho, { ...init, signal: AbortSignal.timeout(3000) });
      const texto = await res.text();
      let json = null;
      try { json = JSON.parse(texto); } catch { json = null; }
      return { status: res.status, texto, json, tipo: res.headers.get('content-type') || '' };
    },
  };
}

const esperarTicks = () => new Promise((resolve) => setTimeout(resolve, 50));

test('handler async que lança STORE_WITHOUT_LEGACY_KEY → 409 controlado, sem request pendurado', async () => {
  const s = await subir((app) => {
    app.get('/api/x', async () => { throw new TenantRuntimeError('a store desta organization não tem loja legada', 'STORE_WITHOUT_LEGACY_KEY'); });
  });
  try {
    const r = await s.pedir('/api/x');
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'STORE_WITHOUT_LEGACY_KEY');
    assert.equal(r.json.error, 'este recurso ainda não está disponível para a sua loja');
    assert.ok(r.tipo.includes('application/json'));
    await esperarTicks();
    assert.equal(rejeicoes.length, 0, 'nenhum unhandledRejection pode ser emitido');
  } finally { await s.fechar(); }
});

test('a resposta de erro não carrega stack, caminho de arquivo nem o nome da função interna', async () => {
  const s = await subir((app) => {
    app.get('/api/x', async () => { throw new TenantRuntimeError('a store desta organization não tem loja legada', 'STORE_WITHOUT_LEGACY_KEY'); });
    app.get('/api/y', async () => { throw new Error('senha do banco: hunter2 em /app/server.js:99'); });
  });
  try {
    for (const caminho of ['/api/x', '/api/y']) {
      const r = await s.pedir(caminho);
      assert.doesNotMatch(r.texto, /\n\s+at |\.js:\d+|node_modules|lojaLegadaDoContexto|hunter2|stack/i, `${caminho}: ${r.texto}`);
    }
  } finally { await s.fechar(); }
});

test('erro desconhecido → 500 genérico (a mensagem do erro não é resposta) e o stack fica no log do servidor', async () => {
  const s = await subir((app) => {
    app.get('/api/y', async () => { throw new Error('detalhe interno que ninguém previu'); });
  });
  try {
    const r = await s.pedir('/api/y');
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'erro interno do servidor', codigo: 'INTERNAL_ERROR' });
    assert.equal(s.logs.length, 1, 'o erro é logado UMA vez');
    assert.match(s.logs[0], /detalhe interno que ninguém previu/);
    assert.match(s.logs[0], /GET \/api\/y -> 500 INTERNAL_ERROR/);
    assert.match(s.logs[0], /\n\s+at /, 'o stack vai para o log');
  } finally { await s.fechar(); }
});

test('o log não carrega a query string (pode ter token ou PII)', async () => {
  const s = await subir((app) => {
    app.get('/api/y', async () => { throw new Error('falhou'); });
  });
  try {
    await s.pedir('/api/y?token=segredo123&email=a@b.com');
    assert.equal(s.logs.length, 1);
    assert.doesNotMatch(s.logs[0], /segredo123|a@b\.com/);
  } finally { await s.fechar(); }
});

test('Promise.reject() sem motivo não vira "next()" silencioso: responde 500', async () => {
  const s = await subir((app) => {
    // eslint-disable-next-line prefer-promise-reject-errors
    app.get('/api/x', async () => Promise.reject());
  });
  try {
    const r = await s.pedir('/api/x');
    assert.equal(r.status, 500);
  } finally { await s.fechar(); }
});

test('throw síncrono e rejeição depois de um await também chegam ao erro central', async () => {
  const s = await subir((app) => {
    app.get('/api/sync', () => { throw new TenantRuntimeError('sem contexto', 'TENANT_CONTEXT_REQUIRED'); });
    app.get('/api/depois', async (req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new TenantRuntimeError('sem store', 'STORE_NOT_RESOLVED');
    });
  });
  try {
    assert.equal((await s.pedir('/api/sync')).status, 401);
    assert.equal((await s.pedir('/api/depois')).status, 409);
    await esperarTicks();
    assert.equal(rejeicoes.length, 0);
  } finally { await s.fechar(); }
});

test('middleware async (o formato do requireAdmin) que rejeita também é coberto', async () => {
  const s = await subir((app) => {
    app.use('/api/protegido', async (req, res, next) => { await Promise.resolve(); throw new Error('falha no middleware'); });
    app.get('/api/protegido/x', (req, res) => res.json({ ok: true }));
  });
  try {
    const r = await s.pedir('/api/protegido/x');
    assert.equal(r.status, 500);
    assert.equal(r.json.codigo, 'INTERNAL_ERROR');
  } finally { await s.fechar(); }
});

test('handler que já respondeu e falha depois: a resposta é fechada, não fica aberta', async () => {
  const s = await subir((app) => {
    app.get('/api/x', async (req, res) => {
      res.status(200).write('parcial');
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error('falha depois de começar a responder');
    });
  });
  try {
    const res = await fetch(s.base + '/api/x', { signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'parcial', 'a resposta termina (não pendura) e não troca de status');
  } finally { await s.fechar(); }
});

test('JSON malformado (erro de cliente com expose) → 400 com a mensagem do parser, não 500', async () => {
  const s = await subir((app) => {
    app.post('/api/x', (req, res) => res.json({ ok: true }));
  });
  try {
    const r = await s.pedir('/api/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{quebrado' });
    assert.equal(r.status, 400);
    assert.ok(r.json.error);
    assert.doesNotMatch(r.texto, /\n\s+at |\.js:\d+/);
  } finally { await s.fechar(); }
});

test('caminho que não é /api recebe texto puro, não JSON', async () => {
  const s = await subir((app) => {
    app.get('/pagina', async () => { throw new Error('x'); });
  });
  try {
    const res = await fetch(s.base + '/pagina', { headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(3000) });
    assert.equal(res.status, 500);
    assert.ok((res.headers.get('content-type') || '').startsWith('text/plain'));
    assert.equal(await res.text(), 'erro interno do servidor');
  } finally { await s.fechar(); }
});

test('rota saudável não muda: resposta normal, nenhum log de erro', async () => {
  const s = await subir((app) => {
    app.get('/api/ok', async (req, res) => res.json({ ok: true }));
  });
  try {
    const r = await s.pedir('/api/ok');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(s.logs.length, 0);
  } finally { await s.fechar(); }
});

test('mapearErro: só código conhecido ganha mensagem própria; o resto é genérico', () => {
  assert.deepEqual(httpSafety.mapearErro(new TenantRuntimeError('x', 'STORE_WITHOUT_LEGACY_KEY')), {
    status: 409, error: 'este recurso ainda não está disponível para a sua loja', codigo: 'STORE_WITHOUT_LEGACY_KEY',
  });
  // `status` solto num erro qualquer NÃO é confiável: a mensagem pode ter detalhe interno.
  const solto = Object.assign(new Error('INK API respondeu 403 para o token abc'), { status: 403 });
  assert.deepEqual(httpSafety.mapearErro(solto), { status: 500, error: 'erro interno do servidor', codigo: 'INTERNAL_ERROR' });
  assert.equal(httpSafety.mapearErro(undefined).status, 500);
  assert.equal(httpSafety.mapearErro('texto').status, 500);
});

test('wrapAsync: forma explícita, e middleware de erro (4 argumentos) mantém a aridade', async () => {
  const erro = (err, req, res, next) => next(err); // eslint-disable-line no-unused-vars
  assert.equal(httpSafety.wrapAsync(erro), erro);
  assert.throws(() => httpSafety.wrapAsync('nao-e-funcao'), TypeError);

  let recebido = null;
  const seguro = httpSafety.wrapAsync(async () => { throw new Error('boom'); });
  seguro({}, {}, (err) => { recebido = err; });
  await esperarTicks();
  assert.equal(recebido.message, 'boom');
});

test('instalarSegurancaAsync é idempotente e devolve false quando o Express não tem o Layer do 4.x', () => {
  const Layer = require('express/lib/router/layer'); // o mesmo módulo que o sujeito instala
  const antes = Layer.prototype.handle_request;
  assert.equal(httpSafety.instalarSegurancaAsync(), true);
  assert.equal(Layer.prototype.handle_request, antes, 'instalar duas vezes não empilha o patch');
  assert.equal(httpSafety.instalarSegurancaAsync(() => { throw new Error('MODULE_NOT_FOUND'); }), false);
});
