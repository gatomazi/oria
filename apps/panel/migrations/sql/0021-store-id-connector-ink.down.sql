-- Desfaz a 0021, devolvendo `loja` às chaves.
--
-- Só é possível se TODA linha ainda tiver a chave legada. Linha de cliente nativo do Oria não tem
-- (é o ponto da migration), e o schema antigo não sabe representá-la: descer ali significaria
-- apagar o dado para ele caber. Então a migration recusa, explicando — em vez de destruir.
DO $ck$
DECLARE sem_loja INTEGER;
BEGIN
  SELECT (SELECT count(*) FROM pedidos_ink WHERE loja IS NULL)
       + (SELECT count(*) FROM pedidos_ink_itens WHERE loja IS NULL)
       + (SELECT count(*) FROM sync_estado WHERE loja IS NULL)
    INTO sem_loja;
  IF sem_loja > 0 THEN
    RAISE EXCEPTION 'há % linha(s) sem loja legada (cliente nativo do Oria): descer a 0021 exigiria apagá-las', sem_loja;
  END IF;
END
$ck$;

ALTER TABLE sync_estado DROP CONSTRAINT IF EXISTS ck_sync_estado_store_ou_loja;
ALTER TABLE pedidos_ink_itens DROP CONSTRAINT IF EXISTS ck_pedidos_ink_itens_store_ou_loja;
ALTER TABLE pedidos_ink DROP CONSTRAINT IF EXISTS ck_pedidos_ink_store_ou_loja;
ALTER TABLE webhook_eventos DROP CONSTRAINT IF EXISTS ck_webhook_eventos_store_ou_loja;

DROP INDEX IF EXISTS idx_pedidos_ink_store;
DROP INDEX IF EXISTS idx_webhook_eventos_store;

ALTER TABLE sync_estado DROP CONSTRAINT IF EXISTS fk_sync_estado_store;
ALTER TABLE pedidos_ink_itens DROP CONSTRAINT IF EXISTS fk_pedidos_ink_itens_store;
ALTER TABLE pedidos_ink DROP CONSTRAINT IF EXISTS fk_pedidos_ink_store;
ALTER TABLE webhook_eventos DROP CONSTRAINT IF EXISTS fk_webhook_eventos_store;

ALTER TABLE sync_estado ALTER COLUMN loja SET NOT NULL;
ALTER TABLE pedidos_ink_itens ALTER COLUMN loja SET NOT NULL;
ALTER TABLE pedidos_ink ALTER COLUMN loja SET NOT NULL;

DROP INDEX IF EXISTS uq_sync_estado_store;
ALTER TABLE sync_estado DROP CONSTRAINT sync_estado_pkey;
ALTER TABLE sync_estado DROP COLUMN id;
ALTER TABLE sync_estado ADD CONSTRAINT uq_sync_estado_org PRIMARY KEY USING INDEX uq_sync_estado_org;

DROP INDEX IF EXISTS uq_pedidos_ink_itens_store;
ALTER TABLE pedidos_ink_itens DROP CONSTRAINT pedidos_ink_itens_pkey;
ALTER TABLE pedidos_ink_itens DROP COLUMN id;
ALTER TABLE pedidos_ink_itens ADD CONSTRAINT uq_pedidos_ink_itens_org PRIMARY KEY USING INDEX uq_pedidos_ink_itens_org;

DROP INDEX IF EXISTS uq_pedidos_ink_store;

ALTER TABLE sync_estado DROP COLUMN IF EXISTS store_id;
ALTER TABLE pedidos_ink_itens DROP COLUMN IF EXISTS store_id;
ALTER TABLE pedidos_ink DROP COLUMN IF EXISTS store_id;
ALTER TABLE webhook_eventos DROP COLUMN IF EXISTS store_id;

ALTER TABLE stores DROP CONSTRAINT IF EXISTS uq_stores_id_organization;
