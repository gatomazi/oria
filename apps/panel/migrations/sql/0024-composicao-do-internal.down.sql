-- Desfaz a 0024: tira as três chaves novas de onde quer que estejam e devolve o domain ao
-- conjunto da 0019.
--
-- Apaga em TODOS os planos e em TODOS os overrides, não só no `internal`. É o inverso exato do
-- `up`: antes da 0024 o domain recusava estas chaves, então nenhuma linha com elas podia existir.
-- Qualquer uma que exista agora foi gravada depois (por exemplo, um plano novo criado pelo Oria
-- Admin) e, sem apagá-la, o ADD CONSTRAINT estreito abaixo falharia com a migration inteira
-- revertida — falha segura, mas que impede o down de fazer o que promete.
--
-- Não há o que restaurar: o `up` não apagou nada.

DELETE FROM organization_entitlement_overrides
 WHERE feature::text IN ('meta_ads', 'google_ads', 'analytics_ga4');

DELETE FROM plan_features
 WHERE feature::text IN ('meta_ads', 'google_ads', 'analytics_ga4');

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
    'creative_clean_angles',
    'creative_remarketing',
    'creative_funnel_visual',
    'creative_multi_product'
  ));
