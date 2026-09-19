'use strict';

// Fase 3 no processo real: server.js sobe com a role da aplicação (NOSUPERUSER, NOBYPASSRLS, não
// dona) e DB_ENFORCE_APP_ROLE=1, e cada domínio é exercitado com duas Organizations. É a prova de
// que rotas, webhooks, links públicos e jobs funcionam sob RLS forçada (pré-condição de OPS-14).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const { inserir, limparCache, concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_srv_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const SEGREDO_WEBHOOK_SUL = crypto.randomBytes(16).toString('hex');
// Rodada 18 · §22: segredo do repasse do serviço Go (assinatura em header, nunca na URL).
const SEGREDO_REPASSE_WA = crypto.randomBytes(32).toString('base64url');

let db;
let sup;
let filho;
let saida = '';
let base;
const dados = { A: {}, B: {} };

async function criarPessoa(email, memberships) {
  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, await senhas.gerarHash(SENHA)]
  );
  for (const [org, papel] of memberships) {
    await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
  }
  return u.id;
}

async function semear(chave, org, loja) {
  const d = dados[chave];
  const doc = chave === 'A' ? '11111111111' : '22222222222';
  await sup.query(
    `INSERT INTO pedidos_ink (organization_id, loja, ink_order_id, payment_status, buyer_nome, buyer_documento, buyer_email, total_value, criado_em)
     VALUES ($1, $2, $3, 'paid', $4, $5, $6, 100, now())`,
    [org, loja, chave === 'A' ? 1001 : 2002, `Cliente ${chave}`, doc, `cliente-${chave.toLowerCase()}@teste.oria`]
  );
  d.segmento = String((await sup.query('INSERT INTO segments (organization_id, nome) VALUES ($1, $2) RETURNING id', [org, `seg ${chave}`])).rows[0].id);
  d.utm = String((await inserir(sup, 'utm_campaigns', { organization_id: org, loja, nome: `utm ${chave}` })).id);
  d.despesa = String((await inserir(sup, 'despesas_operacionais', {
    organization_id: org, loja, categoria: 'outros', descricao: `despesa ${chave}`, valor: 10, data: '2026-09-01',
  })).id);
  d.midia = String((await inserir(sup, 'media_assets', {
    organization_id: org, loja, kind: 'template_sample', original_filename: `midia-${chave}.png`, mime_type: 'image/png', size_bytes: 1,
  })).id);
  d.pedido = crypto.randomBytes(9).toString('base64url');
  await sup.query(
    `INSERT INTO app_config (organization_id, chave, valor) VALUES ($1, 'pedidos', $2::jsonb)`,
    [org, JSON.stringify({ [d.pedido]: { loja, pixCode: `pix-${chave}-0000000000`, cliente: `Cliente ${chave}`, criadoEm: new Date().toISOString() } })]
  );
  await sup.query(
    `INSERT INTO audit_log (organization_id, actor_user_id, action, entity_type, entity_id, loja)
     VALUES ($1, $2, 'refund.create', 'pedido', $3, $4)`,
    [org, d.dono, `reembolso-${chave}`, loja]
  );
  await inserir(sup, 'controle_estoque_observacoes', { organization_id: org, loja });
  await inserir(sup, 'meta_campaigns', { organization_id: org, meta_campaign_id: `mc-${chave}` });
  await inserir(sup, 'meta_insights_daily', { organization_id: org, meta_account_id: `act_${chave}` });
  const campanha = await inserir(sup, 'campaigns', { organization_id: org, loja, nome: `camp ${chave}` });
  d.campanha = String(campanha.id);
  d.wamid = `wamid.${chave}.${crypto.randomBytes(6).toString('hex')}`;
  await inserir(sup, 'campaign_recipients', {
    organization_id: org, campaign_id: campanha.id, provider_message_id: d.wamid, status: 'sent',
  });
}

function navegador() {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, headers = {} } = {}) => {
    const h2 = { ...headers };
    if (corpo !== undefined) h2['Content-Type'] = 'application/json';
    if (nav.cookie) h2.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET') h2['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers: h2, body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
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

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_f3_srv');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 2 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  dados.A.dono = await criarPessoa('srv-a@teste.oria', [[ORG_A, 'owner']]);
  dados.B.dono = await criarPessoa('srv-b@teste.oria', [[ORG_B, 'owner']]);
  await criarPessoa('srv-c@teste.oria', [[ORG_A, 'member'], [ORG_B, 'member']]);
  await criarPessoa('srv-am@teste.oria', [[ORG_A, 'member']]);
  limparCache();
  await semear('A', ORG_A, 'sul');
  await semear('B', ORG_B, 'centro');

  // A concessão vem da FONTE CANÔNICA (plano + assinatura ativa), como o Oria Admin faz — o antigo
  // `seed-entitlements` escrevia em `app_config`, que deixou de ser fonte (migration 0023).
  // `catalog` e `refunds` continuam na lista: foram classificadas como capacidade do Connector
  // Ink, mas o runtime ainda as confere como entitlement.
  await concederFeatures(sup, ORG_A, ['financial', 'whatsapp', 'refunds', 'catalog']);
  await concederFeatures(sup, ORG_B, ['whatsapp', 'refunds']);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-f3-srv-'));
  const processo = await h.subirProcessoDoPainel((porta) => spawn(process.execPath, [SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: crypto.randomBytes(32).toString('base64'),
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      // Fase 5c: o segredo legado da loja no ambiente não autentica mais nada.
      INK_WEBHOOK_SECRET_SUL: SEGREDO_WEBHOOK_SUL,
      WHATSAPP_WEBHOOK_SECRET: SEGREDO_REPASSE_WA,
      // A env da instalação não pode decidir o tenant do Creative Core.
      CREATIVE_TENANT_ID: ORG_B,
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
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

test('OPS-14 · o processo sobe com a role da aplicação verificada', () => {
  assert.match(saida, new RegExp(`role da aplicação ${ROLE} verificada`));
});

// Domínio → [rota de lista, extrator dos itens, campo que identifica o dado de cada Organization].
const DOMINIOS = [
  ['clientes (PII)', '/api/admin/clientes', (j) => j.clientes.map((c) => c.nome), (k) => `Cliente ${k}`],
  ['pedidos (link Pix)', '/api/admin/pedidos', (j) => (j.pedidos || j).map((p) => p.id), (k) => dados[k].pedido],
  ['segmentos', '/api/admin/segments', (j) => j.segmentos.map((s) => String(s.id)), (k) => dados[k].segmento],
  ['utm', '/api/admin/utm/campaigns', (j) => j.campanhas.map((c) => String(c.id)), (k) => dados[k].utm],
  ['mídia', '/api/admin/media', (j) => j.assets.map((m) => String(m.id)), (k) => dados[k].midia],
  ['campanhas', '/api/admin/campaigns', (j) => (j.campanhas || j.campaigns || []).map((c) => String(c.id)), (k) => dados[k].campanha],
  ['auditoria (reembolsos)', '/api/admin/reembolsos', (j) => j.reembolsos.map((r) => r.entityId), (k) => `reembolso-${k}`],
];

for (const [nome, rota, extrair, marca] of DOMINIOS) {
  test(`A/B · ${nome}: cada Organization vê só o que é dela`, async () => {
    for (const [k, outro, email] of [['A', 'B', 'srv-a@teste.oria'], ['B', 'A', 'srv-b@teste.oria']]) {
      const nav = await navegador().entrar(email);
      const r = await nav.req('GET', rota);
      assert.equal(r.status, 200, `${k} ${rota}: ${r.texto}`);
      const itens = extrair(r.json);
      assert.ok(itens.includes(marca(k)), `${k} não viu o próprio dado em ${rota}: ${JSON.stringify(itens)}`);
      assert.ok(!itens.includes(marca(outro)), `${k} viu dado de ${outro} em ${rota}`);
    }
  });
}

test('A/B · entitlement por Organization: A tem financeiro, B não', async () => {
  const a = await navegador().entrar('srv-a@teste.oria');
  const ra = await a.req('GET', '/api/admin/financeiro/despesas');
  assert.equal(ra.status, 200, ra.texto);
  assert.deepEqual(ra.json.despesas.map((d) => String(d.id)), [dados.A.despesa]);
  const b = await navegador().entrar('srv-b@teste.oria');
  const rb = await b.req('GET', '/api/admin/financeiro/despesas');
  assert.deepEqual([rb.status, rb.json], [403, { erro: 'feature_nao_disponivel', feature: 'financial' }]);
  // Catálogo já está classificado como capacidade do Connector Ink, mas o guard ainda é o
  // comercial: enquanto `requireEntitlement` conferir `catalog`, quem não tem a chave no plano
  // leva 403. Quando o guard de connector for ligado, esta asserção vira `409`.
  assert.equal((await b.req('GET', '/api/admin/produtos')).status, 403, 'catálogo não semeado → negado');
  const plano = (await b.req('GET', '/api/admin/entitlements')).json;
  assert.equal(plano.financial, false);
  assert.equal(plano.whatsapp, true);
});

test('A/B · recurso por id de outra Organization é 404 e continua intacto', async () => {
  const a = await navegador().entrar('srv-a@teste.oria');
  assert.equal((await a.req('GET', `/api/admin/utm/campaigns/${dados.A.utm}`)).status, 200);
  assert.equal((await a.req('GET', `/api/admin/utm/campaigns/${dados.B.utm}`)).status, 404);
  assert.equal((await a.req('GET', `/api/admin/campaigns/${dados.B.campanha}`)).status, 404);
  assert.equal((await a.req('DELETE', `/api/admin/segments/${dados.B.segmento}`)).status, 404);
  assert.equal((await a.req('DELETE', `/api/admin/financeiro/despesas/${dados.B.despesa}`)).status, 404);
  assert.equal((await a.req('GET', `/api/admin/media/${dados.B.midia}/arquivo`)).status, 404);
  const { rows } = await sup.query('SELECT count(*)::int AS n FROM segments WHERE id = $1', [dados.B.segmento]);
  assert.equal(rows[0].n, 1, 'o segmento de B não pode ter sido apagado');
});

test('A/B · limpeza em massa só apaga a Organization da sessão (nunca TRUNCATE)', async () => {
  const contar = async (tabela, org) => (await sup.query(`SELECT count(*)::int AS n FROM ${tabela} WHERE organization_id = $1`, [org])).rows[0].n;
  const antesB = await Promise.all(['controle_estoque_observacoes', 'meta_campaigns', 'meta_insights_daily'].map((t) => contar(t, ORG_B)));
  assert.ok(antesB.every((n) => n > 0));
  const a = await navegador().entrar('srv-a@teste.oria');
  const limpar = await a.req('POST', '/api/admin/controle-estoque/limpar', { corpo: {} });
  assert.equal(limpar.status, 200, limpar.texto);
  const desconectar = await a.req('POST', '/api/admin/integrations/meta/disconnect', { corpo: {} });
  assert.equal(desconectar.status, 200, desconectar.texto);
  assert.equal(await contar('controle_estoque_observacoes', ORG_A), 0);
  assert.equal(await contar('meta_campaigns', ORG_A), 0);
  assert.equal(await contar('meta_insights_daily', ORG_A), 0);
  const depoisB = await Promise.all(['controle_estoque_observacoes', 'meta_campaigns', 'meta_insights_daily'].map((t) => contar(t, ORG_B)));
  assert.deepEqual(depoisB, antesB, 'a limpeza de A apagou dado de B');
});

test('A/B · escrita sem loja no corpo grava na Store da sessão (UTM)', async () => {
  const b = await navegador().entrar('srv-b@teste.oria');
  const r = await b.req('POST', '/api/admin/utm/campaigns', { corpo: {
    nome: 'utm criada por B', destinationUrl: 'https://exemplo.com/p', source: 'instagram', medium: 'social', campaign: 'fase3',
  } });
  assert.equal(r.status, 200, r.texto);
  const { rows } = await sup.query('SELECT organization_id, loja FROM utm_campaigns WHERE id = $1', [r.json.campanha.id]);
  assert.deepEqual(rows, [{ organization_id: ORG_B, loja: 'centro' }]);
  const comLoja = await b.req('POST', '/api/admin/utm/campaigns', { corpo: {
    loja: 'sul', nome: 'x', destinationUrl: 'https://exemplo.com/p', source: 'a', medium: 'b', campaign: 'c',
  } });
  assert.equal(comLoja.status, 400);
});

test('A/B · seletor de tenant em rota real é 400', async () => {
  const a = await navegador().entrar('srv-a@teste.oria');
  for (const q of ['loja=centro', `organization_id=${ORG_B}`, 'store_id=x']) {
    const r = await a.req('GET', `/api/admin/clientes?${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.json.codigo, 'TENANT_SELECTOR_NOT_ALLOWED');
  }
  const r = await a.req('GET', '/api/admin/clientes', { headers: { 'X-Organization-Id': ORG_B } });
  assert.equal(r.status, 400);
});

test('A/B · User C escolhe o workspace no servidor real', async () => {
  const c = await navegador().entrar('srv-c@teste.oria');
  assert.equal((await c.req('GET', '/api/admin/clientes')).status, 409);
  assert.equal((await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_B } })).status, 200);
  const emB = await c.req('GET', '/api/admin/clientes');
  assert.deepEqual(emB.json.clientes.map((x) => x.nome), ['Cliente B']);
  assert.equal((await c.req('GET', '/api/admin/financeiro/despesas')).status, 403, 'plano de B, não o de A');
  await c.req('POST', '/api/admin/session/organization', { corpo: { organizationId: ORG_A } });
  assert.deepEqual((await c.req('GET', '/api/admin/clientes')).json.clientes.map((x) => x.nome), ['Cliente A']);
});

test('A/B · link público do pedido resolve a Organization dona pelo id', async () => {
  for (const k of ['A', 'B']) {
    const r = await fetch(`${base}/api/pedidos/${dados[k].pedido}`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).cliente, `Cliente ${k}`);
    const qr = await fetch(`${base}/assets/pedidos/${dados[k].pedido}.png`);
    assert.equal(qr.status, 200);
  }
  assert.equal((await fetch(`${base}/api/pedidos/${crypto.randomBytes(9).toString('base64url')}`)).status, 404);
});

async function esperar(condicao, ms = 5000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await condicao()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const assinaturaInk = (segredo, corpo) => Buffer.from(crypto.createHmac('sha256', segredo).update(corpo).digest('hex')).toString('base64');
const SEGREDO_WEBHOOK_B = crypto.randomBytes(16).toString('hex');
const urlsInk = {};
const gravados = async (marca) => (await sup.query(`SELECT organization_id, loja FROM webhook_eventos WHERE body->>'marca' = $1`, [marca])).rows;
const entregarInk = (caminho, corpo, segredo) => fetch(`${base}${caminho}`, {
  method: 'POST', body: corpo,
  headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': segredo ? assinaturaInk(segredo, corpo) : 'bm9wZQ==' },
});

test('TD-005 · só owner emite a URL do webhook; o caminho volta uma vez e o segredo fica no cofre', async () => {
  const membro = await navegador().entrar('srv-am@teste.oria');
  assert.equal((await membro.req('POST', '/api/admin/integrations/ink/webhook-url', { corpo: {} })).status, 403);
  for (const [email, segredo, chave] of [['srv-a@teste.oria', SEGREDO_WEBHOOK_SUL, 'A'], ['srv-b@teste.oria', SEGREDO_WEBHOOK_B, 'B']]) {
    const nav = await navegador().entrar(email);
    assert.equal((await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { webhookSecret: 'curto' } })).status, 400);
    const put = await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { webhookSecret: segredo } });
    assert.equal(put.status, 200, put.texto);
    assert.ok(!put.texto.includes(segredo));
    const r = await nav.req('POST', '/api/admin/integrations/ink/webhook-url', { corpo: {} });
    assert.equal(r.status, 200, r.texto);
    assert.match(r.json.caminho, /^\/api\/webhooks\/ink\/[A-Za-z0-9_-]{43}$/);
    urlsInk[chave] = r.json.caminho;
    const status = await nav.req('GET', '/api/admin/integrations/ink/credenciais');
    assert.deepEqual([status.json.webhook.urlEmitida, status.json.webhook.segredoCadastrado], [true, true]);
    assert.ok(!status.texto.includes(r.json.caminho.split('/').pop()), 'a tela não recebe o token de novo');
  }
  assert.notEqual(urlsInk.A, urlsInk.B);
});

test('INV-15 · webhook Ink: URL de A + assinatura de A grava só em A; sem assinatura válida nada é gravado', async () => {
  const corpo = JSON.stringify({ event: 'teste.fase5c', marca: crypto.randomUUID() });
  const assinado = await entregarInk(urlsInk.A, corpo, SEGREDO_WEBHOOK_SUL);
  assert.equal(assinado.status, 200);
  const marca = JSON.parse(corpo).marca;
  const gravou = await esperar(async () => (await gravados(marca)).length > 0);
  assert.ok(gravou, `evento assinado não gravado:\n${saida.slice(-1500)}`);
  assert.deepEqual(await gravados(marca), [{ organization_id: ORG_A, loja: 'sul' }]);

  const falso = JSON.stringify({ event: 'teste.fase5c', marca: crypto.randomUUID() });
  assert.equal((await entregarInk(urlsInk.A, falso, null)).status, 401);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await gravados(JSON.parse(falso).marca)).length, 0);

  const a = await navegador().entrar('srv-a@teste.oria');
  const logA = (await a.req('GET', '/api/admin/webhook-log')).json.log;
  assert.ok(logA.some((e) => e.body && e.body.marca === marca));
  const b = await navegador().entrar('srv-b@teste.oria');
  assert.ok(!(await b.req('GET', '/api/admin/webhook-log')).json.log.some((e) => e.body && e.body.marca === marca));
});

test('INV-15 · assinado por A e entregue na URL de B é recusado e NÃO roteado para A', async () => {
  const corpo = JSON.stringify({ event: 'teste.cruzado', marca: crypto.randomUUID() });
  assert.equal((await entregarInk(urlsInk.B, corpo, SEGREDO_WEBHOOK_SUL)).status, 401);
  const corpo2 = JSON.stringify({ event: 'teste.cruzado', marca: crypto.randomUUID() });
  assert.equal((await entregarInk(urlsInk.A, corpo2, SEGREDO_WEBHOOK_B)).status, 401);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await gravados(JSON.parse(corpo).marca)).length, 0);
  assert.equal((await gravados(JSON.parse(corpo2).marca)).length, 0);
  // B com a URL e o segredo dele: grava em B.
  const certo = JSON.stringify({ event: 'teste.b', marca: crypto.randomUUID() });
  assert.equal((await entregarInk(urlsInk.B, certo, SEGREDO_WEBHOOK_B)).status, 200);
  assert.ok(await esperar(async () => (await gravados(JSON.parse(certo).marca)).length === 1));
  assert.deepEqual(await gravados(JSON.parse(certo).marca), [{ organization_id: ORG_B, loja: 'centro' }]);
});

test('TD-005 · URL desconhecida é 404, a entrada legada não existe mais e rotação invalida a URL antiga', async () => {
  const corpo = JSON.stringify({ event: 'teste.legado', marca: crypto.randomUUID() });
  // A URL antiga (única) com o segredo legado do ambiente: não aceita.
  const legado = await fetch(`${base}/api/webhooks/ink`, {
    method: 'POST', body: corpo, headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': assinaturaInk(SEGREDO_WEBHOOK_SUL, corpo) },
  });
  assert.equal(legado.status, 404);
  assert.equal((await entregarInk(`/api/webhooks/ink/${crypto.randomBytes(32).toString('base64url')}`, corpo, SEGREDO_WEBHOOK_SUL)).status, 404);
  assert.equal((await entregarInk('/api/webhooks/ink/curto', corpo, SEGREDO_WEBHOOK_SUL)).status, 404);

  const a = await navegador().entrar('srv-a@teste.oria');
  const nova = await a.req('POST', '/api/admin/integrations/ink/webhook-url', { corpo: {} });
  assert.equal(nova.status, 200);
  assert.equal((await entregarInk(urlsInk.A, corpo, SEGREDO_WEBHOOK_SUL)).status, 404, 'URL anterior deixou de valer');
  const corpo2 = JSON.stringify({ event: 'teste.rotacao', marca: crypto.randomUUID() });
  assert.equal((await entregarInk(nova.json.caminho, corpo2, SEGREDO_WEBHOOK_SUL)).status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal((await gravados(JSON.parse(corpo).marca)).length, 0);
  for (const caminho of [urlsInk.A, urlsInk.B, nova.json.caminho]) {
    assert.ok(!saida.includes(caminho.split('/').pop()), 'token da URL no log');
  }
  assert.ok(!saida.includes(SEGREDO_WEBHOOK_B) && !saida.includes(SEGREDO_WEBHOOK_SUL), 'segredo no log');
  urlsInk.A = nova.json.caminho;
});

function assinarRepasseWa(corpo, ts = String(Math.floor(Date.now() / 1000))) {
  const assinatura = `v1=${crypto.createHmac('sha256', SEGREDO_REPASSE_WA).update(`${ts}.`).update(corpo).digest('hex')}`;
  return { 'Content-Type': 'application/json', 'X-Oria-Forward-Timestamp': ts, 'X-Oria-Forward-Signature': assinatura };
}

test('§22 · repasse do WhatsApp só com assinatura em header; ?secret= e repasse sem assinatura são recusados', async () => {
  const corpo = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: dados.A.wamid, status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
  const url = `${base}/api/webhooks/whatsapp`;
  const recusas = {
    'sem assinatura': await fetch(url, { method: 'POST', body: corpo, headers: { 'Content-Type': 'application/json' } }),
    'segredo na query (formato antigo)': await fetch(`${url}?secret=${encodeURIComponent(SEGREDO_REPASSE_WA)}`, { method: 'POST', body: corpo, headers: { 'Content-Type': 'application/json' } }),
    'segredo na query + assinatura certa': await fetch(`${url}?secret=${encodeURIComponent(SEGREDO_REPASSE_WA)}`, { method: 'POST', body: corpo, headers: assinarRepasseWa(corpo) }),
    'assinatura de outro corpo': await fetch(url, { method: 'POST', body: corpo.replace('read', 'delivered'), headers: assinarRepasseWa(corpo) }),
    'timestamp velho': await fetch(url, { method: 'POST', body: corpo, headers: assinarRepasseWa(corpo, String(Math.floor(Date.now() / 1000) - 3600)) }),
  };
  for (const [nome, r] of Object.entries(recusas)) assert.equal(r.status, 401, nome);
  await new Promise((res) => setTimeout(res, 300));
  const { rows } = await sup.query('SELECT status FROM campaign_recipients WHERE provider_message_id = $1', [dados.A.wamid]);
  assert.equal(rows[0].status, 'sent', 'repasse recusado não pode alterar status');
  assert.ok(!saida.includes(SEGREDO_REPASSE_WA), 'segredo do repasse no log');
  assert.match(saida, /repasse recusado \(401\): segredo na query string recusado/);
});

test('A/B · status do WhatsApp pelo wamid só altera o destinatário da Organization dona', async () => {
  const corpo = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: dados.B.wamid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)) }] } }] }] });
  const r = await fetch(`${base}/api/webhooks/whatsapp`, { method: 'POST', body: corpo, headers: assinarRepasseWa(corpo) });
  assert.equal(r.status, 200);
  const ok = await esperar(async () => (await sup.query(
    `SELECT status FROM campaign_recipients WHERE provider_message_id = $1`, [dados.B.wamid]
  )).rows[0].status === 'delivered');
  assert.ok(ok, `status não aplicado:\n${saida.slice(-1500)}`);
  const { rows } = await sup.query(`SELECT status FROM campaign_recipients WHERE provider_message_id = $1`, [dados.A.wamid]);
  assert.equal(rows[0].status, 'sent');
});

test('INV-22 · Creative Core no servidor real grava na Organization da sessão, não na env', async () => {
  await concederFeatures(sup, ORG_A, ['financial', 'whatsapp', 'refunds', 'catalog', 'creative_generator']);
  const a = await navegador().entrar('srv-a@teste.oria');
  const r = await a.req('PUT', '/api/admin/criativos/settings/openai-key', { corpo: { apiKey: 'sk-fase3-aaaaaaaaaaaaaaaaaaaaaaaa' } });
  assert.equal(r.status, 200, r.texto);
  // Fase 4: a chave é a integração 'openai' da Organization da sessão (integration_secrets).
  const { rows } = await sup.query(
    `SELECT i.organization_id, s.tipo FROM integration_secrets s JOIN integrations i ON i.id = s.integration_id
      WHERE i.provider = 'openai'`
  );
  assert.deepEqual(rows, [{ organization_id: ORG_A, tipo: 'api_key' }]);
});

test('INV-17 · os jobs do processo rodam sob a role da aplicação sem erro de contexto', async () => {
  // A rodada inicial das redes de segurança dispara 5s depois do boot, por Organization.
  await new Promise((r) => setTimeout(r, 6000));
  assert.doesNotMatch(saida, /TENANT_CONTEXT_REQUIRED|sem contexto de Organization|row-level security|permission denied/i, saida.slice(-3000));
});
