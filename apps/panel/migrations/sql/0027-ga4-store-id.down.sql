-- Desfaz a 0027. Só é seguro enquanto nenhuma conexão/cache de Store nativa (sem chave legada)
-- existir: `loja` volta a ser obrigatória e apagar essas linhas seria perder dado. Recusa em vez de apagar.

DO $ck$
DECLARE sem_loja INTEGER;
BEGIN
  SELECT (SELECT count(*) FROM google_analytics_connections WHERE loja IS NULL)
       + (SELECT count(*) FROM ga4_performance_cache WHERE loja IS NULL)
    INTO sem_loja;
  IF sem_loja > 0 THEN
    RAISE EXCEPTION 'há % linha(s) de GA4 sem loja legada (cliente nativo do Oria): descer a 0027 exigiria apagá-las', sem_loja;
  END IF;
END
$ck$;

DROP INDEX IF EXISTS uq_ga4_performance_cache_store;
DROP INDEX IF EXISTS uq_google_analytics_connections_store;

ALTER TABLE ga4_performance_cache DROP CONSTRAINT IF EXISTS ck_ga4_performance_cache_store_ou_loja;
ALTER TABLE google_analytics_connections DROP CONSTRAINT IF EXISTS ck_google_analytics_connections_store_ou_loja;

ALTER TABLE ga4_performance_cache DROP CONSTRAINT IF EXISTS fk_ga4_performance_cache_store;
ALTER TABLE google_analytics_connections DROP CONSTRAINT IF EXISTS fk_google_analytics_connections_store;

ALTER TABLE ga4_performance_cache ALTER COLUMN loja SET NOT NULL;
ALTER TABLE google_analytics_connections ALTER COLUMN loja SET NOT NULL;

ALTER TABLE ga4_performance_cache DROP COLUMN IF EXISTS store_id;
ALTER TABLE google_analytics_connections DROP COLUMN IF EXISTS store_id;
