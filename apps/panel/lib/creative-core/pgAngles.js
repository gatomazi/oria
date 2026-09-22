'use strict';

// Persistência dos ângulos customizados (Fase D) — tabela creative_angles (migration 0034). Ângulos SYSTEM não
// vivem aqui: vêm do catálogo do core (`GET /v1/contracts` → `catalog.angle_families`/`angle_legacy_map`), lido
// pela rota, nunca por este módulo. Nomes de coluna só saem do mapa fixo abaixo, nunca do request.

const FAMILIES = Object.freeze([
  'lifestyle', 'connection', 'editorial_portrait', 'action_movement', 'product_focus', 'product_no_person', 'creator_social',
]);
const PEOPLE_MODES = Object.freeze(['none', 'optional', 'required']);

function iso(v) {
  return v instanceof Date ? v.toISOString() : v || null;
}

function mapAngle(r) {
  return r && {
    id: r.id, organizationId: r.organization_id, storeId: r.store_id, scope: r.scope, slug: r.slug, name: r.name,
    description: r.description, family: r.family, peopleMode: r.people_mode, preset: r.preset, definition: r.definition,
    // Fase D.1 (migration 0035): compatibilidade que o planner passa a respeitar de verdade.
    allowedInteractions: r.allowed_interactions, allowedProductModes: r.allowed_product_modes, defaultGaze: r.default_gaze,
    active: r.active, version: r.version, createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

// O ângulo no formato que o REQUEST do core espera (CustomAngle — snake_case, sem campos só do painel).
function angleForCore(a) {
  return {
    id: a.id, scope: a.scope, organization_id: a.organizationId, store_id: a.storeId, slug: a.slug, name: a.name,
    description: a.description, family: a.family, people_mode: a.peopleMode, preset: a.preset, definition: a.definition || {},
    allowed_interactions: a.allowedInteractions, allowed_product_modes: a.allowedProductModes, default_gaze: a.defaultGaze,
    active: a.active, version: a.version, created_by: a.createdBy, created_at: a.createdAt, updated_at: a.updatedAt,
  };
}

// `q` = (sql, params) => Promise<{ rows, rowCount }>, o mesmo executor do pgStore (contexto de tenant incluso).
function angleMethods(q) {
  return {
    // Biblioteca resolvida para ESTA Store: os ângulos de Organization (store_id NULL) + os desta Store, sempre
    // ativos. Nunca junta com o catálogo system — isso é papel da rota, que já tem o catálogo do core em mãos.
    async listAngles(tenantId, { storeId = null, includeInactive = false } = {}) {
      const filtroAtivo = includeInactive ? '' : 'AND active';
      const filtroEscopo = storeId ? 'AND (store_id IS NULL OR store_id = $2)' : 'AND store_id IS NULL';
      const params = storeId ? [tenantId, storeId] : [tenantId];
      const { rows } = await q(
        `SELECT * FROM creative_angles WHERE organization_id = $1::uuid ${filtroEscopo} ${filtroAtivo} ORDER BY scope, name`,
        params,
      );
      return rows.map(mapAngle);
    },
    async getAngle(tenantId, id) {
      const { rows } = await q('SELECT * FROM creative_angles WHERE organization_id = $1::uuid AND id = $2', [tenantId, id]);
      return mapAngle(rows[0]) || null;
    },
    async createAngle(tenantId, { storeId = null, slug, name, description, family, peopleMode, preset, definition,
      allowedInteractions, allowedProductModes, defaultGaze, createdBy }) {
      const scope = storeId ? 'store' : 'organization';
      const { rows } = await q(
        `INSERT INTO creative_angles
           (organization_id, store_id, scope, slug, name, description, family, people_mode, preset, definition,
            allowed_interactions, allowed_product_modes, default_gaze, created_by)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
        [tenantId, storeId, scope, slug, name, description || null, family, peopleMode, preset || null,
          JSON.stringify(definition || {}), allowedInteractions || null, allowedProductModes || null, defaultGaze || null,
          createdBy || null],
      );
      return mapAngle(rows[0]);
    },
    // Nunca reescreve um plano já gerado (o core roteia para o angle_id legado, que não volta a ler esta linha):
    // `version` só sobe para o histórico saber em qual versão do ângulo cada criativo foi feito.
    async updateAngle(tenantId, id, { name, description, family, peopleMode, preset, definition,
      allowedInteractions, allowedProductModes, defaultGaze, active }) {
      const { rows } = await q(
        `UPDATE creative_angles SET
           name = COALESCE($3, name), description = COALESCE($4, description), family = COALESCE($5, family),
           people_mode = COALESCE($6, people_mode), preset = COALESCE($7, preset),
           definition = COALESCE($8, definition), allowed_interactions = COALESCE($9, allowed_interactions),
           allowed_product_modes = COALESCE($10, allowed_product_modes), default_gaze = COALESCE($11, default_gaze),
           active = COALESCE($12, active), version = version + 1, updated_at = now()
         WHERE organization_id = $1::uuid AND id = $2 RETURNING *`,
        [tenantId, id, name || null, description === undefined ? null : description, family || null, peopleMode || null,
          preset === undefined ? null : preset, definition ? JSON.stringify(definition) : null,
          allowedInteractions === undefined ? null : allowedInteractions, allowedProductModes === undefined ? null : allowedProductModes,
          defaultGaze === undefined ? null : defaultGaze, active === undefined ? null : active],
      );
      return mapAngle(rows[0]) || null;
    },
    async archiveAngle(tenantId, id) {
      const { rowCount } = await q(
        'UPDATE creative_angles SET active = false, version = version + 1, updated_at = now() WHERE organization_id = $1::uuid AND id = $2 AND active',
        [tenantId, id],
      );
      return rowCount > 0;
    },
  };
}

module.exports = { angleMethods, angleForCore, FAMILIES, PEOPLE_MODES };
