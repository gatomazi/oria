-- Fase 1 · organization_id nullable + funções de verificação
-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.
-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.

ALTER TABLE bulk_category_jobs ADD COLUMN organization_id UUID;
ALTER TABLE campaigns ADD COLUMN organization_id UUID;
ALTER TABLE controle_estoque_observacoes ADD COLUMN organization_id UUID;
ALTER TABLE despesas_operacionais ADD COLUMN organization_id UUID;
ALTER TABLE estoque_observacoes ADD COLUMN organization_id UUID;
ALTER TABLE ga4_performance_cache ADD COLUMN organization_id UUID;
ALTER TABLE google_analytics_connections ADD COLUMN organization_id UUID;
ALTER TABLE pedidos_backfill_jobs ADD COLUMN organization_id UUID;
ALTER TABLE pedidos_ink ADD COLUMN organization_id UUID;
ALTER TABLE pedidos_ink_itens ADD COLUMN organization_id UUID;
ALTER TABLE produtos_feed ADD COLUMN organization_id UUID;
ALTER TABLE produtos_feed_sync ADD COLUMN organization_id UUID;
ALTER TABLE produtos_ink ADD COLUMN organization_id UUID;
ALTER TABLE produtos_ink_sync ADD COLUMN organization_id UUID;
ALTER TABLE sync_estado ADD COLUMN organization_id UUID;
ALTER TABLE utm_campaigns ADD COLUMN organization_id UUID;
ALTER TABLE origens_migration_city_uf_map ADD COLUMN organization_id UUID;
ALTER TABLE origens_migration_rules ADD COLUMN organization_id UUID;
ALTER TABLE origens_migration_simulations ADD COLUMN organization_id UUID;
ALTER TABLE audit_log ADD COLUMN organization_id UUID;
ALTER TABLE media_assets ADD COLUMN organization_id UUID;
ALTER TABLE webhook_eventos ADD COLUMN organization_id UUID;
ALTER TABLE whatsapp_web_outbox ADD COLUMN organization_id UUID;
ALTER TABLE bulk_category_job_items ADD COLUMN organization_id UUID;
ALTER TABLE campaign_recipients ADD COLUMN organization_id UUID;
ALTER TABLE origens_migration_simulation_items ADD COLUMN organization_id UUID;
ALTER TABLE app_config ADD COLUMN organization_id UUID;
ALTER TABLE custos_api_precos ADD COLUMN organization_id UUID;
ALTER TABLE segments ADD COLUMN organization_id UUID;
ALTER TABLE utm_presets ADD COLUMN organization_id UUID;
ALTER TABLE whatsapp_web_mensagens ADD COLUMN organization_id UUID;
ALTER TABLE meta_connections ADD COLUMN organization_id UUID;
ALTER TABLE meta_ad_accounts ADD COLUMN organization_id UUID;
ALTER TABLE meta_campaigns ADD COLUMN organization_id UUID;
ALTER TABLE meta_adsets ADD COLUMN organization_id UUID;
ALTER TABLE meta_ads ADD COLUMN organization_id UUID;
ALTER TABLE meta_creatives ADD COLUMN organization_id UUID;
ALTER TABLE meta_insights_daily ADD COLUMN organization_id UUID;
ALTER TABLE meta_sync_logs ADD COLUMN organization_id UUID;
ALTER TABLE google_ads_connections ADD COLUMN organization_id UUID;
ALTER TABLE google_ads_customers ADD COLUMN organization_id UUID;
ALTER TABLE google_ads_campaigns ADD COLUMN organization_id UUID;
ALTER TABLE google_ads_insights_daily ADD COLUMN organization_id UUID;
ALTER TABLE google_ads_sync_logs ADD COLUMN organization_id UUID;
ALTER TABLE creative_settings ADD COLUMN organization_id UUID;
ALTER TABLE creative_brand_profiles ADD COLUMN organization_id UUID;
ALTER TABLE creative_niche_profiles ADD COLUMN organization_id UUID;
ALTER TABLE creative_context_profiles ADD COLUMN organization_id UUID;
ALTER TABLE creative_personas ADD COLUMN organization_id UUID;
ALTER TABLE creative_products ADD COLUMN organization_id UUID;
ALTER TABLE creative_jobs ADD COLUMN organization_id UUID;
ALTER TABLE creative_generations ADD COLUMN organization_id UUID;
ALTER TABLE creative_assets ADD COLUMN organization_id UUID;

-- Itens que o dado existente exige que estejam mapeados e não estão. Vazio = cobertura completa.
-- NÃO existe ramo "há uma só Organization": com uma Organization, loja sem mapeamento continua
-- aparecendo aqui (INV-09).
CREATE FUNCTION tenancy_itens_sem_mapeamento() RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  RETURN QUERY
    WITH lojas AS (
      SELECT loja AS chave FROM bulk_category_jobs WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM campaigns WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM controle_estoque_observacoes WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM despesas_operacionais WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM estoque_observacoes WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM ga4_performance_cache WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM google_analytics_connections WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM pedidos_backfill_jobs WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM pedidos_ink WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM pedidos_ink_itens WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM produtos_feed WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM produtos_feed_sync WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM produtos_ink WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM produtos_ink_sync WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM sync_estado WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM utm_campaigns WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM origens_migration_city_uf_map WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM origens_migration_rules WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM origens_migration_simulations WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM audit_log WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM media_assets WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM webhook_eventos WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT loja AS chave FROM whatsapp_web_outbox WHERE organization_id IS NULL AND loja IS NOT NULL
      UNION SELECT escopo FROM integrations WHERE organization_id IS NULL AND escopo IS NOT NULL
    )
    SELECT 'loja:' || l.chave FROM lojas l
     WHERE NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos mp WHERE mp.tipo = 'loja' AND mp.chave = l.chave);
  RETURN QUERY SELECT 'sem_loja:audit_log'
    WHERE EXISTS (SELECT 1 FROM audit_log WHERE organization_id IS NULL AND loja IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'sem_loja' AND chave = 'audit_log');
  RETURN QUERY SELECT 'sem_loja:media_assets'
    WHERE EXISTS (SELECT 1 FROM media_assets WHERE organization_id IS NULL AND loja IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'sem_loja' AND chave = 'media_assets');
  RETURN QUERY SELECT 'sem_loja:webhook_eventos'
    WHERE EXISTS (SELECT 1 FROM webhook_eventos WHERE organization_id IS NULL AND loja IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'sem_loja' AND chave = 'webhook_eventos');
  RETURN QUERY SELECT 'sem_loja:whatsapp_web_outbox'
    WHERE EXISTS (SELECT 1 FROM whatsapp_web_outbox WHERE organization_id IS NULL AND loja IS NULL)
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'sem_loja' AND chave = 'whatsapp_web_outbox');
  RETURN QUERY SELECT 'instalacao:*'
    WHERE (EXISTS (SELECT 1 FROM app_config WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM custos_api_precos WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM segments WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM utm_presets WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM whatsapp_web_mensagens WHERE organization_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'instalacao' AND chave = '*');
  RETURN QUERY SELECT 'meta:*'
    WHERE (EXISTS (SELECT 1 FROM meta_connections WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM meta_ad_accounts WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM meta_campaigns WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM meta_adsets WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM meta_ads WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM meta_creatives WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM meta_insights_daily WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM meta_sync_logs WHERE organization_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'meta' AND chave = '*');
  RETURN QUERY SELECT 'google_ads:*'
    WHERE (EXISTS (SELECT 1 FROM google_ads_connections WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM google_ads_customers WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM google_ads_campaigns WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM google_ads_insights_daily WHERE organization_id IS NULL)
        OR EXISTS (SELECT 1 FROM google_ads_sync_logs WHERE organization_id IS NULL))
      AND NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos WHERE tipo = 'google_ads' AND chave = '*');
  RETURN QUERY
    WITH tenants AS (
      SELECT tenant_id FROM creative_settings WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_brand_profiles WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_niche_profiles WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_context_profiles WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_personas WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_products WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_jobs WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_generations WHERE organization_id IS NULL
      UNION SELECT tenant_id FROM creative_assets WHERE organization_id IS NULL
    )
    SELECT 'creative_tenant:' || t.tenant_id FROM tenants t
     WHERE NOT EXISTS (SELECT 1 FROM tenancy_mapeamentos mp WHERE mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id);
  RETURN QUERY SELECT 'integrations: linha sem organization_id e sem escopo — nenhuma regra a cobre'::TEXT
    WHERE EXISTS (SELECT 1 FROM integrations WHERE organization_id IS NULL AND escopo IS NULL);
END
$fn$;

CREATE FUNCTION tenancy_exigir_cobertura() RETURNS VOID
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $fn$
DECLARE faltando TEXT;
BEGIN
  SELECT string_agg(x, E'\n  - ' ORDER BY x) INTO faltando FROM tenancy_itens_sem_mapeamento() AS x;
  IF faltando IS NOT NULL THEN
    RAISE EXCEPTION E'tenancy: existe dado sem dono declarado. Nada foi atribuído por dedução.\n  - %', faltando
      USING HINT = 'Declare cada item no arquivo apontado por TENANCY_MAPPING_FILE (ver docs/produtizacao-saas/tenant-owned-tables.md).';
  END IF;
END
$fn$;

-- Problemas de ownership: linha sem organization_id, ou com dono diferente do que a regra
-- explícita manda. Regras que são FATO (loja, pai, tenant do Creative Core) valem sempre; as de
-- instalação só no backfill, e são conferidas lá.
CREATE FUNCTION tenancy_problemas_de_ownership() RETURNS SETOF TEXT
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE n BIGINT;
BEGIN
  SELECT count(*) INTO n FROM bulk_category_jobs WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'bulk_category_jobs: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM campaigns WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'campaigns: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM controle_estoque_observacoes WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'controle_estoque_observacoes: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM despesas_operacionais WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'despesas_operacionais: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM estoque_observacoes WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'estoque_observacoes: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM ga4_performance_cache WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'ga4_performance_cache: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM google_analytics_connections WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'google_analytics_connections: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM pedidos_backfill_jobs WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'pedidos_backfill_jobs: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM pedidos_ink WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'pedidos_ink: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM pedidos_ink_itens WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'pedidos_ink_itens: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM produtos_feed WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'produtos_feed: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM produtos_feed_sync WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'produtos_feed_sync: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM produtos_ink WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'produtos_ink: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM produtos_ink_sync WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'produtos_ink_sync: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM sync_estado WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'sync_estado: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM utm_campaigns WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'utm_campaigns: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM origens_migration_city_uf_map WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'origens_migration_city_uf_map: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM origens_migration_rules WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'origens_migration_rules: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM origens_migration_simulations WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'origens_migration_simulations: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM audit_log WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'audit_log: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM media_assets WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'media_assets: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM webhook_eventos WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'webhook_eventos: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM whatsapp_web_outbox WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'whatsapp_web_outbox: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM bulk_category_job_items WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'bulk_category_job_items: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM campaign_recipients WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'campaign_recipients: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM origens_migration_simulation_items WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'origens_migration_simulation_items: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM integration_secrets WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'integration_secrets: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM integrations WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'integrations: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM app_config WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'app_config: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM custos_api_precos WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'custos_api_precos: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM segments WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'segments: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM utm_presets WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'utm_presets: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM whatsapp_web_mensagens WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'whatsapp_web_mensagens: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_connections WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_connections: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_ad_accounts WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_ad_accounts: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_campaigns WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_campaigns: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_adsets WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_adsets: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_ads WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_ads: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_creatives WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_creatives: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_insights_daily WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_insights_daily: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM meta_sync_logs WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'meta_sync_logs: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM google_ads_connections WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'google_ads_connections: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM google_ads_customers WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'google_ads_customers: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM google_ads_campaigns WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'google_ads_campaigns: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM google_ads_insights_daily WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'google_ads_insights_daily: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM google_ads_sync_logs WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'google_ads_sync_logs: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_settings WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_settings: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_brand_profiles WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_brand_profiles: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_niche_profiles WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_niche_profiles: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_context_profiles WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_context_profiles: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_personas WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_personas: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_products WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_products: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_jobs WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_jobs: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_generations WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_generations: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM creative_assets WHERE organization_id IS NULL;
  IF n > 0 THEN RETURN NEXT 'creative_assets: ' || n || ' linha(s) sem organization_id'; END IF;
  SELECT count(*) INTO n FROM bulk_category_jobs t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'bulk_category_jobs: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM campaigns t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'campaigns: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM controle_estoque_observacoes t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'controle_estoque_observacoes: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM despesas_operacionais t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'despesas_operacionais: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM estoque_observacoes t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'estoque_observacoes: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM ga4_performance_cache t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'ga4_performance_cache: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM google_analytics_connections t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'google_analytics_connections: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM pedidos_backfill_jobs t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'pedidos_backfill_jobs: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM pedidos_ink t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'pedidos_ink: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM pedidos_ink_itens t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'pedidos_ink_itens: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM produtos_feed t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'produtos_feed: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM produtos_feed_sync t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'produtos_feed_sync: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM produtos_ink t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'produtos_ink: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM produtos_ink_sync t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'produtos_ink_sync: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM sync_estado t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'sync_estado: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM utm_campaigns t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'utm_campaigns: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM origens_migration_city_uf_map t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'origens_migration_city_uf_map: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM origens_migration_rules t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'origens_migration_rules: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM origens_migration_simulations t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.loja
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'origens_migration_simulations: ' || n || ' linha(s) com organization_id diferente da regra loja'; END IF;
  SELECT count(*) INTO n FROM audit_log t JOIN tenancy_mapeamentos mp
      ON (t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja)
      OR (t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'audit_log')
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'audit_log: ' || n || ' linha(s) com organization_id diferente da regra loja_ou_sem_loja'; END IF;
  SELECT count(*) INTO n FROM media_assets t JOIN tenancy_mapeamentos mp
      ON (t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja)
      OR (t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'media_assets')
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'media_assets: ' || n || ' linha(s) com organization_id diferente da regra loja_ou_sem_loja'; END IF;
  SELECT count(*) INTO n FROM webhook_eventos t JOIN tenancy_mapeamentos mp
      ON (t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja)
      OR (t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'webhook_eventos')
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'webhook_eventos: ' || n || ' linha(s) com organization_id diferente da regra loja_ou_sem_loja'; END IF;
  SELECT count(*) INTO n FROM whatsapp_web_outbox t JOIN tenancy_mapeamentos mp
      ON (t.loja IS NOT NULL AND mp.tipo = 'loja' AND mp.chave = t.loja)
      OR (t.loja IS NULL AND mp.tipo = 'sem_loja' AND mp.chave = 'whatsapp_web_outbox')
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'whatsapp_web_outbox: ' || n || ' linha(s) com organization_id diferente da regra loja_ou_sem_loja'; END IF;
  SELECT count(*) INTO n FROM bulk_category_job_items t JOIN bulk_category_jobs p ON p.id = t.job_id
    WHERE t.organization_id IS DISTINCT FROM p.organization_id;
  IF n > 0 THEN RETURN NEXT 'bulk_category_job_items: ' || n || ' linha(s) com organization_id diferente da regra pai'; END IF;
  SELECT count(*) INTO n FROM campaign_recipients t JOIN campaigns p ON p.id = t.campaign_id
    WHERE t.organization_id IS DISTINCT FROM p.organization_id;
  IF n > 0 THEN RETURN NEXT 'campaign_recipients: ' || n || ' linha(s) com organization_id diferente da regra pai'; END IF;
  SELECT count(*) INTO n FROM origens_migration_simulation_items t JOIN origens_migration_simulations p ON p.id = t.simulation_id
    WHERE t.organization_id IS DISTINCT FROM p.organization_id;
  IF n > 0 THEN RETURN NEXT 'origens_migration_simulation_items: ' || n || ' linha(s) com organization_id diferente da regra pai'; END IF;
  SELECT count(*) INTO n FROM integration_secrets t JOIN integrations p ON p.id = t.integration_id
    WHERE t.organization_id IS DISTINCT FROM p.organization_id;
  IF n > 0 THEN RETURN NEXT 'integration_secrets: ' || n || ' linha(s) com organization_id diferente da regra pai'; END IF;
  SELECT count(*) INTO n FROM integrations t JOIN tenancy_mapeamentos mp ON mp.tipo = 'loja' AND mp.chave = t.escopo
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'integrations: ' || n || ' linha(s) com organization_id diferente da regra integracao'; END IF;
  SELECT count(*) INTO n FROM creative_settings t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_settings: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_brand_profiles t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_brand_profiles: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_niche_profiles t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_niche_profiles: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_context_profiles t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_context_profiles: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_personas t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_personas: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_products t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_products: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_jobs t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_jobs: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_generations t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_generations: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
  SELECT count(*) INTO n FROM creative_assets t JOIN tenancy_mapeamentos mp ON mp.tipo = 'creative_tenant' AND mp.chave = t.tenant_id
    WHERE t.organization_id <> mp.organization_id;
  IF n > 0 THEN RETURN NEXT 'creative_assets: ' || n || ' linha(s) com organization_id diferente da regra creative'; END IF;
END
$fn$;
