'use strict';

// Pipeline de request tenant-facing (Fase 3 · TD-002):
//
//   authenticateUser → resolveOrganizationFromSession → verifyMembership
//     → resolveOrganizationStore → checkEntitlement → handler
//
// A Organization vem SÓ de sessions.active_organization_id. Quem grava esse valor é o servidor,
// depois de validar o membership (POST /api/admin/session/organization, ou a seleção automática
// abaixo). Nenhuma rota de negócio aceita tenant do cliente: parâmetro de tenant no request é 400.
//
// Seleção automática: permitida quando o USUÁRIO AUTENTICADO tem exatamente UM membership
// explícito. Isso não é "o único candidato do banco" (INV-09): o universo é o conjunto de
// Organizations autorizadas para esta pessoa, lido de organization_members, e não o de
// Organizations existentes. Uma pessoa com zero memberships não recebe nenhuma; com duas ou mais,
// precisa escolher.

const { comOrganization } = require('./tenant-db');
const { comContexto } = require('./tenant-runtime');

// Nomes que selecionam tenant. Em query, corpo (nível de topo) ou header, a request é recusada.
const SELETORES = ['loja', 'store_id', 'storeid', 'organization_id', 'organizationid', 'tenant_id', 'tenantid', 'org_id', 'orgid'];
const HEADERS_SELETORES = ['x-organization-id', 'x-org-id', 'x-store-id', 'x-tenant-id', 'x-loja'];

class TenantContextHttpError extends Error {
  constructor(status, codigo, message) {
    super(message);
    this.name = 'TenantContextHttpError';
    this.status = status;
    this.codigo = codigo;
  }
}

function seletoresNoRequest(req) {
  const achados = [];
  const chaves = (obj) => (obj && typeof obj === 'object' && !Array.isArray(obj) ? Object.keys(obj) : []);
  for (const k of chaves(req.query)) if (SELETORES.includes(k.toLowerCase())) achados.push(`query.${k}`);
  for (const k of chaves(req.body)) if (SELETORES.includes(k.toLowerCase())) achados.push(`body.${k}`);
  for (const hdr of HEADERS_SELETORES) if (req.headers[hdr] !== undefined) achados.push(`header.${hdr}`);
  return achados;
}

async function membershipsDe(poolReal, userId) {
  const { rows } = await poolReal.query('SELECT * FROM auth_memberships($1)', [userId]);
  return rows.map((r) => ({ organizationId: r.organization_id, nome: r.organization_nome, papel: r.papel }));
}

// Resolve (e, se preciso, grava) a Organization ativa da sessão. Devolve o membership ativo ou
// lança TenantContextHttpError. Nunca troca silenciosamente para outra Organization.
async function resolverOrganizacaoAtiva(poolReal, auth) {
  const memberships = await membershipsDe(poolReal, auth.userId);
  const atual = auth.organizacaoAtivaId || null;

  if (atual) {
    const m = memberships.find((x) => x.organizationId === atual);
    if (m) return { membership: m, memberships };
    // Membership removido (ou Organization suspensa): a sessão perde a Organization ativa. A
    // pessoa escolhe de novo; ninguém escolhe por ela.
    await poolReal.query(
      'UPDATE sessions SET active_organization_id = NULL WHERE id = $1 AND active_organization_id = $2',
      [auth.sessaoId, atual]
    );
    throw new TenantContextHttpError(403, 'ORGANIZATION_ACCESS_REVOKED', 'acesso a esta organization foi removido');
  }

  if (memberships.length === 1) {
    const [m] = memberships;
    await poolReal.query(
      'UPDATE sessions SET active_organization_id = $1 WHERE id = $2 AND active_organization_id IS NULL',
      [m.organizationId, auth.sessaoId]
    );
    return { membership: m, memberships, autoSelecionada: true };
  }
  if (!memberships.length) {
    throw new TenantContextHttpError(403, 'NO_ORGANIZATION_MEMBERSHIP', 'usuário sem organization');
  }
  throw new TenantContextHttpError(409, 'ORGANIZATION_CONTEXT_REQUIRED', 'escolha uma organization para continuar');
}

// Troca explícita de workspace. O valor proposto pelo navegador só vira contexto depois de passar
// pelo membership desta pessoa.
async function selecionarOrganizacao(poolReal, auth, organizationIdProposta) {
  const memberships = await membershipsDe(poolReal, auth.userId);
  const m = memberships.find((x) => x.organizationId === organizationIdProposta);
  if (!m) throw new TenantContextHttpError(404, 'ORGANIZATION_NOT_FOUND', 'organization não encontrada');
  await poolReal.query('UPDATE sessions SET active_organization_id = $1 WHERE id = $2', [m.organizationId, auth.sessaoId]);
  return m;
}

// Organization → Store (PD-002, 1:1). Nunca por loja do request, env ou "a única Store do banco".
async function resolverStore(poolReal, organizationId) {
  const { rows } = await comOrganization(poolReal, organizationId, (c) => c.query(
    'SELECT id, loja_legada, nome FROM stores WHERE organization_id = $1 AND ativa', [organizationId]
  ));
  if (rows.length === 0) throw new TenantContextHttpError(409, 'STORE_NOT_FOUND', 'organization sem store ativa');
  if (rows.length > 1) {
    console.error(`[TENANCY] integridade: organization ${organizationId} com ${rows.length} stores ativas`);
    throw new TenantContextHttpError(500, 'STORE_INTEGRITY_ERROR', 'erro de integridade da organization');
  }
  return { storeId: rows[0].id, loja: rows[0].loja_legada, nome: rows[0].nome || null };
}

function responderErro(res, err) {
  if (err instanceof TenantContextHttpError) {
    return res.status(err.status).json({ error: err.message, codigo: err.codigo });
  }
  console.error(`[TENANCY] falha ao resolver contexto: ${err.message}`);
  return res.status(503).json({ error: 'contexto indisponível', codigo: 'TENANT_CONTEXT_UNAVAILABLE' });
}

function createTenantPipeline({ poolReal }) {
  // Depois de requireAuth: exige Organization ativa, membership vigente e Store; roda o resto da
  // request dentro do contexto (toda query passa por comOrganization — ver tenant-runtime.js).
  async function requireOrganizationContext(req, res, next) {
    if (!req.auth) return res.status(401).json({ error: 'não autenticado' });
    const seletores = seletoresNoRequest(req);
    if (seletores.length) {
      return res.status(400).json({
        error: `tenant vem da sessão; parâmetros não aceitos: ${seletores.join(', ')}`,
        codigo: 'TENANT_SELECTOR_NOT_ALLOWED',
      });
    }
    let contexto;
    try {
      const { membership } = await resolverOrganizacaoAtiva(poolReal, req.auth);
      const store = await resolverStore(poolReal, membership.organizationId);
      contexto = {
        organizationId: membership.organizationId,
        storeId: store.storeId,
        loja: store.loja,
        papel: membership.papel,
      };
    } catch (err) {
      return responderErro(res, err);
    }
    req.tenant = Object.freeze(contexto);
    return comContexto({ ...contexto, origem: 'sessao' }, () => next());
  }

  function requireOwner(req, res, next) {
    if (!req.tenant || req.tenant.papel !== 'owner') {
      return res.status(403).json({ error: 'apenas owner', codigo: 'OWNER_REQUIRED' });
    }
    return next();
  }

  return { requireOrganizationContext, requireOwner };
}

module.exports = {
  SELETORES,
  HEADERS_SELETORES,
  TenantContextHttpError,
  seletoresNoRequest,
  membershipsDe,
  resolverOrganizacaoAtiva,
  selecionarOrganizacao,
  resolverStore,
  createTenantPipeline,
};
