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

// Parâmetros do INSERT, separados da execução — é o que permite gravar tanto num pool quanto
// dentro de uma transação que já está aberta.
function parametrosDeAuditoria(entrada) {
  const ator = validarAtor(entrada.actorUserId);
  return [
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
}

// Grava a auditoria num cliente que JÁ está numa transação com o contexto de Organization posto.
// Existe para o caso em que a auditoria precisa ser atômica com a escrita que ela descreve: ou as
// duas acontecem, ou nenhuma. Sem isto, a auditoria abriria transação própria e um erro nela
// deixaria a escrita anterior comitada e sem rastro.
async function registrarAuditoriaEm(cliente, entrada) {
  const { rows } = await cliente.query(SQL, parametrosDeAuditoria(entrada));
  return rows[0];
}

async function registrarAuditoria(pool, entrada) {
  const params = parametrosDeAuditoria(entrada);
  // Dono conhecido: grava dentro do contexto dele (vale sob RLS forçada).
  if (entrada.organizationId) {
    return comOrganization(pool, entrada.organizationId, (c) => c.query(SQL, params)).then((r) => r.rows[0]);
  }
  const { rows } = await pool.query(SQL, params);
  return rows[0];
}

module.exports = { AuditError, validarAtor, registrarAuditoria, registrarAuditoriaEm };
