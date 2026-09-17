-- Fase 1 · triggers transitórios de organization_id (saem na Fase 3)
-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.
-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.

CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON bulk_category_jobs
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON controle_estoque_observacoes
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON despesas_operacionais
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON estoque_observacoes
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON ga4_performance_cache
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON google_analytics_connections
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON pedidos_backfill_jobs
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON pedidos_ink
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON pedidos_ink_itens
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON produtos_feed
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON produtos_feed_sync
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON produtos_ink
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON produtos_ink_sync
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON sync_estado
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON utm_campaigns
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON origens_migration_city_uf_map
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON origens_migration_rules
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON origens_migration_simulations
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja_ou_sem_loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON media_assets
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja_ou_sem_loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON webhook_eventos
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja_ou_sem_loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON whatsapp_web_outbox
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('loja_ou_sem_loja');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON bulk_category_job_items
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('pai', 'bulk_category_jobs', 'job_id');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('pai', 'campaigns', 'campaign_id');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON origens_migration_simulation_items
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('pai', 'origens_migration_simulations', 'simulation_id');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON integration_secrets
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('pai', 'integrations', 'integration_id');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('integracao');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON app_config
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('instalacao');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON custos_api_precos
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('instalacao');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON segments
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('instalacao');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON utm_presets
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('instalacao');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON whatsapp_web_mensagens
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('instalacao');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_connections
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_ad_accounts
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_campaigns
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_adsets
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_ads
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_creatives
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_insights_daily
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON meta_sync_logs
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('meta');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON google_ads_connections
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('google_ads');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON google_ads_customers
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('google_ads');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON google_ads_campaigns
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('google_ads');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON google_ads_insights_daily
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('google_ads');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON google_ads_sync_logs
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('google_ads');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_settings
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_brand_profiles
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_niche_profiles
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_context_profiles
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_personas
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_products
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_jobs
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_generations
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
CREATE TRIGGER tenancy_organization BEFORE INSERT OR UPDATE ON creative_assets
  FOR EACH ROW EXECUTE FUNCTION tenancy_preencher_organization('creative');
