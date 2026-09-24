-- Desfaz a 0035. Um ângulo sem essas colunas volta a não ter restrição de compatibilidade — o mesmo estado que
-- toda linha já tinha antes dela (NULL = sem restrição).
ALTER TABLE creative_angles DROP COLUMN IF EXISTS default_gaze;
ALTER TABLE creative_angles DROP COLUMN IF EXISTS allowed_product_modes;
ALTER TABLE creative_angles DROP COLUMN IF EXISTS allowed_interactions;
