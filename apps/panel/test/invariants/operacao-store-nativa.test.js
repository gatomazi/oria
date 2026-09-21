'use strict';

// Operação · Trocas, Reembolsos por pedido e Promoções na Store nativa (`loja_legada = NULL`).
//
// Estes fluxos falam com a API da Reserva Ink. Eles liam a credencial pela CHAVE LEGADA da loja
// (`lojaLegadaDoContexto()` + `inkApiRequest(loja, …)`), então uma Store nativa recebia 409 antes de
// chegar à Ink. Agora usam a credencial da Organization/Store do contexto — a mesma que Produtos,
// Categorias e Agrupamentos já usavam. O provider mock devolve ids de faixas diferentes por token
// (C = 1xxx, D = 2xxx): a faixa do id prova QUAL credencial foi usada em cada chamada.
//
// Trocas ≠ reembolso: a troca é uma solicitação de troca de item; o reembolso devolve valor. Nenhum
// dos dois chama o outro — o teste confere que cada rota só toca o seu endpoint.

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
const { limparCache, concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const ORGS = {
  A: 'a1000000-0000-4000-8000-000000000001',
  C: 'a1000000-0000-4000-8000-00000000000c',
  D: 'a1000000-0000-4000-8000-00000000000d',
};
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_op_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
// 4ª letra do token = "loja de teste" do provider mock.
const TOKEN = {
  A: `inkA-carrinho-${crypto.randomBytes(10).toString('hex')}`,
  C: `inkC-carrinho-${crypto.randomBytes(10).toString('hex')}`,
  D: `inkD-carrinho-${crypto.randomBytes(10).toString('hex')}`,
};
let dirMock;
let goFalso;
let urlGoFalso;
let metaRecusaToken = false;

let db;
let sup;
let filho;
let saida = '';
let base;
const store = {};
const email = (l) => `op-${l.toLowerCase()}@teste.oria`;

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
  await concederFeatures(sup, ORGS[letra], { financial: true, catalog: true, exchanges: true, refunds: true, whatsapp: true, creative_generator: true });
}

function subirServidor() {
  return h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dirMock, UPLOADS_DIR: path.join(dirMock, 'uploads'),
      PORT: String(porta), NODE_ENV: 'development', NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'),
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: path.join(dirMock, 'chamadas.jsonl'),
      // Serviço de WhatsApp (Go) falso: devolve, como o real, o erro da Meta embutido numa string.
      WHATSAPP_SERVICE_URL: urlGoFalso, WHATSAPP_API_KEY: 'k'.repeat(24), WHATSAPP_SENDER_REF_SECRET: crypto.randomBytes(32).toString('hex'),
    },
  }), {
    aoLer: (pedaco, { reiniciando }) => { saida = reiniciando ? '' : saida + pedaco; },
    limiteMs: 30000,
  });
}

test.before(async () => {
  goFalso = require('node:http').createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/health')) return res.end(JSON.stringify({ status: 'ok' }));
    if (!metaRecusaToken && req.url.startsWith('/templates/list')) {
      return res.end(JSON.stringify({ success: true, data: { data: [{ name: 'recupera_carrinho', status: 'APPROVED', language: 'pt_BR', components: [{ type: 'BODY', text: 'Olá {{1}}, seu carrinho ficou esperando.' }] }] } }));
    }
    res.statusCode = 500;
    return res.end(JSON.stringify({ success: false, error: 'meta api 401: {"error":{"message":"Error validating access token: Session has expired on Sunday, 20-Sep-26 16:00:00 PDT.","type":"OAuthException","code":190,"error_subcode":463,"fbtrace_id":"AgNIN"}}' }));
  });
  await new Promise((resolve) => goFalso.listen(0, '127.0.0.1', resolve));
  urlGoFalso = `http://127.0.0.1:${goFalso.address().port}`;
  db = await h.criarBancoDescartavel('oria_op_srv');
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-op-srv-'));
  dirMock = dir;
  const processo = await subirServidor();
  filho = processo.filho;
  base = processo.base;

  // A credencial (e o segredo do webhook) entram pelo caminho real de produto, cifradas.
  for (const l of ['A', 'C', 'D']) {
    const nav = await entrar(l);
    const corpo = { apiToken: TOKEN[l] };
    const salvo = await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo });
    assert.equal(salvo.status, 200, salvo.texto);
  }
});

test.after(async () => {
  if (goFalso) goFalso.close();
  if (filho && filho.exitCode === null) filho.kill('SIGKILL');
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const ORG_FAIXA = { C: 1000, D: 2000 };
const chamadasDaInk = () => {
  try { return fs.readFileSync(path.join(dirMock, 'chamadas.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.host === 'api.reserva.ink'); } catch { return []; }
};

// ── Trocas ────────────────────────────────────────────────────────────────────────────────────

test('Trocas · lista pela API da Ink com a credencial da PRÓPRIA Store, sem chave legada', async () => {
  for (const l of ['C', 'D']) {
    const nav = await entrar(l);
    const r = await nav.req('GET', '/api/admin/trocas');
    assert.equal(r.status, 200, `${l}: ${r.texto}`);
    assert.deepEqual(r.json.trocas.map((t) => t.id), [ORG_FAIXA[l] + 700], 'a troca vem do token desta Store');
    assert.equal(r.json.trocas[0].loja, null, 'Store nativa: sem chave legada');
    assert.doesNotMatch(r.texto, /STORE_WITHOUT_LEGACY_KEY|chave legada/);
  }
});

test('Trocas · detalhe e criação usam a credencial da Store; a Idempotency-Key é gerada no servidor', async () => {
  const c = await entrar('C');
  const detalhe = await c.req('GET', `/api/admin/trocas/${ORG_FAIXA.C + 700}`);
  assert.equal(detalhe.status, 200, detalhe.texto);
  assert.equal(detalhe.json.exchange.id, ORG_FAIXA.C + 700);

  const antes = chamadasDaInk().length;
  const criada = await c.req('POST', '/api/admin/trocas', { corpo: {
    original_order_id: ORG_FAIXA.C + 500, exchange_reason: 'larger_size',
    items: [{ old_item_id: 1, product_v2_id: 1001, product_variant_id: 1, quantity: 1 }],
  } });
  assert.equal(criada.status, 201, criada.texto);
  assert.equal(criada.json.exchange.id, ORG_FAIXA.C + 701);
  const novas = chamadasDaInk().slice(antes);
  const post = novas.find((x) => x.metodo === 'POST');
  assert.ok(post && post.caminho === '/v1/stores/exchanges', 'a troca foi criada no endpoint de trocas');
  assert.ok(!novas.some((x) => /refunds/.test(x.caminho)), 'troca não toca reembolso');
  assert.equal(JSON.parse(post.corpo).original_order_id, ORG_FAIXA.C + 500);
});

test('Trocas · motivos que exigem o suporte continuam exigindo descrição e foto (validação local, sem chamar a Ink)', async () => {
  const c = await entrar('C');
  const antes = chamadasDaInk().length;
  const r = await c.req('POST', '/api/admin/trocas', { corpo: {
    original_order_id: 1, exchange_reason: 'defect_in_product',
    items: [{ old_item_id: 1, product_v2_id: 1, product_variant_id: 1, quantity: 1 }],
  } });
  assert.equal(r.status, 400);
  assert.equal(chamadasDaInk().length, antes, 'a validação barrou antes de qualquer chamada externa');
});

// ── Reembolsos por pedido ─────────────────────────────────────────────────────────────────────

test('Reembolsos · lista por pedido pela credencial da Store; troca e reembolso não se misturam', async () => {
  const d = await entrar('D');
  const r = await d.req('GET', `/api/admin/pedidos/central/${ORG_FAIXA.D + 500}/reembolsos`);
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json.refunds.map((x) => x.id), [ORG_FAIXA.D + 800]);
  assert.equal(r.json.loja, null);
});

test('Reembolsos · criar exige confirmação do total, e o registro de auditoria identifica a Store (não "null:id")', async () => {
  const c = await entrar('C');
  const id = ORG_FAIXA.C + 500;
  const total = await c.req('POST', `/api/admin/pedidos/${id}/reembolsos`, { corpo: {
    reason: '[TESTE Claude] item errado', refundedItems: [{ order_item_id: id * 10 + 1, requested_quantity: 1 }],
  } });
  assert.equal(total.status, 400, 'reembolso do pedido inteiro sem confirmação é recusado');
  assert.equal(total.json.requiresTotalConfirmation, true);
  const ok = await c.req('POST', `/api/admin/pedidos/${id}/reembolsos`, { corpo: {
    reason: '[TESTE Claude] item errado', refundedItems: [{ order_item_id: id * 10 + 1, requested_quantity: 1 }], confirmadoTotal: true,
  } });
  assert.equal(ok.status, 200, ok.texto);
  const { rows } = await sup.query("SELECT entity_id FROM audit_log WHERE action = 'refund.create' AND organization_id = $1 ORDER BY id DESC LIMIT 1", [ORGS.C]);
  assert.equal(rows[0].entity_id, `${store.C}:${id}`, 'a auditoria usa a Store canônica quando não há chave legada');
});

// ── Promoções ─────────────────────────────────────────────────────────────────────────────────

test('Promoções · lista, cria, edita e remove pela credencial da Store nativa', async () => {
  const c = await entrar('C');
  const lista = await c.req('GET', '/api/admin/promocoes');
  assert.equal(lista.status, 200, lista.texto);
  assert.deepEqual(lista.json.promocoes.map((p) => p.code), ['PROMOC']);
  const criada = await c.req('POST', '/api/admin/promocoes', { corpo: { type: 'standard', code: 'TESTE-CLAUDE' } });
  assert.equal(criada.status, 201, criada.texto);
  assert.equal(criada.json.promocao.id, 1901);
  const editada = await c.req('PATCH', `/api/admin/promocoes/standard/${criada.json.promocao.id}`, { corpo: { code: 'TESTE-CLAUDE-2' } });
  assert.equal(editada.status, 200, editada.texto);
  assert.equal(editada.json.promocao.code, 'TESTE-CLAUDE-2');
  const removida = await c.req('DELETE', `/api/admin/promocoes/${criada.json.promocao.id}`);
  assert.equal(removida.status, 204, removida.texto);
});

test('Promoções · outra Store lê as próprias promoções, nunca as de C', async () => {
  const d = await entrar('D');
  const r = await d.req('GET', '/api/admin/promocoes');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.promocoes.map((p) => p.code), ['PROMOD']);
  assert.ok(!r.texto.includes('PROMOC"'));
});

test('Store legada (A) continua funcionando: o caminho da credencial não depende de existir chave legada', async () => {
  const a = await entrar('A');
  const r = await a.req('GET', '/api/admin/trocas');
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual(r.json.trocas.map((t) => t.id), [3700]);
});

test('nenhuma rota migrada devolve o erro de chave legada, nem vaza token', async () => {
  const c = await entrar('C');
  for (const [m, caminho] of [['GET', '/api/admin/trocas'], ['GET', '/api/admin/promocoes'], ['GET', `/api/admin/pedidos/central/${ORG_FAIXA.C + 500}/reembolsos`]]) {
    const r = await c.req(m, caminho);
    assert.equal(r.status, 200, caminho);
    assert.ok(!r.texto.includes(TOKEN.C));
  }
  assert.ok(!saida.includes(TOKEN.C), 'nenhum token no log do processo');
});

// ── Campanhas ─────────────────────────────────────────────────────────────────────────────────

test('Campanhas · Store nativa cria, edita, duplica, lista e cancela — a identidade é a Store, sem chave legada', async () => {
  const c = await entrar('C');
  const criada = await c.req('POST', '/api/admin/campaigns', { corpo: { nome: '[TESTE Claude] campanha', descricao: 'fixture' } });
  assert.equal(criada.status, 200, criada.texto);
  assert.equal(criada.json.campanha.storeId, store.C);
  assert.equal(criada.json.campanha.loja, null, 'sem chave legada');
  assert.equal(criada.json.campanha.status, 'draft');
  const id = criada.json.campanha.id;

  const editada = await c.req('PUT', `/api/admin/campaigns/${id}`, { corpo: { nome: '[TESTE Claude] campanha editada', templateNome: 'boas_vindas', audienceDefinition: { match: 'ALL', filtros: [], exclusoes: {} } } });
  assert.equal(editada.status, 200, editada.texto);
  assert.equal(editada.json.campanha.nome, '[TESTE Claude] campanha editada');

  const copia = await c.req('POST', `/api/admin/campaigns/${id}/duplicate`);
  assert.equal(copia.status, 200, copia.texto);
  assert.equal(copia.json.campanha.storeId, store.C, 'a cópia continua na mesma Store');

  const lista = await c.req('GET', '/api/admin/campaigns');
  assert.equal(lista.status, 200, lista.texto);
  assert.equal(lista.json.campanhas.length, 2);
  assert.ok(lista.json.campanhas.every((x) => x.storeId === store.C));

  for (const x of lista.json.campanhas) {
    const r = await c.req('DELETE', `/api/admin/campaigns/${x.id}`);
    assert.ok([200, 204].includes(r.status), `limpeza da fixture: ${r.status} ${r.texto}`);
  }
  assert.equal((await c.req('GET', '/api/admin/campaigns')).json.campanhas.length, 0, 'a fixture foi removida');
});

test('Campanhas · outra Store não vê, não lê e não edita a campanha de C', async () => {
  const c = await entrar('C');
  const d = await entrar('D');
  const criada = await c.req('POST', '/api/admin/campaigns', { corpo: { nome: '[TESTE Claude] só da C' } });
  const id = criada.json.campanha.id;
  assert.deepEqual((await d.req('GET', '/api/admin/campaigns')).json.campanhas, [], 'D não lista a campanha de C');
  assert.equal((await d.req('GET', `/api/admin/campaigns/${id}`)).status, 404, 'D não lê por id');
  assert.equal((await d.req('PUT', `/api/admin/campaigns/${id}`, { corpo: { nome: 'invadida' } })).status, 404, 'D não edita');
  const { rows } = await sup.query('SELECT nome, store_id FROM campaigns WHERE id = $1', [id]);
  assert.equal(rows[0].nome, '[TESTE Claude] só da C');
  assert.equal(rows[0].store_id, store.C);
  await c.req('DELETE', `/api/admin/campaigns/${id}`);
});

test('Campanhas · a prévia de audiência funciona na Store nativa (sem chave legada, sem provider externo obrigatório)', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/campaigns/audience/preview', { corpo: { match: 'ALL', filters: [], exclusions: {} } });
  assert.equal(r.status, 200, r.texto);
  assert.equal(typeof r.json.matched, 'number');
});

// ── Recuperação e automações (sem webhook) ────────────────────────────────────────────────────

test('Recuperação · abre na Store nativa e lê os carrinhos abandonados pela API (não pelo webhook)', async () => {
  const c = await entrar('C');
  const r = await c.req('GET', '/api/admin/recuperacao');
  assert.equal(r.status, 200, r.texto);
  assert.doesNotMatch(r.texto, /STORE_WITHOUT_LEGACY_KEY|chave legada/);
});

test('Recuperação · envio manual sem vínculo devolve 400 explicativo (nunca 409 de chave legada)', async () => {
  const c = await entrar('C');
  const carrinho = await c.req('POST', '/api/admin/recuperacao/carrinho/enviar', { corpo: { cartId: 1300 } });
  assert.equal(carrinho.status, 400, carrinho.texto);
  assert.match(carrinho.json.error, /nenhuma mensagem/);
  const pix = await c.req('POST', '/api/admin/recuperacao/pix/enviar', { corpo: { inkOrderId: 1500 } });
  assert.equal(pix.status, 400, pix.texto);
  assert.match(pix.json.error, /nenhuma mensagem/);
});

test('Automações · o vínculo do evento é guardado pela chave da Store nativa e só ela o enxerga', async () => {
  const c = await entrar('C');
  const d = await entrar('D');
  // O vínculo confere o template na Meta: precisa de um número cadastrado (o serviço Go é falso).
  const cad = await c.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { phoneNumberId: '1357017780827002', wabaId: '2150656822240540', accessToken: `EAAG-token-de-teste-${crypto.randomBytes(6).toString('hex')}` } });
  assert.equal(cad.status, 200, cad.texto);
  const vinculo = await c.req('PUT', '/api/admin/automacao-eventos/cart.abandoned', { corpo: { template: 'recupera_carrinho', maxEnvios: 2, intervaloHoras: 24 } });
  assert.equal(vinculo.status, 200, vinculo.texto);
  assert.doesNotMatch(vinculo.texto, /STORE_WITHOUT_LEGACY_KEY|chave legada/);
  {
    const lido = await c.req('GET', '/api/admin/automacao-eventos');
    assert.ok(lido.json.eventos[store.C] && lido.json.eventos[store.C]['cart.abandoned'], 'chave = store_id');
    assert.ok(!('null' in lido.json.eventos), 'nunca a chave "null"');
    assert.deepEqual(Object.keys((await d.req('GET', '/api/admin/automacao-eventos')).json.eventos), [], 'D não vê o vínculo de C');
    await c.req('DELETE', '/api/admin/automacao-eventos/cart.abandoned');
    await c.req('DELETE', '/api/admin/whatsapp/remetente');
  }
});

test('Recuperação · o job persiste os carrinhos abandonados da Store nativa SEM webhook (polling da API Ink)', async () => {
  // O job de rede de segurança roda 5 s depois do boot: reinicia o processo, já com as credenciais gravadas.
  filho.kill('SIGKILL');
  await new Promise((resolve) => filho.once('exit', resolve));
  // O processo morto pode ainda segurar o lease do job; soltá-lo torna o teste independente do TTL.
  await sup.query('DELETE FROM job_leases').catch(() => {});
  const novo = await subirServidor();
  filho = novo.filho;
  base = novo.base;
  const chave = `${store.C}:${1000 + 300}`;
  const registro = await ate(async () => {
    const { rows } = await sup.query("SELECT valor FROM app_config WHERE organization_id = $1 AND chave = 'carrinho-envios'", [ORGS.C]);
    return rows[0] && rows[0].valor && rows[0].valor[chave] ? rows[0].valor[chave] : null;
  }, { tentativas: 160, intervalo: 500 });
  if (!registro) {
    const { rows } = await sup.query("SELECT organization_id, chave, (SELECT array_agg(k) FROM jsonb_object_keys(valor) k) AS chaves FROM app_config WHERE chave = 'carrinho-envios'");
    const { rows: leases } = await sup.query('SELECT * FROM job_leases').catch(() => ({ rows: [] }));
    assert.fail(`carrinho de C não persistido. blobs=${JSON.stringify(rows)} leases=${JSON.stringify(leases).slice(0, 600)} log=${saida.slice(-900)}`);
  }
  assert.equal(registro.loja, store.C, 'a chave de escopo é o store_id, nunca "null"');
  assert.equal(registro.concluido, false);
  assert.equal(registro.cart.id, 1300);
  // O job percorre as Organizations em sequência: D chega logo depois de C.
  const doD = await ate(async () => {
    const { rows } = await sup.query("SELECT valor FROM app_config WHERE organization_id = $1 AND chave = 'carrinho-envios'", [ORGS.D]);
    return rows[0] && rows[0].valor && rows[0].valor[`${store.D}:${2000 + 300}`] ? rows[0].valor : null;
  }, { tentativas: 160, intervalo: 500 });
  assert.ok(doD, 'D tem o carrinho DELA (outra credencial)');
  assert.ok(!Object.keys(doD).some((k) => k.startsWith(`${store.C}:`)), 'nada de C aparece em D');
});

// ── OpenAI (BYOK) ─────────────────────────────────────────────────────────────────────────────

test('OpenAI · BYOK da Store nativa: salva mascarada, testa, recusa chave inválida, revoga — e a outra Organization não a vê', async () => {
  const c = await entrar('C');
  const d = await entrar('D');
  const chave = `sk-teste-claude-${crypto.randomBytes(8).toString('hex')}`;
  const salva = await c.req('PUT', '/api/admin/criativos/settings/openai-key', { corpo: { apiKey: chave } });
  assert.equal(salva.status, 200, salva.texto);
  assert.equal(salva.json.configured, true);
  assert.equal(salva.json.last4, chave.slice(-4), 'só os 4 últimos caracteres voltam');
  assert.ok(!salva.texto.includes(chave), 'a chave inteira nunca volta');
  const { rows } = await sup.query("SELECT ciphertext FROM integration_secrets WHERE organization_id = $1 AND tipo = 'api_key'", [ORGS.C]);
  assert.ok(rows.length === 1 && !String(rows[0].ciphertext).includes(chave), 'cifrada no banco');

  assert.deepEqual((await c.req('POST', '/api/admin/criativos/settings/openai-key/test')).json, { ok: true });
  assert.equal((await d.req('GET', '/api/admin/criativos/settings/openai-key')).json.configured, false, 'D não vê a chave de C');
  const status = await c.req('GET', '/api/admin/integrations');
  assert.equal(status.json.integracoes.find((i) => i.provider === 'openai').estado, 'connected');

  // Chave rejeitada pela OpenAI: o teste diz "rejected", sem devolver a resposta do provider.
  const ruim = await c.req('PUT', '/api/admin/criativos/settings/openai-key', { corpo: { apiKey: 'sk-invalid-0123456789abcdef' } });
  assert.equal(ruim.status, 200, ruim.texto);
  const teste = await c.req('POST', '/api/admin/criativos/settings/openai-key/test');
  assert.equal(teste.json.ok, false);
  assert.equal(teste.json.reason, 'rejected');
  assert.doesNotMatch(teste.texto, /Incorrect API key/);

  const removida = await c.req('DELETE', '/api/admin/criativos/settings/openai-key');
  assert.ok([200, 204].includes(removida.status), removida.texto);
  assert.equal((await c.req('GET', '/api/admin/criativos/settings/openai-key')).json.configured, false);
  assert.equal((await c.req('GET', '/api/admin/integrations')).json.integracoes.find((i) => i.provider === 'openai').estado, 'not_configured');
  assert.ok(!saida.includes(chave) && !saida.includes('sk-invalid-0123456789abcdef'), 'a chave nunca vai ao log');
});

// ── Sessão: a identidade da Store chega à tela (Automações/Templates indexam por ela) ─────────

test('Sessão · expõe storeId, nome e a chave de escopo: legada quando existe, store_id na Store nativa', async () => {
  const c = await entrar('C');
  const sc = await c.req('GET', '/api/admin/session');
  assert.equal(sc.status, 200, sc.texto);
  assert.equal(sc.json.organizacaoAtiva.loja, null);
  assert.equal(sc.json.organizacaoAtiva.storeId, store.C);
  assert.equal(sc.json.organizacaoAtiva.chaveEscopo, store.C, 'Store nativa: a chave é o store_id');
  assert.equal(sc.json.organizacaoAtiva.storeNome, 'Loja Nativa C');
  const a = await entrar('A');
  const sa = await a.req('GET', '/api/admin/session');
  assert.equal(sa.json.organizacaoAtiva.chaveEscopo, 'sul', 'Store com chave legada mantém a dela');
  assert.equal(sa.json.organizacaoAtiva.storeId, store.A);
});

// ── WhatsApp: a Meta recusa o token (achado do smoke em produção) ─────────────────────────────

test('WhatsApp · token recusado pela Meta vira mensagem de produto, marca a integração e o card deixa de dizer "conectada"', async () => {
  const c = await entrar('C');
  const token = `EAAG-token-de-teste-${crypto.randomBytes(6).toString('hex')}`;
  const cadastro = { phoneNumberId: '1357017780827002', wabaId: '2150656822240540' };
  const salvo = await c.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { ...cadastro, accessToken: token } });
  assert.equal(salvo.status, 200, salvo.texto);
  assert.equal(salvo.json.tokenInvalidoEm, null);

  metaRecusaToken = true;
  const r = await c.req('GET', '/api/admin/whatsapp-templates');
  assert.equal(r.status, 409, r.texto);
  assert.equal(r.json.codigo, 'WHATSAPP_TOKEN_EXPIRED');
  assert.match(r.json.error, /cole um token novo em Integrações/);
  assert.doesNotMatch(r.texto, /fbtrace|OAuthException|PDT|meta api/, 'o corpo bruto da Meta nunca chega à tela');

  const estado = await c.req('GET', '/api/admin/whatsapp/remetente');
  assert.ok(estado.json.tokenInvalidoEm, 'a integração ficou marcada');
  const integ = await c.req('GET', '/api/admin/integrations');
  const linha = integ.json.integracoes.find((i) => i.provider === 'whatsapp');
  assert.equal(linha.estado, 'error');
  assert.equal(linha.proximaAcao, 'reconnect');

  // Salvar só o comportamento NÃO apaga a marca; trocar o token, sim.
  const soComportamento = await c.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { ...cadastro, replyRedirectMessage: 'Olá!' } });
  assert.equal(soComportamento.status, 200, soComportamento.texto);
  assert.ok(soComportamento.json.tokenInvalidoEm, 'sem token novo, a marca fica');
  const novo = await c.req('PUT', '/api/admin/whatsapp/remetente', { corpo: { ...cadastro, accessToken: `${token}-novo` } });
  assert.equal(novo.status, 200, novo.texto);
  assert.equal(novo.json.tokenInvalidoEm, null, 'token novo limpa a marca');
  assert.ok(!novo.texto.includes(token) && !saida.includes(token), 'o token nunca sai na resposta nem no log');

  metaRecusaToken = false;
  await c.req('DELETE', '/api/admin/whatsapp/remetente');
});

// ── Pedidos: a chave de escopo da Store nunca vai para a coluna `loja` ────────────────────────

test('Pedidos · vincular um pedido na Store nativa grava `loja` NULA (nunca o store_id como nome de loja)', async () => {
  const c = await entrar('C');
  const r = await c.req('POST', '/api/admin/pedidos/ink', { corpo: { inkOrderId: 1777 } });
  assert.equal(r.status, 200, r.texto);
  const { rows } = await sup.query('SELECT loja, store_id FROM pedidos_ink WHERE organization_id = $1 AND ink_order_id = 1777', [ORGS.C]);
  assert.equal(rows.length, 1, 'o pedido foi gravado');
  assert.equal(rows[0].store_id, store.C);
  assert.equal(rows[0].loja, null, 'a coluna loja é só da chave LEGADA; o store_id nela virava "nome de loja" na tela de Clientes');
  const { rows: itens } = await sup.query('SELECT loja FROM pedidos_ink_itens WHERE organization_id = $1 AND ink_order_id = 1777', [ORGS.C]);
  assert.ok(itens.length > 0 && itens.every((i) => i.loja === null), 'os itens também');
});

test('Migração 0030 · desfaz o UUID já gravado em `loja` e não toca chave legada de verdade', async () => {
  await sup.query("INSERT INTO pedidos_ink (organization_id, store_id, loja, ink_order_id, payment_status) VALUES ($1, $2, $3, 424242, 'paid')", [ORGS.C, store.C, store.C]);
  await sup.query("INSERT INTO pedidos_ink (organization_id, store_id, loja, ink_order_id, payment_status) VALUES ($1, $2, 'sul', 424243, 'paid')", [ORGS.A, store.A]);
  const sql = fs.readFileSync(path.join(h.RAIZ_REPO, 'migrations', 'sql', '0030-reparar-loja-uuid-em-pedidos.up.sql'), 'utf8');
  await sup.query(sql);
  await sup.query(sql); // idempotente
  const c = (await sup.query('SELECT loja FROM pedidos_ink WHERE ink_order_id = 424242')).rows[0];
  const a = (await sup.query('SELECT loja FROM pedidos_ink WHERE ink_order_id = 424243')).rows[0];
  assert.equal(c.loja, null, 'o UUID em loja foi desfeito');
  assert.equal(a.loja, 'sul', 'a chave legada verdadeira não é tocada');
  await sup.query('DELETE FROM pedidos_ink WHERE ink_order_id IN (424242, 424243)');
});
