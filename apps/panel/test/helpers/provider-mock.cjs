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

// Catálogo/pedidos da Ink por "loja de teste": a 4ª letra do token Bearer (`inkC…`, `inkD…`, `inkA…`)
// escolhe uma faixa de ids própria. Assim um teste prova que cada Organization leu o catálogo da
// SUA credencial (e que nada de outra apareceu), sem o mock saber nada de Organization.
const FAIXA_INK = { A: 3000, C: 1000, D: 2000 };
function tagInk(auth) {
  return String(auth || '').replace(/^Bearer /, '')[3] || 'X';
}
function produtoInk(tag, i) {
  const base = FAIXA_INK[tag] || 9000;
  return {
    id: base + i, name: `Produto ${tag}${i}`, main_image_url: null, price: '50.0', promotional_price: null,
    visible_in_store: true, approval_status: 'approved', status: 'active',
    product_type: { id: base + 10, name: 'Camiseta' }, product_variants: [{ id: 1 }, { id: 2 }], updated_at: new Date().toISOString(),
  };
}
function pedidoInk(id, tag) {
  const base = FAIXA_INK[tag] || 9000;
  return {
    id, rsv_factory_id: null, payment_status: 'paid', order_status: 'awaiting_production', total_value: 100, shipping_value: 10,
    created_at: new Date().toISOString(),
    buyer: { first_name: 'Cliente', last_name: tag, phone: '11999990000', document: '12345678901', email: `c${tag}@exemplo.com`, accepts_marketing: true },
    shipping_address: { state: 'SP' },
    items: [{ id: id * 10 + 1, quantity: 1, unit_ink_base_price: 40, unit_additional_service_price: 0, total_price: 90, product_v2: { id: base + 1, name: `Produto ${tag}1` } }],
  };
}

function respostaDaInk(p, metodo, corpo, auth, url) {
  const tag = tagInk(auth);
  const base = FAIXA_INK[tag] || 9000;
  let m;
  if (p === '/v1/stores/products' && metodo === 'GET') {
    return json({ products: [1, 2, 3].map((i) => produtoInk(tag, i)), total_pages: 1, total_count: 3 });
  }
  if ((m = p.match(/^\/v1\/stores\/products\/(\d+)$/))) {
    if (metodo === 'PATCH') return json({ product: { id: Number(m[1]), collections: (JSON.parse(corpo || '{}').collections || []) } });
    return json({ product: { id: Number(m[1]), name: `Produto ${m[1]}`, main_image_url: null } });
  }
  if (p === '/v1/stores/product_types') return json({ product_types: [{ id: base + 10, name: 'Camiseta' }] });
  if (p === '/v1/stores/collections' && metodo === 'GET') {
    return json({ collections: [{ id: base + 100, name: `Categoria ${tag}`, product_ids: [] }], total_pages: 1 });
  }
  if (p === '/v1/stores/collections' && metodo === 'POST') {
    return json({ collection: { id: base + 101, name: JSON.parse(corpo || '{}').name || `Categoria ${tag} nova` } }, 201);
  }
  if ((m = p.match(/^\/v1\/stores\/collections\/(\d+)$/))) return json({ collection: { id: Number(m[1]), name: `Categoria ${tag}`, product_ids: [] } });
  if (p === '/v1/stores/product_clusters') {
    return json({ product_clusters: [{ id: base + 200, default_product_id: base + 1, product_ids: [base + 1, base + 2] }], total_pages: 1 });
  }
  if ((m = p.match(/^\/v1\/stores\/product_clusters\/(\d+)$/))) {
    return json({ product_cluster: { id: Number(m[1]), default_product_id: base + 1, product_ids: [base + 1, base + 2] } });
  }
  if ((m = p.match(/^\/v1\/stores\/orders\/(\d+)$/))) return json({ order: pedidoInk(Number(m[1]), tag) });
  // Lista de pedidos: vazia, exceto no backfill histórico (`begin_date=2015-01-01`), que traz UM
  // pedido da "loja" do token — o bastante para provar ingestão por Store sem mexer nos outros testes.
  if (p === '/v1/stores/orders') {
    const historico = url.searchParams.get('begin_date') === '2015-01-01';
    return json({ orders: historico ? [pedidoInk(base + 500, tag)] : [], total_pages: 1, meta: { total_pages: 1 } });
  }
  // Financeiro (somente leitura): valores fixos e reconhecíveis.
  if (p === '/v1/stores/balance') return json({ balance: { available: 1234.56, pending: 78.9 } });
  if (p === '/v1/stores/balance_extract') return json({ balance_extract: [{ id: 1, description: 'venda', value: 10 }], page: 1, total_pages: 1, has_more: false });
  if (p === '/v1/stores/prepayments') return json({ prepayments: [{ id: 7, value: 5 }] });
  if (p === '/v1/stores/withdraws') return json({ withdraws: [{ id: 9, value: 3 }] });
  return json({});
}

function responder(url, metodo, corpo, auth) {
  const p = url.pathname;
  switch (url.hostname) {
    case 'api.reserva.ink':
      return respostaDaInk(p, metodo, corpo, auth, url);
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
    case 'analyticsadmin.googleapis.com': {
      // A quantidade de propriedades vem do token (`ya29.code-<code>`): `single…` = uma (seleção
      // automática), `multi…` = duas (o tenant escolhe); qualquer outro = nenhuma. O id da propriedade
      // carrega a última letra do token, então cada "loja de teste" tem a sua.
      const token = String(auth || '').replace(/^Bearer /, '');
      const id = (i) => `${5550000 + token.charCodeAt(token.length - 1) * 10 + i}`;
      const props = token.includes('single') ? [1] : token.includes('multi') ? [1, 2] : [];
      return json({ accountSummaries: props.length ? [{ displayName: 'Conta GA', propertySummaries: props.map((i) => ({ property: `properties/${id(i)}`, displayName: `Site ${i}` })) }] : [] });
    }
    case 'analyticsdata.googleapis.com': {
      // runReport: UMA combinação de UTM, com números proporcionais ao id da propriedade — prova de
      // qual propriedade foi consultada (e, portanto, de qual Store).
      const m = p.match(/properties\/(\d+):runReport/);
      const escala = m ? Number(m[1].slice(-3)) : 1;
      const linha = { dimensionValues: ['instagram', 'paid_social', 'bf26', '(not set)', '(not set)'].map((value) => ({ value })), metricValues: [escala, escala - 1, 5, escala * 10].map((value) => ({ value: String(value) })) };
      return json({ rows: [linha], totals: [{ metricValues: linha.metricValues }], rowCount: 1 });
    }
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
  return responder(url, metodo, corpo, headers.get('authorization'));
};
