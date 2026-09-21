-- Campanhas · `store_id` como identidade da Store.
--
-- `campaigns.loja` era NOT NULL: a Store nativa do Oria (`loja_legada = NULL`) não conseguia criar uma
-- campanha — a rota respondia 409 antes de chegar ao banco. Mesma decisão das migrations 0021/0025/0026:
--
--   · `store_id` é a identidade CANÔNICA, com FK COMPOSTA `(store_id, organization_id) → stores
--     (id, organization_id)`: a Store precisa ser da Organization da linha.
--   · a coluna textual `loja` continua como compatibilidade histórica (agora nulo-permitida). Nada é
--     removido nem reescrito.
--   · o CHECK (NOT VALID, só para linha nova ou atualizada) exige que toda campanha identifique a Store
--     pela identidade nova OU pela chave histórica: não existe campanha sem dono.
--
-- Backfill só por mapeamento explícito (`stores.loja_legada`) dentro da mesma Organization. Forward-only.

ALTER TABLE campaigns ADD COLUMN store_id UUID;

UPDATE campaigns t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;

ALTER TABLE campaigns ADD CONSTRAINT fk_campaigns_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);

ALTER TABLE campaigns ALTER COLUMN loja DROP NOT NULL;

ALTER TABLE campaigns ADD CONSTRAINT ck_campaigns_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;

CREATE INDEX idx_campaigns_store ON campaigns (organization_id, store_id, criado_em DESC);
