-- Desfaz a 0029. Só é seguro enquanto nenhuma campanha de Store nativa (sem chave legada) existir:
-- `loja` volta a ser obrigatória e apagar essas campanhas para conseguir descer seria perder dado do
-- cliente. A migration recusa em vez de apagar.

DO $ck$
DECLARE sem_loja INTEGER;
BEGIN
  SELECT count(*) INTO sem_loja FROM campaigns WHERE loja IS NULL;
  IF sem_loja > 0 THEN
    RAISE EXCEPTION 'há % campanha(s) sem loja legada (cliente nativo do Oria): descer a 0029 exigiria apagá-las', sem_loja;
  END IF;
END
$ck$;

DROP INDEX IF EXISTS idx_campaigns_store;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS ck_campaigns_store_ou_loja;
ALTER TABLE campaigns ALTER COLUMN loja SET NOT NULL;
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS fk_campaigns_store;
ALTER TABLE campaigns DROP COLUMN IF EXISTS store_id;
