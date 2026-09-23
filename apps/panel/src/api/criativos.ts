import { api } from './client';

// Gerador de Criativos (Oria) — /api/admin/criativos/* (routes/criativos.js). A OpenAI key nunca volta do servidor
// (só os 4 últimos caracteres). O texto do prompt só vem na prévia (para testar no ChatGPT antes do lote);
// lotes e histórico trabalham com resumos.

const BASE = '/api/admin/criativos';

export type Engine = 'CLEAN_ANGLES' | 'REMARKETING' | 'FUNNEL_VISUAL';
export type ProductMode = 'single_product' | 'multi_product';
export type FunnelStage = 'TOFU' | 'MOFU' | 'BOFU';
export type RemarketingIntent = 'site_visitor' | 'product_view' | 'collection_discovery' | 'cart' | 'checkout' | 'social_proof' | 'objection';
export type JobStatus = 'queued' | 'planning' | 'generating' | 'processing' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type ItemStatus = 'queued' | 'planning' | 'generating' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface CriativosStatus {
  flags: Record<string, boolean>;
  flagNames: string[];
  engines: Engine[];
  postgres: boolean;
  core: { configured: boolean; reachable: boolean; versions: Record<string, unknown> | null };
  openaiKey: { configured: boolean; last4: string | null; updatedAt: string | null };
  // Fase E — rollout operacional por Organization (nunca comercial). uiV2: a tela nova do gerador está
  // liberada para esta conta. planV2: "Personalizar cena" (pessoas/interação) e ângulo personalizado exigem
  // isso também — sem ele a UI V2 ainda funciona (recomendação, famílias), mas sem editar a cena.
  uiV2: boolean;
  planV2: boolean;
}

export interface CatalogAngle {
  id: string;
  label: string;
  description: string;
  uses_person: boolean;
  apparel_only: boolean;
}

export interface Catalog {
  engines: Engine[];
  productModes: ProductMode[];
  multiProductRules: Record<string, { enabled: boolean; min: number; max: number; allowedIntents?: string[]; basketIntents?: string[]; singleOnlyIntents?: string[] }>;
  catalog: {
    angles: CatalogAngle[];
    placements: { id: string; label: string; width: number; height: number }[];
    funnel_stages: FunnelStage[];
    remarketing_intents: RemarketingIntent[];
    qualities: string[];
    text_densities: string[];
    cta_emphases: string[];
    clean_modes: string[];
    builtin_kits: { brand: KitData[]; niche: KitData[] };
    // Fase C: nomes para telas. Ausentes em core mais antigo.
    interactions?: { id: string; label: string; min_people: number; max_people: number }[];
    relations?: { id: string; label: string }[];
    // Fase D/E: famílias de ângulo para a UI V2 (§7) — só label/description/reserved, nunca ids legados nem
    // preset/hints internos. `action_movement` vem com reserved: true e não deve virar um cartão clicável.
    angle_families?: AngleFamily[];
  };
  versions: Record<string, unknown>;
}

export type AngleFamilyId = 'connection' | 'lifestyle' | 'editorial_portrait' | 'product_focus' | 'creator_social' | 'product_no_person' | 'action_movement';
export interface AngleFamily {
  id: AngleFamilyId;
  label: string;
  description: string;
  reserved: boolean;
}

export interface KitData {
  id?: string;
  name: string;
  [key: string]: unknown;
}

export interface ProfileRow<T = Record<string, unknown>> {
  id: string;
  data: T;
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  metadata?: { city?: string; state?: string };
  references: { mime: string; sizeBytes: number }[];
  createdAt: string;
}

export interface AngleRecommendation {
  family: AngleFamilyId | null;
  preset: string | null;
  source: 'planner_default' | 'user' | null;
  reason: string[];
}

export interface PlanSummary {
  strategy: Engine;
  product_mode: ProductMode;
  angle: { id: string; label: string } | null;
  // Fase E: a recomendação REAL do motor para este plano — presente mesmo sem semantic_context (defaults
  // honestos, sempre com `reason`). Nunca inventar isto na UI: se vier null, não existe recomendação a mostrar.
  angle_recommendation: AngleRecommendation | null;
  placement: string;
  persona: string | null;
  scene: string;
  context_id: string;
  context_provider: string;
  funnel_stage: FunnelStage | null;
  remarketing_intent: RemarketingIntent | null;
  layout: string | null;
  overlay: { allowed: boolean; headline: string | null; subheadline: string | null; cta: string | null; badges: string[]; benefits: string[]; text_density: string | null; cta_emphasis: string | null; clean: boolean };
  warnings: string[];
}

export interface JobItem {
  creativeId: string;
  itemIndex: number;
  status: ItemStatus;
  generationAttempt: number;
  angle: string;
  placement: string;
  engine: Engine;
  productMode: ProductMode;
  funnelStage: FunnelStage | null;
  remarketingIntent: RemarketingIntent | null;
  persona: string | null;
  contextId: string | null;
  quality: string;
  brandKitVersion: number | null;
  nicheKitVersion: number | null;
  promptVersion: number | null;
  summary: PlanSummary | null;
  error: { code: string; message: string; retryable?: boolean } | null;
  assetUrl: string | null;
  createdAt: string;
  updatedAt: string;
  // Veredito da pessoa logada sobre este criativo (nunca o de outra pessoa).
  feedback?: Avaliacao | null;
}

export type Veredito = 'liked' | 'disliked';
export interface Avaliacao {
  verdict: Veredito;
  updatedAt: string;
}

export interface Job {
  id: string;
  engine: Engine;
  productMode: ProductMode;
  status: JobStatus;
  total: number;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  cancelledAt: string | null;
  progress?: { total: number; done: number; completed: number; failed: number };
  items?: JobItem[];
}

export interface JobInput {
  engine: Engine;
  product_mode: ProductMode;
  product_ids: string[];
  angle_ids: string[];
  placements: string[];
  quantity: number;
  quality: string;
  brand: { source: 'profile' | 'builtin'; id: string };
  niche?: { source: 'profile' | 'builtin'; id: string };
  persona: { mode: 'automatic' | 'custom' | 'none'; id?: string };
  context: { mode: 'automatic' | 'geographic' | 'niche' | 'custom'; profile_id?: string; context_id?: string; subject?: { name: string; metadata: { city: string; state: string } } };
  funnel_stage?: FunnelStage;
  funnel?: Record<string, unknown>;
  remarketing?: Record<string, unknown>;
  copy?: { generate: boolean };
  // Cena com pessoas (Fase C). Vêm de "Copiar dados"; o servidor valida o conteúdo. Mantidos como chegaram.
  subjects?: CenaPessoa[];
  interaction?: string;
  gaze_mode?: string;
  seed?: number;
  scene_picks?: Record<string, number>;
  // Ângulo personalizado (Fase D.1 + D.1.1) — nunca os dois juntos; quando presente, angle_ids vira ["auto"].
  // custom_angle_id: escolha nova, resolvida no servidor. custom_angle_replay_of: id do criativo ORIGINAL para
  // "Gerar de novo"/"Gerar variação" — o servidor lê o snapshot do plano persistido, nunca um objeto daqui.
  custom_angle_id?: string;
  custom_angle_replay_of?: string;
  // Fase E (§7) — outra forma de "auto": família escolhida por cartão, sem ângulo customizado.
  angle_family_hint?: { family: AngleFamilyId; preset?: string };
}

// Ângulos personalizados (Fase D) — CRUD em /angles. `definition` é o texto que de fato muda o prompt
// (Enquadramento/Direção fotográfica/Iluminação/Composição/notas); tudo opcional, nada aqui interpreta a
// linguagem natural (o core só compila o texto como veio — ver docs/features/creative-generator-fase-d1-1.md §3).
export interface AngleDefinition {
  framing?: string;
  photographic_direction?: string;
  lighting?: string;
  composition?: string;
  visual_notes?: string[];
}
export type PeopleMode = 'none' | 'optional' | 'required';
export type GazeMode = 'camera' | 'interaction' | 'off_camera' | 'product';
export interface CustomAngle {
  id: string;
  scope: 'organization' | 'store';
  storeId: string | null;
  slug: string;
  name: string;
  description: string | null;
  family: AngleFamilyId;
  peopleMode: PeopleMode;
  preset: string | null;
  definition: AngleDefinition;
  allowedInteractions: string[] | null;
  allowedProductModes: ProductMode[] | null;
  defaultGaze: GazeMode | null;
  active: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface AnglesResponse {
  system: AngleFamily[];
  organization: CustomAngle[];
  store: CustomAngle[];
}
export interface AngleInput {
  scope: 'organization' | 'store';
  slug: string;
  name: string;
  description?: string | null;
  family: AngleFamilyId;
  peopleMode: PeopleMode;
  preset?: string | null;
  definition?: AngleDefinition;
  allowedInteractions?: string[] | null;
  allowedProductModes?: ProductMode[] | null;
  defaultGaze?: GazeMode | null;
}

export interface CenaPessoa {
  id?: string;
  role?: string;
  persona: { label: string; [key: string]: unknown };
  age_band?: string;
  relation_to_primary?: string;
  relation_label?: string;
  wears_product_id?: string | null;
  prominence?: string;
  [key: string]: unknown;
}

// Remendo de "Gerar de novo" (mesma cena) ou "Gerar variação" (nova cena): campos do POST /jobs, sem nulos.
export interface AcaoCena {
  seed?: number;
  scene_picks?: Record<string, number>;
  gaze_mode?: string;
}

export interface Indisponivel {
  field: string;
  id: string | null;
  reason: string;
}

// GET /items/:creativeId/draft. `draft` é o rascunho inteiro do core, guardado sem perder nada.
export interface CopiaDados {
  creativeId: string;
  jobId: string;
  // `custom_angle_preview` é só para a TELA mostrar (nome/família/definição) — nunca vai de volta no POST
  // /jobs; o que volta é `form.custom_angle_replay_of` (já parte de JobInput). Ver requests.js/draft.js.
  form: Partial<JobInput> & { custom_angle_preview?: CustomAngle };
  actions: { again: AcaoCena; variation: AcaoCena };
  carried: string[];
  unavailable: Indisponivel[];
  warnings: string[];
  draft: Record<string, unknown>;
}

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const getCriativosStatus = () => api<CriativosStatus>(`${BASE}/status`);
export const getCatalog = () => api<Catalog>(`${BASE}/catalog`);

export const saveOpenAiKey = (apiKey: string) => api<CriativosStatus['openaiKey']>(`${BASE}/settings/openai-key`, json('PUT', { apiKey }));
export const removeOpenAiKey = () => api(`${BASE}/settings/openai-key`, json('DELETE'));
export const testOpenAiKey = () => api<{ ok: boolean; reason?: string }>(`${BASE}/settings/openai-key/test`, json('POST'));

export type ProfileKind = 'brand-kits' | 'niche-kits' | 'context-profiles' | 'personas';
export const listProfiles = <T = Record<string, unknown>>(kind: ProfileKind) => api<{ items: ProfileRow<T>[] }>(`${BASE}/${kind}`);
export const createProfile = (kind: ProfileKind, data: Record<string, unknown>, status?: string) =>
  api<ProfileRow>(`${BASE}/${kind}`, json('POST', status ? { data, status } : { data }));
export const updateProfile = (kind: ProfileKind, id: string, data: Record<string, unknown>, status?: string) =>
  api<ProfileRow>(`${BASE}/${kind}/${id}`, json('PUT', status ? { data, status } : { data }));
export const archiveProfile = (kind: ProfileKind, id: string) => api(`${BASE}/${kind}/${id}`, json('DELETE'));

export const listProducts = () => api<{ items: Product[] }>(`${BASE}/products`);
export const createProduct = (input: { name: string; type: string; description?: string; metadata?: { city?: string; state?: string }; images: { data_base64: string }[] }) =>
  api<Product>(`${BASE}/products`, json('POST', input));
export const archiveProduct = (id: string) => api(`${BASE}/products/${id}`, json('DELETE'));

export interface PromptPrevia {
  angle: { id: string; label: string } | null;
  placement: string;
  size: string | null;
  persona: string | null;
  scene: string;
  text: string;
  prompt_version: number | null;
  // Ordem em que as fotos devem ser anexadas: o prompt cita "imagem 1", "imagem 2"...
  references: { order: number; product_id: string; product_name: string; photo: number }[];
}

export const previewJob = (input: JobInput) =>
  api<{ total: number; first: PlanSummary; validations: { rule: string; passed: boolean }[]; prompts: PromptPrevia[]; promptsOmitidos: number }>(`${BASE}/preview`, json('POST', input));

export const urlReferenciaProduto = (productId: string, foto: number) => `${BASE}/products/${productId}/references/${foto}`;
export const createJob = (input: JobInput) => api<Job>(`${BASE}/jobs`, json('POST', input));
export const listJobs = () => api<{ items: Job[] }>(`${BASE}/jobs`);
export const getJob = (id: string) => api<Job>(`${BASE}/jobs/${id}`);
export const cancelJob = (id: string) => api<Job>(`${BASE}/jobs/${id}/cancel`, json('POST'));
export const retryJobItem = (jobId: string, creativeId: string) => api<JobItem>(`${BASE}/jobs/${jobId}/items/${creativeId}/retry`, json('POST'));
export const setFeedback = (creativeId: string, verdict: Veredito) =>
  api<{ creativeId: string; verdict: Veredito; updatedAt: string }>(`${BASE}/items/${creativeId}/feedback`, json('PUT', { verdict }));
export const clearFeedback = (creativeId: string) => api<{ creativeId: string; verdict: null }>(`${BASE}/items/${creativeId}/feedback`, json('DELETE'));
export const getCopiaDados = (creativeId: string) => api<CopiaDados>(`${BASE}/items/${creativeId}/draft`);
export const listHistory = () => api<{ items: (JobItem & { record: Record<string, unknown> | null })[] }>(`${BASE}/history`);
export const generateCopies = (input: JobInput) =>
  api<{ variants: { funnel_stage: FunnelStage; primary_text: string; headline: string; description: string }[] }>(`${BASE}/copies`, json('POST', input));

export const listAngles = () => api<AnglesResponse>(`${BASE}/angles`);
export const createAngle = (input: AngleInput) => api<CustomAngle>(`${BASE}/angles`, json('POST', input));
export const updateAngle = (id: string, input: Partial<AngleInput>) => api<CustomAngle>(`${BASE}/angles/${id}`, json('PUT', input));
export const archiveAngle = (id: string) => api<{ id: string; active: false }>(`${BASE}/angles/${id}`, json('DELETE'));

// Cadastro mínimo de ângulo personalizado (Fase E §8): a tela só pede Nome/Família/"como quer que a fotografia
// pareça" — o slug (identidade dentro do escopo) sai do nome, sem pedir mais um campo. Servidor valida com a
// mesma regra (`ANGLE_SLUG_RE`, routes/criativos.js); uma colisão de slug no mesmo escopo volta como erro comum.
export function gerarSlug(nome: string): string {
  const base = nome
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const comInicio = /^[a-z0-9]/.test(base) ? base : `angulo-${base}`;
  return (comInicio.length >= 2 ? comInicio : `${comInicio || 'angulo'}-x`).slice(0, 60);
}

export async function arquivoParaBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binario = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}
