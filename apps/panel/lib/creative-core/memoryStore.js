'use strict';

// Store em memória com o mesmo contrato do pgStore. Usado pelos testes (test/creative-core.test.js) — nunca em produção:
// o módulo exige Postgres (sem DATABASE_URL as rotas respondem 503).

const { aggregateJobStatus } = require('./status');

const PROFILE_KINDS = ['brand', 'niche', 'context', 'persona'];

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
