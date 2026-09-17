'use strict';

// OPS-22 · revisão da rodada 19: a RELEASE B do runbook é o commit 31a7cdb, que NÃO tem a leitura dupla.
// Ele já lê/grava em creatives/tenant/<organization_id>; a produção (ed5a5b0) lê/grava em
// creatives/tenant/<CREATIVE_TENANT_ID || default>. Plano: ANTES da B, `mover-criativos --vincular`
// cria tenant/<organization_id> como link simbólico relativo para o legado (um passo atômico). As duas
// versões passam a ler e gravar os mesmos arquivos. A materialização (remover o vínculo e mover) só
// acontece numa release com a leitura dupla (HEAD), com `--desvincular --aplicar`.
//
// Aqui roda o código REAL de cada commit (git archive de routes/criativos.js + lib/creative-core/),
// sobre o mesmo volume: antes, durante e depois, com uploads das duas versões e rollback B → anterior.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const h = require('./harness');

const PRODUCAO = 'ed5a5b0'; // master: tenant = CREATIVE_TENANT_ID || 'default'
const RELEASE_B = '31a7cdb'; // tenant = Organization da sessão, sem leitura dupla
const MOVER = path.join(h.RAIZ_REPO, 'scripts', 'tenancy', 'mover-criativos.mjs');
const ORG = 'a1000000-0000-4000-8000-000000000001';
const LEGADO = 'default';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const identidade = (t) => Buffer.from(t).toString('base64');
const silencioso = { log() {}, warn() {}, error() {} };

let tmp;
let mover;
const codigo = {};

function git(args) {
  const r = spawnSync('git', args, { cwd: h.RAIZ_REPO, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// routes/criativos.js + lib/creative-core/ do commit, com o node_modules do repositório.
function extrair(commit) {
  const dir = path.join(tmp, commit);
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(tmp, `${commit}.tar`);
  fs.writeFileSync(tar, git(['archive', '--format=tar', commit, 'routes/criativos.js', 'lib/creative-core']));
  const r = spawnSync('tar', ['-xf', tar, '-C', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.symlinkSync(path.join(h.RAIZ_REPO, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return {
    criarRouterCriativos: require(path.join(dir, 'routes', 'criativos.js')).criarRouterCriativos,
    createMemoryStore: require(path.join(dir, 'lib', 'creative-core', 'memoryStore.js')).createMemoryStore,
  };
}

test.before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops22-release-b-'));
  codigo.producao = extrair(PRODUCAO);
  codigo.b = extrair(RELEASE_B);
  codigo.head = {
    criarRouterCriativos: h.sujeito('routes/criativos.js').criarRouterCriativos,
    createMemoryStore: h.sujeito('lib/creative-core/memoryStore.js').createMemoryStore,
  };
  mover = await import(pathToFileURL(MOVER));
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const core = { configured: true, async validate() { return { valid: true, errors: [] }; }, async contracts() { return {}; }, async health() { return { versions: {} }; } };

// Uma versão do painel no ar. `tenant` = chave com que ESSA versão grava no banco (a migration da B
// troca default → organization_id; aqui cada versão tem seu store e o teste replica as linhas).
async function subir(versao, uploads, extra = {}) {
  const store = codigo[versao].createMemoryStore();
  const tenant = versao === 'producao' ? LEGADO : ORG;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const modulo = codigo[versao].criarRouterCriativos({
    requireAdmin: (req, res, next) => next(),
    tenantAtual: () => ORG,
    paraCadaTenant: async () => {},
    pgPool: null, store, core, uploadsDir: uploads,
    lerEntitlements: async () => ({ creative_generator: true }),
    encriptarSegredo: identidade, descriptografarSegredo: (b) => Buffer.from(b, 'base64').toString(),
    env: {}, logger: silencioso,
    ...extra,
  });
  app.use('/c', modulo.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/c`;
  return {
    versao, store, tenant, modulo,
    async ler(item) {
      const r = await fetch(`${base}/products/${item.productId}/references/1`);
      const a = await fetch(`${base}/assets/${item.creativeId}`);
      return { ref: r.status, refOk: r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(item.bufRef), asset: a.status, assetOk: a.status === 200 && Buffer.from(await a.arrayBuffer()).equals(item.bufAsset) };
    },
    async enviar() {
      const bufRef = Buffer.concat([PNG, crypto.randomBytes(8)]);
      const res = await fetch(`${base}/products`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'novo', type: 't', images: [{ data_base64: bufRef.toString('base64') }] }) });
      assert.equal(res.status, 201, `${versao}: upload`);
      const { id } = await res.json();
      const produto = await store.getProduct(tenant, id);
      return { productId: id, references: produto.references, bufRef };
    },
    fechar: () => server.close(),
  };
}

// Arquivo existente (no disco do tenant `dir`) + linhas no banco.
function criarItem(uploads, dir) {
  const productId = crypto.randomUUID();
  const creativeId = crypto.randomUUID();
  const item = {
    productId, creativeId,
    ref: `products/${productId}/${crypto.randomUUID()}.png`,
    storageKey: `creatives/${creativeId}/image.png`,
    bufRef: Buffer.concat([PNG, crypto.randomBytes(8)]),
    bufAsset: Buffer.concat([PNG, crypto.randomBytes(8)]),
  };
  for (const [rel, buf] of [[item.ref, item.bufRef], [item.storageKey, item.bufAsset]]) {
    const abs = path.join(uploads, 'creatives', 'tenant', dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
  }
  return item;
}

// "Banco compartilhado": a linha existe para as duas versões, cada uma com a sua chave de tenant.
async function registrar(instancias, item) {
  for (const i of instancias) {
    await i.store.createProduct(i.tenant, { id: item.productId, name: 'p', type: 't', metadata: {}, references: [{ ref: item.ref, mime: 'image/png', sizeBytes: item.bufRef.length }] });
    if (item.creativeId) {
      await i.store.insertAsset(i.tenant, { id: crypto.randomUUID(), creativeId: item.creativeId, storageKey: item.storageKey, sha256: 'x', byteSize: item.bufAsset.length, mime: 'image/png' });
    }
  }
}

// Upload feito por uma versão, registrado nas outras (sem asset: só a referência de produto).
async function uploadVisivel(origem, outras) {
  const u = await origem.enviar();
  const item = { productId: u.productId, ref: u.references[0].ref, bufRef: u.bufRef };
  await registrar(outras, { ...item, creativeId: null });
  return item;
}

async function lerRef(inst, item) {
  const r = await inst.ler({ ...item, creativeId: crypto.randomUUID(), bufAsset: Buffer.alloc(0) });
  return r.refOk;
}

function banco(itens) {
  return {
    assets: itens.filter((i) => i.creativeId).map((i) => ({ rel: i.storageKey, sha256: crypto.createHash('sha256').update(i.bufAsset).digest('hex'), bytes: i.bufAsset.length })),
    referencias: itens.map((i) => ({ rel: i.ref, bytes: i.bufRef.length })),
  };
}

function uploadsTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops22-vol-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('OPS-22/B · controle: sem o vínculo, a RELEASE B (31a7cdb) não serve os arquivos existentes', async (t) => {
  const uploads = uploadsTemp(t);
  const b = await subir('b', uploads);
  t.after(b.fechar);
  const antigo = criarItem(uploads, LEGADO);
  await registrar([b], antigo);
  const r = await b.ler(antigo);
  assert.deepEqual([r.ref, r.asset], [500, 500], 'a janela existe sem o procedimento');
});

test('OPS-22/B · vínculo antes da B: produção e B leem e gravam os mesmos arquivos, inclusive no rollback', async (t) => {
  const uploads = uploadsTemp(t);
  const opcoes = { uploads, de: LEGADO, para: ORG };
  const antigos = [criarItem(uploads, LEGADO), criarItem(uploads, LEGADO)];

  // Antes: só a produção no ar.
  const prod = await subir('producao', uploads);
  t.after(prod.fechar);
  await registrar([prod], antigos[0]);
  await registrar([prod], antigos[1]);
  for (const x of antigos) assert.deepEqual(await prod.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true });

  // Simulação não muda nada; aplicação cria o vínculo (um passo).
  const sim = mover.vincularCriativos(opcoes);
  assert.deepEqual([sim.acao, sim.aplicado, sim.arquivos, sim.criarOrigem], ['vincular', false, 4, false]);
  assert.equal(fs.existsSync(path.join(uploads, 'creatives', 'tenant', ORG)), false);
  const upAntes = await uploadVisivel(prod, []);
  assert.equal(mover.vincularCriativos(opcoes, { aplicar: true }).aplicado, true);
  assert.equal(fs.readlinkSync(path.join(uploads, 'creatives', 'tenant', ORG)), LEGADO, 'link relativo');
  assert.equal(mover.vincularCriativos(opcoes, { aplicar: true }).acao, 'nada', 'idempotente');
  assert.equal(mover.verificarCriativos(opcoes, banco(antigos)).status, 'PASS-VINCULADO');

  // Durante (as duas versões no ar, como num deploy com réplicas sobrepostas).
  const b = await subir('b', uploads);
  t.after(b.fechar);
  await registrar([b], antigos[0]);
  await registrar([b], antigos[1]);
  await registrar([b], { ...upAntes, creativeId: null });
  for (const x of antigos) {
    assert.deepEqual(await prod.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true }, 'produção');
    assert.deepEqual(await b.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true }, 'B');
  }
  assert.ok(await lerRef(b, upAntes), 'upload da produção antes do vínculo, visto pela B');

  const daProducao = await uploadVisivel(prod, [b]);
  const daB = await uploadVisivel(b, [prod]);
  assert.ok(await lerRef(b, daProducao), 'upload da produção visível na B');
  assert.ok(await lerRef(prod, daB), 'upload da B visível na produção');
  // Um único diretório físico: nada foi gravado fora do legado.
  assert.deepEqual(fs.readdirSync(path.join(uploads, 'creatives', 'tenant')).sort(), [LEGADO, ORG].sort());
  assert.ok(fs.lstatSync(path.join(uploads, 'creatives', 'tenant', ORG)).isSymbolicLink());

  // Com o vínculo, o movimento comum é recusado e nada se perde.
  assert.throws(() => mover.moverCriativos(opcoes, { aplicar: true }), /vínculo/);
  assert.throws(() => mover.planejarMovimento(opcoes), /--desvincular/);

  // Rollback B → produção: a produção continua vendo tudo, inclusive o que a B gravou.
  b.fechar();
  for (const x of antigos) assert.deepEqual(await prod.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true });
  assert.ok(await lerRef(prod, daB));
  assert.ok(await lerRef(prod, daProducao));

  // Roll-forward de novo (B no ar), ainda vinculado.
  const b2 = await subir('b', uploads);
  t.after(b2.fechar);
  for (const x of [...antigos]) await registrar([b2], x);
  for (const x of [upAntes, daProducao, daB]) await registrar([b2], { ...x, creativeId: null });
  for (const x of antigos) assert.deepEqual(await b2.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true });
  for (const x of [upAntes, daProducao, daB]) assert.ok(await lerRef(b2, x));
  const todos = [...antigos, upAntes, daProducao, daB];
  assert.equal(mover.verificarCriativos(opcoes, banco(todos)).status, 'PASS-VINCULADO');
});

test('OPS-22/B · materialização numa release com leitura dupla: sem janela, e depois PASS separado', async (t) => {
  const uploads = uploadsTemp(t);
  const opcoes = { uploads, de: LEGADO, para: ORG };
  const antigos = [criarItem(uploads, LEGADO), criarItem(uploads, LEGADO)];
  mover.vincularCriativos(opcoes, { aplicar: true });

  const head = await subir('head', uploads, { leituraLegada: { de: LEGADO, organizationId: ORG } });
  t.after(head.fechar);
  for (const x of antigos) await registrar([head], x);
  const doVinculo = await uploadVisivel(head, []);
  for (const x of antigos) assert.deepEqual(await head.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true });
  assert.deepEqual(head.modulo.leituraLegada.contagem(), { referencia: 0, asset: 0 }, 'vinculado: sem fallback');

  // Sem --desvincular, recusado; simulação com o vínculo mostra tudo a mover.
  assert.throws(() => mover.moverCriativos(opcoes, { aplicar: true }), /--desvincular/);
  const plano = mover.planejarMovimento({ ...opcoes, desvincular: true });
  assert.deepEqual([plano.acao, plano.desvincular, plano.mover.length], ['mover', true, 5]);

  // "Durante": vínculo removido, arquivos ainda no legado → a leitura dupla serve; upload vai para o novo.
  fs.unlinkSync(path.join(uploads, 'creatives', 'tenant', ORG));
  for (const x of antigos) assert.deepEqual(await head.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true });
  assert.ok(await lerRef(head, doVinculo));
  const noMeio = await uploadVisivel(head, []);
  assert.ok(fs.lstatSync(path.join(uploads, 'creatives', 'tenant', ORG)).isDirectory(), 'diretório real criado pela escrita');
  assert.ok(head.modulo.leituraLegada.contagem().referencia > 0, 'fallback usado');

  // O vínculo já saiu (passo interrompido): a mesma chamada segue como movimento comum, idempotente.
  const r = mover.moverCriativos({ ...opcoes, desvincular: true }, { aplicar: true });
  assert.deepEqual([r.aplicado, r.movidos, r.desvinculado], [true, 5, undefined]);
  const antes = head.modulo.leituraLegada.contagem();
  const todos = [...antigos, doVinculo, noMeio];
  for (const x of antigos) assert.deepEqual(await head.ler(x), { ref: 200, refOk: true, asset: 200, assetOk: true });
  for (const x of [doVinculo, noMeio]) assert.ok(await lerRef(head, x));
  assert.deepEqual(head.modulo.leituraLegada.contagem(), antes, 'depois: sem fallback');
  const v = mover.verificarCriativos(opcoes, banco(todos));
  assert.deepEqual([v.status, v.estado, v.legadoRestante], ['PASS', 'separado', 0]);
});

test('OPS-22/B · --desvincular --aplicar remove o vínculo e move tudo num passo; B segue servindo', async (t) => {
  const uploads = uploadsTemp(t);
  const opcoes = { uploads, de: LEGADO, para: ORG };
  // Sem legado: o vínculo cria o diretório legado vazio (senão cada versão criaria o seu).
  const sim = mover.vincularCriativos(opcoes);
  assert.deepEqual([sim.criarOrigem, sim.arquivos], [true, 0]);
  mover.vincularCriativos(opcoes, { aplicar: true });
  assert.ok(fs.lstatSync(path.join(uploads, 'creatives', 'tenant', LEGADO)).isDirectory());

  const prod = await subir('producao', uploads);
  t.after(prod.fechar);
  const b = await subir('b', uploads);
  t.after(b.fechar);
  const daProducao = await uploadVisivel(prod, [b]);
  const daB = await uploadVisivel(b, [prod]);
  assert.ok(await lerRef(b, daProducao));
  assert.ok(await lerRef(prod, daB));

  const r = mover.moverCriativos({ ...opcoes, desvincular: true }, { aplicar: true });
  assert.deepEqual([r.aplicado, r.desvinculado, r.movidos], [true, true, 2]);
  assert.ok(fs.lstatSync(path.join(uploads, 'creatives', 'tenant', ORG)).isDirectory());
  assert.ok(!fs.existsSync(path.join(uploads, 'creatives', 'tenant', LEGADO)));
  assert.ok(await lerRef(b, daProducao), 'B (e HEAD) servem depois da materialização');
  assert.ok(await lerRef(b, daB));
  // Documentado no runbook: depois da materialização, a versão anterior à B não vê mais os arquivos.
  assert.equal(await lerRef(prod, daB), false);
  assert.equal(mover.verificarCriativos(opcoes, banco([daProducao, daB])).status, 'PASS');
  assert.equal(mover.moverCriativos({ ...opcoes, desvincular: true }, { aplicar: true }).acao, 'nada');
});

test('OPS-22/B · vínculo recusado quando não se aplica; estado inválido reprova a verificação', async (t) => {
  const uploads = uploadsTemp(t);
  const opcoes = { uploads, de: LEGADO, para: ORG };
  const tenants = path.join(uploads, 'creatives', 'tenant');
  // A B já gravou no diretório real: o vínculo não se aplica (use a leitura dupla).
  criarItem(uploads, ORG);
  assert.throws(() => mover.vincularCriativos(opcoes, { aplicar: true }), /já existe \(diretório\)/);
  fs.rmSync(path.join(tenants, ORG), { recursive: true });
  // Link para outro lugar: nem vincular, nem mover, nem verificar aceitam.
  fs.mkdirSync(path.join(tenants, 'outro'), { recursive: true });
  fs.symlinkSync('outro', path.join(tenants, ORG), 'dir');
  assert.throws(() => mover.vincularCriativos(opcoes, { aplicar: true }), /não é o vínculo esperado/);
  assert.throws(() => mover.moverCriativos({ ...opcoes, desvincular: true }, { aplicar: true }), /nem o vínculo/);
  assert.equal(mover.verificarCriativos(opcoes, banco([])).status, 'FAIL');
  fs.unlinkSync(path.join(tenants, ORG));
  // Legado que é link: recusado.
  fs.symlinkSync('outro', path.join(tenants, LEGADO), 'dir');
  assert.throws(() => mover.vincularCriativos(opcoes, { aplicar: true }), /não é um diretório comum/);
  assert.equal(fs.existsSync(path.join(tenants, ORG)), false, 'nada criado');
  // Vínculo pendurado (legado apagado à mão): verificação reprova.
  fs.unlinkSync(path.join(tenants, LEGADO));
  fs.symlinkSync(LEGADO, path.join(tenants, ORG), 'dir');
  assert.equal(mover.verificarCriativos(opcoes, banco([])).status, 'FAIL');
});

// O bloco de shell do runbook (docs/produtizacao-saas/round19-trilha-g.md, §7.5), extraído do próprio documento:
// a produção (ed5a5b0) não tem o mover, então o vínculo é criado com ele.
function blocoDoRunbook() {
  const doc = fs.readFileSync(path.join(h.RAIZ_REPO, 'docs', 'produtizacao-saas', 'round19-trilha-g.md'), 'utf8');
  const linhas = doc.slice(doc.indexOf('<!-- ops22-vincular-sh -->')).split('\n').map((l) => l.replace(/^> ?/, ''));
  const inicio = linhas.indexOf('```sh');
  const fim = linhas.indexOf('```', inicio + 1);
  assert.ok(inicio > 0 && fim > inicio, 'bloco de shell não encontrado no documento');
  return linhas.slice(inicio + 1, fim).join('\n');
}

function rodarBloco(uploads, extra = {}) {
  const r = spawnSync('sh', ['-c', blocoDoRunbook()], {
    encoding: 'utf8', env: { PATH: process.env.PATH, UPLOADS_DIR: uploads, LEGADO, ORG, ...extra },
  });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

test('OPS-22/B · o bloco de shell do runbook cria o mesmo vínculo que --vincular', async (t) => {
  const uploads = uploadsTemp(t);
  const opcoes = { uploads, de: LEGADO, para: ORG };
  const antigo = criarItem(uploads, LEGADO);
  const r = rodarBloco(uploads);
  assert.equal(r.status, 0, r.saida);
  assert.match(r.saida, new RegExp(`vínculo criado: tenant/${ORG} -> tenant/${LEGADO} \\(2 arquivo\\(s\\)\\)`));
  assert.equal(mover.vincularCriativos(opcoes).acao, 'nada');
  assert.equal(mover.verificarCriativos(opcoes, banco([antigo])).status, 'PASS-VINCULADO');
  const denovo = rodarBloco(uploads);
  assert.deepEqual([denovo.status, denovo.saida.trim()], [0, 'vínculo já existe']);

  const b = await subir('b', uploads);
  t.after(b.fechar);
  await registrar([b], antigo);
  assert.deepEqual(await b.ler(antigo), { ref: 200, refOk: true, asset: 200, assetOk: true });

  // Sem legado: cria vazio e vincula. Diretório real já existente, ou entrada inválida: para sem mudar nada.
  const vazio = uploadsTemp(t);
  assert.equal(rodarBloco(vazio).status, 0);
  assert.ok(fs.lstatSync(path.join(vazio, 'creatives', 'tenant', LEGADO)).isDirectory());
  const ocupado = uploadsTemp(t);
  criarItem(ocupado, ORG);
  const parar = rodarBloco(ocupado);
  assert.equal(parar.status, 1);
  assert.match(parar.saida, /PARAR: tenant\/.* já existe/);
  assert.ok(!fs.existsSync(path.join(ocupado, 'creatives', 'tenant', LEGADO)), 'nada criado');
  for (const extra of [{ LEGADO: '../x' }, { ORG: '../x' }, { ORG: '' }]) {
    const ruim = rodarBloco(uploadsTemp(t), extra);
    assert.notEqual(ruim.status, 0, JSON.stringify(extra));
  }
});

// ── Negative control (5 passos): o mover ANTERIOR a esta revisão, diante do vínculo, apaga os arquivos.
async function movimentoComVinculoPreserva(moduloMover, t) {
  const uploads = uploadsTemp(t);
  const opcoes = { uploads, de: LEGADO, para: ORG };
  const x = criarItem(uploads, LEGADO);
  fs.symlinkSync(LEGADO, path.join(uploads, 'creatives', 'tenant', ORG), 'dir');
  try { moduloMover.moverCriativos(opcoes, { aplicar: true }); } catch { /* recusar é o esperado */ }
  return [x.ref, x.storageKey].every((rel) => fs.existsSync(path.join(uploads, 'creatives', 'tenant', ORG, rel)));
}

test('OPS-22/B · negative control: o mover sem proteção do vínculo apaga os arquivos (5 passos)', async (t) => {
  const raiz = path.join(tmp, 'nc-mover');
  fs.mkdirSync(path.join(raiz, 'scripts', 'tenancy'), { recursive: true });
  fs.symlinkSync(path.join(h.RAIZ_REPO, 'lib'), path.join(raiz, 'lib'), 'dir');
  fs.symlinkSync(path.join(h.RAIZ_REPO, 'node_modules'), path.join(raiz, 'node_modules'), 'dir');
  const copia = path.join(raiz, 'scripts', 'tenancy', 'mover-criativos.mjs');
  const atual = fs.readFileSync(MOVER, 'utf8');
  let versao = 0;
  const carregar = (conteudo) => {
    fs.writeFileSync(copia, conteudo);
    versao += 1;
    return import(`${pathToFileURL(copia)}?v=${versao}`);
  };

  assert.equal(await movimentoComVinculoPreserva(await carregar(atual), t), true, '[1] estado correto');
  // Violação = o mover antes desta revisão: não reconhece o vínculo nem o arquivo alcançado por link.
  const trechos = [
    ["  const estado = estadoDoDestino(destino, de);\n  if (estado === 'invalido') throw new Error(`tenant/${para} existe e não é diretório",
      "  const estado = 'diretorio'; // VIOLAÇÃO DELIBERADA\n  if (estado === 'invalido') throw new Error(`tenant/${para} existe e não é diretório"],
    ['    else if (fs.realpathSync(alvo).startsWith(origemReal + path.sep)) conflitos.push(rel);\n', ''],
  ];
  let anterior = atual;
  for (const [de, para] of trechos) {
    assert.equal(atual.split(de).length - 1, 1, `trecho da violação não encontrado: ${de.trim()}`);
    anterior = anterior.replace(de, para);
  }
  assert.equal(await movimentoComVinculoPreserva(await carregar(anterior), t), false, '[3] o defeito não foi detectado');
  assert.equal(await movimentoComVinculoPreserva(await carregar(atual), t), true, '[5] não voltou a passar');
});
