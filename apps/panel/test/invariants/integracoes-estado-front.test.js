'use strict';

// Integrações · tradução do estado do servidor em selo (src/pages/integracoes/estadoIntegracao.ts).
// O servidor decide o estado; a tela só traduz. Aqui: todo estado do vocabulário tem rótulo, nenhum
// rótulo vaza nome de variável/erro cru, e a Ink separa API de webhook.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const h = require('./harness');
const rm = h.sujeito('lib/platform/integration-read-model.js');

function carregar() {
  const js = ts.transpileModule(fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'src', 'pages', 'integracoes', 'estadoIntegracao.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} };
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports }, { filename: 'estadoIntegracao.ts' });
  return modulo.exports;
}
const f = carregar();

test('Given cada estado do vocabulário do servidor, When traduzido, Then tem rótulo e tom (nada cai em "Desconhecido")', () => {
  for (const estado of rm.ESTADOS) {
    const selo = f.seloDoEstado(estado);
    assert.notEqual(selo.label, 'Desconhecido', estado);
    assert.ok(['success', 'warning', 'danger', 'neutral'].includes(selo.tone), estado);
  }
});

test('Given os rótulos, When lidos, Then nenhum vaza env, HTTP, JSON ou código interno', () => {
  const todos = rm.ESTADOS.map((e) => f.seloDoEstado(e).label).join(' | ');
  assert.doesNotMatch(todos, /META_|GOOGLE_|HTTP|40\d|50\d|STORE_WITHOUT|undefined|\{|\}/);
});

test('Given a Ink, When a API está conectada e o webhook adiado, Then é API conectada + webhook não ativado — sem pendente nem erro', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(f.rotuloDaApiInk('connected'))), { label: 'API conectada', tone: 'success' });
  const webhook = f.rotuloDoWebhookInk('deferred');
  assert.equal(webhook.label, 'Webhook não ativado');
  assert.equal(webhook.tone, 'neutral', 'adiado de propósito não é warning');
  assert.doesNotMatch(webhook.label, /pendente|erro/i);
});

test('Given erro e falta de recurso, When traduzidos, Then erro é danger e falta de conta é ação (warning)', () => {
  assert.equal(f.seloDoEstado('error').tone, 'danger');
  assert.equal(f.seloDoEstado('configured').tone, 'warning');
  assert.equal(f.seloDoEstado('platform_unavailable').tone, 'neutral', 'plataforma ausente não é culpa do tenant');
});

test('Given a tela do WhatsApp, When o Embedded Signup está em homologação, Then o texto diz o modo atual', () => {
  const fonte = fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'src', 'pages', 'integracoes', 'WhatsappConectarMeta.tsx'), 'utf8');
  assert.match(fonte, /Modo atual: homologação/);
  assert.match(fonte, /cadastro manual/);
});
