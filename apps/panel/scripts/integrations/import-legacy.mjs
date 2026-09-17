#!/usr/bin/env node
// Fase 4 · importa as credenciais de tenant que ainda moram fora de integration_secrets (OPS-23).
//
//   origem                                           → integração (organization, provider) / segredo
//   meta_connections.access_token_encrypted          → meta / access_token
//   google_ads_connections.{refresh,access}_token_*  → google_ads / refresh_token, access_token
//   google_analytics_connections (loja da Store)     → ga4 / refresh_token, access_token
//   creative_settings.openai_key_enc                 → openai / api_key
//   INK_TOKEN_<LOJA>, INK_FEED_URL_<LOJA>,
//   INK_WEBHOOK_SECRET_<LOJA>                        → ink / api_token, feed_url, webhook_secret
//
// O dono é sempre o que já está explícito: organization_id da linha, ou — para as variáveis da Ink —
// a loja legada da Store da Organization E o mapeamento `loja` da tenancy apontando para ela. Nunca
// "há uma Organization, deve ser dela".
//
// Segredo nenhum aparece em argumento, log ou saída: o relatório traz só contagens e last4 ausente.
// Grava cifrado na versão CORRENTE da chave (re-cifra os legados de ADMIN_SESSION_SECRET quando
// ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1 permite lê-los). Idempotente: segredo já importado com o
// mesmo valor é pulado.
//
// Uso (role de migration, no pre-deploy — nunca o processo da app):
//   DATABASE_URL=... ENCRYPTION_MASTER_KEY=... node scripts/integrations/import-legacy.mjs            (simula)
//   ... node scripts/integrations/import-legacy.mjs --aplicar
//   ... node scripts/integrations/import-legacy.mjs --aplicar --limpar-colunas-legadas            (release N+1)
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { createKeyring } = require('../../lib/secrets/keyring.js');
const { createSecretStore } = require('../../lib/secrets/store.js');
const { SEGREDOS, ENV_IMPORTACAO_INK } = require('../../lib/platform/integrations.js');
const { LOJAS_LEGADAS } = require('../../lib/platform/tenancy-manifest.js');

const COLUNAS_LEGADAS = [
  { tabela: 'meta_connections', colunas: ['access_token_encrypted'] },
  { tabela: 'google_ads_connections', colunas: ['refresh_token_encrypted', 'access_token_encrypted'] },
  { tabela: 'google_analytics_connections', colunas: ['refresh_token_encrypted', 'access_token_encrypted'] },
  { tabela: 'creative_settings', colunas: ['openai_key_enc'] },
];

async function comOrg(client, org, fn) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
    const r = await fn();
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function importarLegado(url, { env = process.env, aplicar = false, limparColunas = false } = {}) {
  const keyring = createKeyring(env);
  if (aplicar && !keyring.disponivel()) throw new Error('ENCRYPTION_MASTER_KEY ausente — não há como gravar os segredos');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const store = createSecretStore({ pool: { query: (...a) => client.query(...a) }, keyring });
  const relatorio = { aplicado: aplicar, organizations: [], ilegiveis: 0, importados: 0, jaImportados: 0, limpos: 0 };
  try {
    const { rows: orgs } = await client.query(
      'SELECT organization_id, loja_legada FROM tenancy_organizations_para_jobs() ORDER BY organization_id'
    );
    for (const { organization_id: org, loja_legada: loja } of orgs) {
      const item = { organizationId: org, loja, segredos: [] };
      relatorio.organizations.push(item);
      await comOrg(client, org, async () => {
        // Candidatos: [provider, tipo, obter valor em claro (ou null), expiresAt, origem]
        const candidatos = [];
        const cifrado = (provider, tipo, ciphertext, expiresAt, origem) => {
          if (!ciphertext) return;
          const valor = keyring.decrypt(ciphertext, { contexto: SEGREDOS[provider][tipo] });
          candidatos.push({ provider, tipo, valor, expiresAt: expiresAt || null, origem });
        };
        const { rows: meta } = await client.query('SELECT * FROM meta_connections WHERE organization_id = $1', [org]);
        for (const r of meta) cifrado('meta', 'access_token', r.access_token_encrypted, r.token_expires_at, 'meta_connections');
        const { rows: gads } = await client.query('SELECT * FROM google_ads_connections WHERE organization_id = $1', [org]);
        for (const r of gads) {
          cifrado('google_ads', 'refresh_token', r.refresh_token_encrypted, null, 'google_ads_connections');
          cifrado('google_ads', 'access_token', r.access_token_encrypted, r.token_expires_at, 'google_ads_connections');
        }
        // GA4: só a linha da loja da Store desta Organization (1:1). Outras lojas não têm dono aqui.
        const { rows: ga } = await client.query(
          'SELECT * FROM google_analytics_connections WHERE organization_id = $1 AND loja = $2', [org, loja]
        );
        for (const r of ga) {
          cifrado('ga4', 'refresh_token', r.refresh_token_encrypted, null, 'google_analytics_connections');
          cifrado('ga4', 'access_token', r.access_token_encrypted, r.token_expires_at, 'google_analytics_connections');
        }
        const { rows: cs } = await client.query('SELECT openai_key_enc FROM creative_settings WHERE organization_id = $1', [org]);
        for (const r of cs) cifrado('openai', 'api_key', r.openai_key_enc, null, 'creative_settings');
        // Ink: variável da loja legada DESTA Store, e só se o mapeamento `loja` também aponta para cá.
        if (loja && LOJAS_LEGADAS.includes(loja)) {
          const { rows: [dono] } = await client.query('SELECT tenancy_organization_da_loja($1) AS id', [loja]);
          if (dono && dono.id === org) {
            // webhook_secret também: desde a Fase 5c a entrada do webhook só confere o segredo da
            // integração (URL opaca por Organization).
            for (const tipo of ['api_token', 'feed_url', 'webhook_secret']) {
              const valor = env[ENV_IMPORTACAO_INK[tipo](loja)];
              if (valor) candidatos.push({ provider: 'ink', tipo, valor, expiresAt: null, origem: `env:${ENV_IMPORTACAO_INK[tipo](loja)}` });
            }
          }
        }

        for (const c of candidatos) {
          const linha = { provider: c.provider, tipo: c.tipo, origem: c.origem };
          item.segredos.push(linha);
          if (c.valor === null) { linha.resultado = 'ilegivel'; relatorio.ilegiveis += 1; continue; }
          const { rows: [integ] } = await client.query(
            `SELECT id FROM integrations WHERE organization_id = $1 AND provider = $2 AND escopo IS NULL`, [org, c.provider]
          );
          if (integ) {
            const igual = await store.usarSegredo(
              { integrationId: integ.id, organizationId: org, tipo: c.tipo, contexto: SEGREDOS[c.provider][c.tipo], aceitarVencido: true },
              (atual) => atual === c.valor
            ).catch(() => false);
            if (igual) { linha.resultado = 'ja_importado'; relatorio.jaImportados += 1; continue; }
          }
          if (!aplicar) { linha.resultado = 'a_importar'; continue; }
          await client.query(
            `INSERT INTO integrations (organization_id, provider, escopo, status) VALUES ($1, $2, NULL, 'connected')
             ON CONFLICT DO NOTHING`,
            [org, c.provider]
          );
          const { rows: [nova] } = await client.query(
            `SELECT id FROM integrations WHERE organization_id = $1 AND provider = $2 AND escopo IS NULL`, [org, c.provider]
          );
          await store.gravar({
            integrationId: nova.id, organizationId: org, tipo: c.tipo, valor: c.valor,
            expiresAt: c.expiresAt, contexto: SEGREDOS[c.provider][c.tipo],
          });
          // Confere que o gravado decifra para o mesmo valor com a chave corrente.
          const ok = await store.usarSegredo(
            { integrationId: nova.id, organizationId: org, tipo: c.tipo, contexto: SEGREDOS[c.provider][c.tipo], aceitarVencido: true },
            (lido) => lido === c.valor
          );
          if (!ok) throw new Error(`verificação falhou em ${c.provider}/${c.tipo} da organization ${org}`);
          await client.query(`UPDATE integrations SET status = 'connected', atualizado_em = now() WHERE id = $1 AND organization_id = $2`, [nova.id, org]);
          linha.resultado = 'importado';
          relatorio.importados += 1;
        }

        // Release N+1: só depois de todo segredo desta Organization estar em integration_secrets.
        if (aplicar && limparColunas && !item.segredos.some((l) => l.resultado === 'ilegivel')) {
          for (const { tabela, colunas } of COLUNAS_LEGADAS) {
            const set = colunas.map((c) => `${c} = NULL`).join(', ');
            const onde = colunas.map((c) => `${c} IS NOT NULL`).join(' OR ');
            const { rowCount } = await client.query(`UPDATE ${tabela} SET ${set} WHERE organization_id = $1 AND (${onde})`, [org]);
            relatorio.limpos += rowCount;
          }
        }
      });
    }
  } finally {
    await client.end();
  }
  return relatorio;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL ausente');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  importarLegado(process.env.DATABASE_URL, {
    aplicar: args.includes('--aplicar'),
    limparColunas: args.includes('--limpar-colunas-legadas'),
  })
    .then((r) => {
      for (const o of r.organizations) {
        for (const s of o.segredos) console.log(`${o.organizationId} ${s.provider}/${s.tipo} ← ${s.origem}: ${s.resultado}`);
      }
      console.log(`integrações: ${r.importados} importado(s), ${r.jaImportados} já importado(s), ${r.ilegiveis} ilegível(is), ${r.limpos} linha(s) legada(s) limpa(s)${r.aplicado ? '' : ' — SIMULAÇÃO (use --aplicar)'}`);
      if (r.ilegiveis > 0) process.exit(1);
    })
    .catch((err) => { console.error(`integrações: ${err.message}`); process.exit(1); });
}
