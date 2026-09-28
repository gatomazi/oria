'use strict';

// Provider de Promoções da INK: contrato oficial (INK falsa em memória, sem rede). Prova mapper, leitura, criação, atualização, exclusão,
// idempotência, tratamento de erro e o fail-closed de escrita. NÃO valida a conta real da loja (ver docs/afiliados/auditoria-integracao.md §6).

const test = require('node:test');
const assert = require('node:assert/strict');

const inkPromo = require('../lib/afiliados/ink-promotions');
const { criarInkFalsa } = require('./helpers/ink-promotions-fake');

const AGORA = new Date('2026-10-01T12:00:00Z');
const LINK = { id: 'link-1', codeDisplay: 'Amanda10', codeNormalized: 'AMANDA10', discountKind: 'percentage', discountBps: 1000, validFrom: new Date('2026-10-01T03:00:00Z'), validUntil: null };
const ESCRITA = ['store.promotions.read', 'store.promotions.write'];
const semEspera = { esperar: async () => {}, relogio: () => AGORA };

// `escrita:false` = connector sem integração de escrita (cliente só com `get`); a escrita é capacidade do connector, não flag.
const adaptador = (ink, { escrita = true, scopes = ESCRITA, client = escrita ? ink.client : ink.somenteLeitura, ...resto } = {}) =>
  inkPromo.createInkPromotionsAdapter({ client, scopes, ...semEspera, ...resto });
const promocaoCompativel = (extra = {}) => ({ code: 'AMANDA10', kind: 'percentage', discount_tier: { discount: 10 }, starts_at: '2026-10-01T03:00:00.000Z', ...extra });

// ── Mapper Oria → INK ──────────────────────────────────────────────────────────────────────────
test('mapper standard: só campos da promoção, desconto do cliente como número, sem gatilho inventado e sem nada de comissão', () => {
  const r = inkPromo.montarPedidoDeCriacao(LINK);
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.path, '/v1/stores/promotions/standard');
  assert.equal(r.request.escopoExigido, 'store.promotions.write');
  assert.deepEqual(r.request.body, {
    code: 'AMANDA10', kind: 'percentage', list_type: 'all', apply_automatically: false, show_on_product_page: false, show_in_cart: false, first_purchase: false, usage_limit: null,
    starts_at: '2026-10-01T03:00:00.000Z', discount_tier: { discount: 10 },
  });
  assert.equal('min_cart_value' in r.request.body.discount_tier, false);
  assert.equal('min_cart_items' in r.request.body.discount_tier, false);
  assert.doesNotMatch(JSON.stringify(r.request.body), /commission|comiss|level|nivel|benefit|saldo|cache|bps/i);
});

test('mapper standard: valor fixo em reais, vigência com fim e recusa de pedido inválido', () => {
  const v = inkPromo.montarPedidoDeCriacao({ ...LINK, discountKind: 'value', discountBps: null, discountCents: 2550, validUntil: new Date('2026-12-31T02:59:59Z') });
  assert.equal(v.request.body.kind, 'value');
  assert.deepEqual(v.request.body.discount_tier, { discount: 25.5 });
  assert.equal(v.request.body.expires_at, '2026-12-31T02:59:59.000Z');
  const ruim = inkPromo.montarPedidoDeCriacao({ ...LINK, codeDisplay: 'a b', codeNormalized: 'A B', discountKind: null });
  assert.equal(ruim.ok, false);
  assert.ok(ruim.problemas.length >= 2);
});

test('preview não faz chamada alguma e informa se enviaria (connector sem criação → modo manual, não enviaria)', () => {
  const ink = criarInkFalsa();
  const off = adaptador(ink, { escrita: false }).previsualizarCriacao(LINK);
  assert.equal(off.ok, true);
  assert.equal(off.enviaria, false);
  assert.equal(off.bloqueio, 'INK_PROMOTION_WRITES_UNAVAILABLE');
  const on = adaptador(ink).previsualizarCriacao(LINK);
  assert.equal(on.enviaria, true);
  assert.equal(ink.chamadas.length, 0);
});

// ── Idempotência ───────────────────────────────────────────────────────────────────────────────
test('Idempotency-Key: mesma intenção → mesma chave (mesmo em outra instância); outro payload → outra chave; sem segredo nem dado pessoal', () => {
  const a = inkPromo.montarPedidoDeCriacao(LINK).request.headers['Idempotency-Key'];
  const b = inkPromo.montarPedidoDeCriacao({ ...LINK }).request.headers['Idempotency-Key'];
  const c = inkPromo.montarPedidoDeCriacao({ ...LINK, discountBps: 1500 }).request.headers['Idempotency-Key'];
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^oria-aff-create-link-1-[0-9a-f]{16}$/);
  assert.equal(inkPromo.chaveDeAtualizacao('l', 5, { discount_tier: { discount: 12 } }), inkPromo.chaveDeAtualizacao('l', 5, { discount_tier: { discount: 12 } }));
  assert.notEqual(inkPromo.chaveDeAtualizacao('l', 5, { discount_tier: { discount: 12 } }), inkPromo.chaveDeAtualizacao('l', 5, { discount_tier: { discount: 13 } }));
  assert.equal(inkPromo.chaveDeExclusao('l', 5), 'oria-aff-delete-l-5');
});

// ── Fail-closed de escrita ─────────────────────────────────────────────────────────────────────
test('connector sem escrita (cliente só com get): ZERO POST/PATCH/DELETE, e o preview marca o modo manual', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  const ad = adaptador(ink, { escrita: false });
  await assert.rejects(() => ad.criarPromocao({ ...LINK, codeNormalized: 'NOVO10', codeDisplay: 'novo10' }), inkPromo.PromotionWritesUnavailableError);
  await assert.rejects(() => ad.atualizarPromocao(LINK, id), inkPromo.PromotionWritesUnavailableError);
  await assert.rejects(() => ad.excluirPromocao(LINK.id, id), inkPromo.PromotionWritesUnavailableError);
  assert.equal(ink.chamadas.length, 0);
});

test('capacidades do connector: cada escrita depende do seu método; sem `post` a criação é indisponível mas o PATCH/DELETE existentes seguem', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  const semPost = { get: ink.client.get, patch: ink.client.patch, delete: ink.client.delete };
  const ad = adaptador(ink, { client: semPost });
  assert.deepEqual(ad.capacidades(), { provider: 'ink', read: true, create: false, update: true, delete: true });
  await assert.rejects(() => ad.criarPromocao({ ...LINK, codeNormalized: 'NOVO10', codeDisplay: 'novo10' }), inkPromo.PromotionWritesUnavailableError);
  assert.equal((await ad.excluirPromocao(LINK.id, id)).excluida, true);
  assert.deepEqual(adaptador(ink, { escrita: false }).capacidades(), { provider: 'ink', read: true, create: false, update: false, delete: false });
  assert.deepEqual(inkPromo.createInkPromotionsAdapter({}).capacidades(), { provider: 'ink', read: false, create: false, update: false, delete: false });
});

test('escopo de escrita declarado sem `store.promotions.write`: recusa antes de qualquer chamada; escopo não declarado tenta (a INK responde 403 se faltar)', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  const ad = adaptador(ink, { scopes: ['store.promotions.read'] });
  await assert.rejects(() => ad.criarPromocao({ ...LINK, codeNormalized: 'NOVO10', codeDisplay: 'novo10' }), inkPromo.PromotionPermissionError);
  await assert.rejects(() => ad.atualizarPromocao(LINK, id), inkPromo.PromotionPermissionError);
  await assert.rejects(() => ad.excluirPromocao(LINK.id, id), inkPromo.PromotionPermissionError);
  assert.equal(ink.chamadas.length, 0);
  const semDeclaracao = adaptador(ink, { scopes: null });
  ink.falhas.post.push(403);
  await assert.rejects(() => semDeclaracao.criarPromocao({ ...LINK, codeNormalized: 'NOVO10', codeDisplay: 'novo10' }), (e) => e.codigo === 'INK_FORBIDDEN');
  assert.equal(ink.chamadas.filter((c) => c[0] === 'POST').length, 1);
});

// ── GET por código ─────────────────────────────────────────────────────────────────────────────
test('GET por código: encontra sem diferenciar maiúsculas, usa per_page=5 e não escreve nada', async () => {
  const ink = criarInkFalsa();
  ink.semear(promocaoCompativel({ code: 'amanda10' }));
  const r = await adaptador(ink).buscarPorCodigo('Amanda10');
  assert.equal(r.promocoes.length, 1);
  assert.deepEqual(ink.chamadas, [['GET', '/v1/stores/promotions?code=AMANDA10&per_page=5']]);
});

test('GET por código: não encontrado; envelope inesperado é ERRO (nunca "não achou"); resposta ausente também', async () => {
  const ink = criarInkFalsa();
  assert.equal((await adaptador(ink).verificarCupom(LINK)).status, 'not_found');
  for (const resposta of [{ data: [] }, {}, null, { promotions: 'x' }]) {
    const ad = adaptador(ink, { client: { get: async () => resposta } });
    await assert.rejects(() => ad.verificarCupom(LINK), (e) => e.codigo === 'INK_BAD_RESPONSE');
  }
  assert.equal((await inkPromo.createInkPromotionsAdapter({ client: null }).verificarCupom(LINK)).status, 'unavailable');
});

test('GET por código: mais de um resultado exato, ou total maior que a página, é ambíguo e não é escolhido ao acaso', async () => {
  const dupla = { get: async () => ({ promotions: [{ id: 1, code: 'AMANDA10' }, { id: 2, code: 'amanda10' }], total_count: 2, page: 1, per_page: 5, total_pages: 1 }) };
  assert.equal((await adaptador(criarInkFalsa(), { client: dupla }).verificarCupom(LINK)).status, 'ambiguous');
  const truncada = { get: async () => ({ promotions: [{ id: 1, code: 'OUTRO' }], total_count: 9, page: 1, per_page: 5, total_pages: 2 }) };
  assert.equal((await adaptador(criarInkFalsa(), { client: truncada }).verificarCupom(LINK)).status, 'ambiguous');
});

// ── GET por ID ─────────────────────────────────────────────────────────────────────────────────
test('GET por ID: sucesso devolve { promotion }; 404 vira ausência; outros erros sobem traduzidos', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  const ok = await adaptador(ink).buscarPorId(id);
  assert.equal(ok.promocao.code, 'AMANDA10');
  assert.equal(ink.chamadas[0][1], `/v1/stores/promotions/${id}`);
  assert.equal((await adaptador(ink).buscarPorId(99999)).promocao, null);
  ink.falhas.get.push(403);
  await assert.rejects(() => adaptador(ink).buscarPorId(id), (e) => e.codigo === 'INK_FORBIDDEN');
  await assert.rejects(() => adaptador(ink).buscarPorId('abc'), (e) => e.codigo === 'INK_INVALID_ID');
});

// ── Comparação Oria × INK ──────────────────────────────────────────────────────────────────────
test('verificação: promoção compatível é confirmada (discount string "10.0" da leitura × número do Oria)', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  const r = await adaptador(ink).verificarCupom(LINK);
  assert.equal(r.status, 'confirmed');
  assert.equal(r.promotionId, id);
  assert.equal(r.observada.discount, 10);
  assert.equal(r.observada.type, 'standard');
});

test('verificação: cada configuração divergente é apontada (e nada é confirmado)', async () => {
  const casos = [
    ['discount_tier', promocaoCompativel({ discount_tier: { discount: 25 } }), /valor do desconto/],
    ['kind', promocaoCompativel({ kind: 'value' }), /tipo de desconto/],
    ['trigger', promocaoCompativel({ discount_tier: { discount: 10, min_cart_value: 200 } }), /mínima no carrinho/],
    ['trigger', promocaoCompativel({ discount_tier: { discount: 10, min_cart_items: 5 } }), /mínima no carrinho/],
    ['list_type', promocaoCompativel({ list_type: 'products', product_ids: [7] }), /alcance/],
    ['first_purchase', promocaoCompativel({ first_purchase: true }), /primeira compra/],
    ['usage_limit', promocaoCompativel({ usage_limit: 10 }), /limite de usos/],
    ['apply_automatically', promocaoCompativel({ apply_automatically: true }), /aplicação automática/],
    ['show_on_product_page', promocaoCompativel({ show_on_product_page: true }), /página do produto/],
    ['show_in_cart', promocaoCompativel({ show_in_cart: true }), /carrinho/],
    ['expires_at', promocaoCompativel({ expires_at: '2026-12-31T00:00:00.000Z' }), /fim da vigência/],
    ['starts_at', promocaoCompativel({ starts_at: '2026-11-15T00:00:00.000Z' }), /início da vigência/],
  ];
  for (const [campo, corpo, msg] of casos) {
    const ink = criarInkFalsa();
    ink.semear(corpo);
    const r = await adaptador(ink).verificarCupom(LINK);
    assert.equal(r.status, 'divergent', campo);
    assert.ok(r.campos.includes(campo), `${campo}: ${r.campos}`);
    assert.match(r.divergencias.join(' | '), msg, campo);
  }
});

test('`available` é estado calculado pela INK: agendada no futuro não é divergência; expirada/indisponível é; nunca vai no PATCH', async () => {
  const futuro = criarInkFalsa();
  futuro.semear(promocaoCompativel({ starts_at: '2026-10-01T03:00:00.000Z' }));
  const link = { ...LINK, validFrom: new Date('2026-10-20T00:00:00Z') };
  const agendada = criarInkFalsa();
  agendada.semear(promocaoCompativel({ starts_at: '2026-10-20T00:00:00.000Z' }));
  assert.equal((await adaptador(agendada).verificarCupom(link)).status, 'confirmed');
  const limite = { get: async () => ({ promotions: [{ ...criarInkFalsa().leituras, id: 3, type: 'standard', code: 'AMANDA10', kind: 'percentage', available: false, apply_automatically: false, list_type: 'all', first_purchase: false, show_on_product_page: false, show_in_cart: false, usage_limit: null, starts_at: '2026-10-01T03:00:00.000Z', expires_at: null, discount_tiers: [{ discount: '10.0', min_cart_value: null, min_cart_items: null }], product_ids: [], product_type_ids: [], collection_ids: [] }], total_count: 1, page: 1, per_page: 5, total_pages: 1 }) };
  const r = await adaptador(criarInkFalsa(), { client: limite }).verificarCupom(LINK);
  assert.equal(r.status, 'divergent');
  assert.match(r.divergencias.join(' '), /indisponível agora/);
  const plano = inkPromo.montarAtualizacao(LINK, { ...(await limite.get()).promotions[0] }, AGORA);
  assert.deepEqual(plano.patch, {});
  assert.equal(plano.naoSincronizaveis.length, 1);
});

// ── POST standard ──────────────────────────────────────────────────────────────────────────────
test('criação: confere conflito por código, envia o payload do mapper com Idempotency-Key e confirma lendo por ID', async () => {
  const ink = criarInkFalsa();
  const r = await adaptador(ink).criarPromocao(LINK);
  assert.equal(r.promotionId, 101);
  assert.equal(r.confirmacao.status, 'confirmed');
  assert.equal(r.snapshot.type, 'standard');
  assert.equal(r.snapshot.discount, 10);
  const [metodos] = [ink.chamadas.map((c) => c[0])];
  assert.deepEqual(metodos, ['GET', 'POST', 'GET']);
  const post = ink.chamadas[1];
  assert.equal(post[1], '/v1/stores/promotions/standard');
  assert.deepEqual(post[2], inkPromo.montarPedidoDeCriacao(LINK).request.body);
  assert.equal(post[3]['Idempotency-Key'], r.idempotencyKey);
  assert.equal(ink.leituras().length, 1);
});

test('criação: código que já existe na INK não é sobrescrito nem duplicado', async () => {
  const ink = criarInkFalsa();
  ink.semear(promocaoCompativel({ code: 'amanda10' }));
  await assert.rejects(() => adaptador(ink).criarPromocao(LINK), inkPromo.PromotionConflictError);
  assert.equal(ink.escritas().length, 0);
});

test('criação: retry após resposta perdida reenvia a MESMA Idempotency-Key e não duplica a promoção', async () => {
  const ink = criarInkFalsa();
  ink.perderProximaRespostaDePost(1);
  const r = await adaptador(ink).criarPromocao(LINK);
  const posts = ink.chamadas.filter((c) => c[0] === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0][3]['Idempotency-Key'], posts[1][3]['Idempotency-Key']);
  assert.equal(ink.leituras().length, 1);
  assert.equal(r.promotionId, 101);
});

test('criação: erros da INK viram códigos estáveis, sem repetir 4xx e sem vazar token/cabeçalho', async () => {
  const esperados = [[401, 'INK_UNAUTHORIZED'], [403, 'INK_FORBIDDEN'], [409, 'INK_CONFLICT'], [422, 'INK_VALIDATION'], [429, 'INK_RATE_LIMITED'], [503, 'INK_UNAVAILABLE'], ['timeout', 'INK_TIMEOUT']];
  for (const [falha, codigo] of esperados) {
    const ink = criarInkFalsa();
    const persistente = ['timeout', 429, 503].includes(falha);
    ink.falhas.post.push(falha);
    if (persistente) ink.falhas.post.push(falha);
    await assert.rejects(() => adaptador(ink).criarPromocao(LINK), (e) => e.codigo === codigo && !/Bearer|Authorization/i.test(e.message), String(falha));
    assert.equal(ink.chamadas.filter((c) => c[0] === 'POST').length, persistente ? 2 : 1, `tentativas ${falha}`);
    assert.equal(ink.leituras().length, 0);
  }
  const vazador = { get: async () => ({ promotions: [] }), post: async () => { const e = new Error('Authorization: Bearer SEGREDO123'); e.status = 500; throw e; } };
  await assert.rejects(() => adaptador(criarInkFalsa(), { client: vazador }).criarPromocao(LINK), (e) => !/SEGREDO123/.test(e.message) && e.codigo === 'INK_UNAVAILABLE');
});

test('criação: 201 sem promoção válida é erro (não é sucesso); falha na leitura de volta não desfaz o ID criado', async () => {
  const semPromo = { get: async () => ({ promotions: [] }), post: async () => ({}) };
  await assert.rejects(() => adaptador(criarInkFalsa(), { client: semPromo }).criarPromocao(LINK), (e) => e.codigo === 'INK_BAD_RESPONSE');
  const ink = criarInkFalsa();
  const original = ink.client.get;
  let n = 0;
  const client = { ...ink.client, get: async (p) => { n += 1; if (n === 2) { const e = new Error('x'); e.status = 502; throw e; } return original(p); } };
  const r = await adaptador(ink, { client }).criarPromocao(LINK);
  assert.equal(r.promotionId, 101);
  assert.equal(r.confirmacao.status, 'unverified');
});

// ── PATCH standard ─────────────────────────────────────────────────────────────────────────────
test('atualização parcial: só o campo divergente, no endpoint standard, com chave estável por patch', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  const link = { ...LINK, discountBps: 1500, validUntil: new Date('2026-12-31T02:59:59Z') };
  const r = await adaptador(ink).atualizarPromocao(link, id);
  assert.equal(r.atualizado, true);
  assert.deepEqual(r.campos.sort(), ['discount_tier', 'expires_at']);
  const patch = ink.chamadas.find((c) => c[0] === 'PATCH');
  assert.equal(patch[1], `/v1/stores/promotions/standard/${id}`);
  assert.deepEqual(patch[2], { kind: 'percentage', discount_tier: { discount: 15 }, expires_at: '2026-12-31T02:59:59.000Z' });
  assert.equal(patch[3]['Idempotency-Key'], r.idempotencyKey);
  assert.doesNotMatch(JSON.stringify(patch[2]), /commission|comiss|level|nivel|benefit|saldo|cache/i);
  assert.equal(r.confirmacao.status, 'confirmed');
  assert.equal(ink.promocao(id).discount, 15);
});

test('atualização: sem diferença patchável não envia nada; código/gatilho divergentes são só reportados', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel({ discount_tier: { discount: 10, min_cart_value: 200 } }));
  const r = await adaptador(ink).atualizarPromocao(LINK, id);
  assert.equal(r.atualizado, false);
  assert.equal(r.naoSincronizaveis.length, 1);
  assert.equal(ink.escritas().length, 0);
});

test('atualização: falha da INK sobe erro e a promoção da INK continua como estava; promoção inexistente → 404 traduzido', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  ink.falhas.patch.push(422);
  await assert.rejects(() => adaptador(ink).atualizarPromocao({ ...LINK, discountBps: 1500 }, id), (e) => e.codigo === 'INK_VALIDATION');
  assert.equal(ink.promocao(id).discount, 10);
  await assert.rejects(() => adaptador(ink).atualizarPromocao(LINK, 4242), (e) => e.codigo === 'INK_NOT_FOUND');
});

test('atualização: retry da mesma intenção reenvia a mesma chave', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  ink.falhas.patch.push('timeout');
  await adaptador(ink).atualizarPromocao({ ...LINK, discountBps: 1500 }, id);
  const patches = ink.chamadas.filter((c) => c[0] === 'PATCH');
  assert.equal(patches.length, 2);
  assert.equal(patches[0][3]['Idempotency-Key'], patches[1][3]['Idempotency-Key']);
});

// ── DELETE ─────────────────────────────────────────────────────────────────────────────────────
test('exclusão: DELETE /promotions/{id} com Idempotency-Key estável; soft delete libera o código', async () => {
  const ink = criarInkFalsa();
  const id = ink.semear(promocaoCompativel());
  const r = await adaptador(ink).excluirPromocao(LINK.id, id);
  assert.deepEqual(ink.chamadas[0].slice(0, 2), ['DELETE', `/v1/stores/promotions/${id}`]);
  assert.equal(ink.chamadas[0][2]['Idempotency-Key'], `oria-aff-delete-link-1-${id}`);
  assert.equal(r.excluida, true);
  assert.equal(ink.leituras().length, 0);
  assert.equal((await adaptador(ink).verificarCupom(LINK)).status, 'not_found');
  // (vigência por dia: ver os dois testes ao final do arquivo)
  // mesma intenção (mesma chave) = replay idempotente; outra intenção sobre promoção já excluída = 404
  assert.equal((await adaptador(ink).excluirPromocao(LINK.id, id)).excluida, true);
  await assert.rejects(() => adaptador(ink).excluirPromocao('link-2', id), (e) => e.codigo === 'INK_NOT_FOUND');
});

// ── Vigência comparada por dia no fuso da loja (caso real: fim 10/10 no Oria × INK gravando o fim do dia em outro fuso) ──────────────
test('vigência: mesmo dia de fim no fuso da loja é compatível, ainda que a hora/fuso gravados pela INK difiram', async () => {
  const link = { ...LINK, validUntil: new Date('2026-10-11T02:59:59Z'), timezone: 'America/Sao_Paulo' }; // 10/10 23:59:59 -03:00 (o que o formulário do Oria grava)
  for (const expires_at of ['2026-10-10T23:59:59.000Z', '2026-10-11T02:59:59.000Z', '2026-10-10T03:00:00.000Z', '2026-10-10T00:00:00.000Z']) {
    const ink = criarInkFalsa();
    ink.semear(promocaoCompativel({ expires_at }));
    assert.equal((await adaptador(ink).verificarCupom(link)).status, 'confirmed', expires_at);
  }
});

test('vigência: INK terminando em dia posterior (ou sem fim), ou mais de 1 dia antes, diverge e a mensagem mostra as datas', async () => {
  const link = { ...LINK, validUntil: new Date('2026-10-11T02:59:59Z'), timezone: 'America/Sao_Paulo' };
  for (const [expires_at, msg] of [['2026-10-12T15:00:00.000Z', /INK 12\/10\/2026 × Oria 10\/10\/2026/], ['2026-10-08T23:59:59.000Z', /INK 08\/10\/2026 × Oria 10\/10\/2026/], [undefined, /a INK não tem fim e o Oria termina em 10\/10\/2026/]]) {
    const ink = criarInkFalsa();
    ink.semear(promocaoCompativel(expires_at ? { expires_at } : {}));
    const r = await adaptador(ink).verificarCupom(link);
    assert.equal(r.status, 'divergent', String(expires_at));
    assert.match(r.divergencias.join(' '), msg);
  }
});
