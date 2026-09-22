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
const { promptVersionFor, planSchemaVersionFor } = require('../lib/creative-core/rollout');
const { mapDraftToForm } = require('../lib/creative-core/draft');
const { FAMILIES: ANGLE_FAMILIES, PEOPLE_MODES: ANGLE_PEOPLE_MODES } = require('../lib/creative-core/pgAngles');

const PROFILE_CONTRACT = { brand: 'BrandKit', niche: 'NicheKit', context: 'ContextProfile', persona: 'Persona' };
const PROFILE_PATH = { brand: 'brand-kits', niche: 'niche-kits', context: 'context-profiles', persona: 'personas' };
const CONTEXT_STATUS = ['draft', 'approved', 'rejected'];
// Prévia planeja cada combinação ângulo × formato para mostrar o prompt; limita para não travar a tela.
const PREVIEW_PROMPTS_MAX = 12;
const PREVIEW_CONCORRENCIA = 4;
const FEEDBACK_VERDICTS = ['liked', 'disliked'];
const FEEDBACK_DIMENSIONS = ['angle', 'objective', 'context', 'interaction', 'composition', 'product'];
const ANGLE_SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,59}$/;
const ANGLE_INTERACTION_RE = /^[a-z_]{2,40}$/;
const ANGLE_PRODUCT_MODES = ['single_product', 'multi_product'];
const ANGLE_GAZE_MODES = ['camera', 'interaction', 'off_camera', 'product'];
const ANGLE_DEFINITION_TEXT_FIELDS = ['framing', 'photographic_direction', 'lighting', 'composition'];

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

// `feedback` = o veredito da PESSOA da sessão sobre este criativo ({ verdict, updatedAt }) ou null. Nunca o de outra pessoa.
function resumoItem(item, feedback = null) {
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
    planSchemaVersion: item.planSchemaVersion,
    compilerVersion: item.compilerVersion,
    summary: item.planSummary,
    error: item.error,
    // Trace da tentativa mais recente (sem prompt e sem chave): modelo pedido x servido, referências, duração.
    trace: ultimoTrace(item),
    assetUrl: item.assetId ? `/api/admin/criativos/assets/${item.creativeId}` : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    feedback,
  };
}

function resumoJob(job, feedbacks = new Map()) {
  const base = {
    id: job.id, engine: job.engine, productMode: job.productMode, status: job.status, total: job.total,
    createdAt: job.createdAt, updatedAt: job.updatedAt, finishedAt: job.finishedAt, cancelledAt: job.cancelledAt,
  };
  if (job.items) {
    base.progress = progress(job.items);
    base.items = job.items.map((item) => resumoItem(item, feedbacks.get(item.creativeId) || null));
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
  // Pessoa e Store da request. A pessoa vem da sessão (requireAdmin → req.auth), nunca do corpo. A Store é a do contexto
  // quando há uma resolvida; sem ela o feedback nasce compartilhado (store_id nulo).
  const usuarioDe = (req) => (req.auth && typeof req.auth.userId === 'string' ? req.auth.userId : null);
  const storeAtual = () => {
    try { return (typeof deps.storeAtual === 'function' && deps.storeAtual()) || null; } catch { return null; }
  };
  const feedbacksDe = async (req, itens) => {
    const userId = usuarioDe(req);
    if (!userId || typeof store.feedbackByCreative !== 'function') return new Map();
    return store.feedbackByCreative(req.creativeTenant, userId, itens.map((i) => i.creativeId));
  };
  const exigirPessoa = (req, res, next) => (usuarioDe(req) ? next() : res.status(403).json({ error: 'pessoa não identificada na sessão' }));

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

  // ── Angles V2 (Fase D): ângulos customizados de Organization/Store ───────────────────────────────────────────
  // System fica no catálogo do core (GET /catalog → catalog.angleFamilies); aqui só a metade tenant-owned.
  function angleForm(body, { parcial = false } = {}) {
    const campos = ['scope', 'slug', 'name', 'description', 'family', 'peopleMode', 'preset', 'definition',
      'allowedInteractions', 'allowedProductModes', 'defaultGaze'];
    for (const key of Object.keys(body || {})) if (!campos.includes(key)) throw new InputError(`campo desconhecido: ${key}`);
    const out = {};
    if (!parcial || body.slug !== undefined) {
      if (!ANGLE_SLUG_RE.test(body.slug || '')) throw new InputError('slug: minúsculas, números, - ou _, 2 a 60 caracteres');
      out.slug = body.slug;
    }
    if (!parcial || body.name !== undefined) {
      if (!body.name || typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) throw new InputError('name: obrigatório (até 120 caracteres)');
      out.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 2000)) throw new InputError('description: até 2000 caracteres');
      out.description = body.description;
    }
    if (!parcial || body.family !== undefined) {
      if (!ANGLE_FAMILIES.includes(body.family)) throw new InputError(`family: use ${ANGLE_FAMILIES.join(', ')}`);
      out.family = body.family;
    }
    if (!parcial || body.peopleMode !== undefined) {
      if (!ANGLE_PEOPLE_MODES.includes(body.peopleMode)) throw new InputError(`peopleMode: use ${ANGLE_PEOPLE_MODES.join(', ')}`);
      out.peopleMode = body.peopleMode;
    }
    if (body.preset !== undefined) {
      if (body.preset !== null && (typeof body.preset !== 'string' || body.preset.length > 60)) throw new InputError('preset: até 60 caracteres');
      out.preset = body.preset;
    }
    if (body.definition !== undefined) {
      if (typeof body.definition !== 'object' || body.definition === null || Array.isArray(body.definition)) throw new InputError('definition: objeto');
      // Estruturado de propósito (§2 da Fase D.1): campos conhecidos, cada um curto — nunca um prompt livre disfarçado de objeto.
      for (const key of Object.keys(body.definition)) {
        if (![...ANGLE_DEFINITION_TEXT_FIELDS, 'visual_notes'].includes(key)) throw new InputError(`definition: campo desconhecido: ${key}`);
      }
      for (const campo of ANGLE_DEFINITION_TEXT_FIELDS) {
        const v = body.definition[campo];
        if (v !== undefined && (typeof v !== 'string' || v.length > 200)) throw new InputError(`definition.${campo}: até 200 caracteres`);
      }
      if (body.definition.visual_notes !== undefined) {
        const notas = body.definition.visual_notes;
        if (!Array.isArray(notas) || notas.length > 6 || notas.some((n) => typeof n !== 'string' || n.length > 140)) {
          throw new InputError('definition.visual_notes: até 6 notas, cada uma até 140 caracteres');
        }
      }
      out.definition = body.definition;
    }
    if (body.allowedInteractions !== undefined) {
      if (body.allowedInteractions !== null) {
        if (!Array.isArray(body.allowedInteractions) || !body.allowedInteractions.every((i) => ANGLE_INTERACTION_RE.test(i))) {
          throw new InputError('allowedInteractions: lista de ids de interação');
        }
      }
      out.allowedInteractions = body.allowedInteractions;
    }
    if (body.allowedProductModes !== undefined) {
      if (body.allowedProductModes !== null) {
        if (!Array.isArray(body.allowedProductModes) || !body.allowedProductModes.every((m) => ANGLE_PRODUCT_MODES.includes(m))) {
          throw new InputError(`allowedProductModes: use ${ANGLE_PRODUCT_MODES.join(', ')}`);
        }
      }
      out.allowedProductModes = body.allowedProductModes;
    }
    if (body.defaultGaze !== undefined) {
      if (body.defaultGaze !== null && !ANGLE_GAZE_MODES.includes(body.defaultGaze)) throw new InputError(`defaultGaze: use ${ANGLE_GAZE_MODES.join(', ')}`);
      out.defaultGaze = body.defaultGaze;
    }
    return out;
  }

  router.get('/angles', exigirStore, exigirModulo, rota(async (req, res) => {
    const contratos = await core.contracts();
    const storeId = storeAtual();
    const todas = await store.listAngles(req.creativeTenant, { storeId });
    res.json({
      system: contratos.catalog.angle_families || [],
      organization: todas.filter((a) => a.scope === 'organization'),
      store: storeId ? todas.filter((a) => a.scope === 'store' && a.storeId === storeId) : [],
    });
  }));

  router.post('/angles', exigirStore, exigirModulo, rota(async (req, res) => {
    const corpo = req.body || {};
    if (!['organization', 'store'].includes(corpo.scope)) throw new InputError('scope: use organization ou store');
    const dados = angleForm(corpo);
    let storeId = null;
    if (corpo.scope === 'store') {
      storeId = storeAtual();
      if (!storeId) throw new InputError('scope store: nenhuma Store resolvida no contexto');
    }
    try {
      const criado = await store.createAngle(req.creativeTenant, { ...dados, storeId, createdBy: usuarioDe(req) });
      res.status(201).json(criado);
    } catch (err) {
      if (err && (err.code === '23505' || /unique constraint/i.test(err.message || ''))) {
        throw new InputError(`slug já usado neste escopo: ${dados.slug}`);
      }
      throw err;
    }
  }));

  router.put('/angles/:id', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new InputError('id inválido');
    const existente = await store.getAngle(req.creativeTenant, req.params.id);
    if (!existente) return res.status(404).json({ error: 'ângulo não encontrado' });
    const corpo = { ...(req.body || {}) };
    delete corpo.scope; // escopo não muda depois de criado — outro ângulo, se for o caso
    const dados = angleForm(corpo, { parcial: true });
    const atualizado = await store.updateAngle(req.creativeTenant, req.params.id, dados);
    res.json(atualizado);
  }));

  router.delete('/angles/:id', exigirStore, exigirModulo, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.id)) throw new InputError('id inválido');
    const apagado = await store.archiveAngle(req.creativeTenant, req.params.id);
    if (!apagado) return res.status(404).json({ error: 'ângulo não encontrado ou já inativo' });
    res.json({ id: req.params.id, active: false });
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
    const items = await buildRequests(input, { store, tenantId: req.creativeTenant, hints, promptVersion: promptVersionFor(env, req.creativeTenant), planSchemaVersion: planSchemaVersionFor(env, req.creativeTenant) });
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
    res.json(resumoJob(job, await feedbacksDe(req, job.items || [])));
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
    const itens = await store.listHistory(req.creativeTenant, limit);
    const feedbacks = await feedbacksDe(req, itens);
    res.json({ items: itens.map((i) => ({ ...resumoItem(i, feedbacks.get(i.creativeId) || null), record: i.record })) });
  }));

  // ── Gostei / Não gostei ────────────────────────────────────────────────────────────────────────────────────────
  // Um veredito por pessoa e criativo (trocar = upsert; limpar = DELETE). O snapshot vem do core, calculado do plano
  // persistido: o Node só acrescenta quem, onde, qual lote e quando. Nada disto entra no planner.
  async function itemComPlano(req, creativeId) {
    if (!UUID_RE.test(creativeId)) throw new InputError('id inválido');
    const item = await store.getItem(req.creativeTenant, creativeId);
    if (!item) return { status: 404, error: 'criativo não encontrado' };
    if (!item.plan) return { status: 409, error: 'este criativo ainda não tem plano' };
    return { item };
  }

  router.put('/items/:creativeId/feedback', exigirStore, exigirModulo, exigirPessoa, rota(async (req, res) => {
    const corpo = req.body;
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo) || Object.keys(corpo).some((k) => k !== 'verdict')) throw new InputError('corpo inválido');
    if (!FEEDBACK_VERDICTS.includes(corpo.verdict)) throw new InputError('veredito inválido');
    const achado = await itemComPlano(req, req.params.creativeId);
    if (achado.error) return res.status(achado.status).json({ error: achado.error });
    const { item } = achado;
    if (item.status !== 'completed') return res.status(409).json({ error: 'só dá para avaliar um criativo já gerado' });
    const asset = await store.getAssetByCreative(req.creativeTenant, item.creativeId);
    const trace = ultimoTrace(item);
    const snapshot = await core.feedbackSnapshot({
      plan: item.plan, resultMetadata: trace ? { trace } : undefined, assetSha256: asset ? asset.sha256 : undefined,
    });
    const salvo = await store.upsertFeedback(req.creativeTenant, {
      userId: usuarioDe(req), storeId: storeAtual(), creativeId: item.creativeId, jobId: item.jobId, verdict: corpo.verdict, snapshot,
    });
    res.json({ creativeId: item.creativeId, verdict: salvo.verdict, updatedAt: salvo.updatedAt });
  }));

  router.delete('/items/:creativeId/feedback', exigirStore, exigirModulo, exigirPessoa, rota(async (req, res) => {
    if (!UUID_RE.test(req.params.creativeId)) throw new InputError('id inválido');
    await store.deleteFeedback(req.creativeTenant, usuarioDe(req), req.params.creativeId); // idempotente: limpar o que não existe é ok
    res.json({ creativeId: req.params.creativeId, verdict: null });
  }));

  // Aprovação por dimensão, só leitura. Contagem por ângulo, objetivo, contexto, interação, composição ou produto — a base
  // para consultas futuras. Não é ranking e nada aqui é lido pelo planner.
  router.get('/feedback/summary', exigirStore, exigirModulo, rota(async (req, res) => {
    const by = String(req.query.by || '');
    if (!FEEDBACK_DIMENSIONS.includes(by)) throw new InputError(`by: use ${FEEDBACK_DIMENSIONS.join(', ')}`);
    const escopo = req.query.scope === undefined ? 'store' : String(req.query.scope);
    if (!['store', 'organization'].includes(escopo)) throw new InputError('scope: use store ou organization');
    const storeId = escopo === 'store' ? storeAtual() : null;
    res.json({ by, scope: storeId ? 'store' : 'organization', items: await store.feedbackSummary(req.creativeTenant, { by, storeId }) });
  }));

  // ── Copiar dados ───────────────────────────────────────────────────────────────────────────────────────────────
  router.get('/items/:creativeId/draft', exigirStore, exigirModulo, rota(async (req, res) => {
    const achado = await itemComPlano(req, req.params.creativeId);
    if (achado.error) return res.status(achado.status).json({ error: achado.error });
    const { item } = achado;
    const draft = await core.draft(item.plan);
    const job = await store.getJob(req.creativeTenant, item.jobId);
    const mapeado = await mapDraftToForm(draft, { store, tenantId: req.creativeTenant, jobInput: job && job.input && job.input.context ? { context: job.input.context } : null });
    // A cena com pessoas/interação e os sorteios só valem nos planos/prompts v2. Se a conta não os tem, avise em vez de
    // deixar o POST /jobs falhar depois: o `draft` inteiro continua na resposta, nada é perdido.
    const { form, actions, unavailable, warnings } = mapeado;
    if ((form.subjects || form.interaction) && planSchemaVersionFor(env, req.creativeTenant) !== 2) {
      unavailable.push({ field: 'subjects', id: null, reason: 'plan_v2_not_enabled' });
      delete form.subjects;
      delete form.interaction;
    }
    if (form.custom_angle_preview && planSchemaVersionFor(env, req.creativeTenant) !== 2) {
      unavailable.push({ field: 'custom_angle', id: form.custom_angle_preview.id, reason: 'plan_v2_not_enabled' });
      delete form.custom_angle_preview;
      delete form.custom_angle_replay_of;
      form.angle_ids = [draft.angle_id];
    }
    if ((actions.again.scene_picks) && (promptVersionFor(env, req.creativeTenant) !== 2 || planSchemaVersionFor(env, req.creativeTenant) !== 2)) {
      unavailable.push({ field: 'scene_picks', id: null, reason: 'prompt_v2_not_enabled' });
      delete actions.again.scene_picks;
    }
    res.json({ creativeId: item.creativeId, jobId: item.jobId, ...mapeado, warnings, draft });
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
