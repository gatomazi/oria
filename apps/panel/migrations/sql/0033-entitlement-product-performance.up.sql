-- Fase H (rodada H→I) · entitlement `analytics_product_performance` — mesmo padrão da 0024
-- (composição do plano `internal`): o domain `platform_feature` só CRESCE, e a feature entra no
-- plano `internal` — nunca em todas as Organizations por conveniência de teste. Piloto real usa a
-- mesma via de concessão já adotada (plan_features do plano da Organization).
--
-- Diferente de meta_ads/google_ads/analytics_ga4 (0024, que entraram como `sem_guard` — capacidade
-- reconhecida sem rota ligada ainda), esta feature nasce com o guard REAL: `feature-routes.js` já
-- amarra `/api/admin/product-analytics` a ela no mesmo commit desta migration.

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
    'creative_multi_product',
    'analytics_product_performance'
  ));

INSERT INTO plan_features (plan_id, feature, habilitada)
SELECT p.id, 'analytics_product_performance'::platform_feature, true
  FROM plans p
 WHERE p.chave = 'internal'
ON CONFLICT DO NOTHING;
