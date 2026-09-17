-- Fase 5c · entrada multi-tenant do WhatsApp (PD-023 CLOSED: um processo e um Meta App da
-- plataforma para várias Organizations).
--
-- O webhook da Meta é autenticado pelo App Secret da plataforma; quem diz de QUAL Organization é o
-- evento é o par (WABA = entry.id, número = metadata.phone_number_id), confrontado com a posse
-- registrada em external_resource_claims (PD-016). A WABA passa a ter dono exclusivo, como o número.
--
-- O resolvedor roda sem contexto (o evento ainda não tem tenant) e por isso é SECURITY DEFINER. Não
-- existe "a única Organization", "a primeira integração" nem LIMIT 1: a PK da tabela de posse
-- garante no máximo um dono por identificador, e número de outra Organization é divergência.

CREATE FUNCTION whatsapp_organization_do_remetente(p_waba TEXT, p_phone TEXT)
RETURNS TABLE (organization_id UUID, motivo TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH waba AS (
    SELECT c.organization_id FROM public.external_resource_claims c
      JOIN public.organizations o ON o.id = c.organization_id AND o.status = 'active'
     WHERE c.provider = 'whatsapp' AND c.tipo = 'waba' AND c.external_id = p_waba
  ), numero AS (
    SELECT c.organization_id FROM public.external_resource_claims c
     WHERE p_phone IS NOT NULL
       AND c.provider = 'whatsapp' AND c.tipo = 'phone_number' AND c.external_id = p_phone
  )
  SELECT CASE WHEN resultado = 'ok' THEN (SELECT w.organization_id FROM waba w) END, resultado
    FROM (SELECT CASE
      WHEN NOT EXISTS (SELECT 1 FROM waba) THEN 'desconhecido'
      WHEN p_phone IS NULL THEN 'ok'
      WHEN NOT EXISTS (SELECT 1 FROM numero) THEN 'desconhecido'
      WHEN (SELECT n.organization_id FROM numero n) <> (SELECT w.organization_id FROM waba w) THEN 'divergente'
      ELSE 'ok'
    END AS resultado) r
$fn$;

REVOKE ALL ON FUNCTION whatsapp_organization_do_remetente(TEXT, TEXT) FROM PUBLIC;

-- Posse do que já está cadastrado (integrações da 5b). Sem ON CONFLICT de propósito: a mesma WABA ou
-- o mesmo número em duas Organizations faz a migration falhar, em vez de escolher uma.
INSERT INTO external_resource_claims (provider, tipo, external_id, organization_id)
SELECT 'whatsapp', 'waba', i.config ->> 'waba_id', i.organization_id
  FROM integrations i
 WHERE i.provider = 'whatsapp' AND i.escopo IS NULL AND COALESCE(i.config ->> 'waba_id', '') <> '';

INSERT INTO external_resource_claims (provider, tipo, external_id, organization_id)
SELECT 'whatsapp', 'phone_number', i.config ->> 'phone_number_id', i.organization_id
  FROM integrations i
 WHERE i.provider = 'whatsapp' AND i.escopo IS NULL AND COALESCE(i.config ->> 'phone_number_id', '') <> ''
   AND NOT EXISTS (
     SELECT 1 FROM external_resource_claims c
      WHERE c.provider = 'whatsapp' AND c.tipo = 'phone_number'
        AND c.external_id = i.config ->> 'phone_number_id' AND c.organization_id = i.organization_id
   );
