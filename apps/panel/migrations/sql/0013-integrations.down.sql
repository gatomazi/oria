-- Fase 4 · reverte o registro de posse e o state persistido. `integrations`/`integration_secrets`
-- são da Fase 0 e ficam; os segredos importados continuam lá (a versão anterior lê as colunas
-- antigas, que o import não apaga).
DROP FUNCTION IF EXISTS integracao_liberar_recursos(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS integracao_reivindicar_recurso(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS integracao_org_do_contexto();
DROP TABLE IF EXISTS external_resource_claims;
DROP TABLE IF EXISTS oauth_states;
