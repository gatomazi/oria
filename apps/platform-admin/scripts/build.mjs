#!/usr/bin/env node
// "Build" do control plane.
//
// O backend é Node puro: não há transpilação, nem bundling, nem passo de geração. O que existe de
// verificável antes de subir é o que este script faz:
//
//   1. cada arquivo do app CARREGA (erro de sintaxe e require quebrado aparecem aqui, não no boot);
//   2. a configuração de produção é REJEITADA quando falta o que tem de faltar (fail-fast do §25);
//   3. se houver frontend publicado em `public/`, ele tem um index.html.
//
// Um "build" que não verifica nada é um passo de CI que sempre passa — e isso é indistinguível de
// não ter passo nenhum.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const modulos = [
  'server.js',
  'lib/config.js', 'lib/urls.js', 'lib/db.js', 'lib/http.js', 'lib/sessions.js', 'lib/rate-limit.js',
  'lib/password.js', 'lib/entitlements.js', 'lib/audit.js', 'lib/readmodels.js',
  'lib/admins.js', 'lib/plans.js', 'lib/organizations.js', 'lib/app.js',
];

let falhas = 0;
for (const m of modulos) {
  try {
    require(path.join(RAIZ, m));
  } catch (err) {
    console.error(`[build] ${m} não carrega: ${err.message}`);
    falhas += 1;
  }
}

const { resolverConfig } = require(path.join(RAIZ, 'lib/config.js'));
const casos = [
  ['produção sem DATABASE_URL', { NODE_ENV: 'production' }],
  ['produção sem segredo', { NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y' }],
  ['segredo curto', { DATABASE_URL: 'postgres://x/y', PLATFORM_ADMIN_SESSION_SECRET: 'curto' }],
  ['SECOND_TENANT_ENABLED inválido', { DATABASE_URL: 'postgres://x/y', SECOND_TENANT_ENABLED: 'talvez' }],
  ['produção sem PLATFORM_ADMIN_URL', {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y',
    PLATFORM_ADMIN_SESSION_SECRET: 'x'.repeat(40),
  }],
  ['PLATFORM_ADMIN_URL com path', {
    DATABASE_URL: 'postgres://x/y', PLATFORM_ADMIN_URL: 'https://admin.oria.com.br/painel',
  }],
  ['PLATFORM_ADMIN_URL com credencial', {
    DATABASE_URL: 'postgres://x/y', PLATFORM_ADMIN_URL: 'https://u:p@admin.oria.com.br',
  }],
  ['produção com PLATFORM_ADMIN_URL http', {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y',
    PLATFORM_ADMIN_SESSION_SECRET: 'x'.repeat(40), PLATFORM_ADMIN_URL: 'http://admin.oria.com.br',
  }],
];
for (const [nome, env] of casos) {
  let subiu = false;
  try { resolverConfig(env, { avisar: () => {} }); subiu = true; } catch { /* esperado */ }
  if (subiu) {
    console.error(`[build] fail-fast quebrado: "${nome}" deveria ser recusado e não foi`);
    falhas += 1;
  }
}

const publico = path.join(RAIZ, 'public');
if (fs.existsSync(publico) && !fs.existsSync(path.join(publico, 'index.html'))) {
  console.error('[build] public/ existe mas não tem index.html');
  falhas += 1;
}

if (falhas) { console.error(`[build] ${falhas} problema(s)`); process.exit(1); }
console.log(`[build] ok — ${modulos.length} módulos carregam, fail-fast confere`);
