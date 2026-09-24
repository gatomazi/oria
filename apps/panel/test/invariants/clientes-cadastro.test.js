'use strict';

// Cadastro de clientes da Ink (lib/clientes/cadastro.js): lê todas as páginas com concorrência baixa, respeita o
// teto, não duplica, guarda por Store e nunca guarda erro. A chave do cache é a Store — nunca uma compartilhada.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const { lerCadastroCompleto, criarCacheDoCadastro } = h.sujeito('lib/clientes/cadastro.js');

const cliente = (id) => ({ id, first_name: 'Cli', last_name: String(id), email: `c${id}@x.com`, phone: `1190000${String(id).padStart(4, '0')}`, document: `000${id}`, accepts_marketing: id % 2 === 0 });

// Ink falsa: `paginas` páginas de `porPagina` clientes; registra as páginas pedidas e a concorrência máxima.
function inkFalsa({ paginas, porPagina = 3, atraso = 5 }) {
  const estado = { pedidas: [], emVoo: 0, maxEmVoo: 0 };
  const carregarPagina = async (n) => {
    estado.pedidas.push(n);
    estado.emVoo += 1;
    estado.maxEmVoo = Math.max(estado.maxEmVoo, estado.emVoo);
    await new Promise((r) => setTimeout(r, atraso));
    estado.emVoo -= 1;
    const customers = Array.from({ length: porPagina }, (_, i) => cliente((n - 1) * porPagina + i + 1));
    return { customers, total_pages: paginas };
  };
  return { carregarPagina, estado };
}

test('lê TODAS as páginas, sem repetir e com concorrência limitada', async () => {
  const { carregarPagina, estado } = inkFalsa({ paginas: 8 });
  const r = await lerCadastroCompleto(carregarPagina, { concorrencia: 3 });
  assert.equal(r.clientes.length, 24, '8 páginas × 3');
  assert.deepEqual([...estado.pedidas].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8], 'cada página uma vez');
  assert.ok(estado.maxEmVoo <= 3, `no máximo 3 chamadas ao mesmo tempo (foram ${estado.maxEmVoo}): a cota da Ink é compartilhada`);
  assert.equal(r.parcial, false);
  assert.equal(r.clientes[0].nome, 'Cli 1');
  assert.equal(r.clientes[0].aceitaMarketing, false);
});

test('acima do teto de páginas o resultado sai marcado como parcial (e não lê além do teto)', async () => {
  const { carregarPagina, estado } = inkFalsa({ paginas: 10 });
  const r = await lerCadastroCompleto(carregarPagina, { maxPaginas: 4 });
  assert.equal(r.parcial, true);
  assert.equal(r.totalPaginas, 10);
  assert.equal(Math.max(...estado.pedidas), 4, 'nenhuma página além do teto');
  assert.equal(r.clientes.length, 12);
});

test('cliente repetido entre páginas (a Ink mexeu na ordem) não vira duplicado', async () => {
  const carregarPagina = async (n) => ({ customers: [cliente(1), cliente(n + 1)], total_pages: 3 });
  const r = await lerCadastroCompleto(carregarPagina);
  assert.deepEqual(r.clientes.map((c) => c.id).sort(), ['1', '2', '3', '4']);
});

test('cache: a segunda leitura da MESMA Store não vai à Ink; expira depois do TTL', async () => {
  let agora = 1_000;
  const { carregarPagina, estado } = inkFalsa({ paginas: 2 });
  const cache = criarCacheDoCadastro({ ttlMs: 60_000, agora: () => agora });
  await cache.obter('org-1:store-1', carregarPagina);
  const chamadas = estado.pedidas.length;
  await cache.obter('org-1:store-1', carregarPagina);
  assert.equal(estado.pedidas.length, chamadas, 'servido do cache');
  agora += 61_000;
  await cache.obter('org-1:store-1', carregarPagina);
  assert.ok(estado.pedidas.length > chamadas, 'depois do TTL lê de novo');
});

test('cache: Stores diferentes NUNCA compartilham o cadastro (a chave é a Store)', async () => {
  const cache = criarCacheDoCadastro({ ttlMs: 60_000 });
  const a = await cache.obter('org-1:store-1', async () => ({ customers: [cliente(1)], total_pages: 1 }));
  const b = await cache.obter('org-2:store-2', async () => ({ customers: [cliente(2)], total_pages: 1 }));
  assert.deepEqual(a.clientes.map((c) => c.id), ['1']);
  assert.deepEqual(b.clientes.map((c) => c.id), ['2'], 'a outra Store lê o próprio cadastro');
  await assert.rejects(cache.obter('', async () => ({ customers: [], total_pages: 1 })), /sem chave de Store/);
});

test('cache: duas aberturas ao mesmo tempo compartilham UMA leitura (single-flight)', async () => {
  const { carregarPagina, estado } = inkFalsa({ paginas: 3, atraso: 20 });
  const cache = criarCacheDoCadastro({ ttlMs: 60_000 });
  const [x, y] = await Promise.all([cache.obter('k', carregarPagina), cache.obter('k', carregarPagina)]);
  assert.equal(x, y, 'mesmo resultado');
  assert.equal(estado.pedidas.length, 3, 'as 3 páginas foram lidas uma vez só');
});

test('cache: erro NÃO é guardado — a próxima abertura tenta de novo', async () => {
  const cache = criarCacheDoCadastro({ ttlMs: 60_000 });
  let falhar = true;
  const carregarPagina = async () => {
    if (falhar) throw Object.assign(new Error('Ink fora do ar'), { status: 503 });
    return { customers: [cliente(1)], total_pages: 1 };
  };
  await assert.rejects(cache.obter('k', carregarPagina), /Ink fora do ar/);
  falhar = false;
  const r = await cache.obter('k', carregarPagina);
  assert.equal(r.clientes.length, 1, 'recuperou sem esperar o TTL');
});
