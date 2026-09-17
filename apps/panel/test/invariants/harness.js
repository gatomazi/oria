'use strict';

// Harness dos invariants (Fase 0).
//
// ── Por que este arquivo é o entregável mais importante da fase ─────────────────────────────────
// Todo o plano de productização repousa em "a fase fecha quando os invariants passam". Mas os
// invariants são eles próprios um entregável, e chegam antes de terem sido exercitados. Um harness
// escrito sob pressão tende a ser escrito PARA PASSAR, não para detectar — e o sintoma disso é
// silêncio, que é indistinguível de sucesso.
//
// A mitigação é o ciclo de 5 passos do plano, e ele só funciona se o invariant puder ser rodado
// contra uma cópia DEFEITUOSA do código-fonte. Daí `INVARIANT_SUBJECT_ROOT`: os invariants nunca
// fazem `require('../../lib/...')` direto. Eles pedem o sujeito ao harness, que resolve a partir da
// raiz apontada por essa variável. O negative control copia `lib/`, introduz o defeito histórico
// no arquivo real, aponta a variável para a cópia e exige que o MESMO teste reprove.
//
// O que isso compra: um invariant que não detecta nada não sobrevive ao negative control. Ele
// reprova na hora em que é escrito, não seis meses depois, quando alguém reintroduzir o defeito.

const path = require('node:path');
const { Pool } = require('pg');

const RAIZ_REPO = path.resolve(__dirname, '..', '..');
const RAIZ_SUJEITO = process.env.INVARIANT_SUBJECT_ROOT
  ? path.resolve(process.env.INVARIANT_SUBJECT_ROOT)
  : RAIZ_REPO;

// Carrega o módulo SOB TESTE. Sempre por aqui — nunca `require` relativo.
function sujeito(caminhoRelativo) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(RAIZ_SUJEITO, caminhoRelativo));
}

function rodandoContraCopia() {
  return RAIZ_SUJEITO !== RAIZ_REPO;
}

// ── Postgres ───────────────────────────────────────────────────────────────────────────────────
// Sem banco, este harness NÃO se pula. Pular é o modo de falha que a Fase 0 existe para acabar:
// até 8a7ea3d havia 6 testes que se auto-pulavam por falta de `*_TEST_DATABASE_URL`, incluindo o
// único teste de isolamento por tenant do repositório. Um teste pulado é verde na saída do CI.
function urlDoBanco() {
  const url = process.env.INVARIANTS_DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'INVARIANTS_DATABASE_URL não definida. Os invariants exigem Postgres real e NÃO se pulam ' +
      '(é o ponto da Fase 0). Rode `npm run test:pg` — ele sobe um Postgres efêmero, aplica todas ' +
      'as migrations do zero e exporta as variáveis.'
    );
  }
  return url;
}

function abrirPool() {
  return new Pool({ connectionString: urlDoBanco(), max: 4 });
}

// Pool para um banco que o próprio teste cria e derruba com `DROP DATABASE ... WITH (FORCE)`.
// Uma conexão ociosa ainda aberta recebe 57P01 (admin_shutdown) nessa hora; sem listener, o pool
// transforma isso em uncaughtException e o teste reprova pelo teardown, não pelo que mede.
function abrirPoolDescartavel(connectionString, opcoes = {}) {
  const pool = new Pool({ connectionString, ...opcoes });
  pool.on('error', (err) => { if (err.code !== '57P01') throw err; });
  return pool;
}

// ── Banco descartável, migrado pela CLI real ───────────────────────────────────────────────────
const CLI_MIGRATE = path.join(RAIZ_REPO, 'node_modules', 'node-pg-migrate', 'bin', 'node-pg-migrate.js');

// `posicionais` depois do comando (`up 6`): a CLI 9.0.0 ignora `--count` em silêncio.
function migrar(url, { comando = 'up', posicionais = [], env = {} } = {}) {
  // eslint-disable-next-line global-require
  const { spawnSync } = require('node:child_process');
  return spawnSync(
    process.execPath,
    [CLI_MIGRATE, '--migrations-dir', path.join(RAIZ_REPO, 'migrations'),
      '--ignore-pattern', '(README\\.md|sql|sql/.*)', comando, ...posicionais],
    { cwd: RAIZ_REPO, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, ...env }, timeout: 180000 }
  );
}

async function criarBancoDescartavel(prefixo = 'oria_tmp') {
  // eslint-disable-next-line global-require
  const crypto = require('node:crypto');
  const base = urlDoBanco();
  const nome = `${prefixo}_${crypto.randomBytes(5).toString('hex')}`;
  const admin = abrirPoolDescartavel(base.replace(/\/[^/]+$/, '/postgres'), { max: 1 });
  await admin.query(`CREATE DATABASE ${nome}`);
  const url = base.replace(/\/[^/]+$/, `/${nome}`);
  return {
    nome,
    url,
    async destruir() {
      await admin.query(`DROP DATABASE IF EXISTS ${nome} WITH (FORCE)`);
      await admin.end();
    },
  };
}

// URL da mesma instância com outro usuário.
function urlComUsuario(url, usuario, senha) {
  const u = new URL(url);
  u.username = usuario;
  u.password = senha;
  return u.toString();
}

// ── Fixtures de tenancy ────────────────────────────────────────────────────────────────────────
// `organizations` é da FASE 1 e não existe ainda. Estas tabelas são scaffolding de teste, com
// prefixo `harness_` justamente para nunca serem confundidas com o schema real nem migrar para
// produção por descuido.
const DDL_FIXTURES = `
  CREATE TABLE IF NOT EXISTS harness_organizations (
    id UUID PRIMARY KEY,
    nome TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS harness_recursos (
    id TEXT PRIMARY KEY,
    organization_id UUID NULL REFERENCES harness_organizations (id),
    valor NUMERIC NOT NULL DEFAULT 0
  );
`;

async function prepararFixtures(pool) {
  await pool.query(DDL_FIXTURES);
  await pool.query('DELETE FROM harness_recursos');
  await pool.query('DELETE FROM harness_organizations');
}

// Semeia EXATAMENTE `quantas` organizations.
//
// O default é 1, e isso não é economia de digitação: é o teste decisivo do INV-09. Um banco com
// três lojas — que é a forma do banco de produção — NUNCA pega `lojaAtribuidaPadrao()`, porque com
// três candidatos o fallback "se só há um, use-o" devolve null e parece correto. Testar contra a
// forma errada de dados é como não testar.
async function semearOrganizations(pool, quantas = 1) {
  const ids = [];
  for (let i = 0; i < quantas; i += 1) {
    const { rows } = await pool.query(
      'INSERT INTO harness_organizations (id, nome) VALUES (gen_random_uuid(), $1) RETURNING id',
      [`Org ${String.fromCharCode(65 + i)}`]
    );
    ids.push(rows[0].id);
  }
  return ids;
}

async function semearRecurso(pool, { id, organizationId = null, valor = 0 }) {
  await pool.query(
    'INSERT INTO harness_recursos (id, organization_id, valor) VALUES ($1,$2,$3)',
    [id, organizationId, valor]
  );
  return id;
}

// ── Integração + segredo, para os invariants de secrets ────────────────────────────────────────
async function semearIntegracao(pool, { provider, escopo = null, organizationId = null }) {
  const { rows } = await pool.query(
    `INSERT INTO integrations (organization_id, provider, escopo, status)
     VALUES ($1,$2,$3,'connected') RETURNING id`,
    [organizationId, provider, escopo]
  );
  return rows[0].id;
}

async function limparIntegracoes(pool) {
  await pool.query('DELETE FROM integration_secrets');
  await pool.query('DELETE FROM integrations');
}

// Chave mestra determinística por teste — CSPRNG, nunca `Math.random`, e nunca reutilizada entre
// arquivos de teste.
function chaveMestraDeTeste(semente = 'a') {
  return Buffer.alloc(32, semente).toString('base64');
}

module.exports = {
  RAIZ_REPO,
  RAIZ_SUJEITO,
  sujeito,
  rodandoContraCopia,
  abrirPool,
  abrirPoolDescartavel,
  migrar,
  criarBancoDescartavel,
  urlComUsuario,
  urlDoBanco,
  prepararFixtures,
  semearOrganizations,
  semearRecurso,
  semearIntegracao,
  limparIntegracoes,
  chaveMestraDeTeste,
};
