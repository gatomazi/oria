'use strict';

// Rodada 19 (§4) — WHATSAPP_WEBHOOK_SECRET no boot do painel.
//
// Antes: em produção, sem o segredo do repasse o painel só AVISAVA e subia; a rota
// /api/webhooks/whatsapp respondia 503 para todo repasse do serviço Go e os status de campanha se
// perdiam sem nenhum deploy abortar. Agora, em produção, segredo ausente ou curto (< 32, o mesmo
// critério de lib/platform/whatsapp-forward.js) = processo NÃO sobe.
//
// Medido como em boot-exit-code.test.js: `node server.js` real, código de saída e "não escutou".
// O server.js vem da raiz do SUJEITO (INVARIANT_SUBJECT_ROOT) para o negative control poder
// reintroduzir o "só avisa" numa cópia e exigir que este arquivo reprove.
//
// Não há interruptor que desligue o repasse em produção (a rota está sempre montada), então a
// ausência NUNCA é aceita em produção — nem sem WHATSAPP_SERVICE_URL. Fora de produção vale o padrão
// dos outros segredos de boot: não é exigido e a rota falha fechada (503, trilha-c-whatsapp-forward).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const h = require('./harness');

const SERVER = path.join(h.RAIZ_SUJEITO, 'server.js');
const repasse = h.sujeito('lib/platform/whatsapp-forward.js');

const CHAVE_VALIDA = crypto.randomBytes(32).toString('base64');
const SEGREDO_SESSAO = crypto.randomBytes(32).toString('base64url');
const SEGREDO_REPASSE = crypto.randomBytes(32).toString('base64url');
// 31 caracteres com marcador: se aparecer na saída, o boot vazou o valor.
const SEGREDO_CURTO = `curto${crypto.randomBytes(13).toString('hex')}`;

function ambiente(extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-boot-r19-'));
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    STORAGE_DIR: dir,
    UPLOADS_DIR: path.join(dir, 'uploads'),
    PORT: '0',
    ...extra,
  };
}

function producao(extra = {}) {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: h.urlDoBanco(),
    ENCRYPTION_MASTER_KEY: CHAVE_VALIDA,
    ADMIN_SESSION_SECRET: SEGREDO_SESSAO,
    ...extra,
  };
}

const COM_SERVICO_WHATSAPP = {
  WHATSAPP_SERVICE_URL: 'https://whatsapp.interno.test',
  WHATSAPP_API_KEY: crypto.randomBytes(16).toString('hex'),
  WHATSAPP_SENDER_REF_SECRET: crypto.randomBytes(32).toString('base64url'),
  WHATSAPP_SENDER_RESOLVER_KEY: crypto.randomBytes(32).toString('base64url'),
};

function subir(extra) {
  const r = spawnSync(process.execPath, [SERVER], {
    cwd: h.RAIZ_SUJEITO, encoding: 'utf8', timeout: 20000, env: ambiente(extra),
  });
  return { ...r, saida: `${r.stdout}${r.stderr}` };
}

function assertNaoSobe(r) {
  assert.notEqual(r.signal, 'SIGTERM', `o processo ficou vivo até o timeout (só avisou?).\n${r.saida.slice(-2000)}`);
  assert.equal(typeof r.status, 'number', `sem código de saída (signal ${r.signal})`);
  assert.notEqual(r.status, 0, `segredo do repasse inválido saiu com 0.\n${r.saida.slice(-2000)}`);
  assert.match(r.saida, /\[WHATSAPP_WEBHOOK\] WHATSAPP_WEBHOOK_SECRET (ausente|curto)/, `saiu ≠ 0 por outro motivo.\n${r.saida.slice(-2000)}`);
  assert.doesNotMatch(r.saida, /Oria na porta/, 'escutou antes de morrer');
}

async function subirEEscutar(extra) {
  const filho = spawn(process.execPath, [SERVER], { cwd: h.RAIZ_SUJEITO, env: ambiente(extra) });
  let saida = '';
  try {
    await new Promise((resolve, reject) => {
      const limite = setTimeout(() => reject(new Error(`não escutou em 20s:\n${saida.slice(-2000)}`)), 20000);
      const ler = (buf) => {
        saida += buf;
        if (/Oria na porta/.test(saida)) { clearTimeout(limite); resolve(); }
      };
      filho.stdout.on('data', ler);
      filho.stderr.on('data', ler);
      filho.on('exit', (code) => { clearTimeout(limite); reject(new Error(`saiu com ${code} antes de escutar:\n${saida.slice(-2000)}`)); });
    });
    return saida;
  } finally {
    filho.removeAllListeners('exit');
    filho.kill('SIGKILL');
  }
}

// ── Regra (unidade) ───────────────────────────────────────────────────────────────────────────

test('R19-04 · regra do boot: produção exige segredo ≥ 32; fora de produção não; motivo sem valor', () => {
  const f = repasse.exigirSegredoDeRepasseNoBoot;
  assert.equal(f({ NODE_ENV: 'production' }).ok, false);
  assert.equal(f({ NODE_ENV: 'production', WHATSAPP_WEBHOOK_SECRET: '' }).ok, false);
  assert.equal(f({ NODE_ENV: 'Production', WHATSAPP_WEBHOOK_SECRET: SEGREDO_CURTO }).ok, false);
  assert.equal(f({ NODE_ENV: 'production', WHATSAPP_WEBHOOK_SECRET: 'x'.repeat(repasse.TAMANHO_MINIMO_SEGREDO - 1) }).ok, false);
  assert.equal(f({ NODE_ENV: 'production', WHATSAPP_WEBHOOK_SECRET: 'x'.repeat(repasse.TAMANHO_MINIMO_SEGREDO) }).ok, true);
  assert.equal(f({ NODE_ENV: 'production', WHATSAPP_WEBHOOK_SECRET: SEGREDO_REPASSE }).ok, true);
  // Sem WHATSAPP_SERVICE_URL continua exigido: ausência de variável não é "módulo desligado".
  assert.equal(f({ NODE_ENV: 'production', WHATSAPP_SERVICE_URL: '' }).ok, false);
  assert.equal(f({ NODE_ENV: 'development' }).ok, true);
  assert.equal(f({}).ok, true);
  const curto = f({ NODE_ENV: 'production', WHATSAPP_WEBHOOK_SECRET: SEGREDO_CURTO });
  assert.match(curto.motivo, /WHATSAPP_WEBHOOK_SECRET curto/);
  assert.ok(!curto.motivo.includes(SEGREDO_CURTO), 'o motivo carrega o valor do segredo');
  assert.match(f({ NODE_ENV: 'production' }).motivo, /WHATSAPP_WEBHOOK_SECRET ausente/);
});

// ── Processo real ─────────────────────────────────────────────────────────────────────────────

test('boot · produção sem WHATSAPP_WEBHOOK_SECRET → exit ≠ 0 e não escuta', () => {
  assertNaoSobe(subir(producao()));
});

test('boot · produção com serviço de WhatsApp e remetente, sem WHATSAPP_WEBHOOK_SECRET → exit ≠ 0', () => {
  assertNaoSobe(subir(producao(COM_SERVICO_WHATSAPP)));
});

test('boot · produção com WHATSAPP_WEBHOOK_SECRET curto → exit ≠ 0, sem imprimir o valor', () => {
  const r = subir(producao({ ...COM_SERVICO_WHATSAPP, WHATSAPP_WEBHOOK_SECRET: SEGREDO_CURTO }));
  assertNaoSobe(r);
  assert.match(r.saida, /WHATSAPP_WEBHOOK_SECRET curto/);
  assert.ok(!r.saida.includes(SEGREDO_CURTO), 'o boot imprimiu o valor do segredo');
});

// Controle positivo: sem ele, um server.js que nunca sobe em produção passaria nos casos acima.
test('boot · produção com WHATSAPP_WEBHOOK_SECRET válido → sobe e escuta', async () => {
  const saida = await subirEEscutar(producao({ ...COM_SERVICO_WHATSAPP, WHATSAPP_WEBHOOK_SECRET: SEGREDO_REPASSE }));
  assert.doesNotMatch(saida, /WHATSAPP_WEBHOOK_SECRET (ausente|curto)/);
  assert.ok(!saida.includes(SEGREDO_REPASSE), 'o boot imprimiu o valor do segredo');
});

test('boot · desenvolvimento declarado sem WHATSAPP_WEBHOOK_SECRET → sobe (a rota falha fechada)', async () => {
  const saida = await subirEEscutar({ NODE_ENV: 'development', DATA_STORE_MODE: 'ephemeral-json', ENCRYPTION_MASTER_KEY: CHAVE_VALIDA });
  assert.doesNotMatch(saida, /WHATSAPP_WEBHOOK_SECRET (ausente|curto)/);
});
