-- Desfaz a 0032. Só descarta metadado de versão (o plano e o prompt continuam no JSON da geração).

ALTER TABLE creative_generations DROP COLUMN IF EXISTS compiler_version;
ALTER TABLE creative_generations DROP COLUMN IF EXISTS plan_schema_version;
