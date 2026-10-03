-- Cache das categorias (collections) da Reserva Ink — o "sync de Categorias", irmão do cache do catálogo
-- de produtos (`produtos_ink` / `produtos_ink_sync`).
--
-- Até aqui a tela de Categorias lia a Ink AO VIVO a cada abertura, e cada categoria vem com TODOS os
-- `product_ids` (a maior tem ~100 mil): a listagem levava 10+ s só pelo volume. O sync varre
-- GET /v1/stores/collections em segundo plano e guarda só o que a listagem mostra — nome, descrição,
-- disponibilidade, posição, CONTAGEM de produtos, kits e o updated_at da Ink. Os `product_ids` não são
-- guardados: o detalhe e a edição continuam lendo a Ink (a substituição de `product_ids` é total, nunca
-- pode partir de um estado local possivelmente velho).
--
-- A Ink continua sendo a fonte da verdade: toda escrita vai para ela primeiro e só depois atualiza o cache.
--
-- Nascem NATIVAS (organization_id/store_id obrigatórios, FK composta com stores, sem chave legada `loja`),
-- entram em TABELAS_PLATAFORMA e ficam sob RLS forçada — mesmo desenho de partner_preview_links (0046).

CREATE TABLE categorias_ink (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  categoria_id BIGINT NOT NULL,

  name TEXT NOT NULL,
  description TEXT,
  is_available BOOLEAN,
  position INTEGER,
  product_count INTEGER NOT NULL DEFAULT 0 CHECK (product_count >= 0),
  kit_ids BIGINT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ,                 -- updated_at da Ink
  sincronizado_em TIMESTAMPTZ NOT NULL,   -- quando o Oria gravou esta linha (varredura ou escrita pelo painel)

  CONSTRAINT pk_categorias_ink PRIMARY KEY (organization_id, store_id, categoria_id),
  CONSTRAINT fk_categorias_ink_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id)
);
-- A listagem ordena como a Ink (posição, depois id).
CREATE INDEX idx_categorias_ink_ordem ON categorias_ink (organization_id, store_id, position, categoria_id);

-- Estado da varredura e agendamento da renovação automática, 1 linha por Store.
CREATE TABLE categorias_ink_sync (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,

  iniciado_em TIMESTAMPTZ,
  concluido_em TIMESTAMPTZ,               -- NULL enquanto roda; o cache só é servido depois da 1ª varredura concluída
  total INTEGER CHECK (total IS NULL OR total >= 0),
  paginas INTEGER NOT NULL DEFAULT 0 CHECK (paginas >= 0),
  erro TEXT,
  auto_pausado BOOLEAN NOT NULL DEFAULT false,
  intervalo_horas INTEGER NOT NULL DEFAULT 6 CHECK (intervalo_horas IN (6, 12, 24, 48, 72, 168)),

  CONSTRAINT pk_categorias_ink_sync PRIMARY KEY (organization_id, store_id),
  CONSTRAINT fk_categorias_ink_sync_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id)
);

ALTER TABLE categorias_ink ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias_ink FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON categorias_ink
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

ALTER TABLE categorias_ink_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE categorias_ink_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON categorias_ink_sync
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
