-- Fase 1 · organizations, stores, organization_members, mapeamento legado
-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.
-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.

CREATE TABLE organizations (
  id UUID PRIMARY KEY,
  nome TEXT NOT NULL CHECK (btrim(nome) <> ''),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- V1 (PD-002): 1 Organization = 1 Store. A UNIQUE em organization_id É a regra de cardinalidade.
-- Store continua entidade própria; multi-store não existe na V1 (R-02).
CREATE TABLE stores (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  nome TEXT NOT NULL CHECK (btrim(nome) <> ''),
  -- Chave do enum antigo (sul/centro/norte) quando a Store nasceu de uma loja legada.
  loja_legada TEXT UNIQUE,
  ativa BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stores_organization UNIQUE (organization_id)
);

-- Usuários individuais (PD-004). A tabela users e a FK chegam na Fase 2; papéis seguem OPEN.
CREATE TABLE organization_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  papel TEXT NOT NULL DEFAULT 'member',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_organization_members_user UNIQUE (organization_id, user_id)
);

-- Declaração explícita de dono do dado legado. Global, sem RLS, sem acesso da role da aplicação:
-- só o trigger (SECURITY DEFINER) e o backfill leem. PK (tipo, chave) torna "a mesma chave com dois
-- donos" impossível de gravar.
CREATE TABLE tenancy_mapeamentos (
  tipo TEXT NOT NULL CHECK (tipo IN ('loja', 'sem_loja', 'creative_tenant', 'instalacao', 'meta', 'google_ads')),
  chave TEXT NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE RESTRICT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tipo, chave),
  CHECK ((tipo IN ('instalacao', 'meta', 'google_ads')) = (chave = '*'))
);

CREATE FUNCTION tenancy_org_do_mapeamento(p_tipo TEXT, p_chave TEXT) RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT organization_id FROM public.tenancy_mapeamentos WHERE tipo = p_tipo AND chave = p_chave
$fn$;

-- Compatibilidade TRANSITÓRIA: o código grava sem organization_id. Este trigger usa a Organization
-- do contexto (set_config local, Fase 3) e, fora de contexto (migration, operador), o mapeamento
-- explícito — nunca "o único que existe" — e recusa a gravação quando não há regra. Quando o valor vem explícito, confere as regras que são FATO (loja e tenant do
-- Creative Core) e rejeita divergência; para linha-filha, quem confere é a FK composta. Sai quando todo INSERT passar a informar a Organization do
-- contexto (Fase 3).
CREATE FUNCTION tenancy_preencher_organization() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  regra TEXT := TG_ARGV[0];
  dado JSONB := to_jsonb(NEW);
  explicito BOOLEAN;
  contexto UUID := NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
  esperado UUID;
  chave TEXT;
  rotulo TEXT;
BEGIN
  -- Sob contexto de Organization (request ou job da Fase 3), a linha é dela: o valor do contexto
  -- entra como se tivesse sido informado, e as conferências abaixo continuam valendo.
  IF NEW.organization_id IS NULL AND contexto IS NOT NULL THEN
    NEW.organization_id := contexto;
  END IF;
  explicito := NEW.organization_id IS NOT NULL;

  IF regra IN ('loja', 'loja_ou_sem_loja', 'integracao') THEN
    chave := dado ->> CASE WHEN regra = 'integracao' THEN 'escopo' ELSE 'loja' END;
    rotulo := 'loja:' || coalesce(chave, 'NULL');
    IF chave IS NOT NULL THEN
      esperado := public.tenancy_org_do_mapeamento('loja', chave);
      IF explicito AND esperado IS NOT NULL AND esperado <> NEW.organization_id THEN
        RAISE EXCEPTION 'tenancy: %.organization_id % diverge do dono da loja % (%)',
          TG_TABLE_NAME, NEW.organization_id, chave, esperado USING ERRCODE = 'check_violation';
      END IF;
    ELSIF regra = 'loja_ou_sem_loja' AND NOT explicito THEN
      rotulo := 'sem_loja:' || TG_TABLE_NAME;
      esperado := public.tenancy_org_do_mapeamento('sem_loja', TG_TABLE_NAME);
    END IF;
  ELSIF regra = 'pai' THEN
    rotulo := TG_ARGV[1] || '.' || coalesce(dado ->> TG_ARGV[2], 'NULL');
    -- Com dono explícito, a FK composta (organization_id, <fk>) garante que o pai é da mesma
    -- Organization. Sem dono, herda do pai — e o pai precisa ser ÚNICO: STRICT falha fechado se
    -- achar zero ou mais de uma linha, nunca "pega a primeira".
    IF NOT explicito THEN
      BEGIN
        EXECUTE format('SELECT organization_id FROM public.%I WHERE id = $1', TG_ARGV[1])
          INTO STRICT esperado USING (dado ->> TG_ARGV[2])::BIGINT;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          RAISE EXCEPTION 'tenancy: %: linha-pai % inexistente', TG_TABLE_NAME, rotulo
            USING ERRCODE = 'foreign_key_violation';
        WHEN TOO_MANY_ROWS THEN
          RAISE EXCEPTION 'tenancy: %: linha-pai % ambígua entre Organizations — informe organization_id',
            TG_TABLE_NAME, rotulo USING ERRCODE = 'check_violation';
      END;
    END IF;
  ELSIF regra IN ('instalacao', 'meta', 'google_ads') THEN
    rotulo := regra || ':*';
    IF NOT explicito THEN esperado := public.tenancy_org_do_mapeamento(regra, '*'); END IF;
  ELSIF regra = 'creative' THEN
    rotulo := 'creative_tenant:' || coalesce(dado ->> 'tenant_id', 'NULL');
    esperado := public.tenancy_org_do_mapeamento('creative_tenant', dado ->> 'tenant_id');
    IF explicito AND esperado IS NOT NULL AND esperado <> NEW.organization_id THEN
      RAISE EXCEPTION 'tenancy: %.organization_id % diverge do dono de % (%)',
        TG_TABLE_NAME, NEW.organization_id, rotulo, esperado USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'tenancy: regra desconhecida % em %', regra, TG_TABLE_NAME;
  END IF;

  IF NOT explicito THEN
    IF esperado IS NULL THEN
      RAISE EXCEPTION 'tenancy: % sem organization_id e sem mapeamento explícito para %',
        TG_TABLE_NAME, rotulo USING ERRCODE = 'not_null_violation';
    END IF;
    NEW.organization_id := esperado;
  END IF;
  RETURN NEW;
END
$fn$;
