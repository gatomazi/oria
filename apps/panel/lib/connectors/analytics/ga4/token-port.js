'use strict';

// Fase E · troca refresh_token → access_token na conta do Google. A MENOR camada extraída de
// `server.js` (a função `renovarAccessTokenGA4`): só o POST ao endpoint de token do Google, sobre a
// infraestrutura já genérica de `lib/google/http.js` (a mesma usada por Meta/GA4/Google Ads hoje).
//
//   connector → GA4 token port (este arquivo) → lib/google/http.js
//
// Não importa server.js. Não lê ConnectorSecretPort nem integrations — quem chama já tem o
// refresh_token em mãos (via ConnectorSecretPort.use, callback de uso imediato) e entrega aqui.
// `clientId`/`clientSecret` são credencial de PLATAFORMA (o app OAuth do Oria), não segredo de
// tenant — por isso, ao contrário do connector, é legítimo default para `process.env` aqui, no
// mesmo sentido em que `INK_API_BASE` é uma constante: não é fallback de credencial de cliente.

const { fetchGoogle, erroGoogle } = require('../../../google/http');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/**
 * @param {{refreshToken: string, clientId?: string, clientSecret?: string, fetchImpl?: Function}} entrada
 * @returns {Promise<{accessToken: string, expiresAt: Date}>}
 */
async function refreshAccessToken({
  refreshToken, clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET, fetchImpl,
}) {
  if (!refreshToken) throw new TypeError('refreshAccessToken exige refreshToken');
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error('credencial de plataforma do Google ausente (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET)'), { codigo: 'GOOGLE_PLATFORM_CREDENTIAL_MISSING' });
  }
  const res = await fetchGoogle(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token' }),
  }, { idempotente: true, fetchFn: fetchImpl });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw erroGoogle(res.status, data, 'renovação de token GA4');
  if (!data.access_token || !Number.isFinite(Number(data.expires_in))) {
    throw Object.assign(new Error('resposta de renovação de token sem access_token/expires_in'), { codigo: 'GOOGLE_TOKEN_RESPONSE_INVALID' });
  }
  return { accessToken: data.access_token, expiresAt: new Date(Date.now() + Number(data.expires_in) * 1000) };
}

module.exports = { refreshAccessToken, GOOGLE_TOKEN_URL };
