-- Fase 4 · integrações por Organization.
--
-- As credenciais do cliente passam a morar em `integrations` + `integration_secrets` (TD-004), uma
-- integração por (Organization, provider). Duas tabelas GLOBAIS de plataforma entram aqui:
--
--   oauth_states              state de OAuth persistido, amarrado a pessoa, sessão e Organization.
--                             Guarda só o SHA-256 do state (o valor cru vai para o provider).
--   external_resource_claims  qual Organization possui cada recurso externo selecionado (conta de
--                             anúncios, customer do Google Ads, propriedade GA4). É global porque a
--                             pergunta é "alguém MAIS já tem isto?"; a role da aplicação não a lê:
--                             só as funções SECURITY DEFINER abaixo, sempre com a Organization do
--                             contexto (PD-016: sem compartilhamento entre Organizations na V1).

CREATE TABLE oauth_states (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'google_ads', 'ga4')),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  dados JSONB NOT NULL DEFAULT '{}'::jsonb,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  CHECK (expira_em > criado_em)
);
CREATE INDEX idx_oauth_states_expira ON oauth_states (expira_em);

CREATE TABLE external_resource_claims (
  provider TEXT NOT NULL,
  tipo TEXT NOT NULL,
  external_id TEXT NOT NULL CHECK (btrim(external_id) <> ''),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, tipo, external_id)
);
CREATE INDEX idx_external_resource_claims_org ON external_resource_claims (organization_id);

-- Organization do contexto; sem contexto é erro (nunca "a única que existe").
CREATE FUNCTION integracao_org_do_contexto() RETURNS UUID
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE org UUID := NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'integração: operação fora de um contexto de Organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN org;
END
$fn$;

-- true = o recurso é (agora) da Organization do contexto; false = outra Organization já o possui.
-- Nunca transfere posse.
CREATE FUNCTION integracao_reivindicar_recurso(p_provider TEXT, p_tipo TEXT, p_external_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  org UUID := public.integracao_org_do_contexto();
  dono UUID;
BEGIN
  INSERT INTO public.external_resource_claims (provider, tipo, external_id, organization_id)
  VALUES (p_provider, p_tipo, p_external_id, org)
  ON CONFLICT (provider, tipo, external_id) DO NOTHING;
  SELECT organization_id INTO dono FROM public.external_resource_claims
   WHERE provider = p_provider AND tipo = p_tipo AND external_id = p_external_id;
  RETURN dono = org;
END
$fn$;

-- Libera recursos da Organization do contexto. Com p_external_id NULL, todos daquele tipo; com
-- p_tipo NULL, todos do provider. Recurso de outra Organization nunca é tocado.
CREATE FUNCTION integracao_liberar_recursos(p_provider TEXT, p_tipo TEXT, p_external_id TEXT)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  org UUID := public.integracao_org_do_contexto();
  n INTEGER;
BEGIN
  DELETE FROM public.external_resource_claims
   WHERE organization_id = org AND provider = p_provider
     AND (p_tipo IS NULL OR tipo = p_tipo)
     AND (p_external_id IS NULL OR external_id = p_external_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

REVOKE ALL ON FUNCTION integracao_org_do_contexto() FROM PUBLIC;
REVOKE ALL ON FUNCTION integracao_reivindicar_recurso(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION integracao_liberar_recursos(TEXT, TEXT, TEXT) FROM PUBLIC;

-- Posse dos recursos que JÁ estão selecionados. Uma instalação com o mesmo recurso selecionado por
-- duas Organizations é conflito explícito: a migration falha em vez de escolher uma.
INSERT INTO external_resource_claims (provider, tipo, external_id, organization_id)
SELECT 'meta', 'ad_account', meta_account_id, organization_id FROM meta_ad_accounts WHERE selecionada;
INSERT INTO external_resource_claims (provider, tipo, external_id, organization_id)
SELECT 'google_ads', 'customer', customer_id, organization_id FROM google_ads_customers WHERE selecionada;
INSERT INTO external_resource_claims (provider, tipo, external_id, organization_id)
SELECT 'ga4', 'property', property_id, organization_id FROM google_analytics_connections WHERE property_id IS NOT NULL;
