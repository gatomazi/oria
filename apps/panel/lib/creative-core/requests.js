'use strict';

// Converte o formulário do painel (1 lote) em N CreativeRequest do core — 1 por ângulo × formato × quantidade.
// Whitelist de campos: qualquer chave desconhecida é rejeitada. tenant/ids de dono vêm sempre do servidor; o request só
// referencia ids de registros do próprio tenant, que são carregados do banco (nunca aceitos inline do navegador).

const crypto = require('crypto');
const { UUID_RE } = require('./storage');
const { angleForCore, FAMILIES: ANGLE_FAMILIES } = require('./pgAngles');

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
  // Fase C · composição da cena e reprodução (vêm de "Copiar dados" / "Gerar assim"; o core valida o conteúdo).
  'subjects', 'interaction', 'gaze_mode', 'seed', 'scene_picks',
  // Fase D.1 · ângulo personalizado (substitui angle_ids: um lote usa ângulos legados OU um ângulo customizado, nunca os dois).
  // D.1.1 (auditoria do limite de confiança): `custom_angle` (o objeto inteiro, cru do navegador) foi REMOVIDO da
  // entrada aceita — nada aqui validava que ele pertencia à Organization/Store de quem chamou, nem que correspondia a
  // um plano real já gerado; um cliente podia mandar qualquer id/scope/definition e o servidor repassava como se fosse
  // um snapshot histórico autorizado. `custom_angle_replay_of` substitui esse caminho: é o id do CRIATIVO ORIGINAL (já
  // gerado, já autorizado), e o servidor busca o snapshot no PLANO PERSISTIDO (buildRequests), nunca no corpo do
  // request — ver docs/features/creative-generator-fase-d1-1.md.
  'custom_angle_id', 'custom_angle_replay_of',
  // Fase E · família de ângulo (§7): outra forma de "auto" — o usuário escolheu uma família (cartão), não um
  // ângulo customizado nem um id legado. O core resolve pra o legacy angle_id daquela família.
  'angle_family_hint',
]);
const GAZE_MODES = ['auto', 'camera', 'off_camera', 'product', 'interaction'];
const INTERACTION_RE = /^[a-z_]{2,40}$/;
const PICK_NAME_RE = /^[a-z_]{1,40}$/;
const SUBJECT_KEYS = new Set(['id', 'role', 'persona', 'age_band', 'relation_to_primary', 'relation_label', 'wears_product_id', 'prominence']);
const MAX_SUBJECTS = 4;
const MAX_SUBJECTS_BYTES = 8_000;

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
  // Ângulo personalizado (Fase D.1): substitui a lista de ângulos legados por um único slot "auto" — o core
  // resolve o ângulo real a partir de `custom_angle_id`/`custom_angle_replay_of`, nunca dos 13 ids.
  exigir(raw.custom_angle_id === undefined || raw.custom_angle_replay_of === undefined, 'ângulo personalizado: informe custom_angle_id OU custom_angle_replay_of, não os dois');
  // Fase E · família (§7): outro jeito de pedir "auto" — o usuário escolheu uma família (não um id legado nem um
  // ângulo customizado), e o core roteia pra o legacy angle_id daquela família (canonical_legacy_angle_id).
  // `angle_family_hint` só faz sentido junto de "auto"; exclusivo com ângulo personalizado (que, se presente,
  // já venceria a hint no core mesmo assim — recusar aqui evita um pedido que parece pedir duas coisas).
  exigir(
    raw.angle_family_hint === undefined || (raw.custom_angle_id === undefined && raw.custom_angle_replay_of === undefined),
    'informe angle_family_hint OU um ângulo personalizado, não os dois',
  );
  const usaAnguloCustomizado = raw.custom_angle_id !== undefined || raw.custom_angle_replay_of !== undefined;
  const usaFamiliaHint = raw.angle_family_hint !== undefined;
  // "auto" puro (sem hint nenhum): pede a recomendação do motor de verdade (recommend_angle) — é o que dá o
  // "Gerar assim" da primeira geração. `angle_ids: ['auto']` só passa reto aqui; qualquer outra lista cai na
  // validação legada de 13 ids abaixo.
  const pedeAutoPuro = !usaAnguloCustomizado && !usaFamiliaHint && Array.isArray(raw.angle_ids) && raw.angle_ids.length === 1 && raw.angle_ids[0] === 'auto';
  const input = {
    engine: raw.engine,
    product_mode: raw.product_mode,
    product_ids: listaDe(raw.product_ids, { min: 1, max: 6, validar: (v) => UUID_RE.test(v) }, 'produtos'),
    angle_ids: (usaAnguloCustomizado || usaFamiliaHint || pedeAutoPuro) ? ['auto'] : listaDe(raw.angle_ids, { min: 1, max: 13, validar: (v) => ANGLE_RE.test(v) }, 'ângulos'),
    placements: listaDe(raw.placements, { min: 1, max: 2, validar: (v) => PLACEMENTS.includes(v) }, 'formatos'),
    quantity: raw.quantity === undefined ? 1 : raw.quantity,
    quality: raw.quality || 'medium',
  };
  if (raw.custom_angle_id !== undefined) {
    exigir(UUID_RE.test(raw.custom_angle_id), 'ângulo personalizado: id inválido');
    input.custom_angle_id = raw.custom_angle_id; // resolvido do banco em buildRequests (precisa checar "active")
  }
  if (raw.custom_angle_replay_of !== undefined) {
    // Réplica de um draft ("de novo"/"variação"): o cliente manda o id do CRIATIVO ORIGINAL, nunca o CustomAngle em
    // si — o snapshot vem do plano persistido (buildRequests), então "active" não se aplica aqui (autossuficiente,
    // §3 da Fase D.1) e nada que o navegador mande sobre o ângulo é usado como prova de autorização.
    exigir(UUID_RE.test(raw.custom_angle_replay_of), 'custom_angle_replay_of: id inválido');
    input.custom_angle_replay_of = raw.custom_angle_replay_of;
  }
  if (raw.angle_family_hint !== undefined) {
    exigir(objetoSimples(raw.angle_family_hint) && ANGLE_FAMILIES.includes(raw.angle_family_hint.family), `angle_family_hint.family: use ${ANGLE_FAMILIES.join(', ')}`);
    exigir(raw.angle_family_hint.preset === undefined || (typeof raw.angle_family_hint.preset === 'string' && raw.angle_family_hint.preset.length <= 60), 'angle_family_hint.preset: até 60 caracteres');
    input.angle_family_hint = { family: raw.angle_family_hint.family, ...(raw.angle_family_hint.preset !== undefined ? { preset: raw.angle_family_hint.preset } : {}) };
  }
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

  if (raw.subjects !== undefined) input.subjects = normalizeSubjects(raw.subjects, input.product_ids);
  if (raw.interaction !== undefined) {
    exigir(typeof raw.interaction === 'string' && INTERACTION_RE.test(raw.interaction), 'interação inválida');
    input.interaction = raw.interaction;
  }
  if (raw.gaze_mode !== undefined) {
    exigir(GAZE_MODES.includes(raw.gaze_mode), 'olhar inválido');
    input.gaze_mode = raw.gaze_mode;
  }
  // Semente e sorteios de cena só reproduzem UM criativo: com quantidade ou combinações demais, todos sairiam iguais.
  if (raw.seed !== undefined || raw.scene_picks !== undefined) {
    exigir(total === 1, 'reproduzir uma cena vale para um único criativo (1 ângulo, 1 formato, quantidade 1)');
  }
  if (raw.seed !== undefined) {
    exigir(Number.isInteger(raw.seed) && raw.seed >= 0 && raw.seed <= 2 ** 31 - 1, 'semente inválida');
    input.seed = raw.seed;
  }
  if (raw.scene_picks !== undefined) {
    exigir(objetoSimples(raw.scene_picks) && Object.keys(raw.scene_picks).length <= 8, 'sorteios da cena: formato inválido');
    for (const [name, index] of Object.entries(raw.scene_picks)) {
      exigir(PICK_NAME_RE.test(name) && Number.isInteger(index) && index >= 0 && index < 1000, 'sorteios da cena: valor inválido');
    }
    input.scene_picks = { ...raw.scene_picks };
  }
  return input;
}

// Estrutura de `subjects` (até 4 pessoas). O conteúdo (papéis, relações, faixas etárias, produto vestido) é do core, que
// devolve 422 com o campo errado; aqui só o formato, o tamanho e o vínculo com os produtos DESTE lote.
function normalizeSubjects(raw, productIds) {
  exigir(Array.isArray(raw) && raw.length >= 1 && raw.length <= MAX_SUBJECTS, `pessoas: informe de 1 a ${MAX_SUBJECTS}`);
  exigir(JSON.stringify(raw).length <= MAX_SUBJECTS_BYTES, 'pessoas: conteúdo grande demais');
  return raw.map((subject) => {
    exigir(objetoSimples(subject), 'pessoas: formato inválido');
    for (const key of Object.keys(subject)) exigir(SUBJECT_KEYS.has(key), `pessoas: campo desconhecido: ${key}`);
    exigir(objetoSimples(subject.persona) && typeof subject.persona.label === 'string' && subject.persona.label.trim(), 'pessoas: descreva cada pessoa');
    if (subject.wears_product_id !== undefined && subject.wears_product_id !== null) {
      exigir(productIds.includes(subject.wears_product_id), 'pessoas: o produto vestido precisa ser um dos produtos do lote');
    }
    return subject;
  });
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
  if (input.subjects) base.subjects = input.subjects;
  if (input.interaction) base.interaction = input.interaction;
  if (input.gaze_mode && input.gaze_mode !== 'auto') base.gaze_mode = input.gaze_mode;
  if (input.scene_picks) base.scene_picks = input.scene_picks;

  // Ângulo personalizado (Fase D.1 + D.1.1): duas escolhas, nunca o objeto cru do navegador.
  //   - `custom_angle_id`: ESCOLHA NOVA — busca no banco, escopada ao tenant, e exige `active`.
  //   - `custom_angle_replay_of`: REUTILIZAÇÃO HISTÓRICA — o cliente manda o id do CRIATIVO ORIGINAL (já gerado,
  //     já autorizado); o servidor busca esse item ESCOPADO AO TENANT (`store.getItem`, a mesma consulta tenant-
  //     scoped que "Copiar dados" usa) e lê o snapshot do PLANO PERSISTIDO — nunca do corpo do request. Isso é o
  //     que impede um cliente de fingir ser outra Organization/Store ou adulterar id/scope/version/definition: o
  //     que ele manda (um id de criativo) não carrega nenhum desses campos, só uma referência que só resolve para
  //     algo se já pertencer ao tenant da sessão. `active` não entra aqui de propósito — "Gerar de novo" e
  //     "Gerar variação" continuam funcionando com um ângulo já desativado, porque o snapshot é do momento em que
  //     ele foi usado, não do estado atual da linha em creative_angles.
  if (input.custom_angle_id) {
    const linha = await store.getAngle(tenantId, input.custom_angle_id);
    exigir(linha, 'ângulo personalizado não encontrado');
    exigir(linha.active, 'este ângulo personalizado está desativado — escolha outro ou reative-o antes de gerar');
    base.custom_angle = angleForCore(linha);
  } else if (input.custom_angle_replay_of) {
    const original = await store.getItem(tenantId, input.custom_angle_replay_of);
    exigir(original, 'criativo original não encontrado');
    exigir(original.plan, 'criativo original ainda não tem plano');
    const snapshot = original.plan.angle_recommendation && original.plan.angle_recommendation.custom_angle;
    exigir(snapshot, 'este criativo não usou um ângulo personalizado');
    base.custom_angle = snapshot;
  } else if (input.angle_family_hint) {
    // Sem consulta ao banco: `family`/`preset` já são valores fechados (whitelist acima), o core resolve o
    // legacy angle_id (canonical_legacy_angle_id) e recusa família sem rota (ex.: action_movement, reservada).
    base.angle_family_hint = input.angle_family_hint;
  }
  // Cena com pessoas/interação só existe no plano v2 (o core recusa no v1). Diga antes de enfileirar, em português.
  if ((input.subjects || input.interaction || input.scene_picks || base.custom_angle) && planSchemaVersion !== 2) {
    throw new InputError('a composição de cena (pessoas, interação, ângulo personalizado) exige o plano v2, que ainda não está habilitado nesta conta');
  }
  if (input.scene_picks && promptVersion !== 2) {
    throw new InputError('reproduzir os sorteios da cena exige o prompt v2, que ainda não está habilitado nesta conta');
  }
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
          request: { ...base, creative_id: creativeId, angle_id: angle, placement_id: placement, seed: input.seed !== undefined ? input.seed : randomInt(0, 2 ** 31 - 1) },
        });
      }
    }
  }
  return items;
}

// Resumo seguro do plano para UI/histórico: nunca inclui o texto do prompt (conteúdo interno do produto).
// Fase G.2 — "quem veste o quê", só leitura do que o plano JÁ calculou (planner_v2.py::build,
// campo `fields.subjects`) — nenhuma capacidade nova do core, só um resumo seguro de um array que
// o core sempre devolveu e o painel nunca expôs. Formato compatível com `CenaPessoa` (mesmo tipo já
// usado por "Copiar dados"): um objeto assim pode voltar, sem alteração, dentro de `subjects` de um
// novo /jobs — nunca reconstruído campo a campo pela tela. `product_name` é só para exibição (nunca
// volta no request); `persona` é o objeto opaco do próprio plano — a tela não abre ele, só reenvia.
function subjectsSummary(plan) {
  if (!Array.isArray(plan.subjects) || !plan.subjects.length) return [];
  const produtos = new Map((plan.products || []).map((p) => [p.id, p]));
  return plan.subjects.map((s) => ({
    id: s.id, role: s.role, persona: s.persona || { label: s.label || 'uma pessoa' },
    age_band: s.age_band, relation_to_primary: s.relation_to_primary, relation_label: s.relation_label,
    wears_product_id: s.product_id || null,
    product_name: s.product_id ? ((produtos.get(s.product_id) || {}).name || null) : null,
    prominence: s.prominence,
  }));
}

// De onde veio a persona automática: 'custom' (escolhida pelo lojista), 'default' (nenhuma persona sugerida no
// Brand Kit nem no Nicho — o core cai nas duas personas genéricas embutidas, ids `default_*`, ver
// creative_core/personas.py::DEFAULT_PERSONAS; um teste do core fixa essa convenção) ou 'kit'. `null`: cena sem
// pessoa. Só a tela usa isto, para avisar o lojista — nunca entra no plano nem no prompt.
function personaSource(persona) {
  if (!persona) return null;
  if (persona.source === 'custom') return 'custom';
  return /^default_/.test(String(persona.id || '')) ? 'default' : 'kit';
}

function planSummary(plan) {
  return {
    plan_id: plan.plan_id,
    strategy: plan.strategy,
    product_mode: plan.product_mode,
    angle: plan.angle && { id: plan.angle.id, label: plan.angle.label },
    placement: plan.placement && plan.placement.id,
    persona: plan.persona ? plan.persona.label : null,
    persona_source: personaSource(plan.persona),
    subjects: subjectsSummary(plan),
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
    // Fase E: a recomendação REAL do motor (não algo que a UI inventa) — presente em qualquer versão de plano
    // (engines.py inclui `angle_recommendation` tanto no v1 quanto no v2). `family`/`preset` deixam a tela montar
    // "Sugestão para esta estampa" sem expor `angle_id` legado nem os 13 ids — só o que já é seguro para tela
    // (nunca `custom_angle` aqui: a origem completa do ângulo customizado, quando existir, já tem seu próprio
    // resumo em `angle` acima; nada de segredo/definition sai neste campo).
    angle_recommendation: plan.angle_recommendation ? {
      family: plan.angle_recommendation.family || null,
      preset: plan.angle_recommendation.preset || null,
      source: plan.angle_recommendation.source || null,
      reason: Array.isArray(plan.angle_recommendation.reason) ? plan.angle_recommendation.reason : [],
    } : null,
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

module.exports = { normalizeJobInput, buildRequests, planSummary, personaSource, planPrompt, InputError, MAX_ITEMS_PER_JOB };
