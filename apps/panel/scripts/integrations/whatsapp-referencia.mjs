#!/usr/bin/env node
// Fase 5c · referência de serviço de uma Organization para scripts internos que chamam rotas de
// tenant do whatsapp-webhook-go (ex.: /problems/add e /problems/sync do extrator de entregas, OPS-33).
//
// Imprime o número e a referência assinada (X-Sender-Phone-Number-Id / X-Sender-Ref). A referência
// não é credencial sozinha — o serviço ainda exige a API_KEY dele —, mas é configuração sensível:
// guarde junto dos outros segredos do script. Trocar o número da integração ou rotacionar
// WHATSAPP_SENDER_REF_SECRET a invalida.
//
// Uso (role de migration):
//   DATABASE_URL=... WHATSAPP_SENDER_REF_SECRET=... node scripts/integrations/whatsapp-referencia.mjs --organization <uuid>
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { createWhatsappSender } = require('../../lib/platform/whatsapp-sender.js');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function referenciaDeServico(url, { env = process.env, organizationId } = {}) {
  if (!organizationId || !UUID_RE.test(organizationId)) throw new Error('informe --organization <uuid>');
  const org = organizationId.toLowerCase();
  const assinador = createWhatsappSender({ integracoes: {}, segredoRef: env.WHATSAPP_SENDER_REF_SECRET });
  if (!assinador.disponivel()) throw new Error('WHATSAPP_SENDER_REF_SECRET ausente ou curto');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, config ->> 'phone_number_id' AS phone, status FROM integrations
        WHERE organization_id = $1 AND provider = 'whatsapp' AND escopo IS NULL`, [org]
    );
    if (rows.length !== 1 || rows[0].status !== 'connected' || !rows[0].phone) {
      throw new Error('a organization não tem número de WhatsApp conectado');
    }
    return {
      phoneNumberId: rows[0].phone,
      ref: assinador.assinarRef({ organizationId: org, integrationId: rows[0].id, phoneNumberId: rows[0].phone }),
    };
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--organization');
  referenciaDeServico(process.env.DATABASE_URL, { organizationId: i >= 0 ? args[i + 1] : null })
    .then((r) => {
      console.log(`X-Sender-Phone-Number-Id: ${r.phoneNumberId}`);
      console.log(`X-Sender-Ref: ${r.ref}`);
    })
    .catch((err) => { console.error(`whatsapp: ${err.message}`); process.exit(1); });
}
