'use strict';

// Rodada M · sobe um servidor LOCAL efêmero com 5 Organizations, uma por cenário de disponibilidade
// de integração que a Jornada de Compra precisa suportar sem erro 500 (§5 do comando):
//
//   1. GA4 isolado        — só GA4 conectado (mock)
//   2. Commerce isolado   — só Ink conectado (mock), com pedidos pagos reais seedados
//   3. GA4 + Commerce     — os dois conectados
//   4. Tudo conectado     — GA4 + Ink + Meta Ads (conta selecionada)
//   5. Nada conectado     — nenhuma integração
//
// NUNCA toca produção — GA4/Ink são mock (test/helpers/provider-mock.cjs), Meta Ads é só uma linha
// local em meta_ad_accounts (a leitura de campanha é de meta_insights_daily, sem chamada à Graph API
// nesta rodada). Sem `railway run`, sem rede externa.
//
// Uso:
//   node scripts/test-db.mjs run -- node scripts/dev/smoke-jornada-cenarios-local.cjs

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
const SENHA = 'senha-forte-de-teste-123';
const ROLE = `oria_app_smkm_${crypto.randomBytes(4).toString('hex')}`;
const SENHA_ROLE = crypto.randomBytes(16).toString('hex');
const MESTRA = crypto.randomBytes(32).toString('base64');
const PORTA = Number(process.env.SMOKE_PORT) || 18360;

const CENARIOS = [
  { chave: 'ga4-isolado', email: 'm-ga4@teste.oria', ga4: true, ink: false, meta: false },
  { chave: 'commerce-isolado', email: 'm-commerce@teste.oria', ga4: false, ink: true, meta: false },
  { chave: 'ga4-commerce', email: 'm-ga4-commerce@teste.oria', ga4: true, ink: true, meta: false },
  { chave: 'tudo-conectado', email: 'm-tudo@teste.oria', ga4: true, ink: true, meta: true },
  { chave: 'nada-conectado', email: 'm-nada@teste.oria', ga4: false, ink: false, meta: false },
];

async function main() {
  const db = await h.criarBancoDescartavel('oria_smoke_m');
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

  let propertyIdSeq = 5560000000;
  let inkOrderIdSeq = 1;

  for (const cenario of CENARIOS) {
    const orgId = crypto.randomUUID();
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [orgId, `Rodada M — ${cenario.chave}`]);
    const { rows: [store] } = await sup.query(
      'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES (gen_random_uuid(), $1, $2, NULL) RETURNING id',
      [orgId, `Rodada M — ${cenario.chave}`]
    );
    const storeId = store.id;

    if (cenario.ga4) {
      const propertyId = String(propertyIdSeq++);
      await runtime.comContexto({ organizationId: orgId, storeId, origem: 'smoke-m' }, async () => {
        await resolver.gravarSegredo('ga4', 'refresh_token', `1//rt-smokeM-${cenario.chave}`);
      });
      await sup.query(
        `INSERT INTO google_analytics_connections (organization_id, store_id, property_id, property_name, status)
         VALUES ($1, $2, $3, $4, 'connected')`,
        [orgId, storeId, propertyId, `Site ${cenario.chave}`]
      );
      // 1 produto canônico batendo com o item id que o mock do GA4 devolve para esta property.
      await sup.query(
        `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id)
         VALUES ($1, $2, 'reserva_ink', $3, $4, gen_random_uuid())`,
        [orgId, storeId, `sku-mock-${propertyId}`, 'Produto GA4 mock']
      );
      await runtime.comContexto({ organizationId: orgId, storeId, origem: 'smoke-m' }, () =>
        bootstrapCommerceIdentities({ pool: fachada }, { organizationId: orgId, storeId, provider: 'reserva_ink' }));
    }

    if (cenario.ink) {
      await runtime.comContexto({ organizationId: orgId, storeId, origem: 'smoke-m' }, async () => {
        await resolver.gravarSegredo('ink', 'api_token', `ink-token-smokeM-${cenario.chave}`);
      });
      // 2 pedidos pagos reais no cache local — prova "Commerce confirmado" com dado de verdade,
      // nunca inventado no service (a UI lê isto via CommerceConnector.listOrders).
      for (let i = 0; i < 2; i += 1) {
        const inkOrderId = inkOrderIdSeq++;
        await sup.query(
          `INSERT INTO pedidos_ink (organization_id, store_id, ink_order_id, payment_status, order_status, total_value, criado_em, is_troca)
           VALUES ($1, $2, $3, 'paid', 'delivered', $4, $5, false)`,
          [orgId, storeId, inkOrderId, '150.00', '2026-09-10']
        );
      }
    }

    if (cenario.meta) {
      await sup.query(
        `INSERT INTO meta_ad_accounts (organization_id, meta_account_id, nome, currency, selecionada)
         VALUES ($1, $2, $3, 'BRL', true)`,
        [orgId, `act_smokeM_${cenario.chave}`, `Conta ${cenario.chave}`]
      );
      await sup.query(
        `INSERT INTO meta_insights_daily (organization_id, meta_account_id, level, entidade_id, data, meta_campaign_id, impressions, clicks, spend, purchases, purchase_value)
         VALUES ($1,$2,'campaign','camp_smokeM','2026-09-10','camp_smokeM',5000,120,'250.00',9,'890.00')`,
        [orgId, `act_smokeM_${cenario.chave}`]
      );
    }

    const { rows: [u] } = await sup.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [cenario.email, await senhas.gerarHash(SENHA)]
    );
    await sup.query('INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)', [orgId, u.id, 'owner']);
    await concederFeatures(sup, orgId, ['analytics_product_performance']);
  }

  const mockLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oria-smoke-m-mock-')), 'chamadas.jsonl');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oria-smoke-m-srv-'));
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
  console.log(`Senha (todos os logins): ${SENHA}`);
  for (const cenario of CENARIOS) console.log(`  ${cenario.chave.padEnd(18)} → ${cenario.email}`);
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
