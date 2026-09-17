-- Fase 1 · RLS habilitada e FORÇADA (TD-001)
-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.
-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.

-- Em produção o app continua na role atual até OPS-14 (ver plano, Fase 1): a role atual é
-- superusuário e ignora RLS. Sob a role oria_app (CI) estas policies valem integralmente.
ALTER TABLE bulk_category_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_category_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON bulk_category_jobs
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON campaigns
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE controle_estoque_observacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE controle_estoque_observacoes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON controle_estoque_observacoes
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE despesas_operacionais ENABLE ROW LEVEL SECURITY;
ALTER TABLE despesas_operacionais FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON despesas_operacionais
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE estoque_observacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE estoque_observacoes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON estoque_observacoes
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE ga4_performance_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ga4_performance_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON ga4_performance_cache
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE google_analytics_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_analytics_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON google_analytics_connections
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE pedidos_backfill_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos_backfill_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON pedidos_backfill_jobs
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE pedidos_ink ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos_ink FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON pedidos_ink
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE pedidos_ink_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos_ink_itens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON pedidos_ink_itens
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE produtos_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos_feed FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON produtos_feed
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE produtos_feed_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos_feed_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON produtos_feed_sync
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE produtos_ink ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos_ink FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON produtos_ink
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE produtos_ink_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos_ink_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON produtos_ink_sync
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE sync_estado ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_estado FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON sync_estado
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE utm_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE utm_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON utm_campaigns
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE origens_migration_city_uf_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE origens_migration_city_uf_map FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON origens_migration_city_uf_map
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE origens_migration_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE origens_migration_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON origens_migration_rules
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE origens_migration_simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE origens_migration_simulations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON origens_migration_simulations
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON audit_log
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON media_assets
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE webhook_eventos ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_eventos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON webhook_eventos
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE whatsapp_web_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_web_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON whatsapp_web_outbox
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE bulk_category_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_category_job_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON bulk_category_job_items
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON campaign_recipients
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE origens_migration_simulation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE origens_migration_simulation_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON origens_migration_simulation_items
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE integration_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON integration_secrets
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON integrations
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON app_config
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE custos_api_precos ENABLE ROW LEVEL SECURITY;
ALTER TABLE custos_api_precos FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON custos_api_precos
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE segments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON segments
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE utm_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE utm_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON utm_presets
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE whatsapp_web_mensagens ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_web_mensagens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON whatsapp_web_mensagens
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_connections
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_ad_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ad_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_ad_accounts
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_campaigns
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_adsets ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_adsets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_adsets
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_ads ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_ads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_ads
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_creatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_creatives FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_creatives
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_insights_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_insights_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_insights_daily
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE meta_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_sync_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON meta_sync_logs
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE google_ads_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_ads_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON google_ads_connections
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE google_ads_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_ads_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON google_ads_customers
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE google_ads_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_ads_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON google_ads_campaigns
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE google_ads_insights_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_ads_insights_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON google_ads_insights_daily
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE google_ads_sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_ads_sync_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON google_ads_sync_logs
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_settings
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_brand_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_brand_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_brand_profiles
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_niche_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_niche_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_niche_profiles
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_context_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_context_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_context_profiles
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_personas FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_personas
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_products
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_jobs
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_generations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_generations
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE creative_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE creative_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON creative_assets
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON organizations
  USING (id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON stores
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON organization_members
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
