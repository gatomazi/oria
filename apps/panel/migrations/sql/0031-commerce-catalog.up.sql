-- Fase D · Canonical Commerce Catalog — docs/features/ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md §7-8,
-- docs/features/product-analytics-phase-a-audit.md.
--
-- `commerce_products`/`commerce_product_variants` são o catálogo CANÔNICO do Oria, normalizado por
-- `lib/connectors/*/mapper.js` (Fase C). `produtos_ink` (cache do adapter Ink) NÃO muda, não vira
-- view e o canônico não depende dela — são dois caminhos deliberadamente separados; a convergência é
-- problema de outra fase.
--
-- Diferente das tabelas legadas (`loja` NOT NULL, retrofit por ALTER TABLE — migrations 0021/0025/
-- 0026/0027), estas nascem NATIVAS: `organization_id`/`store_id` obrigatórios desde a criação, sem
-- história de loja nenhuma. Por isso entram em `TABELAS_PLATAFORMA` no manifesto de tenancy
-- (lib/platform/tenancy-manifest.js), não em `TABELAS_TENANT` — o mesmo grupo de `organization_members`
-- e `onboarding_sessions`/`onboarding_steps`.
--
-- `store_id` continua presente mesmo com ORIA-TENANCY-STORE-01 (1 Organization = 1 Store,
-- definitivo — productization-decisions.md, PD-002): é dado OPERACIONAL do catálogo, não uma
-- preparação para múltiplas Stores por Organization.
--
-- ── Estado de sincronização (full snapshot, Fase D) ─────────────────────────────────────────────
-- Sem `updated_since` confiável documentado na Ink (§9 do comando), cada sync é um snapshot completo
-- paginado — não incremental. `last_seen_sync_id` marca a última execução que OBSERVOU a linha;
-- `is_active` cai para false só depois que TODAS as páginas de um sync terminaram com sucesso e a
-- linha não apareceu em nenhuma. Nunca DELETE: pedido, analytics e identity (fases futuras) podem
-- referenciar um produto que sumiu do provider. Ver lib/product-analytics/catalog-sync.js.
--
-- `commerce_catalog_sync_logs` é observabilidade do próprio sync (retry/recovery/diagnóstico —
-- "por que o número de produtos mudou", mesmo propósito de `meta_sync_logs`/`google_ads_sync_logs`
-- da baseline, aqui tenant-scoped desde o início). Não é `product_external_identities` (Fase F,
-- fora do escopo) nem `commerce_orders` (fora do escopo).

CREATE TABLE commerce_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,

  provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
  -- TEXT, nunca BIGINT: o provider pode usar inteiro, UUID ou handle: apps/panel/lib/connectors/types.js §7.
  provider_product_id TEXT NOT NULL CHECK (btrim(provider_product_id) <> ''),

  name TEXT NOT NULL,
  slug TEXT,
  image_url TEXT,
  product_url TEXT,
  product_type TEXT,

  price NUMERIC,
  promotional_price NUMERIC,
  visible BOOLEAN,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),

  -- Full snapshot (ver cabeçalho): nunca hard-delete.
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_seen_sync_id UUID NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composta: não basta a Store existir, ela precisa ser da Organization da linha (mesmo padrão da
  -- migration 0021 — reusa a UNIQUE (id, organization_id) que ela já criou em `stores`).
  CONSTRAINT fk_commerce_products_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  -- Alvo da FK composta de commerce_product_variants (garante, no banco, que uma variante não
  -- aponta para produto de outra Organization mesmo se o código errar).
  CONSTRAINT uq_commerce_products_id_organization UNIQUE (id, organization_id),
  -- Identidade externa: um produto por (Organization, Store, provider, id do provider).
  CONSTRAINT uq_commerce_products_identidade UNIQUE (organization_id, store_id, provider, provider_product_id)
);
CREATE INDEX idx_commerce_products_store ON commerce_products (organization_id, store_id);
CREATE INDEX idx_commerce_products_ativos ON commerce_products (organization_id, store_id, provider) WHERE is_active;
CREATE INDEX idx_commerce_products_sync_run ON commerce_products (organization_id, store_id, provider, last_seen_sync_id);

ALTER TABLE commerce_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON commerce_products
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

CREATE TABLE commerce_product_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  commerce_product_id UUID NOT NULL,

  provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
  provider_variant_id TEXT NOT NULL CHECK (btrim(provider_variant_id) <> ''),

  sku TEXT,
  color TEXT,
  size TEXT,
  model TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),

  is_active BOOLEAN NOT NULL DEFAULT true,
  last_seen_sync_id UUID NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_commerce_product_variants_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  -- Composta contra uq_commerce_products_id_organization: uma variante NUNCA aponta para produto de
  -- outra Organization, garantido pelo banco (não só pelo código de persistência).
  CONSTRAINT fk_commerce_product_variants_product FOREIGN KEY (commerce_product_id, organization_id)
    REFERENCES commerce_products (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT uq_commerce_product_variants_identidade UNIQUE (organization_id, store_id, provider, provider_variant_id)
);
CREATE INDEX idx_commerce_product_variants_produto ON commerce_product_variants (organization_id, commerce_product_id);
CREATE INDEX idx_commerce_product_variants_ativos ON commerce_product_variants (organization_id, store_id, provider) WHERE is_active;
CREATE INDEX idx_commerce_product_variants_sync_run ON commerce_product_variants (organization_id, store_id, provider, last_seen_sync_id);

ALTER TABLE commerce_product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_product_variants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON commerce_product_variants
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Observabilidade do sync (ver cabeçalho). Uma linha por execução (`sync_run_id`), atualizada no
-- início ('running') e no fim ('success'/'partial_failure'/'failed') — nunca por página, para não
-- multiplicar escrita a cada página processada.
CREATE TABLE commerce_catalog_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (btrim(provider) <> ''),
  sync_run_id UUID NOT NULL,

  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial_failure', 'failed')),

  pages_processed INTEGER NOT NULL DEFAULT 0 CHECK (pages_processed >= 0),
  products_seen INTEGER NOT NULL DEFAULT 0 CHECK (products_seen >= 0),
  products_inserted INTEGER NOT NULL DEFAULT 0 CHECK (products_inserted >= 0),
  products_updated INTEGER NOT NULL DEFAULT 0 CHECK (products_updated >= 0),
  products_deactivated INTEGER NOT NULL DEFAULT 0 CHECK (products_deactivated >= 0),
  variants_seen INTEGER NOT NULL DEFAULT 0 CHECK (variants_seen >= 0),
  variants_inserted INTEGER NOT NULL DEFAULT 0 CHECK (variants_inserted >= 0),
  variants_updated INTEGER NOT NULL DEFAULT 0 CHECK (variants_updated >= 0),
  variants_deactivated INTEGER NOT NULL DEFAULT 0 CHECK (variants_deactivated >= 0),

  -- Código estável, nunca a mensagem crua do provider (mesmo padrão de onboarding_steps.last_error_code).
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,

  CONSTRAINT fk_commerce_catalog_sync_logs_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT uq_commerce_catalog_sync_logs_run UNIQUE (organization_id, sync_run_id),
  CONSTRAINT ck_commerce_catalog_sync_logs_fim CHECK (status = 'running' OR finished_at IS NOT NULL)
);
CREATE INDEX idx_commerce_catalog_sync_logs_recentes ON commerce_catalog_sync_logs (organization_id, store_id, provider, started_at DESC);

ALTER TABLE commerce_catalog_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_catalog_sync_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON commerce_catalog_sync_logs
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
