'use strict';

// Rodada 18 · §22 — repasse do whatsapp-webhook-go ao painel sem segredo na query string.
//
//   - o contrato (fixture) é o mesmo nos dois repositórios e o vetor de teste confere com a lib;
//   - sem segredo configurado, nada é aceito (503) — antes, aceitava tudo;
//   - `?secret=` é recusado mesmo com a assinatura certa — antes, era a única autenticação;
//   - assinatura errada, corpo alterado, timestamp fora da janela ou headers ausentes → 401;
//   - nenhum motivo de recusa carrega o segredo, a assinatura ou o valor da query.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');
const repasse = h.sujeito('lib/platform/whatsapp-forward.js');

const CONTRATO = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'whatsapp', 'forward-auth-v1.json');
const c = JSON.parse(fs.readFileSync(CONTRATO, 'utf8'));
const SEGREDO = crypto.randomBytes(32).toString('base64url');
const AGORA = Date.UTC(2026, 8, 17, 3, 0, 0);
const CORPO = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '2220000001', changes: [] }] }));

function assinado({ segredo = SEGREDO, corpo = CORPO, ts = String(Math.floor(AGORA / 1000)) } = {}) {
  return {
    [repasse.HEADER_TIMESTAMP]: ts,
    [repasse.HEADER_ASSINATURA]: repasse.assinarRepasse(segredo, ts, corpo),
  };
}

const verificar = (over = {}) => repasse.verificarRepasseWhatsapp({
  segredo: SEGREDO, headers: assinado(), query: {}, corpoCru: CORPO, agora: AGORA, ...over,
});

function semVazamento(resultado, ...valores) {
  const texto = JSON.stringify(resultado);
  for (const v of valores) assert.ok(!texto.includes(v), `motivo da recusa carrega ${v.slice(0, 6)}…`);
}

test('§22 · contrato do repasse: vetor de teste, headers e cópia do Go', (t) => {
  const v = c.test_vector;
  assert.equal(repasse.assinarRepasse(v.secret, v.timestamp, Buffer.from(v.body)), v.signature);
  assert.deepEqual(
    [c.auth.timestamp_header.toLowerCase(), c.auth.signature_header.toLowerCase(), c.auth.signature_scheme],
    [repasse.HEADER_TIMESTAMP, repasse.HEADER_ASSINATURA, repasse.ESQUEMA]
  );
  assert.deepEqual(
    [c.auth.min_secret_length, c.auth.max_clock_skew_seconds, c.auth.forbidden_query_params, c.auth.panel_env],
    [repasse.TAMANHO_MINIMO_SEGREDO, repasse.JANELA_SEGUNDOS, repasse.PARAMETROS_PROIBIDOS, 'WHATSAPP_WEBHOOK_SECRET']
  );
  const ok = repasse.verificarRepasseWhatsapp({
    segredo: v.secret, corpoCru: Buffer.from(v.body), agora: Number(v.timestamp) * 1000,
    headers: { [repasse.HEADER_TIMESTAMP]: v.timestamp, [repasse.HEADER_ASSINATURA]: v.signature },
  });
  assert.deepEqual(ok, { ok: true });

  const dirGo = process.env.WHATSAPP_GO_DIR || path.resolve(h.RAIZ_REPO, '..', '..', 'services', 'whatsapp');
  const copia = path.join(dirGo, 'testdata', 'forward-auth-v1.json');
  if (!fs.existsSync(copia)) {
    t.diagnostic(`cópia do Go não encontrada em ${dirGo} — só a metade do painel foi verificada`);
    return;
  }
  assert.equal(fs.readFileSync(copia, 'utf8'), fs.readFileSync(CONTRATO, 'utf8'), 'as duas cópias do contrato de repasse divergiram');
});

test('§22 · repasse assinado dentro da janela é aceito', () => {
  assert.deepEqual(verificar(), { ok: true });
  // Relógios um pouco diferentes entre os serviços continuam valendo.
  assert.deepEqual(verificar({ agora: AGORA + (repasse.JANELA_SEGUNDOS - 1) * 1000 }), { ok: true });
});

test('§22 · sem segredo configurado nada é aceito (falha fechada)', () => {
  for (const segredo of [null, undefined, '', 'curto-demais']) {
    const r = verificar({ segredo, headers: {}, query: {} });
    assert.equal(r.ok, false, `segredo ${JSON.stringify(segredo)} aceitou`);
    assert.equal(r.status, c.statuses.not_configured);
  }
});

test('§22 · segredo na query string é recusado, mesmo junto com a assinatura certa', () => {
  const r = verificar({ query: { secret: SEGREDO } });
  assert.deepEqual([r.ok, r.status], [false, c.statuses.unauthorized]);
  semVazamento(r, SEGREDO);
  // Só a query, sem headers (o formato antigo): também não.
  const antigo = verificar({ query: { secret: SEGREDO }, headers: {} });
  assert.deepEqual([antigo.ok, antigo.status], [false, c.statuses.unauthorized]);
});

test('§22 · assinatura ausente, errada, de outro corpo ou fora da janela → 401', () => {
  const outroSegredo = crypto.randomBytes(32).toString('base64url');
  const casos = {
    'sem headers': verificar({ headers: {} }),
    'sem timestamp': verificar({ headers: { [repasse.HEADER_ASSINATURA]: assinado()[repasse.HEADER_ASSINATURA] } }),
    'timestamp não numérico': verificar({ headers: { ...assinado(), [repasse.HEADER_TIMESTAMP]: 'agora' } }),
    'outro segredo': verificar({ headers: assinado({ segredo: outroSegredo }) }),
    'corpo alterado': verificar({ corpoCru: Buffer.from(CORPO.toString().replace('2220000001', '2229999999')) }),
    'corpo não verificável': verificar({ corpoCru: undefined }),
    'timestamp antigo (replay)': verificar({ agora: AGORA + (repasse.JANELA_SEGUNDOS + 1) * 1000 }),
    'timestamp no futuro': verificar({ agora: AGORA - (repasse.JANELA_SEGUNDOS + 1) * 1000 }),
    'assinatura com esquema errado': verificar({ headers: { ...assinado(), [repasse.HEADER_ASSINATURA]: assinado()[repasse.HEADER_ASSINATURA].replace('v1=', 'v0=') } }),
  };
  for (const [nome, r] of Object.entries(casos)) {
    assert.deepEqual([r.ok, r.status], [false, c.statuses.unauthorized], nome);
    semVazamento(r, SEGREDO, outroSegredo, assinado()[repasse.HEADER_ASSINATURA]);
  }
});
