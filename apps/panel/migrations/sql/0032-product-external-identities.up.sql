-- Fase F · Product Identity — docs/features/ORIA_PRODUCT_ANALYTICS_CONNECTOR_ARCHITECTURE_V2.md §9-10,
-- comando ORIA_RODADA_NOTURNA_PRODUCT_ANALYTICS_E_F_G.md §5.
--
-- `product_external_identities` liga um id OBSERVADO em algum provider (Ink product/variant id, SKU,
-- GA4 item_id, …) ao produto CANÔNICO do Oria (`commerce_products`). Nasce nativa, como
-- `commerce_products`/`commerce_product_variants` (Fase D): `organization_id`/`store_id`
-- obrigatórios desde a criação, sem história de `loja` — entra em TABELAS_PLATAFORMA.
--
-- `namespace` é um identificador aberto e estável (`reserva_ink.product_id`, `sku`, `ga4.item_id`,
-- …) — nunca o genérico `id`, e o CHECK abaixo recusa esse formato. Novos providers/namespaces
-- entram sem migration nova.
--
-- FK composta para `commerce_products (id, organization_id)` — a mesma proteção de
-- `commerce_product_variants` (Fase D): uma identity NUNCA aponta para produto de outro tenant, nem
-- por erro de código, porque o banco recusa a combinação.
--
-- `source`/`confidence` seguem o vocabulário já fixado na arquitetura (§9 do doc original):
-- `commerce_sync` (bootstrap a partir do catálogo canônico), `analytics_observed` (visto no
-- provider de analytics, ainda não resolvido a uma regra), `manual` (vínculo humano) e `rule`
-- (resolução determinística — ex.: GA4 item_id == provider_product_id). Nunca fuzzy match: não há
-- confidence "inferred por nome/slug" nesta fase (§5.5 do comando: nunca Levenshtein, nunca
-- "parece o mesmo produto" — `itemName` é só diagnóstico manual).

CREATE TABLE product_external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  commerce_product_id UUID NOT NULL,

  namespace TEXT NOT NULL CHECK (namespace ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND namespace <> 'id'),
  external_id TEXT NOT NULL CHECK (btrim(external_id) <> ''),

  source TEXT NOT NULL CHECK (source IN ('commerce_sync', 'analytics_observed', 'manual', 'rule')),
  confidence TEXT NOT NULL CHECK (confidence IN ('exact', 'verified', 'inferred')),

  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_product_external_identities_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_product_external_identities_product FOREIGN KEY (commerce_product_id, organization_id)
    REFERENCES commerce_products (id, organization_id) ON DELETE CASCADE,
  -- Identidade externa é única dentro do tenant: o mesmo (namespace, external_id) não pode
  -- apontar para dois produtos ao mesmo tempo — é exatamente o que impede "SKU duplicado" e
  -- "GA4 item_id com dois candidatos" de virarem duas linhas silenciosas.
  CONSTRAINT uq_product_external_identities_identidade UNIQUE (organization_id, store_id, namespace, external_id)
);
CREATE INDEX idx_product_external_identities_produto ON product_external_identities (organization_id, commerce_product_id);
CREATE INDEX idx_product_external_identities_namespace ON product_external_identities (organization_id, store_id, namespace);

ALTER TABLE product_external_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_external_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON product_external_identities
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
