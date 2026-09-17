'use strict';

// OPS-22 (rodada 19, trilha G) — zero janela de 404 dos criativos.
//
// A release que lê pelo organization_id sobe ANTES de `tenancy:mover-criativos` terminar (o volume
// pode não estar montado no pre-deploy). Com a leitura dupla temporária:
//   antes do mover   arquivo só no diretório legado → servido pelo fallback (200)
//   durante          parte movida, parte não       → os dois 200
//   depois           tudo movido                    → 200 sem fallback; verificação PASS
//   desligada        comportamento anterior (arquivo só no legado não é servido)
// e a fronteira de segurança:
//   só a Organization declarada lê o legado (duas Organizations); caminho confinado ao diretório
//   legado (sem traversal, sem uuid de outra Organization, sem link simbólico); escrita sempre no novo.
//
// Os negative controls (negative-controls.test.js) tiram a checagem da Organization e o confinamento
// da storage e exigem que ESTE arquivo reprove.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { pathToFileURL } = require('node:url');

const h = require('./harness');
const { criarRouterCriativos } = h.sujeito('routes/criativos.js');
const { createMemoryStore } = h.sujeito('lib/creative-core/memoryStore.js');
const { createStorage } = h.sujeito('lib/creative-core/storage.js');
const { lerLeituraLegada, criarObservadorLeituraLegada } = h.sujeito('lib/creative-core/leitura-legada.js');

const MOVER = path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'mover-criativos.mjs');
const ORG_A = 'a1000000-0000-4000-8000-00000000000a';
const ORG_B = 'b1000000-0000-4000-8000-00000000000b';
const LEGADO = 'default';
const CONFIG = Object.freeze({ de: LEGADO, organizationId: ORG_A });
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const identidade = (t) => Buffer.from(t).toString('base64');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

let mover;
test.before(async () => {
  mover = await import(pathToFileURL(MOVER));
});

const dirTenant = (uploads, t) => path.join(uploads, 'creatives', 'tenant', t);

function escrever(uploads, tenant, rel, buf) {
  const abs = path.join(dirTenant(uploads, tenant), rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buf);
}

// Conteúdo distinto por arquivo: a resposta prova QUAL arquivo foi servido.
const conteudo = (rotulo) => Buffer.concat([PNG, Buffer.from(rotulo)]);

// Um produto com uma referência e um criativo com asset, gravados no diretório `tenant`.
async function semear(store, uploads, { org = ORG_A, tenant = LEGADO } = {}) {
  const productId = crypto.randomUUID();
  const creativeId = crypto.randomUUID();
  const ref = `products/${productId}/${crypto.randomUUID()}.png`;
  const storageKey = `creatives/${creativeId}/image.png`;
  const bufRef = conteudo(`ref-${productId}`);
  const bufAsset = conteudo(`asset-${creativeId}`);
  if (tenant) {
    escrever(uploads, tenant, ref, bufRef);
    escrever(uploads, tenant, storageKey, bufAsset);
  }
  await store.createProduct(org, { id: productId, name: 'p', type: 't', metadata: {}, references: [{ ref, mime: 'image/png', sizeBytes: bufRef.length }] });
  await store.insertAsset(org, { id: crypto.randomUUID(), creativeId, storageKey, sha256: sha(bufAsset), byteSize: bufAsset.length, mime: 'image/png' });
  return { productId, creativeId, ref, storageKey, bufRef, bufAsset };
}

async function subir({ uploads, store, leituraLegada, tenantAtual }) {
  const avisos = [];
  const logger = { log() {}, error() {}, warn: (m) => avisos.push(String(m)) };
  const core = { configured: true, async validate() { return { valid: true, errors: [] }; }, async contracts() { return {}; }, async health() { return { versions: {} }; } };
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const modulo = criarRouterCriativos({
    requireAdmin: (req, res, next) => next(),
    tenantAtual,
    paraCadaTenant: async () => {},
    pgPool: null, store, core, uploadsDir: uploads, leituraLegada,
    lerEntitlements: async () => ({ creative_generator: true }),
    encriptarSegredo: identidade, descriptografarSegredo: (b) => Buffer.from(b, 'base64').toString(),
    env: {}, logger,
  });
  app.use('/c', modulo.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/c`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
  };
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { server, get, post, avisos, contagem: modulo.leituraLegada.contagem, fechar: () => server.close() };
}

function uploadsTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops22-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function bancoDoStore(itens) {
  return {
    assets: itens.map((i) => ({ rel: i.storageKey, sha256: sha(i.bufAsset), bytes: i.bufAsset.length })),
    referencias: itens.map((i) => ({ rel: i.ref, bytes: i.bufRef.length })),
  };
}

test('OPS-22 · antes do mover: arquivo só no legado é servido pelo fallback, com contagem e aviso', async (t) => {
  const uploads = uploadsTemp(t);
  const store = createMemoryStore();
  const x = await semear(store, uploads);
  const s = await subir({ uploads, store, leituraLegada: CONFIG, tenantAtual: () => ORG_A });
  t.after(s.fechar);

  const ref = await s.get(`/products/${x.productId}/references/1`);
  assert.equal(ref.status, 200);
  assert.deepEqual(ref.buf, x.bufRef);
  const asset = await s.get(`/assets/${x.creativeId}`);
  assert.equal(asset.status, 200);
  assert.deepEqual(asset.buf, x.bufAsset);
  assert.deepEqual(s.contagem(), { referencia: 1, asset: 1 });
  assert.equal(s.avisos.filter((m) => /OPS-22 leitura legada usada/.test(m)).length, 1, 'aviso com limite de frequência');
  assert.ok(s.avisos.every((m) => !m.includes(uploads) && !m.includes(x.ref)), 'o aviso não expõe caminho');

  // Escrita: sempre no diretório da Organization, nunca no legado.
  const novo = await s.post('/products', { name: 'novo', type: 'camiseta', images: [{ data_base64: PNG.toString('base64') }] });
  assert.equal(novo.status, 201);
  const [criado] = (await store.getProduct(ORG_A, novo.body.id)).references;
  assert.ok(fs.existsSync(path.join(dirTenant(uploads, ORG_A), criado.ref)), 'gravado no diretório novo');
  assert.ok(!fs.existsSync(path.join(dirTenant(uploads, LEGADO), criado.ref)), 'nada gravado no legado');
  assert.equal((await s.get(`/products/${novo.body.id}/references/1`)).status, 200);
  assert.deepEqual(s.contagem(), { referencia: 1, asset: 1 }, 'arquivo novo não usa o fallback');
});

test('OPS-22 · durante: parte movida, parte não — tudo 200; o mover aceita destino já em uso pela release', async (t) => {
  const uploads = uploadsTemp(t);
  const store = createMemoryStore();
  const movido = await semear(store, uploads);
  const pendente = await semear(store, uploads);
  // A release nova já gravou no diretório da Organization antes do mover.
  const daRelease = await semear(store, uploads, { tenant: ORG_A });
  // "Movido" à mão, como um mover interrompido no meio.
  for (const rel of [movido.ref, movido.storageKey]) {
    const de = path.join(dirTenant(uploads, LEGADO), rel);
    const para = path.join(dirTenant(uploads, ORG_A), rel);
    fs.mkdirSync(path.dirname(para), { recursive: true });
    fs.renameSync(de, para);
  }
  const s = await subir({ uploads, store, leituraLegada: CONFIG, tenantAtual: () => ORG_A });
  t.after(s.fechar);

  for (const x of [movido, pendente, daRelease]) {
    const ref = await s.get(`/products/${x.productId}/references/1`);
    assert.equal(ref.status, 200);
    assert.deepEqual(ref.buf, x.bufRef);
    const asset = await s.get(`/assets/${x.creativeId}`);
    assert.equal(asset.status, 200);
    assert.deepEqual(asset.buf, x.bufAsset);
  }
  assert.deepEqual(s.contagem(), { referencia: 1, asset: 1 }, 'só o pendente usou o fallback');

  // Cópia idêntica já no destino (execução interrompida depois do link): conta como duplicado.
  const dup = await semear(store, uploads);
  escrever(uploads, ORG_A, dup.ref, dup.bufRef);
  const plano = mover.planejarMovimento({ uploads, de: LEGADO, para: ORG_A });
  assert.equal(plano.acao, 'mover');
  assert.deepEqual([...plano.mover].sort(), [dup.storageKey, pendente.ref, pendente.storageKey].sort());
  assert.deepEqual(plano.iguais, [dup.ref]);

  const r = mover.moverCriativos({ uploads, de: LEGADO, para: ORG_A }, { aplicar: true });
  assert.deepEqual([r.aplicado, r.movidos, r.duplicadosRemovidos], [true, 3, 1]);
  const antes = s.contagem();
  for (const x of [movido, pendente, daRelease, dup]) {
    assert.equal((await s.get(`/products/${x.productId}/references/1`)).status, 200);
    assert.equal((await s.get(`/assets/${x.creativeId}`)).status, 200);
  }
  assert.deepEqual(s.contagem(), antes, 'depois do mover, nenhuma leitura usa o legado');
});

test('OPS-22 · depois: tudo movido — 200 sem fallback, verificação PASS, re-execução não faz nada', async (t) => {
  const uploads = uploadsTemp(t);
  const store = createMemoryStore();
  const itens = [await semear(store, uploads), await semear(store, uploads)];

  const simulado = mover.moverCriativos({ uploads, de: LEGADO, para: ORG_A });
  assert.equal(simulado.aplicado, false);
  assert.ok(fs.existsSync(path.join(dirTenant(uploads, LEGADO), itens[0].ref)), 'simulação não move');
  assert.equal(mover.verificarCriativos({ uploads, de: LEGADO, para: ORG_A }, bancoDoStore(itens)).status, 'FAIL', 'antes do mover: FAIL');

  const r = mover.moverCriativos({ uploads, de: LEGADO, para: ORG_A }, { aplicar: true });
  assert.deepEqual([r.aplicado, r.movidos], [true, 4]);
  assert.ok(!fs.existsSync(dirTenant(uploads, LEGADO)), 'diretório legado removido');

  const v = mover.verificarCriativos({ uploads, de: LEGADO, para: ORG_A }, bancoDoStore(itens));
  assert.equal(v.status, 'PASS', v.problemas.join('\n'));
  assert.deepEqual([v.legadoRestante, v.assets, v.hashesConferidos, v.referencias, v.referenciasOk], [0, 2, 2, 2, 2]);

  const denovo = mover.moverCriativos({ uploads, de: LEGADO, para: ORG_A }, { aplicar: true });
  assert.deepEqual([denovo.acao, denovo.aplicado], ['nada', false]);

  for (const leituraLegada of [CONFIG, null]) {
    const s = await subir({ uploads, store, leituraLegada, tenantAtual: () => ORG_A });
    try {
      for (const x of itens) {
        assert.equal((await s.get(`/products/${x.productId}/references/1`)).status, 200);
        assert.equal((await s.get(`/assets/${x.creativeId}`)).status, 200);
      }
      assert.deepEqual(s.contagem(), { referencia: 0, asset: 0 }, 'sem fallback');
    } finally {
      s.fechar();
    }
  }
});

test('OPS-22 · a verificação reprova arquivo ausente, hash divergente e chave inválida no banco', async (t) => {
  const uploads = uploadsTemp(t);
  const store = createMemoryStore();
  const x = await semear(store, uploads, { tenant: ORG_A });
  const opcoes = { uploads, de: LEGADO, para: ORG_A };
  assert.equal(mover.verificarCriativos(opcoes, bancoDoStore([x])).status, 'PASS');

  const hash = mover.verificarCriativos(opcoes, { assets: [{ rel: x.storageKey, sha256: sha(Buffer.from('outro')), bytes: x.bufAsset.length }], referencias: [] });
  assert.equal(hash.status, 'FAIL');
  assert.match(hash.problemas.join('\n'), /sha256 divergente/);

  const ausente = mover.verificarCriativos(opcoes, { assets: [], referencias: [{ rel: `products/${crypto.randomUUID()}/${crypto.randomUUID()}.png`, bytes: null }] });
  assert.equal(ausente.status, 'FAIL');
  assert.match(ausente.problemas.join('\n'), /ausente no diretório novo: products\//);
  assert.ok(!ausente.problemas.join('\n').includes(uploads), 'só nomes relativos');

  const tamanho = mover.verificarCriativos(opcoes, { assets: [], referencias: [{ rel: x.ref, bytes: 1 }] });
  assert.match(tamanho.problemas.join('\n'), /tamanho divergente/);

  const invalida = mover.verificarCriativos(opcoes, { assets: [], referencias: [{ rel: '../../etc/passwd', bytes: null }] });
  assert.deepEqual([invalida.status, invalida.problemas], ['FAIL', ['referência com chave inválida no banco']]);
});

test('OPS-22 · fallback desligado: comportamento anterior (arquivo só no legado não é servido)', async (t) => {
  const uploads = uploadsTemp(t);
  const store = createMemoryStore();
  const x = await semear(store, uploads);
  const s = await subir({ uploads, store, leituraLegada: null, tenantAtual: () => ORG_A });
  t.after(s.fechar);
  assert.equal((await s.get(`/products/${x.productId}/references/1`)).status, 500);
  assert.equal((await s.get(`/assets/${x.creativeId}`)).status, 500);
  assert.deepEqual(s.contagem(), { referencia: 0, asset: 0 });
  assert.throws(() => createStorage({ uploadsDir: uploads, tenantId: ORG_A }).readProductReference(x.ref), { code: 'ENOENT' });
});

test('OPS-22 · Organization não mapeada nunca lê o diretório legado (duas Organizations)', async (t) => {
  const uploads = uploadsTemp(t);
  const store = createMemoryStore();
  const deA = await semear(store, uploads);
  // B tem, no próprio banco, uma referência com o MESMO nome do arquivo legado de A (produto com id próprio:
  // o memoryStore indexa por id, e um id repetido sobrescreveria o produto de A).
  const produtoB = crypto.randomUUID();
  await store.createProduct(ORG_B, { id: produtoB, name: 'b', type: 't', metadata: {}, references: [{ ref: deA.ref, mime: 'image/png', sizeBytes: 1 }] });
  await store.insertAsset(ORG_B, { id: crypto.randomUUID(), creativeId: deA.creativeId, storageKey: deA.storageKey, sha256: 'x', byteSize: 1, mime: 'image/png' });

  let atual = ORG_B;
  const s = await subir({ uploads, store, leituraLegada: CONFIG, tenantAtual: () => atual });
  t.after(s.fechar);
  const refB = await s.get(`/products/${produtoB}/references/1`);
  assert.notEqual(refB.status, 200, 'B leu o arquivo legado de A');
  assert.ok(!refB.buf.includes(Buffer.from(`ref-${deA.productId}`)));
  const assetB = await s.get(`/assets/${deA.creativeId}`);
  assert.notEqual(assetB.status, 200, 'B leu o asset legado de A');
  assert.deepEqual(s.contagem(), { referencia: 0, asset: 0 });

  atual = ORG_A;
  assert.equal((await s.get(`/products/${deA.productId}/references/1`)).status, 200, 'controle: A lê');

  const storageB = createStorage({ uploadsDir: uploads, tenantId: ORG_B, leituraLegada: CONFIG });
  assert.throws(() => storageB.readProductReference(deA.ref), { code: 'ENOENT' });
  assert.throws(() => storageB.readCreativeAsset(deA.storageKey), { code: 'ENOENT' });
  // Mapeada para B, A também não lê mais.
  const storageA = createStorage({ uploadsDir: uploads, tenantId: ORG_A, leituraLegada: { de: LEGADO, organizationId: ORG_B } });
  assert.throws(() => storageA.readProductReference(deA.ref), { code: 'ENOENT' });
});

test('OPS-22 · caminho confinado: sem traversal, sem diretório de outra Organization, sem link simbólico', async (t) => {
  const uploads = uploadsTemp(t);
  // O "legado" apontado para o diretório de outra Organization (uuid) ou para fora da raiz de tenants.
  const deB = conteudo('segredo-de-b');
  const ref = `products/${crypto.randomUUID()}/${crypto.randomUUID()}.png`;
  escrever(uploads, ORG_B, ref, deB);
  fs.writeFileSync(path.join(uploads, 'fora.png'), deB);
  for (const de of [ORG_B, '..', '../..', '../../etc', 'default/../..', '.', '']) {
    assert.throws(
      () => createStorage({ uploadsDir: uploads, tenantId: ORG_A, leituraLegada: { de, organizationId: ORG_A } }).readProductReference(ref),
      /leitura legada: origem/, `origem ${JSON.stringify(de)} aceita`
    );
  }

  const storage = createStorage({ uploadsDir: uploads, tenantId: ORG_A, leituraLegada: CONFIG });
  for (const rel of ['products/../../x', '../default/products/a.png', `/${ref}`, `products/${crypto.randomUUID()}/../../../fora.png`]) {
    assert.throws(() => storage.readProductReference(rel), /referência inválida/);
  }
  assert.throws(() => storage.readCreativeAsset('creatives/../../fora.png'), /asset inválido/);

  // Link simbólico no diretório legado não é seguido.
  const link = path.join(dirTenant(uploads, LEGADO), ref);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(dirTenant(uploads, ORG_B), ref), link);
  assert.throws(() => storage.readProductReference(ref), { code: 'ENOENT' });
  // E o mover recusa mexer num diretório com link simbólico.
  assert.throws(() => mover.planejarMovimento({ uploads, de: LEGADO, para: ORG_A }), /link simbólico/);

  // Mover: origem com forma de uuid ou traversal é recusada; conflito não move nada.
  assert.throws(() => mover.planejarMovimento({ uploads, de: ORG_B, para: ORG_A }), /--de inválido/);
  assert.throws(() => mover.planejarMovimento({ uploads, de: '../x', para: ORG_A }), /--de inválido/);
  fs.unlinkSync(link);
  escrever(uploads, LEGADO, ref, conteudo('versao-legada'));
  escrever(uploads, ORG_A, ref, conteudo('versao-nova'));
  assert.throws(() => mover.moverCriativos({ uploads, de: LEGADO, para: ORG_A }, { aplicar: true }), /conteúdo diferente: products\//);
  assert.deepEqual(fs.readFileSync(path.join(dirTenant(uploads, ORG_A), ref)), conteudo('versao-nova'), 'conflito não sobrescreve');
  assert.ok(fs.existsSync(path.join(dirTenant(uploads, LEGADO), ref)), 'conflito não apaga a origem');
});

test('OPS-22 · configuração: explícita, as duas juntas, sem dedução', () => {
  assert.equal(lerLeituraLegada({}), null);
  assert.equal(lerLeituraLegada({ CREATIVE_LEGACY_READ_FROM: ' ', CREATIVE_LEGACY_READ_ORGANIZATION_ID: '' }), null);
  assert.deepEqual(
    { ...lerLeituraLegada({ CREATIVE_LEGACY_READ_FROM: 'Default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_A.toUpperCase() }) },
    { de: 'default', organizationId: ORG_A }
  );
  for (const env of [
    { CREATIVE_LEGACY_READ_FROM: 'default' },
    { CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_A },
    { CREATIVE_LEGACY_READ_FROM: '../default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_A },
    { CREATIVE_LEGACY_READ_FROM: 'a/b', CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_A },
    { CREATIVE_LEGACY_READ_FROM: ORG_B, CREATIVE_LEGACY_READ_ORGANIZATION_ID: ORG_A },
    { CREATIVE_LEGACY_READ_FROM: 'default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: 'todas' },
    { CREATIVE_LEGACY_READ_FROM: 'default', CREATIVE_LEGACY_READ_ORGANIZATION_ID: `${ORG_A},${ORG_B}` },
  ]) {
    assert.throws(() => lerLeituraLegada(env), { name: 'LeituraLegadaConfigError' }, JSON.stringify(env));
  }
  // CREATIVE_TENANT_ID não liga nada.
  assert.equal(lerLeituraLegada({ CREATIVE_TENANT_ID: 'default' }), null);

  let agora = 0;
  const avisos = [];
  const obs = criarObservadorLeituraLegada({ logger: { warn: (m) => avisos.push(m) }, intervaloMs: 1000, agora: () => agora });
  obs.registrar({ tipo: 'asset' });
  obs.registrar({ tipo: 'referencia' });
  agora = 1000;
  obs.registrar({ tipo: 'referencia' });
  assert.deepEqual(obs.contagem(), { referencia: 2, asset: 1 });
  assert.equal(avisos.length, 2);
  assert.match(avisos[1], /referencias=2 assets=1/);
});
