-- Fase 5c · TD-005: o webhook da Ink chega numa URL opaca por integração.
--
-- A URL carrega um token de 256 bits; no banco fica só o SHA-256 dele, registrado como recurso
-- externo da Organization (provider 'ink', tipo 'webhook_token') — dono único por construção (PK).
-- A entrada resolve a Organization por esse hash ANTES de olhar a assinatura, e depois confere a
-- assinatura contra o segredo DAQUELA integração. Nada de testar o segredo de cada loja.
CREATE FUNCTION ink_organization_do_webhook(p_hash TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT c.organization_id FROM public.external_resource_claims c
    JOIN public.organizations o ON o.id = c.organization_id AND o.status = 'active'
   WHERE c.provider = 'ink' AND c.tipo = 'webhook_token' AND c.external_id = p_hash
     AND p_hash ~ '^[0-9a-f]{64}$'
$fn$;

REVOKE ALL ON FUNCTION ink_organization_do_webhook(TEXT) FROM PUBLIC;
