'use strict';

// Fase G.1 — lógica pura de montagem das opções de Remarketing/Funil (compartilhada entre GerarTab.tsx
// V1 e GerarTabV2.tsx). Sem harness de teste de componente React neste repositório — mesmo padrão de
// creative-enrichment-review-fields.test.js (F.2.B.1): o módulo sob teste
// (`src/pages/criativos/criativosMotorInput.mjs`) é ESM real, carregado aqui via `import()` dinâmico.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
test.before(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'criativos', 'criativosMotorInput.mjs'));
  mod = await import(url.href);
});

function textoVazio(over = {}) {
  return { ...mod.TEXTO_MOTOR_VAZIO, ...over };
}

// ------------------------------------------------------------------ remarketingOptions
test('remarketingOptions: só intent quando nada mais foi preenchido — nunca inventa headline/CTA', () => {
  const out = mod.remarketingOptions(textoVazio(), 'site_visitor');
  assert.deepEqual(out, { intent: 'site_visitor' });
});

test('remarketingOptions: campo vazio nunca entra no request — o motor decide o padrão', () => {
  const out = mod.remarketingOptions(textoVazio({ headline: '', subheadline: '', cta: '' }), 'cart');
  assert.ok(!('headline' in out) && !('subheadline' in out) && !('cta' in out));
});

test('remarketingOptions: campos preenchidos entram exatamente como digitados', () => {
  const out = mod.remarketingOptions(textoVazio({
    headline: 'Não esqueça', subheadline: 'Seu carrinho te espera', cta: 'Finalizar compra',
    benefits: 'Frete grátis\nTroca fácil', density: 'commercial', emphasis: 'strong', cleanMode: 'never',
  }), 'cart');
  assert.deepEqual(out, {
    intent: 'cart', headline: 'Não esqueça', subheadline: 'Seu carrinho te espera', cta: 'Finalizar compra',
    benefits: ['Frete grátis', 'Troca fácil'], text_density: 'commercial', cta_emphasis: 'strong', clean_mode: 'never',
  });
});

test('remarketingOptions: preserva chaves desconhecidas vindas de "Copiar dados" (extra)', () => {
  const out = mod.remarketingOptions(textoVazio(), 'checkout', { products_source: 'basket', stage_override: 'BOFU' });
  assert.equal(out.products_source, 'basket');
  assert.equal(out.stage_override, 'BOFU');
  assert.equal(out.intent, 'checkout', 'intent sempre vence o que veio em extra, se houver conflito');
});

test('remarketingOptions: benefícios com linhas em branco são descartados, ordem preservada', () => {
  const out = mod.remarketingOptions(textoVazio({ benefits: 'Um\n\n  \nDois\nTrês' }), 'objection');
  assert.deepEqual(out.benefits, ['Um', 'Dois', 'Três']);
});

// ------------------------------------------------------------------ funnelOptions
test('funnelOptions: nada preenchido produz objeto vazio (nem intent, nem stage — funnel_stage é separado)', () => {
  const out = mod.funnelOptions(textoVazio(), 'MOFU');
  assert.deepEqual(out, {});
});

test('funnelOptions: clean_mode sai como BOOLEANO (diferente do enum do Remarketing)', () => {
  assert.equal(mod.funnelOptions(textoVazio({ cleanMode: 'always' }), 'MOFU').clean_mode, true);
  assert.equal('clean_mode' in mod.funnelOptions(textoVazio({ cleanMode: '' }), 'MOFU'), false, 'vazio não vira false explícito — some do request, o motor decide');
});

test('funnelOptions: badges/chips/busca só entram fora do TOFU', () => {
  const preenchido = textoVazio({ badges: 'Novo\nExclusivo', chips: 'Tamanho P\nTamanho M', search: 'blusa azul' });
  const emTofu = mod.funnelOptions(preenchido, 'TOFU');
  assert.ok(!('badges' in emTofu) && !('chips' in emTofu) && !('search_bar_text' in emTofu));
  const emMofu = mod.funnelOptions(preenchido, 'MOFU');
  assert.deepEqual(emMofu.badges, ['Novo', 'Exclusivo']);
  assert.deepEqual(emMofu.chips, ['Tamanho P', 'Tamanho M']);
  assert.equal(emMofu.search_bar_text, 'blusa azul');
  const emBofu = mod.funnelOptions(preenchido, 'BOFU');
  assert.ok('badges' in emBofu && 'chips' in emBofu && 'search_bar_text' in emBofu);
});

test('funnelOptions: headline/CTA/benefícios entram em qualquer etapa, inclusive TOFU', () => {
  const out = mod.funnelOptions(textoVazio({ headline: 'Conheça a coleção', cta: 'Ver mais' }), 'TOFU');
  assert.equal(out.headline, 'Conheça a coleção');
  assert.equal(out.cta, 'Ver mais');
});

test('funnelOptions: preserva chaves desconhecidas de "Copiar dados"', () => {
  const out = mod.funnelOptions(textoVazio(), 'BOFU', { alguma_chave_futura: 'x' });
  assert.equal(out.alguma_chave_futura, 'x');
});

// ------------------------------------------------------------------ restoDe / helpers
test('restoDe: mantém só as chaves que a tela NÃO edita', () => {
  const original = { intent: 'cart', headline: 'x', products_source: 'basket', algo_novo: 1 };
  assert.deepEqual(mod.restoDe(original, mod.CHAVES_REMARKETING), { algo_novo: 1 });
});

test('restoDe: objeto ausente devolve vazio, nunca lança', () => {
  assert.deepEqual(mod.restoDe(undefined, mod.CHAVES_FUNIL), {});
});

test('linhas: descarta vazias e espaços nas pontas', () => {
  assert.deepEqual(mod.linhas('  a  \n\nb\n   \nc'), ['a', 'b', 'c']);
});

test('texto_de/lista_de: valores no formato errado nunca quebram a tela', () => {
  assert.equal(mod.texto_de(42), '');
  assert.equal(mod.texto_de(undefined), '');
  // lista_de é o inverso de `linhas`: array -> texto de Textarea (1 item por linha), nunca um array de volta.
  assert.equal(mod.lista_de('não é array'), '');
  assert.equal(mod.lista_de(['a', 1, 'b']), 'a\n1\nb');
});

// ------------------------------------------------------------------ troca de motor (G.1 §3)
test('textoAoTrocarDeMotor: sempre volta ao estado vazio — nunca herda texto de outro motor', () => {
  assert.deepEqual(mod.textoAoTrocarDeMotor(), mod.TEXTO_MOTOR_VAZIO);
  // objeto novo, não a mesma referência — evita um componente mutar o "vazio" canônico por engano
  assert.notEqual(mod.textoAoTrocarDeMotor(), mod.TEXTO_MOTOR_VAZIO);
});
