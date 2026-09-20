-- Embedded Signup do WhatsApp · o `state` de OAuth passa a aceitar o provider `whatsapp`.
--
-- O onboarding do WhatsApp (Embedded Signup) usa o mesmo mecanismo de state dos outros conectores:
-- uso único, só o SHA-256 no banco, amarrado a pessoa, sessão, Organization e Store. Sem esta
-- migration o CHECK recusaria o provider novo. Reaproveitar o provider `meta` (Ads) seria pior: o
-- callback de Ads aceitaria um state emitido para o WhatsApp.
--
-- Aditiva: só alarga o CHECK; nenhuma linha existente muda.

ALTER TABLE oauth_states DROP CONSTRAINT oauth_states_provider_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_provider_check
  CHECK (provider IN ('meta', 'google_ads', 'ga4', 'whatsapp'));
