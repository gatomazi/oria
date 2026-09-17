-- Fase 5c · reverte o resolvedor de entrada. A posse dos números (5b) fica; a das WABAs sai.
DROP FUNCTION IF EXISTS whatsapp_organization_do_remetente(TEXT, TEXT);
DELETE FROM external_resource_claims WHERE provider = 'whatsapp' AND tipo = 'waba';
