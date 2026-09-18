'use strict';

// Read models globais — a ÚNICA forma de o control plane listar através de Organizations.
//
// Cada função aqui é uma casca fina sobre a função SQL correspondente (SECURITY DEFINER, criada em
// `apps/panel/migrations/sql/0019-platform-admin.up.sql`, com REVOKE de PUBLIC). Não existe, em
// lugar nenhum deste app, um `SELECT ... FROM organizations` cru fora de `comOrganization`. O teste
// `sem-query-global` varre o código-fonte e reprova se aparecer.
//
// O que estas funções não devolvem — e por quê:
//   integrations.config / integration_secrets   segredo e configuração de provider
//   webhook_eventos.headers / .body             payload cru, com PII
//   job_leases.dono                             identificador de worker/host
//   users.password_hash                         credencial

const { codificarCursor } = require('./http');

// Pede `limite + 1` para saber se há próxima página sem um COUNT separado.
function paginar(linhas, limite, cursorDe) {
  const tem = linhas.length > limite;
  const itens = tem ? linhas.slice(0, limite) : linhas;
  return {
    itens,
    proximoCursor: tem && itens.length ? codificarCursor(cursorDe(itens[itens.length - 1])) : null,
  };
}

function criarReadModels(pool) {
  async function organizations({ status = null, busca = null, limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      'SELECT * FROM platform_listar_organizations($1, $2, $3, $4, $5)',
      [status, busca, limite + 1, cursor ? cursor.em : null, cursor ? cursor.id : null]
    );
    return paginar(rows, limite, (r) => ({ em: r.criado_em, id: r.id }));
  }

  async function organizationResumo(organizationId) {
    const { rows } = await pool.query('SELECT * FROM platform_organization_resumo($1)', [organizationId]);
    return rows[0] || null;
  }

  async function organizationsAtivas() {
    const { rows } = await pool.query('SELECT * FROM platform_organizations_ativas()');
    return rows;
  }

  async function membros(organizationId) {
    const { rows } = await pool.query('SELECT * FROM platform_listar_membros($1)', [organizationId]);
    return rows;
  }

  async function ownersAtivos(organizationId, cliente = pool) {
    const { rows } = await cliente.query('SELECT platform_owners_ativos($1) AS n', [organizationId]);
    return rows[0].n;
  }

  async function users({ busca = null, status = null, limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      'SELECT * FROM platform_listar_users($1, $2, $3, $4, $5)',
      [busca, status, limite + 1, cursor ? cursor.em : null, cursor ? cursor.id : null]
    );
    return paginar(rows, limite, (r) => ({ em: r.criado_em, id: r.id }));
  }

  async function onboardings({ status = null, limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      'SELECT * FROM platform_listar_onboardings($1, $2, $3, $4)',
      [status, limite + 1, cursor ? cursor.em : null, cursor ? cursor.id : null]
    );
    return paginar(rows, limite, (r) => ({ em: r.atualizado_em, id: r.organization_id }));
  }

  async function onboardingResumo(organizationId) {
    const { rows } = await pool.query('SELECT * FROM platform_onboarding_resumo($1)', [organizationId]);
    return rows[0] || null;
  }

  async function passos(organizationId) {
    const { rows } = await pool.query('SELECT * FROM platform_listar_passos($1)', [organizationId]);
    return rows;
  }

  async function integracoes({ organizationId = null, provider = null, status = null, limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      'SELECT * FROM platform_listar_integracoes($1, $2, $3, $4, $5, $6)',
      [organizationId, provider, status, limite + 1, cursor ? cursor.em : null, cursor ? cursor.id : null]
    );
    return paginar(rows, limite, (r) => ({ em: r.atualizado_em, id: r.id }));
  }

  async function jobs({ organizationId = null, limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      'SELECT * FROM platform_listar_jobs($1, $2, $3, $4)',
      [organizationId, limite + 1, cursor ? cursor.job : null, cursor ? cursor.org : null]
    );
    return paginar(rows, limite, (r) => ({ job: r.job, org: r.organization_id }));
  }

  async function webhooks({ organizationId = null, verificado = null, limite = 50, cursor = null }) {
    const { rows } = await pool.query(
      'SELECT * FROM platform_listar_webhooks($1, $2, $3, $4, $5)',
      [organizationId, verificado, limite + 1, cursor ? cursor.em : null, cursor ? cursor.id : null]
    );
    return paginar(rows, limite, (r) => ({ em: r.recebido_em, id: r.id }));
  }

  async function overview() {
    const { rows } = await pool.query('SELECT * FROM platform_overview()');
    return rows[0];
  }

  return {
    organizations,
    organizationResumo,
    organizationsAtivas,
    membros,
    ownersAtivos,
    users,
    onboardings,
    onboardingResumo,
    passos,
    integracoes,
    jobs,
    webhooks,
    overview,
  };
}

module.exports = { criarReadModels, paginar };
