'use strict';

// Fase G.2 — lógica pura de multipeça (limite de produtos, filtro de intents, atribuição de "quem
// veste o quê"), no mesmo módulo/padrão de G.1 (`criativosMotorInput.mjs`, ESM, testável com
// node:test sem harness de componente React).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let mod;
test.before(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'criativos', 'criativosMotorInput.mjs'));
  mod = await import(url.href);
});

// ------------------------------------------------------------------ intentsDisponiveis
test('intentsDisponiveis: produto único mantém todos os 7 intents', () => {
  const todos = ['site_visitor', 'product_view', 'collection_discovery', 'cart', 'checkout', 'social_proof', 'objection'];
  assert.deepEqual(mod.intentsDisponiveis(todos, 'single_product'), todos);
});

test('intentsDisponiveis: multipeça nunca oferece product_view (é só-produto-único no core)', () => {
  const todos = ['site_visitor', 'product_view', 'collection_discovery', 'cart', 'checkout', 'social_proof', 'objection'];
  const disponiveis = mod.intentsDisponiveis(todos, 'multi_product');
  assert.ok(!disponiveis.includes('product_view'));
  assert.equal(disponiveis.length, 6);
});

// ------------------------------------------------------------------ limiteDeProdutos
test('limiteDeProdutos: produto único é sempre 1 a 1, mesmo com uma regra de multipeça generosa', () => {
  assert.deepEqual(mod.limiteDeProdutos('single_product', { min: 2, max: 6 }), { min: 1, max: 1 });
});

test('limiteDeProdutos: multipeça usa min/max da regra real do motor', () => {
  assert.deepEqual(mod.limiteDeProdutos('multi_product', { min: 2, max: 5 }), { min: 2, max: 5 });
});

test('limiteDeProdutos: sem regra cadastrada, usa o teto conservador (nunca inventa um intervalo maior)', () => {
  assert.deepEqual(mod.limiteDeProdutos('multi_product', undefined), { min: 2, max: 6 });
});

// ------------------------------------------------------------------ subjectsComOverride
function subjectsDaPreviaExemplo() {
  return [
    { id: 's1', role: 'primary', persona: { label: 'Menina 8 anos' }, age_band: 'child_6_9', wears_product_id: 'prod-a', prominence: 'hero' },
    { id: 's2', role: 'supporting', persona: { label: 'Menino 6 anos' }, age_band: 'child_3_5', relation_to_primary: 'sibling', wears_product_id: 'prod-b', prominence: 'secondary' },
  ];
}

test('subjectsComOverride: sem NENHUMA edição, devolve undefined — o core decide sozinho', () => {
  assert.equal(mod.subjectsComOverride(subjectsDaPreviaExemplo(), {}), undefined);
  assert.equal(mod.subjectsComOverride(subjectsDaPreviaExemplo(), null), undefined);
});

test('subjectsComOverride: sem prévia (subjects vazio/ausente), devolve undefined mesmo com edição pendente', () => {
  assert.equal(mod.subjectsComOverride([], { s1: 'prod-b' }), undefined);
  assert.equal(mod.subjectsComOverride(undefined, { s1: 'prod-b' }), undefined);
});

test('subjectsComOverride: uma edição troca só a peça daquele sujeito — persona/role/relation preservados intactos', () => {
  const base = subjectsDaPreviaExemplo();
  const out = mod.subjectsComOverride(base, { s1: 'prod-b' });
  assert.equal(out.length, 2);
  assert.equal(out[0].wears_product_id, 'prod-b');
  assert.deepEqual(out[0].persona, { label: 'Menina 8 anos' });
  assert.equal(out[0].age_band, 'child_6_9');
  // a segunda pessoa não foi editada — mantém exatamente o que a prévia real tinha (não um valor em branco)
  assert.equal(out[1].wears_product_id, 'prod-b');
  assert.equal(out[1].relation_to_primary, 'sibling');
});

test('subjectsComOverride: null explícito vira "sem peça" (apoio) — nunca tratado como "não editado"', () => {
  const out = mod.subjectsComOverride(subjectsDaPreviaExemplo(), { s2: null });
  assert.equal(out[1].wears_product_id, null);
  assert.equal(out[0].wears_product_id, 'prod-a', 'a pessoa não editada mantém a atribuição real da prévia');
});

test('subjectsComOverride: edição de UMA linha ainda manda TODAS as linhas explícitas (nunca um mix ambíguo)', () => {
  const out = mod.subjectsComOverride(subjectsDaPreviaExemplo(), { s1: 'prod-b' });
  assert.ok(out.every((s) => 'wears_product_id' in s));
  assert.equal(out.length, subjectsDaPreviaExemplo().length);
});

// Achado real do smoke visual G.2: `planSummary()` devolve `product_name` (só para exibição na tela)
// dentro de cada subject — se isso voltasse no request, o backend recusava com "pessoas: campo
// desconhecido: product_name" (requests.js::SUBJECT_KEYS é uma whitelist estrita). Regressão fixada
// aqui para nunca voltar a espalhar o objeto inteiro da prévia no request.
test('subjectsComOverride: nunca devolve product_name (ou qualquer campo fora da whitelist do backend)', () => {
  const CAMPOS_ACEITOS = new Set(['id', 'role', 'persona', 'age_band', 'relation_to_primary', 'relation_label', 'wears_product_id', 'prominence']);
  const comExibicao = subjectsDaPreviaExemplo().map((s) => ({ ...s, product_name: 'Nome só de tela' }));
  const out = mod.subjectsComOverride(comExibicao, { s1: 'prod-b' });
  for (const s of out) {
    assert.ok(!('product_name' in s), 'product_name nunca pode voltar no request — o backend rejeita como campo desconhecido');
    for (const chave of Object.keys(s)) assert.ok(CAMPOS_ACEITOS.has(chave), `${chave} não está na whitelist do backend (SUBJECT_KEYS)`);
  }
});

// Achado real do smoke visual G.2 (2ª rodada, depois do fix acima): mesmo restrito à whitelist, o
// contrato do core (`contracts.py::RequestSubject`) rejeita `relation_to_primary`/`relation_label` como
// `null` explícito ("must not be null") — só `wears_product_id` é `nullable`. `planSummary()` devolve
// esses campos como `null` quando o plano não tem essa relação (ex.: sujeito `primary`, sem
// `relation_to_primary`); precisam ficar AUSENTES no request, nunca `null`.
test('subjectsComOverride: relation_to_primary/relation_label nulos ficam AUSENTES, nunca null explícito', () => {
  const base = [
    { id: 's1', role: 'primary', persona: { label: 'Homem 35 anos' }, age_band: 'adult', relation_to_primary: null, relation_label: null, wears_product_id: 'prod-a', prominence: 'hero' },
    { id: 's2', role: 'supporting', persona: { label: 'Jovem 22 anos' }, age_band: 'adult', relation_to_primary: null, relation_label: null, wears_product_id: 'prod-b', prominence: 'secondary' },
  ];
  const out = mod.subjectsComOverride(base, { s1: null });
  for (const s of out) {
    assert.ok(!('relation_to_primary' in s), 'relation_to_primary null deve ficar ausente, não null explícito');
    assert.ok(!('relation_label' in s), 'relation_label null deve ficar ausente, não null explícito');
  }
  // wears_product_id continua o único campo em que null é um valor explícito válido ("sem peça — apoio")
  assert.equal(out[0].wears_product_id, null);
  assert.ok('wears_product_id' in out[0]);
});

test('subjectsComOverride: relation_to_primary/relation_label presentes (não nulos) continuam preservados', () => {
  const base = [
    { id: 's1', role: 'primary', persona: { label: 'Mãe' }, wears_product_id: 'prod-a', prominence: 'hero' },
    { id: 's2', role: 'supporting', persona: { label: 'Filha' }, relation_to_primary: 'child', relation_label: null, wears_product_id: 'prod-b', prominence: 'secondary' },
  ];
  const out = mod.subjectsComOverride(base, { s1: null });
  assert.equal(out[1].relation_to_primary, 'child');
  assert.ok(!('relation_label' in out[1]), 'relation_label null continua ausente mesmo quando relation_to_primary está presente');
});

// Achado real do smoke G.2.1 (core real, `/v1/plans` direto): com 5-6 produtos numa família com pessoa
// (people_needed == len(products) nos ângulos com pessoa), o PLANO tem 5-6 subjects — mas o contrato de
// REQUEST só aceita até 4 `subjects` explícitos (core `MAX_SUBJECTS`/`requests.js::MAX_SUBJECTS`).
// Reenviar 5-6 linhas editadas era recusado com "subjects: too many items". `subjectsComOverride` nunca
// deve montar esse array — mesmo com edição pendente.
test('subjectsComOverride: acima de MAX_SUBJECTS_EDITAVEIS, nunca monta subjects (o backend recusaria)', () => {
  const cincoPessoas = Array.from({ length: 5 }, (_, i) => ({
    id: `s${i + 1}`, role: i === 0 ? 'primary' : 'supporting',
    persona: { label: `Pessoa ${i + 1}` }, wears_product_id: `prod-${i + 1}`, prominence: i === 0 ? 'hero' : 'secondary',
  }));
  assert.equal(mod.subjectsComOverride(cincoPessoas, { s1: null }), undefined);
});

test('subjectsComOverride: exatamente no teto (4 pessoas), a edição funciona normalmente', () => {
  const quatroPessoas = Array.from({ length: 4 }, (_, i) => ({
    id: `s${i + 1}`, role: i === 0 ? 'primary' : 'supporting',
    persona: { label: `Pessoa ${i + 1}` }, wears_product_id: `prod-${i + 1}`, prominence: i === 0 ? 'hero' : 'secondary',
  }));
  const out = mod.subjectsComOverride(quatroPessoas, { s1: null });
  assert.equal(out.length, 4);
  assert.equal(out[0].wears_product_id, null);
});

test('MAX_SUBJECTS_EDITAVEIS: é 4, espelhando o contrato real do core (contracts.py::MAX_SUBJECTS)', () => {
  assert.equal(mod.MAX_SUBJECTS_EDITAVEIS, 4);
});

// ------------------------------------------------------------------ reset ao trocar de motor
test('overridesAoTrocarDeMotor: sempre volta a nenhuma edição pendente', () => {
  assert.deepEqual(mod.overridesAoTrocarDeMotor(), {});
});
