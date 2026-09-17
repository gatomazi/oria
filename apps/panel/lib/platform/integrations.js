'use strict';

// Fase 4 · integrações por Organization (INV-12).
//
// Toda credencial do cliente é resolvida assim:
//
//   Organization do contexto → integração (organization_id, provider) → segredo (tipo) → provider
//
// e nunca por env global, `LIMIT 1`, `rows[0]`, "a única conexão", loja do navegador ou flag
// "selecionada" da instalação. Uma integração por (Organization, provider) — o índice
// idx_integrations_org_provider_escopo garante isso no banco; aqui, mais de uma é erro de
// integridade, nunca "a primeira".
//
// Credencial de PLATAFORMA (app id/secret do OAuth, token de serviço, chave mestra) não passa por
// aqui: não pertence a uma Organization.

const { contextoAtual } = require('./tenant-runtime');
const { LOJAS_LEGADAS } = require('./tenancy-manifest');
const { CONTEXTO_GA4, CONTEXTO_META, CONTEXTO_GOOGLE_ADS } = require('../secrets/keyring');
const secretGuard = require('./secret-guard');

// Contexto HKDF de cada segredo. Os de GA4/Meta/Google Ads/OpenAI são os de antes da Fase 4 — o
// import das colunas antigas decifra com eles.
const SEGREDOS = Object.freeze({
  meta: Object.freeze({ access_token: CONTEXTO_META }),
  google_ads: Object.freeze({ refresh_token: CONTEXTO_GOOGLE_ADS, access_token: CONTEXTO_GOOGLE_ADS }),
  ga4: Object.freeze({ refresh_token: CONTEXTO_GA4, access_token: CONTEXTO_GA4 }),
  openai: Object.freeze({ api_key: 'openai-api-key-creative-v1' }),
  // Fase 5b: o token do número de WhatsApp da Organization. Número e WABA ficam em
  // integrations.config (não são segredo); o par é resolvido junto em whatsapp-sender.js.
  whatsapp: Object.freeze({ access_token: 'whatsapp-access-token-v1' }),
  ink: Object.freeze({
    api_token: 'ink-api-token-v1',
    webhook_secret: 'ink-webhook-secret-v1',
    feed_url: 'ink-feed-url-v1',
  }),
});

// Fallback legacy (uma release, OPS-24): variável de ambiente por LOJA LEGADA da Store. A loja vem
// da Store da Organization do contexto (dado explícito do mapeamento de tenancy), nunca do request.
// O segredo do webhook NÃO tem fallback (Fase 5c, TD-005): a entrada só confere o segredo guardado
// na integração.
const ENV_LEGADO_INK = Object.freeze({
  api_token: (loja) => `INK_TOKEN_${loja.toUpperCase()}`,
  feed_url: (loja) => `INK_FEED_URL_${loja.toUpperCase()}`,
});

// O import (OPS-23) ainda lê do ambiente os três valores, inclusive o segredo do webhook.
const ENV_IMPORTACAO_INK = Object.freeze({
  ...ENV_LEGADO_INK,
  webhook_secret: (loja) => `INK_WEBHOOK_SECRET_${loja.toUpperCase()}`,
});

class IntegracaoError extends Error {
  constructor(message, { codigo, status }) {
    super(message);
    this.name = 'IntegracaoError';
    this.codigo = codigo;
    this.status = status;
  }
}

const naoConectada = (provider) => new IntegracaoError(`${provider} não está conectado nesta organization`, { codigo: 'INTEGRATION_NOT_CONNECTED', status: 409 });

function contextoDe(provider, tipo) {
  const porTipo = SEGREDOS[provider];
  if (!porTipo || !porTipo[tipo]) throw new Error(`segredo desconhecido: ${provider}/${tipo}`);
  return porTipo[tipo];
}

function exigirContexto() {
  const ctx = contextoAtual();
  if (!ctx) {
    throw new IntegracaoError('integração fora de um contexto de Organization', { codigo: 'TENANT_CONTEXT_REQUIRED', status: 500 });
  }
  return ctx;
}

function legadoAtivo(env) {
  return String(env.ALLOW_LEGACY_INTEGRATION_ENV || '').trim() === '1';
}

// pool: a fachada do tenant-runtime (toda query dentro de comOrganization).
// segredos: createSecretStore({ pool: fachada, keyring }).
function createIntegrationResolver({ pool, segredos, env = process.env, logger = console }) {
  if (!pool || !segredos) throw new Error('createIntegrationResolver exige pool e store de segredos');
  const avisados = new Set();

  async function buscar(provider) {
    const ctx = exigirContexto();
    if (!SEGREDOS[provider]) throw new Error(`provider desconhecido: ${provider}`);
    const { rows } = await pool.query(
      `SELECT id, status, config FROM integrations
        WHERE organization_id = $1 AND provider = $2 AND escopo IS NULL`,
      [ctx.organizationId, provider]
    );
    if (rows.length > 1) {
      logger.error(`[INTEGRACOES] integridade: ${rows.length} integrações ${provider} na organization ${ctx.organizationId}`);
      throw new IntegracaoError('erro de integridade da integração', { codigo: 'INTEGRATION_INTEGRITY_ERROR', status: 500 });
    }
    return { ctx, integracao: rows[0] || null };
  }

  async function garantir(provider) {
    const { ctx, integracao } = await buscar(provider);
    if (integracao) return { ctx, integracao };
    await pool.query(
      `INSERT INTO integrations (organization_id, provider, escopo, status)
       VALUES ($1, $2, NULL, 'disconnected')
       ON CONFLICT DO NOTHING`,
      [ctx.organizationId, provider]
    );
    const again = await buscar(provider);
    if (!again.integracao) throw naoConectada(provider);
    return again;
  }

  // Valor do fallback legacy para a Store do contexto, ou null. Só Ink, só com a flag, só com loja
  // legada explícita.
  function valorLegado(ctx, provider, tipo) {
    if (provider !== 'ink' || !legadoAtivo(env)) return null;
    const loja = ctx.loja;
    if (!loja || !LOJAS_LEGADAS.includes(loja) || !ENV_LEGADO_INK[tipo]) return null;
    const nome = ENV_LEGADO_INK[tipo](loja);
    const valor = env[nome];
    if (!valor) return null;
    if (!avisados.has(nome)) {
      avisados.add(nome);
      logger.warn(`[INTEGRACOES] ${provider}/${tipo} da organization ${ctx.organizationId} veio de ${nome} (fallback legacy — importe e desligue)`);
    }
    return valor;
  }

  // Entrega o plaintext a `usar` e devolve o resultado. Nunca retorna o segredo por conta própria.
  // `meta` traz também a integração de onde o segredo saiu (id + config), para quem precisa do par
  // segredo/config da MESMA linha (o remetente do WhatsApp).
  async function usarSegredo(provider, tipo, usarOriginal, { aceitarVencido = false } = {}) {
    const contexto = contextoDe(provider, tipo);
    // Todo plaintext entregue fica registrado na rede de segurança de INV-13 (secret-guard).
    const usar = (valor, meta) => {
      secretGuard.registrar(valor);
      return usarOriginal(valor, meta);
    };
    const { ctx, integracao } = await buscar(provider);
    if (integracao) {
      try {
        return await segredos.usarSegredo(
          { integrationId: integracao.id, organizationId: ctx.organizationId, tipo, contexto, aceitarVencido },
          (valor, meta) => usar(valor, { ...meta, integracaoId: integracao.id, config: integracao.config || {} })
        );
      } catch (err) {
        if (err.codigo !== 'SECRET_MISSING') throw err;
      }
    }
    const legado = valorLegado(ctx, provider, tipo);
    if (legado !== null) return usar(legado, { expiresAt: null, legado: true });
    throw naoConectada(provider);
  }

  async function temSegredo(provider, tipo) {
    contextoDe(provider, tipo);
    const { ctx, integracao } = await buscar(provider);
    if (integracao) {
      const { rows } = await pool.query(
        'SELECT 1 FROM integration_secrets WHERE integration_id = $1 AND organization_id = $2 AND tipo = $3',
        [integracao.id, ctx.organizationId, tipo]
      );
      if (rows.length) return true;
    }
    return valorLegado(ctx, provider, tipo) !== null;
  }

  async function gravarSegredo(provider, tipo, valor, { expiresAt = null } = {}) {
    const contexto = contextoDe(provider, tipo);
    if (typeof valor !== 'string' || !valor) throw new Error(`segredo vazio: ${provider}/${tipo}`);
    secretGuard.registrar(valor);
    const { ctx, integracao } = await garantir(provider);
    const meta = await segredos.gravar({
      integrationId: integracao.id, organizationId: ctx.organizationId, tipo, valor, expiresAt, contexto,
    });
    await pool.query(
      `UPDATE integrations SET status = 'connected', atualizado_em = now()
        WHERE id = $1 AND organization_id = $2`,
      [integracao.id, ctx.organizationId]
    );
    return meta;
  }

  // Configuração NÃO sensível da integração (ex.: número e WABA do WhatsApp). Substitui o objeto
  // inteiro; segredo nunca passa por aqui.
  async function gravarConfig(provider, config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`config inválida: ${provider}`);
    const { ctx, integracao } = await garantir(provider);
    await pool.query(
      `UPDATE integrations SET config = $1::jsonb, atualizado_em = now()
        WHERE id = $2 AND organization_id = $3`,
      [JSON.stringify(config), integracao.id, ctx.organizationId]
    );
  }

  // Desconexão local: apaga os segredos, marca desconectado e libera os recursos externos DESTA
  // Organization. Revogar no provider é do chamador (depende do provider).
  async function desconectar(provider, { tipo = null } = {}) {
    const { ctx, integracao } = await buscar(provider);
    let apagados = 0;
    if (integracao) {
      apagados = await segredos.apagar({ integrationId: integracao.id, organizationId: ctx.organizationId, tipo });
      if (!tipo) {
        await pool.query(
          `UPDATE integrations SET status = 'disconnected', atualizado_em = now()
            WHERE id = $1 AND organization_id = $2`,
          [integracao.id, ctx.organizationId]
        );
      }
    }
    if (!tipo) await liberarRecursos(provider);
    return { apagados };
  }

  // O que pode ir para a tela: conectado + metadata (last4, validade, versão). Nunca o segredo.
  async function metadata(provider) {
    const { ctx, integracao } = await buscar(provider);
    const segredosMeta = integracao ? await segredos.listarMetadata(integracao.id) : [];
    const legado = Object.keys(SEGREDOS[provider]).filter((t) => !segredosMeta.some((m) => m.tipo === t) && valorLegado(ctx, provider, t) !== null);
    return {
      provider,
      status: integracao ? integracao.status : 'disconnected',
      config: (integracao && integracao.config) || {},
      segredos: segredosMeta,
      viaEnvLegado: legado,
    };
  }

  // PD-016: recurso externo tem UMA Organization dona. Reivindicar o que é de outra é conflito
  // explícito — nunca transferência silenciosa.
  async function reivindicarRecurso(provider, tipo, externalId) {
    exigirContexto();
    const { rows } = await pool.query('SELECT integracao_reivindicar_recurso($1, $2, $3) AS ok', [provider, tipo, String(externalId)]);
    if (!rows[0] || rows[0].ok !== true) {
      throw new IntegracaoError('este recurso já está conectado a outra organization — desconecte-o lá antes', {
        codigo: 'EXTERNAL_RESOURCE_OWNED_ELSEWHERE', status: 409,
      });
    }
    return true;
  }

  async function liberarRecursos(provider, tipo = null, externalId = null) {
    exigirContexto();
    const { rows } = await pool.query('SELECT integracao_liberar_recursos($1, $2, $3) AS n', [provider, tipo, externalId]);
    return rows[0] ? rows[0].n : 0;
  }

  return {
    usarSegredo, temSegredo, gravarSegredo, gravarConfig, desconectar, metadata,
    reivindicarRecurso, liberarRecursos,
    legadoAtivo: () => legadoAtivo(env),
  };
}

module.exports = { SEGREDOS, ENV_LEGADO_INK, ENV_IMPORTACAO_INK, IntegracaoError, createIntegrationResolver };
