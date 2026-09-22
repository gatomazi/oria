'use strict';

// Fase B.1 · adaptador da porta IntegrationResolver (lib/connectors) sobre a infraestrutura de
// `integrations` que já existe. Sem migration, sem `store_id` em `integrations`.
//
// Premissa do produto (ORIA-TENANCY-STORE-01, PD-002): 1 Organization = 1 Store. A INTEGRAÇÃO é da
// Organization — `integrations` é `(organization_id, provider, escopo)` e seus segredos também. A
// Store é só o contexto operacional do connector (produtos, pedidos, catálogo, analytics).
//
// O que a porta faz, sempre dentro do contexto de Organization do processo:
//
//   1. a Organization da consulta é a do contexto do processo (nunca a que o chamador quiser);
//   2. se a consulta traz Store, ela pertence a essa Organization (`stores.organization_id`);
//   3. a integração é achada por Organization + provider (+ id, se o contexto trouxe um) e `escopo` legado
//      NULO — nunca só por `integrationId`, nunca só por provider;
//   4. sem linha ou `disconnected` → INTEGRATION_NOT_CONNECTED (o mesmo código do resolver legado);
//   5. devolve id, Organization, Store validada, provider, status e config NÃO sensível.
//
// O que a porta NÃO faz:
//   · não lê `integration_secrets` — o segredo não sai daqui, nem por engano; quem precisa dele usa
//     `usarSegredo` do resolver de integrações, dentro do adapter do provider;
//   · não interpreta status além de `disconnected` (pending, degraded, error… voltam como vieram: a
//     política operacional é do connector/service, não uma health policy global);
//   · não usa o fallback por variável de ambiente do resolver legado.
//
// `ResolvedIntegration.storeId` é o "validated execution Store context" (a Store validada como da
// Organization), NÃO uma coluna de `integrations`.

const { contextoAtual } = require('./tenant-runtime');
const { SEGREDOS, IntegracaoError } = require('./integrations');
const { ConnectorError, CODIGOS } = require('../connectors/errors');
const { createConnectorContext } = require('../connectors/contracts');

// `integrations.id` hoje é BIGSERIAL. O contrato de connectors trata o id como opaco; quem conhece o
// tipo da coluna é este adaptador — um id que não cabe nela não existe, e não vira erro de cast do banco.
const ID_DA_COLUNA = /^[0-9]{1,18}$/;

// `integrations.config` é "só configuração NÃO sensível", mas o Ink guarda ali o hash do token da URL do
// webhook. A porta é a última barreira antes do connector: chave com cara de credencial não passa.
const CHAVE_SENSIVEL = /(token|secret|passw|api[_-]?key|private[_-]?key|credential|refresh|signature|sha256|hash)/i;
const PROFUNDIDADE_MAXIMA = 4;

function semChavesSensiveis(valor, profundidade = 0) {
  if (profundidade > PROFUNDIDADE_MAXIMA) return null;
  if (Array.isArray(valor)) return valor.map((v) => semChavesSensiveis(v, profundidade + 1));
  if (valor !== null && typeof valor === 'object') {
    return Object.fromEntries(
      Object.entries(valor)
        .filter(([chave]) => !CHAVE_SENSIVEL.test(chave))
        .map(([chave, v]) => [chave, semChavesSensiveis(v, profundidade + 1)])
    );
  }
  return valor;
}

const naoConectada = (provider) => new IntegracaoError(`${provider} não está conectado nesta organization`, {
  codigo: CODIGOS.INTEGRATION_NOT_CONNECTED, status: 409,
});
const outroTenant = (mensagem) => new ConnectorError(mensagem, CODIGOS.INTEGRATION_TENANT_MISMATCH);

/**
 * @param {{pool: {query: Function}, contexto?: () => (Object|null)}} opcoes
 *   `pool`: a fachada do tenant-runtime (toda query roda em `comOrganization`, sob RLS).
 *   `contexto`: quem diz a Organization do processo; por padrão o AsyncLocalStorage do tenant-runtime.
 * @returns {import('../connectors/types').IntegrationResolver}
 */
function createConnectorIntegrationPort({ pool, contexto = contextoAtual }) {
  if (!pool || typeof pool.query !== 'function') throw new Error('createConnectorIntegrationPort exige pool');

  async function resolve(consulta) {
    if (consulta === null || typeof consulta !== 'object') throw new ConnectorError('consulta inválida', CODIGOS.INTEGRATION_INVALID);
    const { integrationProvider, requiresStoreContext } = consulta;
    if (typeof integrationProvider !== 'string' || !Object.hasOwn(SEGREDOS, integrationProvider)) {
      throw new ConnectorError('integrationProvider desconhecido', CODIGOS.INTEGRATION_INVALID);
    }
    if (typeof requiresStoreContext !== 'boolean') throw new ConnectorError('requiresStoreContext deve ser boolean', CODIGOS.INTEGRATION_INVALID);
    const context = createConnectorContext(consulta.context);

    // 1 · Organization: a do processo. Divergência é erro, não "zero linhas".
    const ambiente = contexto();
    if (!ambiente) {
      throw new IntegracaoError('integração fora de um contexto de Organization', { codigo: 'TENANT_CONTEXT_REQUIRED', status: 500 });
    }
    if (String(ambiente.organizationId).toLowerCase() !== context.organizationId) {
      throw outroTenant('a Organization da consulta não é a do contexto do processo');
    }

    // 2 · Store → Organization. Sempre que vier Store ela é conferida, exigida ou não.
    if (context.storeId === null) {
      if (requiresStoreContext) throw new ConnectorError('este connector exige Store no contexto', CODIGOS.CONTEXT_INVALID);
    } else {
      const { rows: lojas } = await pool.query(
        'SELECT id FROM stores WHERE id = $1 AND organization_id = $2',
        [context.storeId, context.organizationId]
      );
      if (lojas.length === 0) throw outroTenant('a Store não pertence à Organization');
    }

    // 3 · Integração: Organization + provider (+ id). Nunca só um deles.
    const porId = context.integrationId !== null;
    if (porId && !ID_DA_COLUNA.test(context.integrationId)) throw naoConectada(integrationProvider);
    const filtroId = porId ? ' AND id = $3' : '';
    const { rows } = await pool.query(
      `SELECT id, provider, status, config FROM integrations
        WHERE organization_id = $1 AND provider = $2 AND escopo IS NULL${filtroId}`,
      porId ? [context.organizationId, integrationProvider, context.integrationId] : [context.organizationId, integrationProvider]
    );
    if (rows.length > 1) {
      throw new IntegracaoError('erro de integridade da integração', { codigo: 'INTEGRATION_INTEGRITY_ERROR', status: 500 });
    }

    // 4 · Existência e conexão. `garantir` deixa uma linha `disconnected` como placeholder: não é uma
    // integração conectada.
    const linha = rows[0];
    if (!linha || linha.status === 'disconnected') throw naoConectada(integrationProvider);

    // 5 · Só identidade, Store validada, status e config sem chave sensível.
    return {
      integrationId: String(linha.id),
      organizationId: context.organizationId,
      storeId: context.storeId,
      integrationProvider: linha.provider,
      status: linha.status,
      config: semChavesSensiveis(linha.config || {}),
    };
  }

  return { resolve };
}

module.exports = { createConnectorIntegrationPort, semChavesSensiveis };
