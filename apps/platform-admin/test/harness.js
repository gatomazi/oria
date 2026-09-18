'use strict';

// Harness dos testes do control plane.
//
// Duas decisões que mudam o que os testes conseguem provar:
//
//   1. **Um banco por arquivo de teste**, criado com `CREATE DATABASE … TEMPLATE`, a partir do banco
//      que o `scripts/test-db.mjs` já migrou. Barato e isolado. Sem isso, o teste do gate de
//      bootstrap (que exige ZERO Organizations) e o teste de listagem (que exige várias) não podem
//      coexistir na mesma suíte.
//
//   2. **O app é subido de verdade**, em `node:http`, numa porta efêmera, e os testes falam com ele
//      por `fetch` — com cookie e CSRF reais. Chamar os serviços direto provaria a camada de
//      serviço; o que precisa de prova é o CAMINHO COMPLETO (cookie → sessão → CSRF → papel →
//      alvo da rota), porque é nele que os defeitos de autoridade moram.
//
// `INVARIANT_SUBJECT_ROOT` (mesma ideia do harness do painel): os testes não fazem
// `require('../lib/...')` direto — pedem ao harness, que resolve a partir da raiz apontada pela
// variável. É o que permite ao negative control copiar `lib/`, introduzir o defeito e exigir que o
// MESMO teste reprove.

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { Client, Pool } = require('pg');

const RAIZ_REPO = path.resolve(__dirname, '..');
const RAIZ_SUJEITO = process.env.INVARIANT_SUBJECT_ROOT
  ? path.resolve(process.env.INVARIANT_SUBJECT_ROOT)
  : RAIZ_REPO;

const SEGREDO_DE_TESTE = 'segredo-de-teste-com-mais-de-trinta-e-dois-caracteres';
const SENHA_DE_TESTE = 'senha-de-teste-123';

// Sujeito sob teste: sempre pela raiz, nunca por caminho relativo fixo.
function sujeito(modulo) {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(path.join(RAIZ_SUJEITO, modulo));
}

function urlBase() {
  const url = process.env.ADMIN_TEST_DATABASE_URL;
  if (!url) {
    throw new Error('ADMIN_TEST_DATABASE_URL ausente — rode a suíte por `npm test` (scripts/test-db.mjs)');
  }
  return url;
}

function urlComBanco(base, banco) {
  const u = new URL(base);
  u.pathname = `/${banco}`;
  return u.toString();
}

// Banco descartável a partir do template já migrado.
async function bancoNovo() {
  const base = urlBase();
  const nome = `pa_${crypto.randomBytes(6).toString('hex')}`;
  const template = new URL(base).pathname.replace(/^\//, '');
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    // O template precisa estar sem conexões ativas; o pool do teste anterior já foi fechado.
    await admin.query(`CREATE DATABASE ${nome} TEMPLATE ${template}`);
  } finally {
    await admin.end();
  }
  const url = urlComBanco(base, nome);
  return {
    url,
    nome,
    async destruir() {
      const c = new Client({ connectionString: base });
      await c.connect();
      try {
        await c.query(
          'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
          [nome]
        );
        await c.query(`DROP DATABASE IF EXISTS ${nome}`);
      } finally {
        await c.end();
      }
    },
  };
}

// Sobe o app inteiro contra o banco dado. Devolve um cliente HTTP com jarra de cookie.
// `env.PLATFORM_ADMIN_URL`, quando presente, também vira a Origin padrão do cliente de teste — é
// assim que um browser em `admin.oria.com.br` se comporta, e é o que a validação de origem espera.
async function subirApp(url, env = {}) {
  const { resolverConfig } = sujeito('lib/config.js');
  const { criarPool } = sujeito('lib/db.js');
  const { montar } = sujeito('server.js');

  const config = resolverConfig({
    DATABASE_URL: url,
    PLATFORM_ADMIN_SESSION_SECRET: SEGREDO_DE_TESTE,
    ...env,
  }, { avisar: () => {} });

  const pool = criarPool(url, { max: 5 });
  const montado = montar({ config, pool });
  const servidor = http.createServer(montado.handler);
  await new Promise((resolve) => servidor.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  return {
    base,
    pool,
    config,
    ...montado,
    cliente: criarCliente(base, env.PLATFORM_ADMIN_URL || null),
    async fechar() {
      await new Promise((resolve) => servidor.close(resolve));
      await pool.end().catch(() => {});
    },
  };
}

// Cliente HTTP com jarra de cookie e token CSRF — do jeito que um browser faria.
function criarCliente(base, origemPadrao = null) {
  let cookie = null;
  let csrf = null;

  async function pedir(metodo, caminho, corpo, opcoes = {}) {
    const headers = {};
    if (cookie && !opcoes.semCookie) headers.Cookie = cookie;
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    const precisaCsrf = !['GET', 'HEAD', 'OPTIONS'].includes(metodo);
    if (precisaCsrf && csrf && !opcoes.semCsrf) headers['X-CSRF-Token'] = opcoes.csrf || csrf;
    if (opcoes.csrf) headers['X-CSRF-Token'] = opcoes.csrf;
    if (origemPadrao && !opcoes.semOrigem) headers.Origin = origemPadrao;
    Object.assign(headers, opcoes.headers || {});

    const res = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: corpo === undefined ? undefined : (opcoes.corpoCru ?? JSON.stringify(corpo)),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    if (texto) { try { json = JSON.parse(texto); } catch { json = null; } }
    return { status: res.status, headers: res.headers, corpo: json, texto };
  }

  return {
    get: (c, o) => pedir('GET', c, undefined, o),
    post: (c, b, o) => pedir('POST', c, b ?? {}, o),
    put: (c, b, o) => pedir('PUT', c, b ?? {}, o),
    patch: (c, b, o) => pedir('PATCH', c, b ?? {}, o),
    delete: (c, b, o) => pedir('DELETE', c, b ?? {}, o),
    async login(email, senha = SENHA_DE_TESTE) {
      const r = await pedir('POST', '/api/platform/auth/login', { email, senha });
      if (r.status === 200) csrf = r.corpo.csrfToken;
      return r;
    },
    get csrf() { return csrf; },
    set csrf(v) { csrf = v; },
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    limpar() { cookie = null; csrf = null; },
  };
}

// Cria um platform admin direto no banco (o caminho de bootstrap tem teste próprio).
async function criarAdmin(pool, { email, papel = 'platform_owner', senha = SENHA_DE_TESTE, status = 'active' }) {
  const { gerarHash } = sujeito('lib/password.js');
  const { rows } = await pool.query(
    `INSERT INTO platform_admins (email, nome, password_hash, papel, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, email, papel, status`,
    [email, email.split('@')[0], await gerarHash(senha), papel, status]
  );
  return rows[0];
}

// Configuração de onboarding usada nos testes: o mínimo estrutural, tudo mais desligado, para que
// a criação não dependa de provider nenhum.
const PASSOS_DE_TESTE = Object.freeze({
  org_store: 'required',
  owner: 'required',
  ink: 'optional',
  meta: 'disabled',
  google: 'disabled',
  ga4: 'disabled',
  openai_byok: 'disabled',
  whatsapp: 'optional',
  entitlements: 'optional',
  readiness: 'required',
});

const chaveIdempotencia = () => `teste-${crypto.randomBytes(12).toString('hex')}`;

function abrirPool(url) {
  return new Pool({ connectionString: url, max: 5 });
}

module.exports = {
  RAIZ_REPO,
  RAIZ_SUJEITO,
  SEGREDO_DE_TESTE,
  SENHA_DE_TESTE,
  PASSOS_DE_TESTE,
  sujeito,
  bancoNovo,
  subirApp,
  criarCliente,
  criarAdmin,
  chaveIdempotencia,
  abrirPool,
  urlComBanco,
};
