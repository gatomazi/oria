'use strict';

// Hash de senha por usuário (Fase 2). scrypt do próprio Node: sem dependência nativa nova, com
// salt aleatório por senha e parâmetros gravados junto do hash — para poder endurecê-los depois
// sem invalidar o que já existe (`precisaRehash`).
//
// Formato: scrypt$1$<N>$<r>$<p>$<salt base64url>$<hash base64url>

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// N = 2^15, r = 8, p = 1 — o piso recomendado pela OWASP para scrypt. ~32 MB por verificação.
const PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keylen: 64, saltBytes: 16 });
const MAXMEM = 128 * PARAMS.N * PARAMS.r * 2;
const TAMANHO_MINIMO = 12;
const TAMANHO_MAXIMO = 200;

class SenhaInvalidaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SenhaInvalidaError';
  }
}

function validarSenhaNova(senha) {
  if (typeof senha !== 'string') throw new SenhaInvalidaError('senha precisa ser texto');
  if (senha.length < TAMANHO_MINIMO) throw new SenhaInvalidaError(`senha precisa ter ao menos ${TAMANHO_MINIMO} caracteres`);
  if (senha.length > TAMANHO_MAXIMO) throw new SenhaInvalidaError(`senha pode ter no máximo ${TAMANHO_MAXIMO} caracteres`);
}

async function gerarHash(senha) {
  validarSenhaNova(senha);
  const salt = crypto.randomBytes(PARAMS.saltBytes);
  const derivada = await scrypt(senha, salt, PARAMS.keylen, { N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: MAXMEM });
  return ['scrypt', '1', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), derivada.toString('base64url')].join('$');
}

function lerHash(armazenado) {
  const partes = String(armazenado || '').split('$');
  if (partes.length !== 7 || partes[0] !== 'scrypt' || partes[1] !== '1') return null;
  const [N, r, p] = partes.slice(2, 5).map(Number);
  if (![N, r, p].every(Number.isInteger)) return null;
  const salt = Buffer.from(partes[5], 'base64url');
  const hash = Buffer.from(partes[6], 'base64url');
  if (!salt.length || !hash.length) return null;
  return { N, r, p, salt, hash };
}

// Hash de referência para quando o usuário não existe: a verificação custa o mesmo tempo, e a
// resposta não revela se o e-mail está cadastrado.
let hashFalso = null;
async function hashDeReferencia() {
  if (!hashFalso) hashFalso = await gerarHash(crypto.randomBytes(24).toString('base64url'));
  return hashFalso;
}

async function verificarSenha(senha, armazenado) {
  if (typeof senha !== 'string' || !senha || senha.length > TAMANHO_MAXIMO) return false;
  const h = lerHash(armazenado);
  if (!h) return false;
  const derivada = await scrypt(senha, h.salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: 128 * h.N * h.r * 2 });
  return derivada.length === h.hash.length && crypto.timingSafeEqual(derivada, h.hash);
}

function precisaRehash(armazenado) {
  const h = lerHash(armazenado);
  return !h || h.N < PARAMS.N || h.r < PARAMS.r || h.p < PARAMS.p;
}

module.exports = {
  PARAMS,
  TAMANHO_MINIMO,
  SenhaInvalidaError,
  validarSenhaNova,
  gerarHash,
  verificarSenha,
  precisaRehash,
  hashDeReferencia,
};
