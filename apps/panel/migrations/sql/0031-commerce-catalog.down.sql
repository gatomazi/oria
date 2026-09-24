-- Forward-only por convenção do projeto, mas o down existe para dev/rollback local.
DROP TABLE IF EXISTS commerce_catalog_sync_logs;
DROP TABLE IF EXISTS commerce_product_variants;
DROP TABLE IF EXISTS commerce_products;
