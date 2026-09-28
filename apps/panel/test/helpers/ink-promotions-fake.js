'use strict';

// INK FALSA em memória que segue o contrato oficial de Promoções (developers.reserva.ink/referencia, tag Promoções, conferido em 28/09/2026):
//   leitura → { promotions[], page, per_page, total_pages, total_count } e { promotion }; `discount_tiers` com `discount` STRING ("10.0");
//   escrita → corpo com `discount_tier` (discount NUMBER), Idempotency-Key obrigatório, 201/200 com { promotion }, DELETE 204 (soft delete).
// Nenhuma rede: serve a testes de contrato e ao seed local. NÃO prova o comportamento da conta real da loja.

function erroHttp(status, details) {
  const err = new Error(`INK API respondeu ${status}`);
  err.status = status;
  if (details) err.details = details;
  return err;
}

function criarInkFalsa({ agora = () => new Date('2026-10-01T12:00:00Z') } = {}) {
  const promocoes = new Map();
  const respostas = new Map(); // Idempotency-Key → resposta original (replay)
  const chamadas = [];
  const falhas = { get: [], post: [], patch: [], delete: [] };
  const perdaDeResposta = { post: 0 };
  let sequencia = 100;

  const emitir = (metodo, chave) => { const f = falhas[metodo]; const proxima = f.shift(); if (proxima) { if (proxima === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } throw erroHttp(proxima, chave); } };

  function disponivel(p) {
    const t = agora().getTime();
    if (p.starts_at && new Date(p.starts_at).getTime() > t) return false;
    if (p.expires_at && new Date(p.expires_at).getTime() <= t) return false;
    return true; // usage_limit não é simulado
  }
  const dec = (v) => (v === null || v === undefined ? null : Number(v).toFixed(1));
  function leitura(p) {
    return {
      id: p.id, type: 'standard', code: p.code, kind: p.kind, apply_automatically: p.apply_automatically, list_type: p.list_type, progress_kind: null, usage_limit: p.usage_limit,
      first_purchase: p.first_purchase, show_on_product_page: p.show_on_product_page, show_in_cart: p.show_in_cart, starts_at: p.starts_at, expires_at: p.expires_at, available: disponivel(p),
      discount_tiers: [{ min_cart_value: dec(p.min_cart_value), min_cart_items: p.min_cart_items ?? null, discount: dec(p.discount) }],
      product_ids: p.product_ids, product_type_ids: p.product_type_ids, collection_ids: p.collection_ids, created_at: p.created_at, updated_at: p.updated_at,
    };
  }
  function normalizarEscrita(corpo, base = {}) {
    const t = corpo.discount_tier;
    return {
      ...base,
      ...(corpo.code !== undefined ? { code: corpo.code } : {}),
      ...(corpo.kind !== undefined ? { kind: corpo.kind } : {}),
      ...(corpo.list_type !== undefined ? { list_type: corpo.list_type } : {}),
      ...(corpo.apply_automatically !== undefined ? { apply_automatically: corpo.apply_automatically } : {}),
      ...(corpo.first_purchase !== undefined ? { first_purchase: corpo.first_purchase } : {}),
      ...(corpo.show_on_product_page !== undefined ? { show_on_product_page: corpo.show_on_product_page } : {}),
      ...(corpo.show_in_cart !== undefined ? { show_in_cart: corpo.show_in_cart } : {}),
      ...(corpo.usage_limit !== undefined ? { usage_limit: corpo.usage_limit } : {}),
      ...(corpo.starts_at !== undefined ? { starts_at: corpo.starts_at } : {}),
      ...(corpo.expires_at !== undefined ? { expires_at: corpo.expires_at } : {}),
      ...(corpo.product_ids !== undefined ? { product_ids: corpo.product_ids } : {}),
      ...(corpo.product_type_ids !== undefined ? { product_type_ids: corpo.product_type_ids } : {}),
      ...(corpo.collection_ids !== undefined ? { collection_ids: corpo.collection_ids } : {}),
      ...(t ? { discount: t.discount, min_cart_value: t.min_cart_value ?? null, min_cart_items: t.min_cart_items ?? null } : {}),
    };
  }

  // Semeia uma promoção "criada no painel da INK" (formato de escrita do contrato, com defaults do painel quando omitidos).
  function semear(corpo) {
    const id = ++sequencia;
    const p = normalizarEscrita(corpo, {
      id, code: corpo.code, kind: 'percentage', list_type: 'all', apply_automatically: false, first_purchase: false, show_on_product_page: false, show_in_cart: false, usage_limit: null,
      starts_at: null, expires_at: null, product_ids: [], product_type_ids: [], collection_ids: [], min_cart_value: null, min_cart_items: null, discount: null, created_at: agora().toISOString(), updated_at: agora().toISOString(),
    });
    promocoes.set(id, p);
    return id;
  }

  const ativas = () => [...promocoes.values()].filter((p) => !p.excluida);
  const chaveObrigatoria = (headers) => { if (!headers || !headers['Idempotency-Key']) throw erroHttp(400, { errors: ['Idempotency-Key ausente'] }); return headers['Idempotency-Key']; };

  const client = {
    async get(path) {
      chamadas.push(['GET', path]);
      emitir('get');
      const u = new URL(path, 'https://ink.invalid');
      const m = u.pathname.match(/^\/v1\/stores\/promotions\/(\d+)$/);
      if (m) { const p = promocoes.get(Number(m[1])); if (!p || p.excluida) throw erroHttp(404); return { promotion: leitura(p) }; }
      if (u.pathname !== '/v1/stores/promotions') throw erroHttp(404);
      const code = u.searchParams.get('code');
      const porPagina = Math.min(Number(u.searchParams.get('per_page') || 5), 100);
      const todas = ativas().filter((p) => !code || p.code.toLowerCase() === code.toLowerCase());
      return { promotions: todas.slice(0, porPagina).map(leitura), page: 1, per_page: porPagina, total_pages: Math.max(1, Math.ceil(todas.length / porPagina)), total_count: todas.length };
    },
    async post(path, body, headers) {
      chamadas.push(['POST', path, body, headers]);
      emitir('post');
      const chave = chaveObrigatoria(headers);
      if (path !== '/v1/stores/promotions/standard') throw erroHttp(404);
      if (respostas.has(chave)) return respostas.get(chave);
      if (!body.discount_tier) throw erroHttp(422, { errors: ['discount_tier é obrigatório'] });
      if (ativas().some((p) => p.code.toLowerCase() === String(body.code).toLowerCase())) throw erroHttp(422, { errors: ['code já está em uso'] });
      const id = semear(body);
      const resposta = { promotion: leitura(promocoes.get(id)) };
      respostas.set(chave, resposta);
      if (perdaDeResposta.post > 0) { perdaDeResposta.post -= 1; const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
      return resposta;
    },
    async patch(path, body, headers) {
      chamadas.push(['PATCH', path, body, headers]);
      emitir('patch');
      const chave = chaveObrigatoria(headers);
      const m = path.match(/^\/v1\/stores\/promotions\/standard\/(\d+)$/);
      const p = m && promocoes.get(Number(m[1]));
      if (!p || p.excluida) throw erroHttp(404);
      if (respostas.has(chave)) return respostas.get(chave);
      Object.assign(p, normalizarEscrita(body, p), { updated_at: agora().toISOString() });
      const resposta = { promotion: leitura(p) };
      respostas.set(chave, resposta);
      return resposta;
    },
    async delete(path, headers) {
      chamadas.push(['DELETE', path, headers]);
      emitir('delete');
      const chave = chaveObrigatoria(headers);
      const m = path.match(/^\/v1\/stores\/promotions\/(\d+)$/);
      const p = m && promocoes.get(Number(m[1]));
      if (respostas.has(chave)) return respostas.get(chave); // replay idempotente
      if (!p || p.excluida) throw erroHttp(404);
      p.excluida = true; // soft delete: some das listagens e libera o código
      respostas.set(chave, {});
      return {};
    },
  };

  return {
    client, chamadas, falhas, semear, leituras: () => ativas().map(leitura), promocao: (id) => promocoes.get(id),
    perderProximaRespostaDePost: (n = 1) => { perdaDeResposta.post = n; },
    escritas: () => chamadas.filter((c) => c[0] !== 'GET'),
    somenteLeitura: { get: client.get },
  };
}

module.exports = { criarInkFalsa };
