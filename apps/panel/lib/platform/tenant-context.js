'use strict';

// INV-01, INV-02, INV-10 — o tenant do contexto deriva EXCLUSIVAMENTE da sessão.
//
// Regra do plano, sem exceção:
//
//     Session → Organization (eixo de isolamento) → Store (1:1 na V1)
//
// O frontend não escolhe tenant. Nunca. Endpoints não recebem `organization_id` nem `store_id`
// para decidir ownership quando isso pode ser derivado da sessão.
//
// A Fase 0 não liga este pipeline às rotas — `organizations` só existe na Fase 1. O que existe
// aqui é o contrato e o teste que o prova, para que a Fase 2 tenha onde aterrissar e para que o
// harness possa reprovar a regressão antes de ela chegar a uma rota.

class TenantContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantContextError';
  }
}

// Tudo que um cliente consegue controlar. Listado para ser auditável, e usado pelo invariant de
// auth para forjar cada um deles e provar que o resultado não muda.
const FONTES_CONTROLADAS_PELO_CLIENTE = Object.freeze([
  'headers', 'query', 'body', 'params', 'cookies',
]);

// Resolve a organization do contexto.
//
// `req` é recebido só para tornar o defeito escrevível (mesmo raciocínio de ownership.js): o
// negative control do invariant de auth substitui o corpo desta função por uma versão que consulta
// `req.headers['x-organization-id']`, e o invariant precisa reprovar. Se `req` nem chegasse aqui,
// o teste estaria provando a assinatura da função, não a regra.
function resolveOrganization(req, sessao) {
  void req;

  if (!sessao || typeof sessao !== 'object') {
    throw new TenantContextError('sem sessão autenticada — nenhum tenant pode ser resolvido');
  }

  const organizationId = sessao.organizationId;
  if (organizationId === null || organizationId === undefined || String(organizationId).trim() === '') {
    throw new TenantContextError(
      'sessão sem organizationId. Fail-closed: não se procura o tenant em header, query, body, ' +
      'cookie nem process.env (INV-02, INV-10).'
    );
  }

  return String(organizationId);
}

// Store da Organization. Na V1 é 1:1, então NÃO vem do browser. Se um dia vier por razão técnica,
// ainda assim precisa pertencer à Organization autenticada — é o que esta função garante.
function resolveOrganizationStore({ organizationId, storesDaOrganization = [], storeIdSolicitada = null }) {
  if (!organizationId) throw new TenantContextError('resolveOrganizationStore exige organizationId');

  const doTenant = storesDaOrganization.filter((s) => String(s.organization_id) === String(organizationId));

  if (storeIdSolicitada !== null && storeIdSolicitada !== undefined) {
    const encontrada = doTenant.find((s) => String(s.id) === String(storeIdSolicitada));
    if (!encontrada) {
      throw new TenantContextError('store solicitada não pertence à organization autenticada');
    }
    return encontrada;
  }

  if (doTenant.length !== 1) {
    // Zero é erro óbvio. Mais de uma também é erro: PD-002 fechou 1:1, e "pega a primeira" é
    // literalmente o padrão proibido. Ambos os casos falham fechado.
    throw new TenantContextError(
      `esperava exatamente 1 store ativa para a organization; encontrei ${doTenant.length}`
    );
  }

  return doTenant[0];
}

module.exports = {
  TenantContextError,
  FONTES_CONTROLADAS_PELO_CLIENTE,
  resolveOrganization,
  resolveOrganizationStore,
};
