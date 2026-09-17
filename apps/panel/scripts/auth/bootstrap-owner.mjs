#!/usr/bin/env node
// Cria (ou confirma) o primeiro owner de cada Organization declarada — OPS-18.
//
// Pensado para o Pre-deploy Command, DEPOIS das migrations:
//   npm run migrate:up && npm run auth:bootstrap-owner
//
//   AUTH_BOOTSTRAP_OWNER_EMAIL           e-mail do owner
//   AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH   hash scrypt (npm run auth:hash-password) — nunca a senha
//   AUTH_BOOTSTRAP_ORGANIZATION_IDS      lista explícita de Organizations (vírgula). Nada é deduzido.
//   AUTH_BOOTSTRAP_OWNER_NOME            opcional
//
// Sem nenhuma dessas variáveis: não faz nada (exit 0). Com parte delas: erro.
// Idempotente. Usuário existente nunca tem a senha trocada.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function bootstrapOwner(url, env = process.env) {
  const email = String(env.AUTH_BOOTSTRAP_OWNER_EMAIL || '').trim().toLowerCase();
  const hash = String(env.AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH || '').trim();
  const orgs = String(env.AUTH_BOOTSTRAP_ORGANIZATION_IDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const nome = String(env.AUTH_BOOTSTRAP_OWNER_NOME || '').trim() || null;

  if (!email && !hash && !orgs.length) return { feito: false, motivo: 'sem configuração de bootstrap' };
  const faltando = [
    !email && 'AUTH_BOOTSTRAP_OWNER_EMAIL',
    !hash && 'AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH',
    !orgs.length && 'AUTH_BOOTSTRAP_ORGANIZATION_IDS',
  ].filter(Boolean);
  if (faltando.length) throw new Error(`bootstrap de owner incompleto: falta ${faltando.join(', ')}`);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('AUTH_BOOTSTRAP_OWNER_EMAIL inválido');
  if (!hash.startsWith('scrypt$1$')) throw new Error('AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH não é um hash scrypt (use npm run auth:hash-password)');
  const invalidas = orgs.filter((o) => !UUID_RE.test(o));
  if (invalidas.length) throw new Error(`AUTH_BOOTSTRAP_ORGANIZATION_IDS com id inválido: ${invalidas.join(', ')}`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows: existentes } = await client.query('SELECT id FROM organizations WHERE id = ANY($1::uuid[])', [orgs]);
    const achadas = new Set(existentes.map((r) => r.id));
    const ausentes = orgs.filter((o) => !achadas.has(o));
    if (ausentes.length) throw new Error(`Organization inexistente: ${ausentes.join(', ')}`);

    await client.query(
      `INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING`,
      [email, nome, hash]
    );
    const { rows: [u] } = await client.query('SELECT id, status FROM users WHERE email = $1', [email]);
    if (u.status !== 'active') throw new Error(`${email} está desativado — o bootstrap não reativa ninguém`);

    for (const org of orgs) {
      // Contexto da própria Organization: correto também sob RLS forçada.
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
      await client.query(
        `INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')
         ON CONFLICT (organization_id, user_id) DO UPDATE SET papel = 'owner'`,
        [org, u.id]
      );
    }
    await client.query('COMMIT');
    return { feito: true, userId: u.id, organizations: orgs };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente');
    process.exit(2);
  }
  bootstrapOwner(process.env.DATABASE_URL)
    .then((r) => console.log(r.feito
      ? `[AUTH] owner ${r.userId} confirmado em ${r.organizations.length} organization(s)`
      : `[AUTH] bootstrap de owner: ${r.motivo}`))
    .catch((err) => { console.error(`[AUTH] ${err.message}`); process.exit(1); });
}
