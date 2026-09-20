'use strict';

// WhatsApp · Embedded Signup no navegador: leitura da mensagem da Meta (src/pages/integracoes/embeddedSignup.ts)
// e cliente servidor→Meta (lib/whatsapp/embedded-signup.js). Funções puras/isoladas, sem banco.
//
// `window.postMessage` aceita qualquer remetente: a origem tem que ser exatamente o domínio da Meta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const h = require('./harness');

function carregarTs(arquivo) {
  const js = ts.transpileModule(fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'src', 'pages', 'integracoes', arquivo), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} };
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports, URL, JSON }, { filename: arquivo });
  return modulo.exports;
}

const { interpretarMensagemEmbeddedSignup: ler, origemDaMeta } = carregarTs('embeddedSignup.ts');
const FINISH = { type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '7770001', waba_id: '6660001', business_id: '8880001' } };

test('Given a mensagem FINISH da Meta, When lida, Then devolve WABA, número e business', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ler('https://www.facebook.com', JSON.stringify(FINISH)))), {
    tipo: 'concluido', wabaId: '6660001', phoneNumberId: '7770001', businessId: '8880001',
  });
  assert.equal(ler('https://web.facebook.com', FINISH).tipo, 'concluido', 'aceita objeto e string');
});

test('Given origem que não é da Meta, When a mensagem chega, Then é ignorada (mesmo formato, outro remetente)', () => {
  for (const origem of ['https://evilfacebook.com', 'https://facebook.com.evil.test', 'http://www.facebook.com', 'https://oria.test', 'null', '']) {
    assert.equal(ler(origem, FINISH), null, origem);
    assert.equal(origemDaMeta(origem), false, origem);
  }
  assert.equal(origemDaMeta('https://facebook.com'), true);
});

test('Given mensagem que não é do Embedded Signup ou malformada, When lida, Then nenhum efeito', () => {
  assert.equal(ler('https://www.facebook.com', 'não é json'), null);
  assert.equal(ler('https://www.facebook.com', { type: 'OUTRA', event: 'FINISH' }), null);
  assert.equal(ler('https://www.facebook.com', { type: 'WA_EMBEDDED_SIGNUP', event: 'OUTRO' }), null);
  assert.equal(ler('https://www.facebook.com', 42), null);
});

test('Given FINISH com ids fora do formato, When lida, Then vira erro (nada segue para o servidor)', () => {
  const ruim = { ...FINISH, data: { phone_number_id: '../x', waba_id: '6660001' } };
  assert.deepEqual(JSON.parse(JSON.stringify(ler('https://www.facebook.com', ruim))), { tipo: 'erro', codigo: 'IDS_INVALIDOS' });
});

test('Given CANCEL e erro da Meta, When lidos, Then distingue abandono de falha', () => {
  const cancel = { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE_NUMBER_SETUP' } };
  assert.deepEqual(JSON.parse(JSON.stringify(ler('https://www.facebook.com', cancel))), { tipo: 'cancelado', etapa: 'PHONE_NUMBER_SETUP' });
  const falha = { type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { error_message: 'x', error_code: '100' } };
  assert.deepEqual(JSON.parse(JSON.stringify(ler('https://www.facebook.com', falha))), { tipo: 'erro', codigo: '100' });
});

// ── cliente servidor → Meta ───────────────────────────────────────────────────────────────────

const es = h.sujeito('lib/whatsapp/embedded-signup.js');
const resposta = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status });

function clienteCom(rotas) {
  const chamadas = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(String(url));
    chamadas.push({ caminho: u.pathname, query: u.search, metodo: init.method || 'GET', auth: init.headers && init.headers.Authorization });
    for (const [padrao, fn] of rotas) if (u.pathname.endsWith(padrao)) return fn(u, init);
    return resposta({}, 404);
  };
  return { cliente: es.criarClienteEmbeddedSignup({ appId: '4440001', appSecret: 'segredo', fetchFn }), chamadas };
}
const valido = (over = {}) => ([
  ['/oauth/access_token', () => resposta({ access_token: 'TOKEN-DO-CLIENTE-123456', expires_in: 5184000 })],
  ['/debug_token', () => resposta({ data: { is_valid: true, app_id: '4440001', granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['6660001'] }], ...over } })],
  ['/phone_numbers', () => resposta({ data: [{ id: '7770001', display_phone_number: '+55 48 90000-0000', verified_name: 'Loja' }] })],
]);

test('Given code válido, When provar, Then devolve token, validade e o número que a Meta confirma', async () => {
  const { cliente } = clienteCom(valido());
  const r = await cliente.provar({ code: 'codigo-de-teste-valido', wabaId: '6660001', phoneNumberId: '7770001' });
  assert.equal(r.accessToken, 'TOKEN-DO-CLIENTE-123456');
  assert.ok(r.expiraEm instanceof Date && r.expiraEm.getTime() > Date.now());
  assert.equal(r.numero.nomeVerificado, 'Loja');
});

test('Given token de outro app, WABA não concedida ou número de outra WABA, When provar, Then recusa com código', async () => {
  const casos = [
    [{ app_id: '999' }, 'ES_TOKEN_OTHER_APP'],
    [{ is_valid: false }, 'ES_TOKEN_INVALID'],
    [{ granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: ['1'] }] }, 'ES_WABA_NOT_GRANTED'],
    [{ granular_scopes: [{ scope: 'ads_read', target_ids: ['6660001'] }] }, 'ES_WABA_NOT_GRANTED'],
  ];
  for (const [over, codigo] of casos) {
    const { cliente } = clienteCom(valido(over));
    await assert.rejects(cliente.provar({ code: 'codigo-de-teste-valido', wabaId: '6660001', phoneNumberId: '7770001' }), (e) => e.codigo === codigo, codigo);
  }
  const { cliente } = clienteCom(valido());
  await assert.rejects(cliente.provar({ code: 'codigo-de-teste-valido', wabaId: '6660001', phoneNumberId: '7770009' }), (e) => e.codigo === 'ES_PHONE_NOT_IN_WABA');
});

test('Given erro da Meta, When falha, Then o erro carrega só código e mensagem — nunca o token', async () => {
  const { cliente } = clienteCom([['/oauth/access_token', () => resposta({ error: { message: 'Bearer TOKEN-SECRETO-ABC inválido' } }, 400)]]);
  await assert.rejects(cliente.provar({ code: 'codigo-de-teste-valido', wabaId: '6660001', phoneNumberId: '7770001' }), (e) => {
    assert.equal(e.codigo, 'ES_CODE_EXCHANGE_FAILED');
    assert.ok(!e.message.includes('TOKEN-SECRETO') && !JSON.stringify(e).includes('TOKEN-SECRETO'));
    return true;
  });
  const { cliente: indisponivel } = clienteCom([['/oauth/access_token', () => resposta({}, 503)]]);
  await assert.rejects(indisponivel.trocarCode('codigo-de-teste-valido'), (e) => e.status === 502, 'Meta fora do ar não vira "recusado"');
});

test('Given token do cliente, When chama a Meta, Then usa Authorization e appsecret_proof, nunca o token na URL', async () => {
  const { cliente, chamadas } = clienteCom([['/subscribed_apps', () => resposta({ success: true })], ['/register', () => resposta({ success: true })]]);
  await cliente.assinarWebhooks('6660001', 'TOKEN-DO-CLIENTE-123456');
  await cliente.registrarNumero('7770001', 'TOKEN-DO-CLIENTE-123456', '123456');
  for (const c of chamadas) {
    assert.equal(c.auth, 'Bearer TOKEN-DO-CLIENTE-123456');
    assert.match(c.query, /appsecret_proof=[0-9a-f]{64}/);
    assert.ok(!c.query.includes('TOKEN-DO-CLIENTE'));
  }
});

test('Given entrada do navegador, When validada, Then formato ruim é recusado antes de qualquer chamada', () => {
  const ok = { code: 'codigo-de-teste-valido', wabaId: '6660001', phoneNumberId: '7770001', businessId: '8880001' };
  assert.doesNotThrow(() => es.validarEntrada(ok));
  for (const ruim of [{ code: 'x' }, { wabaId: 'abc' }, { phoneNumberId: '1 OR 1=1' }, { businessId: '../../x' }, { phoneNumberId: '6660001' }]) {
    assert.throws(() => es.validarEntrada({ ...ok, ...ruim }), (e) => e.status === 400, JSON.stringify(ruim));
  }
  assert.match(es.gerarPin(), /^[0-9]{6}$/);
});
