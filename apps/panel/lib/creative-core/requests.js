'use strict';

// Converte o formulário do painel (1 lote) em N CreativeRequest do core — 1 por ângulo × formato × quantidade.
// Whitelist de campos: qualquer chave desconhecida é rejeitada. tenant/ids de dono vêm sempre do servidor; o request só
// referencia ids de registros do próprio tenant, que são carregados do banco (nunca aceitos inline do navegador).

const crypto = require('crypto');
const { UUID_RE } = require('./storage');

const ENGINES = ['CLEAN_ANGLES', 'REMARKETING', 'FUNNEL_VISUAL'];
const PRODUCT_MODES = ['single_product', 'multi_product'];
const PLACEMENTS = ['FEED_4X5', 'STORY_9X16'];
const QUALITIES = ['low', 'medium', 'high'];
const FUNNEL_STAGES = ['TOFU', 'MOFU', 'BOFU'];
const PERSONA_MODES = ['automatic', 'custom', 'none'];
const CONTEXT_MODES = ['automatic', 'geographic', 'niche', 'custom'];
const ANGLE_RE = /^[A-Z_]{3,40}$/;
const KIT_ID_RE = /^[a-z0-9_-]{1,60}$/;
const MAX_ITEMS_PER_JOB = 40;

const INPUT_KEYS = new Set([
  'engine', 'product_mode', 'product_ids', 'angle_ids', 'placements', 'quantity', 'brand', 'niche', 'persona',
  'context', 'funnel_stage', 'funnel', 'remarketing', 'copy', 'quality',
]);

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.httpStatus = 400;
  }
}

function exigir(cond, mensagem) {
  if (!cond) throw new InputError(mensagem);
}

function listaDe(valor, { min, max, validar }, nome) {
  exigir(Array.isArray(valor) && valor.length >= min && valor.length <= max, `${nome}: informe de ${min} a ${max} itens`);
  exigir(new Set(valor).size === valor.length, `${nome}: itens repetidos`);
  valor.forEach((v) => exigir(validar(v), `${nome}: valor inválido`));
  return valor;
}

function objetoSimples(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Validação estrutural do formulário. As regras de negócio (limites por motor, intenção x multipeça, overlay em
// Ângulos Limpos) são do core — o painel não duplica essas regras, só repassa e mostra o erro seguro devolvido.
function normalizeJobInput(raw) {
  exigir(objetoSimples(raw), 'corpo inválido');
  for (const key of Object.keys(raw)) exigir(INPUT_KEYS.has(key), `campo desconhecido: ${key}`);
  const input = {
    engine: raw.engine,
    product_mode: raw.product_mode,
    product_ids: listaDe(raw.product_ids, { min: 1, max: 6, validar: (v) => UUID_RE.test(v) }, 'produtos'),
    angle_ids: listaDe(raw.angle_ids, { min: 1, max: 13, validar: (v) => ANGLE_RE.test(v) }, 'ângulos'),
    placements: listaDe(raw.placements, { min: 1, max: 2, validar: (v) => PLACEMENTS.includes(v) }, 'formatos'),
    quantity: raw.quantity === undefined ? 1 : raw.quantity,
    quality: raw.quality || 'medium',
  };
  exigir(ENGINES.includes(input.engine), 'motor inválido');
  exigir(PRODUCT_MODES.includes(input.product_mode), 'modo de produto inválido');
  exigir(Number.isInteger(input.quantity) && input.quantity >= 1 && input.quantity <= 5, 'quantidade: 1 a 5');
  exigir(QUALITIES.includes(input.quality), 'qualidade inválida');
  const total = input.angle_ids.length * input.placements.length * input.quantity;
  exigir(total <= MAX_ITEMS_PER_JOB, `o lote passaria de ${MAX_ITEMS_PER_JOB} criativos (${total})`);

  exigir(objetoSimples(raw.brand), 'marca: obrigatória');
  exigir(['profile', 'builtin'].includes(raw.brand.source), 'marca: origem inválida');
  exigir(raw.brand.source === 'profile' ? UUID_RE.test(raw.brand.id) : KIT_ID_RE.test(raw.brand.id), 'marca: id inválido');
  input.brand = { source: raw.brand.source, id: raw.brand.id };

  if (raw.niche) {
    exigir(objetoSimples(raw.niche) && ['profile', 'builtin'].includes(raw.niche.source), 'nicho: origem inválida');
    exigir(raw.niche.source === 'profile' ? UUID_RE.test(raw.niche.id) : KIT_ID_RE.test(raw.niche.id), 'nicho: id inválido');
    input.niche = { source: raw.niche.source, id: raw.niche.id };
  }

  const persona = raw.persona || { mode: 'automatic' };
  exigir(objetoSimples(persona) && PERSONA_MODES.includes(persona.mode), 'persona: modo inválido');
  if (persona.mode === 'custom') exigir(UUID_RE.test(persona.id), 'persona: escolha uma persona cadastrada');
  input.persona = { mode: persona.mode, id: persona.mode === 'custom' ? persona.id : undefined };

  const context = raw.context || { mode: 'automatic' };
  exigir(objetoSimples(context) && CONTEXT_MODES.includes(context.mode), 'contexto: modo inválido');
  input.context = { mode: context.mode };
  if (context.mode === 'custom') {
    exigir(UUID_RE.test(context.profile_id), 'contexto: escolha um perfil de contexto');
    input.context.profile_id = context.profile_id;
  }
  if (context.mode === 'geographic') {
    exigir(typeof context.context_id === 'string' && /^[a-z0-9_]{2,60}$/.test(context.context_id), 'contexto: região inválida');
    exigir(objetoSimples(context.subject) && typeof context.subject.name === 'string', 'contexto: informe a cidade/estado');
    const meta = context.subject.metadata || {};
    input.context.context_id = context.context_id;
    input.context.subject = {
      name: String(context.subject.name).slice(0, 120),
      metadata: { city: String(meta.city || '').slice(0, 120), state: String(meta.state || '').slice(0, 2).toUpperCase() },
    };
  }

  if (raw.funnel_stage !== undefined) {
    exigir(FUNNEL_STAGES.includes(raw.funnel_stage), 'etapa do funil inválida');
    input.funnel_stage = raw.funnel_stage;
  }
  if (raw.funnel !== undefined) {
    exigir(objetoSimples(raw.funnel), 'funil: formato inválido');
    input.funnel = raw.funnel;
  }
  if (raw.remarketing !== undefined) {
    exigir(objetoSimples(raw.remarketing), 'remarketing: formato inválido');
    input.remarketing = raw.remarketing;
  }
  if (raw.copy !== undefined) {
    exigir(objetoSimples(raw.copy) && typeof raw.copy.generate === 'boolean', 'copy: formato inválido');
    input.copy = { generate: raw.copy.generate };
  }
  return input;
}

function kitDoPerfil(row) {
  return { ...row.data, id: row.id, schemaVersion: 1, version: row.version };
}

function produtoDoRegistro(p) {
  const produto = {
    id: p.id,
    name: p.name,
    type: p.type,
    referenceImages: (p.references || []).map((r) => r.ref),
  };
  if (p.description) produto.description = p.description;
  if (p.metadata && Object.keys(p.metadata).length) {
    // Fase B: o significado da estampa (semantic_context) viaja no campo tipado do produto, não dentro de `metadata`.
    // Hoje nada grava isso pela API do painel (a proposta por GPT e a edição com aprovação são da Fase F); o que estiver
    // gravado no registro chega ao core e o core valida o contrato.
    const { semantic_context: semanticContext, ...resto } = p.metadata;
    if (Object.keys(resto).length) produto.metadata = resto;
    if (semanticContext && typeof semanticContext === 'object' && !Array.isArray(semanticContext)) produto.semantic_context = semanticContext;
  }
  return produto;
}

// Carrega do banco tudo que o request referencia (sempre filtrado pelo tenant) e monta os CreativeRequest.
// `promptVersion` (Fase A3): 2 liga o prompt V2 dos ângulos com pessoa para este lote; ausente = padrão do serviço.
// `planSchemaVersion` (Fase B): 2 pede o CreativePlan v2 (compiler novo) para este lote; ausente = padrão do serviço (plano v1).
async function buildRequests(input, { store, tenantId, hints, promptVersion, planSchemaVersion, randomInt = crypto.randomInt, uuid = crypto.randomUUID }) {
  const produtos = [];
  for (const id of input.product_ids) {
    const p = await store.getProduct(tenantId, id);
    exigir(p, 'produto não encontrado');
    exigir((p.references || []).length > 0, `produto "${p.name}" sem imagem de referência`);
    produtos.push(produtoDoRegistro(p));
  }

  const base = {
    strategy: input.engine,
    product_mode: input.product_mode,
    products: produtos,
    quality: input.quality,
    persona_mode: input.persona.mode,
  };

  let brandId;
  if (input.brand.source === 'profile') {
    const row = await store.getProfile('brand', tenantId, input.brand.id);
    exigir(row, 'Brand Kit não encontrado');
    base.brand_kit = kitDoPerfil(row);
    brandId = row.id;
  } else {
    base.brand_kit_id = input.brand.id;
    brandId = input.brand.id;
  }
  if (input.niche && input.niche.source === 'profile') {
    const row = await store.getProfile('niche', tenantId, input.niche.id);
    exigir(row, 'Niche Kit não encontrado');
    base.niche_kit = kitDoPerfil(row);
  } else if (input.niche) {
    base.niche_kit_id = input.niche.id;
  }

  if (input.persona.mode === 'custom') {
    const row = await store.getProfile('persona', tenantId, input.persona.id);
    exigir(row, 'persona não encontrada');
    base.persona = { ...row.data, id: row.id, source: 'custom' };
  }

  if (input.context.mode === 'custom') {
    const row = await store.getProfile('context', tenantId, input.context.profile_id);
    exigir(row, 'perfil de contexto não encontrado');
    base.context = {
      mode: 'custom',
      profile: { ...row.data, contextId: row.id, status: row.status, schemaVersion: 1, promptVersion: 1, profileVersion: row.version },
    };
  } else {
    base.context = { ...input.context };
  }

  if (promptVersion === 2) base.prompt_version = 2;
  if (planSchemaVersion === 2) base.plan_schema_version = 2;
  if (input.funnel_stage) base.funnel_stage = input.funnel_stage;
  if (input.funnel) base.funnel = input.funnel;
  if (input.remarketing) base.remarketing = input.remarketing;
  if (input.copy) base.copy = input.copy;
  if (hints && (hints.recent_scenes?.length || hints.recent_personas?.length)) {
    base.history_hints = {
      recent_scenes: (hints.recent_scenes || []).slice(0, 50),
      recent_personas: (hints.recent_personas || []).slice(0, 50),
    };
  }

  const items = [];
  for (const angle of input.angle_ids) {
    for (const placement of input.placements) {
      for (let n = 0; n < input.quantity; n += 1) {
        const creativeId = uuid();
        items.push({
          creativeId,
          itemIndex: items.length,
          engine: input.engine,
          productMode: input.product_mode,
          productIds: input.product_ids,
          brandId,
          angle,
          placement,
          funnelStage: input.funnel_stage || null,
          remarketingIntent: (input.remarketing && input.remarketing.intent) || null,
          quality: input.quality,
          request: { ...base, creative_id: creativeId, angle_id: angle, placement_id: placement, seed: randomInt(0, 2 ** 31 - 1) },
        });
      }
    }
  }
  return items;
}

// Resumo seguro do plano para UI/histórico: nunca inclui o texto do prompt (conteúdo interno do produto).
function planSummary(plan) {
  return {
    plan_id: plan.plan_id,
    strategy: plan.strategy,
    product_mode: plan.product_mode,
    angle: plan.angle && { id: plan.angle.id, label: plan.angle.label },
    placement: plan.placement && plan.placement.id,
    persona: plan.persona ? plan.persona.label : null,
    scene: plan.context && plan.context.scene,
    context_id: plan.context && plan.context.context_id,
    context_provider: plan.context && plan.context.provider,
    funnel_stage: plan.funnel_stage,
    remarketing_intent: plan.remarketing_intent,
    layout: plan.layout,
    overlay: plan.overlay,
    copy: plan.copy,
    model: plan.model && { model: plan.model.model, quality: plan.model.quality },
    prompt_sha256: plan.prompt && plan.prompt.sha256,
    prompt_version: plan.prompt && plan.prompt.prompt_version,
    versions: plan.versions,
    warnings: plan.warnings,
    // Plano v2 (Fase B): fatos do plano, nunca o texto do prompt. Ausentes em plano v1.
    plan_schema_version: plan.schema_version,
    compiler_version: plan.compiler ? plan.compiler.version : null,
    gaze: plan.scene && plan.scene.gaze ? { mode: plan.scene.gaze.mode, source: plan.scene.gaze.source } : null,
    people_count: plan.composition ? plan.composition.people_count : null,
    pose_risk: plan.composition ? plan.composition.pose_risk : null,
    minor_safety_applied: plan.minor_safety ? plan.minor_safety.applies : null,
  };
}

// Prompt de uma combinação ângulo × formato, para o lojista testar a arte no ChatGPT antes de pagar o lote.
// Só sai na prévia (resposta direta ao admin): histórico, lotes e logs continuam só com planSummary.
// `references` diz em que ordem anexar as fotos, porque o prompt cita "imagem 1", "imagem 2"...
function planPrompt(plan) {
  const produtos = new Map((plan.products || []).map((p) => [p.id, p]));
  const fotoPorProduto = new Map();
  const references = (plan.references || []).map((r) => {
    const foto = (fotoPorProduto.get(r.product_id) || 0) + 1;
    fotoPorProduto.set(r.product_id, foto);
    const produto = produtos.get(r.product_id);
    return { order: r.order, product_id: r.product_id, product_name: produto ? produto.name : r.product_id, photo: foto };
  });
  return {
    angle: plan.angle && { id: plan.angle.id, label: plan.angle.label },
    placement: plan.placement && plan.placement.id,
    size: plan.model && plan.model.size,
    persona: plan.persona ? plan.persona.label : null,
    scene: plan.context && plan.context.scene,
    text: plan.prompt ? plan.prompt.text : '',
    prompt_version: plan.prompt && plan.prompt.prompt_version,
    references,
  };
}

module.exports = { normalizeJobInput, buildRequests, planSummary, planPrompt, InputError, MAX_ITEMS_PER_JOB };
