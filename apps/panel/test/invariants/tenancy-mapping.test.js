'use strict';

// Validador do mapeamento explícito (lib/platform/tenancy-mapping.js). Sem banco: é a primeira
// barreira, antes de qualquer SQL. Ambiguidade e lacuna reprovam aqui; a cobertura contra o dado
// real é conferida no banco (tenancy-migrations.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./harness');
const tm = h.sujeito('lib/platform/tenancy-mapping.js');

const FIXTURES = path.join(h.RAIZ_REPO, 'test', 'fixtures', 'tenancy');
const ler = (nome) => JSON.parse(fs.readFileSync(path.join(FIXTURES, nome), 'utf8'));

test('mapeamento · os dois cenários de PD-019 são válidos e completos para o runtime', () => {
  for (const nome of ['cenario-a.json', 'cenario-b.json']) {
    const m = tm.validarMapeamento(ler(nome));
    tm.verificarCompletudeRuntime(m, { creativeTenant: 'default' });
  }
  assert.equal(ler('cenario-a.json').organizations.length, 3);
  assert.equal(ler('cenario-b.json').organizations.length, 1);
});

test('mapeamento · a mesma chave duas vezes é ambígua, mesmo apontando para a mesma org', () => {
  const m = ler('cenario-b.json');
  m.mapeamentos.push({ ...m.mapeamentos[0] });
  assert.throws(() => tm.validarMapeamento(m), /loja:sul mapeado mais de uma vez/);
});

test('mapeamento · a mesma loja para duas orgs é ambígua', () => {
  const m = ler('cenario-a.json');
  m.mapeamentos.push({ tipo: 'loja', chave: 'centro', organizationId: m.organizations[0].id });
  assert.throws(() => tm.validarMapeamento(m), /loja:centro mapeado mais de uma vez/);
});

test('mapeamento · duas stores com a mesma loja legada é ambíguo', () => {
  const m = ler('cenario-a.json');
  m.organizations[2].store.lojaLegada = 'centro';
  assert.throws(() => tm.validarMapeamento(m), /reivindicada por duas stores/);
});

test('mapeamento · loja legada da store apontando para outra org é erro', () => {
  const m = ler('cenario-a.json');
  m.mapeamentos = m.mapeamentos.map((x) => (x.tipo === 'loja' && x.chave === 'norte'
    ? { ...x, organizationId: m.organizations[0].id } : x));
  assert.throws(() => tm.validarMapeamento(m), /lojaLegada "norte" é da org/);
});

test('mapeamento · V1 é 1:1 — organization sem store, ou com lista de stores, é erro', () => {
  const sem = ler('cenario-b.json');
  delete sem.organizations[0].store;
  assert.throws(() => tm.validarMapeamento(sem), /store ausente/);
  const lista = ler('cenario-b.json');
  lista.organizations[0].store = [lista.organizations[0].store];
  assert.throws(() => tm.validarMapeamento(lista), /store ausente/);
});

test('mapeamento · org inexistente, UUID inválido, tipo desconhecido, chave "*" errada', () => {
  const m = ler('cenario-b.json');
  m.mapeamentos.push({ tipo: 'loja', chave: 'nova', organizationId: 'b1000000-0000-4000-8000-00000000ffff' });
  m.mapeamentos.push({ tipo: 'tudo', chave: '*', organizationId: m.organizations[0].id });
  m.mapeamentos.push({ tipo: 'meta', chave: 'sul', organizationId: m.organizations[0].id });
  m.organizations.push({ id: 'nao-uuid', nome: 'x', store: {} });
  assert.throws(() => tm.validarMapeamento(m), (e) => {
    assert.ok(e instanceof tm.TenancyMappingError);
    assert.match(e.message, /não está em organizations/);
    assert.match(e.message, /tipo inválido/);
    assert.match(e.message, /meta exige chave "\*"/);
    assert.match(e.message, /id não é UUID/);
    return true;
  });
});

test('mapeamento · sem_loja só vale para as tabelas de loja opcional', () => {
  const m = ler('cenario-b.json');
  m.mapeamentos.push({ tipo: 'sem_loja', chave: 'pedidos_ink', organizationId: m.organizations[0].id });
  assert.throws(() => tm.validarMapeamento(m), /sem_loja só vale para/);
});

test('mapeamento · nome com "$" é recusado (não quebra o SQL gerado)', () => {
  const m = ler('cenario-b.json');
  m.organizations[0].nome = 'Use $mapeamento$ Origens';
  assert.throws(() => tm.validarMapeamento(m), /nome inválido/);
});

test('mapeamento · completude de runtime: cada item faltante é listado; nada é deduzido', () => {
  const m = tm.validarMapeamento(ler('cenario-b.json'));
  const parcial = { ...m, mapeamentos: m.mapeamentos.filter((x) => x.tipo === 'loja') };
  assert.throws(
    () => tm.verificarCompletudeRuntime(parcial, { creativeTenant: 'default' }),
    (err) => ['sem_loja:audit_log', 'instalacao:*', 'meta:*', 'google_ads:*', 'creative_tenant:default']
      .every((i) => err.detalhes.includes(i))
  );
  // Tenant do Creative Core configurado diferente: o mapeamento precisa segui-lo.
  assert.throws(() => tm.verificarCompletudeRuntime(m, { creativeTenant: 'Oria' }), /creative_tenant:oria/);
});

test('mapeamento · SQL gerado escapa aspas e é o mesmo para a mesma entrada', () => {
  const m = ler('cenario-b.json');
  m.organizations[0].nome = "Use D'Origens";
  const sql = tm.sqlAplicarMapeamento(m);
  assert.match(sql, /'Use D''Origens'/);
  assert.equal(sql, tm.sqlAplicarMapeamento(m));
});
