'use strict';

// Store Postgres do Gerador de Criativos. Todas as queries são parametrizadas e filtradas por tenant_id.
// Desde a Fase 3 (INV-22), tenant_id É o id da Organization (CHECK no banco): os INSERTs gravam os dois.
// Nomes de tabela vêm só do mapa fixo abaixo, nunca do request.

const { aggregateJobStatus, FINAL_JOB } = require('./status');

const PROFILE_TABLE = Object.freeze({
  brand: 'creative_brand_profiles',
  niche: 'creative_niche_profiles',
  context: 'creative_context_profiles',
  persona: 'creative_personas',
});

const ITEM_PATCH_COLUMNS = Object.freeze({
  status: 'status',
  generationAttempt: 'generation_attempt',
  infraRetries: 'infra_retries',
  nextAttemptAt: 'next_attempt_at',
  plan: 'plan',
  planSummary: 'plan_summary',
  record: 'record',
  error: 'error',
  angle: 'angle',
  placement: 'placement',
  funnelStage: 'funnel_stage',
  remarketingIntent: 'remarketing_intent',
  contextId: 'context_id',
  persona: 'persona',
  quality: 'quality',
  brandKitVersion: 'brand_kit_version',
  nicheKitVersion: 'niche_kit_version',
  promptVersion: 'prompt_version',
  assetId: 'asset_id',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  modeloImagem: 'modelo_imagem',
  tokensEntrada: 'tokens_entrada',
  tokensSaida: 'tokens_saida',
  tokensEntradaCache: 'tokens_entrada_cache',
  tokensEntradaTexto: 'tokens_entrada_texto',
  tokensEntradaImagem: 'tokens_entrada_imagem',
  generationTrace: 'generation_trace',
  modelServed: 'model_served',
  durationMs: 'duration_ms',
  providerRequestId: 'provider_request_id',
  planSchemaVersion: 'plan_schema_version',
  compilerVersion: 'compiler_version',
});
// Dimensões de consulta do feedback → coluna. Nome de coluna só sai deste mapa fixo, nunca do request.
const FEEDBACK_DIMENSIONS = Object.freeze({
  angle: 'angle', objective: 'objective', context: 'context_id', interaction: 'interaction', composition: 'composition_key',
});
const FEEDBACK_VERDICTS = ['liked', 'disliked'];
const JSON_COLUMNS = new Set(['plan', 'plan_summary', 'record', 'error', 'generation_trace']);

function iso(v) {
  return v instanceof Date ? v.toISOString() : v || null;
}

function mapProfile(r) {
  return r && { id: r.id, tenantId: r.tenant_id, data: r.data, version: r.version, status: r.status, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) };
}

function mapProduct(r) {
  return r && {
    id: r.id, tenantId: r.tenant_id, name: r.name, type: r.type, description: r.description, metadata: r.metadata,
    references: r.references_json, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}

function mapJob(r) {
  return r && {
    id: r.id, tenantId: r.tenant_id, engine: r.engine, productMode: r.product_mode, status: r.status, input: r.input,
    total: r.total, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), finishedAt: iso(r.finished_at), cancelledAt: iso(r.cancelled_at),
  };
}

function mapItem(r) {
  return r && {
    creativeId: r.creative_id, tenantId: r.tenant_id, jobId: r.job_id, itemIndex: r.item_index, status: r.status,
    generationAttempt: r.generation_attempt, infraRetries: r.infra_retries,
    nextAttemptAt: r.next_attempt_at instanceof Date ? r.next_attempt_at.getTime() : r.next_attempt_at,
    request: r.request, plan: r.plan, planSummary: r.plan_summary, record: r.record, error: r.error,
    engine: r.engine, productMode: r.product_mode, productIds: r.product_ids, brandId: r.brand_id, angle: r.angle,
    placement: r.placement, funnelStage: r.funnel_stage, remarketingIntent: r.remarketing_intent, contextId: r.context_id,
    persona: r.persona, quality: r.quality, brandKitVersion: r.brand_kit_version, nicheKitVersion: r.niche_kit_version,
    promptVersion: r.prompt_version, assetId: r.asset_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    startedAt: iso(r.started_at), finishedAt: iso(r.finished_at),
    modeloImagem: r.modelo_imagem, tokensEntrada: r.tokens_entrada, tokensSaida: r.tokens_saida,
    tokensEntradaCache: r.tokens_entrada_cache,
    tokensEntradaTexto: r.tokens_entrada_texto, tokensEntradaImagem: r.tokens_entrada_imagem,
    generationTrace: r.generation_trace, modelServed: r.model_served, durationMs: r.duration_ms,
    providerRequestId: r.provider_request_id,
    planSchemaVersion: r.plan_schema_version, compilerVersion: r.compiler_version,
  };
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

function createPgStore(pgPool) {
  const q = (sql, params) => pgPool.query(sql, params);

  const store = {
    kind: 'postgres',

    // A OpenAI key não mora aqui desde a Fase 4: é a integração 'openai' da Organization
    // (integration_secrets). creative_settings.openai_key_* só é lida pelo import legado.

    async listProfiles(kind, tenantId) {
      const { rows } = await q(`SELECT * FROM ${PROFILE_TABLE[kind]} WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 500`, [tenantId]);
      return rows.map(mapProfile);
    },
    async getProfile(kind, tenantId, id) {
      const { rows } = await q(`SELECT * FROM ${PROFILE_TABLE[kind]} WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [tenantId, id]);
      return mapProfile(rows[0]) || null;
    },
    async createProfile(kind, tenantId, { id, data, status }) {
      const { rows } = await q(
        `INSERT INTO ${PROFILE_TABLE[kind]} (id, tenant_id, data, status, organization_id) VALUES ($1, $2, $3, $4, $2::text::uuid) RETURNING *`,
        [id, tenantId, JSON.stringify(data), status],
      );
      return mapProfile(rows[0]);
    },
    async updateProfile(kind, tenantId, id, { data, status }) {
      const { rows } = await q(
        `UPDATE ${PROFILE_TABLE[kind]} SET data = $3, status = COALESCE($4, status), version = version + 1, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL RETURNING *`,
        [tenantId, id, JSON.stringify(data), status || null],
      );
      return mapProfile(rows[0]) || null;
    },
    async archiveProfile(kind, tenantId, id) {
      const { rowCount } = await q(`UPDATE ${PROFILE_TABLE[kind]} SET archived_at = now() WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL`, [tenantId, id]);
      return rowCount > 0;
    },

    async listProducts(tenantId) {
      const { rows } = await q('SELECT * FROM creative_products WHERE tenant_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 500', [tenantId]);
      return rows.map(mapProduct);
    },
    async getProduct(tenantId, id) {
      const { rows } = await q('SELECT * FROM creative_products WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL', [tenantId, id]);
      return mapProduct(rows[0]) || null;
    },
    async createProduct(tenantId, p) {
      const { rows } = await q(
        `INSERT INTO creative_products (id, tenant_id, name, type, description, metadata, references_json, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $2::text::uuid) RETURNING *`,
        [p.id, tenantId, p.name, p.type, p.description || null, JSON.stringify(p.metadata || {}), JSON.stringify(p.references || [])],
      );
      return mapProduct(rows[0]);
    },
    async archiveProduct(tenantId, id) {
      const { rowCount } = await q('UPDATE creative_products SET archived_at = now() WHERE tenant_id = $1 AND id = $2 AND archived_at IS NULL', [tenantId, id]);
      return rowCount > 0;
    },

    async createJob(tenantId, job, items) {
      const client = await pgPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO creative_jobs (id, tenant_id, engine, product_mode, status, input, total, organization_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $2::text::uuid)',
          [job.id, tenantId, job.engine, job.productMode, 'queued', JSON.stringify(job.input), items.length],
        );
        for (const it of items) {
          await client.query(
            `INSERT INTO creative_generations
               (creative_id, tenant_id, job_id, item_index, request, engine, product_mode, product_ids, brand_id, angle, placement, funnel_stage, remarketing_intent, quality, organization_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $2::text::uuid)`,
            [it.creativeId, tenantId, job.id, it.itemIndex, JSON.stringify(it.request), it.engine, it.productMode,
              JSON.stringify(it.productIds), it.brandId, it.angle, it.placement, it.funnelStage || null, it.remarketingIntent || null, it.quality],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      return this.getJob(tenantId, job.id);
    },
    async listJobs(tenantId, limit = 30) {
      const { rows } = await q('SELECT * FROM creative_jobs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2', [tenantId, limit]);
      return rows.map(mapJob);
    },
    async getJob(tenantId, id) {
      const { rows } = await q('SELECT * FROM creative_jobs WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
      if (!rows.length) return null;
      const itens = await q('SELECT * FROM creative_generations WHERE tenant_id = $1 AND job_id = $2 ORDER BY item_index', [tenantId, id]);
      return { ...mapJob(rows[0]), items: itens.rows.map(mapItem) };
    },
    async refreshJobStatus(tenantId, id) {
      const job = await this.getJob(tenantId, id);
      if (!job) return null;
      const status = aggregateJobStatus(job.items, Boolean(job.cancelledAt));
      const { rows } = await q(
        `UPDATE creative_jobs SET status = $3, updated_at = now(), finished_at = CASE WHEN $4 THEN COALESCE(finished_at, now()) ELSE NULL END
         WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        [tenantId, id, status, FINAL_JOB.includes(status)],
      );
      return mapJob(rows[0]);
    },
    async cancelJob(tenantId, id) {
      const { rowCount } = await q('UPDATE creative_jobs SET cancelled_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND cancelled_at IS NULL', [tenantId, id]);
      if (!rowCount && !(await this.getJob(tenantId, id))) return null;
      await q("UPDATE creative_generations SET status = 'cancelled', updated_at = now() WHERE tenant_id = $1 AND job_id = $2 AND status = 'queued'", [tenantId, id]);
      return this.refreshJobStatus(tenantId, id);
    },

    async claimNextItem(tenantId) {
      // FOR UPDATE SKIP LOCKED: seguro mesmo se um dia houver mais de uma instância do painel.
      const { rows } = await q(
        `UPDATE creative_generations g SET status = 'planning', started_at = now(), updated_at = now()
         WHERE g.creative_id = (
           SELECT c.creative_id FROM creative_generations c JOIN creative_jobs j ON j.id = c.job_id
           WHERE c.tenant_id = $1 AND c.status = 'queued' AND c.next_attempt_at <= now() AND j.cancelled_at IS NULL
           ORDER BY c.created_at, c.item_index LIMIT 1 FOR UPDATE OF c SKIP LOCKED
         ) RETURNING g.*`,
        [tenantId],
      );
      return mapItem(rows[0]) || null;
    },
    async updateItem(tenantId, creativeId, patch) {
      const sets = [];
      const params = [tenantId, creativeId];
      for (const [key, value] of Object.entries(patch)) {
        const col = ITEM_PATCH_COLUMNS[key];
        if (!col) continue; // whitelist de colunas
        params.push(JSON_COLUMNS.has(col) && value !== null ? JSON.stringify(value) : key === 'nextAttemptAt' ? new Date(value) : value);
        sets.push(`${col} = $${params.length}`);
      }
      if (!sets.length) return this.getItem(tenantId, creativeId);
      const { rows } = await q(
        `UPDATE creative_generations SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND creative_id = $2 RETURNING *`,
        params,
      );
      return mapItem(rows[0]) || null;
    },
    async getItem(tenantId, creativeId) {
      const { rows } = await q('SELECT * FROM creative_generations WHERE tenant_id = $1 AND creative_id = $2', [tenantId, creativeId]);
      return mapItem(rows[0]) || null;
    },
    async retryItem(tenantId, jobId, creativeId) {
      const { rows } = await q(
        `UPDATE creative_generations g SET status = 'queued', generation_attempt = generation_attempt + 1, infra_retries = 0,
           next_attempt_at = now(), error = NULL, finished_at = NULL, updated_at = now()
         FROM creative_jobs j
         WHERE g.tenant_id = $1 AND g.job_id = $2 AND g.creative_id = $3 AND g.status = 'failed' AND j.id = g.job_id AND j.cancelled_at IS NULL
         RETURNING g.*`,
        [tenantId, jobId, creativeId],
      );
      if (!rows.length) return null;
      await this.refreshJobStatus(tenantId, jobId);
      return mapItem(rows[0]);
    },
    async requeueStuck(tenantId) {
      const { rowCount } = await q(
        "UPDATE creative_generations SET status = 'queued', updated_at = now() WHERE tenant_id = $1 AND status IN ('planning', 'generating', 'processing')",
        [tenantId],
      );
      return rowCount;
    },

    async insertAsset(tenantId, a) {
      await q(
        `INSERT INTO creative_assets (id, tenant_id, creative_id, storage_key, mime_type, byte_size, sha256, width, height, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $2::text::uuid)`,
        [a.id, tenantId, a.creativeId, a.storageKey, a.mime, a.byteSize, a.sha256, a.width || null, a.height || null],
      );
    },
    async getAssetByCreative(tenantId, creativeId) {
      const { rows } = await q('SELECT * FROM creative_assets WHERE tenant_id = $1 AND creative_id = $2 ORDER BY created_at DESC LIMIT 1', [tenantId, creativeId]);
      if (!rows.length) return null;
      const r = rows[0];
      return { id: r.id, creativeId: r.creative_id, storageKey: r.storage_key, mime: r.mime_type, byteSize: Number(r.byte_size), sha256: r.sha256, width: r.width, height: r.height };
    },

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

    async listHistory(tenantId, limit = 50) {
      const { rows } = await q(
        "SELECT * FROM creative_generations WHERE tenant_id = $1 AND status IN ('completed', 'failed') ORDER BY updated_at DESC LIMIT $2",
        [tenantId, limit],
      );
      return rows.map(mapItem);
    },
    async recentHints(tenantId) {
      const recentes = await this.listHistory(tenantId, 20);
      return {
        recent_scenes: recentes.map((i) => i.planSummary && i.planSummary.scene).filter(Boolean),
        recent_personas: recentes.map((i) => i.persona).filter(Boolean),
      };
    },
  };
  return store;
}

module.exports = { createPgStore, PROFILE_TABLE, FEEDBACK_DIMENSIONS, FEEDBACK_VERDICTS };
