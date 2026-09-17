'use strict';

// Rodada 19 · §5 — transição do repasse Go → painel sem perda de status (unidade).
//
//   - WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED: só "1" liga; "", "0" desligam; outro valor é erro;
//   - com a tolerância, `secret` na query + assinatura válida → aceito (o valor da query nem é lido);
//   - com a tolerância, a query NUNCA autentica sozinha: sem assinatura, assinatura errada, corpo
//     alterado ou fora da janela → 401, com o valor da query igual ou diferente do segredo;
//   - sem a tolerância, o comportamento da rodada 18 continua (401 mesmo com assinatura válida);
//   - o contrato (as duas cópias) nomeia as mesmas flags.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');
const repasse = h.sujeito('lib/platform/whatsapp-forward.js');

const c = JSON.parse(fs.readFileSync(path.join(h.RAIZ_REPO, 'test', 'fixtures', 'whatsapp', 'forward-auth-v1.json'), 'utf8'));
const SEGREDO = crypto.randomBytes(32).toString('base64url');
const LEGADO = crypto.randomBytes(12).toString('hex');
const AGORA = Date.UTC(2026, 8, 17, 12, 0, 0);
const CORPO = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '2220000001', changes: [] }] }));

function assinado({ segredo = SEGREDO, corpo = CORPO, ts = String(Math.floor(AGORA / 1000)) } = {}) {
  return { [repasse.HEADER_TIMESTAMP]: ts, [repasse.HEADER_ASSINATURA]: repasse.assinarRepasse(segredo, ts, corpo) };
}

const verificar = (over = {}) => repasse.verificarRepasseWhatsapp({
  segredo: SEGREDO, headers: assinado(), query: { secret: LEGADO }, corpoCru: CORPO, agora: AGORA, toleraQueryLegada: true, ...over,
});

test('R19 · flag de tolerância: só "1" liga, "" e "0" desligam, o resto é erro', () => {
  assert.equal(repasse.FLAG_TOLERANCIA_QUERY_LEGADA, 'WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED');
  for (const v of [undefined, null, '', '0', ' 0 ']) assert.equal(repasse.lerToleranciaQueryLegada(v), false, JSON.stringify(v));
  for (const v of ['1', ' 1 ']) assert.equal(repasse.lerToleranciaQueryLegada(v), true, JSON.stringify(v));
  for (const v of ['true', 'yes', 'on', '2', 'false']) {
    assert.throws(() => repasse.lerToleranciaQueryLegada(v), /WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED inválida/, v);
  }
});

test('R19 · contrato: bloco de transição com os mesmos nomes do código, versão mantida', (t) => {
  const tr = c.legacy_query_transition;
  assert.equal(c.version, 1);
  assert.deepEqual(
    [tr.panel_flag_env, tr.service_flag_env, tr.legacy_query_param, tr.query_secret_must_differ_from_signing_secret],
    [repasse.FLAG_TOLERANCIA_QUERY_LEGADA, 'WEBHOOK_FORWARD_LEGACY_QUERY_SECRET', 'secret', true]
  );
  assert.equal(repasse.lerToleranciaQueryLegada(tr.flag_on), true);
  for (const v of tr.flag_off) assert.equal(repasse.lerToleranciaQueryLegada(v), false);
  assert.deepEqual(c.auth.forbidden_query_params, [tr.legacy_query_param]);
  const dirGo = process.env.WHATSAPP_GO_DIR || path.resolve(h.RAIZ_REPO, '..', '..', 'services', 'whatsapp');
  const copia = path.join(dirGo, 'testdata', 'forward-auth-v1.json');
  if (!fs.existsSync(copia)) {
    t.diagnostic(`cópia do Go não encontrada em ${dirGo}`);
    return;
  }
  assert.equal(JSON.parse(fs.readFileSync(copia, 'utf8')).legacy_query_transition.service_flag_env, tr.service_flag_env);
});

test('R19 · com a tolerância, query legada + assinatura válida é aceita e marcada', () => {
  assert.deepEqual(verificar(), { ok: true, queryLegadaTolerada: true });
  // O valor da query não importa (não é comparado): vazio, igual ao segredo ou qualquer outro.
  for (const secret of ['', SEGREDO, 'x']) assert.deepEqual(verificar({ query: { secret } }), { ok: true, queryLegadaTolerada: true });
  // Sem query, com a tolerância ligada: o caminho normal, sem marca.
  assert.deepEqual(verificar({ query: {} }), { ok: true });
});

test('R19 · com a tolerância, a query NUNCA autentica sozinha', () => {
  const outro = crypto.randomBytes(32).toString('base64url');
  const casos = {
    'query legada sem headers': verificar({ headers: {} }),
    'query igual ao segredo, sem headers': verificar({ headers: {}, query: { secret: SEGREDO } }),
    'query igual ao segredo, assinatura de outro segredo': verificar({ headers: assinado({ segredo: outro }), query: { secret: SEGREDO } }),
    'assinatura de outro segredo': verificar({ headers: assinado({ segredo: outro }) }),
    'corpo alterado': verificar({ corpoCru: Buffer.from(CORPO.toString().replace('2220000001', '2229999999')) }),
    'sem corpo verificável': verificar({ corpoCru: undefined }),
    'fora da janela': verificar({ agora: AGORA + (repasse.JANELA_SEGUNDOS + 1) * 1000 }),
    'só timestamp': verificar({ headers: { [repasse.HEADER_TIMESTAMP]: String(Math.floor(AGORA / 1000)) } }),
  };
  for (const [nome, r] of Object.entries(casos)) {
    assert.deepEqual([r.ok, r.status], [false, c.statuses.unauthorized], nome);
    const texto = JSON.stringify(r);
    for (const v of [SEGREDO, LEGADO, outro]) assert.ok(!texto.includes(v), `${nome}: motivo carrega valor sensível`);
  }
  // Sem segredo configurado, a tolerância também não abre nada.
  assert.equal(verificar({ segredo: '' }).status, c.statuses.not_configured);
});

test('R19 · sem a tolerância (ou com valor não booleano), a query continua recusada mesmo assinada', () => {
  for (const toleraQueryLegada of [false, undefined, 'true', 1, '1']) {
    const r = verificar({ toleraQueryLegada });
    assert.deepEqual([r.ok, r.status], [false, c.statuses.unauthorized], String(toleraQueryLegada));
    assert.match(r.motivo, /segredo na query string recusado/);
  }
});
