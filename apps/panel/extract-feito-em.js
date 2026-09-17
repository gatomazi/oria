#!/usr/bin/env node
// Scrape do modelo "Feito em {cidade}" (slug prefixado: feito-em-{cidade}[-uuid])
// Usa o filtro de busca paginado da loja e casa cada produto com a cidade
// existente em data/cities.json pelo citySlug. Adiciona a chave `feitoEm`.
//
// Uso:
//   node extract-feito-em.js [marca]        (padrão: usesul)
//   node extract-feito-em.js usesul --dry   (não grava)

import fs from 'fs';

const BRANDS = {
  usesul:    { baseUrl: 'https://www.usesul.com.br',    store: 'usesul' },
  usecentro: { baseUrl: 'https://www.usecentro.com.br', store: 'usecentro' },
  usenorte:  { baseUrl: 'https://www.usenorte.com.br',  store: 'usenorte' },
};

const BRAND = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'usesul';
const DRY = process.argv.includes('--dry');
const FILE = 'data/cities.json';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DELAY_CATALOG = 200;
const FETCH_CONCURRENCY = 6;
const UUID_RE = /-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const brand = BRANDS[BRAND];
if (!brand) { console.error(`Marca desconhecida: ${BRAND}`); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

function extractFeitoEmSlugs(html, store) {
  const re = new RegExp(`/${store}/product/(feito-em-[^"?]+)`, 'g');
  return [...new Set([...html.matchAll(re)].map(m => m[1]))];
}

// feito-em-balneario-camboriu-<uuid> -> citySlug "balneario-camboriu"
function citySlugFromFeitoEm(slug) {
  return slug.replace(/^feito-em-/, '').replace(UUID_RE, '');
}

function ogImage(html) {
  const m =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1] : null;
}

async function runPool(items, concurrency, fn, label) {
  const queue = [...items];
  let done = 0; const total = items.length;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      await fn(queue.pop());
      done++;
      if (done % 20 === 0 || done === total) process.stdout.write(`  ${label}: ${done}/${total}\r`);
    }
  }));
  process.stdout.write('\n');
}

async function collectSlugs() {
  const { baseUrl, store } = brand;
  const found = new Map(); // citySlug -> product slug (prefere sem uuid)
  let page = 1, emptyStreak = 0;
  console.log(`[${BRAND}] Coletando produtos "feito em" via filtro...`);
  while (true) {
    const url = `${baseUrl}/${store}/products?search_filter=feito+em&page=${page}`;
    const html = await fetchHtml(url);
    if (!html) { console.log(`  pagina ${page}: erro`); break; }
    const slugs = extractFeitoEmSlugs(html, store);
    let novos = 0;
    for (const slug of slugs) {
      const cs = citySlugFromFeitoEm(slug);
      if (!found.has(cs)) { found.set(cs, slug); novos++; }
      else if (!UUID_RE.test(slug) && UUID_RE.test(found.get(cs))) found.set(cs, slug); // prefere slug limpo
    }
    process.stdout.write(`  pagina ${page}: ${slugs.length} produtos, ${novos} cidades novas\n`);
    if (novos === 0) { if (++emptyStreak >= 3) { console.log('  3 paginas sem novidade — fim'); break; } }
    else emptyStreak = 0;
    page++;
    await sleep(DELAY_CATALOG);
  }
  console.log(`[${BRAND}] ${found.size} cidades com "feito em" encontradas`);
  return found;
}

async function run() {
  const found = await collectSlugs();
  const { baseUrl, store } = brand;

  const cities = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  const byCitySlug = new Map(cities.filter(c => c.brand === BRAND).map(c => [c.citySlug, c]));

  // normaliza divergências de slug entre a loja e o cities.json
  // ex.: loja "diamante-doeste"  ↔  cities.json "diamante-d-oeste"
  function resolveCity(citySlug) {
    return byCitySlug.get(citySlug)
      || byCitySlug.get(citySlug.replace(/doeste$/, 'd-oeste'))
      || byCitySlug.get(citySlug.replace(/doeste$/, 'do-oeste'));
  }

  const jobs = [];
  const semCidade = [];
  for (const [citySlug, prodSlug] of found) {
    const city = resolveCity(citySlug);
    if (!city) { semCidade.push(citySlug); continue; }
    jobs.push({ city, url: `${baseUrl}/${store}/product/${prodSlug}` });
  }

  console.log(`Casadas com cidade existente: ${jobs.length} | sem match no cities.json: ${semCidade.length}`);
  console.log('Buscando og:image...');

  let semImagem = 0;
  await runPool(jobs, FETCH_CONCURRENCY, async (job) => {
    const html = await fetchHtml(job.url);
    const img = html ? ogImage(html) : null;
    if (!img) semImagem++;
    job.city.feitoEm = { url: job.url, imageUrl: img };
  }, 'imagens');

  console.log(`\nCidades com feitoEm adicionado: ${jobs.length} (sem imagem: ${semImagem})`);
  if (semCidade.length) console.log(`Produtos sem cidade no cities.json (ignorados): ${semCidade.slice(0, 15).join(', ')}${semCidade.length > 15 ? '…' : ''}`);

  if (DRY) { console.log('\n(--dry) nada gravado.'); return; }

  fs.copyFileSync(FILE, `${FILE}.bak`);
  fs.writeFileSync(FILE, JSON.stringify(cities, null, 2));
  console.log(`\ncities.json atualizado (backup em ${FILE}.bak)`);
}

run().catch(console.error);
