#!/usr/bin/env node
// Scrape completo do catalogo Use Sul + Use Centro + Use Norte
// Gera data/cities.json com cidade → url + imageUrl (/img/<hash>.webp)
//
// Uso:
//   node extract.js                        # scrapa tudo
//   node extract.js --brand usesul         # só uma marca
//   node extract.js --brand usesul --resume # retoma do temp existente
//
// Estratégia de imagem:
//   1. Extrai direto da listagem (src/data-src com gcp-images CDN) — sem req extra
//   2. Fallback: busca og:image na página do produto

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BRANDS = [
  { id: 'usesul',    label: 'Use Sul',    baseUrl: 'https://www.usesul.com.br',    store: 'usesul' },
  { id: 'usecentro', label: 'Use Centro', baseUrl: 'https://www.usecentro.com.br', store: 'usecentro' },
  { id: 'usenorte',  label: 'Use Norte',  baseUrl: 'https://www.usenorte.com.br',  store: 'usenorte' },
];

const MODELS        = ['coordenadas', 'tipografia', 'territorio', 'legado', 'traco', 'gentilico', 'origem'];
const CDN_HOST      = 'gcp-images.majestic.ink.rsvcloud.com';
const CDN_PATH      = '/images/product_v2/main_image/';
const HASH_RE       = /([a-f0-9]{32})\.webp/;

const DELAY_PAGE    = 250;   // ms entre páginas de listagem
const DELAY_PRODUCT = 400;   // ms entre fetches individuais de produto (fallback)
const SAVE_EVERY    = 10;    // salva temp a cada N páginas
const MAX_EMPTY     = 3;     // páginas sem novos produtos antes de parar

const OUTPUT        = path.join(__dirname, 'data', 'cities.json');
const OUTPUT_TEMP   = path.join(__dirname, 'data', 'cities_temp.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      if (attempt < retries) await sleep(1000);
    }
  }
  return null;
}

// Converte URL CDN em path local do proxy
function cdnToLocal(cdnUrl) {
  const m = cdnUrl && cdnUrl.match(HASH_RE);
  return m ? `/img/${m[1]}.webp` : null;
}

// Extrai links de produto de uma página de listagem,
// tentando capturar a imagem associada ao mesmo tempo
function extractProducts(html, baseUrl, store) {
  const results = new Map(); // slug → { url, imageUrl }

  // Encontra todos os blocos de produto (link + imagem próxima)
  // Estratégia: extrai href do produto, depois procura img CDN no mesmo bloco
  const linkRe  = new RegExp(`href="(/${store}/product/([^"]+))"`, 'g');
  // Captura imagens CDN em src, data-src, content
  const imgRe   = new RegExp(`(?:src|data-src|content)="(https://${CDN_HOST}${CDN_PATH}[a-f0-9]{32}\\.webp)"`, 'g');

  // Divide o HTML em blocos de ~2000 chars ao redor de cada link de produto
  const chunkSize = 2000;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const slug    = m[2];
    const prodUrl = `${baseUrl}${m[1]}`;

    // Procura imagem CDN no bloco ao redor do link
    const start = Math.max(0, m.index - 200);
    const end   = Math.min(html.length, m.index + chunkSize);
    const chunk = html.slice(start, end);

    let imgUrl = null;
    const im = imgRe.exec(chunk);
    if (im) imgUrl = cdnToLocal(im[1]);
    imgRe.lastIndex = 0; // reset para próxima iteração

    if (!results.has(slug)) {
      results.set(slug, { url: prodUrl, imageUrl: imgUrl });
    } else if (!results.get(slug).imageUrl && imgUrl) {
      results.get(slug).imageUrl = imgUrl;
    }
  }

  return results;
}

const UUID_RE = /-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function isCityProduct(slug) {
  if (slug.startsWith('feito-em-')) return true;
  return MODELS.some(m => slug.includes(`-${m}`));
}

function detectModel(slug) {
  if (slug.startsWith('feito-em-')) return 'feitoEm';
  return MODELS.find(m => slug.includes(`-${m}`)) || 'origem';
}

function parseSlug(slug) {
  // feito-em-{city}-{state}[-uuid]
  if (slug.startsWith('feito-em-')) {
    const body     = slug.replace(/^feito-em-/, '').replace(UUID_RE, '');
    const stateMatch = body.match(/-([a-z]{2})$/);
    const state    = stateMatch ? stateMatch[1].toUpperCase() : null;
    const citySlug = state ? body.replace(/-[a-z]{2}$/, '') : body;
    const cityName = citySlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return { cityName, citySlug, state, model: 'feitoEm' };
  }

  const model = detectModel(slug);
  const stateMatch = slug.match(new RegExp(`-${model}-([a-z]{2})(?:-|$)`));
  const state = stateMatch ? stateMatch[1].toUpperCase() : null;
  const citySlug = slug
    .replace(new RegExp(`-${model}.*$`), '')
    .replace(UUID_RE, '');
  const cityName = citySlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return { cityName, citySlug, state, model };
}

async function fetchOgImage(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const match =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return match ? cdnToLocal(match[1]) : null;
}

function saveTemp(allCities) {
  const output = Object.values(allCities).sort((a, b) =>
    a.cityName.localeCompare(b.cityName, 'pt-BR')
  );
  fs.writeFileSync(OUTPUT_TEMP, JSON.stringify(output, null, 2));
  return output.length;
}

async function scrapeBrand(brand, allCities, resumeFrom) {
  const { baseUrl, store, label, id } = brand;

  // Fase 1: percorre listagem, coleta produtos + imagens quando disponível
  const products = new Map(); // slug → { url, imageUrl }
  let page            = resumeFrom || 1;
  let consecutiveEmpty = 0;

  console.log(`\n[${label}] Scrape da listagem a partir da página ${page}...`);

  while (true) {
    const url  = `${baseUrl}/${store}/products?page=${page}`;
    const html = await fetchHtml(url);

    if (!html) {
      console.log(`  página ${page}: erro de conexão, pulando`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= MAX_EMPTY) break;
      page++;
      await sleep(DELAY_PAGE);
      continue;
    }

    const found = extractProducts(html, baseUrl, store);
    const cityOnes = [...found.entries()].filter(([slug]) => isCityProduct(slug));
    const newOnes  = cityOnes.filter(([slug]) => !products.has(slug));
    newOnes.forEach(([slug, data]) => products.set(slug, data));

    const withImg    = newOnes.filter(([, d]) => d.imageUrl).length;
    const withoutImg = newOnes.length - withImg;
    process.stdout.write(
      `  p.${page}: ${found.size} total, ${cityOnes.length} cidades, ${newOnes.length} novos (${withImg} c/ img, ${withoutImg} sem)\n`
    );

    // Para só quando a página não tem nenhum produto (fim real do catálogo)
    if (found.size === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= MAX_EMPTY) {
        console.log(`  ${MAX_EMPTY} páginas vazias → fim do catálogo`);
        break;
      }
    } else {
      consecutiveEmpty = 0;
    }

    if (page % SAVE_EVERY === 0) {
      buildCities(id, products, allCities);
      saveTemp(allCities);
      console.log(`  → temp salvo (${Object.keys(allCities).length} cidades total)`);
    }

    page++;
    await sleep(DELAY_PAGE);
  }

  console.log(`[${label}] ${products.size} produtos de cidade encontrados`);

  // Fase 2: busca imagem para produtos que não conseguiram da listagem
  const sem = [...products.entries()].filter(([, d]) => !d.imageUrl);
  if (sem.length > 0) {
    console.log(`[${label}] Buscando imagem individual para ${sem.length} produtos sem img...`);
    let i = 0;
    for (const [slug, data] of sem) {
      i++;
      process.stdout.write(`  [${i}/${sem.length}] ${slug}...`);
      const imgUrl = await fetchOgImage(data.url);
      data.imageUrl = imgUrl;
      process.stdout.write(` ${imgUrl ? '✓' : '✗'}\n`);
      await sleep(DELAY_PRODUCT);
    }
  }

  buildCities(id, products, allCities);
}

function buildCities(brandId, products, allCities) {
  const brand = BRANDS.find(b => b.id === brandId);
  for (const [slug, data] of products) {
    const meta = parseSlug(slug);
    const key  = `${brandId}:${meta.citySlug}`;

    if (!allCities[key]) {
      allCities[key] = {
        cityName:   meta.cityName,
        citySlug:   meta.citySlug,
        state:      meta.state,
        brand:      brandId,
        brandLabel: brand.label,
        origem:     null,
        coordenadas: null,
        tipografia:  null,
        traco:       null,
        legado:      null,
        territorio:  null,
        gentilico:   null,
        feitoEm:     null,
      };
    } else if (!allCities[key].state && meta.state) {
      allCities[key].state = meta.state;
    }

    // Preserva imageUrl existente se o novo scrape não trouxe imagem
    const existing = allCities[key][meta.model];
    allCities[key][meta.model] = {
      url:      data.url || existing?.url,
      imageUrl: data.imageUrl || existing?.imageUrl || null,
    };
  }
}

async function run() {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

  const brandIdx    = process.argv.indexOf('--brand');
  const brandFilter = brandIdx !== -1 ? process.argv[brandIdx + 1] : null;
  const pageIdx     = process.argv.indexOf('--page');
  const startPage   = pageIdx !== -1 ? parseInt(process.argv[pageIdx + 1], 10) : null;
  const doResume    = process.argv.includes('--resume');

  const activeBrands = brandFilter
    ? BRANDS.filter(b => b.id === brandFilter)
    : BRANDS;

  if (activeBrands.length === 0) {
    console.error(`Marca não encontrada: ${brandFilter}`);
    process.exit(1);
  }

  const allCities = {};

  // Carrega existente para merge (mantém outras marcas se filtrando uma)
  const existingFile = doResume && fs.existsSync(OUTPUT_TEMP) ? OUTPUT_TEMP : OUTPUT;
  if (fs.existsSync(existingFile)) {
    const existing = JSON.parse(fs.readFileSync(existingFile, 'utf-8'));
    for (const city of existing) {
      const skip = brandFilter && city.brand === brandFilter;
      if (!skip) allCities[`${city.brand}:${city.citySlug}`] = city;
    }
    const kept = Object.keys(allCities).length;
    if (kept > 0) console.log(`Mantidas ${kept} cidades existentes`);
  }

  for (const brand of activeBrands) {
    await scrapeBrand(brand, allCities, startPage);
  }

  const output = Object.values(allCities).sort((a, b) =>
    a.cityName.localeCompare(b.cityName, 'pt-BR')
  );

  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  if (fs.existsSync(OUTPUT_TEMP)) fs.unlinkSync(OUTPUT_TEMP);
  console.log(`\n✓ ${output.length} cidades salvas em ${OUTPUT}`);
}

run().catch(console.error);
