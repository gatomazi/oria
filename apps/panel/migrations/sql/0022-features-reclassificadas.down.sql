-- Volta o plano `internal` ao conteúdo que a 0019 semeou.
--
-- Só o `internal` é restaurado, e só ele pode ser: as linhas apagadas em `plan_features` de
-- outros planos e os `organization_entitlement_overrides` apagados não são reconstrutíveis a partir de um
-- valor conhecido, e inventar linha de entitlement no down seria conceder acesso que ninguém
-- pediu. Hoje `internal` é o único plano semeado, então na prática o down é exato.

INSERT INTO plan_features (plan_id, feature, habilitada)
SELECT p.id, f, true FROM plans p, unnest(ARRAY[
  'catalog',
  'creative_clean_angles',
  'creative_funnel_visual',
  'creative_multi_product',
  'creative_remarketing',
  'exchanges',
  'refunds'
]::platform_feature[]) AS f
WHERE p.chave = 'internal'
ON CONFLICT DO NOTHING;
