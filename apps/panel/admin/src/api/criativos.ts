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
  };
  versions: Record<string, unknown>;
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

export interface PlanSummary {
  strategy: Engine;
  product_mode: ProductMode;
  angle: { id: string; label: string } | null;
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
export const listHistory = () => api<{ items: (JobItem & { record: Record<string, unknown> | null })[] }>(`${BASE}/history`);
export const generateCopies = (input: JobInput) =>
  api<{ variants: { funnel_stage: FunnelStage; primary_text: string; headline: string; description: string }[] }>(`${BASE}/copies`, json('POST', input));

export async function arquivoParaBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  let binario = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binario);
}
