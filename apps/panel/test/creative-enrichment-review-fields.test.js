'use strict';

// Fase F.2.B.1 (§3) — cobre a lógica pura por trás do modal de revisão (EnrichmentReview.tsx):
// aprovação total (caminho de um clique), parcial/ajuste (estado inicial dos checkboxes) e a
// exibição da exclusão. Não há harness de teste de componente React/JSX neste repositório — o
// módulo testado (`src/pages/criativos/enrichmentReviewFields.js`) é a ponte deliberada: lógica pura,
// sem JSX, importada pelo componente E por este teste, carregada aqui via `import()` dinâmico porque
// é um módulo ESM real (ver o comentário no próprio arquivo). Rejeição e persistência (o que a rota
// realmente grava a partir de `acceptedFields`) já são cobertas por
// apps/panel/test/creative-enrichment.test.js e creative-enrichment-pg.test.js — este arquivo cobre
// exatamente a lacuna encontrada nesta fase: o que a TELA decide mostrar/pré-marcar antes de chegar
// à rota.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let campos;
test.before(async () => {
  const url = pathToFileURL(path.join(__dirname, '..', 'src', 'pages', 'criativos', 'enrichmentReviewFields.mjs'));
  campos = await import(url.href);
});

function propostaCaso1() {
  return {
    wearer_roles: ['child'],
    relationship_themes: ['father_child'],
    recommended_supporting_roles: ['father'],
    incompatible_auto_supporting_roles: ['mother', 'sibling', 'grandparent', 'partner', 'friend'],
    scene_intents: ['play', 'bond'],
    visible_text: [],
  };
}

// ------------------------------------------------------------------ camposNaoVazios: a lista completa
test('camposNaoVazios: inclui a exclusão quando populada — nada fica escondido do modo Ajustar', () => {
  const resultado = campos.camposNaoVazios(propostaCaso1());
  assert.deepEqual(resultado.sort(), [
    'incompatible_auto_supporting_roles', 'recommended_supporting_roles',
    'relationship_themes', 'scene_intents', 'wearer_roles',
  ].sort());
});

test('camposNaoVazios: campo vazio ou ausente nunca aparece', () => {
  const resultado = campos.camposNaoVazios({ wearer_roles: [], relationship_themes: ['family'] });
  assert.deepEqual(resultado, ['relationship_themes']);
});

test('camposNaoVazios: proposed nulo/ausente não derruba a função', () => {
  assert.deepEqual(campos.camposNaoVazios(null), []);
  assert.deepEqual(campos.camposNaoVazios(undefined), []);
});

// ------------------------------------------------------------------ aprovação total (1 clique) — F.2.B.1 §3
test('camposPositivos: aprovação total (1 clique) NUNCA inclui a exclusão automaticamente', () => {
  const resultado = campos.camposPositivos(propostaCaso1());
  assert.ok(!resultado.includes(campos.CAMPO_EXCLUSAO), 'a exclusão não pode ser aplicada por um clique sem revisão');
  assert.deepEqual(resultado.sort(), ['recommended_supporting_roles', 'relationship_themes', 'scene_intents', 'wearer_roles'].sort());
});

test('camposPositivos: sem exclusão proposta, o conjunto é idêntico a camposNaoVazios', () => {
  const proposta = { relationship_themes: ['family'], scene_intents: ['play'] };
  assert.deepEqual(campos.camposPositivos(proposta), campos.camposNaoVazios(proposta));
});

// ------------------------------------------------------------------ modo Ajustar — estado inicial dos checkboxes
test('camposPositivos como estado inicial do Ajustar: a exclusão começa DESMARCADA por padrão', () => {
  const marcadosInicialmente = new Set(campos.camposPositivos(propostaCaso1()));
  assert.ok(!marcadosInicialmente.has(campos.CAMPO_EXCLUSAO), 'exclusão não pré-marcada — opt-in explícito exigido');
  // mas continua VISÍVEL como opção no modo Ajustar (a lista de checkboxes usa camposNaoVazios, não
  // camposPositivos, no componente) — cobrindo o "exiba claramente OU desmarque por padrão" das duas
  // formas ao mesmo tempo, uma por fluxo.
  assert.ok(campos.camposNaoVazios(propostaCaso1()).includes(campos.CAMPO_EXCLUSAO));
});

test('camposPositivos: outros campos (positivos) continuam pré-marcados — só a exclusão muda', () => {
  const marcadosInicialmente = new Set(campos.camposPositivos(propostaCaso1()));
  for (const c of ['wearer_roles', 'relationship_themes', 'recommended_supporting_roles', 'scene_intents']) {
    assert.ok(marcadosInicialmente.has(c), `${c} deveria continuar marcado por padrão`);
  }
});

// ------------------------------------------------------------------ exibição explícita da exclusão
test('temExclusaoProposta: true exatamente quando a exclusão está populada', () => {
  assert.equal(campos.temExclusaoProposta(propostaCaso1()), true);
  assert.equal(campos.temExclusaoProposta({ relationship_themes: ['family'] }), false);
  assert.equal(campos.temExclusaoProposta({ incompatible_auto_supporting_roles: [] }), false, 'array vazio não conta como proposta');
});

// ------------------------------------------------------------------ caso 2/3 do piloto — nenhuma exclusão presente
test('caso 2 do piloto (sem recomendação/exclusão): camposPositivos não inventa nada', () => {
  const proposta = { wearer_roles: [], relationship_themes: [], recommended_supporting_roles: [], incompatible_auto_supporting_roles: [], scene_intents: [], visible_text: [] };
  assert.deepEqual(campos.camposNaoVazios(proposta), []);
  assert.deepEqual(campos.camposPositivos(proposta), []);
  assert.equal(campos.temExclusaoProposta(proposta), false);
});

test('caso 3 do piloto (visible_text evidenciado, sem exclusão): camposPositivos preserva visible_text', () => {
  const proposta = { wearer_roles: [], relationship_themes: [], recommended_supporting_roles: [], incompatible_auto_supporting_roles: [], scene_intents: [], visible_text: ['FEITO A MAO'] };
  assert.deepEqual(campos.camposPositivos(proposta), ['visible_text']);
  assert.equal(campos.temExclusaoProposta(proposta), false);
});
