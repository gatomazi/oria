'use strict';

// Audit log com sujeito real (Fase 2 · INV-21, parte de identidade).
//
// Todo registro novo carrega o id do usuário autenticado. Sujeito ausente, ou o antigo sujeito
// sintético 'admin', é erro — nunca "grava assim mesmo". O histórico anterior não é reescrito.
//
// Organization: quando a ação tem dono conhecido (ex.: gestão de membros), ele vai explícito. Sem
// ele, o trigger de tenancy da Fase 1 resolve pela loja ou pelo dono declarado — escopar todo
// registro pela Organization ativa é Fase 3.

const { comOrganization } = require('./tenant-db');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AuditError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditError';
  }
}

function validarAtor(actorUserId) {
  if (typeof actorUserId !== 'string' || !UUID_RE.test(actorUserId)) {
    throw new AuditError(`audit sem sujeito real (recebido: ${JSON.stringify(actorUserId)})`);
  }
  return actorUserId;
}

const SQL = `INSERT INTO audit_log (criado_em, actor_user_id, action, entity_type, entity_id, loja, before, after, organization_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING id, organization_id`;

async function registrarAuditoria(pool, entrada) {
  const ator = validarAtor(entrada.actorUserId);
  const params = [
    entrada.criadoEm || new Date().toISOString(),
    ator,
    entrada.action,
    entrada.entityType,
    entrada.entityId,
    entrada.loja || null,
    JSON.stringify(entrada.before ?? null),
    JSON.stringify(entrada.after ?? null),
    entrada.organizationId || null,
  ];
  // Dono conhecido: grava dentro do contexto dele (vale sob RLS forçada).
  if (entrada.organizationId) {
    return comOrganization(pool, entrada.organizationId, (c) => c.query(SQL, params)).then((r) => r.rows[0]);
  }
  const { rows } = await pool.query(SQL, params);
  return rows[0];
}

module.exports = { AuditError, validarAtor, registrarAuditoria };
