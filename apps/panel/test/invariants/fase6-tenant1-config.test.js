'use strict';

// Fase 6 · Tenant #1 — arquivo, argumentos, cenário, guarda de banco local, sessão somente leitura
// e saída sem segredo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const e = require('../helpers/tenant1-ensaio');

let cfgMod;
const carregar = async () => {
  cfgMod = cfgMod || await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'config.mjs')));
  return cfgMod;
};

test('tenant1 · os dois arquivos de exemplo validam no próprio cenário e só nele', async () => {
  const c = await carregar();
  const a = c.lerTenant1(e.ARQUIVO.A, { cenario: 'A' });
  assert.equal(a.organizations.length, 3);
  assert.equal(a.donoCriativos, 'a1000000-0000-4000-8000-000000000001');
  const b = c.lerTenant1(e.ARQUIVO.B, { cenario: 'B' });
  assert.equal(b.organizations.length, 1);
  assert.throws(() => c.lerTenant1(e.ARQUIVO.B, { cenario: 'A' }), /não confere/);
  assert.deepEqual(c.conferirCenario('A', b.mapeamento).length > 0, true);
  assert.deepEqual(c.conferirCenario('B', a.mapeamento).length > 0, true);
  assert.deepEqual(c.conferirCenario('A', a.mapeamento), []);
  assert.deepEqual(c.conferirCenario('B', b.mapeamento), []);
  assert.deepEqual(c.conferirCenario('C', a.mapeamento), ['cenário desconhecido: "C"']);
});

test('tenant1 · B exige que Centro e Norte convirjam por declaração, não por serem "as que sobraram"', async () => {
  const c = await carregar();
  const b = c.lerTenant1(e.ARQUIVO.B, { cenario: 'B' });
  const semNorte = { ...b.mapeamento, mapeamentos: b.mapeamento.mapeamentos.filter((m) => !(m.tipo === 'loja' && m.chave === 'norte')) };
  assert.ok(c.conferirCenario('B', semNorte).some((x) => x.includes('loja:norte precisa convergir')));
});

test('tenant1 · campos desconhecidos, feature fora do vocabulário e ids fora do mapeamento reprovam', async () => {
  const c = await carregar();
  const base = JSON.parse(fs.readFileSync(e.ARQUIVO.A, 'utf8'));
  const dir = path.dirname(e.ARQUIVO.A);
  const valida = (json) => () => c.validarTenant1(json, { dir, cenario: 'A' });
  assert.throws(valida({ ...base, extra: 1 }), /campos não aceitos: extra/);
  assert.throws(valida({ ...base, organizations: [{ ...base.organizations[0], entitlements: ['tudo'] }, ...base.organizations.slice(1)] }), /fora do vocabulário: tudo/);
  assert.throws(valida({ ...base, whatsapp: { organizationId: base.organizations[0].id } }), /whatsapp: campos não aceitos: organizationId/);
  assert.throws(valida({ ...base, whatsapp: { ...base.whatsapp, waba: { ...base.whatsapp.waba, organizationId: '00000000-0000-4000-8000-000000000000' } } }), /whatsapp.waba.organizationId/);
  assert.throws(valida({ ...base, inkWebhook: { organizations: [] } }), /inkWebhook.organizations/);
  assert.throws(valida({ ...base, owners: [{ ...base.owners[0], passwordHashEnv: 'scrypt$1$valor-direto' }, ...base.owners.slice(1)] }), /NOME de uma variável/);
  assert.throws(valida({ ...base, organizations: [...base.organizations, base.organizations[0]] }), /duplicado/);
  assert.throws(valida({ ...base, versao: 2 }), /versao 2/);
  assert.doesNotThrow(valida({ ...base, whatsapp: null, inkWebhook: null }));
});

test('tenant1 · argumentos: desconhecido ou sem valor reprova', async () => {
  const c = await carregar();
  assert.deepEqual(c.lerArgs(['--scenario', 'A', '--aplicar']), { scenario: 'A', aplicar: true, rollout: false });
  assert.deepEqual(c.lerArgs(['--app-role', 'x', '--saida-segredos', '/tmp/x']), { appRole: 'x', saidaSegredos: '/tmp/x', aplicar: false, rollout: false });
  assert.deepEqual(c.lerArgs(['--rollout']), { aplicar: false, rollout: true });
  assert.throws(() => c.lerArgs(['--cenario', 'A']), /argumento desconhecido/);
  assert.throws(() => c.lerArgs(['--scenario']), /exige um valor/);
  assert.throws(() => c.lerArgs(['--scenario', '--mapping', 'x']), /exige um valor/);
  assert.throws(() => c.exigirCenarioEArquivo({ scenario: 'C', mapping: e.ARQUIVO.A }), /precisa ser A ou B/);
});

test('tenant1 · escrita só em banco local, fora de produção e fora do Railway', async () => {
  const c = await carregar();
  assert.doesNotThrow(() => c.exigirBancoLocal('postgres://u:p@127.0.0.1:5432/x', {}));
  assert.doesNotThrow(() => c.exigirBancoLocal('postgres://u:p@localhost/x', {}));
  assert.throws(() => c.exigirBancoLocal('postgres://u:p@postgres.railway.internal:5432/x', {}), /não é local/);
  assert.throws(() => c.exigirBancoLocal('postgres://u:p@127.0.0.1/x', { NODE_ENV: 'production' }), /NODE_ENV=production/);
  assert.throws(() => c.exigirBancoLocal('postgres://u:p@127.0.0.1/x', { RAILWAY_PROJECT_ID: 'x' }), /Railway/);
  assert.throws(() => c.exigirBancoLocal('nada', {}), /DATABASE_URL inválida/);
});

test('tenant1 · a sessão de preflight/plan/verify é READ ONLY no servidor', async () => {
  const c = await carregar();
  const pool = h.abrirPoolDescartavel(c.urlSomenteLeitura(h.urlDoBanco()), { max: 1 });
  try {
    const { rows } = await pool.query('SHOW default_transaction_read_only');
    assert.equal(rows[0].default_transaction_read_only, 'on');
    await assert.rejects(pool.query('CREATE TEMP TABLE tenant1_nao_pode (x int)'), (err) => err.code === '25006');
  } finally {
    await pool.end();
  }
});

test('tenant1 · saída: valor sensível do ambiente é mascarado e a execução reprova', async () => {
  const c = await carregar();
  const escritas = [];
  const env = { ALGUM_TOKEN: 'valor-muito-secreto-123', DATABASE_URL: 'postgres://u:senhaDoBanco@127.0.0.1/x', CURTO_SECRET: 'abc' };
  const saida = c.criarSaida({ env, escrever: (l) => escritas.push(l) });
  saida.linha('nada sensível aqui abc');
  assert.equal(saida.estado.vazou, false, 'valor curto demais não é tratado como segredo');
  saida.linha('vazou valor-muito-secreto-123 e senhaDoBanco e postgres://outro:qualquer@h/x');
  assert.equal(saida.estado.vazou, true);
  assert.ok(!escritas.join('\n').includes('valor-muito-secreto-123'));
  assert.ok(!escritas.join('\n').includes('senhaDoBanco'));
  assert.ok(!escritas.join('\n').includes('qualquer@'));

  // Ponta a ponta: um argumento com o valor de um segredo é ecoado na mensagem de erro → mascarado
  // e RESULTADO FAIL, mesmo que o erro em si já fosse FAIL.
  const cli = await import(pathToFileURL(path.join(h.RAIZ_REPO, 'scripts', 'tenant1', 'cli.mjs')));
  const r = await cli.executar('plan', ['valor-muito-secreto-123'], { env, escrever: () => {} });
  assert.equal(r.codigo, 1);
  assert.ok(r.linhas.some((l) => l.startsWith('FAIL saida.segredo')));
  assert.ok(!r.linhas.join('\n').includes('valor-muito-secreto-123'));
  const desconhecido = await cli.executar('migrar', [], { env: {}, escrever: () => {} });
  assert.ok(desconhecido.linhas.some((l) => l.includes('comando desconhecido')));
});
