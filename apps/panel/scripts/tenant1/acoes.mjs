// Fase 6 · Tenant #1 — plan, apply e rollback.
//
// O apply ORQUESTRA os passos que já existem; não reimplementa nenhuma regra:
//
//   1 mapeamento     scripts/tenancy/aplicar-mapeamento.mjs     (transação; divergência aborta)
//   2 owners         scripts/auth/bootstrap-owner.mjs           (transação por owner)
//   3 entitlements   scripts/tenancy/seed-entitlements.mjs      (transação por Organization)
//   4 integrações    scripts/integrations/import-legacy.mjs     (transação por Organization; NUNCA limpa colunas)
//   5 re-cifra       scripts/integrations/reencrypt.mjs
//   6 WhatsApp       scripts/integrations/import-whatsapp-sender.mjs (se declarado)
//   7 criativos      scripts/tenancy/mover-criativos.mjs
//   8 URL da Ink     mesma regra da tela (POST /api/admin/integrations/ink/webhook-url), transação
//   9 auditoria      lib/platform/audit.js, sujeito = owner declarado da Organization
//
// Antes de escrever qualquer coisa, o preflight inteiro roda; um FAIL aborta com zero escrita.
// Depois, o verify roda e decide o resultado. Rodar de novo não muda nada (e não audita de novo).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { urlSomenteLeitura, exigirBancoLocal, resultado, Tenant1Error, CENARIO_ALVO_ROLLOUT } from './config.mjs';
import { coletar, impressaoDigital, compararImpressoes, ACAO_TENANT1, ACAO_ROLLBACK } from './checks.mjs';
import { aplicarMapeamento } from '../tenancy/aplicar-mapeamento.mjs';
import { seedEntitlements } from '../tenancy/seed-entitlements.mjs';
import { moverCriativos } from '../tenancy/mover-criativos.mjs';
import { bootstrapOwner } from '../auth/bootstrap-owner.mjs';
import { importarLegado } from '../integrations/import-legacy.mjs';
import { importarRemetenteWhatsapp } from '../integrations/import-whatsapp-sender.mjs';
import { recifrar } from '../integrations/reencrypt.mjs';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { gerarRouteToken } = require('../../lib/platform/webhook-routing.js');
const { registrarAuditoria } = require('../../lib/platform/audit.js');
const { SEGREDOS, ENV_IMPORTACAO_INK, ENV_LEGADO_INK } = require('../../lib/platform/integrations.js');
const { createKeyring } = require('../../lib/secrets/keyring.js');

const hashDoToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ── plan ───────────────────────────────────────────────────────────────────────────────────────
export async function planejar({ url, cfg, env = process.env, uploads, appRole }) {
  const itens = await coletar({ url: urlSomenteLeitura(url), cfg, env, uploads, appRole, modo: 'preflight' });
  const linhas = [`PLANO cenário ${cfg.cenario} (declarado; alvo de rollout de PD-019 = cenário ${CENARIO_ALVO_ROLLOUT})`];
  linhas.push(cfg.rollout
    ? `  alvo de rollout: sim (rollout: true, cenário ${cfg.cenario})`
    : `  alvo de rollout: NÃO — ensaio (o rollout usa o cenário ${CENARIO_ALVO_ROLLOUT} com rollout: true e --rollout)`);
  for (const o of cfg.organizations) {
    const org = itens.find((i) => i.id === `tenancy.organization[${o.id}]`);
    const st = itens.find((i) => i.id === `tenancy.store[${o.id}]`);
    linhas.push(`  organization ${o.id} "${o.nome}": ${org && org.status === 'PEND' ? 'criar' : 'usar'}`);
    linhas.push(`    store ${o.store.id} "${o.store.nome}" loja legada ${o.store.lojaLegada || '—'}: ${st && st.status === 'PEND' ? 'criar' : 'usar'}`);
    linhas.push(`    entitlements${o.perfil ? ` (perfil ${o.perfil})` : ''}: ${o.entitlements.length ? o.entitlements.join(', ') : '(nenhuma)'}`);
  }
  for (const m of cfg.mapeamento.mapeamentos) linhas.push(`  mapeamento ${m.tipo}:${m.chave} → ${m.organizationId}`);
  for (const o of cfg.owners) linhas.push(`  owner ${o.email} (hash em ${o.passwordHashEnv}) → ${o.organizations.join(', ')}`);
  linhas.push(`  criativos: tenant/${cfg.creativeTenantLegado} → ${cfg.donoCriativos}`);
  linhas.push(`  whatsapp: ${cfg.whatsapp
    ? `WABA ${cfg.whatsapp.wabaId} + número ${cfg.whatsapp.phoneNumberId} → ${cfg.whatsapp.organizationId} (declarado)`
    : 'não declarado (whatsapp: null)'}`);
  linhas.push(`  ink webhook: ${cfg.inkWebhook ? `URL opaca para ${cfg.inkWebhook.organizations.join(', ')}` : 'não declarado'}`);
  const acoes = itens.filter((i) => i.status === 'PEND');
  linhas.push(`  ações necessárias: ${acoes.length ? '' : 'nenhuma'}`);
  for (const a of acoes) linhas.push(`    - ${a.id}: ${a.detalhe}`);
  linhas.push('  limpeza de colunas legadas: não (fica para depois do dogfooding)');
  linhas.push('  ações destrutivas: nenhuma');
  return { itens, linhas };
}

// ── apply ──────────────────────────────────────────────────────────────────────────────────────
// Exportada para o dry-run do runbook (emissão do D0, OPS-34), com a mesma regra da rota da tela.
export async function emitirUrlInk(url, org, dirSaida) {
  // Leitura e decisão dentro da mesma transação da escrita.
  const client = new pg.Client({ connectionString: url });
  client.on('error', () => {});
  await client.connect();
  let arquivo = null;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
    const integ = (await client.query(
      `SELECT i.id, i.config,
              EXISTS (SELECT 1 FROM integration_secrets s WHERE s.integration_id = i.id AND s.organization_id = i.organization_id AND s.tipo = 'webhook_secret') AS tem_segredo
         FROM integrations i WHERE i.organization_id = $1 AND i.provider = 'ink' AND i.escopo IS NULL FOR UPDATE OF i`, [org]
    )).rows;
    if (integ.length !== 1 || !integ[0].tem_segredo) throw new Tenant1Error(`ink ${org}: sem integração com segredo do webhook — cadastre antes de emitir a URL`);
    const config = integ[0].config || {};
    if (config.webhook_token_sha256) {
      const dono = (await client.query('SELECT ink_organization_do_webhook($1) AS org', [config.webhook_token_sha256])).rows;
      if (dono.length === 1 && dono[0].org === org) { await client.query('COMMIT'); return { mudou: false }; }
    }
    if (!dirSaida) throw new Tenant1Error(`ink ${org}: a URL precisa ser emitida — gere na tela (OPS-34) ou passe --saida-segredos <dir>`);
    const token = gerarRouteToken();
    const hash = hashDoToken(token);
    await client.query("SELECT integracao_liberar_recursos('ink', 'webhook_token', NULL)");
    const claim = (await client.query("SELECT integracao_reivindicar_recurso('ink', 'webhook_token', $1) AS ok", [hash])).rows;
    if (claim.length !== 1 || claim[0].ok !== true) throw new Tenant1Error(`ink ${org}: token de URL já pertence a outra Organization`);
    await client.query(
      `UPDATE integrations SET config = $1::jsonb, atualizado_em = now() WHERE id = $2 AND organization_id = $3`,
      [JSON.stringify({ ...config, webhook_token_sha256: hash, webhook_token_criado_em: new Date().toISOString() }), integ[0].id, org]
    );
    // A URL é credencial: vai só para um arquivo novo, 0600, nunca para o stdout. Escrito antes do
    // COMMIT para não existir URL válida que ninguém conhece.
    fs.mkdirSync(dirSaida, { recursive: true, mode: 0o700 });
    const destino = path.join(dirSaida, `ink-webhook-${org}.url`);
    fs.writeFileSync(destino, `/api/webhooks/ink/${token}\n`, { mode: 0o600, flag: 'wx' });
    arquivo = destino;
    await client.query('COMMIT');
    return { mudou: true, arquivo };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (arquivo) fs.rmSync(arquivo, { force: true });
    throw err;
  } finally {
    await client.end().catch(() => {});
  }
}

async function usuarioDoOwner(url, email) {
  const client = new pg.Client({ connectionString: urlSomenteLeitura(url) });
  client.on('error', () => {});
  await client.connect();
  try {
    const { rows } = await client.query(`SELECT id FROM users WHERE email = $1 AND status = 'active'`, [email]);
    // e-mail é UNIQUE: zero ou mais de uma linha é erro, nunca "a primeira".
    if (rows.length !== 1) throw new Tenant1Error(`owner ${email} não encontrado`);
    const [unico] = rows;
    return unico.id;
  } finally {
    await client.end().catch(() => {});
  }
}

// Sujeito do registro: o PRIMEIRO owner declarado para a Organization, na ordem do arquivo.
function ownerDeclarado(cfg, org) {
  return cfg.owners.find((o) => o.organizations.includes(org));
}

async function auditar(url, cfg, acao, depois) {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on('error', () => {});
  try {
    for (const o of cfg.organizations) {
      const actorUserId = await usuarioDoOwner(url, ownerDeclarado(cfg, o.id).email);
      await registrarAuditoria(pool, {
        actorUserId, action: acao, entityType: 'organization', entityId: o.id,
        loja: o.store.lojaLegada, organizationId: o.id, after: { cenario: cfg.cenario, ...depois },
      });
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function aplicar({ url, cfg, env = process.env, uploads, appRole, saidaSegredos = null }) {
  exigirBancoLocal(url, env);
  const preflight = await coletar({ url: urlSomenteLeitura(url), cfg, env, uploads, appRole, modo: 'preflight' });
  if (resultado(preflight) === 'FAIL') return { abortado: true, preflight, passos: [], verify: [] };

  const passos = [];
  const passo = (status, id, detalhe, mudou = false) => passos.push({ status, id, detalhe, mudou });
  try {
    await aplicarMapeamento(url, cfg.arquivoMapeamento, { creativeTenant: cfg.creativeTenantLegado });
    const mudouMapa = preflight.some((i) => i.status === 'PEND' && i.id.startsWith('tenancy.'));
    passo('PASS', 'apply.mapeamento', mudouMapa ? 'organizations/stores/regras gravadas' : 'já aplicado', mudouMapa);

    for (const o of cfg.owners) {
      const pendente = preflight.some((i) => i.id === `auth.owner[${o.email}]` && i.status === 'PEND');
      if (!pendente) { passo('PASS', `apply.owner[${o.email}]`, 'já era owner'); continue; }
      const r = await bootstrapOwner(url, {
        AUTH_BOOTSTRAP_OWNER_EMAIL: o.email,
        AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH: env[o.passwordHashEnv],
        AUTH_BOOTSTRAP_ORGANIZATION_IDS: o.organizations.join(','),
      });
      passo('PASS', `apply.owner[${o.email}]`, `owner ${r.userId} em ${r.organizations.length} Organization(s)`, true);
    }

    for (const o of cfg.organizations) {
      const pendente = preflight.some((i) => i.id === `entitlements[${o.id}]` && i.status === 'PEND');
      if (!pendente) { passo('PASS', `apply.entitlements[${o.id}]`, 'nada a ligar'); continue; }
      // Com perfil, o seed lê o MESMO arquivo que o pre-deploy usa (ENTITLEMENTS_SEED_PROFILE).
      await seedEntitlements(url, o.arquivoPerfil
        ? { ENTITLEMENTS_SEED_ORGANIZATION_IDS: o.id, ENTITLEMENTS_SEED_PROFILE: o.arquivoPerfil }
        : { ENTITLEMENTS_SEED_ORGANIZATION_IDS: o.id, ENTITLEMENTS_SEED_FEATURES: o.entitlements.join(',') });
      passo('PASS', `apply.entitlements[${o.id}]`, `ligadas${o.perfil ? ` (perfil ${o.perfil})` : ''}: ${o.entitlements.join(', ')}`, true);
    }

    const legado = await importarLegado(url, { env, aplicar: true, limparColunas: false });
    if (legado.ilegiveis) throw new Tenant1Error(`integrações: ${legado.ilegiveis} credencial(is) ilegível(is)`);
    passo('PASS', 'apply.integrations', `${legado.importados} importada(s), ${legado.jaImportados} já importada(s); colunas legadas mantidas`, legado.importados > 0);

    const rc = await recifrar(url, { env });
    if (rc.pendentes || rc.ilegiveis) throw new Tenant1Error(`re-cifra: ${rc.pendentes} pendente(s), ${rc.ilegiveis} ilegível(is)`);
    passo('PASS', 'apply.recifra', `${rc.recifrados} re-cifrado(s) para a versão ${rc.versao}`, rc.recifrados > 0);

    if (cfg.whatsapp) {
      const pendente = preflight.some((i) => i.id === `whatsapp.remetente[${cfg.whatsapp.organizationId}]` && i.status === 'PEND');
      if (pendente) {
        const { organizationId, wabaId, phoneNumberId } = cfg.whatsapp;
        const r = await importarRemetenteWhatsapp(url, { env, organizationId, esperado: { wabaId, phoneNumberId }, aplicar: true });
        passo('PASS', 'apply.whatsapp', `remetente legado → ${r.organizationId}: ${r.resultado}`, true);
      } else passo('PASS', 'apply.whatsapp', 'já importado');
    } else passo('PASS', 'apply.whatsapp', 'não declarado');

    const cri = moverCriativos({ uploads, de: cfg.creativeTenantLegado, para: cfg.donoCriativos }, { aplicar: true });
    passo('PASS', 'apply.criativos', cri.aplicado ? `tenant/${cfg.creativeTenantLegado} → tenant/${cfg.donoCriativos}` : 'nada a mover', cri.aplicado);

    for (const org of (cfg.inkWebhook ? cfg.inkWebhook.organizations : [])) {
      const r = await emitirUrlInk(url, org, saidaSegredos);
      passo('PASS', `apply.ink-webhook[${org}]`, r.mudou ? `URL emitida (gravada em ${r.arquivo}, 0600)` : 'URL já emitida', r.mudou);
    }

    const mudaram = passos.filter((p) => p.mudou).map((p) => p.id);
    if (mudaram.length) {
      await auditar(url, cfg, ACAO_TENANT1, { passos: mudaram });
      passo('PASS', 'apply.audit', `${cfg.organizations.length} registro(s) ${ACAO_TENANT1}`);
    } else passo('PASS', 'apply.audit', 'nada mudou — sem novo registro');
  } catch (err) {
    passo('FAIL', 'apply.abortado', err.message);
    return { abortado: true, preflight, passos, verify: [] };
  }

  const verify = await coletar({ url: urlSomenteLeitura(url), cfg, env, uploads, appRole, modo: 'verify' });
  return { abortado: false, preflight, passos, verify };
}

// ── rollback (Fase 6, local) ───────────────────────────────────────────────────────────────────
// O cutover do Tenant #1 não cria schema e não apaga nada; por isso o rollback é de CONFIGURAÇÃO e
// de CAMINHO DE LEITURA, nunca DROP, DELETE ou troca de dono:
//
//   alavanca                          efeito                                              pré-condição conferida
//   ALLOW_LEGACY_ADMIN_PASSWORD=1     login de emergência como o owner declarado          LEGACY_ADMIN_USER_EMAIL é owner ativo de todas
//   ALLOW_LEGACY_INTEGRATION_ENV=1    Ink volta a poder ler INK_TOKEN/FEED_URL_<LOJA>     variáveis presentes para a loja de cada Store
//   release anterior do painel        webhook legado da Ink (INK_WEBHOOK_SECRET_<LOJA>)   variáveis presentes
//   release anterior (credenciais)    lê as colunas antigas com ADMIN_SESSION_SECRET      colunas intactas e legíveis
//   Go (5b/5c)                        remetente pelo ambiente (META_*)                    WHATSAPP_LEGACY_* ainda existem
//
// Com --aplicar, a única escrita é o registro de auditoria `tenant1.rollback` por Organization; a
// impressão digital antes/depois prova que nenhuma linha saiu nem mudou de Organization.
export async function conferirRollback({ url, cfg, env = process.env }) {
  const itens = [];
  const add = (status, id, detalhe) => itens.push({ status, id, detalhe });
  const client = new pg.Client({ connectionString: urlSomenteLeitura(url) });
  client.on('error', () => {});
  await client.connect();
  try {
    const email = String(env.LEGACY_ADMIN_USER_EMAIL || '').trim().toLowerCase();
    if (!email || !env.ADMIN_PASSWORD) add('FAIL', 'rollback.login-emergencia', 'LEGACY_ADMIN_USER_EMAIL e ADMIN_PASSWORD precisam estar no ambiente');
    else {
      const { rows } = await client.query(
        `SELECT m.organization_id FROM users u JOIN organization_members m ON m.user_id = u.id
          WHERE u.email = $1 AND u.status = 'active' AND m.papel = 'owner'`, [email]
      );
      const tem = new Set(rows.map((r) => r.organization_id));
      const faltam = cfg.organizations.filter((o) => !tem.has(o.id)).map((o) => o.id);
      if (faltam.length) add('FAIL', 'rollback.login-emergencia', `${email} não é owner ativo de: ${faltam.join(', ')}`);
      else add('PASS', 'rollback.login-emergencia', `${email} é owner ativo de todas as Organizations declaradas`);
    }

    for (const o of cfg.organizations) {
      const loja = o.store.lojaLegada;
      if (!loja) { add('INFO', `rollback.ink[${o.id}]`, 'Store sem loja legada — sem caminho antigo da Ink'); continue; }
      const leitura = Object.values(ENV_LEGADO_INK).map((f) => f(loja)).filter((n) => !env[n]);
      if (leitura.length) add('FAIL', `rollback.ink-leitura[${o.id}]`, `ausentes: ${leitura.join(', ')}`);
      else add('PASS', `rollback.ink-leitura[${o.id}]`, `${Object.values(ENV_LEGADO_INK).map((f) => f(loja)).join(', ')} presentes`);
      const nomeWebhook = ENV_IMPORTACAO_INK.webhook_secret(loja);
      if (!env[nomeWebhook]) add('FAIL', `rollback.ink-webhook[${o.id}]`, `${nomeWebhook} ausente — a release anterior não verificaria o webhook`);
      else add('PASS', `rollback.ink-webhook[${o.id}]`, `${nomeWebhook} presente`);
    }

    // Colunas antigas: a release anterior lê daqui. Integração importada sem coluna antiga = sem volta.
    const legado = createKeyring({ ADMIN_SESSION_SECRET: env.ADMIN_SESSION_SECRET, ENCRYPTION_ALLOW_LEGACY_SESSION_KEY: '1' });
    const fontes = [
      { provider: 'meta', sql: 'SELECT organization_id, access_token_encrypted AS c FROM meta_connections', tipo: 'access_token' },
      { provider: 'google_ads', sql: 'SELECT organization_id, refresh_token_encrypted AS c FROM google_ads_connections', tipo: 'refresh_token' },
      { provider: 'ga4', sql: 'SELECT g.organization_id, g.refresh_token_encrypted AS c FROM google_analytics_connections g JOIN stores s ON s.organization_id = g.organization_id AND s.ativa AND s.loja_legada = g.loja', tipo: 'refresh_token' },
      { provider: 'openai', sql: 'SELECT organization_id, openai_key_enc AS c FROM creative_settings', tipo: 'api_key' },
    ];
    const semVolta = [];
    const ilegiveis = [];
    let conferidas = 0;
    for (const f of fontes) {
      const { rows: importadas } = await client.query(
        `SELECT DISTINCT s.organization_id FROM integration_secrets s JOIN integrations i ON i.id = s.integration_id AND i.organization_id = s.organization_id
          WHERE i.provider = $1 AND i.escopo IS NULL AND s.tipo = $2`, [f.provider, f.tipo]
      );
      const { rows: colunas } = await client.query(f.sql);
      for (const { organization_id: org } of importadas) {
        const c = colunas.find((x) => x.organization_id === org && x.c);
        if (!c) { semVolta.push(`${org}/${f.provider}`); continue; }
        conferidas += 1;
        if (legado.decrypt(c.c, { contexto: SEGREDOS[f.provider][f.tipo] }) === null) ilegiveis.push(`${org}/${f.provider}`);
      }
    }
    if (semVolta.length) add('FAIL', 'rollback.colunas-legadas', `colunas antigas já limpas: ${semVolta.join(', ')}`);
    else if (ilegiveis.length) add('FAIL', 'rollback.colunas-legadas', `ilegíveis com ADMIN_SESSION_SECRET: ${ilegiveis.join(', ')}`);
    else add('PASS', 'rollback.colunas-legadas', `${conferidas} credencial(is) ainda legível(is) pela release anterior`);

    if (cfg.whatsapp) {
      const faltam = ['WHATSAPP_LEGACY_PHONE_NUMBER_ID', 'WHATSAPP_LEGACY_WABA_ID', 'WHATSAPP_LEGACY_ACCESS_TOKEN'].filter((n) => !env[n]);
      if (faltam.length) add('FAIL', 'rollback.whatsapp', `ausentes (o Go voltaria sem remetente): ${faltam.join(', ')}`);
      else add('PASS', 'rollback.whatsapp', 'remetente legado ainda no ambiente (Release D não executada)');
    }
    add('PASS', 'rollback.schema', 'o Tenant #1 não adiciona migration — nenhum migrate:down faz parte do rollback');
  } finally {
    await client.end().catch(() => {});
  }
  return itens;
}

export const ALAVANCAS_ROLLBACK = Object.freeze([
  'ALLOW_LEGACY_ADMIN_PASSWORD=1 (com ADMIN_PASSWORD e LEGACY_ADMIN_USER_EMAIL=<owner declarado>)',
  'ALLOW_LEGACY_INTEGRATION_ENV=1 (Ink lê INK_TOKEN_<LOJA>/INK_FEED_URL_<LOJA> se o segredo da integração faltar)',
  'se preciso voltar a release: ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1 mantida e INK_WEBHOOK_SECRET_<LOJA> no ambiente',
  'Reserva Ink: URL antiga só junto com a release anterior; Go: rollback antes do painel (whatsapp-inbound-5c.md §7)',
]);

export async function reverter({ url, cfg, env = process.env, aplicar = false }) {
  exigirBancoLocal(url, env);
  const itens = await conferirRollback({ url, cfg, env });
  const antes = await impressaoDigital(urlSomenteLeitura(url));
  if (!aplicar || resultado(itens) === 'FAIL') return { itens, antes, depois: null, diferencas: [], aplicado: false };
  await auditar(url, cfg, ACAO_ROLLBACK, { alavancas: ['ALLOW_LEGACY_ADMIN_PASSWORD', 'ALLOW_LEGACY_INTEGRATION_ENV'] });
  const depois = await impressaoDigital(urlSomenteLeitura(url));
  const diferencas = compararImpressoes(antes, depois);
  itens.push(diferencas.length
    ? { status: 'FAIL', id: 'rollback.dados', detalhe: diferencas.join('; ') }
    : { status: 'PASS', id: 'rollback.dados', detalhe: `nenhuma linha removida nem reassociada (impressão ${depois.resumo.slice(0, 12)})` });
  return { itens, antes, depois, diferencas, aplicado: true };
}
