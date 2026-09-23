ALTER TABLE segments DROP CONSTRAINT IF EXISTS ck_segments_politica;
ALTER TABLE segments DROP CONSTRAINT IF EXISTS ck_segments_origem;
ALTER TABLE segments DROP COLUMN IF EXISTS rfm_segmento;
ALTER TABLE segments DROP COLUMN IF EXISTS classificado_em;
ALTER TABLE segments DROP COLUMN IF EXISTS rfm_versao;
ALTER TABLE segments DROP COLUMN IF EXISTS predicado;
ALTER TABLE segments DROP COLUMN IF EXISTS politica;
ALTER TABLE segments DROP COLUMN IF EXISTS origem;
