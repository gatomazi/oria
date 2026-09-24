-- Fase D.1 · compatibilidade e direção visual que o planner PASSA A RESPEITAR de verdade (não só informativa).
--
-- `definition` (JSONB, da 0034) já guarda a direção visual em si (framing, direção fotográfica, iluminação,
-- composição, notas) — isso não muda. As três colunas daqui são diferentes: são regras de COMPATIBILIDADE que o
-- core valida (allowed_product_modes: recusa dura; allowed_interactions: aviso; default_gaze: prioridade de
-- olhar), então ficam em colunas próprias, tipadas, como o resto do que é validado nesta tabela — não dentro do
-- JSONB livre, que é só para o texto ainda em evolução (§5 da direção).
--
-- Aditiva e reversível: só ALTER TABLE ADD COLUMN; nenhuma linha existente muda (todas nascem NULL = sem
-- restrição, exatamente o comportamento anterior a esta migration).

ALTER TABLE creative_angles ADD COLUMN IF NOT EXISTS allowed_interactions TEXT[];
ALTER TABLE creative_angles ADD COLUMN IF NOT EXISTS allowed_product_modes TEXT[]
  CHECK (allowed_product_modes IS NULL OR allowed_product_modes <@ ARRAY['single_product', 'multi_product']::text[]);
ALTER TABLE creative_angles ADD COLUMN IF NOT EXISTS default_gaze TEXT
  CHECK (default_gaze IS NULL OR default_gaze IN ('camera', 'interaction', 'off_camera', 'product'));
