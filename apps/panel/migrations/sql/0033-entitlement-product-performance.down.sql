-- Desfaz a 0033: mesmo padrão do down da 0024. Apaga em TODOS os planos e overrides (não só
-- `internal`) — é o inverso exato do `up`, que não apagou nada.

DELETE FROM organization_entitlement_overrides
 WHERE feature::text = 'analytics_product_performance';

DELETE FROM plan_features
 WHERE feature::text = 'analytics_product_performance';

ALTER DOMAIN platform_feature DROP CONSTRAINT platform_feature_check;
ALTER DOMAIN platform_feature ADD CONSTRAINT platform_feature_check
  CHECK (VALUE IN (
    'whatsapp',
    'instagram',
    'advancedAutomations',
    'catalog',
    'exchanges',
    'refunds',
    'financial',
    'creative_generator',
    'meta_ads',
    'google_ads',
    'analytics_ga4',
    'creative_clean_angles',
    'creative_remarketing',
    'creative_funnel_visual',
    'creative_multi_product'
  ));
