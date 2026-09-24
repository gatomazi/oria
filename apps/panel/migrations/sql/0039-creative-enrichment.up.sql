-- Fase F.1 · Product Enrichment — propostas de `semantic_context`, nunca aplicadas automaticamente.
--
-- Uma linha = UMA proposta sobre UM produto, de UM provider (só "fake" nesta fase — nenhuma chamada
-- paga, nenhuma chave, ver apps/creative-generator/creative_core/enrichment.py). O produto em si NUNCA
-- é alterado por esta tabela: aprovar grava o merge em `creative_products.metadata.semantic_context`
-- (rota do painel, dentro de uma transação que também audita aqui) — esta tabela só guarda a proposta e
-- a decisão tomada sobre ela.
--
-- `product_id` referencia `creative_products (id, organization_id)` — FK COMPOSTA (a 0010 já deixou a PK
-- de creative_products como `(organization_id, id)`, exatamente o formato que essa FK precisa): protege
-- no banco, não só na aplicação, contra um product_id de OUTRA Organization — mesmo padrão de
-- `fk_creative_angles_store` (0034) para `stores`.
--
-- `before_semantic_context`/`applied_semantic_context`/`accepted_fields` só existem depois da decisão
-- (aprovada/ajustada): é o "antes/depois" auditável que o §4 da direção pede, sem guardar nada do
-- provider além do que já é a proposta validada (nunca uma resposta bruta).
--
-- Aditiva e reversível: uma tabela nova; nada existente muda.

CREATE TABLE creative_enrichment_proposals (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL,
  -- creative_products é só Organization hoje (sem store_id) — esta coluna existe para quando/se deixar
  -- de ser, e fica sempre NULL até lá. Nunca filtrada.
  store_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'adjusted', 'rejected')),
  schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('fake', 'openai')),
  -- A proposta validada (contracts.EnrichmentProposal.proposed, formato ProductSemanticContext) — nunca
  -- uma resposta bruta do provider.
  proposed JSONB NOT NULL CHECK (jsonb_typeof(proposed) = 'object'),
  recommended_angle_families JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recommended_angle_families) = 'array'),
  recommended_interactions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recommended_interactions) = 'array'),
  field_notes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(field_notes) = 'object'),
  -- Hash dos campos do produto NO MOMENTO da proposta (creative_core.enrichment.snapshot_hash) — auditoria
  -- ("isto foi proposto quando o texto era X"), calculado pelo core, nunca recalculado no painel.
  product_snapshot_hash TEXT NOT NULL,
  -- A checagem de frescor de verdade (§4, "exigir revalidação... sem aprovação silenciosa") usa isto, não
  -- o hash: `updated_at` do produto no momento da proposta, comparado ao `updated_at` atual na hora de
  -- aprovar. Um token de concorrência simples e no MESMO banco/linguagem evita depender de serialização
  -- JSON byte-a-byte idêntica entre Python (core) e Node (painel) para algo que decide uma escrita.
  product_updated_at TIMESTAMPTZ NOT NULL,
  -- Preenchidos só na decisão (aprovar/ajustar/rejeitar); NULL enquanto `status = 'pending'`.
  accepted_fields JSONB CHECK (accepted_fields IS NULL OR jsonb_typeof(accepted_fields) = 'array'),
  before_semantic_context JSONB CHECK (before_semantic_context IS NULL OR jsonb_typeof(before_semantic_context) = 'object'),
  applied_semantic_context JSONB CHECK (applied_semantic_context IS NULL OR jsonb_typeof(applied_semantic_context) = 'object'),
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  reviewed_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_creative_enrichment_proposals PRIMARY KEY (organization_id, id),
  CONSTRAINT ck_creative_enrichment_proposals_reviewed CHECK ((status = 'pending') OR (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)),
  CONSTRAINT fk_creative_enrichment_proposals_product FOREIGN KEY (product_id, organization_id) REFERENCES creative_products (id, organization_id) ON DELETE CASCADE
);

CREATE INDEX idx_creative_enrichment_proposals_product ON creative_enrichment_proposals (organization_id, product_id, created_at DESC);

-- Um produto só tem UMA proposta pendente por vez: pedir uma proposta nova com uma já pendente deve
-- reusar/decidir a existente, nunca empilhar propostas que ninguém decide.
CREATE UNIQUE INDEX uq_creative_enrichment_proposals_pending ON creative_enrichment_proposals (organization_id, product_id) WHERE status = 'pending';

-- Mesma forma canônica das policies da Fase 1 (INV-07 compara o texto).
ALTER TABLE creative_enrichment_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_enrichment_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_enrichment_proposals
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
