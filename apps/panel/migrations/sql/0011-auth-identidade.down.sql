-- Fase 2 · reverte identidade individual.
DROP FUNCTION IF EXISTS auth_memberships(UUID);
DROP INDEX IF EXISTS idx_organization_members_user;
ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS ck_organization_members_papel;
ALTER TABLE organization_members DROP CONSTRAINT IF EXISTS fk_organization_members_user;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;
