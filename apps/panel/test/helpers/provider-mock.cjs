'use strict';

// Mock dos providers externos para o processo real do server.js (carregado com `node --require`).
// Intercepta globalThis.fetch só para os hosts abaixo, responde localmente e anota cada chamada
// (host, caminho, método, Authorization, corpo) em PROVIDER_MOCK_LOG, uma linha JSON por chamada.
// Nada disso existe no código de produção.

const fs = require('node:fs');

const LOG = process.env.PROVIDER_MOCK_LOG;
const HOSTS = new Set([
  'api.reserva.ink',
  'graph.facebook.com',
  'oauth2.googleapis.com',
  'googleads.googleapis.com',
  'analyticsadmin.googleapis.com',
  'analyticsdata.googleapis.com',
  'api.openai.com',
]);
const original = globalThis.fetch;

const json = (corpo, status = 200) => new Response(JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

function responder(url, metodo, corpo) {
  const p = url.pathname;
  switch (url.hostname) {
    case 'api.reserva.ink':
      // Financeiro (somente leitura): valores fixos e reconhecíveis, para o teste provar que a
      // resposta veio da Ink consultada com a credencial da Organization certa.
      if (p === '/v1/stores/balance') return json({ balance: { available: 1234.56, pending: 78.9 } });
      if (p === '/v1/stores/balance_extract') return json({ balance_extract: [{ id: 1, description: 'venda', value: 10 }], page: 1, total_pages: 1, has_more: false });
      if (p === '/v1/stores/prepayments') return json({ prepayments: [{ id: 7, value: 5 }] });
      if (p === '/v1/stores/withdraws') return json({ withdraws: [{ id: 9, value: 3 }] });
      return json(p.startsWith('/v1/stores/orders') ? { orders: [], meta: { total_pages: 1 } } : {});
    case 'graph.facebook.com':
      if (p.endsWith('/me/permissions')) return json({ success: true });
      if (p.endsWith('/debug_token')) {
        return json({ data: { is_valid: true, user_id: '1', scopes: ['ads_read'], expires_at: Math.floor(Date.now() / 1000) + 5_000_000 } });
      }
      if (p.endsWith('/oauth/access_token')) return json({ access_token: `EAAG-oauth-${url.searchParams.get('code') || 'longo'}`, expires_in: 5_000_000 });
      if (p.endsWith('/me')) return json({ id: '1', name: 'Pessoa' });
      return json({ data: [], paging: {} });
    case 'oauth2.googleapis.com': {
      if (p === '/revoke') return json({});
      const form = new URLSearchParams(String(corpo || ''));
      if (form.get('grant_type') === 'refresh_token') {
        return json({ access_token: `ya29.${form.get('refresh_token')}`, expires_in: 3600 });
      }
      return json({ access_token: `ya29.code-${form.get('code')}`, refresh_token: `1//code-refresh-${form.get('code')}`, expires_in: 3600, scope: 'x' });
    }
    case 'googleads.googleapis.com':
      return json(p.includes('listAccessibleCustomers') ? { resourceNames: [] } : { results: [] });
    case 'analyticsadmin.googleapis.com':
      return json({ accountSummaries: [] });
    case 'api.openai.com':
      return json({ data: [] });
    default:
      return json({}, 404);
  }
}

globalThis.fetch = async function fetchComMock(entrada, init = {}) {
  let url;
  try { url = new URL(typeof entrada === 'string' || entrada instanceof URL ? String(entrada) : entrada.url); } catch { return original(entrada, init); }
  if (!HOSTS.has(url.hostname)) return original(entrada, init);
  const headers = new Headers(init.headers || {});
  const corpo = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : null;
  const metodo = (init.method || 'GET').toUpperCase();
  if (LOG) {
    fs.appendFileSync(LOG, `${JSON.stringify({
      host: url.hostname, caminho: url.pathname, metodo,
      auth: headers.get('authorization'), corpo, query: url.search,
    })}\n`);
  }
  return responder(url, metodo, corpo);
};
