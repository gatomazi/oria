-- Reversível: as tabelas são novas e nascem vazias (exceto o plano técnico `internal`, que é
-- semente da própria migration). Nada de dado legado depende delas.

DROP FUNCTION IF EXISTS platform_consumir_convite(TEXT, UUID);
DROP FUNCTION IF EXISTS platform_overview();
DROP FUNCTION IF EXISTS platform_listar_webhooks(UUID, BOOLEAN, INTEGER, TIMESTAMPTZ, BIGINT);
DROP FUNCTION IF EXISTS platform_listar_jobs(UUID, INTEGER, TEXT, UUID);
DROP FUNCTION IF EXISTS platform_listar_integracoes(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, BIGINT);
DROP FUNCTION IF EXISTS platform_onboarding_resumo(UUID);
DROP FUNCTION IF EXISTS platform_listar_passos(UUID);
DROP FUNCTION IF EXISTS platform_listar_onboardings(TEXT, INTEGER, TIMESTAMPTZ, UUID);
DROP FUNCTION IF EXISTS platform_listar_users(TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID);
DROP FUNCTION IF EXISTS platform_owners_ativos(UUID);
DROP FUNCTION IF EXISTS platform_listar_membros(UUID);
DROP FUNCTION IF EXISTS platform_organizations_ativas();
DROP FUNCTION IF EXISTS platform_organization_resumo(UUID);
DROP FUNCTION IF EXISTS platform_listar_organizations(TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID);
DROP FUNCTION IF EXISTS platform_bootstrap_reservar();

DROP TRIGGER IF EXISTS trg_platform_admin_ultimo_owner ON platform_admins;
DROP FUNCTION IF EXISTS platform_admin_proteger_ultimo_owner();
DROP FUNCTION IF EXISTS platform_admin_owners_ativos();

DROP TABLE IF EXISTS platform_audit_logs;
DROP TABLE IF EXISTS platform_organization_creations;
DROP TABLE IF EXISTS organization_owner_invites;
DROP TABLE IF EXISTS organization_entitlement_overrides;
DROP TABLE IF EXISTS organization_subscriptions;
DROP TABLE IF EXISTS plan_features;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS platform_admin_sessions;
DROP TABLE IF EXISTS platform_admins;

DROP DOMAIN IF EXISTS platform_feature;
