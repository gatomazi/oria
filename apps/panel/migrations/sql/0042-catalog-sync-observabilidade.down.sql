DROP FUNCTION IF EXISTS job_lease_liberar_forcado(TEXT, UUID);

ALTER TABLE commerce_catalog_sync_logs DROP CONSTRAINT commerce_catalog_sync_logs_status_check;
ALTER TABLE commerce_catalog_sync_logs ADD CONSTRAINT commerce_catalog_sync_logs_status_check
  CHECK (status IN ('running', 'success', 'partial_failure', 'failed'));

ALTER TABLE commerce_catalog_sync_logs DROP COLUMN pages_total;
