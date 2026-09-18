'use strict';

// Fase 5b no processo real: server.js sob a role da aplicação, com a Meta simulada
// (test/helpers/provider-mock.cjs) e um whatsapp-webhook-go falso neste processo, que registra o
// que o painel manda. Duas Organizations, cada uma com seu número/WABA/token:
//   - cadastro do remetente só por owner, validado, com posse do número (PD-016);
//   - resolução interna da referência (o caminho que o Go usa para fila/retry);
//   - Fase 5c: contexto de entrada por (WABA, número) e por referência, sem token, divergência e
//     desconhecido recusados, organization_id do corpo recusado, posse exclusiva da WABA;
//   - nenhum token em resposta ou log (INV-13).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const CONTRATO_CONTEXTO = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'whatsapp', 'inbound-context-v1.json');
const LIMITE_CONTEXTO = 400;
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_f5s_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_REF = crypto.randomBytes(32).toString('base64url');
const CHAVE_RESOLVER = crypto.randomBytes(24).toString('base64url');
const CHAVE_GO = crypto.randomBytes(24).toString('base64url');
const LOJA = { [ORG_A]: 'sul', [ORG_B]: 'centro' };

const R = {
  [ORG_A]: { phone: '1110000001', waba: '2220000001', token: `EAAGA${crypto.randomBytes(12).toString('hex')}` },
  [ORG_B]: { phone: '1110000002', waba: '2220000002', token: `EAAGB${crypto.randomBytes(12).toString('hex')}` },
};
const TOKENS = () => Object.values(R).map((x) => x.token);

let db;
let sup;
let resolver;
let assinador;
let filho;
let saida = '';
let base;
let mockLog;
let goFalso;
const chamadasGo = [];
const respostas = [];

const chamadasMeta = () => (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const em = (org, fn) => runtime.comContexto({ organizationId: org, loja: LOJA[org] }, fn);

async function criarPessoa(email, org, papel) {
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]
  );
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
}

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    respostas.push(texto);
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto };
  };
  nav.entrar = async (email) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email, password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}

// whatsapp-webhook-go falso: registra método, caminho, headers e corpo; responde como o serviço.
function subirGoFalso() {
  return new Promise((resolve) => {
    goFalso = http.createServer((req, res) => {
      let corpo = '';
      req.on('data', (c) => { corpo += c; });
      req.on('end', () => {
        const u = new URL(req.url, 'http://go');
        chamadasGo.push({ metodo: req.method, caminho: u.pathname, query: u.search, headers: req.headers, corpo });
        res.setHeader('Content-Type', 'application/json');
        if (req.headers['x-api-key'] !== CHAVE_GO) {
          res.statusCode = 401;
          res.end(JSON.stringify({ success: false, error: 'invalid or missing API key' }));
          return;
        }
        switch (u.pathname) {
          case '/health':
            // O Go antigo ainda devolve o número: o painel não pode usá-lo para nada.
            res.end(JSON.stringify({ status: 'ok', phone_number_id: '9990000000' }));
            return;
          case '/dashboard/events':
            res.end(JSON.stringify({ events: [], stats: { sent: 0, received: 0, errors: 0 }, pending: 0 }));
            return;
          case '/templates/list':
            res.end(JSON.stringify({ success: true, data: { data: [{ name: 'boas_vindas', status: 'APPROVED', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'Olá' }] }] } }));
            return;
          default:
            res.end(JSON.stringify({ success: true, data: { messages: [{ id: `wamid.${crypto.randomBytes(6).toString('hex')}` }] } }));
        }
      });
    });
    goFalso.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${goFalso.address().port}`));
  });
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_f5b_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const fachada = runtime.criarPoolTenant(sup);
  resolver = createIntegrationResolver({
    pool: fachada,
    segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {},
    logger: { warn() {}, error() {} },
  });
  assinador = wa.createWhatsappSender({ integracoes: resolver, segredoRef: SEGREDO_REF });
  await criarPessoa('f5-a@teste.oria', ORG_A, 'owner');
  await criarPessoa('f5-am@teste.oria', ORG_A, 'member');
  await criarPessoa('f5-b@teste.oria', ORG_B, 'owner');
  limparCache();
  for (const org of [ORG_A, ORG_B]) {
    await sup.query(
      `INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'entitlements', '{"whatsapp": true}'::jsonb)`, [org]
    );
    await concederFeatures(sup, org, { whatsapp: true });
  }

  const urlGo = await subirGoFalso();
  mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-f5b-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-f5b-srv-'));
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
      WHATSAPP_SERVICE_URL: urlGo,
      WHATSAPP_API_KEY: CHAVE_GO,
      WHATSAPP_SENDER_REF_SECRET: SEGREDO_REF,
      WHATSAPP_SENDER_RESOLVER_KEY: CHAVE_RESOLVER,
      WHATSAPP_CONTEXT_RATE_PER_MIN: String(LIMITE_CONTEXTO),
    },
  }), {
    aoLer: (pedaco, { reiniciando }) => { saida = reiniciando ? '' : saida + pedaco; },
    limiteMs: 30000,
  });
  filho = processo.filho;
  base = processo.base;
});

test.after(async () => {
  if (filho && filho.exitCode === null) filho.kill('SIGKILL');
  goFalso?.close();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

// ── Cadastro do remetente ─────────────────────────────────────────────────────────────────────

test('remetente · só owner grava; campos validados; token nunca volta', async () => {
  const membro = await navegador().entrar('f5-am@teste.oria');
  const corpoA = { phoneNumberId: R[ORG_A].phone, wabaId: R[ORG_A].waba, accessToken: R[ORG_A].token };
  assert.equal((await membro.req('PUT', '/api/admin/whatsapp/remetente', { corpo: corpoA })).status, 403);

  const a = await navegador().entrar('f5-a@teste.oria');
  for (const ruim of [
    { ...corpoA, organization_id: ORG_B },
    { ...corpoA, phoneNumberId: '11/../me' },
    { ...corpoA, wabaId: corpoA.phoneNumberId },
    { ...corpoA, accessToken: 'curto' },
    { phoneNumberId: corpoA.phoneNumberId, wabaId: corpoA.wabaId },
  ]) {
    const r = await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: ruim });
    assert.equal(r.status, 400, `${JSON.stringify(Object.keys(ruim))}: ${r.texto}`);
  }
  const ok = await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: corpoA });
  assert.equal(ok.status, 200, ok.texto);
  assert.deepEqual(
    { status: ok.json.status, phone: ok.json.phoneNumberId, waba: ok.json.wabaId, last4: ok.json.token.last4 },
    { status: 'connected', phone: R[ORG_A].phone, waba: R[ORG_A].waba, last4: R[ORG_A].token.slice(-4) }
  );
  assert.ok(!ok.texto.includes(R[ORG_A].token));
  // Só os IDs de novo, com o token já salvo: vale.
  assert.equal((await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: corpoA.phoneNumberId, wabaId: corpoA.wabaId } })).status, 200);
  // Trocar de número sem o token do número novo: recusado, nada muda.
  const troca = await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: '1110000077', wabaId: corpoA.wabaId } });
  assert.equal(troca.status, 400);
  assert.equal((await a.req('GET', '/api/admin/whatsapp/remetente')).json.phoneNumberId, R[ORG_A].phone);

  const b = await navegador().entrar('f5-b@teste.oria');
  const okB = await b.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: R[ORG_B].phone, wabaId: R[ORG_B].waba, accessToken: R[ORG_B].token } });
  assert.equal(okB.status, 200, okB.texto);
});

test('PD-016 · o número de A não é cadastrado por B', async () => {
  const b = await navegador().entrar('f5-b@teste.oria');
  const r = await b.req('PUT', '/api/admin/whatsapp/remetente', {
    corpo: { phoneNumberId: R[ORG_A].phone, wabaId: R[ORG_B].waba, accessToken: R[ORG_B].token },
  });
  assert.deepEqual([r.status, r.json.codigo], [409, 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE']);
  assert.equal((await b.req('GET', '/api/admin/whatsapp/remetente')).json.phoneNumberId, R[ORG_B].phone);
});

test('teste de conexão · a Meta recebe o número e o token da mesma Organization', async () => {
  for (const [email, org] of [['f5-a@teste.oria', ORG_A], ['f5-b@teste.oria', ORG_B]]) {
    const nav = await navegador().entrar(email);
    const antes = chamadasMeta().length;
    const r = await nav.req('POST', '/api/admin/integrations/whatsapp/teste', { corpo: {} });
    assert.equal(r.json.status, 'connected', r.texto);
    const novas = chamadasMeta().slice(antes).filter((c) => c.host === 'graph.facebook.com');
    assert.equal(novas.length, 1);
    assert.match(novas[0].caminho, new RegExp(`/${R[org].phone}$`));
    assert.equal(novas[0].auth, `Bearer ${R[org].token}`);
  }
});

// ── Resolução interna da referência (fila/retry do Go) ───────────────────────────────────────

async function refDe(org) {
  return em(org, () => assinador.comRemetente((r) => r.ref));
}

const resolverReq = (corpo, chave = CHAVE_RESOLVER, sufixo = '') => fetch(`${base}/api/internal/whatsapp/sender${sufixo}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(chave ? { 'X-Api-Key': chave } : {}) },
  body: JSON.stringify(corpo),
}).then(async (res) => ({ status: res.status, cache: res.headers.get('cache-control'), json: await res.json().catch(() => null) }));

test('resolver interno · chave do serviço e assinatura do painel, os dois obrigatórios', async () => {
  const refA = await refDe(ORG_A);
  assert.equal((await resolverReq({ ref: refA }, null)).status, 401);
  assert.equal((await resolverReq({ ref: refA }, 'chave-errada')).status, 401);
  assert.equal((await resolverReq({ ref: refA }, CHAVE_GO)).status, 401, 'a chave do Go para o painel não é a API_KEY do Go');
  const lixo = await resolverReq({ ref: 'v1.qualquercoisa0000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.deepEqual([lixo.status, lixo.json.codigo], [400, 'SENDER_REF_INVALID']);
  const extra = await resolverReq({ ref: refA, organization_id: ORG_B });
  assert.deepEqual([extra.status, extra.json.codigo], [400, 'SENDER_REF_INVALID']);
  // Assinada por outro painel: recusada.
  const outro = wa.createWhatsappSender({ integracoes: resolver, segredoRef: crypto.randomBytes(32).toString('base64url') });
  const alheia = await em(ORG_B, () => outro.comRemetente((r) => r.ref));
  assert.equal((await resolverReq({ ref: alheia })).status, 400);

  for (const org of [ORG_A, ORG_B]) {
    const r = await resolverReq({ ref: await refDe(org) }, CHAVE_RESOLVER, `?organization_id=${org === ORG_A ? ORG_B : ORG_A}`);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    assert.deepEqual(r.json, { phone_number_id: R[org].phone, waba_id: R[org].waba, access_token: R[org].token });
  }
});

test('resolver interno · plano sem WhatsApp, número trocado ou desconectado: recusa', async () => {
  const refA = await refDe(ORG_A);
  const refB = await refDe(ORG_B);
  await concederFeatures(sup, ORG_B, { whatsapp: false });
  try {
    const r = await resolverReq({ ref: refB });
    assert.deepEqual([r.status, r.json.codigo], [403, 'FEATURE_DISABLED']);
  } finally {
    await concederFeatures(sup, ORG_B, { whatsapp: true });
  }

  // A troca de número (com o token dele): a referência antiga não resolve para o número novo.
  const a = await navegador().entrar('f5-a@teste.oria');
  const novo = `EAAGA2${crypto.randomBytes(12).toString('hex')}`;
  assert.equal((await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: '1110000011', wabaId: R[ORG_A].waba, accessToken: novo } })).status, 200);
  const trocado = await resolverReq({ ref: refA });
  assert.deepEqual([trocado.status, trocado.json.codigo], [409, 'SENDER_CHANGED']);
  // O número antigo foi liberado: B pode ficar com ele depois.
  const { rows } = await sup.query(
    `SELECT external_id FROM external_resource_claims WHERE organization_id = $1 AND provider = 'whatsapp' AND tipo = 'phone_number'`, [ORG_A]
  );
  assert.deepEqual(rows.map((x) => x.external_id), ['1110000011']);

  // Desconectar: nenhuma referência de A resolve.
  const refNova = await refDe(ORG_A);
  assert.equal((await a.req('DELETE', '/api/admin/whatsapp/remetente')).status, 200);
  const desconectado = await resolverReq({ ref: refNova });
  assert.deepEqual([desconectado.status, desconectado.json.codigo], [409, 'INTEGRATION_NOT_CONNECTED']);
  assert.equal((await a.req('GET', '/api/admin/whatsapp/remetente')).json.status, 'disconnected');

  // Restaura A como no início.
  const volta = await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: R[ORG_A].phone, wabaId: R[ORG_A].waba, accessToken: R[ORG_A].token } });
  assert.equal(volta.status, 200, volta.texto);
  TOKENS_EXTRAS.push(novo);
});

const TOKENS_EXTRAS = [];

test('§16 · o painel não lê identidade do /health do serviço (estático)', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  // Toda leitura de phone_number_id/waba_id no painel vem da config da integração ou é a resposta do
  // resolver interno. Qualquer outra (ex.: do /health) reprova.
  const permitidas = [
    /m\.config\.(phone_number_id|waba_id)/,
    // gravação da config pela tela (valores validados do corpo do owner)
    /^\s*phone_number_id: phoneNumberId,$/,
    /^\s*waba_id: wabaId,$/,
    /return \{ phone_number_id: r\.phoneNumberId, waba_id: r\.wabaId, access_token: r\.accessToken \};/,
    // entrada da 5c: o pedido do serviço Go traz os identificadores do evento, conferidos contra a posse
    /rotaDeContextoInterno\('inbound', \['waba_id', 'phone_number_id'\]/,
    /corpo\.(waba_id|phone_number_id)/,
  ];
  const linhas = fonte.split('\n');
  const suspeitas = linhas
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /phone_number_id|waba_id/.test(l) && !/^\s*\/\//.test(l))
    .filter(([, l]) => !permitidas.some((re) => re.test(l)));
  assert.deepEqual(suspeitas, [], 'leitura de identidade fora da integração da Organization');
  assert.doesNotMatch(fonte, /health[A-Za-z]*\.value\.(phone_number_id|waba_id)/);
});

// ── Envio com remetente explícito ─────────────────────────────────────────────────────────────

const remetenteDaChamada = (c) => ({
  phone: c.headers['x-sender-phone-number-id'],
  waba: c.headers['x-sender-waba-id'],
  token: c.headers['x-sender-access-token'],
  ref: c.headers['x-sender-ref'],
});
const orgDoPar = ({ phone, waba, token }) => [ORG_A, ORG_B].find((o) => R[o].phone === phone && R[o].waba === waba && R[o].token === token) || null;
const TELEFONE = (org, i) => `4899${org === ORG_A ? '1' : '2'}0000${String(i).padStart(2, '0')}`;
const testeTemplate = (nav, org, i, extra = {}) => nav.req('POST', '/api/admin/whatsapp-templates/boas_vindas/test', { corpo: { telefone: TELEFONE(org, i), ...extra } });

test('INV-28 · envios A/B intercalados e concorrentes: o Go recebe o par da Organization da sessão', async () => {
  const navs = { [ORG_A]: await navegador().entrar('f5-a@teste.oria'), [ORG_B]: await navegador().entrar('f5-b@teste.oria') };
  const antes = chamadasGo.length;
  const esperado = [];
  for (let i = 0; i < 6; i += 1) {
    const org = i % 2 ? ORG_B : ORG_A;
    esperado.push([org, i]);
    const r = await testeTemplate(navs[org], org, i);
    assert.equal(r.status, 200, r.texto);
  }
  const concorrentes = Array.from({ length: 12 }, (_, k) => [k % 2 ? ORG_A : ORG_B, 10 + k]);
  esperado.push(...concorrentes);
  const rs = await Promise.all(concorrentes.map(([org, i]) => testeTemplate(navs[org], org, i)));
  assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.texto).join('\n'));

  const novas = chamadasGo.slice(antes);
  const porCaminho = (c) => novas.filter((x) => x.caminho === c);
  assert.equal(porCaminho('/send/template').length, esperado.length);
  assert.equal(porCaminho('/templates/list').length, esperado.length);
  const orgDoTelefone = new Map(esperado.map(([org, i]) => [`55${TELEFONE(org, i)}`, org]));
  for (const c of porCaminho('/send/template')) {
    const org = orgDoTelefone.get(JSON.parse(c.corpo).to);
    const par = remetenteDaChamada(c);
    assert.equal(orgDoPar(par), org, `envio para ${JSON.parse(c.corpo).to} saiu com outro remetente`);
    // A referência que o Go guardaria resolve para o mesmo par (caminho da fila/retry).
    assert.deepEqual(assinador.lerRef(par.ref), { organizationId: org, integrationId: assinador.lerRef(par.ref).integrationId, phoneNumberId: R[org].phone });
    assert.equal(c.headers['x-api-key'], CHAVE_GO);
  }
  const contagem = {};
  for (const c of porCaminho('/templates/list')) {
    const org = orgDoPar(remetenteDaChamada(c));
    assert.ok(org, 'listagem de templates com par inconsistente');
    contagem[org] = (contagem[org] || 0) + 1;
  }
  assert.deepEqual(contagem, { [ORG_A]: 9, [ORG_B]: 9 });

  // Ida e volta completa: a referência recebida pelo Go troca pelo par certo no resolver interno.
  const umaDeB = porCaminho('/send/template').find((c) => orgDoTelefone.get(JSON.parse(c.corpo).to) === ORG_B);
  const volta = await resolverReq({ ref: remetenteDaChamada(umaDeB).ref });
  assert.deepEqual(volta.json, { phone_number_id: R[ORG_B].phone, waba_id: R[ORG_B].waba, access_token: R[ORG_B].token });
});

test('INV-25 · remetente forjado pelo navegador (corpo, headers, query) não chega ao Go', async () => {
  const a = await navegador().entrar('f5-a@teste.oria');
  const antes = chamadasGo.length;
  // Seletor de tenant no corpo é recusado antes de qualquer envio (pipeline da Fase 3).
  const seletor = await testeTemplate(a, ORG_A, 49, { organization_id: ORG_B });
  assert.deepEqual([seletor.status, seletor.json.codigo], [400, 'TENANT_SELECTOR_NOT_ALLOWED']);
  assert.equal(chamadasGo.length, antes, 'nada chega ao Go');
  // Campos de remetente no corpo são ignorados: o remetente vem da Organization da sessão.
  const forjado = {
    phone_number_id: R[ORG_B].phone, phoneNumberId: R[ORG_B].phone, waba_id: R[ORG_B].waba, wabaId: R[ORG_B].waba,
    access_token: R[ORG_B].token, accessToken: R[ORG_B].token, sender: { phone_number_id: R[ORG_B].phone, access_token: R[ORG_B].token },
  };
  const r = await testeTemplate(a, ORG_A, 50, forjado);
  assert.equal(r.status, 200, r.texto);
  // Headers X-Sender-* vindos do navegador também não são repassados.
  const res = await fetch(`${base}/api/admin/whatsapp-templates/boas_vindas/test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Cookie: a.cookie, 'X-CSRF-Token': a.csrf,
      'X-Sender-Phone-Number-Id': R[ORG_B].phone, 'X-Sender-Access-Token': R[ORG_B].token, 'X-Sender-Waba-Id': R[ORG_B].waba,
    },
    body: JSON.stringify({ telefone: TELEFONE(ORG_A, 51) }),
  });
  assert.equal(res.status, 200);
  // Seletor de tenant na query é recusado antes de qualquer envio.
  const q = await a.req('POST', `/api/admin/whatsapp-templates/boas_vindas/test?organization_id=${ORG_B}`, { corpo: { telefone: TELEFONE(ORG_A, 52) } });
  assert.equal(q.status, 400);

  const novas = chamadasGo.slice(antes);
  assert.ok(novas.length >= 2);
  for (const c of novas) {
    assert.equal(orgDoPar(remetenteDaChamada(c)), ORG_A, `${c.caminho} saiu com remetente forjado`);
    assert.ok(!c.corpo.includes(R[ORG_B].token) && !c.corpo.includes(R[ORG_B].phone), 'campo forjado repassado no corpo');
    assert.ok(!c.corpo.includes('phone_number_id') && !c.corpo.includes('access_token'), 'campo de remetente no corpo');
  }
});

test('INV-25 · Organization sem número cadastrado não envia: 409 e nada chega ao Go', async () => {
  const b = await navegador().entrar('f5-b@teste.oria');
  assert.equal((await b.req('DELETE', '/api/admin/whatsapp/remetente')).status, 200);
  try {
    const antes = chamadasGo.length;
    const r = await testeTemplate(b, ORG_B, 60);
    assert.equal(r.status, 409, r.texto);
    assert.match(r.json.error, /número do WhatsApp não cadastrado/);
    const lista = await b.req('GET', '/api/admin/whatsapp-templates');
    assert.ok(lista.status >= 400, `listagem sem remetente respondeu ${lista.status}`);
    assert.equal(chamadasGo.slice(antes).filter((c) => c.caminho !== '/health').length, 0,
      'nenhuma chamada em nome da Organization sai sem remetente');
    // A visão geral continua de pé, sem número.
    const visao = await b.req('GET', '/api/admin/whatsapp/visao-geral');
    assert.equal(visao.status, 200);
    assert.equal(visao.json.phoneNumberId, null);
  } finally {
    const volta = await b.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: R[ORG_B].phone, wabaId: R[ORG_B].waba, accessToken: R[ORG_B].token } });
    assert.equal(volta.status, 200, volta.texto);
  }
});

test('/health vai sem remetente, eventos só com contexto; o número exibido é o da Organization, nunca o do /health', async () => {
  const a = await navegador().entrar('f5-a@teste.oria');
  const antes = chamadasGo.length;
  const visao = await a.req('GET', '/api/admin/whatsapp/visao-geral');
  assert.equal(visao.status, 200);
  assert.equal(visao.json.connected, true);
  assert.equal(visao.json.phoneNumberId, R[ORG_A].phone, 'o /health falso devolve 9990000000 e não pode ser usado');
  const novas = chamadasGo.slice(antes);
  const b = await navegador().entrar('f5-b@teste.oria');
  assert.equal((await b.req('GET', '/api/admin/whatsapp/visao-geral')).json.phoneNumberId, R[ORG_B].phone);
  const health = novas.filter((c) => c.caminho === '/health');
  assert.equal(health.length, 1);
  assert.deepEqual(Object.keys(health[0].headers).filter((k) => k.startsWith('x-sender-')), []);
  // Fase 5c: eventos são da Organization — vão com número + referência, nunca com token ou WABA.
  const eventos = novas.filter((c) => c.caminho === '/dashboard/events');
  assert.equal(eventos.length, 1);
  assert.deepEqual(Object.keys(eventos[0].headers).filter((k) => k.startsWith('x-sender-')).sort(), ['x-sender-phone-number-id', 'x-sender-ref']);
  assert.equal(eventos[0].headers['x-sender-phone-number-id'], R[ORG_A].phone);
  assert.equal(assinador.lerRef(eventos[0].headers['x-sender-ref']).organizationId, ORG_A);
});

test('INV-13 · nenhum token de WhatsApp em resposta do painel ou no log do processo', async () => {
  const a = await navegador().entrar('f5-a@teste.oria');
  for (const rota of ['/api/admin/whatsapp/remetente', '/api/admin/integrations']) await a.req('GET', rota);
  const tudo = respostas.join('\n');
  for (const token of [...TOKENS(), ...TOKENS_EXTRAS]) assert.ok(!tudo.includes(token), 'token numa resposta do painel');
  await new Promise((r) => setTimeout(r, 300));
  for (const token of [...TOKENS(), ...TOKENS_EXTRAS]) assert.ok(!saida.includes(token), 'token no log do processo');
  assert.doesNotMatch(saida, /TENANT_CONTEXT_REQUIRED|row-level security|permission denied/i);
});

// ── Fase 5c · contexto de entrada e de referência para o serviço Go ───────────────────────────

const interno = (caminho, corpo, chave = CHAVE_RESOLVER) => fetch(`${base}/api/internal/whatsapp/${caminho}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(chave ? { 'X-Api-Key': chave } : {}) },
  body: JSON.stringify(corpo),
}).then(async (res) => {
  const texto = await res.text();
  respostas.push(texto);
  let json = null;
  try { json = JSON.parse(texto); } catch { json = null; }
  return { status: res.status, cache: res.headers.get('cache-control'), json, texto };
});

test('5c · comportamento por Organization: resposta automática e aviso configurados na tela, validados', async () => {
  const a = await navegador().entrar('f5-a@teste.oria');
  const base5c = { phoneNumberId: R[ORG_A].phone, wabaId: R[ORG_A].waba };
  assert.equal((await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { ...base5c, notifyNumber: '12ab' } })).status, 400);
  assert.equal((await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { ...base5c, replyRedirectMessage: 'x'.repeat(1001) } })).status, 400);
  const ok = await a.req('PUT', '/api/admin/whatsapp/remetente', {
    corpo: { ...base5c, replyRedirectMessage: ' Fale com A em wa.me/5548 ', notifyNumber: '+55 (48) 90000-0001' },
  });
  assert.equal(ok.status, 200, ok.texto);
  assert.deepEqual([ok.json.replyRedirectMessage, ok.json.notifyNumber], ['Fale com A em wa.me/5548', '5548900000001']);
  // Omitir os campos mantém o que estava.
  const mantem = await a.req('PUT', '/api/admin/whatsapp/remetente', { corpo: base5c });
  assert.equal(mantem.json.notifyNumber, '5548900000001');
  const b = await navegador().entrar('f5-b@teste.oria');
  assert.equal((await b.req('PUT', '/api/admin/whatsapp/remetente', {
    corpo: { phoneNumberId: R[ORG_B].phone, wabaId: R[ORG_B].waba, replyRedirectMessage: 'Fale com B', notifyNumber: '' },
  })).status, 200);
});

test('PD-016 · a WABA de A não é cadastrada por B', async () => {
  const b = await navegador().entrar('f5-b@teste.oria');
  const r = await b.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: R[ORG_B].phone, wabaId: R[ORG_A].waba } });
  assert.deepEqual([r.status, r.json.codigo], [409, 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE']);
  assert.equal((await b.req('GET', '/api/admin/whatsapp/remetente')).json.wabaId, R[ORG_B].waba);
});

test('INV-15 · inbound-context resolve (WABA, número) para a Organization dona, sem token', async () => {
  for (const org of [ORG_A, ORG_B]) {
    const r = await interno('inbound-context', { waba_id: R[org].waba, phone_number_id: R[org].phone });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.cache, 'no-store');
    assert.equal(r.json.organization_id, org);
    assert.equal(r.json.phone_number_id, R[org].phone);
    assert.equal(r.json.waba_id, R[org].waba);
    assert.deepEqual(r.json.reply, org === ORG_A
      ? { redirect_message: 'Fale com A em wa.me/5548', notify_number: '5548900000001' }
      : { redirect_message: 'Fale com B', notify_number: '' });
    assert.deepEqual(assinador.lerRef(r.json.sender_ref).organizationId, org);
    assert.ok(!r.texto.includes(R[org].token), 'contexto não carrega token');
    // A referência devolvida é a mesma que o resolver da 5b troca pelo par da própria Organization.
    const par = await resolverReq({ ref: r.json.sender_ref });
    assert.equal(par.json.access_token, R[org].token);
  }
  // Só a WABA (evento de conta/template): roteia pela posse exclusiva da WABA.
  const soWaba = await interno('inbound-context', { waba_id: R[ORG_B].waba });
  assert.equal(soWaba.json.organization_id, ORG_B);
});

test('INV-15 · HMAC da plataforma não escolhe tenant: desconhecido e divergente são recusados sem listar nada', async () => {
  const cruzado = await interno('inbound-context', { waba_id: R[ORG_A].waba, phone_number_id: R[ORG_B].phone });
  assert.deepEqual([cruzado.status, cruzado.json.codigo], [409, 'SENDER_MISMATCH']);
  const wabaDesconhecida = await interno('inbound-context', { waba_id: '2229999999', phone_number_id: R[ORG_A].phone });
  assert.deepEqual([wabaDesconhecida.status, wabaDesconhecida.json.codigo], [404, 'SENDER_UNKNOWN']);
  const numeroDesconhecido = await interno('inbound-context', { waba_id: R[ORG_A].waba, phone_number_id: '1119999999' });
  assert.deepEqual([numeroDesconhecido.status, numeroDesconhecido.json.codigo], [404, 'SENDER_UNKNOWN']);
  for (const r of [cruzado, wabaDesconhecida, numeroDesconhecido]) {
    assert.ok(!r.texto.includes(ORG_A) && !r.texto.includes(ORG_B), 'erro não revela Organization');
  }
});

test('INV-31 · organization_id no corpo não é autoridade; chave e formato obrigatórios', async () => {
  const pedido = { waba_id: R[ORG_A].waba, phone_number_id: R[ORG_A].phone };
  assert.equal((await interno('inbound-context', pedido, null)).status, 401);
  assert.equal((await interno('inbound-context', pedido, CHAVE_GO)).status, 401);
  const comOrg = await interno('inbound-context', { ...pedido, organization_id: ORG_B });
  assert.deepEqual([comOrg.status, comOrg.json.codigo], [400, 'CONTEXT_REQUEST_INVALID']);
  for (const ruim of [{}, { waba_id: 'abc' }, { waba_id: R[ORG_A].waba, phone_number_id: '1/../2' }, { waba_id: 2220000001 }]) {
    assert.equal((await interno('inbound-context', ruim)).status, 400, JSON.stringify(ruim));
  }
  const refB = await refDe(ORG_B);
  const comOrgRef = await interno('ref-context', { ref: refB, organization_id: ORG_A });
  assert.equal(comOrgRef.status, 400);
  const porRef = await interno('ref-context', { ref: refB });
  assert.equal(porRef.json.organization_id, ORG_B);
  const outro = wa.createWhatsappSender({ integracoes: resolver, segredoRef: crypto.randomBytes(32).toString('base64url') });
  const forjada = await em(ORG_A, () => outro.comRemetente((r) => r.ref));
  assert.equal((await interno('ref-context', { ref: forjada })).status, 400);
});

test('5c · plano sem WhatsApp: nenhum contexto sai para o serviço', async () => {
  await concederFeatures(sup, ORG_B, { whatsapp: false });
  try {
    const r = await interno('inbound-context', { waba_id: R[ORG_B].waba, phone_number_id: R[ORG_B].phone });
    assert.deepEqual([r.status, r.json.codigo], [403, 'FEATURE_DISABLED']);
    assert.equal((await interno('ref-context', { ref: await refDe(ORG_B) })).status, 403);
  } finally {
    await concederFeatures(sup, ORG_B, { whatsapp: true });
  }
});

test('contrato 5c · respostas reais do painel seguem a fixture de contexto (cópia idêntica no Go)', async (t) => {
  const c = JSON.parse(fs.readFileSync(CONTRATO_CONTEXTO, 'utf8'));
  assert.equal(c.endpoints.inbound.path, '/api/internal/whatsapp/inbound-context');
  assert.equal(c.endpoints.ref.path, '/api/internal/whatsapp/ref-context');
  const r = await interno('inbound-context', { waba_id: R[ORG_A].waba, phone_number_id: R[ORG_A].phone });
  assert.deepEqual(Object.keys(r.json).sort(), c.response_fields);
  assert.deepEqual(Object.keys(r.json.reply).sort(), c.reply_fields);
  assert.deepEqual(Object.keys(c.examples.response).sort(), c.response_fields);
  for (const f of c.forbidden_response_fields) assert.ok(!(f in r.json));
  // Os exemplos do contrato usam os identificadores de A deste cenário.
  const semTelefone = await interno('inbound-context', c.examples.inbound_request_waba_only);
  assert.deepEqual([semTelefone.status, semTelefone.json.organization_id], [200, c.examples.response.organization_id]);
  const completo = await interno('inbound-context', c.examples.inbound_request);
  assert.deepEqual(
    [completo.json.phone_number_id, completo.json.waba_id],
    [c.examples.response.phone_number_id, c.examples.response.waba_id]
  );
  const cruzado = await interno('inbound-context', { waba_id: R[ORG_A].waba, phone_number_id: R[ORG_B].phone });
  assert.deepEqual([cruzado.status, cruzado.json.codigo], [c.statuses.mismatch, c.codes.mismatch]);
  const invalido = await interno('inbound-context', { organization_id: ORG_A, waba_id: R[ORG_A].waba });
  assert.deepEqual([invalido.status, invalido.json.codigo], [c.statuses.invalid_request, c.codes.invalid_request]);
  assert.deepEqual(Object.keys(c.examples.inbound_request).sort(), c.endpoints.inbound.request_fields);
  assert.deepEqual(Object.keys(c.examples.ref_request).sort(), c.endpoints.ref.request_fields);

  const dirGo = process.env.WHATSAPP_GO_DIR || path.resolve(h.RAIZ_REPO, '..', '..', 'services', 'whatsapp');
  const copia = path.join(dirGo, 'testdata', 'inbound-context-v1.json');
  if (!fs.existsSync(copia)) {
    t.diagnostic(`cópia do Go não encontrada em ${dirGo} — só a metade do painel foi verificada`);
    return;
  }
  assert.equal(fs.readFileSync(copia, 'utf8'), fs.readFileSync(CONTRATO_CONTEXTO, 'utf8'), 'as duas cópias do contrato de contexto divergiram');
});

test('5c · INV-13 no contexto e limite de taxa do endpoint interno', async () => {
  const tudo = respostas.join('\n');
  for (const token of [...TOKENS(), ...TOKENS_EXTRAS]) assert.ok(!tudo.includes(token), 'token numa resposta de contexto');
  await new Promise((r) => setTimeout(r, 200));
  for (const token of [...TOKENS(), ...TOKENS_EXTRAS]) assert.ok(!saida.includes(token), 'token no log do processo');
  const pedidos = await Promise.all(Array.from({ length: LIMITE_CONTEXTO + 20 }, () => interno('inbound-context', { waba_id: '2229999998' })));
  assert.ok(pedidos.some((r) => r.status === 429), 'o limite por minuto precisa existir');
  assert.ok(pedidos.filter((r) => r.status === 429).every((r) => r.json.codigo === 'RATE_LIMITED'));
});
