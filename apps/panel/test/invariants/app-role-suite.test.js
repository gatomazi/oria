'use strict';

// Suíte sob oria_app (rodada 18, §36; critério do OPS-14 no plano: "a suíte inteira verde sob
// oria_app").
//
// `npm run test:app-role` roda a suíte inteira com TEST_APP_ROLE=1: DATABASE_URL, TEST_DATABASE_URL
// e CREATIVE_TEST_DATABASE_URL são da role oria_app e DB_ENFORCE_APP_ROLE=1 (scripts/test-db.mjs).
// Este arquivo garante que o modo não mente:
//   - nas duas execuções: a checagem de privilégio distingue a dona da role da aplicação (controle
//     negativo da própria checagem) e a lista de testes que usam URL dona é FECHADA;
//   - com TEST_APP_ROLE=1: as URLs entregues ao código da aplicação são mesmo sem privilégio.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');

// Testes de schema/SQL copiado que continuam com a dona também no modo app-role. Criam tabela ou
// banco próprios e rodam SQL sem contexto de tenant; não carregam código de request. Arquivo novo
// que precise da URL dona entra aqui por decisão explícita — nunca por acaso.
const ARQUIVOS_SQL_DE_FIXTURE_DONOS = Object.freeze([
  'test/custos-api-sql.test.js',
  'test/google-ads-midia-sql.test.js',
  'test/google-ads-schema.test.js',
  'test/meta-schema.test.js',
  'test/recuperacao-fila.test.js',
]);

const VARIAVEIS_DONAS = /\b(META_TEST_DATABASE_URL|GOOGLE_ADS_TEST_DATABASE_URL)\b/;
// Código da aplicação que usa banco. Um teste dono que carregue isto estaria rodando código de
// request fora da role da aplicação.
const MODULOS_COM_BANCO = /require\(['"]\.\.\/(server|lib\/(platform|auth|secrets|creative-core|integrations|campanhas|jobs)\b)/;

async function privilegios(url) {
  const pool = h.abrirPoolDescartavel(url, { max: 1 });
  try {
    const { rows: [r] } = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    return { privilegiada: r.rolsuper || r.rolbypassrls };
  } finally {
    await pool.end();
  }
}

test('app-role · a checagem de privilégio distingue a dona da role da aplicação', async () => {
  assert.equal((await privilegios(h.urlDoBanco())).privilegiada, true, 'a URL dona precisa ser detectada como privilegiada');
  assert.ok(process.env.INVARIANTS_APP_DATABASE_URL, 'INVARIANTS_APP_DATABASE_URL ausente — rode pelo scripts/test-db.mjs');
  assert.equal((await privilegios(process.env.INVARIANTS_APP_DATABASE_URL)).privilegiada, false);
});

test('app-role · só os arquivos declarados usam as URLs donas de fixture SQL', () => {
  const raiz = h.RAIZ_REPO;
  const arquivos = [
    ...fs.readdirSync(path.join(raiz, 'test')).filter((x) => x.endsWith('.js')).map((x) => `test/${x}`),
    ...fs.readdirSync(path.join(raiz, 'test', 'helpers')).filter((x) => /\.c?js$/.test(x)).map((x) => `test/helpers/${x}`),
  ];
  const usam = arquivos.filter((a) => VARIAVEIS_DONAS.test(fs.readFileSync(path.join(raiz, a), 'utf8'))).sort();
  assert.deepEqual(usam, [...ARQUIVOS_SQL_DE_FIXTURE_DONOS].sort());
  for (const a of ARQUIVOS_SQL_DE_FIXTURE_DONOS) {
    assert.doesNotMatch(fs.readFileSync(path.join(raiz, a), 'utf8'), MODULOS_COM_BANCO, `${a} carrega código da aplicação com banco`);
  }
});

test('app-role · controle negativo da lista: arquivo novo com URL dona reprova', () => {
  const texto = "const URL = process.env.META_TEST_DATABASE_URL;\nconst x = require('../lib/platform/integrations');";
  assert.ok(VARIAVEIS_DONAS.test(texto));
  assert.ok(MODULOS_COM_BANCO.test(texto));
});

test('app-role · com TEST_APP_ROLE=1, o código da aplicação conecta sem privilégio', async () => {
  if (process.env.TEST_APP_ROLE !== '1') {
    // Execução padrão (npm test): as URLs da aplicação são a dona, e isso é declarado aqui.
    assert.equal((await privilegios(process.env.DATABASE_URL)).privilegiada, true);
    return;
  }
  assert.equal(process.env.DB_ENFORCE_APP_ROLE, '1');
  for (const nome of ['DATABASE_URL', 'TEST_DATABASE_URL', 'CREATIVE_TEST_DATABASE_URL']) {
    assert.ok(process.env[nome], `${nome} ausente`);
    assert.equal((await privilegios(process.env[nome])).privilegiada, false, `${nome} conecta com privilégio no modo app-role`);
  }
  assert.ok(process.env.TEST_OWNER_DATABASE_URL, 'TEST_OWNER_DATABASE_URL ausente');
  assert.equal((await privilegios(process.env.TEST_OWNER_DATABASE_URL)).privilegiada, true);
});
