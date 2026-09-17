-- Fase 5c · reverte o lease persistente (a versão anterior usa só a trava em memória).
DROP FUNCTION IF EXISTS job_lease_concluir(TEXT, UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS job_lease_adquirir(TEXT, UUID, TEXT, INTEGER);
DROP TABLE IF EXISTS job_leases;
