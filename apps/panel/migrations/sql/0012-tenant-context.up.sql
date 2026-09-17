-- Fase 3 · Organization ativa na sessão + resolvedores estreitos para caminhos sem sessão.
--
-- A Organization de uma request de negócio vem SOMENTE de sessions.active_organization_id,
-- gravada pelo servidor depois de validar o membership (lib/auth/router.js). Os resolvedores abaixo
-- são SECURITY DEFINER porque rodam antes de existir contexto (jobs, webhooks, links públicos) e as
-- tabelas que consultam estão sob RLS forçada. Cada um devolve UMA Organization ou nada — nunca
-- "a única que existe"; ambiguidade devolve nada (fail-closed).

ALTER TABLE sessions
  ADD COLUMN active_organization_id UUID REFERENCES organizations (id) ON DELETE SET NULL;

-- Jobs: uma iteração por Organization ativa com Store ativa. É a lista que o scheduler percorre;
-- o trabalho de cada item roda dentro de comOrganization.
CREATE FUNCTION tenancy_organizations_para_jobs()
RETURNS TABLE (organization_id UUID, store_id UUID, loja_legada TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT o.id, s.id, s.loja_legada
    FROM public.organizations o
    JOIN public.stores s ON s.organization_id = o.id AND s.ativa
   WHERE o.status = 'active'
   ORDER BY o.id
$fn$;

-- Webhook da Ink ainda chega por loja legada (roteamento por token é TD-005 / Fase 5c).
CREATE FUNCTION tenancy_organization_da_loja(p_loja TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT m.organization_id FROM public.tenancy_mapeamentos m
    JOIN public.organizations o ON o.id = m.organization_id AND o.status = 'active'
   WHERE m.tipo = 'loja' AND m.chave = p_loja
$fn$;

-- Status de mensagem do WhatsApp chega pelo wamid da Meta (repasse do whatsapp-webhook-go).
CREATE FUNCTION tenancy_organization_do_wamid(p_wamid TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN count(DISTINCT organization_id) = 1 THEN min(organization_id::text)::uuid END
    FROM public.campaign_recipients
   WHERE provider_message_id = p_wamid
$fn$;

-- Link público de pedido (id de 72 bits) e de mídia (token de 192 bits): capability, não tenant do
-- cliente. Mais de um dono para o mesmo identificador = nada.
CREATE FUNCTION publico_organization_do_pedido(p_id TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN count(*) = 1 THEN min(organization_id::text)::uuid END
    FROM public.app_config
   WHERE chave = 'pedidos' AND jsonb_typeof(valor) = 'object' AND valor ? p_id
$fn$;

CREATE FUNCTION publico_organization_da_midia(p_token TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN count(*) = 1 THEN min(organization_id::text)::uuid END
    FROM public.media_assets
   WHERE public_token = p_token
$fn$;

-- Agente WhatsApp Web: o token é da Organization que o emitiu (B-15).
CREATE FUNCTION publico_organization_do_agente(p_hash TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN count(*) = 1 THEN min(organization_id::text)::uuid END
    FROM public.app_config
   WHERE chave = 'whatsapp-web-agente' AND valor ->> 'tokenHash' = p_hash
$fn$;

-- INV-22 · o tenant do Creative Core é a Organization autenticada. tenant_id deixa de ser um rótulo
-- da instalação (CREATIVE_TENANT_ID) e passa a ser o id da Organization dona, garantido por CHECK.
UPDATE creative_settings SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_brand_profiles SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_niche_profiles SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_context_profiles SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_personas SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_products SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_jobs SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_generations SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
UPDATE creative_assets SET tenant_id = organization_id::text WHERE tenant_id IS DISTINCT FROM organization_id::text;
ALTER TABLE creative_settings ADD CONSTRAINT ck_creative_settings_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_brand_profiles ADD CONSTRAINT ck_creative_brand_profiles_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_niche_profiles ADD CONSTRAINT ck_creative_niche_profiles_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_context_profiles ADD CONSTRAINT ck_creative_context_profiles_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_personas ADD CONSTRAINT ck_creative_personas_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_products ADD CONSTRAINT ck_creative_products_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_jobs ADD CONSTRAINT ck_creative_jobs_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_generations ADD CONSTRAINT ck_creative_generations_tenant_org CHECK (tenant_id = organization_id::text);
ALTER TABLE creative_assets ADD CONSTRAINT ck_creative_assets_tenant_org CHECK (tenant_id = organization_id::text);

REVOKE ALL ON FUNCTION tenancy_organizations_para_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy_organization_da_loja(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION tenancy_organization_do_wamid(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION publico_organization_do_pedido(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION publico_organization_da_midia(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION publico_organization_do_agente(TEXT) FROM PUBLIC;
