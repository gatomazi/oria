#!/usr/bin/env node
// Pré-aquece o img-cache baixando imagens do CDN e redimensionando para 350x350.
// Uso: node scripts/warm-images.mjs [--concurrency 8] [--limit 500]
//
// Processa as cidades por prioridade: origem, coordenadas primeiro (mais comuns).

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.join(__dirname, '..');

const CDN_BASE   = 'https://gcp-images.majestic.ink.rsvcloud.com/images/product_v2/main_image/';
const CACHE_DIR  = process.env.IMG_CACHE_DIR || path.join(ROOT, 'img-cache');
const HASH_RE    = /^([a-f0-9]{32})\.webp$/;
const FIELDS     = ['origem', 'coordenadas', 'tipografia', 'traco', 'legado', 'territorio', 'feitoEm', 'gentilico'];

function getArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : def;
}
const concurrency = parseInt(getArg('--concurrency', '6'), 10);
const limit       = parseInt(getArg('--limit', '0'), 10);

fs.mkdirSync(CACHE_DIR, { recursive: true });

const cities = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cities.json'), 'utf-8'));

// Coleta hashes únicos ainda não em cache
const hashes = new Set();
for (const city of cities) {
  for (const field of FIELDS) {
    const entry = city[field];
    if (!entry?.imageUrl) continue;
    const m = entry.imageUrl.match(/\/img\/([a-f0-9]{32}\.webp)$/);
    if (!m) continue;
    const filename = m[1];
    if (!fs.existsSync(path.join(CACHE_DIR, filename))) {
      hashes.add(filename);
    }
  }
}

let queue = [...hashes];
if (limit > 0) queue = queue.slice(0, limit);

console.log(`${hashes.size} imagens sem cache. Baixando ${queue.length} com ${concurrency} workers...`);

let done = 0; let failed = 0;
const total = queue.length;

async function worker() {
  while (queue.length) {
    const filename = queue.pop();
    const dest = path.join(CACHE_DIR, filename);
    try {
      const res = await fetch(CDN_BASE + filename, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());

      let out = buf;
      try {
        const { default: sharp } = await import('sharp');
        out = await sharp(buf).resize(350, 350, { fit: 'cover' }).webp({ quality: 82 }).toBuffer();
      } catch { /* sharp não instalado: salva original */ }

      fs.writeFileSync(dest, out);
      done++;
    } catch (err) {
      failed++;
      done++;
    }
    if (done % 50 === 0 || done === total) {
      process.stdout.write(`\r  ${done}/${total} (${failed} erros)`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
console.log(`\n✓ Concluído. ${done - failed} baixadas, ${failed} erros.`);
