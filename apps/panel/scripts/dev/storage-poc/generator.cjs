'use strict';

// POC de armazenamento · gerador de catálogo sintético que REPRODUZ a forma medida em produção
// (Use Sul, 2026-09-25) — nunca linhas homogêneas: distribuição conjunta tipo × variantes por
// produto, mix publicado/não publicado, cores/tamanhos/modelos com as frequências reais, larguras
// reais de nome/slug/urls/metadata e SKU compartilhado entre produtos (a base "peça lisa" que as
// estampas reutilizam — por isso o SKU não é identidade única lá).
//
// Determinístico (semente fixa): o mesmo (nProducts, mix, seed) gera exatamente o mesmo catálogo,
// então antes/depois comparam os mesmos bytes lógicos.
//
// Mixes:
//   usesul      distribuição conjunta INTEIRA da Use Sul (≈ 34,8 variantes/produto)
//   published   só o perfil dos produtos publicados da Use Sul (≈ 100 variantes/produto — grade
//               cor × tamanho × modelo cheia; é o mais próximo de uma loja "normal" grande em grade)
//   light       ≈ 10 variantes/produto (Regata / Cropped Moletom — loja de grade curta)
//   mid         ≈ 24 variantes/produto
// SKU: 'shared' (Use Sul: reaproveitado entre produtos) | 'unique' (SKU único por variante — o caso
// típico de outras lojas, que faz o bootstrap materializar MAIS uma identity por variante).

const path = require('node:path');

const SHAPE = require(path.join(__dirname, 'fixtures', 'usesul-catalog-shape.json'));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function poolPorMix(mix) {
  const juntas = SHAPE.joint;
  if (mix === 'usesul') return juntas.map((j) => ({ ...j, peso: j.products }));
  if (mix === 'published') return juntas.filter((j) => j.published > 0).map((j) => ({ ...j, peso: j.published }));
  if (mix === 'light') return juntas.filter((j) => ['Regata', 'Cropped Moletom'].includes(j.type) && j.variants >= 10).map((j) => ({ ...j, peso: j.products }));
  if (mix === 'mid') return juntas.filter((j) => ['Suéter Moletom', 'Hoodie Moletom'].includes(j.type) && j.variants >= 24).map((j) => ({ ...j, peso: j.products }));
  throw new Error(`mix desconhecido: ${mix}`);
}

/**
 * Plano do catálogo: um item por produto {type, nVariants, published, ga4}. Escala pelo método do
 * maior resto — as proporções de tipo × variantes são exatamente as medidas.
 */
function montarPlano({ nProducts, mix = 'usesul', ga4Rate = 19608 / 105857, publishedRate = null }) {
  const pool = poolPorMix(mix);
  const total = pool.reduce((a, j) => a + j.peso, 0);
  const cotas = pool.map((j) => ({ j, exato: (j.peso / total) * nProducts }));
  let dado = 0;
  for (const c of cotas) { c.n = Math.floor(c.exato); dado += c.n; }
  cotas.sort((a, b) => (b.exato - b.n) - (a.exato - a.n));
  for (let i = 0; dado < nProducts; i += 1, dado += 1) cotas[i % cotas.length].n += 1;

  const rnd = mulberry32(1234567);
  const plano = [];
  for (const { j, n } of cotas) {
    const taxaPub = publishedRate !== null ? publishedRate : (j.products ? j.published / j.products : 0);
    for (let i = 0; i < n; i += 1) {
      plano.push({ type: j.type, nVariants: j.variants, published: rnd() < taxaPub, ga4: rnd() < ga4Rate });
    }
  }
  // Embaralha (Fisher–Yates com a mesma semente): a Ink não entrega ordenado por tipo.
  for (let i = plano.length - 1; i > 0; i -= 1) {
    const k = Math.floor(rnd() * (i + 1));
    [plano[i], plano[k]] = [plano[k], plano[i]];
  }
  return plano;
}

// Espalhamento dos ids de variante em relação à ordem física (calibrado p/ correlação ~0,41).
const ESPALHAMENTO_IDS = Number(process.env.POC_ID_SPREAD) || 2.0;

const CORES = Object.entries(SHAPE.colors);
const HEX = ['FFFFFF', '000000', '1F2A44', 'F2C230', '9AA0A6', 'C0392B', '2E7D32', 'F5F5DC', 'E8A0BF', 'D2B48C', '7B1E3A', 'C2B280'];

function escolherCor(rnd) {
  let x = rnd();
  for (const [nome, peso] of CORES) { x -= peso; if (x <= 0) return nome; }
  return CORES[0][0];
}

const ehInfantil = (tipo) => /Infantil/.test(tipo);

// Variantes de UM produto: grade cor × tamanho × modelo (cicla), tamanho varia mais rápido.
function variantesDoProduto({ idx, item, revisao, churn, skuMode, contadorVariante }) {
  const rnd = mulberry32(0x9E3779B1 ^ (idx * 2654435761));
  const tamanhos = ehInfantil(item.type) ? SHAPE.sizesKids : SHAPE.sizesAdult;
  const nTam = Math.min(tamanhos.length, Math.max(2, Math.round(Math.sqrt(item.nVariants))));
  const nCor = Math.min(CORES.length, Math.max(1, Math.round(item.nVariants / nTam / 2)));
  const cores = [];
  while (cores.length < nCor) { const c = escolherCor(rnd); if (!cores.includes(c)) cores.push(c); }
  const modelos = SHAPE.models.slice(0, Math.max(1, Math.ceil(item.nVariants / (nTam * nCor))));
  const variants = [];
  for (let i = 0; i < item.nVariants; i += 1) {
    const size = tamanhos[i % nTam];
    const color = cores[Math.floor(i / nTam) % nCor];
    const model = modelos[Math.floor(i / (nTam * nCor)) % modelos.length];
    const providerVariantId = String(contadorVariante.next());
    // Estoque muda a cada revisão só para uma fração `churn` (o resto fica idêntico).
    const muda = mulberry32((Number(providerVariantId) * 7919) ^ (revisao * 104729))() < churn;
    const rev = muda ? revisao : 0;
    const qtd = Math.floor(mulberry32(Number(providerVariantId) ^ (rev * 31))() * 1000);
    variants.push({
      providerVariantId,
      // 'shared': a base "peça lisa" (tipo × cor × tamanho) reaproveitada por TODAS as estampas.
      // 'unique': um SKU por variante.
      sku: skuMode === 'unique'
        ? `SKU${providerVariantId.padStart(9, '0')}`
        : `00${String(Math.abs(hashTexto(`${item.type}|${color}|${size}|${model}`)) % 1e10).padStart(10, '0')}`,
      color, size, model,
      metadata: { hexColor: HEX[CORES.findIndex(([n]) => n === color) % HEX.length], isAvailable: qtd > 0, availableQuantity: qtd },
    });
  }
  return variants;
}

function hashTexto(t) {
  let h = 2166136261;
  for (let i = 0; i < t.length; i += 1) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function pad(texto, n) {
  if (texto.length >= n) return texto.slice(0, n);
  return texto + 'x'.repeat(n - texto.length);
}

function produtoDoPlano({ idx, item }) {
  const providerProductId = String(3900000 + idx);
  const nome = pad(`Cidade ${idx} | Território RS`, SHAPE.widths.productName);
  return {
    providerProductId,
    name: nome,
    slug: pad(`cidade-${idx}-territorio-rs-`, SHAPE.widths.slug - 8) + hashTexto(String(idx)).toString(16).padStart(8, '0'),
    imageUrl: pad(`https://gcp-images.example.invalid/images/product_v2/main_image/${hashTexto(`i${idx}`).toString(16)}`, SHAPE.widths.imageUrl),
    productUrl: pad(`https://www.example.invalid/produto/${idx}-`, SHAPE.widths.productUrl),
    productType: item.type,
    price: 89.9 + (idx % 28),
    promotionalPrice: null,
    visible: item.published,
    metadata: { status: item.published ? 'published' : 'not_published', productTypeId: 100 + (idx % 90), approvalStatus: item.published ? 'approved' : 'waiting', productClusterId: 443000 + idx },
  };
}

/**
 * Connector de commerce FALSO com o contrato real (`listProductsWithVariants` paginado a 100) —
 * gera cada página sob demanda a partir do plano. `revisao` > 0 faz `churn` das variantes mudar
 * (estoque), como um segundo sync de uma loja viva.
 */
function conectorFalso({ plano, revisao = 0, churn = 0.1, skuMode = 'shared', porPagina = 100, nPedidos = 0, org = null, store = null, provider = 'reserva_ink' }) {
  const observados = idsObservadosGa4(plano);
  // Ids de variante estáveis entre revisões. A Ink NÃO entrega os ids em ordem física: em produção a
  // correlação entre provider_variant_id e a posição da linha é ~0,41 (pg_stats). Sem imitar isso
  // o índice único nasce denso demais (inserção sequencial) e a POC subestima o custo real dos
  // índices. `rank` = posição do produto no espaço de ids (ordem embaralhada com ruído).
  const rnd = mulberry32(777);
  const chaves = plano.map((_, i) => i + (rnd() - 0.5) * plano.length * ESPALHAMENTO_IDS);
  const rank = new Array(plano.length);
  [...chaves.keys()].sort((x, y) => chaves[x] - chaves[y]).forEach((idx, pos) => { rank[idx] = pos; });
  const porRank = new Array(plano.length);
  for (let i = 0; i < plano.length; i += 1) porRank[rank[i]] = i;
  const inicioIds = new Array(plano.length);
  let acumulado = 0;
  for (let pos = 0; pos < plano.length; pos += 1) { inicioIds[porRank[pos]] = acumulado; acumulado += plano[porRank[pos]].nVariants; }
  const prefixo = new Array(plano.length + 1);
  prefixo[0] = 0;
  for (let i = 0; i < plano.length; i += 1) prefixo[i + 1] = prefixo[i] + plano[i].nVariants;
  return {
    totalVariants: prefixo[plano.length],
    async listProductsWithVariants({ cursor }) {
      const pagina = cursor ? Number(cursor) : 1;
      const inicio = (pagina - 1) * porPagina;
      if (inicio >= plano.length) return { items: [], nextCursor: null, totalPages: Math.ceil(plano.length / porPagina) };
      const fim = Math.min(inicio + porPagina, plano.length);
      const items = [];
      for (let idx = inicio; idx < fim; idx += 1) {
        // Ids de variante 9 dígitos, com o degrau (~×1.4) que a Ink tem entre ids consecutivos.
        let n = 119000000 + Math.floor(inicioIds[idx] * 1.1);
        const contadorVariante = { next: () => { n += 1; return n; } };
        items.push({
          product: produtoDoPlano({ idx, item: plano[idx] }),
          variants: variantesDoProduto({ idx, item: plano[idx], revisao, churn, skuMode, contadorVariante }),
        });
      }
      return { items, nextCursor: fim < plano.length ? String(pagina + 1) : null, totalPages: Math.ceil(plano.length / porPagina) };
    },
    async listOrders({ cursor, limit = 200 }) {
      const pagina = cursor ? Number(cursor) : 1;
      const inicio = (pagina - 1) * limit;
      if (inicio >= nPedidos || !observados.length) return { items: [], nextCursor: null };
      const fim = Math.min(inicio + limit, nPedidos);
      const items = [];
      for (let n = inicio; n < fim; n += 1) {
        items.push({
          id: `pedido-${n}`, organizationId: org, storeId: store, provider, providerOrderId: String(n),
          status: 'delivered', paymentStatus: 'paid', isPaid: true, isRefunded: false, totalValue: 89.9,
          createdAt: new Date(), paidAt: new Date(),
          items: [{ providerProductId: observados[(n * 37) % observados.length], commerceProductId: null, quantity: 1, unitValue: 89.9, totalValue: 89.9 }],
        });
      }
      return { items, nextCursor: fim < nPedidos ? String(pagina + 1) : null };
    },
    async getOrder() { return null; },
  };
}

// ids de produto que o GA4 "observa" (item_id == provider_product_id, o que a Use Sul mostra em produção)
function idsObservadosGa4(plano) {
  const ids = [];
  for (let idx = 0; idx < plano.length; idx += 1) if (plano[idx].ga4) ids.push(String(3900000 + idx));
  return ids;
}

module.exports = { idsObservadosGa4, SHAPE, montarPlano, conectorFalso, produtoDoPlano, mulberry32 };
