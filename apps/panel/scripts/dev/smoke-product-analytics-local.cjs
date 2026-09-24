'use strict';

// Rodada J · sobe um servidor LOCAL efêmero (banco de teste descartável, criado do zero a cada
// execução, com o GA4/Ink mock — test/helpers/provider-mock.cjs) pré-carregado com um dataset no
// formato de um tenant piloto: 1 Organization, 1 Store, GA4 "conectado" com property mockada,
// catálogo canônico com um produto RASTREADO (bate com o item id que o mock devolve) e dois
// produtos SEM atividade — pensado pra reproduzir localmente, com Claude in Chrome ou qualquer
// navegador, exatamente os estados reais que a tela de Desempenho de Produtos precisa distinguir
// (resolvido / identidade não resolvida / sem atividade / sem integração).
//
// NUNCA toca produção: `DATABASE_URL`, credenciais e o GA4/Ink são todos fake/locais, gerados aqui.
// Sem `railway run`, sem rede externa (o provider-mock intercepta o `fetch` global do processo
// filho). Fica no ar até Ctrl+C — HTTP + navegador conseguem exercitar a UI de verdade, ponta a
// ponta, sem precisar de nenhuma credencial real.
//
// Uso:
//   node scripts/dev/smoke-product-analytics-local.cjs
//   (via `npm run test:pg`-style: precisa do Postgres efêmero do harness — rode com)
//   node scripts/test-db.mjs run -- node scripts/dev/smoke-product-analytics-local.cjs
//
// Imprime a URL, o e-mail e a senha de teste no final — a credencial só existe neste banco
// descartável, recriado do zero a cada execução; nunca é a mesma coisa que uma credencial real.

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

const MOCK = path.join(RAIZ, 'test/helpers/provider-mock.cjs');
const SERVER = path.join(RAIZ, 'server.js');
const ORG_A = 'c1000000-0000-4000-8000-000000000001';
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_smk_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const EMAIL = 'smoke-j@teste.oria';
const PORTA = Number(process.env.SMOKE_PORT) || 18342;

async function main() {
  const db = await h.criarBancoDescartavel('oria_smoke_pa');
  const r = h.migrar(db.url);
  if (r.status !== 0) throw new Error(`migrations falharam: ${r.stdout}${r.stderr}`);
  const sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA_ROLE, tabelasSobRls: manifesto.nomesSobRls() })) {
    await sup.query(sql);
  }
  const fachada = runtime.criarPoolTenant(sup);
  const resolver = createIntegrationResolver({
    pool: fachada, segredos: createSecretStore({ pool: fachada, keyring: createKeyring({ ENCRYPTION_MASTER_KEY: MESTRA }) }),
    env: {}, logger: { warn() {}, error() {} },
  });

  await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [ORG_A, 'Piloto Smoke']);
  const { rows: [store] } = await sup.query(
    'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES (gen_random_uuid(), $1, $2, NULL) RETURNING id',
    [ORG_A, 'Piloto Smoke']
  );
  const storeId = store.id;

  // GA4 "conectado" (refresh token fake, decifrável só com a ENCRYPTION_MASTER_KEY gerada acima) —
  // o mock nunca valida o token de verdade, só ecoa o property_id na resposta.
  await runtime.comContexto({ organizationId: ORG_A, storeId, origem: 'smoke' }, async () => {
    await resolver.gravarSegredo('ga4', 'refresh_token', '1//rt-smoke-single-a');
  });
  await sup.query(
    `INSERT INTO google_analytics_connections (organization_id, store_id, property_id, property_name, status)
     VALUES ($1, $2, '5559876543', 'Site Smoke', 'connected')`,
    [ORG_A, storeId]
  );
  // 3 produtos canônicos: um com dado real no mock do GA4 (o id bate com sku-mock-<property_id> —
  // ver provider-mock.cjs), dois sem NENHUMA atividade — pensados pra provar visualmente os quatro
  // estados de qualidade de dado (resolvido / sem identidade / sem atividade / — a distinção fica
  // clara já na primeira tela).
  const produtos = [
    { providerProductId: 'sku-mock-5559876543', name: 'Camiseta Regional Azul' },
    { providerProductId: 'smoke-sem-atividade', name: 'Bermuda Estampada' },
    { providerProductId: 'smoke-sem-identity', name: 'Boné Aba Curva' },
  ];
  for (const p of produtos) {
    await sup.query(
      `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
       VALUES ($1, $2, 'reserva_ink', $3, $4, gen_random_uuid())`,
      [ORG_A, storeId, p.providerProductId, p.name]
    );
  }
  await runtime.comContexto({ organizationId: ORG_A, storeId, origem: 'smoke' }, () =>
    bootstrapCommerceIdentities({ pool: fachada }, { organizationId: ORG_A, storeId, provider: 'reserva_ink' }));

  // Nenhuma integração 'ink' é criada de propósito: prova o estado "reconciliação sem Commerce
  // conectado" (achado real da rodada J — ver fix(panel): correct product analytics integration
  // findings). Para testar reconciliação com Ink conectado, chame resolver.gravarSegredo('ink', ...)
  // e semeie pedidos_ink manualmente antes de subir o servidor.

  const { rows: [u] } = await sup.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [EMAIL, await senhas.gerarHash(SENHA)]
  );
  await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [ORG_A, u.id, 'owner']);
  await concederFeatures(sup, ORG_A, ['analytics_product_performance']);

  const mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-smoke-pa-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-smoke-pa-srv-'));
  const filho = spawn(process.execPath, ['--require', MOCK, SERVER], {
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

  console.log('\n=== PRONTO — ambiente local, nunca produção ===');
  console.log(`URL: http://localhost:${PORTA}/admin/login`);
  console.log(`E-mail: ${EMAIL}`);
  console.log(`Senha: ${SENHA}`);
  console.log('Ctrl+C encerra o servidor e derruba o banco descartável.');
  console.log('=================================================\n');

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
