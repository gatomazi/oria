-- Fase 7 · reverte o onboarding. Organizations criadas por ele continuam (são dado de negócio);
-- só o estado de onboarding, os convites e as reservas de idempotência saem.
DROP FUNCTION IF EXISTS onboarding_consumir_convite(TEXT);
DROP FUNCTION IF EXISTS onboarding_emitir_convite(TEXT, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS onboarding_reservar_organizacao(UUID, TEXT, TEXT);
DROP TABLE IF EXISTS onboarding_idempotencia;
DROP TABLE IF EXISTS onboarding_invites;
DROP TABLE IF EXISTS onboarding_steps;
DROP TABLE IF EXISTS onboarding_sessions;
