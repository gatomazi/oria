#!/usr/bin/env node
// Diagnóstico SÓ LEITURA: mostra a resposta crua da Ink (status, headers, corpo) de produtos
// específicos — pra comparar um produto preso em resizing com um que terminou. Não cria nada.
//
//   INK_TOKEN_SUL=... node scripts/migracao-diagnostico.mjs <id> [<id> ...]
//   INK_TOKEN_SUL=... node scripts/migracao-diagnostico.mjs <id> --completo   # sem resumir variantes

import { INK } from './migracao-config.mjs';

const token = process.env.INK_TOKEN_SUL;
const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const COMPLETO = process.argv.includes('--completo');
if (!token || !ids.length) { console.error('uso: INK_TOKEN_SUL=... node scripts/migracao-diagnostico.mjs <id> [<id> ...] [--completo]'); process.exit(1); }

const HEADERS_UTEIS = ['content-type', 'x-request-id', 'x-runtime', 'retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'date'];

async function mostrar(rota) {
  const res = await fetch(INK + rota, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60000) });
  const txt = await res.text();
  let corpo; try { corpo = JSON.parse(txt); } catch { corpo = txt.slice(0, 2000); }
  console.log(`\n\x1b[1mGET ${rota}\x1b[0m  →  ${res.status} ${res.statusText}`);
  for (const h of HEADERS_UTEIS) if (res.headers.get(h)) console.log(`  ${h}: ${res.headers.get(h)}`);
  const p = corpo?.product;
  if (p && !COMPLETO && Array.isArray(p.product_variants)) {
    // 50–100 variantes com a mesma cara: resume, mas guarda uma de amostra inteira e conta os campos
    // que variam (é onde apareceria mockup ausente por cor/modelo).
    const v = p.product_variants;
    const semImagem = v.filter((x) => Object.entries(x).some(([k, val]) => /image|mockup/i.test(k) && !val)).length;
    corpo = { ...corpo, product: { ...p, product_variants: `[${v.length} variantes · ${semImagem} com campo de imagem vazio · 1ª abaixo]`, _variante_amostra: v[0] } };
  }
  console.log(JSON.stringify(corpo, null, 2));
  return p;
}

for (const id of ids) {
  const p = await mostrar(`/v1/stores/products/${id}`);
  if (p?.product_cluster_id) await mostrar(`/v1/stores/product_clusters/${p.product_cluster_id}`);
}
