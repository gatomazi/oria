-- Fase B · versões do plano e do compiler por geração do Gerador de Criativos.
--
-- `plan_schema_version` (1 = plano v1, 2 = CreativePlan v2) e `compiler_version` (versão do compiler v2 que produziu o
-- prompt; NULL para plano v1, que usa o PromptBuilder antigo) ficam em colunas porque o histórico de "Gostei / Não
-- gostei" e as comparações de qualidade filtram e agrupam por elas sem abrir o JSON do plano.
--
-- Aditiva. O backfill só copia para a coluna o que o próprio plano já diz (`plan.schema_version`, ausente = 1), e só
-- onde há plano; gerações sem plano (ainda na fila) ficam NULL. Idempotente.

ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS plan_schema_version INTEGER;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS compiler_version INTEGER;

UPDATE creative_generations
   SET plan_schema_version = COALESCE((plan->>'schema_version')::int, 1),
       compiler_version = (plan->'compiler'->>'version')::int
 WHERE plan IS NOT NULL AND plan_schema_version IS NULL;
