-- Fase 5c · reverte a resolução por token. As URLs emitidas deixam de valer (a versão anterior usa
-- a URL única com o segredo por loja do ambiente).
DROP FUNCTION IF EXISTS ink_organization_do_webhook(TEXT);
DELETE FROM external_resource_claims WHERE provider = 'ink' AND tipo = 'webhook_token';
