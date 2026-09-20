-- GA4 · `store_id` como identidade da Store na conexão e no cache de performance.
--
-- ── O problema ───────────────────────────────────────────────────────────────────────────────
-- `google_analytics_connections` e `ga4_performance_cache` tinham `loja` NOT NULL e a unicidade era
-- por `(organization_id, loja)`. A Store nativa do Oria (`stores.loja_legada` NULA) não podia ter
-- conexão GA4 nem cache: Conectar respondia `STORE_WITHOUT_LEGACY_KEY`, o UTM Tracker ficava sem
-- performance e o consolidado sem o GA4. (Os tokens já eram por Organization, em `integration_secrets`;
-- só a LINHA de conexão e a chave do cache dependiam da loja.)
--
-- ── A decisão ────────────────────────────────────────────────────────────────────────────────
-- A mesma da 0021, 0025 e 0026:
--   · `store_id` (UUID) com FK COMPOSTA `(store_id, organization_id) → stores (id, organization_id)`;
--   · `loja` fica como compatibilidade histórica (nula na Store nativa), e o índice único legado por
--     `loja` continua com o MESMO NOME (as releases publicadas o usam no `ON CONFLICT`);
--   · a unicidade canônica é PARCIAL em `store_id`: uma conexão por Store; um cache por
--     (Store, período);
--   · CHECK (NOT VALID, só para linha nova ou atualizada): toda linha identifica a Store por
--     `store_id` OU pela chave histórica.
--
-- Backfill oportunista: só por mapeamento explícito (`stores.loja_legada`), mesma Organization.
-- Forward-only. Nenhuma coluna legada é removida.

ALTER TABLE google_analytics_connections ADD COLUMN store_id UUID;
ALTER TABLE ga4_performance_cache ADD COLUMN store_id UUID;

UPDATE google_analytics_connections t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;
UPDATE ga4_performance_cache t SET store_id = s.id
  FROM stores s WHERE s.organization_id = t.organization_id AND s.loja_legada = t.loja AND t.store_id IS NULL;

ALTER TABLE google_analytics_connections ALTER COLUMN loja DROP NOT NULL;
ALTER TABLE ga4_performance_cache ALTER COLUMN loja DROP NOT NULL;

ALTER TABLE google_analytics_connections ADD CONSTRAINT fk_google_analytics_connections_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);
ALTER TABLE ga4_performance_cache ADD CONSTRAINT fk_ga4_performance_cache_store
  FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id);

ALTER TABLE google_analytics_connections ADD CONSTRAINT ck_google_analytics_connections_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;
ALTER TABLE ga4_performance_cache ADD CONSTRAINT ck_ga4_performance_cache_store_ou_loja
  CHECK (store_id IS NOT NULL OR loja IS NOT NULL) NOT VALID;

CREATE UNIQUE INDEX uq_google_analytics_connections_store ON google_analytics_connections (organization_id, store_id)
  WHERE store_id IS NOT NULL;
CREATE UNIQUE INDEX uq_ga4_performance_cache_store ON ga4_performance_cache (organization_id, store_id, periodo)
  WHERE store_id IS NOT NULL;
