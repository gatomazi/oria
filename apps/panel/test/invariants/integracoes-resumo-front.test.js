'use strict';

// Integrações · resumo da linha de cada provedor e alertas de atenção (estadoIntegracao.ts).
// O servidor decide o estado; a tela decide o que dizer e quando vale um alerta. As regras aqui são
// as que impedem mentira: credencial salva não é "conectado", falha de leitura não é "reconectar",
// opcional desligado não é alerta, e um membro não recebe botão que só o responsável pode usar.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const h = require('./harness');

function carregar() {
  const js = ts.transpileModule(fs.readFileSync(path.join(h.RAIZ_SUJEITO, 'src', 'pages', 'integracoes', 'estadoIntegracao.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const modulo = { exports: {} };
  vm.runInNewContext(js, { module: modulo, exports: modulo.exports }, { filename: 'estadoIntegracao.ts' });
  return modulo.exports;
}
const f = carregar();

const linha = (provider, estado, proximaAcao = 'none', extra = {}) => ({
  provider, estado, proximaAcao, entitled: null, platformAvailable: true, ...extra,
});
const dono = { papel: 'owner' };
const membro = { papel: 'member' };
const plain = (o) => JSON.parse(JSON.stringify(o));

test('Given a Ink com credencial, When resumida, Then diz "Credencial cadastrada" (não "Conectado") e mostra o recebimento à parte', () => {
  const sem = f.resumoDoProvedor(linha('ink', 'connected'), { ...dono, ink: { webhookAtivo: false } });
  assert.equal(sem.label, 'Credencial cadastrada');
  assert.equal(sem.detalhe, 'Recebimento automático não ativado');
  assert.equal(sem.tone, 'success', 'o recebimento adiado não rebaixa a integração');
  assert.equal(sem.atencao, null, 'recebimento adiado de propósito não vira alerta');
  const com = f.resumoDoProvedor(linha('ink', 'connected'), { ...dono, ink: { webhookAtivo: true } });
  assert.equal(com.detalhe, 'Recebimento automático de pedidos ativo');
});

test('Given a Ink sem credencial, When resumida, Then é "Não conectado" e não gera alerta', () => {
  const r = f.resumoDoProvedor(linha('ink', 'not_configured', 'configure'), dono);
  assert.equal(r.label, 'Não conectado');
  assert.equal(r.atencao, null);
});

test('Given o WhatsApp com token recusado pela Meta, When o responsável vê, Then é "Reconexão necessária" com alerta para a aba Conexão', () => {
  const r = f.resumoDoProvedor(linha('whatsapp', 'error', 'reconnect'), { ...dono, whatsappModo: 'meta_api' });
  assert.equal(r.label, 'Reconexão necessária');
  assert.equal(r.tone, 'danger');
  assert.deepEqual(plain(r.atencao), { mensagem: 'O WhatsApp precisa ser reconectado', acao: 'Resolver', aba: 'conexao' });
});

test('Given o mesmo erro, When quem vê é membro (não responsável), Then o estado aparece mas NÃO há alerta com botão', () => {
  const r = f.resumoDoProvedor(linha('whatsapp', 'error', 'reconnect'), { ...membro, whatsappModo: 'meta_api' });
  assert.equal(r.label, 'Reconexão necessária');
  assert.equal(r.atencao, null);
});

test('Given uma leitura que falhou (retry), When resumida, Then é "Não foi possível verificar" — nunca "reconectar" nem alerta', () => {
  for (const provider of ['whatsapp', 'meta_ads', 'ga4', 'google_ads', 'ink', 'openai']) {
    const r = f.resumoDoProvedor(linha(provider, 'error', 'retry', { leituraFalhou: true }), { ...dono, whatsappModo: 'meta_api' });
    assert.equal(r.label, 'Não foi possível verificar', provider);
    assert.equal(r.atencao, null, provider);
  }
});

test('Given o WhatsApp com cadastro manual, When resumido, Then diz "Token cadastrado" (só o Embedded Signup passa pela Meta)', () => {
  const manual = f.resumoDoProvedor(linha('whatsapp', 'connected', 'none', { componentes: { modo: 'manual' } }), { ...dono, whatsappModo: 'meta_api' });
  assert.equal(manual.label, 'Token cadastrado');
  const meta = f.resumoDoProvedor(linha('whatsapp', 'connected', 'none', { componentes: { modo: 'embedded_signup' } }), { ...dono, whatsappModo: 'meta_api' });
  assert.equal(meta.label, 'Conectado');
  assert.equal(meta.detalhe, 'Canal: API oficial da Meta');
});

test('Given o WhatsApp Web, When o app está offline, Then o estado vem do app (não do token da Meta) e o alerta leva à aba Canal de envio', () => {
  // Mesmo com o número da Meta em erro, no modo Web o que vale é o app no computador da loja.
  const off = f.resumoDoProvedor(linha('whatsapp', 'error', 'reconnect'), { ...dono, whatsappModo: 'whatsapp_web', agenteWeb: 'offline' });
  assert.equal(off.label, 'App offline');
  assert.equal(off.detalhe, 'Canal: WhatsApp Web');
  assert.equal(off.atencao.aba, 'envio');
  const ok = f.resumoDoProvedor(linha('whatsapp', 'error', 'reconnect'), { ...dono, whatsappModo: 'whatsapp_web', agenteWeb: 'enviando' });
  assert.equal(ok.label, 'Enviando pelo WhatsApp Web');
  assert.equal(ok.atencao, null);
  const pausado = f.resumoDoProvedor(linha('whatsapp', 'connected'), { ...dono, whatsappModo: 'whatsapp_web', agenteWeb: 'pausado' });
  assert.equal(pausado.atencao, null, 'pausar é escolha da pessoa, não problema');
});

test('Given o WhatsApp Web, When o estado do app ainda não chegou ou falhou, Then não afirma offline', () => {
  const carregando = f.resumoDoProvedor(linha('whatsapp', 'connected'), { ...dono, whatsappModo: 'whatsapp_web', agenteWeb: 'carregando' });
  assert.equal(carregando.label, 'Verificando…');
  const falhou = f.resumoDoProvedor(linha('whatsapp', 'connected'), { ...dono, whatsappModo: 'whatsapp_web', agenteWeb: 'indisponivel' });
  assert.equal(falhou.label, 'Não foi possível verificar');
  assert.equal(falhou.atencao, null);
});

test('Given Meta Ads/Google Ads/GA4, When falta escolher conta ou propriedade, Then é "Configuração pendente" com alerta acionável (sem ser owner-only)', () => {
  for (const [provider, texto] of [['meta_ads', 'Meta Ads: falta escolher a conta de anúncios'], ['google_ads', 'Google Ads: falta escolher a conta de anúncios'], ['ga4', 'Google Analytics 4: falta escolher a propriedade']]) {
    const r = f.resumoDoProvedor(linha(provider, 'configured', 'select_resource'), membro);
    assert.equal(r.label, 'Configuração pendente', provider);
    assert.equal(r.tone, 'warning', provider);
    assert.equal(r.atencao.mensagem, texto);
    assert.equal(r.atencao.acao, 'Concluir configuração');
  }
});

test('Given Meta Ads com autorização expirada, When resumido, Then pede reconexão; conectado e não conectado NÃO geram alerta', () => {
  assert.equal(f.resumoDoProvedor(linha('meta_ads', 'error', 'reconnect'), dono).atencao.mensagem, 'Meta Ads precisa ser reconectado');
  for (const estado of ['connected', 'connected_with_data', 'not_configured', 'platform_unavailable', 'not_entitled', 'coming_soon']) {
    assert.equal(f.resumoDoProvedor(linha('meta_ads', estado), dono).atencao, null, estado);
  }
});

test('Given a OpenAI, When resumida, Then fala de chave cadastrada (sem prometer que funciona)', () => {
  assert.equal(f.resumoDoProvedor(linha('openai', 'connected'), dono).label, 'Chave cadastrada');
  assert.equal(f.resumoDoProvedor(linha('openai', 'not_configured', 'configure'), dono).label, 'Chave não cadastrada');
});

test('Given o Instagram, When resumido, Then é "Em breve" sem ação', () => {
  const r = f.resumoDoProvedor(linha('instagram', 'coming_soon'), dono);
  assert.equal(r.label, 'Em breve');
  assert.equal(r.atencao, null);
});

test('Given vários provedores, When montados os alertas, Then só entram os com problema real e acionável', () => {
  const resumos = [
    f.resumoDoProvedor(linha('ink', 'connected'), { ...dono, ink: { webhookAtivo: false } }),
    f.resumoDoProvedor(linha('whatsapp', 'error', 'reconnect'), { ...dono, whatsappModo: 'meta_api' }),
    f.resumoDoProvedor(linha('meta_ads', 'not_configured', 'configure'), dono),
    f.resumoDoProvedor(linha('ga4', 'configured', 'select_resource'), dono),
    f.resumoDoProvedor(linha('instagram', 'coming_soon'), dono),
  ];
  assert.deepEqual(plain(f.alertasDeAtencao(resumos).map((a) => a.provider)), ['whatsapp', 'ga4']);
  assert.deepEqual(plain(f.alertasDeAtencao([])), []);
});

test('Given os textos das linhas, When lidos, Then nenhum vaza jargão de infraestrutura', () => {
  const todos = [];
  for (const provider of ['ink', 'whatsapp', 'meta_ads', 'google_ads', 'ga4', 'openai', 'instagram']) {
    for (const estado of ['not_entitled', 'platform_unavailable', 'not_configured', 'configured', 'connecting', 'connected', 'connected_with_data', 'degraded', 'error', 'deferred', 'coming_soon']) {
      const r = f.resumoDoProvedor(linha(provider, estado, 'reconnect'), { ...dono, whatsappModo: 'meta_api', ink: { webhookAtivo: false } });
      todos.push(r.label, r.detalhe || '', r.atencao ? r.atencao.mensagem : '');
    }
  }
  assert.doesNotMatch(todos.join(' | '), /webhook|payload|retry|token|META_|GOOGLE_|HTTP|undefined/i);
});
