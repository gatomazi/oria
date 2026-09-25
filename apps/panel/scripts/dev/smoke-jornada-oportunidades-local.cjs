'use strict';

// Gate F ("Jornada de Valor") · sobe um servidor LOCAL efêmero com 1 Organization, catálogo de 7
// produtos e o mock de GA4 multi-item (mock-ga4-multi-item.cjs, DEMONSTRAÇÃO — números fabricados,
// nunca produção) pra provar "Prioridades de hoje" com sinais REAIS calculados pelo motor real
// (opportunity-diagnostics.js) contra uma Store com baseline de verdade. Nunca toca produção.
//
// Uso:
//   node scripts/test-db.mjs run -- node scripts/dev/smoke-jornada-oportunidades-local.cjs

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..', '..');
const h = require(path.join(RAIZ, 'test/invariants/harness.js'));
const senhas = h.sujeito('lib/auth/password.js');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { createIntegrationResolver } = h.sujeito('lib/platform/integrations.js');
const { createSecretStore } = h.sujeito('lib/secrets/store.js');
const { createKeyring } = h.sujeito('lib/secrets/keyring.js');
const { bootstrapCommerceIdentities } = h.sujeito('lib/product-analytics/product-identity-resolver.js');
const { concederFeatures } = require(path.join(RAIZ, 'test/helpers/linhas.js'));

const MOCK_MULTI = path.join(__dirname, 'mock-ga4-multi-item.cjs');
const SERVER = path.join(RAIZ, 'server.js');
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_smkc_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const PORTA = Number(process.env.SMOKE_PORT) || 18361;
const PROPERTY_MULTI = '9990001';
const EMAIL = 'gate-c@teste.oria';

// Mesmos ids/nomes de mock-ga4-multi-item.cjs — duplicado aqui (nunca via require() no processo
// pai: o outro arquivo reescreve globalThis.fetch como efeito colateral, que só faz sentido dentro
// do processo filho que roda o server.js).
const PRODUTOS_DEMO = [
  'saudavel-1', 'saudavel-2', 'saudavel-3', 'saudavel-4', 'saudavel-5', 'baixa-conversao', 'fricção-frete',
];

async function main() {
  const db = await h.criarBancoDescartavel('oria_smoke_c');
  const r = h.migrar(db.url);
  if (r.status !== 0) throw new Error(`migrations falharam: ${r.stdout}${r.stderr}`);
  const sup = h.abrirPoolDescartavel(db.url, { max: 8 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const fachada = runtime.criarPoolTenant(sup);
  const resolver = createIntegrationResolver({
    pool: fachada, segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {}, logger: { warn() {}, error() {} },
  });

  const orgId = crypto.randomUUID();
  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [orgId, 'Gate C — Prioridades de hoje']);
  const { rows: [store] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES (gen_random_uuid(), $1, $2, NULL) RETURNING id',
    [orgId, 'Gate C — Prioridades de hoje']
  );
  const storeId = store.id;

  await runtime.comContexto({ organizationId: orgId, storeId, origem: 'smoke-c' }, async () => {
    await resolver.gravarSegredo('ga4', 'refresh_token', '1//rt-smokeC-gate-c');
  });
  await sup.query(
    `INSERT INTO google_analytics_connections (organization_id, store_id, property_id, property_name, status)
     VALUES ($1, $2, $3, $4, 'connected')`,
    [orgId, storeId, PROPERTY_MULTI, 'Site Gate C']
  );
  for (const id of PRODUTOS_DEMO) {
    await sup.query(
      `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
       VALUES ($1, $2, 'reserva_ink', $3, $4, gen_random_uuid())`,
      [orgId, storeId, `sku-demo-${id}`, `Produto ${id}`]
    );
  }
  await runtime.comContexto({ organizationId: orgId, storeId, origem: 'smoke-c' }, () =>
    bootstrapCommerceIdentities({ pool: fachada }, { organizationId: orgId, storeId, provider: 'reserva_ink' }));

  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [EMAIL, await senhas.gerarHash(SENHA)]
  );
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [orgId, u.id, 'owner']);
  await concederFeatures(sup, orgId, ['analytics_product_performance']);

  const mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-smoke-c-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-smoke-c-srv-'));
  const filho = spawn(process.execPath, ['--require', MOCK_MULTI, SERVER], {
    cwd: RAIZ,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, STORAGE_DIR: dir, UPLOADS_DIR: path.join(dir, 'uploads'),
      PORT: String(PORTA), NODE_ENV: 'development',
      DATABASE_URL: h.urlComUsuario(db.url, ROLE, SENHA_ROLE),
      DB_ENFORCE_APP_ROLE: '1',
      ENCRYPTION_MASTER_KEY: MESTRA,
      ADMIN_SESSION_SECRET: crypto.randomBytes(32).toString('base64url'),
      PROVIDER_MOCK_LOG: mockLog,
      GOOGLE_CLIENT_ID: 'cliente-google', GOOGLE_CLIENT_SECRET: 'segredo-plataforma-google', GOOGLE_OAUTH_REDIRECT_URI: 'https://oria.test/cb',
    },
  });
  filho.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  filho.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  await new Promise((resolve, reject) => {
    const limite = setTimeout(() => reject(new Error('não escutou a tempo')), 30000);
    filho.stdout.on('data', (d) => { if (/na porta/.test(String(d))) { clearTimeout(limite); resolve(); } });
    filho.on('exit', (c) => { clearTimeout(limite); reject(new Error(`saiu com ${c}`)); });
  });

  console.log('\n=== PRONTO — ambiente local, DEMONSTRAÇÃO (números fabricados), nunca produção ===');
  console.log(`URL: http://localhost:${PORTA}/admin/login`);
  console.log(`Login: ${EMAIL} / Senha: ${SENHA}`);
  console.log('Ctrl+C encerra o servidor e derruba o banco descartável.');
  console.log('===================================================================================\n');

  const encerrar = async () => {
    filho.kill('SIGKILL');
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
    await db.destruir();
    process.exit(0);
  };
  process.on('SIGTERM', encerrar);
  process.on('SIGINT', encerrar);
}

main().catch((err) => { console.error('ERRO:', err); process.exit(1); });
