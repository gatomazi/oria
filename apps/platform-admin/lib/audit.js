'use strict';

// Auditoria do control plane (§22).
//
// Duas regras que o resto do código não pode contornar:
//
//   1. **Sujeito real.** Todo registro carrega o id E o e-mail do platform admin que agiu. Sem
//      sujeito é erro, nunca "grava assim mesmo". O e-mail é RETRATO: o rastro sobrevive ao admin
//      ser removido (a FK vira NULL, o e-mail fica).
//
//   2. **Nenhum segredo.** `before`/`after` passam por um guarda que RECUSA (não redige em
//      silêncio) qualquer chave que pareça credencial, em qualquer profundidade. Redação
//      silenciosa treina o código a mandar segredo para a auditoria e confiar no filtro; recusa
//      quebra o teste na hora em que alguém escreve isso.
//
// Uso: `registrar(cliente, entrada)` recebe o CLIENTE da transação da mutação, não o pool. É assim
// que "mutação sem auditoria" fica impossível: se a auditoria falhar, a mutação desfaz junto.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Vocabulário fechado. Ação fora daqui é erro de programação.
const ACOES = Object.freeze([
  'admin.login',
  'admin.logout',
  'admin.login_failed',
  'admin.created',
  'admin.deactivated',
  'admin.reactivated',
  'admin.role_changed',
  'plan.created',
  'plan.updated',
  'plan.archived',
  'plan.features_replaced',
  'organization.created',
  'organization.suspended',
  'organization.reactivated',
  'subscription.created',
  'subscription.changed',
  'entitlement.override_set',
  'entitlement.override_removed',
  'invite.issued',
  'invite.reissued',
  'invite.revoked',
  'member.removed',
  'integration.tested',
]);

// Chave que cheira a credencial. Deliberadamente largo: falso positivo custa renomear um campo.
const CHAVE_PROIBIDA = /(token|secret|senha|password|passwd|hash|api_?key|private_?key|authorization|cookie|ciphertext|credential|bearer)/i;

class AuditError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'AuditError';
    Object.assign(this, extra);
  }
}

// Recusa, não redige. Profundidade limitada para não virar caminho de DoS por objeto aninhado.
function exigirSemSegredo(valor, caminho = '$', profundidade = 0) {
  if (profundidade > 8) throw new AuditError(`auditoria: objeto aninhado demais em ${caminho}`);
  if (valor === null || valor === undefined) return valor;
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => exigirSemSegredo(v, `${caminho}[${i}]`, profundidade + 1));
    return valor;
  }
  if (typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor)) {
      if (CHAVE_PROIBIDA.test(k)) {
        throw new AuditError(`auditoria: campo "${k}" parece credencial e não pode ir para o log`, { campo: k });
      }
      exigirSemSegredo(v, `${caminho}.${k}`, profundidade + 1);
    }
    return valor;
  }
  return valor;
}

function validarAtor(ator) {
  if (!ator || typeof ator !== 'object') throw new AuditError('auditoria sem sujeito');
  if (typeof ator.adminId !== 'string' || !UUID_RE.test(ator.adminId)) {
    throw new AuditError(`auditoria sem sujeito real (adminId: ${JSON.stringify(ator.adminId)})`);
  }
  if (typeof ator.email !== 'string' || !ator.email.trim()) {
    throw new AuditError('auditoria sem e-mail do sujeito');
  }
  return ator;
}

const SQL = `INSERT INTO platform_audit_logs
               (actor_admin_id, actor_email, action, entity_type, entity_id, organization_id, before, after)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
             RETURNING id, criado_em`;

// `cliente` é o client da transação da mutação (db.emTransacao / db.comOrganization).
async function registrar(cliente, entrada) {
  const ator = validarAtor(entrada.ator);
  if (!ACOES.includes(entrada.action)) {
    throw new AuditError(`auditoria: ação desconhecida ${JSON.stringify(entrada.action)}`);
  }
  exigirSemSegredo(entrada.before ?? null, '$.before');
  exigirSemSegredo(entrada.after ?? null, '$.after');

  const { rows } = await cliente.query(SQL, [
    ator.adminId,
    ator.email,
    entrada.action,
    entrada.entityType,
    entrada.entityId === undefined || entrada.entityId === null ? null : String(entrada.entityId),
    entrada.organizationId || null,
    JSON.stringify(entrada.before ?? null),
    JSON.stringify(entrada.after ?? null),
  ]);
  return rows[0];
}

module.exports = { ACOES, CHAVE_PROIBIDA, AuditError, exigirSemSegredo, validarAtor, registrar };
