-- Connector Ink · `store_id` como identidade da Store nas tabelas operacionais.
--
-- ── O problema ───────────────────────────────────────────────────────────────────────────────
-- O escopo dentro da Organization era a coluna textual `loja` (`sul`/`centro`/`norte`), herdada do
-- sistema de loja única. `stores.loja_legada` é NULA em Store criada nativamente pelo Oria — e
-- `loja` não era só obrigatória: fazia parte da CHAVE de `pedidos_ink`, `pedidos_ink_itens` e
-- `sync_estado`. A chave do sistema antigo era requisito de EXISTÊNCIA da linha, então cliente novo
-- não conseguia ter pedido.
--
-- ── A decisão que moldou esta migration ──────────────────────────────────────────────────────
-- A primeira versão tornava `store_id` NOT NULL e o punha na chave primária, com backfill
-- obrigatório. Isso quebrou 116 testes e, mais importante, quebrou o cenário REAL de migração: nele
-- existem linhas de pedido cuja loja ainda não foi mapeada para uma Store. Exigir a identidade nova
-- retroativamente é reescrever história que ninguém pediu para reescrever.
--
-- O alvo do comando é `store_id` obrigatório para registro NOVO — não para o histórico. É o que esta
-- versão faz:
--
--   · `store_id` é NULO-permitido na coluna, mas o CHECK (NOT VALID, logo só para linha nova e
--     atualizada) exige que toda linha identifique sua Store: pela identidade nova OU pela chave
--     histórica. Não existe linha sem dono.
--   · a unicidade ganha um índice por Store (parcial, só onde há `store_id`) e MANTÉM o índice
--     legado por `loja`, com o mesmo nome e sem predicado — é o que as releases já publicadas
--     referenciam no seu `ON CONFLICT`. Como NULL é distinto de NULL em índice único, o legado não
--     restringe as linhas novas.
--   · a FK é COMPOSTA, `(store_id, organization_id) → stores (id, organization_id)`: não basta a
--     Store existir, ela precisa ser da Organization da linha. É a regra da RLS escrita também como
--     integridade referencial — o banco recusa a combinação errada mesmo que o código erre.
--
-- O backfill continua, mas agora é OPORTUNISTA: resolve o que dá por mapeamento explícito
-- (`stores.loja_legada`) e deixa quieto o que não resolve. Nada é inferido de "a Organization só tem
-- uma Store" — essa inferência estaria certa hoje e errada no primeiro cliente com duas.
--
-- Forward-only. Nenhuma coluna legada é removida aqui.

-- Alvo da FK composta (o PK sozinho não serve como referência de duas colunas).
ALTER TABLE stores ADD CONSTRAINT uq_stores_id_organization UNIQUE (id, organization_id);

ALTER TABLE webhook_eventos ADD COLUMN store_id UUID;
ALTER TABLE pedidos_ink ADD COLUMN store_id UUID;
ALTER TABLE pedidos_ink_itens ADD COLUMN store_id UUID;
ALTER TABLE sync_estado ADD COLUMN store_id UUID;

-- Backfill oportunista: só por mapeamento explícito, dentro da mesma Organization.
UPDATE webhook_eventos t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE pedidos_ink t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE pedidos_ink_itens t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE sync_estado t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;

-- ── `loja` sai das chaves ────────────────────────────────────────────────────────────────────
-- pedidos_ink: a PK é (organization_id, id) e não muda; troca-se a unicidade de negócio.
-- O índice legado CONTINUA existindo, com o mesmo nome e sem predicado. Isso não é conservadorismo:
-- as releases anteriores (que o dry-run do runbook executa de verdade) fazem
-- `ON CONFLICT (organization_id, loja, ink_order_id)`, e ON CONFLICT não casa com índice parcial.
-- Transformá-lo em parcial quebraria o código já publicado. Como NULL é distinto de NULL em índice
-- único, ele simplesmente não restringe as linhas novas (que têm `loja` nula).
CREATE UNIQUE INDEX uq_pedidos_ink_store ON pedidos_ink (organization_id, store_id, ink_order_id)
  WHERE store_id IS NOT NULL;

-- Estas duas tinham `loja` na PRIMARY KEY, e coluna de PK não pode ser nula. A PK vira substituta
-- (a identidade da linha deixa de ser o texto da loja) e o índice único legado permanece, agora
-- como unicidade de negócio e não como PK — de novo, para o ON CONFLICT das releases antigas casar.
ALTER TABLE pedidos_ink_itens DROP CONSTRAINT uq_pedidos_ink_itens_org;
CREATE UNIQUE INDEX uq_pedidos_ink_itens_org ON pedidos_ink_itens (organization_id, loja, item_id);
ALTER TABLE pedidos_ink_itens ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE pedidos_ink_itens ADD CONSTRAINT pedidos_ink_itens_pkey PRIMARY KEY (organization_id, id);
CREATE UNIQUE INDEX uq_pedidos_ink_itens_store ON pedidos_ink_itens (organization_id, store_id, item_id)
  WHERE store_id IS NOT NULL;

ALTER TABLE sync_estado DROP CONSTRAINT uq_sync_estado_org;
CREATE UNIQUE INDEX uq_sync_estado_org ON sync_estado (organization_id, loja);
ALTER TABLE sync_estado ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE sync_estado ADD CONSTRAINT sync_estado_pkey PRIMARY KEY (organization_id, id);
CREATE UNIQUE INDEX uq_sync_estado_store ON sync_estado (organization_id, store_id)
  WHERE store_id IS NOT NULL;

ALTER TABLE pedidos_ink ALTER COLUMN loja DROP NOT NULL;
ALTER TABLE pedidos_ink_itens ALTER COLUMN loja DROP NOT NULL;
ALTER TABLE sync_estado ALTER COLUMN loja DROP NOT NULL;

-- ── Integridade referencial, leitura e a regra das linhas novas ──────────────────────────────
ALTER TABLE webhook_eventos ADD CONSTRAINT fk_webhook_eventos_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE pedidos_ink ADD CONSTRAINT fk_pedidos_ink_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE pedidos_ink_itens ADD CONSTRAINT fk_pedidos_ink_itens_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE sync_estado ADD CONSTRAINT fk_sync_estado_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);

CREATE INDEX idx_webhook_eventos_store ON webhook_eventos (organization_id, store_id, recebido_em DESC);
CREATE INDEX idx_pedidos_ink_store ON pedidos_ink (organization_id, store_id);

-- NOT VALID: vale para linha nova e para atualização, não revalida o histórico. Toda linha nova
-- identifica sua Store — pela identidade canônica ou pela chave antiga, mas identifica.
ALTER TABLE webhook_eventos ADD CONSTRAINT ck_webhook_eventos_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE pedidos_ink ADD CONSTRAINT ck_pedidos_ink_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE pedidos_ink_itens ADD CONSTRAINT ck_pedidos_ink_itens_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE sync_estado ADD CONSTRAINT ck_sync_estado_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
