-- Fase D · Angles V2 — ângulos customizados por Organization/Store.
--
-- Ângulos SYSTEM (globais do Oria) NÃO moram aqui: ficam versionados em arquivo no core
-- (apps/creative-generator/creative_core/templates/angle_catalog_v2.json), servidos por `GET /v1/contracts`.
-- Esta tabela é só a metade tenant-owned da hierarquia (§4 da direção da Fase D): um ângulo próprio de uma
-- Organization (visível em todas as Stores dela) ou de uma Store (visível só nela). Resolução final
-- (system + organization + store) é feita na rota, nunca por nome — cada item tem identidade própria; não
-- existe override implícito.
--
-- ── Escopo ───────────────────────────────────────────────────────────────────────────────────
-- `scope` e `store_id` andam juntos por CHECK: `scope='organization'` ⇔ `store_id IS NULL`;
-- `scope='store'` ⇔ `store_id` aponta pra uma Store da MESMA Organization (FK composta). Sem override
-- implícito por nome: `slug` só precisa ser único DENTRO do próprio escopo (um slug de Organization e um de
-- Store podem coincidir, cada um é um ângulo próprio).
--
-- ── Por que o plano não quebra quando o ângulo é editado (§14) ─────────────────────────────────
-- O core roteia todo ângulo customizado para um `angle_id` LEGADO concreto (via `family`/`preset` —
-- `canonical_legacy_angle_id`, apps/creative-generator/creative_core/angle_catalog.py): esse id legado sozinho
-- já determina o prompt inteiro. O CreativePlan persiste o `angle_id` legado resolvido + `angle_recommendation`
-- (family/preset/scope/version no momento da geração) — editar o nome/descrição/family depois NÃO pode alterar
-- um prompt já gerado, porque nada na recompilação volta a ler esta tabela. `version` incrementa a cada UPDATE
-- só para o snapshot/histórico saber "isto foi gerado quando o ângulo estava na v1", nunca para recompilar.
--
-- Aditiva e reversível: uma tabela nova; nada existente muda.

CREATE TABLE creative_angles (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  store_id UUID,
  scope TEXT NOT NULL CHECK (scope IN ('organization', 'store')),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{1,59}$'),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  description TEXT,
  family TEXT NOT NULL CHECK (family IN (
    'lifestyle', 'connection', 'editorial_portrait', 'action_movement', 'product_focus', 'product_no_person', 'creator_social'
  )),
  people_mode TEXT NOT NULL CHECK (people_mode IN ('none', 'optional', 'required')),
  preset TEXT,
  -- Campos mais ricos (planner/prompt hints ainda em evolução — §5 "internamente pode ter campos mais ricos").
  -- O core não exige nada daqui hoje; só family/people_mode/preset são lidos por resolve_angle_meta.
  definition JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(definition) = 'object'),
  active BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_creative_angles PRIMARY KEY (organization_id, id),
  CONSTRAINT ck_creative_angles_scope_store CHECK ((scope = 'organization') = (store_id IS NULL)),
  CONSTRAINT fk_creative_angles_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id)
);

-- Unicidade de slug DENTRO do escopo (índices parciais: NULL não colide entre si por padrão, então uma
-- UNIQUE normal em (organization_id, store_id, slug) deixaria repetir slug de Organization à vontade).
CREATE UNIQUE INDEX uq_creative_angles_org_slug ON creative_angles (organization_id, slug) WHERE store_id IS NULL;
CREATE UNIQUE INDEX uq_creative_angles_store_slug ON creative_angles (organization_id, store_id, slug) WHERE store_id IS NOT NULL;

CREATE INDEX idx_creative_angles_org_family ON creative_angles (organization_id, family) WHERE active;
CREATE INDEX idx_creative_angles_store ON creative_angles (organization_id, store_id) WHERE store_id IS NOT NULL AND active;

-- Mesma forma canônica das policies da Fase 1 (INV-07 compara o texto).
ALTER TABLE creative_angles ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_angles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_angles
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
