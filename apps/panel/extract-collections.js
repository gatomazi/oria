#!/usr/bin/env node
// Scrape das collections por estado (Use Sul + Use Centro)
// Gera data/collections.json com as estampas de referencia estadual

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COLLECTIONS = [
  { brand: 'usesul',    baseUrl: 'https://www.usesul.com.br',    store: 'usesul',    state: 'PR', slug: 'parana' },
  { brand: 'usesul',    baseUrl: 'https://www.usesul.com.br',    store: 'usesul',    state: 'SC', slug: 'santa-catarina' },
  { brand: 'usesul',    baseUrl: 'https://www.usesul.com.br',    store: 'usesul',    state: 'RS', slug: 'rio-grande-do-sul' },
  { brand: 'usecentro', baseUrl: 'https://www.usecentro.com.br', store: 'usecentro', state: 'GO', slug: 'goias' },
  { brand: 'usecentro', baseUrl: 'https://www.usecentro.com.br', store: 'usecentro', state: 'MT', slug: 'mato-grosso' },
  { brand: 'usecentro', baseUrl: 'https://www.usecentro.com.br', store: 'usecentro', state: 'MS', slug: 'mato-grosso-do-sul' },
  { brand: 'usecentro', baseUrl: 'https://www.usecentro.com.br', store: 'usecentro', state: 'DF', slug: 'distrito-federal' },
];

const MAX_PRODUCTS = 10;  // max por estado
const DELAY        = 350; // ms entre requisicoes
const OUTPUT       = path.join(__dirname, 'data', 'collections.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function fetchOgImage(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const match =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return match ? match[1] : null;
}

function extractProductLinks(html, baseUrl, store) {
  const pattern = new RegExp(`href="/${store}/product/([^"]+)"`, 'g');
  const matches = [...html.matchAll(pattern)];
  const slugs = [...new Set(matches.map(m => m[1]))];
  return slugs.map(slug => ({ slug, url: `${baseUrl}/${store}/product/${slug}` }));
}

function isCityProduct(slug) {
  return slug.includes('-origem-') || slug.includes('-coordenadas');
}

function productName(slug) {
  return slug
    .replace(/-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function scrapeCollection(col) {
  const { brand, baseUrl, store, state, slug } = col;
  const url = `${baseUrl}/${store}/collections/${slug}`;
  console.log(`\n[${brand} / ${state}] ${url}`);

  const html = await fetchHtml(url);
  if (!html) { console.log('  erro ao buscar página'); return null; }

  const all   = extractProductLinks(html, baseUrl, store);
  const refs  = all.filter(p => !isCityProduct(p.slug));

  console.log(`  ${all.length} produtos encontrados, ${refs.length} referencias estaduais`);

  const top = refs.slice(0, MAX_PRODUCTS);
  const products = [];

  for (let i = 0; i < top.length; i++) {
    const p = top[i];
    process.stdout.write(`  [${i+1}/${top.length}] ${productName(p.slug)}...`);
    const imageUrl = await fetchOgImage(p.url);
    process.stdout.write(` ${imageUrl ? '✓' : '✗'}\n`);
    products.push({ name: productName(p.slug), url: p.url, imageUrl });
    await sleep(DELAY);
  }

  return { brand, state, products };
}

async function run() {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

  const result = {};

  for (const col of COLLECTIONS) {
    const data = await scrapeCollection(col);
    if (data && data.products.length > 0) {
      result[`${col.brand}:${col.state}`] = data;
    }
  }

  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
  console.log(`\n✓ collections.json salvo em ${OUTPUT}`);
}

run().catch(console.error);
