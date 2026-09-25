'use strict';

// Persistência do feedback (Gostei / Não gostei) do Gerador de Criativos: uma linha por (Organization, criativo, pessoa),
// tabela creative_feedback (migration 0033). Só memória para consulta: nada aqui alimenta o planner.
// Nomes de coluna só saem do mapa fixo abaixo, nunca do request.

// Dimensões de consulta do feedback → coluna. Nome de coluna só sai deste mapa fixo, nunca do request.
const FEEDBACK_DIMENSIONS = Object.freeze({
  angle: 'angle', objective: 'objective', context: 'context_id', interaction: 'interaction', composition: 'composition_key',
});
const FEEDBACK_VERDICTS = ['liked', 'disliked'];
function iso(v) {
  return v instanceof Date ? v.toISOString() : v || null;
}

function mapFeedback(r) {
  return r && {
    id: r.id, tenantId: r.organization_id, storeId: r.store_id, creativeId: r.creative_id, jobId: r.job_id, userId: r.user_id,
    verdict: r.verdict, snapshot: r.snapshot, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

// Colunas de consulta copiadas do snapshot (o snapshot manda; as colunas existem para filtrar sem abrir o JSON).
function feedbackColumns(snapshot) {
  const s = snapshot || {};
  return [
    s.plan_schema_version ?? null, s.compiler_version ?? null, s.prompt_version ?? null, s.angle ?? null, s.objective ?? null,
    s.mode ?? null, (s.context && s.context.context_id) ?? null, s.interaction ?? null, s.composition_key ?? null,
    Array.isArray(s.product_ids) ? s.product_ids.map(String) : [], Number.isInteger(s.people_count) ? s.people_count : null,
    s.pose_risk ?? null,
  ];
}

// `q` = (sql, params) => Promise<{ rows, rowCount }>, o mesmo executor do pgStore (contexto de tenant incluso).
function feedbackMethods(q) {
  return {
    // ── Feedback (Gostei / Não gostei): um veredito por (Organization, criativo, pessoa). Nunca alimenta o planner.
    async upsertFeedback(tenantId, { userId, storeId = null, creativeId, jobId, verdict, snapshot }) {
      const { rows } = await q(
        `INSERT INTO creative_feedback
           (organization_id, store_id, creative_id, job_id, user_id, verdict, snapshot, plan_schema_version, compiler_version,
            prompt_version, angle, objective, mode, context_id, interaction, composition_key, product_ids, people_count, pose_risk)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (organization_id, creative_id, user_id) DO UPDATE SET
           store_id = EXCLUDED.store_id, verdict = EXCLUDED.verdict, snapshot = EXCLUDED.snapshot,
           plan_schema_version = EXCLUDED.plan_schema_version, compiler_version = EXCLUDED.compiler_version,
           prompt_version = EXCLUDED.prompt_version, angle = EXCLUDED.angle, objective = EXCLUDED.objective, mode = EXCLUDED.mode,
           context_id = EXCLUDED.context_id, interaction = EXCLUDED.interaction, composition_key = EXCLUDED.composition_key,
           product_ids = EXCLUDED.product_ids, people_count = EXCLUDED.people_count, pose_risk = EXCLUDED.pose_risk,
           updated_at = now()
         RETURNING *`,
        [tenantId, storeId, creativeId, jobId, userId, verdict, JSON.stringify(snapshot), ...feedbackColumns(snapshot)],
      );
      return mapFeedback(rows[0]);
    },
    async deleteFeedback(tenantId, userId, creativeId) {
      const { rowCount } = await q('DELETE FROM creative_feedback WHERE organization_id = $1::uuid AND user_id = $2 AND creative_id = $3', [tenantId, userId, creativeId]);
      return rowCount > 0;
    },
    async getFeedback(tenantId, userId, creativeId) {
      const { rows } = await q('SELECT * FROM creative_feedback WHERE organization_id = $1::uuid AND user_id = $2 AND creative_id = $3', [tenantId, userId, creativeId]);
      return mapFeedback(rows[0]) || null;
    },
    // creativeId → { verdict, updatedAt } do veredito DESTA pessoa, para o histórico e os cards.
    async feedbackByCreative(tenantId, userId, creativeIds) {
      if (!creativeIds.length) return new Map();
      const { rows } = await q(
        'SELECT creative_id, verdict, updated_at FROM creative_feedback WHERE organization_id = $1::uuid AND user_id = $2 AND creative_id = ANY($3::uuid[])',
        [tenantId, userId, creativeIds],
      );
      return new Map(rows.map((r) => [r.creative_id, { verdict: r.verdict, updatedAt: iso(r.updated_at) }]));
    },
    // Aprovação por dimensão (ângulo, objetivo, contexto, interação, composição, produto). Só leitura, só contagem.
    // `storeId`: as linhas daquela Store + as compartilhadas (store_id nulo); sem ele, a Organization inteira.
    async feedbackSummary(tenantId, { by, storeId = null }) {
      if (by !== 'product' && !FEEDBACK_DIMENSIONS[by]) throw new Error('dimensão de feedback desconhecida');
      const filtroStore = storeId ? 'AND (store_id = $2 OR store_id IS NULL)' : '';
      const params = storeId ? [tenantId, storeId] : [tenantId];
      const contagem = "count(*) FILTER (WHERE verdict = 'liked')::int AS liked, count(*) FILTER (WHERE verdict = 'disliked')::int AS disliked, count(*)::int AS total";
      const sql = by === 'product'
        ? `SELECT p AS key, ${contagem} FROM creative_feedback, unnest(product_ids) AS p WHERE organization_id = $1::uuid ${filtroStore} GROUP BY p ORDER BY total DESC, key LIMIT 200`
        : `SELECT ${FEEDBACK_DIMENSIONS[by]} AS key, ${contagem} FROM creative_feedback WHERE organization_id = $1::uuid ${filtroStore} AND ${FEEDBACK_DIMENSIONS[by]} IS NOT NULL GROUP BY 1 ORDER BY total DESC, key LIMIT 200`;
      const { rows } = await q(sql, params);
      return rows.map((r) => ({ key: r.key, liked: r.liked, disliked: r.disliked, total: r.total }));
    },
  };
}

module.exports = { feedbackMethods, FEEDBACK_DIMENSIONS, FEEDBACK_VERDICTS };
