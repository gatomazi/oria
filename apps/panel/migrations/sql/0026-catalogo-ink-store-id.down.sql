-- Desfaz a 0026. Só é seguro enquanto nenhuma linha de Store nativa (sem chave legada) existir:
-- `loja` volta a ser obrigatória e apagar essas linhas para conseguir descer seria perder dado. A
-- migration recusa em vez de apagar.

DO $ck$
DECLARE sem_loja INTEGER;
BEGIN
  SELECT (SELECT count(*) FROM produtos_ink WHERE loja IS NULL)
       + (SELECT count(*) FROM produtos_ink_sync WHERE loja IS NULL)
       + (SELECT count(*) FROM bulk_category_jobs WHERE loja IS NULL)
       + (SELECT count(*) FROM pedidos_backfill_jobs WHERE loja IS NULL)
    INTO sem_loja;
  IF sem_loja > 0 THEN
    RAISE EXCEPTION 'há % linha(s) de catálogo sem loja legada (cliente nativo do Oria): descer a 0026 exigiria apagá-las', sem_loja;
  END IF;
END
$ck$;

DROP INDEX IF EXISTS idx_pedidos_backfill_jobs_store;
DROP INDEX IF EXISTS idx_bulk_category_jobs_store;
DROP INDEX IF EXISTS idx_produtos_ink_store;

ALTER TABLE pedidos_backfill_jobs DROP CONSTRAINT IF EXISTS ck_pedidos_backfill_jobs_store_ou_loja;
ALTER TABLE bulk_category_jobs DROP CONSTRAINT IF EXISTS ck_bulk_category_jobs_store_ou_loja;
ALTER TABLE produtos_ink_sync DROP CONSTRAINT IF EXISTS ck_produtos_ink_sync_store_ou_loja;
ALTER TABLE produtos_ink DROP CONSTRAINT IF EXISTS ck_produtos_ink_store_ou_loja;

ALTER TABLE pedidos_backfill_jobs DROP CONSTRAINT IF EXISTS fk_pedidos_backfill_jobs_store;
ALTER TABLE bulk_category_jobs DROP CONSTRAINT IF EXISTS fk_bulk_category_jobs_store;
ALTER TABLE produtos_ink_sync DROP CONSTRAINT IF EXISTS fk_produtos_ink_sync_store;
ALTER TABLE produtos_ink DROP CONSTRAINT IF EXISTS fk_produtos_ink_store;

ALTER TABLE pedidos_backfill_jobs ALTER COLUMN loja SET NOT NULL;
ALTER TABLE bulk_category_jobs ALTER COLUMN loja SET NOT NULL;
ALTER TABLE produtos_ink_sync ALTER COLUMN loja SET NOT NULL;
ALTER TABLE produtos_ink ALTER COLUMN loja SET NOT NULL;

DROP INDEX IF EXISTS uq_produtos_ink_sync_store;
ALTER TABLE produtos_ink_sync DROP CONSTRAINT IF EXISTS produtos_ink_sync_pkey;
ALTER TABLE produtos_ink_sync DROP COLUMN IF EXISTS id;
DROP INDEX IF EXISTS uq_produtos_ink_sync_org;
ALTER TABLE produtos_ink_sync ADD CONSTRAINT uq_produtos_ink_sync_org PRIMARY KEY (organization_id, loja);

DROP INDEX IF EXISTS uq_produtos_ink_store;
ALTER TABLE produtos_ink DROP CONSTRAINT IF EXISTS produtos_ink_pkey;
ALTER TABLE produtos_ink DROP COLUMN IF EXISTS id;
DROP INDEX IF EXISTS uq_produtos_ink_org;
ALTER TABLE produtos_ink ADD CONSTRAINT uq_produtos_ink_org PRIMARY KEY (organization_id, loja, produto_id);

ALTER TABLE pedidos_backfill_jobs DROP COLUMN IF EXISTS store_id;
ALTER TABLE bulk_category_jobs DROP COLUMN IF EXISTS store_id;
ALTER TABLE produtos_ink_sync DROP COLUMN IF EXISTS store_id;
ALTER TABLE produtos_ink DROP COLUMN IF EXISTS store_id;
