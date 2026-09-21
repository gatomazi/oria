'use strict';

// Rodada de integrações core (2026-09-20) · Connector Ink na Store nativa (`loja_legada = NULL`):
// Produtos, Categorias, Agrupamentos, cache do catálogo, status, backfill de pedidos, jobs de
// categoria em lote e webhook — por `organization_id + store_id`, sem chave legada.
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

  // Linha ANTIGA do cache de A (sem store_id, só a chave legada): o sync a reivindica por mapeamento
  // explícito em vez de duplicar.
  await inserir(sup, 'produtos_ink', { organization_id: ORGS.A, store_id: null, loja: 'sul', produto_id: 3001, name: 'Produto antigo A1' });

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

// ── Credencial e teste de conexão ─────────────────────────────────────────────────────────────

test('credencial · o token fica cifrado e nunca volta em resposta; feed não é requisito', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', '/api/admin/integrations/ink/credenciais');
  assert.equal(r.status, 200, r.texto);
  assert.ok(!r.texto.includes(TOKEN.C), 'o token não pode voltar na resposta');
  assert.ok(!r.texto.includes(SEGREDO_WEBHOOK.C), 'o segredo do webhook não pode voltar na resposta');
  assert.ok(r.json.segredos.some((s) => s.tipo === 'api_token' && s.last4 === TOKEN.C.slice(-4)));
  assert.ok(!r.json.segredos.some((s) => s.tipo === 'feed_url'), 'a Store nativa conecta sem feed');
  const { rows } = await sup.query("SELECT tipo, ciphertext FROM integration_secrets WHERE organization_id = $1 AND tipo = 'api_token'", [ORGS.C]);
  assert.equal(rows.length, 1);
  assert.ok(!String(rows[0].ciphertext).includes(TOKEN.C), 'o token está cifrado no banco');

  const status = await c.req('GET', '/api/admin/integrations');
  assert.equal(status.status, 200, status.texto);
  assert.equal(status.json.reservaInk[0].tokenConfigurado, true);
});

test('teste de conexão · read-only, com a credencial da Organization, sem feed', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/integrations/ink/teste', { corpo: {} });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.status, 'connected');
  assert.ok(!r.texto.includes(TOKEN.C));
  // A API da Ink está conectada com o token; o webhook é OUTRA parte e está adiado de propósito — sem
  // ele a integração NÃO fica "pendente". O teste de conexão não fabrica um webhook que não existe.
  const status = await c.req('GET', '/api/admin/integrations');
  assert.equal(status.json.ink.status, 'conectada');
  assert.equal(status.json.ink.conectado, true);
  assert.equal(status.json.ink.webhook, 'adiado');
  const ink = status.json.integracoes.find((i) => i.provider === 'ink');
  assert.equal(ink.estado, 'connected');
  assert.deepEqual(ink.componentes, { api: 'connected', webhook: 'deferred' });
});

// ── Produtos, Categorias, Agrupamentos (ao vivo, pela credencial da Store) ────────────────────

test('Produtos · Store nativa lista pela API da Ink com a credencial da PRÓPRIA Organization', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', '/api/admin/produtos?fonte=ink&per_page=20');
  assert.equal(r.status, 200, `Produtos não pode exigir chave legada: ${r.texto}`);
  assert.deepEqual(r.json.produtos.map((p) => p.id).sort(), [1001, 1002, 1003]);
  const d = await (await entrar('D')).req('GET', '/api/admin/produtos?fonte=ink&per_page=20');
  assert.deepEqual(d.json.produtos.map((p) => p.id).sort(), [2001, 2002, 2003], 'D lê o catálogo da credencial dela');
  const tipos = await c.req('GET', '/api/admin/produto-tipos');
  assert.equal(tipos.status, 200, tipos.texto);
  assert.equal(tipos.json.tipos[0].id, 1010);
  const um = await c.req('GET', '/api/admin/produtos/1001');
  assert.equal(um.status, 200, um.texto);
});

test('Categorias · lista, detalhe e criação na Store nativa', async () => {
  const c = await entrar('C');
  const lista = await c.req('GET', '/api/admin/categorias');
  assert.equal(lista.status, 200, `Categorias não pode exigir chave legada: ${lista.texto}`);
  assert.deepEqual(lista.json.categorias.map((x) => x.id), [1100]);
  // A listagem devolve só a CONTAGEM (os ids completos ficam no detalhe): sem isso a tela carregava centenas de KB
  // de ids só para mostrar um número.
  assert.equal(lista.json.categorias[0].product_count, 0);
  assert.ok(!('product_ids' in lista.json.categorias[0]), 'a lista não carrega product_ids');
  const um = await c.req('GET', '/api/admin/categorias/1100');
  assert.equal(um.status, 200, um.texto);
  const nova = await c.req('POST', '/api/admin/categorias', { corpo: { name: 'Teste nativa' } });
  assert.equal(nova.status, 201, nova.texto);
  assert.equal(nova.json.categoria.id, 1101);
  const d = await (await entrar('D')).req('GET', '/api/admin/categorias');
  assert.deepEqual(d.json.categorias.map((x) => x.id), [2100], 'D não vê as categorias de C');
  assert.equal(d.json.categorias[0].product_count, 3, 'a lista devolve a contagem de product_ids');
  assert.ok(!('product_ids' in d.json.categorias[0]), 'a lista não carrega os ids completos');
});

test('Categorias e Agrupamentos · paginação: `page` chega à Ink, os totais voltam e valor inválido não vira consulta livre', async () => {
  const c = await entrar('C');
  const cat = await c.req('GET', '/api/admin/categorias?page=2&per_page=20');
  assert.equal(cat.status, 200, cat.texto);
  assert.equal(cat.json.page, 2);
  assert.equal(cat.json.totalPages, 3, 'o total de páginas é o da Ink');
  assert.equal(cat.json.totalCount, 60);
  const agr = await c.req('GET', '/api/admin/agrupamentos?page=3&per_page=20');
  assert.equal(agr.status, 200, agr.texto);
  assert.equal(agr.json.page, 3);
  assert.equal(agr.json.totalPages, 3);
  // Sem `page` (seletores): comportamento de sempre, uma página só.
  const sem = await c.req('GET', '/api/admin/categorias');
  assert.equal(sem.json.totalPages, 1);
  // `page` que não é inteiro na faixa cai no modo sem paginação — nunca é repassado cru à Ink.
  for (const ruim of ['0', '-1', 'abc', '1001', '2;drop']) {
    const r = await c.req('GET', `/api/admin/categorias?page=${encodeURIComponent(ruim)}`);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.totalPages, 1, `page=${ruim} não pagina`);
  }
});

test('Agrupamentos · lista e detalhe na Store nativa, por credencial', async () => {
  const c = await entrar('C');
  const lista = await c.req('GET', '/api/admin/agrupamentos');
  assert.equal(lista.status, 200, `Agrupamentos não pode exigir chave legada: ${lista.texto}`);
  assert.equal(lista.json.agrupamentos.length, 1);
  assert.equal(lista.json.agrupamentos[0].id, 1200);
  const um = await c.req('GET', '/api/admin/agrupamentos/1200');
  assert.equal(um.status, 200, um.texto);
  const d = await (await entrar('D')).req('GET', '/api/admin/agrupamentos');
  assert.equal(d.json.agrupamentos[0].id, 2200);
});

// ── Cache do catálogo e status ────────────────────────────────────────────────────────────────

async function sincronizarCatalogo(nav) {
  const r = await nav.req('POST', '/api/admin/produtos/catalogo/sync', { corpo: {} });
  assert.equal(r.status, 200, r.texto);
  const pronto = await ate(async () => {
    const s = await nav.req('GET', '/api/admin/produtos/catalogo/status');
    const l = s.json && s.json.lojas && s.json.lojas[0];
    return l && !l.sincronizando && l.concluidoEm ? l : null;
  });
  assert.ok(pronto, 'o sync do catálogo não terminou');
  return pronto;
}

test('catálogo · status da Store nativa: 200 (era 500), configurado, sem exigir chave legada', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', '/api/admin/produtos/catalogo/status');
  assert.equal(r.status, 200, `o status do catálogo não pode ser 500: ${r.texto}`);
  const [l] = r.json.lojas;
  assert.equal(l.storeId, store.C);
  assert.equal(l.loja, null);
  assert.equal(l.configurado, true, 'o token Ink existe: "Nenhuma loja conectada" é o defeito');
  assert.equal(l.total, 0);
  assert.equal(l.erro, null);
});

test('catálogo · sync da Store nativa grava com store_id e loja NULL; a busca passa a responder do cache', async () => {
  const c = await entrar('C');
  const l = await sincronizarCatalogo(c);
  assert.equal(l.erro, null);
  assert.equal(l.total, 3);
  const { rows } = await sup.query('SELECT store_id, loja, produto_id FROM produtos_ink WHERE organization_id = $1 ORDER BY produto_id', [ORGS.C]);
  assert.deepEqual(rows.map((x) => x.produto_id).map(Number), [1001, 1002, 1003]);
  for (const linha of rows) {
    assert.equal(linha.store_id, store.C);
    assert.equal(linha.loja, null, 'a Store nativa nunca ganha chave legada');
  }
  const { rows: [sync] } = await sup.query('SELECT store_id, loja, total FROM produtos_ink_sync WHERE organization_id = $1', [ORGS.C]);
  assert.equal(sync.store_id, store.C);
  assert.equal(sync.loja, null);

  const lista = await c.req('GET', '/api/admin/produtos?per_page=20');
  assert.equal(lista.status, 200, lista.texto);
  assert.equal(lista.json.fonte, 'catalogo', 'agora a tela responde do cache');
  assert.equal(lista.json.totalCount, 3);

  // Idempotência: sincronizar de novo não duplica.
  await sincronizarCatalogo(c);
  const { rows: [n] } = await sup.query('SELECT count(*)::int AS n FROM produtos_ink WHERE organization_id = $1', [ORGS.C]);
  assert.equal(n.n, 3);
});

test('catálogo · isolamento: D sincroniza o dela e C nunca enxerga; A (legada) reivindica a linha antiga sem duplicar', async () => {
  const d = await entrar('D');
  await sincronizarCatalogo(d);
  const listaD = await d.req('GET', '/api/admin/produtos?per_page=20');
  assert.deepEqual(listaD.json.produtos.map((p) => p.id).sort(), [2001, 2002, 2003]);
  const listaC = await (await entrar('C')).req('GET', '/api/admin/produtos?per_page=20');
  assert.deepEqual(listaC.json.produtos.map((p) => p.id).sort(), [1001, 1002, 1003], 'C só vê o catálogo dela');

  const a = await entrar('A');
  const la = await sincronizarCatalogo(a);
  assert.equal(la.total, 3);
  assert.equal(la.loja, 'sul', 'compatibilidade: a Store legada continua exposta pela chave');
  const { rows } = await sup.query('SELECT store_id, loja, produto_id FROM produtos_ink WHERE organization_id = $1 ORDER BY produto_id', [ORGS.A]);
  assert.equal(rows.length, 3, 'a linha antiga (3001) foi reivindicada, não duplicada');
  for (const linha of rows) {
    assert.equal(linha.store_id, store.A);
    assert.equal(linha.loja, 'sul');
  }
});

test('catálogo · pausar a renovação automática e ler o estado, na Store nativa', async () => {
  const c = await entrar('C');
  const r = await c.req('PUT', '/api/admin/produtos/catalogo/config', { corpo: { pausado: true } });
  assert.equal(r.status, 200, `a config do catálogo não pode exigir chave legada: ${r.texto}`);
  assert.equal(r.json.autoPausado, true);
  const s = await c.req('GET', '/api/admin/produtos/catalogo/status');
  assert.equal(s.json.lojas[0].autoPausado, true);
  await c.req('PUT', '/api/admin/produtos/catalogo/config', { corpo: { pausado: false } });
});

test('feed legado · não é requisito: status sem erro e sync explicitamente descontinuado (410)', async () => {
  const c = await entrar('C');
  const st = await c.req('GET', '/api/admin/produtos/feed/status');
  assert.equal(st.status, 200, `o feed descontinuado não pode virar erro de integração: ${st.texto}`);
  assert.deepEqual(st.json, { lojas: [], descontinuado: true });
  const sync = await c.req('POST', '/api/admin/produtos/feed/sync', { corpo: {} });
  assert.equal(sync.status, 410, sync.texto);
  assert.equal(sync.json.codigo, 'FEED_DEPRECATED');
});

// ── Backfill histórico de pedidos ─────────────────────────────────────────────────────────────

test('pedidos · backfill histórico da Store nativa: cria job com store_id, conclui e ingere o pedido por Store', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/pedidos/backfill-historico', { corpo: {} });
  assert.equal(r.status, 202, `o backfill não pode exigir chave legada: ${r.texto}`);
  const jobId = r.json.jobId;
  const job = await ate(async () => {
    const j = await c.req('GET', `/api/admin/pedidos/backfill-historico/${jobId}`);
    return j.json && j.json.job && j.json.job.status !== 'processando' ? j.json.job : null;
  });
  assert.ok(job, 'o job não terminou');
  assert.equal(job.status, 'concluido', job.erro);
  assert.equal(job.store_id, store.C);
  assert.equal(job.loja, null);
  const { rows } = await sup.query('SELECT store_id, loja, ink_order_id FROM pedidos_ink WHERE organization_id = $1', [ORGS.C]);
  assert.deepEqual(rows.map((x) => Number(x.ink_order_id)), [1500]);
  assert.equal(rows[0].store_id, store.C);
  assert.equal(rows[0].loja, null);

  const lista = await c.req('GET', '/api/admin/pedidos/backfill-historico');
  assert.equal(lista.status, 200, lista.texto);
  assert.equal(lista.json.jobs.length, 1);
  const d = await (await entrar('D')).req('GET', '/api/admin/pedidos/backfill-historico');
  assert.equal(d.json.jobs.length, 0, 'os jobs de C não aparecem para D');
});

// ── Webhook ───────────────────────────────────────────────────────────────────────────────────

const assinar = (segredo, corpo) => Buffer.from(crypto.createHmac('sha256', segredo).update(corpo).digest('hex')).toString('base64');

async function urlDoWebhook(letra) {
  const nav = await entrar(letra);
  const r = await nav.req('POST', '/api/admin/integrations/ink/webhook-url', { corpo: {} });
  assert.equal(r.status, 200, `gerar a URL do webhook não pode exigir chave legada: ${r.texto}`);
  return r.json.caminho;
}

async function entregar(caminho, segredo, evento) {
  const corpo = JSON.stringify(evento);
  const res = await fetch(base + caminho, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': assinar(segredo, corpo) }, body: corpo,
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

test('webhook · evento assinado da Store nativa é verificado, associado à Organization/Store e o pedido é ingerido', async () => {
  const caminhoC = await urlDoWebhook('C');
  const conectada = await (await entrar('C')).req('GET', '/api/admin/integrations');
  assert.equal(conectada.json.ink.status, 'conectada', 'token = API conectada');
  assert.equal(conectada.json.ink.webhook, 'configurado', 'URL + segredo do webhook = webhook configurado');
  assert.equal(conectada.json.ink.conectado, true);
  const status = await entregar(caminhoC, SEGREDO_WEBHOOK.C, { event: 'order.paid', order_id: 7001 });
  assert.equal(status, 200);
  const ingerido = await ate(async () => {
    const { rows } = await sup.query('SELECT store_id, loja FROM pedidos_ink WHERE organization_id = $1 AND ink_order_id = 7001', [ORGS.C]);
    return rows[0] || null;
  });
  assert.ok(ingerido, 'o pedido do webhook não foi ingerido');
  assert.equal(ingerido.store_id, store.C);
  assert.equal(ingerido.loja, null);
  const { rows: eventos } = await sup.query('SELECT store_id, loja, verificado, ink_order_id, event_name FROM webhook_eventos WHERE organization_id = $1', [ORGS.C]);
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].store_id, store.C, 'o evento identifica organization_id + store_id sem inferir por chave legada');
  assert.equal(eventos[0].loja, null);
  assert.equal(eventos[0].verificado, true);
  assert.doesNotMatch(saida, /falha ao processar entrega|não tem loja legada/);

  // Idempotência: a mesma entrega de novo atualiza o mesmo pedido (um registro), e o evento é auditado.
  assert.equal(await entregar(caminhoC, SEGREDO_WEBHOOK.C, { event: 'order.paid', order_id: 7001 }), 200);
  await ate(async () => {
    const { rows } = await sup.query('SELECT count(*)::int AS n FROM webhook_eventos WHERE organization_id = $1', [ORGS.C]);
    return rows[0].n === 2;
  });
  const { rows: [n] } = await sup.query('SELECT count(*)::int AS n FROM pedidos_ink WHERE organization_id = $1 AND ink_order_id = 7001', [ORGS.C]);
  assert.equal(n.n, 1, 'o pedido não duplica');
});

test('webhook · cross-tenant: assinatura de D na URL de C é recusada e nada é gravado; URL desconhecida é 404', async () => {
  const caminhoC = await urlDoWebhook('C');
  const antes = (await sup.query('SELECT count(*)::int AS n FROM pedidos_ink WHERE ink_order_id = 7002')).rows[0].n;
  assert.equal(await entregar(caminhoC, SEGREDO_WEBHOOK.D, { event: 'order.paid', order_id: 7002 }), 401);
  await esperar(300);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM pedidos_ink WHERE ink_order_id = 7002')).rows[0].n, antes, 'nada foi ingerido');
  assert.equal(await entregar('/api/webhooks/ink/' + 'x'.repeat(43), SEGREDO_WEBHOOK.C, { event: 'order.paid', order_id: 7003 }), 404);

  // A entrega legítima de D vai para D, nunca para C.
  const caminhoD = await urlDoWebhook('D');
  assert.equal(await entregar(caminhoD, SEGREDO_WEBHOOK.D, { event: 'order.paid', order_id: 7004 }), 200);
  await ate(async () => (await sup.query('SELECT 1 FROM pedidos_ink WHERE organization_id = $1 AND ink_order_id = 7004', [ORGS.D])).rows.length);
  assert.equal((await sup.query('SELECT count(*)::int AS n FROM pedidos_ink WHERE organization_id = $1 AND ink_order_id = 7004', [ORGS.C])).rows[0].n, 0);
});

// ── Segredos, logs e processo ─────────────────────────────────────────────────────────────────

test('segurança · nenhum token, segredo ou URL de webhook aparece no log do processo', () => {
  for (const segredo of [...Object.values(TOKEN), ...Object.values(SEGREDO_WEBHOOK)]) {
    assert.ok(!saida.includes(segredo), 'um segredo vazou para o log do processo');
  }
});

test('processo · zero UNHANDLED_REJECTION e nenhuma falha por chave legada nos fluxos do Ink', async () => {
  await esperar(300);
  assert.doesNotMatch(saida, /UNHANDLED_REJECTION/, `rejeição não tratada no log:\n${saida.slice(-1500)}`);
  assert.doesNotMatch(saida, /não tem loja legada|STORE_WITHOUT_LEGACY_KEY/);
});

// ── Fonte: os domínios migrados não voltam a exigir a chave legada ────────────────────────────

function blocoDe(fonte, assinatura) {
  const inicio = fonte.indexOf(assinatura);
  assert.ok(inicio >= 0, `não encontrado: ${assinatura}`);
  const fechamento = assinatura.startsWith('app.') ? '\n});' : '\n}\n';
  const fim = fonte.indexOf(fechamento, inicio);
  assert.ok(fim > inicio, `fim do bloco não encontrado: ${assinatura}`);
  return fonte.slice(inicio, fim + fechamento.length);
}

test('fonte · Produtos, Categorias, Agrupamentos, catálogo, backfill e webhook não chamam lojaLegadaDoContexto()', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  const rotas = fonte.match(/^app\.(get|post|put|patch|delete)\('\/api\/admin\/(produtos|produto-tipos|categorias|category-assignments|agrupamentos)[^']*'/gm) || [];
  const legadasPorDesenho = new Set(["app.get('/api/admin/produtos/feed/status'", "app.post('/api/admin/produtos/feed/sync'"]);
  assert.ok(rotas.length >= 15, `poucas rotas do domínio encontradas (${rotas.length})`);
  for (const assinatura of rotas) {
    if (legadasPorDesenho.has(assinatura.replace(/'$/, "'"))) continue;
    assert.doesNotMatch(blocoDe(fonte, assinatura), /lojaLegadaDoContexto\(\)/, `${assinatura} voltou a exigir a chave legada`);
  }
  for (const assinatura of [
    "app.post('/api/admin/pedidos/backfill-historico'", "app.get('/api/admin/pedidos/backfill-historico'",
    "app.post('/api/webhooks/ink/:token'",
    'async function sincronizarCatalogoInk()', 'async function gravarLoteCatalogo(', 'async function buscarProdutosNoCatalogo(',
    'async function processarEventoWebhook(',
  ]) {
    assert.doesNotMatch(blocoDe(fonte, assinatura), /lojaLegadaDoContexto\(\)/, `${assinatura} voltou a exigir a chave legada`);
  }
  // O job periódico do catálogo enumera a Store do contexto, não só as que têm chave legada.
  assert.match(blocoDe(fonte, 'async function sincronizarCatalogoInkDaOrganizacao('), /storesInkDoContexto\(\)/);
});

test('fonte · escritas do catálogo e dos jobs carregam store_id (nenhum write novo só por loja)', () => {
  const fonte = fs.readFileSync(SERVER, 'utf8');
  assert.match(blocoDe(fonte, 'async function gravarLoteCatalogo('), /INSERT INTO produtos_ink \(store_id, loja,/);
  assert.match(blocoDe(fonte, 'async function sincronizarCatalogoInk()'), /INSERT INTO produtos_ink_sync \(store_id, loja,/);
  assert.match(blocoDe(fonte, "app.post('/api/admin/pedidos/backfill-historico'"), /INSERT INTO pedidos_backfill_jobs \(store_id, loja,/);
});
