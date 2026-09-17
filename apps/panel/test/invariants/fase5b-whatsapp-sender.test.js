'use strict';

// Fase 5b — remetente WhatsApp da Organization (INV-25, INV-28, INV-13).
//
// Sob a role da aplicação, com duas Organizations (A = sul, B = centro), cada uma com seu número,
// WABA e token:
//   - o remetente sai inteiro da integração da Organization do contexto, A/B intercalado e
//     concorrente;
//   - número de uma com token de outra não passa (posse do número, PD-016);
//   - a referência que o Go guarda só vale com a assinatura do painel;
//   - o token não sai por JSON, inspect ou spread;
//   - o contrato serializado (fixture) é o mesmo que a lib implementa.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const wa = h.sujeito('lib/platform/whatsapp-sender.js');

const CENARIO_A = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy', 'cenario-a.json');
const CONTRATO = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'whatsapp', 'sender-contract-v1.json');
const ORG_A = 'a1000000-0000-4000-8000-000000000001';
const ORG_B = 'a1000000-0000-4000-8000-000000000002';
const ORG_N = 'a1000000-0000-4000-8000-000000000003';
const ROLE = `oria_app_f5b_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const SEGREDO_REF = crypto.randomBytes(32).toString('base64url');
const LOJA = { [ORG_A]: 'sul', [ORG_B]: 'centro', [ORG_N]: 'norte' };
const silencioso = { log() {}, warn() {}, error() {} };

const R = {
  [ORG_A]: { phone: '1110000001', waba: '2220000001', token: `EAAG-A-${crypto.randomBytes(12).toString('hex')}` },
  [ORG_B]: { phone: '1110000002', waba: '2220000002', token: `EAAG-B-${crypto.randomBytes(12).toString('hex')}` },
};

let db;
let sup;
let appPool;
let integracoes;
let remetentes;

const em = (org, fn) => runtime.comContexto({ organizationId: org, loja: LOJA[org] }, fn);
const par = (r) => ({ org: r.organizationId, phone: r.phoneNumberId, waba: r.wabaId, token: r.accessToken });

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_f5b');
  const r = h.migrar(db.url, { env: { TENANCY_MAPPING_FILE: CENARIO_A } });
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 3 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  appPool = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA_ROLE), { max: 4 });
  const fachada = runtime.criarPoolTenant(appPool);
  integracoes = createIntegrationResolver({
    pool: fachada,
    segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {},
    logger: silencioso,
  });
  remetentes = wa.createWhatsappSender({ integracoes, segredoRef: SEGREDO_REF });
  for (const org of [ORG_A, ORG_B]) {
    await em(org, async () => {
      await integracoes.gravarConfig('whatsapp', { phone_number_id: R[org].phone, waba_id: R[org].waba });
      await integracoes.gravarSegredo('whatsapp', 'access_token', R[org].token);
    });
  }
});

test.after(async () => {
  await appPool?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

// ── INV-28 · o par sai inteiro da integração da Organization do contexto ─────────────────────

test('INV-28 · cada Organization recebe o próprio número, WABA e token', async () => {
  for (const org of [ORG_A, ORG_B]) {
    const got = await em(org, () => remetentes.comRemetente(par));
    assert.deepEqual(got, { org, phone: R[org].phone, waba: R[org].waba, token: R[org].token });
  }
});

test('INV-28 · A/B intercalado e concorrente não cruza pares', async () => {
  const ordem = Array.from({ length: 24 }, (_, i) => (i % 2 ? ORG_B : ORG_A));
  const got = await Promise.all(ordem.map((org) => em(org, async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 10));
    return remetentes.comRemetente(par);
  })));
  got.forEach((g, i) => {
    const org = ordem[i];
    assert.deepEqual(g, { org, phone: R[org].phone, waba: R[org].waba, token: R[org].token }, `envio ${i}`);
  });
});

test('INV-28 · número de B configurado em A não sai com o token de A', async () => {
  // Posse dos números já registrada pelos envios acima (e pela tela, em produção).
  await sup.query(
    `UPDATE integrations SET config = jsonb_set(config, '{phone_number_id}', to_jsonb($1::text))
      WHERE organization_id = $2 AND provider = 'whatsapp'`,
    [R[ORG_B].phone, ORG_A]
  );
  try {
    await em(ORG_A, () => assert.rejects(
      remetentes.comRemetente(() => assert.fail('o par cruzado não pode chegar ao chamador')),
      (e) => e.codigo === 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE'
    ));
  } finally {
    await sup.query(
      `UPDATE integrations SET config = jsonb_set(config, '{phone_number_id}', to_jsonb($1::text))
        WHERE organization_id = $2 AND provider = 'whatsapp'`,
      [R[ORG_A].phone, ORG_A]
    );
  }
  assert.equal((await em(ORG_A, () => remetentes.comRemetente(par))).token, R[ORG_A].token);
});

test('INV-25 · sem contexto, sem integração, incompleta ou sem chave de referência: falha, sem fallback', async () => {
  await assert.rejects(remetentes.comRemetente(() => 'x'), (e) => e.codigo === 'TENANT_CONTEXT_REQUIRED');
  // Norte não tem integração WhatsApp.
  await em(ORG_N, () => assert.rejects(remetentes.comRemetente(() => 'x'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED'));
  // Token sem número.
  await em(ORG_N, async () => {
    await integracoes.gravarSegredo('whatsapp', 'access_token', `EAAG-N-${crypto.randomBytes(12).toString('hex')}`);
    await assert.rejects(remetentes.comRemetente(() => 'x'), (e) => e.codigo === 'SENDER_INCOMPLETE');
    await integracoes.gravarConfig('whatsapp', { phone_number_id: '1110000003' });
    await assert.rejects(remetentes.comRemetente(() => 'x'), (e) => e.codigo === 'SENDER_INCOMPLETE', 'sem WABA');
    await integracoes.desconectar('whatsapp');
    await integracoes.gravarConfig('whatsapp', { phone_number_id: '1110000003', waba_id: '2220000003' });
    await assert.rejects(remetentes.comRemetente(() => 'x'), (e) => e.codigo === 'INTEGRATION_NOT_CONNECTED', 'desconectado');
  });
  const semChave = wa.createWhatsappSender({ integracoes, segredoRef: '' });
  await em(ORG_A, () => assert.rejects(semChave.comRemetente(() => 'x'), (e) => e.codigo === 'SENDER_REF_UNAVAILABLE'));
  const chaveCurta = wa.createWhatsappSender({ integracoes, segredoRef: 'curta' });
  await em(ORG_A, () => assert.rejects(chaveCurta.comRemetente(() => 'x'), (e) => e.codigo === 'SENDER_REF_UNAVAILABLE'));
});

test('INV-13 · o token não sai por JSON, inspect, spread nem chaves do objeto', async () => {
  await em(ORG_A, () => remetentes.comRemetente((r) => {
    const token = R[ORG_A].token;
    assert.equal(r.accessToken, token);
    assert.ok(!JSON.stringify(r).includes(token));
    assert.ok(!JSON.stringify({ r }).includes(token));
    assert.ok(!util.inspect(r, { depth: 5 }).includes(token));
    assert.ok(!JSON.stringify({ ...r }).includes(token));
    assert.ok(!Object.keys(r).includes('accessToken'));
    assert.ok(Object.isFrozen(r));
    const headers = wa.headersDoRemetente(r);
    assert.equal(headers['X-Sender-Access-Token'], token, 'o token só aparece no header do contrato');
  }));
});

// ── INV-25 · referência assinada ─────────────────────────────────────────────────────────────

test('INV-25 · a referência só vale com a assinatura do painel e não é trocável', async () => {
  const ref = await em(ORG_A, () => remetentes.comRemetente((r) => r.ref));
  assert.match(ref, wa.REF_RE);
  assert.ok(!ref.includes(R[ORG_A].token));
  const lida = remetentes.lerRef(ref);
  assert.equal(lida.organizationId, ORG_A);
  assert.equal(lida.phoneNumberId, R[ORG_A].phone);

  const [, payload, assinatura] = ref.split('.');
  const dados = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  // Troca a Organization e mantém a assinatura: recusada.
  const forjado = Buffer.from(JSON.stringify({ ...dados, o: ORG_B })).toString('base64url');
  assert.throws(() => remetentes.lerRef(`v1.${forjado}.${assinatura}`), (e) => e.codigo === 'SENDER_REF_INVALID');
  // Assinada com outra chave: recusada.
  const outroPainel = wa.createWhatsappSender({ integracoes, segredoRef: crypto.randomBytes(32).toString('base64url') });
  const alheia = outroPainel.assinarRef({ organizationId: ORG_B, integrationId: 1, phoneNumberId: R[ORG_B].phone });
  assert.throws(() => remetentes.lerRef(alheia), (e) => e.codigo === 'SENDER_REF_INVALID');
  // Formatos inválidos.
  for (const ruim of [null, '', 'v1..', `v2.${payload}.${assinatura}`, `v1.${payload}.${assinatura}x`, ref.toUpperCase()]) {
    assert.throws(() => remetentes.lerRef(ruim), (e) => e.codigo === 'SENDER_REF_INVALID', String(ruim));
  }
  // Payload assinado mas sem os campos esperados.
  const semOrg = remetentes.assinarRef({ organizationId: 'nao-e-uuid', integrationId: 1, phoneNumberId: R[ORG_A].phone });
  assert.throws(() => remetentes.lerRef(semOrg), (e) => e.codigo === 'SENDER_REF_INVALID');
});

test('validação da tela: campos numéricos, número diferente da WABA, token no formato', () => {
  const ok = { phoneNumberId: '1110000001', wabaId: '2220000001', accessToken: 'EAAG-token-valido-0000' };
  assert.equal(wa.validarConfiguracao(ok), null);
  assert.equal(wa.validarConfiguracao({ ...ok, accessToken: undefined }), null);
  assert.ok(wa.validarConfiguracao({ ...ok, phoneNumberId: '11/../me' }));
  assert.ok(wa.validarConfiguracao({ ...ok, wabaId: 'abc' }));
  assert.ok(wa.validarConfiguracao({ ...ok, wabaId: ok.phoneNumberId }));
  assert.ok(wa.validarConfiguracao({ ...ok, accessToken: 'curto' }));
  assert.ok(wa.validarConfiguracao({ ...ok, accessToken: 'token com espaço 0000000' }));
  assert.ok(wa.validarConfiguracao({ ...ok, accessToken: '' }));
});

// ── OPS-29 · import do remetente do ambiente do Go ────────────────────────────────────────────

test('OPS-29 · import do remetente legado: Organization explícita, posse do número, idempotente, sem vazar token', async () => {
  const { importarRemetenteWhatsapp } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'integrations', 'import-whatsapp-sender.mjs')));
  const token = `EAAG-legado-${crypto.randomBytes(12).toString('hex')}`;
  const env = {
    ENCRYPTION_MASTER_KEY: MESTRA,
    WHATSAPP_LEGACY_PHONE_NUMBER_ID: '1110000009',
    WHATSAPP_LEGACY_WABA_ID: '2220000009',
    WHATSAPP_LEGACY_ACCESS_TOKEN: token,
  };
  // Norte foi desconectado acima; começa sem número próprio.
  await em(ORG_N, () => integracoes.gravarConfig('whatsapp', {}));

  await assert.rejects(importarRemetenteWhatsapp(db.url, { env, aplicar: true }), /--organization/);
  await assert.rejects(importarRemetenteWhatsapp(db.url, { env: { ...env, WHATSAPP_LEGACY_ACCESS_TOKEN: 'x' }, organizationId: ORG_N, aplicar: true }), /token/);
  await assert.rejects(importarRemetenteWhatsapp(db.url, { env, organizationId: crypto.randomUUID(), aplicar: true }), /não existe/);
  // Número que já é de A: recusado para B.
  await assert.rejects(
    importarRemetenteWhatsapp(db.url, { env: { ...env, WHATSAPP_LEGACY_PHONE_NUMBER_ID: R[ORG_A].phone }, organizationId: ORG_N, aplicar: true }),
    /outra organization/
  );
  // Não sobrescreve outro número já cadastrado.
  await assert.rejects(importarRemetenteWhatsapp(db.url, { env, organizationId: ORG_B, aplicar: true }), /outro número/);

  const simulado = await importarRemetenteWhatsapp(db.url, { env, organizationId: ORG_N });
  assert.equal(simulado.resultado, 'a_importar');
  await em(ORG_N, () => assert.rejects(remetentes.comRemetente(() => 'x')));

  const aplicado = await importarRemetenteWhatsapp(db.url, { env, organizationId: ORG_N, aplicar: true });
  assert.equal(aplicado.resultado, 'importado');
  assert.ok(!JSON.stringify([simulado, aplicado]).includes(token), 'relatório não traz o token');
  assert.equal(aplicado.last4, token.slice(-4));
  const got = await em(ORG_N, () => remetentes.comRemetente(par));
  assert.deepEqual(got, { org: ORG_N, phone: '1110000009', waba: '2220000009', token });

  const deNovo = await importarRemetenteWhatsapp(db.url, { env, organizationId: ORG_N, aplicar: true });
  assert.equal(deNovo.resultado, 'ja_importado');
  const { rows } = await sup.query(
    `SELECT organization_id FROM external_resource_claims WHERE provider = 'whatsapp' AND external_id = '1110000009'`
  );
  assert.deepEqual(rows.map((x) => x.organization_id), [ORG_N]);
});

// ── Contrato Node ↔ Go (fixture serializada) ───────────────────────────────────────────────────

test('contrato · a lib do painel implementa exatamente a fixture versionada', async () => {
  const c = JSON.parse(fs.readFileSync(CONTRATO, 'utf8'));
  assert.equal(c.version, 1);
  assert.deepEqual(
    { phone_number_id: wa.HEADERS.phoneNumberId, waba_id: wa.HEADERS.wabaId, access_token: wa.HEADERS.accessToken, ref: wa.HEADERS.ref },
    c.headers
  );
  assert.equal(wa.META_ID_RE.source, new RegExp(c.patterns.meta_id).source);
  assert.equal(wa.TOKEN_RE.source, new RegExp(c.patterns.access_token).source);
  assert.equal(wa.REF_RE.source.replace(/[()]/g, ''), new RegExp(c.patterns.ref).source);
  assert.deepEqual([wa.TOKEN_MIN, wa.TOKEN_MAX], [c.access_token_length.min, c.access_token_length.max]);

  // O que o painel emite de verdade satisfaz a fixture.
  const valida = (headers) => {
    const g = (k) => headers[c.headers[k]];
    if (c.required_headers.some((k) => !g(k))) return false;
    const t = g('access_token');
    return new RegExp(c.patterns.meta_id).test(g('phone_number_id'))
      && (g('waba_id') === undefined || new RegExp(c.patterns.meta_id).test(g('waba_id')))
      && t.length >= c.access_token_length.min && t.length <= c.access_token_length.max
      && new RegExp(c.patterns.access_token).test(t)
      && new RegExp(c.patterns.ref).test(g('ref'));
  };
  for (const org of [ORG_A, ORG_B]) {
    const headers = await em(org, () => remetentes.comRemetente((r) => wa.headersDoRemetente(r)));
    assert.deepEqual(Object.keys(headers).sort(), Object.values(c.headers).sort());
    assert.ok(valida(headers), `headers de ${org} fora do contrato`);
  }
  assert.ok(valida(c.examples.valid));
  for (const inv of c.examples.invalid) assert.equal(valida(inv.headers), false, inv.name);
});

test('contrato · a cópia do serviço Go é idêntica (quando o repositório está ao lado)', (t) => {
  const dirGo = process.env.WHATSAPP_GO_DIR || path.resolve(h.RAIZ_REPO, '..', 'whatsapp-webhook-go');
  const copia = path.join(dirGo, 'testdata', 'sender-contract-v1.json');
  if (!fs.existsSync(copia)) {
    t.skip(`repositório do Go não encontrado em ${dirGo} (defina WHATSAPP_GO_DIR)`);
    return;
  }
  assert.equal(fs.readFileSync(copia, 'utf8'), fs.readFileSync(CONTRATO, 'utf8'), 'as duas cópias do contrato divergiram');
});

test('OPS-33 · referência de serviço impressa pelo script resolve para a Organization certa', async () => {
  const { referenciaDeServico } = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'integrations', 'whatsapp-referencia.mjs')));
  const env = { WHATSAPP_SENDER_REF_SECRET: SEGREDO_REF };
  await assert.rejects(referenciaDeServico(db.url, { env }), /--organization/);
  await assert.rejects(referenciaDeServico(db.url, { env: {}, organizationId: ORG_A }), /WHATSAPP_SENDER_REF_SECRET/);
  const r = await referenciaDeServico(db.url, { env, organizationId: ORG_B });
  assert.equal(r.phoneNumberId, R[ORG_B].phone);
  assert.deepEqual(
    [remetentes.lerRef(r.ref).organizationId, remetentes.lerRef(r.ref).phoneNumberId],
    [ORG_B, R[ORG_B].phone]
  );
  assert.equal(r.ref, await em(ORG_B, () => remetentes.comRemetente((x) => x.ref)), 'a mesma referência que o painel emite');
  assert.ok(!JSON.stringify(r).includes(R[ORG_B].token));
});
