#!/usr/bin/env node
// Fase 5b · importa o remetente WhatsApp que hoje mora no ambiente do whatsapp-webhook-go para a
// integração `whatsapp` de UMA Organization (OPS-29).
//
//   META_PHONE_NUMBER_ID (Go) → WHATSAPP_LEGACY_PHONE_NUMBER_ID → integrations.config.phone_number_id
//   META_WABA_ID         (Go) → WHATSAPP_LEGACY_WABA_ID         → integrations.config.waba_id
//   META_ACCESS_TOKEN    (Go) → WHATSAPP_LEGACY_ACCESS_TOKEN    → integration_secrets (access_token)
//   REPLY_REDIRECT_MESSAGE / REPLY_REDIRECT_NUMBER (Go)
//                             → WHATSAPP_LEGACY_REPLY_REDIRECT_MESSAGE / _NUMBER → config.reply_redirect_message
//   REPLY_NOTIFY_NUMBER  (Go) → WHATSAPP_LEGACY_NOTIFY_NUMBER    → config.notify_number
//
// (Fase 5c: resposta automática e aviso ao atendimento deixaram de ser variáveis do serviço.)
//
// O número do ambiente do Go não diz de quem é: a instalação tem um só, e escolher "a Organization
// que existir" é exatamente o que a Fase 5b remove. Por isso a Organization é argumento obrigatório,
// escolhido pelo operador — e o número é reivindicado para ela (PD-016): se outra Organization já o
// tem, o import falha.
//
// Segredo nenhum aparece em argumento, log ou saída: os valores vêm só do ambiente, e o relatório
// traz o resultado e o last4. Idempotente.
//
// Uso (role de migration, no pre-deploy — nunca o processo da app):
//   DATABASE_URL=... ENCRYPTION_MASTER_KEY=... WHATSAPP_LEGACY_PHONE_NUMBER_ID=... \
//   WHATSAPP_LEGACY_WABA_ID=... WHATSAPP_LEGACY_ACCESS_TOKEN=... \
//     node scripts/integrations/import-whatsapp-sender.mjs --organization <uuid>            (simula)
//   ... node scripts/integrations/import-whatsapp-sender.mjs --organization <uuid> --aplicar
//   (HEAD) [--waba-id <id> --phone-number-id <id>]  confere o ambiente contra o par declarado
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { createKeyring } = require('../../lib/secrets/keyring.js');
const { createSecretStore } = require('../../lib/secrets/store.js');
const { SEGREDOS } = require('../../lib/platform/integrations.js');
const { validarConfiguracao, validarComportamento } = require('../../lib/platform/whatsapp-sender.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTEXTO = SEGREDOS.whatsapp.access_token;

// `esperado` (opcional, usado pelo tenant1): o par {wabaId, phoneNumberId} DECLARADO no arquivo de
// rollout. Se vier, o ambiente precisa ser exatamente esse par — o número não é aceito só por ser o
// que está no ambiente.
export async function importarRemetenteWhatsapp(url, { env = process.env, organizationId, esperado = null, aplicar = false } = {}) {
  if (!organizationId || !UUID_RE.test(organizationId)) throw new Error('informe --organization <uuid> (a Organization dona do número)');
  const org = organizationId.toLowerCase();
  const phoneNumberId = String(env.WHATSAPP_LEGACY_PHONE_NUMBER_ID || '').trim();
  const wabaId = String(env.WHATSAPP_LEGACY_WABA_ID || '').trim();
  const accessToken = String(env.WHATSAPP_LEGACY_ACCESS_TOKEN || '').trim();
  const invalido = validarConfiguracao({ phoneNumberId, wabaId, accessToken });
  if (invalido) throw new Error(`WHATSAPP_LEGACY_*: ${invalido}`);
  if (esperado && (esperado.phoneNumberId !== phoneNumberId || esperado.wabaId !== wabaId)) {
    throw new Error('WHATSAPP_LEGACY_PHONE_NUMBER_ID/WABA_ID não são o par declarado — confira o arquivo de rollout');
  }
  // Mesmo texto padrão que o serviço Go montava a partir do número de atendimento.
  const numeroAtendimento = String(env.WHATSAPP_LEGACY_REPLY_REDIRECT_NUMBER || '').replace(/\D/g, '');
  const replyRedirectMessage = String(env.WHATSAPP_LEGACY_REPLY_REDIRECT_MESSAGE || '').trim()
    || (numeroAtendimento
      ? 'Olá! 👋 Esse canal é automático e não é monitorado.\n\n'
        + `Para falar com a gente, chame no nosso WhatsApp de atendimento: https://wa.me/${numeroAtendimento}`
      : '');
  const notifyNumber = String(env.WHATSAPP_LEGACY_NOTIFY_NUMBER || '').replace(/\D/g, '');
  const comportamentoInvalido = validarComportamento({ replyRedirectMessage, notifyNumber });
  if (comportamentoInvalido) throw new Error(`WHATSAPP_LEGACY_*: ${comportamentoInvalido}`);
  const configNova = { phone_number_id: phoneNumberId, waba_id: wabaId, reply_redirect_message: replyRedirectMessage, notify_number: notifyNumber };

  const keyring = createKeyring(env);
  if (aplicar && !keyring.disponivel()) throw new Error('ENCRYPTION_MASTER_KEY ausente — não há como gravar o token');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const store = createSecretStore({ pool: { query: (...a) => client.query(...a) }, keyring });
  const relatorio = { aplicado: aplicar, organizationId: org, phoneNumberId, wabaId, last4: accessToken.slice(-4), resultado: null };
  try {
    const { rows: ativas } = await client.query(
      'SELECT organization_id FROM tenancy_organizations_para_jobs() WHERE organization_id = $1', [org]
    );
    if (!ativas.length) throw new Error(`organization ${org} não existe ou não está ativa`);

    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.current_organization_id', $1, true)", [org]);
      const { rows: [dono] } = await client.query(
        `SELECT organization_id FROM external_resource_claims WHERE provider = 'whatsapp' AND tipo = 'phone_number' AND external_id = $1`,
        [phoneNumberId]
      );
      if (dono && dono.organization_id !== org) throw new Error('este número já pertence a outra organization');
      const { rows: [donoWaba] } = await client.query(
        `SELECT organization_id FROM external_resource_claims WHERE provider = 'whatsapp' AND tipo = 'waba' AND external_id = $1`,
        [wabaId]
      );
      if (donoWaba && donoWaba.organization_id !== org) throw new Error('esta WABA já pertence a outra organization');

      const { rows: [integ] } = await client.query(
        `SELECT id, config FROM integrations WHERE organization_id = $1 AND provider = 'whatsapp' AND escopo IS NULL`, [org]
      );
      const configIgual = integ && integ.config && Object.entries(configNova).every(([k, v]) => (integ.config[k] || '') === v);
      const tokenIgual = integ && await store.usarSegredo(
        { integrationId: integ.id, organizationId: org, tipo: 'access_token', contexto: CONTEXTO, aceitarVencido: true },
        (atual) => atual === accessToken
      ).catch(() => false);
      if (configIgual && tokenIgual && dono && donoWaba) {
        relatorio.resultado = 'ja_importado';
      } else if (integ && integ.config && integ.config.phone_number_id && integ.config.phone_number_id !== phoneNumberId) {
        // Não sobrescreve um número que o owner já cadastrou na tela.
        throw new Error('a organization já tem outro número cadastrado — confira antes de importar');
      } else if (!aplicar) {
        relatorio.resultado = 'a_importar';
      } else {
        const { rows: [claim] } = await client.query(
          "SELECT integracao_reivindicar_recurso('whatsapp', 'phone_number', $1) AS ok", [phoneNumberId]
        );
        if (!claim.ok) throw new Error('este número já pertence a outra organization');
        const { rows: [claimWaba] } = await client.query(
          "SELECT integracao_reivindicar_recurso('whatsapp', 'waba', $1) AS ok", [wabaId]
        );
        if (!claimWaba.ok) throw new Error('esta WABA já pertence a outra organization');
        await client.query(
          `INSERT INTO integrations (organization_id, provider, escopo, status) VALUES ($1, 'whatsapp', NULL, 'disconnected')
           ON CONFLICT DO NOTHING`,
          [org]
        );
        const { rows: [nova] } = await client.query(
          `SELECT id FROM integrations WHERE organization_id = $1 AND provider = 'whatsapp' AND escopo IS NULL`, [org]
        );
        await client.query(
          `UPDATE integrations SET config = $1::jsonb, atualizado_em = now() WHERE id = $2 AND organization_id = $3`,
          [JSON.stringify(configNova), nova.id, org]
        );
        if (!tokenIgual) {
          await store.gravar({ integrationId: nova.id, organizationId: org, tipo: 'access_token', valor: accessToken, expiresAt: null, contexto: CONTEXTO });
        }
        const ok = await store.usarSegredo(
          { integrationId: nova.id, organizationId: org, tipo: 'access_token', contexto: CONTEXTO },
          (lido) => lido === accessToken
        );
        if (!ok) throw new Error('verificação do token gravado falhou');
        await client.query(`UPDATE integrations SET status = 'connected', atualizado_em = now() WHERE id = $1 AND organization_id = $2`, [nova.id, org]);
        relatorio.resultado = 'importado';
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
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
  const valor = (nome) => { const i = args.indexOf(nome); return i >= 0 ? args[i + 1] : null; };
  // Rodada 19: --waba-id e --phone-number-id (juntos) = o par declarado no arquivo de rollout; o
  // ambiente precisa ser exatamente ele. Um sem o outro é erro.
  const wabaId = valor('--waba-id');
  const phoneNumberId = valor('--phone-number-id');
  if (Boolean(wabaId) !== Boolean(phoneNumberId)) {
    console.error('whatsapp: informe --waba-id e --phone-number-id juntos');
    process.exit(2);
  }
  importarRemetenteWhatsapp(process.env.DATABASE_URL, {
    organizationId: valor('--organization'),
    esperado: wabaId ? { wabaId, phoneNumberId } : null,
    aplicar: args.includes('--aplicar'),
  })
    .then((r) => {
      console.log(`whatsapp: organization ${r.organizationId} ← número ${r.phoneNumberId}, WABA ${r.wabaId}, token final ${r.last4}: ${r.resultado}${r.aplicado ? '' : ' — SIMULAÇÃO (use --aplicar)'}`);
    })
    .catch((err) => { console.error(`whatsapp: ${err.message}`); process.exit(1); });
}
