-- Desfaz a 0023. O painel volta a depender de `app_config.entitlements`, que é o desenho de duas
-- fontes de verdade — por isso este down só existe para reversão de release, não como alternativa.
DROP FUNCTION IF EXISTS entitlements_efetivos(UUID);
DROP FUNCTION IF EXISTS entitlements_estado(UUID);
