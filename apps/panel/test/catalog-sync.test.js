'use strict';

// Fase D · lib/product-analytics/catalog-sync.js — SQL builders (sem banco) e o fluxo de controle de
// runCatalogSync com pool/registry/leases falsos: lease bloqueado, capability ausente, falha
// parcial não desativa, "catálogo grande" processado página a página sem acumular em memória. O
// comportamento real de banco (idempotência, staleness, isolamento entre Organizations) está em
// test/invariants/catalog-sync.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runCatalogSync, jobDoSync, contadoresVazios,
  montarUpsertProdutos, montarUpsertVariantes, montarDesativacao,
} = require('../lib/product-analytics/catalog-sync');
const { createConnectorRegistry } = require('../lib/connectors/registry');
const { CODIGOS } = require('../lib/connectors/errors');

const ORG_A = 'a1000000-0000-4000-8000-00000000000a';
const STORE_A = 'a1a10000-0000-4000-8000-0000000000a1';
const RUN = 'b1000000-0000-4000-8000-00000000000b';
const CTX = Object.freeze({ organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink', syncRunId: RUN });

const produto = (over = {}) => ({
  providerProductId: '1', name: 'x', slug: null, imageUrl: null, productUrl: null, productType: null,
  price: null, promotionalPrice: null, visible: null, metadata: {}, ...over,
});
const variante = (over = {}) => ({ commerceProductId: 'c-1', providerVariantId: '9', sku: null, color: null, size: null, model: null, metadata: {}, ...over });

// ── montarUpsertProdutos ────────────────────────────────────────────────────────────────────────

test('D · montarUpsertProdutos: um placeholder por coluna, arrays paralelos na mesma ordem dos produtos', () => {
  const q = montarUpsertProdutos(CTX, [produto({ providerProductId: '1', name: 'A' }), produto({ providerProductId: '2', name: 'B' })]);
  assert.match(q.text, /INSERT INTO commerce_products/);
  assert.match(q.text, /ON CONFLICT \(organization_id, store_id, provider, provider_product_id\) DO UPDATE/);
  assert.match(q.text, /\(xmax = 0\) AS inserted/);
  assert.equal(q.values[0], ORG_A);
  assert.equal(q.values[1], STORE_A);
  assert.equal(q.values[2], 'reserva_ink');
  assert.equal(q.values[3], RUN);
  assert.deepEqual(q.values[4], ['1', '2']); // provider_product_id[]
  assert.deepEqual(q.values[5], ['A', 'B']); // name[]
});

test('D · montarUpsertProdutos: metadata sai serializada como JSON, uma string por produto', () => {
  const q = montarUpsertProdutos(CTX, [produto({ metadata: { approvalStatus: 'approved' } })]);
  const metadataArray = q.values[q.values.length - 1];
  assert.deepEqual(metadataArray, [JSON.stringify({ approvalStatus: 'approved' })]);
});

test('D · montarUpsertProdutos: só 1 statement para N produtos (nunca N statements)', () => {
  const q = montarUpsertProdutos(CTX, Array.from({ length: 37 }, (_, i) => produto({ providerProductId: String(i) })));
  assert.equal((q.text.match(/INSERT INTO/g) || []).length, 1);
  assert.equal(q.values[4].length, 37);
});

// ── montarUpsertVariantes ───────────────────────────────────────────────────────────────────────

test('D · montarUpsertVariantes: commerce_product_id vai como uuid[], resolvido por quem chamou', () => {
  const q = montarUpsertVariantes(CTX, [variante({ commerceProductId: 'c-1', providerVariantId: '9' }), variante({ commerceProductId: 'c-2', providerVariantId: '10' })]);
  assert.match(q.text, /INSERT INTO commerce_product_variants/);
  assert.match(q.text, /unnest\(\$5::uuid\[\]/);
  assert.deepEqual(q.values[4], ['c-1', 'c-2']);
  assert.deepEqual(q.values[5], ['9', '10']);
});

test('D · montarUpsertVariantes: só 1 statement para N variantes', () => {
  const q = montarUpsertVariantes(CTX, Array.from({ length: 50 }, (_, i) => variante({ providerVariantId: String(i) })));
  assert.equal((q.text.match(/INSERT INTO/g) || []).length, 1);
});

// ── montarDesativacao ───────────────────────────────────────────────────────────────────────────

test('D · montarDesativacao: só desativa is_active=true com last_seen_sync_id diferente do run atual', () => {
  const q = montarDesativacao('commerce_products', CTX);
  assert.match(q.text, /UPDATE commerce_products SET is_active = false/);
  assert.match(q.text, /is_active = true\s+AND last_seen_sync_id <> \$4/);
  assert.deepEqual(q.values, [ORG_A, STORE_A, 'reserva_ink', RUN]);
});

// ── jobDoSync / contadoresVazios ────────────────────────────────────────────────────────────────

test('D · jobDoSync: um job por provider, formato aceito por job_leases (^[a-z0-9:_-]{1,80}$)', () => {
  assert.equal(jobDoSync('reserva_ink'), 'commerce-catalog-sync:reserva_ink');
  assert.match(jobDoSync('reserva_ink'), /^[a-z0-9:_-]{1,80}$/);
});

test('D · contadoresVazios: todos os 8 campos zerados', () => {
  assert.deepEqual(contadoresVazios(), {
    productsSeen: 0, productsInserted: 0, productsUpdated: 0, productsDeactivated: 0,
    variantsSeen: 0, variantsInserted: 0, variantsUpdated: 0, variantsDeactivated: 0,
  });
});

// ── runCatalogSync: fluxo de controle (pool/registry/leases falsos) ─────────────────────────────

// Pool falso: registra toda query e responde de acordo com o texto (upsert devolve linhas com
// (xmax=0) alternando insert/update para exercitar a contagem; desativação devolve n=0 por padrão).
function poolDeControle({ onQuery } = {}) {
  const chamadas = [];
  let seq = 0;
  return {
    chamadas,
    async query(text, values) {
      chamadas.push({ text, values });
      if (onQuery) {
        const r = await onQuery(text, values, chamadas.length);
        if (r !== undefined) return r;
      }
      if (/INSERT INTO commerce_catalog_sync_logs/.test(text)) return { rows: [] };
      if (/UPDATE commerce_catalog_sync_logs/.test(text)) return { rows: [] };
      if (/INSERT INTO commerce_products/.test(text)) {
        const ids = values[4];
        return { rows: ids.map((pid, i) => { seq += 1; return { id: `cp-${pid}`, provider_product_id: pid, inserted: seq % 2 === 1 }; }) };
      }
      if (/INSERT INTO commerce_product_variants/.test(text)) {
        const ids = values[5];
        return { rows: ids.map(() => { seq += 1; return { id: `cv-${seq}`, inserted: seq % 2 === 1 }; }) };
      }
      if (/UPDATE commerce_products SET is_active/.test(text)) return { rows: [{ n: 0 }] };
      if (/UPDATE commerce_product_variants SET is_active/.test(text)) return { rows: [{ n: 0 }] };
      throw new Error(`SQL inesperado no pool de controle: ${text.slice(0, 60)}`);
    },
  };
}

// Registry com um connector Ink-shaped falso: `paginas` é um array (ou gerador) de páginas.
function registryComPaginas(paginas, { capabilities } = {}) {
  const registry = createConnectorRegistry();
  let chamado = 0;
  registry.register({
    domain: 'commerce',
    provider: 'reserva_ink',
    integrationProvider: 'ink',
    requiresStoreContext: true,
    capabilities: { products: true, variants: true, productsWithVariants: true, orders: false, refunds: false, productCosts: false, ...capabilities },
    create: () => ({
      listProducts: async () => ({ items: [], nextCursor: null }),
      getProduct: async () => null,
      listProductVariants: async () => ({ items: [], nextCursor: null }),
      listProductsWithVariants: async () => {
        const pagina = typeof paginas === 'function' ? paginas(chamado) : paginas[chamado];
        chamado += 1;
        if (!pagina) throw new Error('pediu página além do fim');
        return pagina;
      },
    }),
  });
  return registry;
}

const item = (n) => ({ product: produto({ providerProductId: String(n), name: `p${n}` }), variants: [variante({ providerVariantId: String(1000 + n) })] });

test('D · runCatalogSync: 1 página, upsert de produtos e variantes, log fecha success', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas([{ items: [item(1), item(2)], nextCursor: null }]);
  const r = await runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' });
  assert.equal(r.status, 'success');
  assert.equal(r.pagesProcessed, 1);
  assert.equal(r.productsSeen, 2);
  assert.equal(r.variantsSeen, 2);
  const upsertLog = pool.chamadas.find((c) => /INSERT INTO commerce_catalog_sync_logs/.test(c.text));
  const fechaLog = pool.chamadas.find((c) => /UPDATE commerce_catalog_sync_logs/.test(c.text));
  assert.ok(upsertLog && fechaLog);
  assert.equal(fechaLog.values[2], 'success');
});

test('D · runCatalogSync: múltiplas páginas seguem o nextCursor até null', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas([
    { items: [item(1)], nextCursor: '2' },
    { items: [item(2)], nextCursor: '3' },
    { items: [item(3)], nextCursor: null },
  ]);
  const r = await runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' });
  assert.equal(r.pagesProcessed, 3);
  assert.equal(r.productsSeen, 3);
});

test('D · runCatalogSync: produto sem variantes não chama o upsert de variantes', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas([{ items: [{ product: produto({ providerProductId: '1' }), variants: [] }], nextCursor: null }]);
  await runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' });
  assert.equal(pool.chamadas.some((c) => /INSERT INTO commerce_product_variants/.test(c.text)), false);
});

test('D · runCatalogSync: exige a capability productsWithVariants (nunca cai para listProductVariants por produto)', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas([], { capabilities: { productsWithVariants: false } });
  await assert.rejects(
    runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' }),
    (err) => err.codigo === CODIGOS.CAPABILITY_UNSUPPORTED,
  );
  assert.equal(pool.chamadas.some((c) => /INSERT INTO commerce_products/.test(c.text)), false);
});

test('D · runCatalogSync: falha na página 2 deixa a página 1 upsertada e NÃO desativa nada', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas((chamado) => {
    if (chamado === 0) return { items: [item(1)], nextCursor: '2' };
    throw Object.assign(new Error('Ink caiu'), { codigo: 'INK_UNAVAILABLE' });
  });
  await assert.rejects(
    runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' }),
    /Ink caiu/,
  );
  assert.equal(pool.chamadas.filter((c) => /INSERT INTO commerce_products/.test(c.text)).length, 1);
  assert.equal(pool.chamadas.some((c) => /UPDATE commerce_products SET is_active/.test(c.text)), false);
  assert.equal(pool.chamadas.some((c) => /UPDATE commerce_product_variants SET is_active/.test(c.text)), false);
  const fechaLog = pool.chamadas.find((c) => /UPDATE commerce_catalog_sync_logs/.test(c.text));
  assert.equal(fechaLog.values[2], 'partial_failure'); // status
  assert.equal(fechaLog.values[3], 1); // pages_processed
  assert.equal(fechaLog.values[fechaLog.values.length - 1], 'INK_UNAVAILABLE'); // error_code
});

test('D · runCatalogSync: falha na PRIMEIRA página fecha o log como failed, não partial_failure', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas(() => { throw new Error('sem código'); });
  await assert.rejects(runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' }));
  const fechaLog = pool.chamadas.find((c) => /UPDATE commerce_catalog_sync_logs/.test(c.text));
  assert.equal(fechaLog.values[2], 'failed');
  assert.equal(fechaLog.values[fechaLog.values.length - 1], 'CATALOG_SYNC_FAILED'); // erro sem .codigo vira o padrão
});

test('D · runCatalogSync: sem leases, roda direto (comportamento de hoje não regride)', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas([{ items: [], nextCursor: null }]);
  const r = await runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' });
  assert.equal(r.status, 'success');
});

test('D · runCatalogSync: lease ocupado devolve status "locked" sem tocar o banco nem o connector', async () => {
  const pool = poolDeControle();
  let pedidoDePagina = false;
  const registry = registryComPaginas(() => { pedidoDePagina = true; return { items: [], nextCursor: null }; });
  const leases = { adquirir: async () => false, concluir: async () => true };
  const r = await runCatalogSync({ pool, registry, leases }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' });
  assert.equal(r.status, 'locked');
  assert.equal(pool.chamadas.length, 0);
  assert.equal(pedidoDePagina, false);
});

test('D · runCatalogSync: pede e libera o lease por (job, organizationId), mesmo em falha', async () => {
  const pool = poolDeControle();
  const chamadasLease = [];
  const leases = {
    adquirir: async (job, org, ttl) => { chamadasLease.push(['adquirir', job, org, ttl]); return true; },
    concluir: async (job, org) => { chamadasLease.push(['concluir', job, org]); return true; },
  };
  const registry = registryComPaginas(() => { throw new Error('falhou'); });
  await assert.rejects(runCatalogSync({ pool, registry, leases }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' }));
  assert.equal(chamadasLease[0][1], 'commerce-catalog-sync:reserva_ink');
  assert.equal(chamadasLease[0][2], ORG_A);
  assert.equal(chamadasLease[1][0], 'concluir'); // libera mesmo com erro
});

test('D · runCatalogSync exige pool, registry e o alvo completo', async () => {
  const pool = poolDeControle();
  const registry = registryComPaginas([]);
  await assert.rejects(runCatalogSync({ registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'x' }), /pool/);
  await assert.rejects(runCatalogSync({ pool }, { organizationId: ORG_A, storeId: STORE_A, provider: 'x' }), /registry/);
  await assert.rejects(runCatalogSync({ pool, registry }, { storeId: STORE_A, provider: 'x' }), /organizationId/);
  await assert.rejects(runCatalogSync({ pool, registry }, { organizationId: ORG_A, provider: 'x' }), /storeId/);
  await assert.rejects(runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A }), /provider/);
});

// ── Catálogo grande: página a página, sem acumular tudo em memória ──────────────────────────────

test('D · catálogo grande: 40 páginas processadas uma a uma, upsert nunca recebe mais que o tamanho de UMA página', async () => {
  const TOTAL_PAGINAS = 40;
  const POR_PAGINA = 100;
  const tamanhosDeLote = [];
  const pool = poolDeControle({
    onQuery: (text, values) => {
      if (/INSERT INTO commerce_products/.test(text)) tamanhosDeLote.push(values[4].length);
    },
  });
  // Gerador: cada página é construída NA HORA, a partir só do número dela — nunca existe um array
  // com o catálogo inteiro em memória neste teste (o que provaria pouco) NEM dentro do sync.
  const registry = registryComPaginas((chamado) => {
    if (chamado >= TOTAL_PAGINAS) return null;
    const base = chamado * POR_PAGINA;
    return {
      items: Array.from({ length: POR_PAGINA }, (_, i) => item(base + i)),
      nextCursor: chamado + 1 < TOTAL_PAGINAS ? String(chamado + 2) : null,
    };
  });
  const r = await runCatalogSync({ pool, registry }, { organizationId: ORG_A, storeId: STORE_A, provider: 'reserva_ink' });
  assert.equal(r.pagesProcessed, TOTAL_PAGINAS);
  assert.equal(r.productsSeen, TOTAL_PAGINAS * POR_PAGINA);
  assert.equal(tamanhosDeLote.length, TOTAL_PAGINAS);
  assert.ok(tamanhosDeLote.every((n) => n === POR_PAGINA), 'nenhum upsert recebeu lote maior que 1 página');
});
