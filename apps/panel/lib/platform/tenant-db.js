'use strict';

// TD-001 — como a Organization chega à RLS do Postgres.
//
// Mecanismo fechado: transação + `set_config('app.current_organization_id', $1, true)`.
// O `true` é o `is_local`: equivale a `SET LOCAL` e morre no COMMIT/ROLLBACK. Com pool, a conexão
// volta limpa para o próximo request — nada fica gravado na sessão. `SET LOCAL` literal não aceita
// parâmetro de bind; `set_config` aceita, e o valor ainda passa por validação de UUID antes.
//
// As policies da Fase 1 leem o valor assim:
//
//     organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid
//
// Sem contexto, `current_setting(..., true)` dá NULL (ou '' numa sessão onde o valor já existiu e
// foi desfeito — daí o NULLIF). Comparação com NULL não casa nenhuma linha: fail-closed, sem erro
// e sem vazamento.
//
// A Fase 0 NÃO liga isto a rota nenhuma. É o contrato que a Fase 1 usa e que
// test/invariants/td001-rls-contract.test.js prova contra um Postgres real.

const CONFIG_ORGANIZATION = 'app.current_organization_id';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TenantDbContextError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TenantDbContextError';
  }
}

// Roda `fn(client)` numa transação com a Organization no contexto. `organizationId` vem do tenant
// context resolvido pela sessão (TD-002), nunca de header/query/body.
async function comOrganization(pool, organizationId, fn) {
  if (typeof organizationId !== 'string' || !UUID_RE.test(organizationId)) {
    // Fail-closed antes de tocar no banco: sem Organization válida não há query.
    throw new TenantDbContextError('organizationId ausente ou inválido — nenhuma query roda sem tenant');
  }
  if (typeof fn !== 'function') throw new TypeError('comOrganization exige um callback');

  const client = await pool.connect();
  let descartar = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [CONFIG_ORGANIZATION, organizationId]);
    const resultado = await fn(client);
    await client.query('COMMIT');
    return resultado;
  } catch (err) {
    // Se nem o ROLLBACK passar, a conexão não volta ao pool num estado desconhecido.
    await client.query('ROLLBACK').catch(() => { descartar = true; });
    throw err;
  } finally {
    client.release(descartar);
  }
}

module.exports = { CONFIG_ORGANIZATION, TenantDbContextError, comOrganization };
