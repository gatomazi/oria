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
  if (p === '/v1/stores/customers' && metodo === 'GET') {
    // A: já pediu (mesmo documento/telefone do pedido do mock). B: só cadastro, nunca pediu.
    const A = { id: base + 500, first_name: 'Cliente', last_name: tag, email: `c${tag.toLowerCase()}@exemplo.com`, phone: '11999990000', document: '12345678901', accepts_marketing: true };
    const B = { id: base + 501, first_name: 'Cadastro', last_name: tag, email: `n${tag.toLowerCase()}@exemplo.com`, phone: '11888880000', document: '99999999999', accepts_marketing: false };
    // Com `page` o cadastro vem em 2 páginas (A, depois B); sem `page` é a chamada antiga da lista de 100.
    const pagina = new URL(url, 'http://ink.invalid').searchParams.get('page');
    if (!pagina) return json({ customers: [A], total_pages: 1 });
    // Token de teste com `cadastro-falha`: a Ink recusa a leitura paginada do cadastro (fora do ar).
    if (String(auth || '').includes('cadastro-falha')) return json({ error: 'indisponível' }, 503);
    return json({ customers: Number(pagina) === 1 ? [A] : [B], page: Number(pagina), total_pages: 2 });
  }
  if (p === '/v1/stores/product_types') return json({ product_types: [{ id: base + 10, name: 'Camiseta' }] });
  if (p === '/v1/stores/collections' && metodo === 'GET') {
    // Só a Store D traz product_ids na lista (como a Ink de verdade; o painel devolve só a contagem). As demais
    // seguem vazias: o job de categorias em lote lê esta lista para saber o que já está associado.
    const ids = tag === 'D' ? [base + 1, base + 2, base + 3] : [];
    // Com `page` na query a Ink pagina: o mock devolve 3 páginas de 20 itens e ecoa a página pedida.
    const pagina = new URL(url, 'http://ink.invalid').searchParams.get('page');
    return json(pagina
      ? { collections: [{ id: base + 100, name: `Categoria ${tag}`, product_ids: ids }], page: Number(pagina), total_pages: 3, total_count: 60 }
      : { collections: [{ id: base + 100, name: `Categoria ${tag}`, product_ids: ids }], total_pages: 1 });
  }
  if (p === '/v1/stores/collections' && metodo === 'POST') {
    return json({ collection: { id: base + 101, name: JSON.parse(corpo || '{}').name || `Categoria ${tag} nova` } }, 201);
  }
  if ((m = p.match(/^\/v1\/stores\/collections\/(\d+)$/))) return json({ collection: { id: Number(m[1]), name: `Categoria ${tag}`, product_ids: [] } });
  if (p === '/v1/stores/product_clusters') {
    const pagina = new URL(url, 'http://ink.invalid').searchParams.get('page');
    const cluster = { id: base + 200, default_product_id: base + 1, product_ids: [base + 1, base + 2] };
    return json(pagina
      ? { product_clusters: [cluster], page: Number(pagina), total_pages: 3, total_count: 60 }
      : { product_clusters: [cluster], total_pages: 1 });
  }
  if ((m = p.match(/^\/v1\/stores\/product_clusters\/(\d+)$/))) {
    return json({ product_cluster: { id: Number(m[1]), default_product_id: base + 1, product_ids: [base + 1, base + 2] } });
  }
  if ((m = p.match(/^\/v1\/stores\/orders\/(\d+)$/))) {
    const pedido = pedidoInk(Number(m[1]), tag);
    // Pedido com Pix pendente (id terminado em 777): o vínculo manual grava o pedido no banco.
    if (Number(m[1]) % 1000 === 777) {
      Object.assign(pedido, { payment_status: 'pending', payment_method: 'pix', pix: { qr_code: '00020126580014br.gov.bcb.pix0136teste-claude', expiration_date: new Date(Date.now() + 3600_000).toISOString() } });
    }
    return json({ order: pedido });
  }
  // Lista de pedidos: vazia, exceto no backfill histórico (`begin_date=2015-01-01`), que traz UM
  // pedido da "loja" do token — o bastante para provar ingestão por Store sem mexer nos outros testes.
  if (p === '/v1/stores/orders') {
    const historico = url.searchParams.get('begin_date') === '2015-01-01';
    return json({ orders: historico ? [pedidoInk(base + 500, tag)] : [], total_pages: 1, meta: { total_pages: 1 } });
  }
  // Carrinhos abandonados (Recuperação sem webhook): UM carrinho, com telefone e e-mail da "loja de teste".
  // Só para tokens marcados com `-carrinho` (os demais testes veem a lista vazia, como sempre viram).
  if (p === '/v1/stores/abandoned_carts' && !String(auth || '').includes('-carrinho')) return json({ abandoned_carts: [], total_pages: 1 });
  if (p === '/v1/stores/abandoned_carts') {
    return json({ abandoned_carts: [{ id: base + 300, created_at: new Date().toISOString(), contactable: true,
      buyer: { first_name: 'Carla', last_name: tag, phone: '11988887777', document: '98765432100', email: `carrinho${tag}@exemplo.com`, marketing: true },
      items: [{ product_name: `Produto ${tag}1`, quantity: 1 }] }], total_pages: 1 });
  }
  // Trocas, reembolsos e promoções: o id carrega a faixa da "loja de teste" do token.
  if (p === '/v1/stores/exchanges' && metodo === 'GET') {
    return json({ exchanges: [{ id: base + 700, exchange_type: 'exchange', status: 'waiting', old_order: { id: base + 500 }, created_at: new Date().toISOString() }], page: 1, per_page: 20, total_pages: 1, total_count: 1 });
  }
  if (p === '/v1/stores/exchanges' && metodo === 'POST') {
    return json({ exchange: { id: base + 701, status: 'waiting', old_order: { id: JSON.parse(corpo || '{}').original_order_id } } }, 201);
  }
  if ((m = p.match(/^\/v1\/stores\/exchanges\/(\d+)$/))) return json({ exchange: { id: Number(m[1]), status: 'waiting', old_order: { id: base + 500 } } });
  if ((m = p.match(/^\/v1\/stores\/orders\/(\d+)\/refunds$/))) {
    if (metodo === 'POST') return json({ refund: { id: base + 801, value: 10 } }, 201);
    return json({ refunds: [{ id: base + 800, value: 10 }] });
  }
  if (p === '/v1/stores/promotions' && metodo === 'GET') return json({ promotions: [{ id: base + 900, code: `PROMO${tag}`, type: 'standard' }] });
  if ((m = p.match(/^\/v1\/stores\/promotions\/(standard|progressive|unit_free)$/)) && metodo === 'POST') {
    return json({ promotion: { id: base + 901, type: m[1], code: JSON.parse(corpo || '{}').code } }, 201);
  }
  if ((m = p.match(/^\/v1\/stores\/promotions\/(standard|progressive|unit_free)\/(\d+)$/)) && metodo === 'PATCH') {
    return json({ promotion: { id: Number(m[2]), type: m[1], ...JSON.parse(corpo || '{}') } });
  }
  if ((m = p.match(/^\/v1\/stores\/promotions\/(\d+)$/)) && metodo === 'DELETE') return json({});
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
    case 'graph.facebook.com': {
      // Tokens do fluxo OAuth simulado: o code `meta<X>` vira `EAAG-oauth-meta<X>` (curto) e, na troca
      // por longa duração, `EAAG-long-<X>`. A ÚLTIMA letra do token é a "loja de teste": ela escolhe a
      // conta de anúncio e o gasto — prova de qual credencial (e, portanto, de qual Store) foi usada.
      const longo = String(auth || '').startsWith('Bearer EAAG-long-');
      const tag = String(auth || '').slice(-1);
      // ── WhatsApp · Embedded Signup (app da Meta do WhatsApp, distinto do de Ads) ──────────────
      // code `wa-<WABA>-<NUMERO>[-flag]` vira o token `WAT-<WABA>-<NUMERO>[-flag]`. O token só "enxerga"
      // a WABA e o número que carrega — prova do que a Meta confirma, independente do que o navegador
      // afirmou. Flags: `foreign` = token de OUTRO app; `subfail` = assinar webhooks falha;
      // `regfail` = registrar o número falha.
      const codigoWa = url.searchParams.get('code') || '';
      if (p.endsWith('/oauth/access_token') && codigoWa.startsWith('wa-')) {
        if (codigoWa.includes('-expired')) return json({ error: { message: 'code expirado', code: 100 } }, 400);
        return json({ access_token: `WAT-${codigoWa.slice(3)}` });
      }
      const entrada = url.searchParams.get('input_token') || '';
      if (p.endsWith('/debug_token') && entrada.startsWith('WAT-')) {
        const [waba] = entrada.slice(4).split('-');
        const appDaChamada = String(url.searchParams.get('access_token') || '').split('|')[0];
        return json({ data: {
          is_valid: true, app_id: entrada.includes('-foreign') ? '999' : appDaChamada,
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          granular_scopes: [{ scope: 'whatsapp_business_management', target_ids: [waba] }, { scope: 'whatsapp_business_messaging', target_ids: [waba] }],
        } });
      }
      if (String(auth || '').startsWith('Bearer WAT-')) {
        const [waba, numero] = String(auth).slice('Bearer WAT-'.length).split('-');
        if (p.endsWith('/phone_numbers')) return json({ data: [{ id: numero, display_phone_number: '+55 48 99999-0000', verified_name: 'Loja de Teste' }] });
        if (p.endsWith('/subscribed_apps')) return String(auth).includes('-subfail') ? json({ error: { code: 100 } }, 400) : json({ success: true });
        if (p.endsWith('/register')) return String(auth).includes('-regfail') ? json({ error: { code: 100 } }, 400) : json({ success: true });
        void waba;
      }
      if (p.endsWith('/me/permissions')) return json({ success: true });
      if (p.endsWith('/debug_token')) {
        return json({ data: { is_valid: true, user_id: '1', scopes: ['ads_read'], expires_at: Math.floor(Date.now() / 1000) + 5_000_000 } });
      }
      if (p.endsWith('/oauth/access_token')) {
        const troca = url.searchParams.get('fb_exchange_token');
        if (troca) return json({ access_token: `EAAG-long-${troca.slice(-1)}`, expires_in: 5_000_000 });
        return json({ access_token: `EAAG-oauth-${url.searchParams.get('code') || 'longo'}`, expires_in: 3600 });
      }
      if (p.endsWith('/me')) return json({ id: '1', name: 'Pessoa' });
      if (longo && p.endsWith('/me/adaccounts')) {
        return json({ data: [{ id: `act_${tag}001`, name: `Conta ${tag}`, currency: 'BRL', timezone_name: 'America/Sao_Paulo', timezone_offset_hours_utc: -3, account_status: 1, amount_spent: '100000', spend_cap: '0' }], paging: {} });
      }
      // Insights só no nível da conta: UMA linha de hoje, com gasto derivado da "loja de teste".
      if (longo && p.endsWith('/insights') && url.searchParams.get('level') === 'account') {
        const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
        return json({ data: [{ date_start: hoje, date_stop: hoje, account_id: `${tag}001`, spend: String(100 + (tag.charCodeAt(0) % 50)), impressions: '1000', clicks: '50', reach: '900' }], paging: {} });
      }
      return json({ data: [], paging: {} });
    }
    case 'oauth2.googleapis.com': {
      if (p === '/revoke') return json({});
      const form = new URLSearchParams(String(corpo || ''));
      if (form.get('grant_type') === 'refresh_token') {
        // Refresh token de uma conexão "revogada": o Google devolve invalid_grant (consentimento acabou).
        if (String(form.get('refresh_token') || '').includes('revoked')) {
          return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        }
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
      // ── Product Analytics (rodada H→I, lib/connectors/analytics/ga4/) ──────────────────────────
      // GET properties/{id}/metadata: item-scoped completo (itemId/itemName + as 5 métricas de
      // item) — nenhum teste legado chama este endpoint, então não há comportamento a preservar.
      if (metodo === 'GET' && /\/properties\/\d+\/metadata$/.test(p)) {
        return json({
          dimensions: [{ apiName: 'itemId' }, { apiName: 'itemName' }],
          metrics: ['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue'].map((apiName) => ({ apiName })),
        });
      }
      // POST properties/{id}:checkCompatibility: tudo compatível (o mock não simula propriedade
      // incompatível — isso já tem cobertura própria em test/connectors-analytics-ga4-*.test.js).
      if (metodo === 'POST' && /:checkCompatibility$/.test(p)) {
        return json({
          dimensionCompatibilities: [{ dimensionMetadata: { apiName: 'itemId' }, compatibility: 'COMPATIBLE' }, { dimensionMetadata: { apiName: 'itemName' }, compatibility: 'COMPATIBLE' }],
          metricCompatibilities: ['itemsViewed', 'itemsAddedToCart', 'itemsCheckedOut', 'itemsPurchased', 'itemRevenue'].map((apiName) => ({ metricMetadata: { apiName }, compatibility: 'COMPATIBLE' })),
        });
      }
      const m = p.match(/properties\/(\d+):runReport$/);
      if (m) {
        const propertyId = m[1];
        const escala = Number(propertyId.slice(-3)) || 1;
        // O corpo decide o formato: dimensão `itemId` = Product Analytics; senão, o runReport
        // legado (UTM/consolidado) — comportamento ORIGINAL, intocado, pra não quebrar teste nenhum.
        let itemScoped = false;
        try { itemScoped = JSON.parse(corpo || '{}').dimensions?.some((d) => d.name === 'itemId'); } catch { /* corpo não é JSON: trata como legado */ }
        if (itemScoped) {
          // Números proporcionais ao id da propriedade — mesma prova de "qual property foi
          // consultada" que o runReport legado já usa (escala vem do id).
          const linha = {
            dimensionValues: [{ value: `sku-mock-${propertyId}` }, { value: `Produto Mock ${propertyId}` }],
            metricValues: [escala * 10, escala * 2, escala, Math.max(1, Math.floor(escala / 2)), escala * 9.9].map((value) => ({ value: String(value) })),
          };
          return json({ rows: [linha], rowCount: 1 });
        }
        const linha = { dimensionValues: ['instagram', 'paid_social', 'bf26', '(not set)', '(not set)'].map((value) => ({ value })), metricValues: [escala, escala - 1, 5, escala * 10].map((value) => ({ value: String(value) })) };
        return json({ rows: [linha], totals: [{ metricValues: linha.metricValues }], rowCount: 1 });
      }
      return json({}, 404);
    }
    case 'api.openai.com':
      // Chave "inválida" (o texto contém `invalid`): a OpenAI a recusa com 401, como faria de verdade.
      if (String(auth || '').includes('invalid')) return json({ error: { message: 'Incorrect API key provided' } }, 401);
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
  // Controle de teste (arquivo JSON relido a cada chamada): o cadastro de clientes da Ink pode ficar lento ou fora do ar
  // para provar que isso não contamina a lista de Clientes. Ausente = comportamento de sempre.
  if (url.hostname === 'api.reserva.ink' && url.pathname === '/v1/stores/customers' && process.env.PROVIDER_MOCK_CONTROL) {
    let controle = {};
    try { controle = JSON.parse(fs.readFileSync(process.env.PROVIDER_MOCK_CONTROL, 'utf8')); } catch { controle = {}; }
    if (controle.clientesCadastro === 'lento') await new Promise((r) => setTimeout(r, Number(controle.atrasoMs) || 3000));
    if (controle.clientesCadastro === 'falha') return json({ error: 'indisponível (simulado)' }, 503);
  }
  return responder(url, metodo, corpo, headers.get('authorization'));
};
