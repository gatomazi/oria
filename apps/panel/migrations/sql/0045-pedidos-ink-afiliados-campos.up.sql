-- Parcerias · campos do pedido da INK de que a apuração de comissões precisa e que o cache não guardava.
--
-- Estritamente ADITIVA e nula por padrão: nenhuma linha existente é reescrita. Quem grava é o MESMO upsert
-- de pedido que o sync periódico e o webhook já usam (server.js) — nenhuma chamada nova à API da INK.
--
--   affiliate_snapshot_at  marca que a linha foi tocada por um payload COMPLETO depois desta migration. Pedido
--                          antigo (NULL) ainda não tem cupom/quantidade devolvida conhecidos: o módulo de
--                          afiliados o trata como dado incompleto (revisão manual), nunca como "sem cupom".
--   promotion_code         `promotion_code` do pedido (cupom usado), como veio.
--   promotion_value        `promotion_value` (desconto de promoção concedido no pedido).
--   payment_discount_value `payment_discount_value` (desconto de forma de pagamento).
--   freight_value_difference  diferença de frete subvencionada.
--   kickback_value         `kickback_value` da INK: dado de CONFERÊNCIA, nunca base de comissão.
--   delivered_at           `delivery.delivered_at`.
--
-- Itens: quantidades devolvidas/gratuitas, preço unitário efetivo, custo base e ids de produto/variante/cluster
-- (o item já guardava `produto_id`; variante e cluster ajudam a descobrir produtos de uma collab).

ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS promotion_code TEXT;
ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS promotion_value NUMERIC;
ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS payment_discount_value NUMERIC;
ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS freight_value_difference NUMERIC;
ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS kickback_value NUMERIC;
ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS affiliate_snapshot_at TIMESTAMPTZ;

ALTER TABLE pedidos_ink_itens ADD COLUMN IF NOT EXISTS unit_value NUMERIC;
ALTER TABLE pedidos_ink_itens ADD COLUMN IF NOT EXISTS refunded_quantity INTEGER;
ALTER TABLE pedidos_ink_itens ADD COLUMN IF NOT EXISTS free_quantity INTEGER;
ALTER TABLE pedidos_ink_itens ADD COLUMN IF NOT EXISTS unit_ink_base_price NUMERIC;
ALTER TABLE pedidos_ink_itens ADD COLUMN IF NOT EXISTS unit_additional_service_price NUMERIC;
ALTER TABLE pedidos_ink_itens ADD COLUMN IF NOT EXISTS product_variant_id BIGINT;
ALTER TABLE pedidos_ink_itens ADD COLUMN IF NOT EXISTS product_cluster_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_pedidos_ink_promotion_code ON pedidos_ink (organization_id, upper(btrim(promotion_code)))
  WHERE promotion_code IS NOT NULL;
