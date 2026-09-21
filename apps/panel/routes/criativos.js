'use strict';

// Rotas do Gerador de Criativos (Oria) — /api/admin/criativos/*. Tudo do módulo mora aqui e em lib/creative-core/;
// server.js só chama montarCriativos(app, deps).
//
// Seguro por padrão:
//   - todas as rotas exigem requireAdmin; flags creative_* desligadas por default (lib/creative-core/flags.js);
//   - sem Postgres, sem CREATIVE_CORE_URL/token ou com o serviço Python fora do ar → 503, nunca crash;
//   - tenant_id = Organization autenticada da request (deps.tenantAtual, Fase 3 · INV-22), nunca do request nem de env;
//   - OpenAI key nunca é devolvida, logada nem gravada em job/erro;
//   - o texto do prompt só sai na prévia (para testar a arte no ChatGPT antes do lote); lotes, histórico e logs
//     guardam só resumo + sha256.

const crypto = require('crypto');
const express = require('express');

const { createCoreClient, CoreUnavailableError, CoreRequestError } = require('../lib/creative-core/client');
const { resolveFlags, enabledEngines, checkEngineAccess, FLAGS } = require('../lib/creative-core/flags');
const { createByok, cofreDeStore, testarChave } = require('../lib/creative-core/byok');
const { createStorage, UUID_RE, TENANT_RE } = require('../lib/creative-core/storage');
const { criarObservadorLeituraLegada } = require('../lib/creative-core/leitura-legada');
const { createPgStore } = require('../lib/creative-core/pgStore');
const { normalizeJobInput, buildRequests, planSummary, planPrompt, InputError } = require('../lib/creative-core/requests');
const { createWorker } = require('../lib/creative-core/worker');
const { progress } = require('../lib/creative-core/status');
const { promptVersionFor } = require('../lib/creative-core/rollout');

const PROFILE_CONTRACT = { brand: 'BrandKit', niche: 'NicheKit', context: 'ContextProfile', persona: 'Persona' };
const PROFILE_PATH = { brand: 'brand-kits', niche: 'niche-kits', context: 'context-profiles', persona: 'personas' };
const CONTEXT_STATUS = ['draft', 'approved', 'rejected'];
// Prévia planeja cada combinação ângulo × formato para mostrar o prompt; limita para não travar a tela.
const PREVIEW_PROMPTS_MAX = 12;
const PREVIEW_CONCORRENCIA = 4;

function responderErro(res, err, logger) {
  if (err instanceof CoreUnavailableError) {
    return res.status(503).json({ error: 'serviço do gerador de criativos indisponível', code: err.code });
  }
  if (err instanceof CoreRequestError) {
    return res.status(err.httpStatus).json({ error: err.message, code: err.code, details: err.details });
  }
  if (err instanceof InputError || (err && err.httpStatus && err.httpStatus < 500)) {
    return res.status(err.httpStatus).json({ error: err.message });
  }
  logger.error(`[CRIATIVOS] erro na rota: ${err && err.name}`);
  return res.status(500).json({ error: 'erro interno no gerador de criativos' });
}

function ultimoTrace(item) {
  const porTentativa = item.generationTrace;
  if (!porTentativa || typeof porTentativa !== 'object') return null;
  return porTentativa[String(item.generationAttempt)] || null;
}

function resumoItem(item) {
  return {
    creativeId: item.creativeId,
    itemIndex: item.itemIndex,
    status: item.status,
    generationAttempt: item.generationAttempt,
    angle: item.angle,
    placement: item.placement,
    engine: item.engine,
    productMode: item.productMode,
    productIds: item.productIds,
    funnelStage: item.funnelStage,
    remarketingIntent: item.remarketingIntent,
    persona: item.persona,
    contextId: item.contextId,
    quality: item.quality,
    brandKitVersion: item.brandKitVersion,
    nicheKitVersion: item.nicheKitVersion,
    promptVersion: item.promptVersion,
    summary: item.planSummary,
    error: item.error,
    // Trace da tentativa mais recente (sem prompt e sem chave): modelo pedido x servido, referências, duração.
    trace: ultimoTrace(item),
    assetUrl: item.assetId ? `/api/admin/criativos/assets/${item.creativeId}` : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function resumoJob(job) {
  const base = {
    id: job.id, engine: job.engine, productMode: job.productMode, status: job.status, total: job.total,
    createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt, cancelledAt: job.cancelledAt,
  };
  if (job.items) {
    base.progress = progress(job.items);
    base.items = job.items.map(resumoItem);
  }
  return base;
}

// deps: { requireAdmin, tenantAtual, paraCadaTenant, pgPool, lerEntitlements, cofreOpenAi | (encriptarSegredo, descriptografarSegredo),
//         uploadsDir, leituraLegada?, env?, store?, core?, fetchImpl?, logger?, startWorker? }
// leituraLegada: null (padrão) ou { de, organizationId } de lerLeituraLegada(env) — OPS-22, temporário.
function criarRouterCriativos(deps) {
  const env = deps.env || process.env;
  const logger = deps.logger || console;
  if (typeof deps.tenantAtual !== 'function') throw new Error('criativos: tenantAtual obrigatório');
  const store = deps.store || (deps.pgPool ? createPgStore(deps.pgPool) : null);
  const core = deps.core || createCoreClient({ baseUrl: env.CREATIVE_CORE_URL, token: env.CREATIVE_CORE_SERVICE_TOKEN });
  // OPS-22: leitura dupla só com configuração explícita; a storage confere a Organization e confina o caminho.
  const leituraLegada = deps.leituraLegada || null;
  const observadorLegado = criarObservadorLeituraLegada({ logger });
  const storageDe = (tenantId) => createStorage({
    uploadsDir: deps.uploadsDir, tenantId, leituraLegada, aoUsarLegado: observadorLegado.registrar,
  });
  // Produção: cofre = integração 'openai' da Organization (deps.cofreOpenAi). Sem ele (testes), o store.
  const byokDe = (tenantId) => {
    if (typeof deps.cofreOpenAi === 'function') return createByok({ cofre: deps.cofreOpenAi(tenantId) });
    if (!store || typeof store.getSettings !== 'function') return null;
    return createByok({ cofre: cofreDeStore({ store, encrypt: deps.encriptarSegredo, decrypt: deps.descriptografarSegredo, tenantId }) });
  };

  async function flagsAtuais() {
    let entitlements = {};
    try {
      entitlements = (await deps.lerEntitlements()) || {};
    } catch {
      entitlements = {};
    }
    return resolveFlags(entitlements, env.CREATIVE_FEATURE_FLAGS);
  }

  const worker = store && typeof deps.paraCadaTenant === 'function'
    ? createWorker({ store, core, byokDe, storageDe, paraCadaTenant: deps.paraCadaTenant, flagsProvider: flagsAtuais, logger })
    : null;

  const router = express.Router();
  router.use(deps.requireAdmin);
  // Tenant da request = Organization da sessão (já resolvida pelo requireAdmin). Sem ela, nada roda.
  router.use((req, res, next) => {
    let tenant = null;
    try { tenant = String(deps.tenantAtual() || '').toLowerCase(); } catch { tenant = null; }
    if (!tenant || !TENANT_RE.test(tenant)) {
      return res.status(403).json({ error: 'organization não resolvida', codigo: 'TENANT_CONTEXT_REQUIRED' });
    }
    req.creativeTenant = tenant;
    req.creativeStorage = storageDe(tenant);
    req.creativeByok = byokDe(tenant);
    return next();
  });

  // Guardas: Postgres obrigatório e módulo habilitado (status e catálogo ficam acessíveis pra UI explicar o estado).
  const exigirStore = (req, res, next) => (store ? next() : res.status(503).json({ error: 'o gerador de criativos exige Postgres (DATABASE_URL)' }));
  const exigirModulo = async (req, res, next) => {
    const flags = await flagsAtuais();
    if (!flags.creative_generator) return res.status(403).json({ error: 'o gerador de criativos não está habilitado nesta conta' });
    req.creativeFlags = flags;
    return next();
  };
  const rota = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => responderErro(res, err, logger));

  router.get('/status', rota(async (req, res) => {
    const flags = await flagsAtuais();
    let coreStatus = { configured: core.configured, reachable: false, versions: null };
    if (core.configured) {
      try {
        const health = await core.health();
        coreStatus = { configured: true, reachable: true, versions: health.versions };
      } catch {
        coreStatus = { configured: true, reachable: false, versions: null };
      }
    }
    res.json({
      flags,
      flagNames: FLAGS,
      engines: enabledEngines(flags),
      postgres: Boolean(store),
      core: coreStatus,
      openaiKey: store ? await req.creativeByok.status() : { configured: false, last4: null, updatedAt: null },
    });
  }));

  router.get('/catalog', rota(async (req, res) => {
    const contratos = await core.contracts();
    const flags = await flagsAtuais();
    res.json({
      engines: enabledEngines(flags),
      productModes: contratos.product_modes,
      multiProductRules: contratos.multi_product_rules,
      compatibilityMatrix: contratos.compatibility_matrix,
      catalog: contratos.catalog,
      versions: contratos.versions,
    });
  }));

  // ── BYOK ────────────────────────────────────────────────────────────────
  router.get('/settings/openai-key', exigirStore, exigirModulo, rota(async (req, res) => res.json(await req.creativeByok.status())));
  router.put('/settings/openai-key', exigirStore, exigirModulo, rota(async (req, res) => {
    const apiKey = req.body && req.body.apiKey;
    res.json(await req.creativeByok.save(apiKey));
  }));
  router.delete('/settings/openai-key', exigirStore, exigirModulo, rota(async (req, res) => {
    await req.creativeByok.remove();
    res.json({ configured: false, last4: null });
  }));
  router.post('/settings/openai-key/test', exigirStore, exigirModulo, rota(async (req, res) => {
    const apiKey = await req.creativeByok.resolve();
    res.json(await testarChave(apiKey, deps.fetchImpl));
  }));

  // ── Kits, contextos e personas (validados pelo contrato do core antes de salvar) ─────────
  for (const kind of Object.keys(PROFILE_PATH)) {
    const base = `/${PROFILE_PATH[kind]}`;

    router.get(base, exigirStore, exigirModulo, rota(async (req, res) => {
      res.json({ items: await store.listProfiles(kind, req.creativeTenant) });
    }));

    const salvar = (criando) => rota(async (req, res) => {
      const body = req.body || {};
      if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) throw new InputError('data: objeto obrigatório');
      if (!criando && !UUID_RE.test(req.params.id)) throw new InputError('id inválido');
      const id = criando ? crypto.randomUUID() : req.params.id;
      let status = kind === 'context' ? body.status || 'draft' : 'active';
      if (kind === 'context' && !CONTEXT_STATUS.includes(status)) throw new InputError('status inválido');

      const atual = criando ? null : await store.getProfile(kind, req.creativeTenant, id);
      if (!criando && !atual) return res.status(404).json({ error: 'registro não encontrado' });
      const version = atual ? atual.version + 1 : 1;
      // Campos de identidade/versão são sempre do servidor.
      let payload = { ...body.data };
      if (kind === 'brand' || kind === 'niche') payload = { ...payload, id, schemaVersion: 1, version };
      if (kind === 'context') payload = { ...payload, contextId: id, status, schemaVersion: 1, promptVersion: 1, profileVersion: version };
      if (kind === 'persona') payload = { ...payload, id, source: 'custom' };

      const validacao = await core.validate(PROFILE_CONTRACT[kind], payload);
      // As mensagens do core têm só caminho do campo + motivo, nunca valores (seguro para mostrar na tela).
      if (!validacao.valid) {
        return res.status(422).json({ error: `dados inválidos: ${validacao.errors.slice(0, 5).join('; ')}`, details: { errors: validacao.errors } });
      }

      const semIdentidade = { ...payload };
      delete semIdentidade.id; delete semIdentidade.contextId; delete semIdentidade.schemaVersion;
      delete semIdentidade.version; delete semIdentidade.promptVersion; delete semIdentidade.profileVersion;
      delete semIdentidade.status; delete semIdentidade.source;
      const row = criando
        ? await store.createProfile(kind, req.creativeTenant, { id, data: semIdentidade, status })
        : await store.updateProfile(kind, req.creativeTenant, id, { data: semIdentidade, status });
      res.status(criando ? 201 : 200).json(row);
    });

    router.post(base, exigirStore, exigirModulo, salvar(true));
    router.put(`${base}/:id`, exigirStore, exigirModulo, salvar(false));
    router.delete(`${base}/:id`, exigirStore, exigirModulo, rota(async (req, res) => {
      if (!UUID_RE.test(req.params.id)) throw new InputError('id inválido');
      const ok = await store.archiveProfile(kind, req.creativeTenant, req.params.id);
      res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'registro não encontrado' });
    }));
  }

  // ── Produtos ─────────────────────────────────────────────────────────────
  router.get('/products', exigirStore, exigirModulo, rota(async (req, res) => {
    const items = await store.listProducts(req.creativeTenant);
    res.json({ items: items.map((p) => ({ ...p, references: (p.references || []).map((r) => ({ mime: r.mime, sizeBytes: r.sizeBytes })) })) });
  }));
  router.post('/products', exigirStore, exigirModulo, rota(async (req, res) => {
    const b = req.body || {};
    const permitidos = new Set(['name', 'type', 'description', 'metadata', 'images']);
    for (const key of Object.keys(b)) if (!permitidos.has(key)) throw new InputError(`campo desconhecido: ${key}`);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const type = typeof b.type === 'string' ? b.type.trim() : '';
    if (!name || name.length > 200) throw new InputError('nome: obrigatório (até 200 caracteres)');
    if (!type || type.length > 120) throw new InputError('tipo: obrigatório (até 120 caracteres)');
    if (b.description !== undefined && (typeof b.description !== 'string' || b.description.length > 2000)) throw new InputError('descrição inválida');
    const metadata = {};
    if (b.metadata !== undefined) {
      if (!b.metadata || typeof b.metadata !== 'object' || Array.isArray(b.metadata)) throw new InputError('metadata inválida');
      for (const key of ['city', 'state']) if (b.metadata[key]) metadata[key] = String(b.metadata[key]).slice(0, key === 'state' ? 2 : 120);
    }
    if (!Array.isArray(b.images) || b.images.length < 1 || b.images.length > 4) throw new InputError('envie de 1 a 4 imagens de referência');
    const id = crypto.randomUUID();
    const references = b.images.map((img) => req.creativeStorage.saveProductReference(id, img && img.data_base64));
    const row = await store.createProduct(req.creativeTenant, { id, name, type, description: b.description, metadata, references });
    res.status(201).json({ ...row, references: references.map((r) => ({ mime: r.mime, sizeBytes: r.sizeBytes })) });
  }));
  // Foto de referência do produto (1 = primeira), para o lojista anexar no ChatGPT na ordem que o prompt da prévia cita.
  router.get('/products/:id/references/:n', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.id) || !/^[1-9][0-9]?$/.test(req.params.n)) throw new InputError('id inválido');
    const produto = await store.getProduct(req.creativeTenant, req.params.id);
    const referencia = produto && (produto.references || [])[Number(req.params.n) - 1];
    if (!referencia) return res.status(404).json({ error: 'imagem não encontrada' });
    const buf = req.creativeStorage.readProductReference(referencia.ref);
    res.set('Cache-Control', 'private, max-age=3600');
    res.type(referencia.mime || 'application/octet-stream').send(buf);
  }));
  router.delete('/products/:id', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new InputError('id inválido');
    const ok = await store.archiveProduct(req.creativeTenant, req.params.id);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'produto não encontrado' });
  }));

  // ── Prévia e lotes ───────────────────────────────────────────────────────
  async function prepararLote(req) {
    const input = normalizeJobInput(req.body);
    const bloqueio = checkEngineAccess(req.creativeFlags, input.engine, input.product_mode);
    if (bloqueio) {
      const e = new Error(bloqueio);
      e.httpStatus = 403;
      throw e;
    }
    const hints = await store.recentHints(req.creativeTenant);
    const items = await buildRequests(input, { store, tenantId: req.creativeTenant, hints, promptVersion: promptVersionFor(env, req.creativeTenant) });
    return { input, items };
  }

  router.post('/preview', exigirStore, exigirModulo, rota(async (req, res) => {
    const { items } = await prepararLote(req);
    // Um plano (sem custo) por combinação ângulo × formato: quantidade só repete a combinação com outra seed.
    const vistos = new Set();
    const combinacoes = items.filter((item) => {
      const chave = `${item.angle}|${item.placement}`;
      if (vistos.has(chave) || vistos.size >= PREVIEW_PROMPTS_MAX) return false;
      vistos.add(chave);
      return true;
    });
    const planos = [];
    for (let i = 0; i < combinacoes.length; i += PREVIEW_CONCORRENCIA) {
      planos.push(...await Promise.all(combinacoes.slice(i, i + PREVIEW_CONCORRENCIA).map((item) => core.plan(item.request))));
    }
    const plan = planos[0]; // valida as regras de negócio no core
    res.json({
      total: items.length,
      first: planSummary(plan),
      validations: plan.validations,
      prompts: planos.map(planPrompt),
      promptsOmitidos: new Set(items.map((item) => `${item.angle}|${item.placement}`)).size - planos.length,
    });
  }));

  router.post('/jobs', exigirStore, exigirModulo, rota(async (req, res) => {
    const { input, items } = await prepararLote(req);
    const byokStatus = await req.creativeByok.status();
    if (!byokStatus.configured) return res.status(409).json({ error: 'cadastre a OpenAI API Key em Integrações antes de gerar' });
    await core.plan(items[0].request); // falha rápida: erro de regra volta 422 antes de enfileirar
    const job = await store.createJob(req.creativeTenant, { id: crypto.randomUUID(), engine: input.engine, productMode: input.product_mode, input }, items);
    if (worker) worker.kick();
    res.status(201).json(resumoJob(job));
  }));

  router.get('/jobs', exigirStore, exigirModulo, rota(async (req, res) => {
    res.json({ items: (await store.listJobs(req.creativeTenant, 30)).map(resumoJob) });
  }));
  router.get('/jobs/:id', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new InputError('id inválido');
    const job = await store.getJob(req.creativeTenant, req.params.id);
    if (!job) return res.status(404).json({ error: 'lote não encontrado' });
    res.json(resumoJob(job));
  }));
  router.post('/jobs/:id/cancel', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new InputError('id inválido');
    const job = await store.cancelJob(req.creativeTenant, req.params.id);
    if (!job) return res.status(404).json({ error: 'lote não encontrado' });
    res.json(resumoJob(await store.getJob(req.creativeTenant, req.params.id)));
  }));
  router.post('/jobs/:id/items/:creativeId/retry', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.id) || !UUID_RE.test(req.params.creativeId)) throw new InputError('id inválido');
    const item = await store.retryItem(req.creativeTenant, req.params.id, req.params.creativeId);
    if (!item) return res.status(409).json({ error: 'só é possível tentar de novo um criativo que falhou, em lote não cancelado' });
    if (worker) worker.kick();
    res.json(resumoItem(item));
  }));

  router.get('/history', exigirStore, exigirModulo, rota(async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    res.json({ items: (await store.listHistory(req.creativeTenant, limit)).map((i) => ({ ...resumoItem(i), record: i.record })) });
  }));

  router.get('/assets/:creativeId', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.creativeId)) throw new InputError('id inválido');
    const asset = await store.getAssetByCreative(req.creativeTenant, req.params.creativeId);
    if (!asset) return res.status(404).json({ error: 'asset não encontrado' });
    const buf = req.creativeStorage.readCreativeAsset(asset.storageKey);
    res.set('Cache-Control', 'private, max-age=3600');
    res.type('png').send(buf);
  }));

  router.post('/copies', exigirStore, exigirModulo, rota(async (req, res) => {
    const { items } = await prepararLote(req);
    const apiKey = await req.creativeByok.resolve();
    if (!apiKey) return res.status(409).json({ error: 'cadastre a OpenAI API Key em Integrações antes de gerar' });
    const request = { ...items[0].request, copy: { generate: true } };
    res.json({ variants: await core.copies({ request, apiKey }) });
  }));

  return { router, worker, store, core, leituraLegada: { config: leituraLegada, contagem: observadorLegado.contagem } };
}

// Chamado por server.js. Nunca lança: qualquer falha de montagem vira log e o painel sobe sem o módulo.
function montarCriativos(app, deps) {
  const logger = deps.logger || console;
  try {
    const modulo = criarRouterCriativos(deps);
    app.use('/api/admin/criativos', modulo.router);
    // O schema vem das migrations (1789509900000_creative-core-schema), nunca do boot. O worker só
    // liga quando quem monta chamar `iniciarWorker()` — em server.js, depois da verificação de boot.
    modulo.iniciarWorker = () => {
      if (!deps.pgPool || deps.startWorker === false || !modulo.worker) return Promise.resolve(null);
      return Promise.resolve(modulo.worker.start())
        .catch((err) => logger.error(`[CRIATIVOS] worker não iniciado: ${(err && (err.code || err.name)) || 'erro'}`));
    };
    return modulo;
  } catch (err) {
    logger.error(`[CRIATIVOS] módulo não montado: ${(err && err.name) || 'erro'}`);
    return null;
  }
}

module.exports = { montarCriativos, criarRouterCriativos };
