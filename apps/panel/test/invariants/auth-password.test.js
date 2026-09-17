'use strict';

// Hash de senha (lib/auth/password.js): scrypt com salt e parâmetros gravados no próprio hash.

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');

test('senha · hash scrypt com salt, parâmetros no formato e nada da senha em claro', async () => {
  const a = await senhas.gerarHash('uma senha longa o bastante');
  const b = await senhas.gerarHash('uma senha longa o bastante');
  assert.match(a, /^scrypt\$1\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  assert.notEqual(a, b, 'salt aleatório: a mesma senha gera hashes diferentes');
  assert.ok(!a.includes('senha'));
});

test('senha · confere a certa, recusa a errada, a vazia, a enorme e hash corrompido', async () => {
  const hash = await senhas.gerarHash('senha-certa-123456');
  assert.equal(await senhas.verificarSenha('senha-certa-123456', hash), true);
  assert.equal(await senhas.verificarSenha('senha-certa-123457', hash), false);
  assert.equal(await senhas.verificarSenha('', hash), false);
  assert.equal(await senhas.verificarSenha('x'.repeat(201), hash), false);
  assert.equal(await senhas.verificarSenha('senha-certa-123456', 'texto-claro'), false);
  // Corrompe um caractere do MEIO do hash: no último, a troca pode cair só nos bits de enchimento do
  // base64 e decodificar para os mesmos bytes (o teste passava ou falhava ao acaso).
  const i = hash.length - 10;
  const corrompido = hash.slice(0, i) + (hash[i] === 'A' ? 'B' : 'A') + hash.slice(i + 1);
  assert.notEqual(Buffer.from(corrompido.split('$').pop(), 'base64').toString('hex'), Buffer.from(hash.split('$').pop(), 'base64').toString('hex'));
  assert.equal(await senhas.verificarSenha('senha-certa-123456', corrompido), false);
});

test('senha · política mínima e rehash quando os parâmetros ficam abaixo do atual', async () => {
  await assert.rejects(senhas.gerarHash('curta'), senhas.SenhaInvalidaError);
  await assert.rejects(senhas.gerarHash('x'.repeat(201)), senhas.SenhaInvalidaError);
  const hash = await senhas.gerarHash('senha-certa-123456');
  assert.equal(senhas.precisaRehash(hash), false);
  assert.equal(senhas.precisaRehash(hash.replace('$32768$', '$16384$')), true);
  assert.equal(senhas.precisaRehash('bcrypt$qualquer'), true);
});
