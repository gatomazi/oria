-- Catálogo Ink · `store_id` como identidade da Store no cache de produtos, no estado do sync, nos
-- jobs de categoria em lote e nos jobs de backfill histórico de pedidos.
--
-- ── O problema ───────────────────────────────────────────────────────────────────────────────
-- Igual ao dos pedidos (0021): `produtos_ink` e `produtos_ink_sync` tinham `loja` NOT NULL e ela
-- fazia parte da CHAVE PRIMÁRIA. A Store nativa do Oria (`stores.loja_legada` NULA) não podia ter
-- uma linha de cache de catálogo: o sync a deixava de fora "de propósito" (comentário no código), a
-- tela de Produtos caía na API ao vivo e o card de Integrações dizia "Nenhuma loja conectada" mesmo
-- com token Ink. `bulk_category_jobs.loja` NOT NULL impedia a Store nativa de associar categoria em
-- lote.
--
-- ── A decisão ────────────────────────────────────────────────────────────────────────────────
-- A mesma da 0021 e da 0025, para o modelo ser um só:
--   · `store_id` (UUID) com FK COMPOSTA `(store_id, organization_id) → stores (id, organization_id)`;
--   · a chave textual `loja` fica como COMPATIBILIDADE HISTÓRICA (nula na Store nativa);
--   · a PK deixa de conter `loja`: vira substituta `(organization_id, id)`. A unicidade de negócio
--     canônica é PARCIAL em `store_id`; o índice legado por `loja` continua, com o MESMO NOME e sem
--     predicado — as releases já publicadas o referenciam no `ON CONFLICT`. NULL é distinto de NULL
--     em índice único, então o legado não restringe as linhas novas;
--   · CHECK (NOT VALID, só para linha nova ou atualizada): toda linha identifica sua Store pela
--     identidade nova OU pela chave histórica.
--
-- Backfill oportunista: só por mapeamento explícito (`stores.loja_legada`), mesma Organization.
-- Forward-only. Nenhuma coluna legada é removida aqui.
--
-- `produtos_feed` e `produtos_feed_sync` ficam de fora: o feed CSV é caminho legado descontinuado e
-- não é requisito de nada para a Store nativa.

ALTER TABLE produtos_ink ADD COLUMN store_id UUID;
ALTER TABLE produtos_ink_sync ADD COLUMN store_id UUID;
ALTER TABLE bulk_category_jobs ADD COLUMN store_id UUID;
ALTER TABLE pedidos_backfill_jobs ADD COLUMN store_id UUID;

UPDATE produtos_ink t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE produtos_ink_sync t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE bulk_category_jobs t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE pedidos_backfill_jobs t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;

-- produtos_ink: PK substituta; legado por loja mantido com o mesmo nome; canônico parcial por Store.
ALTER TABLE produtos_ink DROP CONSTRAINT uq_produtos_ink_org;
CREATE UNIQUE INDEX uq_produtos_ink_org ON produtos_ink (organization_id, loja, produto_id);
ALTER TABLE produtos_ink ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE produtos_ink ADD CONSTRAINT produtos_ink_pkey PRIMARY KEY (organization_id, id);
CREATE UNIQUE INDEX uq_produtos_ink_store ON produtos_ink (organization_id, store_id, produto_id)
  WHERE store_id IS NOT NULL;

-- produtos_ink_sync: idem.
ALTER TABLE produtos_ink_sync DROP CONSTRAINT uq_produtos_ink_sync_org;
CREATE UNIQUE INDEX uq_produtos_ink_sync_org ON produtos_ink_sync (organization_id, loja);
ALTER TABLE produtos_ink_sync ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE produtos_ink_sync ADD CONSTRAINT produtos_ink_sync_pkey PRIMARY KEY (organization_id, id);
CREATE UNIQUE INDEX uq_produtos_ink_sync_store ON produtos_ink_sync (organization_id, store_id)
  WHERE store_id IS NOT NULL;

ALTER TABLE produtos_ink ALTER COLUMN loja DROP NOT NULL;
ALTER TABLE produtos_ink_sync ALTER COLUMN loja DROP NOT NULL;
ALTER TABLE bulk_category_jobs ALTER COLUMN loja DROP NOT NULL;
ALTER TABLE pedidos_backfill_jobs ALTER COLUMN loja DROP NOT NULL;

ALTER TABLE produtos_ink ADD CONSTRAINT fk_produtos_ink_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE produtos_ink_sync ADD CONSTRAINT fk_produtos_ink_sync_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE bulk_category_jobs ADD CONSTRAINT fk_bulk_category_jobs_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE pedidos_backfill_jobs ADD CONSTRAINT fk_pedidos_backfill_jobs_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);

ALTER TABLE produtos_ink ADD CONSTRAINT ck_produtos_ink_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE produtos_ink_sync ADD CONSTRAINT ck_produtos_ink_sync_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE bulk_category_jobs ADD CONSTRAINT ck_bulk_category_jobs_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE pedidos_backfill_jobs ADD CONSTRAINT ck_pedidos_backfill_jobs_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;

CREATE INDEX idx_produtos_ink_store ON produtos_ink (organization_id, store_id);
CREATE INDEX idx_bulk_category_jobs_store ON bulk_category_jobs (organization_id, store_id, criado_em DESC);
CREATE INDEX idx_pedidos_backfill_jobs_store ON pedidos_backfill_jobs (organization_id, store_id, criado_em DESC);
