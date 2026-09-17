'use strict';

// Base descartável "como produção" para o ensaio do Tenant #1 (Fase 6).
//
//   schema até a migration 6 → dado nas três lojas legadas (55 tabelas) → credenciais nas colunas
//   antigas, cifradas com a chave derivada de ADMIN_SESSION_SECRET → demais migrations com o
//   mapeamento do cenário → role da aplicação provisionada.
//
// Cada chamada cria um banco NOVO e independente. Nenhum valor aqui é real.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const h = require('../invariants/harness');
const { semearBaseLegada, MIGRATIONS_PRE_TENANCY } = require('./tenancy-legado');
const { limparCache } = require('./linhas');
const { sqlProvisionarAppRole } = require('../../lib/platform/app-role.js');
const manifesto = require('../../lib/platform/tenancy-manifest.js');
const { SEGREDOS } = require('../../lib/platform/integrations.js');
const senhas = require('../../lib/auth/password.js');

const FIXTURES = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenant1');
const ARQUIVO = { A: path.join(FIXTURES, 'cenario-a.json'), B: path.join(FIXTURES, 'cenario-b.json') };
const MAPEAMENTO = {
  A: path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json'),
  B: path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-b.json'),
};
const LOJAS = ['sul', 'centro', 'norte'];

function cifrarLegado(segredoSessao, texto, contexto) {
  const k = Buffer.from(crypto.hkdfSync('sha256', segredoSessao, '', contexto, 32));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

// Valores de teste gerados por execução: o teste confere que NENHUM deles aparece na saída.
function segredosDoEnsaio() {
  const r = (p) => `${p}-${crypto.randomBytes(12).toString('hex')}`;
  return {
    sessao: crypto.randomBytes(32).toString('base64url'),
    mestra: crypto.randomBytes(32).toString('base64'),
    meta: r('EAAGmeta'),
    openai: r('sk-openai'),
    ga4: Object.fromEntries(LOJAS.map((l) => [l, r(`1//ga4-${l}`)])),
    ink: Object.fromEntries(LOJAS.map((l) => [l, { token: r(`ink-${l}`), feed: `https://feed.reserva.ink/${l}-${crypto.randomBytes(6).toString('hex')}`, webhook: r(`whsec-${l}`) }])),
    whatsappToken: r('EAAGzap'),
    senhaAdmin: r('senha-admin'),
  };
}

// `migrations`: total de migrations a aplicar (ex.: 17 = schema publicado pela RELEASE B); sem ele, todas.
async function montarBase(t, cenario, s, { migrations = null } = {}) {
  const db = await h.criarBancoDescartavel(`oria_t1${cenario.toLowerCase()}`);
  t.after(() => db.destruir());
  let r = h.migrar(db.url, { posicionais: [String(MIGRATIONS_PRE_TENANCY)] });
  if (r.status !== 0) throw new Error(`pré-tenancy falhou:\n${r.stdout}${r.stderr}`);
  const sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  t.after(() => sup.end());
  limparCache();
  await semearBaseLegada(sup);
  // O seed genérico cria integrações por escopo com segredo de brinquedo; produção não as tem.
  await sup.query('DELETE FROM integration_secrets');
  await sup.query('DELETE FROM integrations');
  await sup.query('UPDATE meta_connections SET access_token_encrypted = $1', [cifrarLegado(s.sessao, s.meta, SEGREDOS.meta.access_token)]);
  await sup.query('UPDATE creative_settings SET openai_key_enc = $1', [cifrarLegado(s.sessao, s.openai, SEGREDOS.openai.api_key)]);
  for (const l of LOJAS) {
    await sup.query('UPDATE google_analytics_connections SET refresh_token_encrypted = $1 WHERE loja = $2',
      [cifrarLegado(s.sessao, s.ga4[l], SEGREDOS.ga4.refresh_token), l]);
  }
  // `migrations === MIGRATIONS_PRE_TENANCY`: a base fica como a produção antes da Fase 1 (quem migra é o
  // pre-deploy do teste).
  if (migrations === MIGRATIONS_PRE_TENANCY) return { db, sup };
  r = h.migrar(db.url, {
    posicionais: migrations ? [String(migrations - MIGRATIONS_PRE_TENANCY)] : [],
    env: { TENANCY_MAPPING_FILE: MAPEAMENTO[cenario] },
  });
  if (r.status !== 0) throw new Error(`migrations com mapeamento ${cenario} falharam:\n${r.stdout.slice(-3000)}${r.stderr}`);
  limparCache();
  return { db, sup };
}

// Role da aplicação exclusiva do arquivo de teste (objeto do cluster: sai no fim).
function roleDoEnsaio(t, prefixo) {
  const role = `${prefixo}_${crypto.randomBytes(4).toString('hex')}`;
  const senha = crypto.randomBytes(16).toString('hex');
  const bancos = [];
  t.after(async () => {
    for (const url of bancos) {
      const p = h.abrirPoolDescartavel(url, { max: 1 });
      try { await p.query(`DROP OWNED BY ${role}`); } catch { /* banco já destruído */ } finally { await p.end(); }
    }
    const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
    try { await admin.query(`DROP ROLE IF EXISTS ${role}`); } finally { await admin.end(); }
  });
  return {
    role,
    senha,
    async provisionar(sup, url) {
      bancos.push(url);
      for (const sql of sqlProvisionarAppRole({ role, senha, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
    },
  };
}

function diretorioTemporario(t, prefixo) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Uploads com arquivos do Creative Core ainda na pasta legada.
function uploadsLegados(t) {
  const dir = diretorioTemporario(t, 'oria-t1-up-');
  const legado = path.join(dir, 'creatives', 'tenant', 'default', 'assets');
  fs.mkdirSync(legado, { recursive: true });
  fs.writeFileSync(path.join(legado, 'arte.png'), 'png-de-teste');
  return dir;
}

async function ambiente(cenario, s, { url, extra = {} } = {}) {
  const env = {
    PATH: process.env.PATH,
    DATABASE_URL: url,
    ENCRYPTION_MASTER_KEY: s.mestra,
    ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1',
    ADMIN_SESSION_SECRET: s.sessao,
    WHATSAPP_LEGACY_PHONE_NUMBER_ID: cenario === 'A' ? '5511900000001' : '5511900000009',
    WHATSAPP_LEGACY_WABA_ID: cenario === 'A' ? '1200000000001' : '1200000000009',
    WHATSAPP_LEGACY_ACCESS_TOKEN: s.whatsappToken,
    WHATSAPP_LEGACY_REPLY_REDIRECT_NUMBER: '5511988887777',
    ...extra,
  };
  for (const l of LOJAS) {
    env[`INK_TOKEN_${l.toUpperCase()}`] = s.ink[l].token;
    env[`INK_FEED_URL_${l.toUpperCase()}`] = s.ink[l].feed;
    env[`INK_WEBHOOK_SECRET_${l.toUpperCase()}`] = s.ink[l].webhook;
  }
  const hash = await senhas.gerarHash('senha-forte-do-ensaio-123');
  for (const nome of ['TENANT1_OWNER_SUL_HASH', 'TENANT1_OWNER_CENTRO_HASH', 'TENANT1_OWNER_NORTE_HASH', 'TENANT1_OWNER_HASH']) env[nome] = hash;
  return env;
}

let cli;
async function executar(comando, args, env) {
  cli = cli || await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'cli.mjs')));
  return cli.executar(comando, args, { env, escrever: () => {} });
}

async function modulo(nome) {
  return import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', nome)));
}

// Todo valor sensível do ensaio, para conferir que nenhum aparece na saída.
function valoresProibidos(s, env) {
  return [
    s.sessao, s.mestra, s.meta, s.openai, s.whatsappToken, s.senhaAdmin, env.TENANT1_OWNER_HASH, env.TENANT1_OWNER_SUL_HASH,
    ...Object.values(s.ga4),
    ...Object.values(s.ink).flatMap((x) => [x.token, x.feed, x.webhook]),
    new URL(env.DATABASE_URL).password,
  ].filter(Boolean);
}

const itensDe = (linhas) => linhas
  .map((l) => /^(PASS|FAIL|PEND|INFO) (\S+)/.exec(l))
  .filter(Boolean)
  .map((m) => ({ status: m[1], id: m[2] }));

module.exports = {
  ARQUIVO, MAPEAMENTO, LOJAS, MIGRATIONS_PRE_TENANCY,
  cifrarLegado, segredosDoEnsaio, montarBase, roleDoEnsaio, diretorioTemporario, uploadsLegados,
  ambiente, executar, modulo, valoresProibidos, itensDe,
};
