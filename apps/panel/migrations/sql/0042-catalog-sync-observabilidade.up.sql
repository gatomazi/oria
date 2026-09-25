-- Rodada "Observabilidade e controle do catalog sync" · achado real de dogfooding (Use Sul,
-- 2026-09-24): um sync que trava sem fechar o log fica "running" pra sempre — sem progresso visível
-- enquanto roda, e sem jeito de liberar a trava exceto esperar o TTL de 3h do lease ou mexer direto
-- no banco. Esta migration cobre as duas pontas:
--
--   1. pages_total: coluna nova, nullable — só preenchida quando o provider informa o total de
--      páginas na resposta (a Ink informa). Sem isso, a UI cai pro modo "contador sem percentual",
--      igual o card de backfill de pedidos já faz quando não sabe o total.
--   2. status 'cancelled': uma trava liberada na mão nunca deve virar 'failed' (soa como erro do
--      provider) nem 'success' — precisa do próprio rótulo.
--   3. job_lease_liberar_forcado: libera um lease IGNORANDO o dono (ao contrário de
--      job_lease_concluir, que só libera se `dono` bater — não serve aqui porque quem cancela pela
--      tela não é o processo dono do lease). Mesma trava de segurança das outras funções de lease:
--      SECURITY DEFINER, REVOKE ALL FROM PUBLIC, GRANT só pra role da aplicação (ver app-role.js —
--      em produção isso exige reaplicar o script OPS-14, não é automático pela migration).
--      Importante: isto NÃO mata o processo Node que ainda estiver rodando (não existe como fazer
--      isso via SQL) — só libera a trava pra um run novo poder começar. Se o processo antigo ainda
--      estiver vivo, ele fecha o PRÓPRIO log row (mesmo sync_run_id) quando terminar sozinho — nunca
--      conflita com o run novo, que nasce com outro sync_run_id.

ALTER TABLE commerce_catalog_sync_logs
  ADD COLUMN pages_total INTEGER CHECK (pages_total IS NULL OR pages_total >= 0);

ALTER TABLE commerce_catalog_sync_logs DROP CONSTRAINT commerce_catalog_sync_logs_status_check;
ALTER TABLE commerce_catalog_sync_logs ADD CONSTRAINT commerce_catalog_sync_logs_status_check
  CHECK (status IN ('running', 'success', 'partial_failure', 'failed', 'cancelled'));

CREATE FUNCTION job_lease_liberar_forcado(p_job TEXT, p_org UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE ok BOOLEAN;
BEGIN
  UPDATE public.job_leases
     SET dono = NULL, ate = now()
   WHERE job = p_job AND organization_id = p_org AND ate >= now()
  RETURNING true INTO ok;
  RETURN COALESCE(ok, false);
END
$fn$;

REVOKE ALL ON FUNCTION job_lease_liberar_forcado(TEXT, UUID) FROM PUBLIC;
