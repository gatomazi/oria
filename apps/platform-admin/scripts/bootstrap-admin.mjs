#!/usr/bin/env node
// Bootstrap do PRIMEIRO platform admin (§8).
//
//   PLATFORM_ADMIN_EMAIL=... PLATFORM_ADMIN_PASSWORD=... npm run platform-admin:bootstrap
//
// Regras, sem exceção:
//   · sem as duas variáveis, RECUSA e explica — não inventa credencial, não usa senha padrão;
//   · IDEMPOTENTE: rodar de novo com o mesmo e-mail não troca a senha e não duplica;
//   · NUNCA imprime a senha, nem em mensagem de erro, nem em trace;
//   · o primeiro admin nasce `platform_owner` (senão não haveria quem criasse os outros);
//   · o segundo em diante nasce `platform_operator`, salvo PLATFORM_ADMIN_ROLE explícito.
//
// Este script não é chamado no boot. O app sobe sem nenhum admin; o que fica indisponível é o
// login, não o processo.

import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { criarPool, verificarBanco } = require('../lib/db.js');
const { gerarHash, validarSenhaNova, SenhaInvalidaError } = require('../lib/password.js');

const PAPEIS = ['platform_owner', 'platform_operator'];

function falhar(mensagem) {
  // Nada de `process.env` no texto: a senha nunca entra em log.
  console.error(`[bootstrap] ${mensagem}`);
  process.exit(1);
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  const email = String(process.env.PLATFORM_ADMIN_EMAIL || '').trim().toLowerCase();
  const senha = typeof process.env.PLATFORM_ADMIN_PASSWORD === 'string' ? process.env.PLATFORM_ADMIN_PASSWORD : '';
  const nome = String(process.env.PLATFORM_ADMIN_NAME || '').trim() || null;
  const papelPedido = String(process.env.PLATFORM_ADMIN_ROLE || '').trim() || null;

  if (!databaseUrl) falhar('DATABASE_URL ausente');
  if (!email) {
    falhar('PLATFORM_ADMIN_EMAIL ausente. Informe o e-mail do primeiro platform admin — este script não inventa credencial.');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) falhar('PLATFORM_ADMIN_EMAIL inválido');
  if (!senha) {
    falhar('PLATFORM_ADMIN_PASSWORD ausente. Informe a senha — não existe senha padrão neste projeto.');
  }
  if (papelPedido && !PAPEIS.includes(papelPedido)) {
    falhar(`PLATFORM_ADMIN_ROLE inválido: use ${PAPEIS.join(' ou ')}`);
  }
  try {
    validarSenhaNova(senha);
  } catch (err) {
    if (err instanceof SenhaInvalidaError) falhar(`senha recusada: ${err.message}`);
    throw err;
  }

  const pool = criarPool(databaseUrl, { max: 2 });
  try {
    await verificarBanco(pool);

    const { rows: existentes } = await pool.query(
      'SELECT id, papel, status FROM platform_admins WHERE email = $1', [email]
    );
    if (existentes.length) {
      // Idempotente: não troca a senha (trocar senha é outra operação, deliberada), não duplica.
      console.log(`[bootstrap] já existe um platform admin com este e-mail (papel=${existentes[0].papel}, status=${existentes[0].status}). Nada a fazer.`);
      return 0;
    }

    const { rows: [{ n }] } = await pool.query('SELECT platform_admin_owners_ativos() AS n');
    const papel = papelPedido || (n === 0 ? 'platform_owner' : 'platform_operator');

    const hash = await gerarHash(senha);
    const { rows: [novo] } = await pool.query(
      `INSERT INTO platform_admins (email, nome, password_hash, papel) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, papel`,
      [email, nome, hash, papel]
    );
    if (!novo) {
      // Corrida com outro bootstrap: o outro ganhou, e isso é sucesso, não erro.
      console.log('[bootstrap] outro processo criou este admin primeiro. Nada a fazer.');
      return 0;
    }
    console.log(`[bootstrap] platform admin criado: ${novo.email} (papel=${novo.papel}). A senha não é exibida.`);
    return 0;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    // Mensagem do erro, nunca o objeto inteiro (que poderia carregar parâmetros de query).
    console.error(`[bootstrap] falhou: ${err && err.message ? err.message : 'erro desconhecido'}`);
    process.exit(1);
  }
);
