-- Fase 3 · reverte Organization ativa e resolvedores.
-- tenant_id volta ao rótulo declarado no mapeamento (creative_tenant) quando a Organization tem
-- exatamente um; sem rótulo único, fica o id da Organization — e o rollback da Fase 1 exige que o
-- operador o declare, em vez de adivinhar.
ALTER TABLE creative_settings DROP CONSTRAINT IF EXISTS ck_creative_settings_tenant_org;
ALTER TABLE creative_brand_profiles DROP CONSTRAINT IF EXISTS ck_creative_brand_profiles_tenant_org;
ALTER TABLE creative_niche_profiles DROP CONSTRAINT IF EXISTS ck_creative_niche_profiles_tenant_org;
ALTER TABLE creative_context_profiles DROP CONSTRAINT IF EXISTS ck_creative_context_profiles_tenant_org;
ALTER TABLE creative_personas DROP CONSTRAINT IF EXISTS ck_creative_personas_tenant_org;
ALTER TABLE creative_products DROP CONSTRAINT IF EXISTS ck_creative_products_tenant_org;
ALTER TABLE creative_jobs DROP CONSTRAINT IF EXISTS ck_creative_jobs_tenant_org;
ALTER TABLE creative_generations DROP CONSTRAINT IF EXISTS ck_creative_generations_tenant_org;
ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS ck_creative_assets_tenant_org;
UPDATE creative_settings t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_brand_profiles t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_niche_profiles t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_context_profiles t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_personas t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_products t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_jobs t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_generations t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
UPDATE creative_assets t SET tenant_id = m.chave
  FROM (SELECT organization_id, min(chave) AS chave FROM tenancy_mapeamentos
         WHERE tipo = 'creative_tenant' GROUP BY organization_id HAVING count(*) = 1) m
 WHERE m.organization_id = t.organization_id AND t.tenant_id = t.organization_id::text;
DROP FUNCTION IF EXISTS publico_organization_do_agente(TEXT);
DROP FUNCTION IF EXISTS publico_organization_da_midia(TEXT);
DROP FUNCTION IF EXISTS publico_organization_do_pedido(TEXT);
DROP FUNCTION IF EXISTS tenancy_organization_do_wamid(TEXT);
DROP FUNCTION IF EXISTS tenancy_organization_da_loja(TEXT);
DROP FUNCTION IF EXISTS tenancy_organizations_para_jobs();
ALTER TABLE sessions DROP COLUMN IF EXISTS active_organization_id;
