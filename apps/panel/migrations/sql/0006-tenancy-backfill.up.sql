-- Fase 1 · backfill determinístico por mapeamento explícito
-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.
-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.

SELECT tenancy_exigir_cobertura();

UPDATE bulk_category_jobs t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE campaigns t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE controle_estoque_observacoes t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE despesas_operacionais t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE estoque_observacoes t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE ga4_performance_cache t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE google_analytics_connections t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE pedidos_backfill_jobs t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE pedidos_ink t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE pedidos_ink_itens t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE produtos_feed t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE produtos_feed_sync t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE produtos_ink t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE produtos_ink_sync t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE sync_estado t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE utm_campaigns t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE origens_migration_city_uf_map t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE origens_migration_rules t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE origens_migration_simulations t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE audit_log t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE audit_log t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'audit_log';
UPDATE media_assets t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE media_assets t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'media_assets';
UPDATE webhook_eventos t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE webhook_eventos t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'webhook_eventos';
UPDATE whatsapp_web_outbox t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja;
UPDATE whatsapp_web_outbox t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'whatsapp_web_outbox';
UPDATE integrations t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'loja' AND mp.chave = t.escopo;
UPDATE app_config t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'instalacao' AND mp.chave = '*';
UPDATE custos_api_precos t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'instalacao' AND mp.chave = '*';
UPDATE segments t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'instalacao' AND mp.chave = '*';
UPDATE utm_presets t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'instalacao' AND mp.chave = '*';
UPDATE whatsapp_web_mensagens t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'instalacao' AND mp.chave = '*';
UPDATE meta_connections t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE meta_ad_accounts t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE meta_campaigns t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE meta_adsets t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE meta_ads t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE meta_creatives t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE meta_insights_daily t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE meta_sync_logs t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'meta' AND mp.chave = '*';
UPDATE google_ads_connections t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'google_ads' AND mp.chave = '*';
UPDATE google_ads_customers t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'google_ads' AND mp.chave = '*';
UPDATE google_ads_campaigns t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'google_ads' AND mp.chave = '*';
UPDATE google_ads_insights_daily t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'google_ads' AND mp.chave = '*';
UPDATE google_ads_sync_logs t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'google_ads' AND mp.chave = '*';
UPDATE creative_settings t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_brand_profiles t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_niche_profiles t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_context_profiles t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_personas t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_products t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_jobs t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_generations t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE creative_assets t SET organization_id = mp.organization_id FROM tenancy_mapeamentos mp
 WHERE t.organization_id IS NULL AND mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id;
UPDATE bulk_category_job_items t SET organization_id = p.organization_id FROM bulk_category_jobs p
 WHERE t.organization_id IS NULL AND p.id = t.job_id;
UPDATE campaign_recipients t SET organization_id = p.organization_id FROM campaigns p
 WHERE t.organization_id IS NULL AND p.id = t.campaign_id;
UPDATE origens_migration_simulation_items t SET organization_id = p.organization_id FROM origens_migration_simulations p
 WHERE t.organization_id IS NULL AND p.id = t.simulation_id;
UPDATE integration_secrets t SET organization_id = p.organization_id FROM integrations p
 WHERE t.organization_id IS NULL AND p.id = t.integration_id;

-- Zero órfãos NÃO basta: cada linha precisa ter o dono que a regra explícita manda.
DO $check$
DECLARE
  n BIGINT;
  problemas TEXT[] := ARRAY(SELECT tenancy_problemas_de_ownership());
BEGIN
  SELECT count(*) INTO n FROM app_config t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'instalacao' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('app_config: ' || n || ' linha(s) fora do dono declarado instalacao:*'); END IF;
  SELECT count(*) INTO n FROM custos_api_precos t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'instalacao' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('custos_api_precos: ' || n || ' linha(s) fora do dono declarado instalacao:*'); END IF;
  SELECT count(*) INTO n FROM segments t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'instalacao' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('segments: ' || n || ' linha(s) fora do dono declarado instalacao:*'); END IF;
  SELECT count(*) INTO n FROM utm_presets t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'instalacao' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('utm_presets: ' || n || ' linha(s) fora do dono declarado instalacao:*'); END IF;
  SELECT count(*) INTO n FROM whatsapp_web_mensagens t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'instalacao' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('whatsapp_web_mensagens: ' || n || ' linha(s) fora do dono declarado instalacao:*'); END IF;
  SELECT count(*) INTO n FROM meta_connections t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_connections: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM meta_ad_accounts t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_ad_accounts: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM meta_campaigns t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_campaigns: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM meta_adsets t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_adsets: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM meta_ads t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_ads: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM meta_creatives t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_creatives: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM meta_insights_daily t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_insights_daily: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM meta_sync_logs t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'meta' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('meta_sync_logs: ' || n || ' linha(s) fora do dono declarado meta:*'); END IF;
  SELECT count(*) INTO n FROM google_ads_connections t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'google_ads' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('google_ads_connections: ' || n || ' linha(s) fora do dono declarado google_ads:*'); END IF;
  SELECT count(*) INTO n FROM google_ads_customers t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'google_ads' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('google_ads_customers: ' || n || ' linha(s) fora do dono declarado google_ads:*'); END IF;
  SELECT count(*) INTO n FROM google_ads_campaigns t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'google_ads' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('google_ads_campaigns: ' || n || ' linha(s) fora do dono declarado google_ads:*'); END IF;
  SELECT count(*) INTO n FROM google_ads_insights_daily t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'google_ads' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('google_ads_insights_daily: ' || n || ' linha(s) fora do dono declarado google_ads:*'); END IF;
  SELECT count(*) INTO n FROM google_ads_sync_logs t
    LEFT JOIN tenancy_mapeamentos mp ON mp.tipo = 'google_ads' AND mp.chave = '*'
   WHERE t.organization_id IS DISTINCT FROM mp.organization_id;
  IF n > 0 THEN problemas := problemas || ('google_ads_sync_logs: ' || n || ' linha(s) fora do dono declarado google_ads:*'); END IF;
  IF cardinality(problemas) > 0 THEN
    RAISE EXCEPTION E'tenancy: backfill não confere com o mapeamento explícito:\n  - %',
      array_to_string(problemas, E'\n  - ');
  END IF;
END
$check$;
