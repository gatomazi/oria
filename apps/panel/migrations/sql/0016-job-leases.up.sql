-- Fase 5c · TD-006 / INV-18: lease persistente dos jobs por (job, Organization).
--
-- Várias réplicas do painel agendam os mesmos jobs. Antes de rodar a iteração de uma Organization,
-- a réplica pede o lease; só uma consegue. O lease vence sozinho (queda no meio) e guarda quando a
-- próxima execução pode começar — uma rodada por intervalo no cluster, não uma por réplica.
--
-- Tabela GLOBAL PRIVADA: a role da aplicação só passa pelas funções abaixo.
CREATE TABLE job_leases (
  job TEXT NOT NULL CHECK (job ~ '^[a-z0-9:_-]{1,80}$'),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  dono TEXT,
  iniciado_em TIMESTAMPTZ,
  ate TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  proxima_em TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  PRIMARY KEY (job, organization_id)
);

-- true = este dono tem o lease até now() + ttl.
CREATE FUNCTION job_lease_adquirir(p_job TEXT, p_org UUID, p_dono TEXT, p_ttl_ms INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE ok BOOLEAN;
BEGIN
  IF p_dono IS NULL OR btrim(p_dono) = '' OR p_ttl_ms IS NULL OR p_ttl_ms <= 0 THEN
    RAISE EXCEPTION 'lease inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.job_leases (job, organization_id) VALUES (p_job, p_org) ON CONFLICT DO NOTHING;
  UPDATE public.job_leases
     SET dono = p_dono, iniciado_em = now(), ate = now() + (p_ttl_ms * interval '1 millisecond')
   WHERE job = p_job AND organization_id = p_org AND ate < now() AND proxima_em <= now()
  RETURNING true INTO ok;
  RETURN COALESCE(ok, false);
END
$fn$;

-- Libera o lease (se ainda for deste dono) e marca a próxima janela: início + intervalo.
CREATE FUNCTION job_lease_concluir(p_job TEXT, p_org UUID, p_dono TEXT, p_intervalo_ms INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE ok BOOLEAN;
BEGIN
  UPDATE public.job_leases
     SET dono = NULL, ate = now(),
         proxima_em = COALESCE(iniciado_em, now()) + (GREATEST(p_intervalo_ms, 0) * interval '1 millisecond')
   WHERE job = p_job AND organization_id = p_org AND dono = p_dono
  RETURNING true INTO ok;
  RETURN COALESCE(ok, false);
END
$fn$;

REVOKE ALL ON FUNCTION job_lease_adquirir(TEXT, UUID, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION job_lease_concluir(TEXT, UUID, TEXT, INTEGER) FROM PUBLIC;
