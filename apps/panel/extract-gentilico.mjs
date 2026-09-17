#!/usr/bin/env node
// Vincula produtos gentílico às cidades corretas.
//
// Problema: o slug "tijuquense-gentilico-sc" não contém o nome da cidade.
// Solução: para cada cidade sem gentílico, busca pelo nome da cidade na loja
// e verifica se algum produto gentílico do mesmo estado aparece nos resultados.
//
// Uso:
//   node extract-gentilico.mjs [marca]     (padrão: usesul)
//   node extract-gentilico.mjs usesul --dry

import fs from 'fs';

const BRANDS = {
  usesul:    { baseUrl: 'https://www.usesul.com.br',    store: 'usesul' },
  usecentro: { baseUrl: 'https://www.usecentro.com.br', store: 'usecentro' },
  usenorte:  { baseUrl: 'https://www.usenorte.com.br',  store: 'usenorte' },
};

const BRAND      = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'usesul';
const DRY        = process.argv.includes('--dry');
const FILE       = 'data/cities.json';
const UA         = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const CONCURRENCY = 8;
const UUID_RE    = /-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CDN_HOST   = 'gcp-images.majestic.ink.rsvcloud.com';
const CDN_PATH   = '/images/product_v2/main_image/';

const brand = BRANDS[BRAND];
if (!brand) { console.error(`Marca desconhecida: ${BRAND}`); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

function cdnToLocal(html) {
  const re = new RegExp(`https://${CDN_HOST}${CDN_PATH}([a-f0-9]{32}\\.webp)`, 'g');
  const m = re.exec(html || '');
  return m ? `/img/${m[1]}` : null;
}

function ogImage(html) {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? cdnToLocal(m[1]) : null;
}

// Busca por nome de cidade e retorna slugs de produtos gentílico no mesmo estado
async function findGentilico(cityName, state, store, baseUrl) {
  const url = `${baseUrl}/${store}/products?search_filter=${encodeURIComponent(cityName)}`;
  const html = await fetchHtml(url);
  if (!html) return [];

  const re = new RegExp(`/${store}/product/([a-z0-9-]+-gentilico-${state.toLowerCase()}[^"?]*)`, 'g');
  const matches = [...html.matchAll(re)].map(m => m[1].replace(UUID_RE, ''));
  return [...new Set(matches)];
}

async function runPool(items, concurrency, fn) {
  const queue = [...items];
  let done = 0; const total = items.length;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      await fn(queue.shift());
      done++;
      if (done % 20 === 0 || done === total)
        process.stdout.write(`  ${done}/${total}\r`);
    }
  }));
  process.stdout.write('\n');
}

async function run() {
  const cities = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  const targets = cities.filter(c =>
    c.brand === BRAND && c.state && !c.gentilico
  );

  console.log(`[${BRAND}] ${targets.length} cidades sem gentílico para verificar...`);

  const { baseUrl, store } = brand;
  let found = 0; let fetched = 0;

  await runPool(targets, CONCURRENCY, async (city) => {
    const slugs = await findGentilico(city.cityName, city.state, store, baseUrl);
    if (!slugs.length) return;

    // Pega og:image do primeiro slug
    const prodUrl = `${baseUrl}/${store}/product/${slugs[0]}`;
    const html    = await fetchHtml(prodUrl);
    const imgUrl  = html ? ogImage(html) : null;
    fetched++;

    city.gentilico = { url: prodUrl, imageUrl: imgUrl };
    found++;
  });

  console.log(`\nGentílicos vinculados: ${found} (${fetched} páginas buscadas)`);

  if (DRY) { console.log('(--dry) nada gravado.'); return; }

  fs.copyFileSync(FILE, `${FILE}.bak`);
  fs.writeFileSync(FILE, JSON.stringify(cities, null, 2));
  console.log(`cities.json atualizado (backup em ${FILE}.bak)`);
}

run().catch(console.error);
