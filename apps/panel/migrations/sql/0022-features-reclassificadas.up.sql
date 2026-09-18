-- ── Reclassificação de features comerciais (features × connectors × capabilities) ────────────
--
-- Sete chaves deixaram de ser FEATURE COMERCIAL:
--
--   catalog, exchanges, refunds
--     → CONNECTOR CAPABILITY da Reserva Ink. Toda rota por trás delas é proxy ou cache da API da
--       Ink (/v1/stores/products, /collections, /product_clusters, /promotions, /exchanges,
--       /orders/{id}/refunds). Trocar a Ink por outro fornecedor não deixa nada dessas áreas de
--       pé como capacidade do Oria — que é exatamente o critério de classificação.
--
--   creative_clean_angles, creative_remarketing, creative_funnel_visual, creative_multi_product
--     → MODULE CAPABILITY de `creative_generator`. São modos internos do Gerador, não produtos
--       que alguém compra separado.
--
-- Esta migration ajusta só o DADO do control plane: tira as sete de `plan_features` e de
-- `organization_entitlement_overrides`. A partir daqui, `internal` = as features comerciais do perfil do
-- Tenant #1 (apps/panel/config/entitlements/tenant1-entitlements.json).
--
-- ── O que esta migration NÃO faz ─────────────────────────────────────────────────────────────
-- Não mexe no domain `platform_feature`. Estreitar o domain é a última fase da depreciação
-- (Phase E), e ela só faz sentido quando não houver mais nenhuma linha nem nenhum ambiente
-- carregando as chaves antigas. Até lá o código já nega: as sete estão fora de `FEATURES` nos
-- dois registries, então nem o painel nem o control plane conseguem gravá-las.
--
-- ── Sem regressão de acesso ──────────────────────────────────────────────────────────────────
-- Nenhuma funcionalidade sai do ar por causa desta migration:
--   · Catálogo / Trocas / Reembolsos passam a depender do Connector Ink conectado (as rotas já
--     falham sozinhas, com 409, quando não há segredo da Ink) — não do plano;
--   · os quatro modos de criativos passam a vir de `creative_generator`, que o `internal` mantém.
-- O runtime do painel lê `app_config.entitlements`, não `plan_features`; aquelas linhas seguem
-- intactas e as chaves antigas viram ruído ignorado (FEATURES_DEPRECIADAS).

DELETE FROM plan_features
 WHERE feature::text IN (
   'catalog', 'exchanges', 'refunds',
   'creative_clean_angles', 'creative_remarketing', 'creative_funnel_visual', 'creative_multi_product'
 );

DELETE FROM organization_entitlement_overrides
 WHERE feature::text IN (
   'catalog', 'exchanges', 'refunds',
   'creative_clean_angles', 'creative_remarketing', 'creative_funnel_visual', 'creative_multi_product'
 );
