-- Fase A1 · trace de geração do Gerador de Criativos. Puramente observacional.
--
-- `generation_trace` guarda, por tentativa (chave = generation_attempt como texto), o que a chamada ao
-- provedor realmente fez: modelo pedido x modelo que respondeu, parâmetros efetivos, referências (tipo
-- original e tipo anunciado, bytes), duração, request id do provedor, hash do prompt. Nunca guarda o
-- texto do prompt nem a OpenAI key.
-- Ficam em colunas, além do JSON, só o que se filtra/agrega sem abrir o JSON: modelo servido, duração
-- e request id da tentativa mais recente. NULL = "sem trace" (gerações anteriores a esta migration).
--
-- Aditiva e sem backfill. Guardar o trace POR TENTATIVA (e não só o último) evita que um retry apague a
-- evidência da tentativa anterior; a tabela própria de tentativas é da Fase H.

ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS generation_trace JSONB;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS model_served TEXT;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE creative_generations ADD COLUMN IF NOT EXISTS provider_request_id TEXT;
