-- Desfaz a 0031. Só descarta dado de observabilidade (trace); nada que a geração ou o custo leiam.

ALTER TABLE creative_generations DROP COLUMN IF EXISTS provider_request_id;
ALTER TABLE creative_generations DROP COLUMN IF EXISTS duration_ms;
ALTER TABLE creative_generations DROP COLUMN IF EXISTS model_served;
ALTER TABLE creative_generations DROP COLUMN IF EXISTS generation_trace;
