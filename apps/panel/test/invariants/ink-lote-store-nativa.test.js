'use strict';

// Rodada de integrações core (2026-09-20) · associação de categorias em lote (job) na Store nativa.
// Separado de ink-store-nativa.test.js: o runner de jobs roda a cada 15 s, e este é o teste lento.
//
// Antes: cada rota chamava `lojaLegadaDoContexto()`; o cache do catálogo (`produtos_ink`,
// `produtos_ink_sync`) tinha `loja` NOT NULL na PK e pulava a Store nativa "de propósito"; o card
// de Integrações dizia "Nenhuma loja conectada" mesmo com token Ink; o webhook era verificado (200) e
// depois falhava em silêncio ao processar o evento.
//
// O provider mock devolve produtos/categorias/pedidos por "loja de teste" escolhida pela 4ª letra do
// token Bearer (`inkC…`, `inkD…`, `inkA…`): cada Organization só pode ler o catálogo da SUA credencial.
//
//   A  Store COM chave legada `sul`   — compatibilidade histórica
//   C  Store nativa                    — o caso do tenant de dogfooding (Use Sul)
//   D  Store nativa                    — isolamento

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { inserir, limparCache, concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORGS = {
  A: 'a1000000-0000-4000-8000-000000000001',
  C: 'a1000000-0000-4000-8000-00000000000c',
  D: 'a1000000-0000-4000-8000-00000000000d',
};
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_ink_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
// 4ª letra do token = "loja de teste" do provider mock.
const TOKEN = {
  A: `inkA${crypto.randomBytes(10).toString('hex')}`,
  C: `inkC${crypto.randomBytes(10).toString('hex')}`,
  D: `inkD${crypto.randomBytes(10).toString('hex')}`,
};
const SEGREDO_WEBHOOK = { C: `segredoC-${crypto.randomBytes(12).toString('hex')}`, D: `segredoD-${crypto.randomBytes(12).toString('hex')}` };

let db;
let sup;
let filho;
let saida = '';
let base;
const store = {};
const email = (l) => `ink-${l.toLowerCase()}@teste.oria`;

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    // Timeout: o defeito histórico deste tipo de rota era "a requisição nunca responde".
    const res = await fetch(base + caminho, {
      method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(10000),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto };
  };
  nav.entrar = async (letra) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email: email(letra), password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}
const entrar = (l) => navegador().entrar(l);
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ate(fn, { tentativas = 40, intervalo = 500 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const v = await fn();
    if (v) return v;
    await esperar(intervalo);
  }
  return null;
}

async function criarNativa(letra) {
  const org = ORGS[letra];
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, `Tenant Nativo ${letra}`]);
  const { rows: [s] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id', [crypto.randomUUID(), org, `Loja Nativa ${letra}`]
  );
  store[letra] = s.id;
}

async function pessoa(letra) {
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email(letra), await senhas.gerarHash(SENHA)]);
  await sup.query("INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, 'owner')", [ORGS[letra], u.id]);
  await concederFeatures(sup, ORGS[letra], { financial: true, catalog: true, exchanges: true, refunds: true, whatsapp: true });
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_ink_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  limparCache();
  const { rows: [sa] } = await sup.query('SELECT id FROM stores WHERE organization_id = $1', [ORGS.A]);
  store.A = sa.id;
  await criarNativa('C');
  await criarNativa('D');
  for (const l of Object.keys(ORGS)) await pessoa(l);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-ink-srv-'));
  const mockLog = path.join(dir, 'chamadas.jsonl');
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: mockLog,
    },
  }), {
    aoLer: (pedaco, { reiniciando }) => { saida = reiniciando ? '' : saida + pedaco; },
    limiteMs: 30000,
  });
  filho = processo.filho;
  base = processo.base;

  // A credencial (e o segredo do webhook) entram pelo caminho real de produto, cifradas.
  for (const l of ['A', 'C', 'D']) {
    const nav = await entrar(l);
    const corpo = { apiToken: TOKEN[l] };
    if (SEGREDO_WEBHOOK[l]) corpo.webhookSecret = SEGREDO_WEBHOOK[l];
    const salvo = await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo });
    assert.equal(salvo.status, 200, salvo.texto);
  }
});

test.after(async () => {
  if (filho && filho.exitCode === null) filho.kill('SIGKILL');
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

// ── Associação de categorias em lote (job) ────────────────────────────────────────────────────

test('categorias em lote · job da Store nativa nasce com store_id e é processado com a credencial da Store', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/category-assignments', { corpo: { mode: 'add', categoryIds: [1100], filtros: {} } });
  assert.equal(r.status, 201, `associar categorias em lote não pode exigir chave legada: ${r.texto}`);
  const { rows: [job] } = await sup.query('SELECT store_id, loja, total FROM bulk_category_jobs WHERE id = $1 AND organization_id = $2', [r.json.jobId, ORGS.C]);
  assert.equal(job.store_id, store.C);
  assert.equal(job.loja, null);
  assert.equal(job.total, 3);
  // O runner de jobs (15 s) processa o lote sob o contexto da Organization/Store. Na CI lenta (Full
  // Verification em modo owner) o job passou dos 40 s antigos. 60 s dá folga sem estourar o limite de 120 s
  // do negative control (que roda este arquivo 3 vezes): um job que NUNCA roda continua reprovando.
  const concluido = await ate(async () => {
    const { rows } = await sup.query('SELECT status, succeeded, failed FROM bulk_category_jobs WHERE id = $1', [r.json.jobId]);
    return rows[0] && !['queued', 'running'].includes(rows[0].status) ? rows[0] : null;
  }, { tentativas: 120, intervalo: 500 });
  assert.ok(concluido, 'o job de categoria em lote não foi processado');
  assert.notEqual(concluido.status, 'cancelled');
  assert.equal(concluido.failed, 0);
  assert.equal(concluido.succeeded, 3, 'os 3 produtos do catálogo de C receberam a categoria pela credencial da Store');
});


function blocoDe(fonte, assinatura) {
  const inicio = fonte.indexOf(assinatura);
  assert.ok(inicio >= 0, `não encontrado: ${assinatura}`);
  const fim = fonte.indexOf('\n});', inicio);
  return fonte.slice(inicio, fim + 4);
}

test('fonte · o job de categoria em lote grava com store_id e o processador usa a credencial da Store', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  const rota = blocoDe(fonte, "app.post('/api/admin/category-assignments'");
  assert.doesNotMatch(rota, /lojaLegadaDoContexto\(\)/);
  assert.match(rota, /INSERT INTO bulk_category_jobs \(store_id, loja,/);
  assert.match(fonte, /inkApiPatchDaStore\(\n\s+`\/v1\/stores\/products\/\$\{item\.product_id\}`/, 'o PATCH do lote usa a credencial da Store');
});

test('processo · zero UNHANDLED_REJECTION no fluxo de lote', async () => {
  await esperar(300);
  assert.doesNotMatch(saida, /UNHANDLED_REJECTION/);
  assert.doesNotMatch(saida, /não tem loja legada|STORE_WITHOUT_LEGACY_KEY/);
});
