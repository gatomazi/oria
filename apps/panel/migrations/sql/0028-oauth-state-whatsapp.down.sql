-- states de WhatsApp são efêmeros (minutos): descartá-los aqui não perde nada que importe.
DELETE FROM oauth_states WHERE provider = 'whatsapp';
ALTER TABLE oauth_states DROP CONSTRAINT oauth_states_provider_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_provider_check
  CHECK (provider IN ('meta', 'google_ads', 'ga4'));
