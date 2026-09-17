-- Fase 1 · reverte plataforma
-- GERADO por scripts/tenancy/gerar-sql-fase1.mjs a partir de lib/platform/tenancy-manifest.js.
-- Congelado: edite o manifesto e regenere só se o desenho mudar ANTES do primeiro deploy.

DROP FUNCTION IF EXISTS tenancy_preencher_organization();
DROP FUNCTION IF EXISTS tenancy_org_do_mapeamento(TEXT, TEXT);
DROP TABLE IF EXISTS tenancy_mapeamentos;
DROP TABLE IF EXISTS organization_members;
DROP TABLE IF EXISTS stores;
DROP TABLE IF EXISTS organizations;
