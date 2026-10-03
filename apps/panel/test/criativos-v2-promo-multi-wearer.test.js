'use strict';

// Funil por Criativo · preset Oferta/Promoção + "Quem usa a peça?" (multi-wearer: UMA peça em várias pessoas).
// Lógica pura da tela (`criativosMotorInput.mjs`, mesmo padrão ESM/node:test de G.1/G.2) + a passagem do
// request pelo servidor (`requests.js`): o que a tela monta chega ao core sem campo inventado nem perdido.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { normalizeJobInput, buildRequests, planSummary } = require('../lib/creative-core/requests');
const { createMemoryStore } = require('../lib/creative-core/memoryStore');

let mod;
test.before(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'criativos', 'criativosMotorInput.mjs'));
  mod = await import(url.href);
});

const TENANT = 'a1000000-0000-4000-8000-000000000001';
const texto = (campos = {}) => ({ ...mod.TEXTO_MOTOR_VAZIO, ...campos });

// ------------------------------------------------------------------ preset Oferta/Promoção (tela)
test('promo: oferta, desconto, benefício e CTA vão no request com os nomes do contrato do Funil', () => {
  const out = mod.funnelOptions(texto({ headline: 'LEVE 3', discount: '15% OFF', benefits: 'FRETE GRÁTIS', cta: 'EU QUERO' }), 'BOFU', {}, mod.PRESET_PROMO);
  assert.deepEqual(out, { preset: 'promo_offer', headline: 'LEVE 3', discount: '15% OFF', benefits: ['FRETE GRÁTIS'], cta: 'EU QUERO' });
});

test('promo: campo vazio nunca vai no request — a tela não inventa oferta', () => {
  const out = mod.funnelOptions(texto({ discount: '15% OFF' }), 'BOFU', {}, mod.PRESET_PROMO);
  assert.deepEqual(out, { preset: 'promo_offer', discount: '15% OFF' });
  assert.equal(mod.promoTemOferta(texto()), false);
  assert.equal(mod.promoTemOferta(texto({ benefits: '  \n ' })), false);
  assert.equal(mod.promoTemOferta(texto({ cta: 'Comprar agora' })), true);
});

test('promo: selos/chips/busca/modo limpo do funil por etapa nunca entram no preset', () => {
  const out = mod.funnelOptions(texto({ discount: '15% OFF', badges: 'novo', chips: 'a', search: 'b', cleanMode: 'always', density: 'minimal' }), 'BOFU', {}, mod.PRESET_PROMO);
  assert.deepEqual(out, { preset: 'promo_offer', discount: '15% OFF' });
});

test('funil por etapa (V1/G.1) continua idêntico: sem preset e sem discount', () => {
  const t = texto({ headline: 'Garanta', discount: '15% OFF', badges: 'novo' });
  assert.deepEqual(mod.funnelOptions(t, 'BOFU', {}), { headline: 'Garanta', badges: ['novo'] });
  assert.deepEqual(mod.funnelOptions(t, 'BOFU'), mod.funnelOptions(t, 'BOFU', {}, ''));
});

test('Oferta/Promoção é um objetivo ao lado das etapas, e sempre vira BOFU no contrato', () => {
  assert.deepEqual(mod.aplicarObjetivoFunil('promo_offer'), { stage: 'BOFU', preset: 'promo_offer' });
  assert.deepEqual(mod.aplicarObjetivoFunil('TOFU'), { stage: 'TOFU', preset: '' });
  assert.equal(mod.objetivoFunil('BOFU', 'promo_offer'), 'promo_offer');
  assert.equal(mod.objetivoFunil('MOFU', ''), 'MOFU');
});

test('prévia: a oferta é lida do overlay REAL do plano, nunca do estado da tela', () => {
  const overlay = { allowed: true, preset: 'promo_offer', headline: 'LEVE 3', discount: '15% OFF', subheadline: null, benefits: ['FRETE GRÁTIS'], cta: 'EU QUERO' };
  assert.deepEqual(mod.resumoPromo(overlay), [['Oferta', 'LEVE 3'], ['Desconto', '15% OFF'], ['Benefício', 'FRETE GRÁTIS'], ['CTA', 'EU QUERO']]);
  assert.deepEqual(mod.resumoPromo({ ...overlay, preset: undefined }), []);
});

// ------------------------------------------------------------------ "Quem usa a peça?" (tela)
test('quem usa: automático não manda nada; uma pessoa não pergunta sobre compartilhar', () => {
  assert.equal(mod.multiWearerInput('auto', true), undefined);
  assert.deepEqual(mod.multiWearerInput('one', true), { group: 'one' });
  assert.equal(mod.perguntaMesmaPeca('one'), false);
  assert.equal(mod.perguntaMesmaPeca('family'), true);
});

test('quem usa: família com a mesma peça = share all; desmarcado = só a principal veste (apoio sem peça)', () => {
  assert.deepEqual(mod.multiWearerInput('family', true), { group: 'family', share: 'all' });
  assert.deepEqual(mod.multiWearerInput('pair', false), { group: 'pair', share: 'primary_only' });
});

test('prévia: "Pessoas" e "Uso" vêm do plano (subjects + wearers_by_product)', () => {
  const s = (id, pid) => ({ id, persona: { label: id }, wears_product_id: pid });
  const familia = { subjects: [s('s1', 'p'), s('s2', 'p'), s('s3', 'p')], wearers_by_product: { p: ['s1', 's2', 's3'] } };
  assert.equal(mod.textoPessoas(familia, 'family'), 'Família de 3');
  assert.equal(mod.textoUso(familia), 'Mesma peça nas 3 pessoas');
  const apoio = { subjects: [s('s1', 'p'), s('s2', 'p'), s('s3', null)], wearers_by_product: { p: ['s1', 's2'] } };
  assert.equal(mod.textoUso(apoio), 'Mesma peça em 2 de 3 pessoas');
  const uma = { subjects: [s('s1', 'p')], wearers_by_product: null };
  assert.equal(mod.textoPessoas(uma, 'auto'), 'Uma pessoa');
  assert.equal(mod.textoUso(uma), null);
});

// ------------------------------------------------------------------ servidor: o request chega ao core
async function semear(store) {
  const productId = crypto.randomUUID();
  await store.createProduct(TENANT, { id: productId, name: 'Camiseta Todo Mundo é Diferente', type: 'camiseta', references: [{ ref: 'x', mime: 'image/png', sizeBytes: 1 }], metadata: {} });
  const brandId = crypto.randomUUID();
  await store.createProfile('brand', TENANT, { id: brandId, data: { name: 'Entre Nós' }, status: 'active' });
  return { productId, brandId };
}

const jobFunil = (ids, extra = {}) => ({
  engine: 'FUNNEL_VISUAL', product_mode: 'single_product', product_ids: [ids.productId], angle_ids: ['auto'], placements: ['FEED_4X5'],
  quantity: 1, brand: { source: 'profile', id: ids.brandId }, funnel_stage: 'BOFU',
  funnel: mod.funnelOptions(texto({ headline: 'LEVE 3', discount: '15% OFF', benefits: 'FRETE GRÁTIS', cta: 'EU QUERO' }), 'BOFU', {}, mod.PRESET_PROMO),
  multi_wearer: mod.multiWearerInput('family', true), ...extra,
});

test('servidor: oferta + multi_wearer chegam ao CreativeRequest exatamente como a tela montou', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const [item] = await buildRequests(normalizeJobInput(jobFunil(ids)), { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 });
  assert.deepEqual(item.request.funnel, { preset: 'promo_offer', headline: 'LEVE 3', discount: '15% OFF', benefits: ['FRETE GRÁTIS'], cta: 'EU QUERO' });
  assert.deepEqual(item.request.multi_wearer, { group: 'family', share: 'all' });
  assert.equal(item.request.funnel_stage, 'BOFU');
});

test('servidor: sem multi_wearer, o request não ganha a chave (o motor decide como sempre)', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  const [item] = await buildRequests(normalizeJobInput(jobFunil(ids, { multi_wearer: undefined })), { store, tenantId: TENANT, hints: null, planSchemaVersion: 2 });
  assert.equal('multi_wearer' in item.request, false);
});

test('servidor: multi_wearer malformado é recusado antes do core; plano v1 recusa em português', async () => {
  const store = createMemoryStore();
  const ids = await semear(store);
  assert.throws(() => normalizeJobInput(jobFunil(ids, { multi_wearer: { group: 'trio' } })), /quem usa a peça/);
  assert.throws(() => normalizeJobInput(jobFunil(ids, { multi_wearer: { group: 'pair', extra: 1 } })), /quem usa a peça/);
  await assert.rejects(
    buildRequests(normalizeJobInput(jobFunil(ids)), { store, tenantId: TENANT, hints: null, planSchemaVersion: 1 }),
    /exige o plano v2/,
  );
});

test('prévia e geração usam a mesma montagem de request (prepararLote) no servidor', () => {
  const rotas = fs.readFileSync(path.join(__dirname, '..', 'routes', 'criativos.js'), 'utf8');
  const corpo = (rota) => rotas.slice(rotas.indexOf(`router.post('${rota}'`), rotas.indexOf('}));', rotas.indexOf(`router.post('${rota}'`)));
  assert.match(corpo('/preview'), /prepararLote\(req\)/);
  assert.match(corpo('/jobs'), /prepararLote\(req\)/);
});

test('planSummary: expõe wearers_by_product só quando a mesma peça é vestida por 2+ pessoas', () => {
  const base = { plan_id: 'p', overlay: { allowed: true }, products: [{ id: 'p1', name: 'Camiseta' }], subjects: [] };
  assert.equal(planSummary({ ...base, composition: { people_count: 1 } }).wearers_by_product, null);
  const resumo = planSummary({ ...base, composition: { people_count: 3, multi_wearer: true, wearers_by_product: { p1: ['s1', 's2', 's3'] } } });
  assert.deepEqual(resumo.wearers_by_product, { p1: ['s1', 's2', 's3'] });
});

test('aviso de família/grupo (3+ pessoas) é traduzido; código desconhecido continua cru', () => {
  assert.match(mod.textoAviso('people_count_risk:3'), /^Cena com 3 pessoas/);
  assert.equal(mod.textoAviso('algo_novo'), 'algo_novo');
});
