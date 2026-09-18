'use strict';

// Fase 5c · E2E local painel ↔ whatsapp-webhook-go ↔ Meta (simulada).
//
// Processos reais: server.js (painel, sob a role da aplicação) e o binário do serviço Go compilado
// a partir de WHATSAPP_GO_DIR (padrão: ../../services/whatsapp, no monorepo Oria), cada um com o seu banco
// descartável. A Meta é um servidor HTTP deste processo (META_GRAPH_BASE_URL). Cenário A/B:
//
//   entrada A → evento A e resposta pelo remetente A, sem envio prévio do painel (cold start)
//   entrada B, mesmo cliente → resposta de B (cooldown de A não suprime)
//   WABA de A + número de B, WABA desconhecida → nenhum efeito
//   painel de eventos de A não mostra B e vice-versa
//   envio pelo painel usa o par da Organization da sessão
//   fila de A sobrevive ao restart do Go e sai com o token atual resolvido no painel
//   problema de entrega com o mesmo número em A e B fica independente
//   reentrega do mesmo evento não repete efeito
//   nenhum token em log dos dois processos nem no banco do Go
//
// Sem Go instalado ou sem o repositório, o teste registra o motivo e não roda.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const wa = h.sujeito('lib/platform/whatsapp-sender.js');
const { limparCache, concederFeatures } = require('../helpers/linhas');

const DIR_GO = process.env.WHATSAPP_GO_DIR || path.resolve(h.RAIZ_REPO, '..', '..', 'services', 'whatsapp');
const GO = spawnSync('go', ['version'], { encoding: 'utf8' });
const MOTIVO_PULO = GO.status !== 0 ? 'toolchain Go ausente'
  : !fs.existsSync(path.join(DIR_GO, 'go.mod')) ? `repositório do Go não encontrado em ${DIR_GO} (defina WHATSAPP_GO_DIR)`
    : null;

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_e2e_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_REF = crypto.randomBytes(32).toString('base64url');
const CHAVE_RESOLVER = crypto.randomBytes(32).toString('base64url');
const CHAVE_GO = crypto.randomBytes(24).toString('base64url');
const APP_SECRET = crypto.randomBytes(24).toString('hex');
// Rodada 18 · §22: o repasse Go → painel é assinado em header; a URL não leva segredo.
const SEGREDO_REPASSE = crypto.randomBytes(32).toString('base64url');
const LOJA = { [ORG_A]: 'sul', [ORG_B]: 'centro' };
const CLIENTE = '5548912340000';

const R = {
  [ORG_A]: { phone: '1110000001', waba: '2220000001', token: `EAAGE2EA${crypto.randomBytes(12).toString('hex')}`, resposta: 'Fale com A', aviso: '5548900000001' },
  [ORG_B]: { phone: '1110000002', waba: '2220000002', token: `EAAGE2EB${crypto.randomBytes(12).toString('hex')}`, resposta: 'Fale com B', aviso: '' },
};

let dbPainel;
let dbGo;
let sup;
let assinador;
let painel;
let go;
let meta;
const logs = { painel: '', go: '' };
const chamadasMeta = [];
let portas;

const livre = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const esperar = async (oque, cond, ms = 10000) => {
  const fim = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > fim) throw new Error(`tempo esgotado: ${oque}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
const envios = () => chamadasMeta.filter((c) => c.metodo === 'POST' && c.caminho.endsWith('/messages'));
const parDe = (c) => ({ phone: c.caminho.split('/')[2], token: (c.auth || '').replace(/^Bearer /, '') });
const orgDoPar = (p) => [ORG_A, ORG_B].find((o) => R[o].phone === p.phone && R[o].token === p.token) || null;

function subirMeta() {
  return new Promise((resolve) => {
    meta = http.createServer((req, res) => {
      let corpo = '';
      req.on('data', (c) => { corpo += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://meta');
        chamadasMeta.push({ metodo: req.method, caminho: u.pathname, auth: req.headers.authorization, corpo });
        res.setHeader('Content-Type', 'application/json');
        if (u.pathname.endsWith('/message_templates')) {
          res.end(JSON.stringify({ data: [{ name: 'boas_vindas', status: 'APPROVED', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá' }] }] }));
          return;
        }
        res.end(JSON.stringify({ messages: [{ id: `wamid.E2E-${chamadasMeta.length}` }] }));
      });
    });
    meta.listen(portas.meta, '127.0.0.1', resolve);
  });
}

function aguardarSaida(filho, rotulo, marca) {
  return new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error(`${rotulo} não subiu:\n${logs[rotulo].slice(-3000)}`)), 60000);
    const ler = (b) => { logs[rotulo] += b; if (marca.test(logs[rotulo])) { clearTimeout(limite); resolve(); } };
    filho.stdout.on('data', ler);
    filho.stderr.on('data', ler);
    filho.on('exit', (code) => { clearTimeout(limite); reject(new Error(`${rotulo} saiu com ${code}:\n${logs[rotulo].slice(-3000)}`)); });
  });
}

let binarioGo;
async function subirGo() {
  go = spawn(binarioGo, [], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      APP_ENV: 'development',
      PORT: String(portas.go),
      API_KEY: CHAVE_GO,
      META_APP_SECRET: APP_SECRET,
      META_VERIFY_TOKEN: 'verificacao',
      META_API_VERSION: 'v21.0',
      META_GRAPH_BASE_URL: `http://127.0.0.1:${portas.meta}`,
      META_SEND_INTERVAL_MS: '0',
      DATABASE_URL: dbGo.url.includes('?') ? dbGo.url : `${dbGo.url}?sslmode=disable`,
      PANEL_SENDER_RESOLVER_URL: `http://127.0.0.1:${portas.painel}/api/internal/whatsapp/sender`,
      PANEL_SENDER_RESOLVER_KEY: CHAVE_RESOLVER,
      WEBHOOK_FORWARD_URL: `http://127.0.0.1:${portas.painel}/api/webhooks/whatsapp`,
      WEBHOOK_FORWARD_SECRET: SEGREDO_REPASSE,
      // Variáveis antigas presentes: não podem ser usadas.
      META_PHONE_NUMBER_ID: '9990000000',
      META_ACCESS_TOKEN: 'EAAG-token-do-ambiente-nao-use-0000',
      REPLY_REDIRECT_MESSAGE: 'texto do ambiente que não pode sair',
      REPLY_NOTIFY_NUMBER: '5548999999999',
    },
  });
  const pronto = aguardarSaida(go, 'go', /WhatsApp service :/);
  await pronto;
  go.removeAllListeners('exit');
  await esperar('health do Go', async () => (await fetch(`http://127.0.0.1:${portas.go}/health`).catch(() => ({ ok: false }))).ok);
}

async function derrubarGo() {
  if (!go || go.exitCode !== null) return;
  await new Promise((resolve) => { go.once('exit', resolve); go.kill('SIGTERM'); });
}

function webhook(corpo) {
  const assinatura = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(corpo).digest('hex')}`;
  return fetch(`http://127.0.0.1:${portas.go}/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': assinatura }, body: corpo,
  });
}

const entrada = (org, de, wamid, telefone = R[org].phone) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{ id: R[org].waba, changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: telefone },
    contacts: [{ wa_id: de, profile: { name: 'Cliente' } }],
    messages: [{ from: de, id: wamid, type: 'text', text: { body: 'oi' } }],
  } }] }],
});

function goInterno(metodo, caminho, { headers = {}, corpo } = {}) {
  return fetch(`http://127.0.0.1:${portas.go}${caminho}`, {
    method: metodo,
    headers: { 'X-Api-Key': CHAVE_GO, ...(corpo ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: corpo ? JSON.stringify(corpo) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

const em = (org, fn) => runtime.comContexto({ organizationId: org, loja: LOJA[org] }, fn);
const refDe = (org) => em(org, () => assinador.comRemetente((r) => r.ref));
const contexto = async (org) => ({ 'X-Sender-Phone-Number-Id': R[org].phone, 'X-Sender-Ref': await refDe(org) });

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(`http://127.0.0.1:${portas.painel}${caminho}`, { method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto };
  };
  return nav;
}
const entrar = async (email) => {
  const nav = navegador();
  const r = await nav.req('POST', '/api/admin/login', { corpo: { email, password: SENHA } });
  assert.equal(r.status, 200, r.texto);
  return nav;
};

test.before(async () => {
  if (MOTIVO_PULO) return;
  portas = { painel: await livre(), go: await livre(), meta: await livre() };
  const dirBin = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-e2e-go-'));
  binarioGo = path.join(dirBin, 'whatsapp-webhook');
  const build = spawnSync('go', ['build', '-o', binarioGo, '.'], { cwd: DIR_GO, encoding: 'utf8' });
  assert.equal(build.status, 0, `go build falhou:\n${build.stderr}`);

  dbPainel = await h.criarBancoDescartavel('oria_e2e');
  dbGo = await h.criarBancoDescartavel('wa_e2e');
  const r = h.migrar(dbPainel.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(dbPainel.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const fachada = runtime.criarPoolTenant(sup);
  const resolver = createIntegrationResolver({
    pool: fachada,
    segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {},
    logger: { warn() {}, error() {} },
  });
  assinador = wa.createWhatsappSender({ integracoes: resolver, segredoRef: SEGREDO_REF });
  for (const [email, org] of [['e2e-a@teste.oria', ORG_A], ['e2e-b@teste.oria', ORG_B]]) {
    const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]);
    await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, 'owner']);
    await concederFeatures(sup, org, { whatsapp: true });
  }
  limparCache();

  await subirMeta();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-e2e-srv-'));
  painel = spawn(process.execPath, [SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(portas.painel), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(dbPainel.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      WHATSAPP_SERVICE_URL: `http://127.0.0.1:${portas.go}`,
      WHATSAPP_API_KEY: CHAVE_GO,
      WHATSAPP_SENDER_REF_SECRET: SEGREDO_REF,
      WHATSAPP_SENDER_RESOLVER_KEY: CHAVE_RESOLVER,
      WHATSAPP_WEBHOOK_SECRET: SEGREDO_REPASSE,
      META_API_VERSION: 'v21.0',
    },
  });
  await aguardarSaida(painel, 'painel', /na porta/);
  painel.removeAllListeners('exit');
  await subirGo();

  for (const [email, org] of [['e2e-a@teste.oria', ORG_A], ['e2e-b@teste.oria', ORG_B]]) {
    const nav = await entrar(email);
    const put = await nav.req('PUT', '/api/admin/whatsapp/remetente', { corpo: {
      phoneNumberId: R[org].phone, wabaId: R[org].waba, accessToken: R[org].token,
      replyRedirectMessage: R[org].resposta, notifyNumber: R[org].aviso,
    } });
    assert.equal(put.status, 200, put.texto);
  }
});

test.after(async () => {
  if (MOTIVO_PULO) return;
  await derrubarGo();
  if (painel && painel.exitCode === null) painel.kill('SIGKILL');
  meta?.close();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await dbPainel?.destruir();
  await dbGo?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const cenario = (nome, fn) => test(nome, (t) => (MOTIVO_PULO ? t.skip(MOTIVO_PULO) : fn(t)));

cenario('E2E · cold start: a primeira entrada de A responde pelo remetente de A, sem envio prévio do painel', async () => {
  assert.equal(envios().length, 0, 'nenhum envio antes');
  const r = await webhook(entrada(ORG_A, CLIENTE, 'wamid.IN-A1'));
  assert.equal(r.status, 200);
  await esperar('aviso + resposta de A', () => envios().length === 2);
  const [aviso, resposta] = envios();
  for (const c of [aviso, resposta]) assert.equal(orgDoPar(parDe(c)), ORG_A, JSON.stringify(parDe(c)));
  assert.equal(JSON.parse(aviso.corpo).to, R[ORG_A].aviso);
  assert.deepEqual([JSON.parse(resposta.corpo).to, JSON.parse(resposta.corpo).text.body], [CLIENTE, R[ORG_A].resposta]);
});

cenario('E2E · mesmo cliente em B: resposta de B com o par de B; cooldown de A não interfere', async () => {
  const antes = envios().length;
  assert.equal((await webhook(entrada(ORG_B, CLIENTE, 'wamid.IN-B1'))).status, 200);
  await esperar('resposta de B', () => envios().length === antes + 1);
  const c = envios()[antes];
  assert.equal(orgDoPar(parDe(c)), ORG_B);
  assert.deepEqual([JSON.parse(c.corpo).to, JSON.parse(c.corpo).text.body], [CLIENTE, R[ORG_B].resposta]);
  // Segunda mensagem do cliente para A: só o aviso (A está em cooldown para ele).
  assert.equal((await webhook(entrada(ORG_A, CLIENTE, 'wamid.IN-A2'))).status, 200);
  await esperar('aviso da 2ª de A', () => envios().length === antes + 2);
  assert.equal(JSON.parse(envios()[antes + 1].corpo).to, R[ORG_A].aviso);
});

cenario('E2E · HMAC válido não escolhe tenant: divergente, desconhecido e reentrega não produzem efeito', async () => {
  const antes = envios().length;
  const cruzado = entrada(ORG_A, CLIENTE, 'wamid.X1', R[ORG_B].phone);
  const desconhecido = entrada(ORG_A, CLIENTE, 'wamid.X2').replace(R[ORG_A].waba, '2229999999');
  for (const corpo of [cruzado, desconhecido, entrada(ORG_A, CLIENTE, 'wamid.IN-A1')]) {
    assert.equal((await webhook(corpo)).status, 200);
  }
  const semAssinatura = await fetch(`http://127.0.0.1:${portas.go}/webhook`, { method: 'POST', body: entrada(ORG_A, CLIENTE, 'wamid.X3') });
  assert.equal(semAssinatura.status, 403);
  await pausa(600);
  assert.equal(envios().length, antes, 'nenhum envio');
});

cenario('E2E · eventos: o painel de A só vê A, o de B só vê B', async () => {
  const a = await entrar('e2e-a@teste.oria');
  const b = await entrar('e2e-b@teste.oria');
  const va = await a.req('GET', '/api/admin/whatsapp/visao-geral');
  const vb = await b.req('GET', '/api/admin/whatsapp/visao-geral');
  assert.equal(va.status, 200, va.texto);
  assert.deepEqual([va.json.connected, va.json.phoneNumberId, va.json.stats.received], [true, R[ORG_A].phone, 2]);
  assert.deepEqual([vb.json.phoneNumberId, vb.json.stats.received], [R[ORG_B].phone, 1]);
  // Sem contexto, o serviço não lista nada.
  assert.equal((await goInterno('GET', '/dashboard/events')).status, 400);
  const forjado = await goInterno('GET', '/dashboard/events', { headers: { 'X-Sender-Phone-Number-Id': R[ORG_B].phone, 'X-Sender-Ref': await refDe(ORG_A) } });
  assert.equal(forjado.status, 403, 'referência de A com número de B é recusada');
});

cenario('E2E · envio pelo painel usa o par da Organization da sessão', async () => {
  for (const [email, org] of [['e2e-a@teste.oria', ORG_A], ['e2e-b@teste.oria', ORG_B]]) {
    const nav = await entrar(email);
    const antes = chamadasMeta.length;
    const r = await nav.req('POST', '/api/admin/whatsapp-templates/boas_vindas/test', { corpo: { telefone: '48911112222', phone_number_id: R[ORG_A === org ? ORG_B : ORG_A].phone } });
    assert.equal(r.status, 200, r.texto);
    const novas = chamadasMeta.slice(antes);
    assert.ok(novas.some((c) => c.caminho === `/v21.0/${R[org].waba}/message_templates` && c.auth === `Bearer ${R[org].token}`));
    const envio = novas.find((c) => c.caminho.endsWith('/messages'));
    assert.equal(orgDoPar(parDe(envio)), org);
  }
});

cenario('E2E · fila de A sobrevive ao restart do Go e sai com o token resolvido no painel', async () => {
  const headersA = {
    ...(await contexto(ORG_A)), 'X-Sender-Waba-Id': R[ORG_A].waba, 'X-Sender-Access-Token': R[ORG_A].token,
  };
  const add = await goInterno('POST', '/queue/add', { headers: headersA, corpo: { type: 'template', to: '5548977770000', template: 'boas_vindas', language: 'en' } });
  assert.equal(add.status, 200, JSON.stringify(add.json));

  await derrubarGo();
  await subirGo();

  const listaB = await goInterno('GET', '/queue/list', { headers: await contexto(ORG_B) });
  assert.equal(listaB.json.items.length, 0, 'a fila de A não aparece para B');
  const antes = envios().length;
  // Sem token na chamada: o serviço pede ao painel.
  const send = await goInterno('POST', '/queue/send', { headers: await contexto(ORG_A), corpo: { all: true } });
  assert.equal(send.status, 200, JSON.stringify(send.json));
  assert.deepEqual(send.json.data, { sent: 1, errors: 0 });
  const c = envios()[antes];
  assert.equal(orgDoPar(parDe(c)), ORG_A);
  assert.deepEqual([JSON.parse(c.corpo).to, JSON.parse(c.corpo).template.language.code], ['5548977770000', 'en']);
  const listaA = await goInterno('GET', '/queue/list', { headers: await contexto(ORG_A) });
  assert.deepEqual(listaA.json.items.map((i) => i.status), ['sent']);
});

cenario('E2E · problema de entrega com o mesmo número em A e B fica independente', async () => {
  for (const org of [ORG_A, ORG_B]) {
    const r = await goInterno('POST', '/problems/add', { headers: await contexto(org), corpo: { numero: 'INK1', loja: LOJA[org], telefone: `tel-${org}` } });
    assert.equal(r.status, 200);
  }
  const vazio = await goInterno('POST', '/problems/add', { headers: await contexto(ORG_A), corpo: { numero: 'INK1', loja: LOJA[ORG_A] } });
  assert.equal(vazio.status, 200);
  for (const org of [ORG_A, ORG_B]) {
    const lista = await goInterno('GET', '/problems/list', { headers: await contexto(org) });
    assert.deepEqual(lista.json.items.map((i) => [i.numero, i.telefone]), [['INK1', `tel-${org}`]]);
  }
  const sync = await goInterno('POST', '/problems/sync', { headers: await contexto(ORG_B), corpo: { loja: LOJA[ORG_B], numeros: [] } });
  assert.equal(sync.status, 200);
  assert.equal((await goInterno('GET', '/problems/list', { headers: await contexto(ORG_A) })).json.items.length, 1);
  assert.equal((await goInterno('GET', '/problems/list', { headers: await contexto(ORG_B) })).json.items.length, 0);
});

cenario('E2E · nenhum token em log dos dois processos nem no banco do Go', async () => {
  await pausa(300);
  const goDb = h.abrirPoolDescartavel(dbGo.url, { max: 1 });
  try {
    const { rows } = await goDb.query(`
      SELECT coalesce(string_agg(t::text, ' '), '') AS tudo FROM (
        SELECT row_to_json(e)::text AS t FROM events e
        UNION ALL SELECT row_to_json(q)::text FROM queue_items q
        UNION ALL SELECT row_to_json(p)::text FROM problem_orders p
        UNION ALL SELECT row_to_json(w)::text FROM processed_webhook_events w
        UNION ALL SELECT row_to_json(i)::text FROM webhook_inbox i
      ) x`);
    for (const org of [ORG_A, ORG_B]) {
      assert.ok(!rows[0].tudo.includes(R[org].token), 'token no banco do Go');
      assert.ok(!logs.go.includes(R[org].token), 'token no log do Go');
      assert.ok(!logs.painel.includes(R[org].token), 'token no log do painel');
    }
    const { rows: [orgs] } = await goDb.query(`SELECT count(DISTINCT organization_id)::int AS n, count(*) FILTER (WHERE organization_id IS NULL)::int AS sem FROM events`);
    assert.deepEqual([orgs.n, orgs.sem], [2, 0]);
    // §23: tudo o que foi aceito foi processado (a inbox esvazia; nada ficou em falha).
    const { rows: [inbox] } = await goDb.query('SELECT count(*)::int AS n FROM webhook_inbox');
    assert.equal(inbox.n, 0, 'inbox do Go com linhas pendentes ou em falha');
  } finally {
    await goDb.end();
  }
  assert.doesNotMatch(logs.go, /texto do ambiente que não pode sair|9990000000/);
  // §22: o repasse assinado foi aceito pelo painel, e o segredo não aparece em lugar nenhum.
  assert.doesNotMatch(logs.go, /repasse:|forward: /, 'repasse do Go falhou');
  assert.doesNotMatch(logs.painel, /repasse recusado/);
  for (const log of [logs.go, logs.painel]) {
    assert.ok(!log.includes(SEGREDO_REPASSE), 'segredo do repasse no log');
    assert.ok(!log.includes('secret='), 'segredo em query string no log');
  }
});

cenario('E2E · status "delivered" repassado pelo Go chega assinado e o painel aceita', async () => {
  const original = logs.painel.length;
  const r = await webhook(JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: R[ORG_A].waba, changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: R[ORG_A].phone },
      statuses: [{ id: `wamid.E2E-FWD-${crypto.randomBytes(4).toString('hex')}`, status: 'delivered', recipient_id: CLIENTE }],
    } }] }],
  }));
  assert.equal(r.status, 200);
  const goDb = h.abrirPoolDescartavel(dbGo.url, { max: 1 });
  try {
    // A linha só sai da inbox depois do 2xx do painel: repasse recusado a deixaria pendente.
    await esperar('inbox vazia depois do repasse', async () => {
      const { rows: [x] } = await goDb.query('SELECT count(*)::int AS n FROM webhook_inbox');
      return x.n === 0;
    });
  } finally {
    await goDb.end();
  }
  assert.doesNotMatch(logs.painel.slice(original), /repasse recusado/);
});
