#!/usr/bin/env node
// Gera o hash scrypt de uma senha, para AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH (OPS-18).
// A senha é lida do stdin — nunca de argumento de linha de comando (fica no histórico do shell).
//   node scripts/auth/hash-password.mjs < arquivo-com-a-senha
//   printf '%s' "$SENHA" | node scripts/auth/hash-password.mjs
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gerarHash } = require('../../lib/auth/password.js');

let entrada = '';
process.stdin.setEncoding('utf8');
for await (const pedaco of process.stdin) entrada += pedaco;
const senha = entrada.replace(/\r?\n$/, '');
try {
  console.log(await gerarHash(senha));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
