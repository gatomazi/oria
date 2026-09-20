-- Desfaz a 0025. Só é seguro enquanto nenhuma despesa ou campanha UTM de Store nativa (sem chave
-- legada) existir: `loja` volta a ser obrigatória e apagar essas linhas para conseguir descer seria
-- perder dado do cliente. A migration recusa em vez de apagar.

DO $ck$
DECLARE sem_loja INTEGER;
BEGIN
  SELECT (SELECT count(*) FROM despesas_operacionais WHERE loja IS NULL)
       + (SELECT count(*) FROM utm_campaigns WHERE loja IS NULL)
    INTO sem_loja;
  IF sem_loja > 0 THEN
    RAISE EXCEPTION 'há % despesa(s)/campanha(s) UTM sem loja legada (cliente nativo do Oria): descer a 0025 exigiria apagá-las', sem_loja;
  END IF;
END
$ck$;

DROP INDEX IF EXISTS idx_utm_campaigns_store;
DROP INDEX IF EXISTS idx_despesas_operacionais_store_data;
DROP INDEX IF EXISTS idx_google_ads_customers_store;
DROP INDEX IF EXISTS idx_meta_ad_accounts_store;

ALTER TABLE utm_campaigns DROP CONSTRAINT IF EXISTS ck_utm_campaigns_store_ou_loja;
ALTER TABLE despesas_operacionais DROP CONSTRAINT IF EXISTS ck_despesas_operacionais_store_ou_loja;

ALTER TABLE utm_campaigns ALTER COLUMN loja SET NOT NULL;
ALTER TABLE despesas_operacionais ALTER COLUMN loja SET NOT NULL;

ALTER TABLE utm_campaigns DROP CONSTRAINT IF EXISTS fk_utm_campaigns_store;
ALTER TABLE despesas_operacionais DROP CONSTRAINT IF EXISTS fk_despesas_operacionais_store;
ALTER TABLE google_ads_customers DROP CONSTRAINT IF EXISTS fk_google_ads_customers_store;
ALTER TABLE meta_ad_accounts DROP CONSTRAINT IF EXISTS fk_meta_ad_accounts_store;

ALTER TABLE utm_campaigns DROP COLUMN IF EXISTS store_id;
ALTER TABLE despesas_operacionais DROP COLUMN IF EXISTS store_id;
ALTER TABLE google_ads_customers DROP COLUMN IF EXISTS store_id;
ALTER TABLE meta_ad_accounts DROP COLUMN IF EXISTS store_id;
