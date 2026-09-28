'use strict';

// Parcerias, Afiliados e Collabs · no processo REAL do server.js, contra Postgres real e sob a role da aplicação (RLS forçada):
// flag do módulo, sessão/CSRF, papéis (owner × member) chamando os endpoints DIRETO, tenant só da sessão, isolamento entre dois
// workspaces (IDOR por id) e o caminho de dados completo — pedido da INK (mock, sem rede) → upsert com cupom/itens → atribuição →
// ledger — pelo próprio HTTP. Nenhuma chamada de escrita à INK: o mock registra todas as chamadas e o teste prova que não há POST
// de promoção.

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
const { concederFeatures } = require('../helpers/linhas');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const MOCK = path.join(h.RAIZ_REPO, 'test', 'helpers', 'provider-mock.cjs');
const ORG = { A: 'af300000-0000-4000-8000-00000000000a', B: 'af300000-0000-4000-8000-00000000000b' };
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_afh_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
// 4ª letra do token = "loja de teste" do mock: F devolve pedido com cupom e campos de afiliados (produto 6001).
const TOKEN_A = `inkF${crypto.randomBytes(10).toString('hex')}`;
const TOKEN_B = `inkD${crypto.randomBytes(10).toString('hex')}`;

let db;
let sup;
let ligado;
let desligado;
let mockLog;
const store = {};
const emailDe = (chave) => `afh-${chave}@teste.oria`;
const esperar = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function ate(fn, { tentativas = 40, intervalo = 500 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const v = await fn();
    if (v) return v;
    await esperar(intervalo);
  }
  return null;
}

function navegador(base) {
  const nav = { cookie: null, csrf: null };
  nav.req = async (metodo, caminho, { corpo, semCsrf = false } = {}) => {
    const hd = {};
    if (corpo !== undefined) hd['Content-Type'] = 'application/json';
    if (nav.cookie) hd.Cookie = nav.cookie;
    if (nav.csrf && metodo !== 'GET' && !semCsrf) hd['X-CSRF-Token'] = nav.csrf;
    const res = await fetch(base + caminho, { method: metodo, headers: hd, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: AbortSignal.timeout(15000) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && setCookie.includes('oria_session')) nav.cookie = setCookie.split(';')[0];
    const texto = await res.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { json = null; }
    if (json && json.csrfToken) nav.csrf = json.csrfToken;
    return { status: res.status, json, texto };
  };
  nav.entrar = async (chave) => {
    const r = await nav.req('POST', '/api/admin/login', { corpo: { email: emailDe(chave), password: SENHA } });
    assert.equal(r.status, 200, r.texto);
    return nav;
  };
  return nav;
}

async function pessoa(chave, org, papel) {
  const { rows: [u] } = await sup.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [emailDe(chave), await senhas.gerarHash(SENHA)]);
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [org, u.id, papel]);
}

function subir(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-afh-srv-'));
  return h.subirProcessoDoPainel((porta) => spawn(process.execPath, ['--require', MOCK, SERVER], {
    cwd: h.RAIZ_SUJEITO,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'), PORT: String(porta), NODE_ENV: 'development',
      NODE_PATH: path.join(h.RAIZ_REPO, 'node_modules'), DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE), DB_ENFORCE_APP_ROLE: '1', ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'), PROVIDER_MOCK_LOG: mockLog, ORIA_JOBS_DE_FUNDO: 'off', ...env,
    },
  }), { limiteMs: 30000 });
}

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_afil_http');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  for (const chave of ['A', 'B']) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG[chave], `Org ${chave}`]);
    const { rows: [s] } = await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL) RETURNING id', [crypto.randomUUID(), ORG[chave], `Loja ${chave}`]);
    store[chave] = s.id;
    await concederFeatures(sup, ORG[chave], { financial: true, catalog: true, exchanges: true, refunds: true, whatsapp: true });
  }
  await pessoa('a-owner', ORG.A, 'owner');
  await pessoa('a-member', ORG.A, 'member');
  await pessoa('b-owner', ORG.B, 'owner');

  mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-afh-mock-')), 'chamadas.jsonl');
  ligado = await subir({ AFILIADOS_MODULE_ENABLED: 'true' });
  desligado = await subir({});

  // Credencial da INK entra pelo caminho real de produto (cifrada), só para A e B.
  for (const [chave, token] of [['a-owner', TOKEN_A], ['b-owner', TOKEN_B]]) {
    const nav = await navegador(ligado.base).entrar(chave);
    const salvo = await nav.req('PUT', '/api/admin/integrations/ink/credenciais', { corpo: { apiToken: token } });
    assert.equal(salvo.status, 200, salvo.texto);
  }
});

test.after(async () => {
  for (const p of [ligado, desligado]) if (p && p.filho.exitCode === null) p.filho.kill('SIGKILL');
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

const A = () => navegador(ligado.base);

test('sem sessão: 401; com a flag desligada: /status diz enabled:false e todo o resto é 404', async () => {
  assert.equal((await A().req('GET', '/api/admin/afiliados/status')).status, 401);
  const off = await navegador(desligado.base).entrar('a-owner');
  const st = await off.req('GET', '/api/admin/afiliados/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.enabled, false);
  for (const c of ['/partners', '/overview', '/payables', '/collabs']) {
    const r = await off.req('GET', `/api/admin/afiliados${c}`);
    assert.equal(r.status, 404, c);
    assert.equal(r.json.codigo, 'AFILIADOS_DESABILITADO');
  }
  const post = await off.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'x' } });
  assert.equal(post.status, 404);
  assert.equal(await sup.query('SELECT count(*)::int AS n FROM partnership_partners').then((r) => r.rows[0].n), 0);
});

test('flag ligada: status por papel; escrita exige CSRF; tenant nunca vem do request', async () => {
  const owner = await A().entrar('a-owner');
  const st = await owner.req('GET', '/api/admin/afiliados/status');
  assert.deepEqual([st.json.enabled, st.json.papel, st.json.inkPromotionWritesEnabled], [true, 'owner', false]);
  const member = await A().entrar('a-member');
  assert.equal((await member.req('GET', '/api/admin/afiliados/status')).json.papel, 'member');

  const semCsrf = await owner.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'Sem CSRF' }, semCsrf: true });
  assert.equal(semCsrf.status, 403);
  assert.equal(semCsrf.json.codigo, 'csrf');

  for (const qs of ['organizationId=x', 'storeId=x', 'organization_id=x']) {
    const r = await owner.req('GET', `/api/admin/afiliados/partners?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.json.codigo, 'TENANT_SELECTOR_NOT_ALLOWED');
  }
  const corpoComTenant = await owner.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'X', organizationId: ORG.B } });
  assert.equal(corpoComTenant.status, 400);
  // O pipeline de tenant já recusa seletor no corpo; se um dia deixar passar, o próprio router recusa campo desconhecido.
  assert.ok(['TENANT_SELECTOR_NOT_ALLOWED', 'AFILIADOS_CAMPO_DESCONHECIDO'].includes(corpoComTenant.json.codigo), corpoComTenant.texto);
  const campoQualquer = await owner.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'X', qualquerCoisa: 1 } });
  assert.equal(campoQualquer.status, 400);
  assert.equal(campoQualquer.json.codigo, 'AFILIADOS_CAMPO_DESCONHECIDO');
});

test('member cadastra e acompanha, mas TODO endpoint de dinheiro/aprovação é 403 chamado direto', async () => {
  const member = await A().entrar('a-member');
  const criado = await member.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'Candidato do member', profiles: [{ network: 'instagram', handle: '@cand' }] } });
  assert.equal(criado.status, 201, criado.texto);
  assert.equal(criado.json.applicationStatus, 'candidate');
  assert.equal((await member.req('GET', '/api/admin/afiliados/partners')).status, 200);
  const semDinheiro = await member.req('GET', '/api/admin/afiliados/partners');
  assert.ok(semDinheiro.json.itens.every((p) => p.balance === null));
  for (const [m, c, corpo] of [
    ['GET', '/payables'], ['GET', '/payables/summary'], ['GET', '/payables/export.csv'], ['GET', '/payments'], ['GET', '/payouts'],
    ['POST', '/payments', { partnerId: criado.json.id }], ['POST', '/payouts', { partnerId: criado.json.id }], ['POST', '/reconcile', {}],
    ['POST', `/partners/${criado.json.id}/application`, { decision: 'approved' }], ['POST', '/ledger/manual', { partnerId: criado.json.id }],
    ['GET', `/partners/${criado.json.id}/statement`], ['PUT', '/settings', {}], ['POST', '/levels/evaluate', {}],
  ]) {
    const r = await member.req(m, `/api/admin/afiliados${c}`, corpo === undefined ? {} : { corpo });
    assert.equal(r.status, 403, `${m} ${c} → ${r.status}`);
    assert.equal(r.json.codigo, 'AFILIADOS_SEM_PERMISSAO');
  }
  const ov = await member.req('GET', '/api/admin/afiliados/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.json.kpis.payableCents, null);
  assert.deepEqual(ov.json.series, []);
  // Aprovar direto no cadastro também é do owner.
  const direto = await member.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'Tentativa', approve: true } });
  assert.equal(direto.status, 403);
});

test('isolamento entre workspaces pelo HTTP: B não vê nem altera parceiro, contrato, cupom, collab ou pagamento de A', async () => {
  const owner = await A().entrar('a-owner');
  const p = await owner.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'Parceiro só de A', approve: true } });
  assert.equal(p.status, 201, p.texto);
  const k = await owner.req('POST', '/api/admin/afiliados/contracts', {
    corpo: { partnerId: p.json.id, modality: 'coupon', title: 'Contrato A', reason: 'teste', terms: { commissionBasis: 'verified_margin_percent', commissionBps: 1000 } },
  });
  assert.equal(k.status, 201, k.texto);
  const collab = await owner.req('POST', '/api/admin/afiliados/collabs', { corpo: { name: 'Collab de A' } });
  assert.equal(collab.status, 201, collab.texto);

  const b = await A().entrar('b-owner');
  assert.equal((await b.req('GET', '/api/admin/afiliados/partners')).json.total, 0);
  for (const [m, c, corpo] of [
    ['GET', `/partners/${p.json.id}`], ['PATCH', `/partners/${p.json.id}`, { publicName: 'invadido' }], ['POST', `/partners/${p.json.id}/application`, { decision: 'rejected', reason: 'x' }],
    ['POST', `/contracts/${k.json.contract.id}/versions`, { reason: 'x', terms: { commissionBps: 1 } }],
    ['GET', `/collabs/${collab.json.id}`], ['POST', `/collabs/${collab.json.id}/products`, { products: [{ inkProductId: '1' }] }],
    ['GET', `/partners/${p.json.id}/statement`], ['POST', '/payments', { partnerId: p.json.id, idempotencyKey: 'x', method: 'pix', paidAt: '2026-09-01T00:00:00Z', allocations: [{ ledgerId: crypto.randomUUID(), amountCents: 1 }] }],
    ['POST', `/payments/${crypto.randomUUID()}/reverse`, { reason: 'x' }],
  ]) {
    const r = await b.req(m, `/api/admin/afiliados${c}`, corpo === undefined ? {} : { corpo });
    assert.equal(r.status, 404, `${m} ${c} → ${r.status} ${r.texto.slice(0, 120)}`);
  }
  // Id que nem é UUID: 404 igual (nunca 500 com detalhe de SQL) e nada vaza sobre A.
  const lixo = await b.req('GET', '/api/admin/afiliados/partners/1;DROP TABLE x');
  assert.equal(lixo.status, 404);
  assert.doesNotMatch(lixo.texto, /SELECT|relation|syntax|partnership_/i);
  assert.equal((await b.req('GET', '/api/admin/afiliados/collabs')).json.itens.length, 0);
  assert.equal((await b.req('GET', '/api/admin/afiliados/payables?dateType=due')).json.total, 0);
  const csv = await fetch(`${ligado.base}/api/admin/afiliados/payables/export.csv`, { headers: { Cookie: b.cookie } });
  assert.equal(csv.status, 200);
  assert.doesNotMatch(await csv.text(), /Parceiro só de A/);
  // Dados de A intactos.
  assert.equal((await owner.req('GET', `/api/admin/afiliados/partners/${p.json.id}`)).json.partner.publicName, 'Parceiro só de A');
  assert.equal(await sup.query(`SELECT count(*)::int AS n FROM partnership_audit_events WHERE organization_id = $1 AND action = 'partner.update'`, [ORG.B]).then((r) => r.rows[0].n), 0);
});

test('caminho completo pelo HTTP: pedido da INK com cupom → upsert com campos novos → atribuição → ledger provisório (sem entrega, nunca liberado)', async () => {
  const owner = await A().entrar('a-owner');
  const p = await owner.req('POST', '/api/admin/afiliados/partners', { corpo: { publicName: 'Bruno do Cupom', approve: true } });
  const k = await owner.req('POST', '/api/admin/afiliados/contracts', {
    corpo: { partnerId: p.json.id, modality: 'coupon', title: 'Cupom Bruno', status: 'active', reason: 'programa', terms: { commissionBasis: 'verified_margin_percent', commissionBps: 1500 } },
  });
  assert.equal(k.status, 201, k.texto);
  const cupom = await owner.req('POST', '/api/admin/afiliados/coupons', { corpo: { partnerId: p.json.id, contractId: k.json.contract.id, code: 'mockcupom', discountKind: 'percentage', discountBps: 500 } });
  assert.equal(cupom.status, 201, cupom.texto);
  // Fail-closed: um cupom que a INK (mock) não conhece NÃO ativa — 200 com activated=false, sem POST, e continua aguardando a INK.
  const desconhecido = await owner.req('POST', '/api/admin/afiliados/coupons', { corpo: { partnerId: p.json.id, contractId: k.json.contract.id, code: 'semink', discountKind: 'percentage', discountBps: 500 } });
  const bloqueado = await owner.req('POST', `/api/admin/afiliados/coupons/${desconhecido.json.id}/activate`, { corpo: {} });
  assert.equal(bloqueado.status, 200, bloqueado.texto);
  assert.equal(bloqueado.json.activated, false);
  assert.equal(bloqueado.json.outcome, 'awaiting_ink');
  assert.equal(bloqueado.json.coupon.status, 'pending_validation');
  assert.equal(bloqueado.json.coupon.operationalState, 'awaiting_ink');
  // Já o cupom que a INK confirma (GET por código, contrato oficial) é vinculado pelo ID e ativado.
  const ativo = await owner.req('POST', `/api/admin/afiliados/coupons/${cupom.json.id}/activate`, { corpo: {} });
  assert.equal(ativo.status, 200, ativo.texto);
  assert.equal(ativo.json.activated, true);
  assert.equal(ativo.json.coupon.operationalState, 'active_verified');
  assert.ok(Number(ativo.json.coupon.inkPromotionId) > 0);

  // O pedido entra pelo backfill (mesmo upsert do sync/webhook), lido do mock da INK — sem rede.
  const bf = await owner.req('POST', '/api/admin/pedidos/backfill-historico', { corpo: {} });
  assert.equal(bf.status, 202, bf.texto);
  const job = await ate(async () => {
    const j = await owner.req('GET', `/api/admin/pedidos/backfill-historico/${bf.json.jobId}`);
    return j.json && j.json.job && j.json.job.status !== 'processando' ? j.json.job : null;
  });
  assert.ok(job && job.status === 'concluido', JSON.stringify(job));
  const { rows: [ped] } = await sup.query('SELECT promotion_code, promotion_value, payment_discount_value, kickback_value, delivered_at, affiliate_snapshot_at FROM pedidos_ink WHERE organization_id = $1 AND ink_order_id = 6500', [ORG.A]);
  assert.equal(ped.promotion_code, 'MockCupom');
  assert.equal(String(ped.promotion_value), '5.00');
  assert.ok(ped.affiliate_snapshot_at, 'payload completo marca o snapshot');
  assert.equal(ped.delivered_at, null);
  const { rows: [item] } = await sup.query('SELECT produto_id, unit_value, refunded_quantity, free_quantity, unit_ink_base_price, product_variant_id FROM pedidos_ink_itens WHERE organization_id = $1 AND ink_order_id = 6500', [ORG.A]);
  assert.equal(String(item.produto_id), '6001');
  assert.equal(String(item.unit_value), '90.00');
  assert.equal(item.refunded_quantity, 0);
  assert.equal(String(item.unit_ink_base_price), '40.00');
  assert.equal(String(item.product_variant_id), '6011');

  const rec = await owner.req('POST', '/api/admin/afiliados/reconcile', { corpo: { completo: true } });
  assert.equal(rec.status, 200, rec.texto);
  // O cupom foi ativado ANTES do pedido existir? A ativação não é retroativa: o pedido (criado_em = agora do mock) é posterior.
  const vendas = await owner.req('GET', '/api/admin/afiliados/sales');
  assert.equal(vendas.status, 200, vendas.texto);
  assert.equal(vendas.json.total, 1, vendas.texto);
  const v = vendas.json.itens[0];
  assert.deepEqual([v.inkOrderId, v.basis, v.couponCode, v.partnerName], ['6500', 'coupon', 'mockcupom', 'Bruno do Cupom']);
  assert.equal(v.netRevenueCents, 8500); // 90 − 5 de desconto
  assert.equal(v.commissionCents, 675); // 15% de (85 − 40)
  const ledger = await sup.query(`SELECT status, amount_cents FROM partner_commission_ledger WHERE organization_id = $1`, [ORG.A]);
  assert.deepEqual(ledger.rows.map((r) => [r.status, Number(r.amount_cents)]), [['provisional', 675]]);
  const resumo = await owner.req('GET', '/api/admin/afiliados/payables/summary');
  assert.equal(resumo.json.forecastCents, 675);
  assert.equal(resumo.json.availableCents, 0);
  assert.equal(resumo.json.overdueCents, 0);

  // A criação de cupom na INK está desligada: prévia sem envio, criação recusada e NENHUM POST de promoção no log do mock.
  const previa = await owner.req('GET', `/api/admin/afiliados/coupons/${cupom.json.id}/ink-preview`);
  assert.equal(previa.json.enviaria, false);
  const criar = await owner.req('POST', `/api/admin/afiliados/coupons/${cupom.json.id}/ink-create`, { corpo: {} });
  assert.equal(criar.status, 409);
  assert.equal(criar.json.codigo, 'INK_PROMOTION_WRITES_DISABLED');
  const chamadas = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  assert.equal(chamadas.filter((c) => /\/v1\/stores\/promotions/.test(c.caminho || c.path || '') && String(c.metodo || c.method).toUpperCase() !== 'GET').length, 0);

  // B não enxerga nada disso (nem o pedido de A, nem a comissão).
  const b = await A().entrar('b-owner');
  assert.equal((await b.req('GET', '/api/admin/afiliados/sales')).json.total, 0);
  assert.equal((await b.req('GET', '/api/admin/afiliados/payables/summary')).json.forecastCents, 0);
});

test('pagamento pelo HTTP: exige owner, é idempotente e não passa do saldo; vencimento, estorno e CSV', async () => {
  const owner = await A().entrar('a-owner');
  const p = (await owner.req('GET', '/api/admin/afiliados/partners?q=Bruno')).json.itens[0];
  // Libera o lançamento de teste diretamente (a entrega real viria da INK): simula o estado "liberado" na fonte, não no ledger.
  await sup.query(`UPDATE pedidos_ink SET delivered_at = now() - interval '40 days', order_status = 'delivered' WHERE organization_id = $1 AND ink_order_id = 6500`, [ORG.A]);
  await owner.req('POST', '/api/admin/afiliados/reconcile', { corpo: { completo: true } });
  const extrato = await owner.req('GET', `/api/admin/afiliados/partners/${p.id}/statement`);
  const lanc = extrato.json.itens.find((i) => i.status === 'released');
  assert.ok(lanc, JSON.stringify(extrato.json.itens));
  const corpo = { partnerId: p.id, idempotencyKey: 'http-1', method: 'pix', paidAt: new Date(Date.now() - 3600000).toISOString(), allocations: [{ ledgerId: lanc.id, amountCents: 300 }], externalReference: 'E2E-HTTP-1' };
  const pg = await owner.req('POST', '/api/admin/afiliados/payments', { corpo });
  assert.equal(pg.status, 201, pg.texto);
  assert.equal(pg.json.recibo.saldoRestanteLiberadoCents, 375);
  const repetido = await owner.req('POST', '/api/admin/afiliados/payments', { corpo });
  assert.equal(repetido.status, 200);
  assert.equal(repetido.json.deduplicated, true);
  const excede = await owner.req('POST', '/api/admin/afiliados/payments', { corpo: { ...corpo, idempotencyKey: 'http-2', externalReference: undefined, allocations: [{ ledgerId: lanc.id, amountCents: 9999 }] } });
  assert.equal(excede.status, 422);
  assert.equal(excede.json.codigo, 'AFILIADOS_PAGAMENTO_EXCEDE_SALDO');
  const semMotivo = await owner.req('POST', '/api/admin/afiliados/ledger/due-date', { corpo: { ledgerIds: [lanc.id], dueAt: '2026-12-10T12:00:00Z' } });
  assert.equal(semMotivo.status, 400);
  const csv = await fetch(`${ligado.base}/api/admin/afiliados/payables/export.csv?dateType=paid&from=2020-01-01&to=2030-12-31`, { headers: { Cookie: owner.cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const texto = await csv.text();
  assert.match(texto, /Bruno do Cupom/);
  assert.doesNotMatch(texto, /@|cpf|documento|token/i);
  const est = await owner.req('POST', `/api/admin/afiliados/payments/${pg.json.id}/reverse`, { corpo: { reason: 'erro de digitação' } });
  assert.equal(est.status, 201, est.texto);
  assert.equal((await owner.req('GET', `/api/admin/afiliados/partners/${p.id}/statement`)).json.totais.paidCents, 0);
});
