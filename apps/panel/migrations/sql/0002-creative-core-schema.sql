CREATE TABLE IF NOT EXISTS creative_settings (
  tenant_id TEXT PRIMARY KEY,
  openai_key_enc TEXT,
  openai_key_last4 TEXT,
  openai_key_updated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creative_brand_profiles (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  data JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_creative_brand_profiles_tenant ON creative_brand_profiles (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS creative_niche_profiles (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  data JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_creative_niche_profiles_tenant ON creative_niche_profiles (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS creative_context_profiles (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  data JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_creative_context_profiles_tenant ON creative_context_profiles (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS creative_personas (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  data JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_creative_personas_tenant ON creative_personas (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS creative_products (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  references_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_creative_products_tenant ON creative_products (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS creative_jobs (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  product_mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  input JSONB NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_creative_jobs_tenant ON creative_jobs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS creative_generations (
  creative_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id UUID NOT NULL,
  item_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  generation_attempt INTEGER NOT NULL DEFAULT 1,
  infra_retries INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request JSONB NOT NULL,
  plan JSONB,
  plan_summary JSONB,
  record JSONB,
  error JSONB,
  engine TEXT NOT NULL,
  product_mode TEXT NOT NULL,
  product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  brand_id TEXT,
  angle TEXT,
  placement TEXT,
  funnel_stage TEXT,
  remarketing_intent TEXT,
  context_id TEXT,
  persona TEXT,
  quality TEXT,
  brand_kit_version INTEGER,
  niche_kit_version INTEGER,
  prompt_version INTEGER,
  asset_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_creative_generations_job ON creative_generations (job_id, item_index);
CREATE INDEX IF NOT EXISTS idx_creative_generations_queue ON creative_generations (tenant_id, status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_creative_generations_history ON creative_generations (tenant_id, created_at DESC);

-- Consumo cobrado pela OpenAI nesta geração. Em colunas, não dentro de record (JSONB), porque a
-- tela de custos soma isso por período — e SUM de coluna não depende de o JSON ter o formato certo.
-- NULL significa "não medido", nunca "custou zero": zero somaria silenciosamente a menos.
-- O modelo fica junto porque o preço é por modelo; sem ele, um troca de modelo reprecifica o passado.
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS modelo_imagem TEXT;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada INTEGER;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_saida INTEGER;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada_cache INTEGER;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada_texto INTEGER;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS tokens_entrada_imagem INTEGER;
CREATE INDEX IF NOT EXISTS idx_creative_generations_custo
  ON creative_generations (tenant_id, created_at DESC) WHERE tokens_saida IS NOT NULL;

CREATE TABLE IF NOT EXISTS creative_assets (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  creative_id UUID NOT NULL,
  storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_creative_assets_creative ON creative_assets (tenant_id, creative_id);
