-- Fase C · "Gostei / Não gostei" do Gerador de Criativos.
--
-- Uma linha por (Organization, criativo, pessoa): o veredito de UMA pessoa sobre UM criativo. Marcar de novo troca o
-- veredito (upsert); limpar apaga a linha. Nada aqui alimenta o planner: é memória para consulta futura ("esta loja
-- aprova mais este ângulo / contexto / interação / composição / produto"), sem ML e sem ranking automático.
--
-- ── Escopo ───────────────────────────────────────────────────────────────────────────────────
-- `organization_id` NOT NULL (RLS forçada, mesma policy canônica das tabelas de plataforma). `store_id` é NULO por
-- desenho: NULL = feedback compartilhado pela Organization inteira; uma Store = feedback daquela loja. FK COMPOSTA
-- `(store_id, organization_id) → stores (id, organization_id)`: uma Store de outra Organization não entra (com
-- store_id NULL a FK não checa nada, que é o comportamento pedido).
--
-- ── O que fica na linha ──────────────────────────────────────────────────────────────────────
-- `snapshot` é o FeedbackSnapshot do core, calculado do PLANO persistido (o Node não recalcula nada). As colunas
-- abaixo são cópias do que as consultas filtram e agrupam, para não abrir o JSON: ângulo, objetivo, modo, contexto,
-- interação, composição (`p2|child_6_9+father|playing`), produtos, pessoas, risco de pose. Só o snapshot manda; se
-- divergirem, o snapshot vale e a coluna é regravada no próximo upsert.
--
-- Aditiva e reversível: uma tabela nova; nada existente muda.

CREATE TABLE creative_feedback (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  store_id UUID,
  creative_id UUID NOT NULL,
  job_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('liked', 'disliked')),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  plan_schema_version INTEGER,
  compiler_version INTEGER,
  prompt_version INTEGER,
  angle TEXT,
  objective TEXT,
  mode TEXT,
  context_id TEXT,
  interaction TEXT,
  composition_key TEXT,
  product_ids TEXT[] NOT NULL DEFAULT '{}',
  people_count INTEGER CHECK (people_count IS NULL OR people_count >= 0),
  pose_risk TEXT CHECK (pose_risk IS NULL OR pose_risk IN ('low', 'medium', 'high')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_creative_feedback PRIMARY KEY (organization_id, id),
  -- Um veredito por pessoa e criativo. É a chave do upsert.
  CONSTRAINT uq_creative_feedback_pessoa UNIQUE (organization_id, creative_id, user_id),
  CONSTRAINT fk_creative_feedback_criativo FOREIGN KEY (organization_id, creative_id)
    REFERENCES creative_generations (organization_id, creative_id) ON DELETE CASCADE,
  CONSTRAINT fk_creative_feedback_job FOREIGN KEY (organization_id, job_id)
    REFERENCES creative_jobs (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_creative_feedback_store FOREIGN KEY (store_id, organization_id)
    REFERENCES stores (id, organization_id)
);

CREATE INDEX idx_creative_feedback_veredito ON creative_feedback (organization_id, verdict, updated_at DESC);
CREATE INDEX idx_creative_feedback_store ON creative_feedback (organization_id, store_id) WHERE store_id IS NOT NULL;
CREATE INDEX idx_creative_feedback_angle ON creative_feedback (organization_id, angle, verdict);
CREATE INDEX idx_creative_feedback_objective ON creative_feedback (organization_id, objective, verdict);
CREATE INDEX idx_creative_feedback_context ON creative_feedback (organization_id, context_id, verdict) WHERE context_id IS NOT NULL;
CREATE INDEX idx_creative_feedback_interaction ON creative_feedback (organization_id, interaction, verdict) WHERE interaction IS NOT NULL;
CREATE INDEX idx_creative_feedback_composition ON creative_feedback (organization_id, composition_key, verdict) WHERE composition_key IS NOT NULL;
CREATE INDEX idx_creative_feedback_products ON creative_feedback USING GIN (product_ids);

-- Mesma forma canônica das policies da Fase 1 (INV-07 compara o texto).
ALTER TABLE creative_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_feedback
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
