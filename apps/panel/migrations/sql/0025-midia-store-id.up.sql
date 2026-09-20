-- Mídia e financeiro · `store_id` como identidade da Store na atribuição de conta de anúncio,
-- nas despesas operacionais e nas campanhas UTM.
--
-- ── O problema ───────────────────────────────────────────────────────────────────────────────
-- A conta de anúncios (Meta e Google Ads) era atribuída a uma loja por TEXTO: `loja_atribuida`
-- (`sul`/`centro`/`norte`). `stores.loja_legada` é NULA em toda Store criada nativamente pelo Oria,
-- então uma Store nativa não tinha valor possível para essa coluna: a rota de selecionar conta
-- exigia a chave legada, o gasto de mídia nunca era atribuído e o Dashboard/Financeiro mostravam
-- lucro sem descontar mídia. O mesmo vale para `despesas_operacionais.loja` e `utm_campaigns.loja`
-- (ambas NOT NULL): a Store nativa não conseguia sequer cadastrar uma despesa ou uma campanha UTM.
--
-- ── A decisão ────────────────────────────────────────────────────────────────────────────────
-- Mesma da 0021 (Connector Ink), para o modelo ser um só:
--
--   · `store_id` é a identidade CANÔNICA, com FK COMPOSTA `(store_id, organization_id) → stores
--     (id, organization_id)`: não basta a Store existir, ela tem de ser da Organization da linha. É a
--     regra da RLS escrita também como integridade referencial.
--   · a coluna textual (`loja_atribuida` / `loja`) continua, como COMPATIBILIDADE HISTÓRICA. Nada é
--     removido nem reescrito.
--   · nas contas de anúncio `store_id` é nulo-permitido: conta sem Store atribuída é um estado
--     legítimo ("conectei mas ainda não escolhi a loja") e o gasto dela fica FORA do resultado,
--     sinalizado — nunca somado por dedução.
--   · em despesas e UTM o CHECK (NOT VALID, logo só para linha nova ou atualizada) exige que a linha
--     identifique a Store pela identidade nova OU pela chave histórica: não existe linha sem dono.
--
-- ── Backfill ─────────────────────────────────────────────────────────────────────────────────
-- Só por mapeamento explícito e dentro da MESMA Organization: `stores.loja_legada = <coluna textual>`.
-- O que não resolve fica como está (conta sem `store_id` continua atribuída pelo texto, se houver).
-- Nada é inferido de "a Organization só tem uma Store" — estaria certo hoje e errado no primeiro
-- cliente com duas.
--
-- Forward-only. Nenhuma coluna legada é removida aqui.

ALTER TABLE meta_ad_accounts ADD COLUMN store_id UUID;
ALTER TABLE google_ads_customers ADD COLUMN store_id UUID;
ALTER TABLE despesas_operacionais ADD COLUMN store_id UUID;
ALTER TABLE utm_campaigns ADD COLUMN store_id UUID;

UPDATE meta_ad_accounts t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja_atribuida AND t.store_id IS NULL;
UPDATE google_ads_customers t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja_atribuida AND t.store_id IS NULL;
UPDATE despesas_operacionais t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE utm_campaigns t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;

ALTER TABLE meta_ad_accounts ADD CONSTRAINT fk_meta_ad_accounts_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE google_ads_customers ADD CONSTRAINT fk_google_ads_customers_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE despesas_operacionais ADD CONSTRAINT fk_despesas_operacionais_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE utm_campaigns ADD CONSTRAINT fk_utm_campaigns_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);

-- Despesa e campanha UTM deixam de exigir a chave legada para existir.
ALTER TABLE despesas_operacionais ALTER COLUMN loja DROP NOT NULL;
ALTER TABLE utm_campaigns ALTER COLUMN loja DROP NOT NULL;

ALTER TABLE despesas_operacionais ADD CONSTRAINT ck_despesas_operacionais_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE utm_campaigns ADD CONSTRAINT ck_utm_campaigns_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;

CREATE INDEX idx_meta_ad_accounts_store ON meta_ad_accounts (organization_id, store_id);
CREATE INDEX idx_google_ads_customers_store ON google_ads_customers (organization_id, store_id);
CREATE INDEX idx_despesas_operacionais_store_data ON despesas_operacionais (organization_id, store_id, data);
CREATE INDEX idx_utm_campaigns_store ON utm_campaigns (organization_id, store_id, arquivada_em, atualizado_em DESC);
