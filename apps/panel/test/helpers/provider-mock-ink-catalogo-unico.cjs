'use strict';

// Wrapper ADITIVO em volta de provider-mock.cjs — nunca o modifica, só embrulha o fetch que ele já
// reescreveu. Existe só para test/invariants/catalog-sync-automatico.test.js: o fixture PADRÃO do
// mock compartilhado (`produtoInk`, FAIXA_INK) usa os MESMOS ids de variante (1 e 2) em TODOS os
// produtos de uma loja — inofensivo pros testes que já existem (nenhum deles varre o catálogo
// completo com listProductsWithVariants pela API real da Ink), mas colide de propósito errado
// quando um full catalog sync tenta fazer 1 upsert em LOTE de todas as variantes da página: Postgres
// recusa "ON CONFLICT DO UPDATE" afetando a MESMA linha (organization_id, store_id, provider,
// provider_variant_id) duas vezes dentro do MESMO INSERT — aqui viraria 3 produtos todos reclamando
// variant_id "1" e "2" na mesma chamada. Este arquivo só corrige ISSO: cada produto ganha ids de
// variante próprios, o resto do catálogo (nome, preço, tipo) continua igual ao fixture original.
require('./provider-mock.cjs'); // já reescreveu globalThis.fetch
const original = globalThis.fetch;

const FAIXA_INK = { A: 3000, C: 1000, D: 2000 };

function tagInk(auth) {
  return String(auth || '').replace(/^Bearer /, '')[3] || 'X';
}

globalThis.fetch = async function fetchComVariantesUnicas(entrada, init = {}) {
  let url;
  try { url = new URL(typeof entrada === 'string' || entrada instanceof URL ? String(entrada) : entrada.url); } catch { return original(entrada, init); }
  const metodo = (init.method || 'GET').toUpperCase();
  if (url.hostname === 'api.reserva.ink' && url.pathname === '/v1/stores/products' && metodo === 'GET') {
    const headers = new Headers(init.headers || {});
    const tag = tagInk(headers.get('authorization'));
    const base = FAIXA_INK[tag] || 9000;
    const produtos = [1, 2, 3].map((i) => ({
      id: base + i,
      name: `Produto ${tag}${i}`,
      main_image_url: null,
      price: '50.0',
      promotional_price: null,
      visible_in_store: true,
      approval_status: 'approved',
      status: 'active',
      product_type: { id: base + 10, name: 'Camiseta' },
      // Únicas por produto (base + i*100 + n) — nunca repetidas entre produtos da mesma página.
      product_variants: [{ id: base + i * 100 + 1 }, { id: base + i * 100 + 2 }],
      updated_at: new Date().toISOString(),
    }));
    return new Response(
      JSON.stringify({ products: produtos, total_pages: 1, total_count: produtos.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
  return original(entrada, init);
};
