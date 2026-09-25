'use strict';

const crypto = require('crypto');

// Store em memória com o mesmo contrato do pgStore. Usado pelos testes (test/creative-core.test.js) — nunca em produção:
// o módulo exige Postgres (sem DATABASE_URL as rotas respondem 503).

const { aggregateJobStatus } = require('./status');
const { mergeSemanticContext } = require('./pgEnrichment');

const PROFILE_KINDS = ['brand', 'niche', 'context', 'persona'];
// Mesmas dimensões do pgStore (coluna do snapshot que cada uma agrupa).
const FEEDBACK_DIMENSIONS = Object.freeze({
  angle: (s) => s.angle, objective: (s) => s.objective, context: (s) => s.context && s.context.context_id,
  interaction: (s) => s.interaction, composition: (s) => s.composition_key,
});

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function createMemoryStore() {
  const settings = new Map();
  const profiles = Object.fromEntries(PROFILE_KINDS.map((k) => [k, new Map()]));
  const products = new Map();
  const jobs = new Map();
  const items = new Map();
  const assets = new Map();
  const feedback = new Map();
  const angles = new Map();
  const enrichmentProposals = new Map();
  const now = () => new Date().toISOString();

  function own(map, tenantId, id) {
    const row = map.get(id);
    return row && row.tenantId === tenantId && !row.archivedAt ? row : null;
  }

  const store = {
    kind: 'memory',

    async getSettings(tenantId) {
      return clone(settings.get(tenantId)) || null;
    },
    async saveOpenAiKey(tenantId, enc, last4) {
      settings.set(tenantId, { openaiKeyEnc: enc, openaiKeyLast4: last4, openaiKeyUpdatedAt: now() });
    },
    async deleteOpenAiKey(tenantId) {
      settings.delete(tenantId);
    },

    async listProfiles(kind, tenantId) {
      return [...profiles[kind].values()].filter((r) => r.tenantId === tenantId && !r.archivedAt).map(clone);
    },
    async getProfile(kind, tenantId, id) {
      return clone(own(profiles[kind], tenantId, id));
    },
    async createProfile(kind, tenantId, { id, data, status }) {
      const row = { id, tenantId, data: clone(data), version: 1, status, createdAt: now(), updatedAt: now(), archivedAt: null };
      profiles[kind].set(id, row);
      return clone(row);
    },
    async updateProfile(kind, tenantId, id, { data, status }) {
      const row = own(profiles[kind], tenantId, id);
      if (!row) return null;
      row.version += 1;
      row.data = clone(data);
      row.status = status || row.status;
      row.updatedAt = now();
      return clone(row);
    },
    async archiveProfile(kind, tenantId, id) {
      const row = own(profiles[kind], tenantId, id);
      if (!row) return false;
      row.archivedAt = now();
      return true;
    },

    async listProducts(tenantId) {
      return [...products.values()].filter((p) => p.tenantId === tenantId && !p.archivedAt).map(clone);
    },
    async getProduct(tenantId, id) {
      return clone(own(products, tenantId, id));
    },
    async createProduct(tenantId, product) {
      const row = { ...clone(product), tenantId, createdAt: now(), updatedAt: now(), archivedAt: null };
      products.set(product.id, row);
      return clone(row);
    },
    async archiveProduct(tenantId, id) {
      const row = own(products, tenantId, id);
      if (!row) return false;
      row.archivedAt = now();
      return true;
    },

    // Product Enrichment (Fase F.1) — mesmo contrato do pgStore/pgEnrichment.js.
    async listProposals(tenantId, productId) {
      return [...enrichmentProposals.values()]
        .filter((p) => p.organizationId === tenantId && p.productId === productId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map(clone);
    },
    async getPendingProposal(tenantId, productId) {
      const row = [...enrichmentProposals.values()].find((p) => p.organizationId === tenantId && p.productId === productId && p.status === 'pending');
      return clone(row) || null;
    },
    async getProposal(tenantId, id) {
      const row = enrichmentProposals.get(id);
      return row && row.organizationId === tenantId ? clone(row) : null;
    },
    async createProposal(tenantId, { productId, provider, proposed, recommendedAngleFamilies, recommendedInteractions,
      fieldNotes, productSnapshotHash, productUpdatedAt, createdBy, providerMeta }) {
      const id = crypto.randomUUID();
      const row = {
        id, organizationId: tenantId, productId, storeId: null, status: 'pending', schemaVersion: 1, provider,
        proposed: clone(proposed), recommendedAngleFamilies: clone(recommendedAngleFamilies || []),
        recommendedInteractions: clone(recommendedInteractions || []), fieldNotes: clone(fieldNotes || {}),
        productSnapshotHash, productUpdatedAt, acceptedFields: null, beforeSemanticContext: null, appliedSemanticContext: null,
        providerMeta: providerMeta ? clone(providerMeta) : null,
        createdBy: createdBy || null, reviewedBy: null, createdAt: now(), reviewedAt: null, updatedAt: now(),
      };
      enrichmentProposals.set(id, row);
      return clone(row);
    },
    async decideEnrichmentProposal(tenantId, proposalId, { decision, acceptedFields = [], reviewedBy }) {
      const prop = enrichmentProposals.get(proposalId);
      if (!prop || prop.organizationId !== tenantId || prop.status !== 'pending') return { error: 'not_found' };

      if (decision === 'rejected') {
        prop.status = 'rejected';
        prop.reviewedBy = reviewedBy || null;
        prop.reviewedAt = now();
        prop.updatedAt = now();
        return { proposal: clone(prop) };
      }

      const produto = own(products, tenantId, prop.productId);
      if (!produto) return { error: 'product_not_found' };
      if (produto.updatedAt !== prop.productUpdatedAt) return { error: 'product_changed', product: clone(produto) };

      const antes = (produto.metadata && produto.metadata.semantic_context) || null;
      let mesclado;
      try {
        mesclado = mergeSemanticContext(antes, prop.proposed, acceptedFields);
      } catch (err) {
        throw err;
      }
      produto.metadata = { ...(produto.metadata || {}), semantic_context: mesclado };
      produto.updatedAt = now();

      prop.status = decision;
      prop.acceptedFields = clone(acceptedFields);
      prop.beforeSemanticContext = antes ? clone(antes) : null;
      prop.appliedSemanticContext = clone(mesclado);
      prop.reviewedBy = reviewedBy || null;
      prop.reviewedAt = now();
      prop.updatedAt = now();
      return { proposal: clone(prop), product: clone(produto), before: antes, after: mesclado };
    },

    async createJob(tenantId, job, jobItems) {
      jobs.set(job.id, { ...clone(job), tenantId, status: 'queued', createdAt: now(), updatedAt: now(), finishedAt: null, cancelledAt: null });
      jobItems.forEach((item) => {
        items.set(item.creativeId, {
          status: 'queued', generationAttempt: 1, infraRetries: 0, nextAttemptAt: Date.now(), plan: null, planSummary: null,
          record: null, error: null, assetId: null, startedAt: null, finishedAt: null,
          ...clone(item), tenantId, jobId: job.id, createdAt: now(), updatedAt: now(),
        });
      });
      return this.getJob(tenantId, job.id);
    },
    async listJobs(tenantId, limit = 30) {
      return [...jobs.values()].filter((j) => j.tenantId === tenantId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit).map(clone);
    },
    async getJob(tenantId, id) {
      const job = jobs.get(id);
      if (!job || job.tenantId !== tenantId) return null;
      const jobItems = [...items.values()].filter((i) => i.jobId === id).sort((a, b) => a.itemIndex - b.itemIndex);
      return { ...clone(job), items: jobItems.map(clone) };
    },
    async refreshJobStatus(tenantId, id) {
      const job = jobs.get(id);
      if (!job || job.tenantId !== tenantId) return null;
      const jobItems = [...items.values()].filter((i) => i.jobId === id);
      job.status = aggregateJobStatus(jobItems, Boolean(job.cancelledAt));
      job.updatedAt = now();
      job.finishedAt = ['completed', 'partial', 'failed', 'cancelled'].includes(job.status) ? now() : null;
      return clone(job);
    },
    async cancelJob(tenantId, id) {
      const job = jobs.get(id);
      if (!job || job.tenantId !== tenantId) return null;
      job.cancelledAt = now();
      for (const item of items.values()) if (item.jobId === id && item.status === 'queued') item.status = 'cancelled';
      return this.refreshJobStatus(tenantId, id);
    },

    async claimNextItem(tenantId, nowMs = Date.now()) {
      const candidato = [...items.values()]
        .filter((i) => i.tenantId === tenantId && i.status === 'queued' && i.nextAttemptAt <= nowMs && !jobs.get(i.jobId).cancelledAt)
        .sort((a, b) => (a.createdAt === b.createdAt ? a.itemIndex - b.itemIndex : a.createdAt < b.createdAt ? -1 : 1))[0];
      if (!candidato) return null;
      candidato.status = 'planning';
      candidato.startedAt = now();
      return clone(candidato);
    },
    async updateItem(tenantId, creativeId, patch) {
      const item = items.get(creativeId);
      if (!item || item.tenantId !== tenantId) return null;
      Object.assign(item, clone(patch), { updatedAt: now() });
      return clone(item);
    },
    async getItem(tenantId, creativeId) {
      const item = items.get(creativeId);
      return item && item.tenantId === tenantId ? clone(item) : null;
    },
    async retryItem(tenantId, jobId, creativeId) {
      const item = items.get(creativeId);
      const job = jobs.get(jobId);
      if (!item || !job || item.tenantId !== tenantId || item.jobId !== jobId || item.status !== 'failed' || job.cancelledAt) return null;
      Object.assign(item, {
        status: 'queued', generationAttempt: item.generationAttempt + 1, infraRetries: 0, nextAttemptAt: Date.now(),
        error: null, finishedAt: null, updatedAt: now(),
      });
      await this.refreshJobStatus(tenantId, jobId);
      return clone(item);
    },
    async requeueStuck(tenantId) {
      let n = 0;
      for (const item of items.values()) {
        if (item.tenantId === tenantId && ['planning', 'generating', 'processing'].includes(item.status)) {
          item.status = 'queued';
          n += 1;
        }
      }
      return n;
    },

    async insertAsset(tenantId, asset) {
      assets.set(asset.id, { ...clone(asset), tenantId, createdAt: now() });
    },
    async getAssetByCreative(tenantId, creativeId) {
      return clone([...assets.values()].find((a) => a.tenantId === tenantId && a.creativeId === creativeId)) || null;
    },

    async upsertFeedback(tenantId, { userId, storeId = null, creativeId, jobId, verdict, snapshot }) {
      const key = `${tenantId}|${creativeId}|${userId}`;
      const previous = feedback.get(key);
      const row = {
        id: previous ? previous.id : `${feedback.size + 1}`, tenantId, storeId, creativeId, jobId, userId, verdict,
        snapshot: clone(snapshot), createdAt: previous ? previous.createdAt : now(), updatedAt: now(),
      };
      feedback.set(key, row);
      return clone(row);
    },
    async deleteFeedback(tenantId, userId, creativeId) {
      return feedback.delete(`${tenantId}|${creativeId}|${userId}`);
    },
    async getFeedback(tenantId, userId, creativeId) {
      return clone(feedback.get(`${tenantId}|${creativeId}|${userId}`)) || null;
    },
    async feedbackByCreative(tenantId, userId, creativeIds) {
      const out = new Map();
      for (const id of creativeIds) {
        const row = feedback.get(`${tenantId}|${id}|${userId}`);
        if (row) out.set(id, { verdict: row.verdict, updatedAt: row.updatedAt });
      }
      return out;
    },
    async feedbackSummary(tenantId, { by, storeId = null }) {
      if (by !== 'product' && !FEEDBACK_DIMENSIONS[by]) throw new Error('dimensão de feedback desconhecida');
      const grupos = new Map();
      for (const row of feedback.values()) {
        if (row.tenantId !== tenantId || (storeId && row.storeId && row.storeId !== storeId)) continue;
        const chaves = by === 'product' ? (row.snapshot.product_ids || []) : [FEEDBACK_DIMENSIONS[by](row.snapshot)].filter(Boolean);
        for (const key of chaves) {
          const g = grupos.get(key) || { key, liked: 0, disliked: 0, total: 0 };
          g[row.verdict] += 1;
          g.total += 1;
          grupos.set(key, g);
        }
      }
      return [...grupos.values()].sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
    },

    // Ângulos customizados (Fase D) — mesmo contrato do pgStore.
    async listAngles(tenantId, { storeId = null, includeInactive = false } = {}) {
      return [...angles.values()]
        .filter((a) => a.organizationId === tenantId && (includeInactive || a.active)
          && (a.storeId === null || (storeId && a.storeId === storeId)))
        .sort((a, b) => (a.name < b.name ? -1 : 1)).map(clone);
    },
    async getAngle(tenantId, id) {
      const row = angles.get(id);
      return row && row.organizationId === tenantId ? clone(row) : null;
    },
    async createAngle(tenantId, { storeId = null, slug, name, description, family, peopleMode, preset, definition,
      allowedInteractions, allowedProductModes, defaultGaze, createdBy }) {
      const scope = storeId ? 'store' : 'organization';
      const clash = [...angles.values()].some((a) => a.organizationId === tenantId && a.storeId === storeId && a.slug === slug);
      if (clash) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
      const id = crypto.randomUUID();
      const row = {
        id, organizationId: tenantId, storeId, scope, slug, name, description: description || null, family,
        peopleMode, preset: preset || null, definition: definition || {},
        allowedInteractions: allowedInteractions || null, allowedProductModes: allowedProductModes || null, defaultGaze: defaultGaze || null,
        active: true, version: 1, createdBy: createdBy || null, createdAt: now(), updatedAt: now(),
      };
      angles.set(id, row);
      return clone(row);
    },
    async updateAngle(tenantId, id, patch) {
      const row = angles.get(id);
      if (!row || row.organizationId !== tenantId) return null;
      for (const key of ['name', 'description', 'family', 'peopleMode', 'preset', 'definition', 'allowedInteractions', 'allowedProductModes', 'defaultGaze', 'active']) {
        if (patch[key] !== undefined) row[key] = patch[key];
      }
      row.version += 1;
      row.updatedAt = now();
      return clone(row);
    },
    async archiveAngle(tenantId, id) {
      const row = angles.get(id);
      if (!row || row.organizationId !== tenantId || !row.active) return false;
      row.active = false;
      row.version += 1;
      row.updatedAt = now();
      return true;
    },

    async listHistory(tenantId, limit = 50) {
      return [...items.values()]
        .filter((i) => i.tenantId === tenantId && (i.status === 'completed' || i.status === 'failed'))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, limit).map(clone);
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

module.exports = { createMemoryStore, PROFILE_KINDS };
