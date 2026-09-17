-- Fase 1 · FK, NOT NULL, índices e UNIQUEs por Organization
-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.
-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.

-- bulk_category_jobs (loja)
ALTER TABLE bulk_category_jobs ADD CONSTRAINT fk_bulk_category_jobs_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE bulk_category_jobs ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_bulk_category_jobs_org ON bulk_category_jobs (organization_id);

-- campaigns (loja)
ALTER TABLE campaigns ADD CONSTRAINT fk_campaigns_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE campaigns ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_campaigns_org ON campaigns (organization_id);

-- controle_estoque_observacoes (loja)
ALTER TABLE controle_estoque_observacoes ADD CONSTRAINT fk_controle_estoque_observacoes_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE controle_estoque_observacoes ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_controle_estoque_observacoes_org ON controle_estoque_observacoes (organization_id);

-- despesas_operacionais (loja)
ALTER TABLE despesas_operacionais ADD CONSTRAINT fk_despesas_operacionais_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE despesas_operacionais ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_despesas_operacionais_org ON despesas_operacionais (organization_id);

-- estoque_observacoes (loja)
ALTER TABLE estoque_observacoes ADD CONSTRAINT fk_estoque_observacoes_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE estoque_observacoes ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_estoque_observacoes_org ON estoque_observacoes (organization_id);

-- ga4_performance_cache (loja)
ALTER TABLE ga4_performance_cache ADD CONSTRAINT fk_ga4_performance_cache_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE ga4_performance_cache ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_ga4_performance_cache_org ON ga4_performance_cache (organization_id);
CREATE UNIQUE INDEX uq_ga4_performance_cache_org ON ga4_performance_cache (organization_id, loja, periodo);

-- google_analytics_connections (loja)
ALTER TABLE google_analytics_connections ADD CONSTRAINT fk_google_analytics_connections_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE google_analytics_connections ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_google_analytics_connections_org ON google_analytics_connections (organization_id);
CREATE UNIQUE INDEX uq_google_analytics_connections_org ON google_analytics_connections (organization_id, loja);

-- pedidos_backfill_jobs (loja)
ALTER TABLE pedidos_backfill_jobs ADD CONSTRAINT fk_pedidos_backfill_jobs_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE pedidos_backfill_jobs ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_pedidos_backfill_jobs_org ON pedidos_backfill_jobs (organization_id);

-- pedidos_ink (loja)
ALTER TABLE pedidos_ink ADD CONSTRAINT fk_pedidos_ink_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE pedidos_ink ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_pedidos_ink_org ON pedidos_ink (organization_id);
CREATE UNIQUE INDEX uq_pedidos_ink_org ON pedidos_ink (organization_id, loja, ink_order_id);

-- pedidos_ink_itens (loja)
ALTER TABLE pedidos_ink_itens ADD CONSTRAINT fk_pedidos_ink_itens_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE pedidos_ink_itens ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_pedidos_ink_itens_org ON pedidos_ink_itens (organization_id);
CREATE UNIQUE INDEX uq_pedidos_ink_itens_org ON pedidos_ink_itens (organization_id, loja, item_id);

-- produtos_feed (loja)
ALTER TABLE produtos_feed ADD CONSTRAINT fk_produtos_feed_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE produtos_feed ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_produtos_feed_org ON produtos_feed (organization_id);
CREATE UNIQUE INDEX uq_produtos_feed_org ON produtos_feed (organization_id, loja, produto_id);

-- produtos_feed_sync (loja)
ALTER TABLE produtos_feed_sync ADD CONSTRAINT fk_produtos_feed_sync_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE produtos_feed_sync ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_produtos_feed_sync_org ON produtos_feed_sync (organization_id);
CREATE UNIQUE INDEX uq_produtos_feed_sync_org ON produtos_feed_sync (organization_id, loja);

-- produtos_ink (loja)
ALTER TABLE produtos_ink ADD CONSTRAINT fk_produtos_ink_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE produtos_ink ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_produtos_ink_org ON produtos_ink (organization_id);
CREATE UNIQUE INDEX uq_produtos_ink_org ON produtos_ink (organization_id, loja, produto_id);

-- produtos_ink_sync (loja)
ALTER TABLE produtos_ink_sync ADD CONSTRAINT fk_produtos_ink_sync_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE produtos_ink_sync ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_produtos_ink_sync_org ON produtos_ink_sync (organization_id);
CREATE UNIQUE INDEX uq_produtos_ink_sync_org ON produtos_ink_sync (organization_id, loja);

-- sync_estado (loja)
ALTER TABLE sync_estado ADD CONSTRAINT fk_sync_estado_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE sync_estado ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_sync_estado_org ON sync_estado (organization_id);
CREATE UNIQUE INDEX uq_sync_estado_org ON sync_estado (organization_id, loja);

-- utm_campaigns (loja)
ALTER TABLE utm_campaigns ADD CONSTRAINT fk_utm_campaigns_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE utm_campaigns ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_utm_campaigns_org ON utm_campaigns (organization_id);

-- origens_migration_city_uf_map (loja)
ALTER TABLE origens_migration_city_uf_map ADD CONSTRAINT fk_origens_migration_city_uf_map_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE origens_migration_city_uf_map ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_origens_migration_city_uf_map_org ON origens_migration_city_uf_map (organization_id);
CREATE UNIQUE INDEX uq_origens_city_uf_map_org ON origens_migration_city_uf_map (organization_id, loja, cidade_normalizada);

-- origens_migration_rules (loja)
ALTER TABLE origens_migration_rules ADD CONSTRAINT fk_origens_migration_rules_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE origens_migration_rules ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_origens_migration_rules_org ON origens_migration_rules (organization_id);

-- origens_migration_simulations (loja)
ALTER TABLE origens_migration_simulations ADD CONSTRAINT fk_origens_migration_simulations_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE origens_migration_simulations ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_origens_migration_simulations_org ON origens_migration_simulations (organization_id);

-- audit_log (loja_ou_sem_loja)
ALTER TABLE audit_log ADD CONSTRAINT fk_audit_log_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE audit_log ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_audit_log_org ON audit_log (organization_id);

-- media_assets (loja_ou_sem_loja)
ALTER TABLE media_assets ADD CONSTRAINT fk_media_assets_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE media_assets ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_media_assets_org ON media_assets (organization_id);
CREATE UNIQUE INDEX uq_media_assets_public_token_org ON media_assets (organization_id, public_token) WHERE public_token IS NOT NULL;

-- webhook_eventos (loja_ou_sem_loja)
ALTER TABLE webhook_eventos ADD CONSTRAINT fk_webhook_eventos_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE webhook_eventos ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_webhook_eventos_org ON webhook_eventos (organization_id);

-- whatsapp_web_outbox (loja_ou_sem_loja)
ALTER TABLE whatsapp_web_outbox ADD CONSTRAINT fk_whatsapp_web_outbox_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE whatsapp_web_outbox ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_whatsapp_web_outbox_org ON whatsapp_web_outbox (organization_id);
CREATE UNIQUE INDEX uq_wa_web_outbox_dedupe_org ON whatsapp_web_outbox (organization_id, dedupe_key) WHERE status IN ('aguardando_aprovacao', 'pending', 'claimed', 'sent', 'desconhecido');

-- bulk_category_job_items (pai)
ALTER TABLE bulk_category_job_items ADD CONSTRAINT fk_bulk_category_job_items_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE bulk_category_job_items ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_bulk_category_job_items_org ON bulk_category_job_items (organization_id);

-- campaign_recipients (pai)
ALTER TABLE campaign_recipients ADD CONSTRAINT fk_campaign_recipients_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE campaign_recipients ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_campaign_recipients_org ON campaign_recipients (organization_id);
CREATE UNIQUE INDEX uq_campaign_recipients_org ON campaign_recipients (organization_id, campaign_id, customer_key);

-- origens_migration_simulation_items (pai)
ALTER TABLE origens_migration_simulation_items ADD CONSTRAINT fk_origens_migration_simulation_items_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE origens_migration_simulation_items ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_origens_migration_simulation_items_org ON origens_migration_simulation_items (organization_id);

-- integration_secrets (pai)
ALTER TABLE integration_secrets ADD CONSTRAINT fk_integration_secrets_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE integration_secrets ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_integration_secrets_org ON integration_secrets (organization_id);
CREATE UNIQUE INDEX uq_integration_secrets_org ON integration_secrets (organization_id, integration_id, tipo);

-- integrations (integracao)
ALTER TABLE integrations ADD CONSTRAINT fk_integrations_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE integrations ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_integrations_org ON integrations (organization_id);

-- app_config (instalacao)
ALTER TABLE app_config ADD CONSTRAINT fk_app_config_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE app_config ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_app_config_org ON app_config (organization_id);
CREATE UNIQUE INDEX uq_app_config_org ON app_config (organization_id, chave);

-- custos_api_precos (instalacao)
ALTER TABLE custos_api_precos ADD CONSTRAINT fk_custos_api_precos_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE custos_api_precos ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_custos_api_precos_org ON custos_api_precos (organization_id);
CREATE UNIQUE INDEX uq_custos_api_precos_org ON custos_api_precos (organization_id, chave);

-- segments (instalacao)
ALTER TABLE segments ADD CONSTRAINT fk_segments_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE segments ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_segments_org ON segments (organization_id);

-- utm_presets (instalacao)
ALTER TABLE utm_presets ADD CONSTRAINT fk_utm_presets_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE utm_presets ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_utm_presets_org ON utm_presets (organization_id);

-- whatsapp_web_mensagens (instalacao)
ALTER TABLE whatsapp_web_mensagens ADD CONSTRAINT fk_whatsapp_web_mensagens_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE whatsapp_web_mensagens ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_whatsapp_web_mensagens_org ON whatsapp_web_mensagens (organization_id);
CREATE UNIQUE INDEX uq_wa_web_mensagens_nome_org ON whatsapp_web_mensagens (organization_id, lower(nome));

-- meta_connections (meta)
ALTER TABLE meta_connections ADD CONSTRAINT fk_meta_connections_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_connections ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_connections_org ON meta_connections (organization_id);
CREATE UNIQUE INDEX uq_meta_connections_org ON meta_connections (organization_id);
-- INV-06: deixa de ser uma linha por instalação.
ALTER TABLE meta_connections DROP CONSTRAINT meta_connections_id_check;
CREATE SEQUENCE meta_connections_id_seq AS SMALLINT START WITH 2 OWNED BY meta_connections.id;
SELECT setval('meta_connections_id_seq', GREATEST(2, (SELECT COALESCE(max(id), 0) + 1 FROM meta_connections)), false);
ALTER TABLE meta_connections ALTER COLUMN id SET DEFAULT nextval('meta_connections_id_seq');

-- meta_ad_accounts (meta)
ALTER TABLE meta_ad_accounts ADD CONSTRAINT fk_meta_ad_accounts_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_ad_accounts ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_ad_accounts_org ON meta_ad_accounts (organization_id);
CREATE UNIQUE INDEX uq_meta_ad_accounts_org ON meta_ad_accounts (organization_id, meta_account_id);
CREATE UNIQUE INDEX uq_meta_ad_accounts_selecionada_org ON meta_ad_accounts (organization_id) WHERE selecionada;

-- meta_campaigns (meta)
ALTER TABLE meta_campaigns ADD CONSTRAINT fk_meta_campaigns_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_campaigns ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_campaigns_org ON meta_campaigns (organization_id);
CREATE UNIQUE INDEX uq_meta_campaigns_org ON meta_campaigns (organization_id, meta_campaign_id);

-- meta_adsets (meta)
ALTER TABLE meta_adsets ADD CONSTRAINT fk_meta_adsets_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_adsets ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_adsets_org ON meta_adsets (organization_id);
CREATE UNIQUE INDEX uq_meta_adsets_org ON meta_adsets (organization_id, meta_adset_id);

-- meta_ads (meta)
ALTER TABLE meta_ads ADD CONSTRAINT fk_meta_ads_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_ads ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_ads_org ON meta_ads (organization_id);
CREATE UNIQUE INDEX uq_meta_ads_org ON meta_ads (organization_id, meta_ad_id);

-- meta_creatives (meta)
ALTER TABLE meta_creatives ADD CONSTRAINT fk_meta_creatives_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_creatives ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_creatives_org ON meta_creatives (organization_id);
CREATE UNIQUE INDEX uq_meta_creatives_org ON meta_creatives (organization_id, meta_creative_id);

-- meta_insights_daily (meta)
ALTER TABLE meta_insights_daily ADD CONSTRAINT fk_meta_insights_daily_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_insights_daily ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_insights_daily_org ON meta_insights_daily (organization_id);
CREATE UNIQUE INDEX uq_meta_insights_daily_org ON meta_insights_daily (organization_id, meta_account_id, level, entidade_id, data, attribution_setting);

-- meta_sync_logs (meta)
ALTER TABLE meta_sync_logs ADD CONSTRAINT fk_meta_sync_logs_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE meta_sync_logs ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_meta_sync_logs_org ON meta_sync_logs (organization_id);

-- google_ads_connections (google_ads)
ALTER TABLE google_ads_connections ADD CONSTRAINT fk_google_ads_connections_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE google_ads_connections ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_google_ads_connections_org ON google_ads_connections (organization_id);
CREATE UNIQUE INDEX uq_google_ads_connections_org ON google_ads_connections (organization_id);
-- INV-06: deixa de ser uma linha por instalação.
ALTER TABLE google_ads_connections DROP CONSTRAINT google_ads_connections_id_check;
CREATE SEQUENCE google_ads_connections_id_seq AS SMALLINT START WITH 2 OWNED BY google_ads_connections.id;
SELECT setval('google_ads_connections_id_seq', GREATEST(2, (SELECT COALESCE(max(id), 0) + 1 FROM google_ads_connections)), false);
ALTER TABLE google_ads_connections ALTER COLUMN id SET DEFAULT nextval('google_ads_connections_id_seq');

-- google_ads_customers (google_ads)
ALTER TABLE google_ads_customers ADD CONSTRAINT fk_google_ads_customers_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE google_ads_customers ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_google_ads_customers_org ON google_ads_customers (organization_id);
CREATE UNIQUE INDEX uq_google_ads_customers_org ON google_ads_customers (organization_id, customer_id);
CREATE UNIQUE INDEX uq_google_ads_customers_selecionada_org ON google_ads_customers (organization_id) WHERE selecionada;

-- google_ads_campaigns (google_ads)
ALTER TABLE google_ads_campaigns ADD CONSTRAINT fk_google_ads_campaigns_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE google_ads_campaigns ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_google_ads_campaigns_org ON google_ads_campaigns (organization_id);
CREATE UNIQUE INDEX uq_google_ads_campaigns_org ON google_ads_campaigns (organization_id, customer_id, campaign_id);

-- google_ads_insights_daily (google_ads)
ALTER TABLE google_ads_insights_daily ADD CONSTRAINT fk_google_ads_insights_daily_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE google_ads_insights_daily ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_google_ads_insights_daily_org ON google_ads_insights_daily (organization_id);
CREATE UNIQUE INDEX uq_google_ads_insights_daily_org ON google_ads_insights_daily (organization_id, customer_id, level, entidade_id, data, contagem_conversao);

-- google_ads_sync_logs (google_ads)
ALTER TABLE google_ads_sync_logs ADD CONSTRAINT fk_google_ads_sync_logs_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE google_ads_sync_logs ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_google_ads_sync_logs_org ON google_ads_sync_logs (organization_id);

-- creative_settings (creative)
ALTER TABLE creative_settings ADD CONSTRAINT fk_creative_settings_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_settings ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_settings_org ON creative_settings (organization_id);
CREATE UNIQUE INDEX uq_creative_settings_org ON creative_settings (organization_id);

-- creative_brand_profiles (creative)
ALTER TABLE creative_brand_profiles ADD CONSTRAINT fk_creative_brand_profiles_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_brand_profiles ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_brand_profiles_org ON creative_brand_profiles (organization_id);

-- creative_niche_profiles (creative)
ALTER TABLE creative_niche_profiles ADD CONSTRAINT fk_creative_niche_profiles_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_niche_profiles ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_niche_profiles_org ON creative_niche_profiles (organization_id);

-- creative_context_profiles (creative)
ALTER TABLE creative_context_profiles ADD CONSTRAINT fk_creative_context_profiles_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_context_profiles ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_context_profiles_org ON creative_context_profiles (organization_id);

-- creative_personas (creative)
ALTER TABLE creative_personas ADD CONSTRAINT fk_creative_personas_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_personas ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_personas_org ON creative_personas (organization_id);

-- creative_products (creative)
ALTER TABLE creative_products ADD CONSTRAINT fk_creative_products_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_products ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_products_org ON creative_products (organization_id);

-- creative_jobs (creative)
ALTER TABLE creative_jobs ADD CONSTRAINT fk_creative_jobs_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_jobs ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_jobs_org ON creative_jobs (organization_id);

-- creative_generations (creative)
ALTER TABLE creative_generations ADD CONSTRAINT fk_creative_generations_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_generations ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_generations_org ON creative_generations (organization_id);

-- creative_assets (creative)
ALTER TABLE creative_assets ADD CONSTRAINT fk_creative_assets_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT;
ALTER TABLE creative_assets ALTER COLUMN organization_id SET NOT NULL;
CREATE INDEX idx_creative_assets_org ON creative_assets (organization_id);
