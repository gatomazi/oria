'use strict';

// Superfície HTTP do módulo de afiliados (lib/afiliados/routes.js), sem banco: papéis (owner × member), feature flag, campos
// desconhecidos, seletores de tenant e mapeamento de erros. O serviço é um dublê que REGISTRA chamadas — para provar que uma rota
// negada não chegou nem a tocar o serviço.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { createAfiliadosRouter, PERMITIDOS } = require('../lib/afiliados/routes');
const { erro } = require('../lib/afiliados/db');
const { camposDeAfiliadosDoPedido, camposDeAfiliadosDoItem } = require('../lib/ink/afiliados-campos');
const { financeiroItensPedidoInk } = require('../lib/ink/financeiro');

const UUID = '11111111-1111-4111-8111-111111111111';

function servicoDuble() {
  const chamadas = [];
  const registrar = (nome, retorno = {}) => async (...args) => { chamadas.push([nome, ...args]); return typeof retorno === 'function' ? retorno(...args) : retorno; };
  const s = {
    chamadas,
    inkPromotions: { capacidades: () => ({ provider: 'ink', read: true, create: false, update: false, delete: false }) },
    registry: {
      lerConfig: registrar('lerConfig', { timezone: 'America/Sao_Paulo' }), salvarConfig: registrar('salvarConfig'), lerRegrasDeNivel: registrar('lerRegras'), salvarRegrasDeNivel: registrar('salvarRegras'),
      criarParceiro: registrar('criarParceiro', { id: UUID }), atualizarParceiro: registrar('atualizarParceiro'), decidirCandidatura: registrar('decidirCandidatura'), mudarVinculo: registrar('mudarVinculo'),
      simularContrato: registrar('simularContrato'), criarContrato: registrar('criarContrato', { contract: {} }), novaVersaoDeContrato: registrar('novaVersaoDeContrato', {}),
      listarCupons: registrar('listarCupons', []), criarCupom: registrar('criarCupom', {}), ativarCupom: registrar('ativarCupom'), pausarCupom: registrar('pausarCupom'), retomarCupom: registrar('retomarCupom'),
      encerrarCupom: registrar('encerrarCupom'), verificarCupomNaInk: registrar('verificarCupomNaInk'), previsualizarCriacaoNaInk: registrar('previsualizar'),
      sincronizarCupomNaInk: registrar('sincronizarCupomNaInk'), excluirPromocaoNaInk: registrar('excluirPromocaoNaInk'),
      criarCupomNaInk: async () => { throw erro(409, 'INK_PROMOTION_WRITES_UNAVAILABLE', 'connector sem criação'); },
    },
    collabs: {
      listarCollabs: registrar('listarCollabs', []), criarCollab: registrar('criarCollab', {}), detalharCollab: registrar('detalharCollab'), atualizarCollab: registrar('atualizarCollab'),
      adicionarCriador: registrar('adicionarCriador'), encerrarCriador: registrar('encerrarCriador'), adicionarProdutos: registrar('adicionarProdutos'), descobrirPorCluster: registrar('descobrir'),
      aprovarProduto: registrar('aprovarProduto'), rejeitarProduto: registrar('rejeitarProduto'), removerProduto: registrar('removerProduto'), buscarProdutosDoCatalogo: registrar('buscar', []),
    },
    reconciliador: { resolverRevisao: registrar('resolverRevisao') },
    reconciliarTudo: registrar('reconciliarTudo'),
    diretorio: {
      listarParceiros: registrar('listarParceiros', { total: 1, itens: [{ id: UUID, balance: { releasedCents: 500 } }] }),
      perfilDoParceiro: registrar('perfil', { partner: {}, balance: { x: 1 }, payments: [{ id: 'p' }] }), listarVendas: registrar('vendas', { total: 0, itens: [] }), listarRevisoes: registrar('revisoes', []),
      visaoGeral: registrar('overview', () => ({ kpis: { payableCents: 1000, overdueCents: 5, validOrders: 3, forecastCommissionCents: 9 }, series: [{ date: 'x' }], upcoming: [{ a: 1 }] })),
    },
    progressao: {
      listarPropostas: registrar('propostas', []), gerarPropostas: registrar('gerarPropostas'), decidirProposta: registrar('decidirProposta'), definirNivelManual: registrar('definirNivelManual'),
      avaliarParceiro: registrar('avaliar'), listarBeneficios: registrar('beneficios'), concederPeca: registrar('concederPeca'), reverterBeneficio: registrar('reverterBeneficio'),
    },
    payables: {
      listarAPagar: registrar('listarAPagar'), resumoDeAPagar: registrar('resumo'), extratoDoParceiro: registrar('extrato'), previaDeFechamento: registrar('previa'), criarLote: registrar('criarLote'),
      listarLotes: registrar('listarLotes', []), aprovarLote: registrar('aprovarLote'), anularLote: registrar('anularLote'), registrarPagamento: registrar('registrarPagamento', { deduplicated: false }),
      listarPagamentos: registrar('listarPagamentos', []), estornarPagamento: registrar('estornarPagamento'), alterarVencimento: registrar('alterarVencimento'), lancarManual: registrar('lancarManual'),
      exportarCsv: registrar('exportarCsv', { csv: 'a,b\r\n', linhas: 0 }),
    },
    preview: {
      statusDoLink: registrar('statusDoLink', { ativo: false }), gerarLink: registrar('gerarLink', { token: 'x'.repeat(43), partnerName: 'x' }), revogarLink: registrar('revogarLink', { revogado: true }),
    },
  };
  return s;
}

async function subir({ papel = 'owner', habilitado = true, service = servicoDuble() } = {}) {
  const app = express();
  app.use(express.json());
  // Faz o papel de requireAdmin: tenant e autenticação vêm da SESSÃO (aqui simulada), nunca do request.
  app.use('/api/admin/afiliados', (req, res, next) => {
    req.tenant = Object.freeze({ organizationId: 'org-1', storeId: 'store-1', papel });
    req.auth = Object.freeze({ userId: 'user-1' });
    next();
  }, createAfiliadosRouter({ service, enabled: () => habilitado, logger: { error() {} } }));
  const server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
  const base = `http://127.0.0.1:${server.address().port}/api/admin/afiliados`;
  const chamar = async (metodo, caminho, corpo) => {
    const r = await fetch(`${base}${caminho}`, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    const texto = await r.text();
    let json = null; try { json = JSON.parse(texto); } catch { /* csv */ }
    return { status: r.status, json, texto, headers: r.headers };
  };
  return { service, chamar, fechar: () => new Promise((resolve) => server.close(resolve)) };
}

const ROTAS_SO_OWNER = [
  ['PUT', '/settings', {}], ['PUT', '/levels/rules', { regras: {}, motivo: 'x' }],
  ['POST', `/partners/${UUID}/application`, { decision: 'approved' }], ['POST', `/partners/${UUID}/relationship`, { status: 'active', reason: 'x' }],
  ['GET', `/partners/${UUID}/statement`], ['POST', `/partners/${UUID}/level`, { level: 'voz', reason: 'x' }], ['POST', `/partners/${UUID}/benefits/grant`, { productionCostCents: 1, description: 'x' }],
  ['POST', `/benefits/${UUID}/reverse`, { reason: 'x' }],
  ['POST', `/coupons/${UUID}/activate`, {}], ['POST', `/coupons/${UUID}/pause`, { reason: 'x' }], ['POST', `/coupons/${UUID}/resume`, { reason: 'x' }], ['POST', `/coupons/${UUID}/end`, { reason: 'x' }],
  ['POST', `/coupons/${UUID}/ink-create`, {}], ['POST', `/coupons/${UUID}/ink-sync`, {}], ['POST', `/coupons/${UUID}/ink-delete`, { reason: 'x' }],
  ['POST', `/collabs/${UUID}/creators`, { partnerId: UUID, contractId: UUID }], ['POST', `/collabs/${UUID}/creators/${UUID}/end`, { reason: 'x' }],
  ['POST', `/collabs/${UUID}/products`, { products: [] }], ['POST', `/collabs/${UUID}/products/discover`, {}], ['POST', `/collabs/${UUID}/products/${UUID}/approve`, {}],
  ['POST', `/collabs/${UUID}/products/${UUID}/reject`, { reason: 'x' }], ['POST', `/collabs/${UUID}/products/${UUID}/remove`, { reason: 'x' }],
  ['POST', `/reviews/${UUID}/resolve`, { decision: 'dismiss', reason: 'x' }], ['POST', '/reconcile', {}],
  ['POST', '/levels/evaluate', {}], ['POST', `/levels/proposals/${UUID}/decide`, { decision: 'approve' }],
  ['GET', '/payables'], ['GET', '/payables/summary'], ['GET', '/payables/export.csv'], ['POST', '/payouts/preview', { partnerId: UUID }], ['POST', '/payouts', { partnerId: UUID }], ['GET', '/payouts'],
  ['POST', `/payouts/${UUID}/approve`, {}], ['POST', `/payouts/${UUID}/void`, { reason: 'x' }], ['POST', '/payments', { partnerId: UUID }], ['GET', '/payments'],
  ['POST', `/payments/${UUID}/reverse`, { reason: 'x' }], ['POST', '/ledger/due-date', { ledgerIds: [UUID], dueAt: '2026-10-10', reason: 'x' }], ['POST', '/ledger/manual', { partnerId: UUID }],
  ['GET', `/partners/${UUID}/preview-link`], ['POST', `/partners/${UUID}/preview-link`, {}], ['POST', `/partners/${UUID}/preview-link/revoke`, {}],
];

test('feature flag desligada: tudo 404, exceto /status que diz enabled:false', async () => {
  const { chamar, fechar, service } = await subir({ habilitado: false });
  try {
    const st = await chamar('GET', '/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.enabled, false);
    assert.deepEqual(st.json.couponCreation, { provider: 'ink', read: true, create: false, update: false, delete: false });
    for (const [m, c, b] of [['GET', '/partners'], ['POST', '/partners', { publicName: 'x' }], ['GET', '/payables'], ['GET', '/overview']]) {
      const r = await chamar(m, c, b);
      assert.equal(r.status, 404, `${m} ${c}`);
      assert.equal(r.json.codigo, 'AFILIADOS_DESABILITADO');
    }
    assert.equal(service.chamadas.length, 0);
  } finally { await fechar(); }
});

test('member: TODA rota de dinheiro/aprovação responde 403 e o serviço nem é chamado (inclusive chamando o endpoint direto)', async () => {
  const { chamar, fechar, service } = await subir({ papel: 'member' });
  try {
    for (const [m, c, b] of ROTAS_SO_OWNER) {
      const r = await chamar(m, c, b);
      assert.equal(r.status, 403, `${m} ${c} → ${r.status}`);
      assert.equal(r.json.codigo, 'AFILIADOS_SEM_PERMISSAO');
    }
    assert.deepEqual(service.chamadas.filter(([n]) => !['lerConfig'].includes(n)), []);
  } finally { await fechar(); }
});

test('owner: as mesmas rotas chegam ao serviço', async () => {
  const { chamar, fechar, service } = await subir({ papel: 'owner' });
  try {
    for (const [m, c, b] of ROTAS_SO_OWNER) {
      if (c.includes('ink-create')) continue; // devolve 409 do adaptador (coberto abaixo)
      const r = await chamar(m, c, b);
      assert.ok(r.status < 400, `${m} ${c} → ${r.status} ${r.texto.slice(0, 120)}`);
    }
    assert.ok(service.chamadas.length >= ROTAS_SO_OWNER.length - 1);
  } finally { await fechar(); }
});

test('member cadastra e acompanha: parceiros, contratos em rascunho, cupom planejado, collab — mas não aprova direto', async () => {
  const { chamar, fechar } = await subir({ papel: 'member' });
  try {
    assert.equal((await chamar('POST', '/partners', { publicName: 'Ana' })).status, 201);
    assert.equal((await chamar('POST', '/partners', { publicName: 'Ana', approve: true })).status, 403); // aprovar direto é do owner
    assert.equal((await chamar('GET', '/partners')).status, 200);
    assert.equal((await chamar('POST', '/contracts', { partnerId: UUID, modality: 'coupon', title: 't', reason: 'r', terms: {} })).status, 201);
    assert.equal((await chamar('POST', '/coupons', { partnerId: UUID, contractId: UUID, code: 'ABC' })).status, 201);
    assert.equal((await chamar('POST', '/collabs', { name: 'c' })).status, 201);
    assert.equal((await chamar('PATCH', `/collabs/${UUID}`, { name: 'novo' })).status, 200);
    assert.equal((await chamar('PATCH', `/collabs/${UUID}`, { status: 'active' })).status, 403);
    assert.equal((await chamar('POST', '/coupons/x/verify')).status, 200);
  } finally { await fechar(); }
});

test('member vê a visão geral SEM dinheiro, a lista SEM saldo e o perfil SEM contas a pagar', async () => {
  const { chamar, fechar } = await subir({ papel: 'member' });
  try {
    const ov = await chamar('GET', '/overview');
    assert.equal(ov.json.kpis.payableCents, null);
    assert.equal(ov.json.kpis.overdueCents, null);
    assert.equal(ov.json.kpis.forecastCommissionCents, null);
    assert.equal(ov.json.kpis.validOrders, 3);
    assert.deepEqual(ov.json.series, []);
    assert.deepEqual(ov.json.upcoming, []);
    const lista = await chamar('GET', '/partners');
    assert.equal(lista.json.itens[0].balance, null);
    const perfil = await chamar('GET', `/partners/${UUID}`);
    assert.equal(perfil.json.balance, null);
    assert.deepEqual(perfil.json.payments, []);
  } finally { await fechar(); }
  const dono = await subir({ papel: 'owner' });
  try {
    assert.equal((await dono.chamar('GET', '/overview')).json.kpis.payableCents, 1000);
    assert.equal((await dono.chamar('GET', '/partners')).json.itens[0].balance.releasedCents, 500);
  } finally { await dono.fechar(); }
});

test('campos desconhecidos e seletores de tenant no corpo são rejeitados (400) antes de tocar o serviço', async () => {
  const { chamar, fechar, service } = await subir({ papel: 'owner' });
  try {
    for (const extra of [{ organizationId: 'outra' }, { storeId: 'outra' }, { organization_id: 'x' }, { qualquerCoisa: 1 }]) {
      const r = await chamar('POST', '/partners', { publicName: 'x', ...extra });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.json.codigo, 'AFILIADOS_CAMPO_DESCONHECIDO');
    }
    const r2 = await chamar('POST', '/payments', { partnerId: UUID, allocations: [], partner_id: UUID });
    assert.equal(r2.status, 400);
    assert.equal(service.chamadas.length, 0);
    const r3 = await chamar('POST', '/partners', [1, 2]);
    assert.equal(r3.status, 400);
  } finally { await fechar(); }
});

test('nenhuma rota lê organização/loja do request: o serviço recebe SEMPRE o tenant da sessão', async () => {
  const { chamar, fechar, service } = await subir({ papel: 'owner' });
  try {
    await chamar('GET', '/partners?organizationId=outra&storeId=outra');
    const [, ctx] = service.chamadas.find(([n]) => n === 'listarParceiros');
    assert.equal(ctx.organizationId, 'org-1');
    assert.equal(ctx.storeId, 'store-1');
    assert.equal(ctx.userId, 'user-1');
  } finally { await fechar(); }
});

test('criação remota de promoção indisponível no connector: 409 com código estável', async () => {
  const { chamar, fechar } = await subir({ papel: 'owner' });
  try {
    const r = await chamar('POST', `/coupons/${UUID}/ink-create`, {});
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'INK_PROMOTION_WRITES_UNAVAILABLE');
  } finally { await fechar(); }
});

test('erros: domínio vira status/código; erro inesperado vira 500 genérico sem vazar SQL', async () => {
  const service = servicoDuble();
  service.diretorio.listarParceiros = async () => { throw Object.assign(new Error('relation "partnership_partners" does not exist SELECT * FROM x WHERE organization_id = 42'), { code: '42P01' }); };
  service.diretorio.listarVendas = async () => { throw erro(404, 'AFILIADOS_NAO_ENCONTRADO', 'parceiro não encontrado'); };
  service.diretorio.listarRevisoes = async () => { throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }); };
  const { chamar, fechar } = await subir({ papel: 'owner', service });
  try {
    const a = await chamar('GET', '/partners');
    assert.equal(a.status, 500);
    assert.equal(a.json.codigo, 'AFILIADOS_ERRO_INTERNO');
    assert.doesNotMatch(a.texto, /partnership_partners|SELECT|organization_id/);
    const b = await chamar('GET', '/sales');
    assert.equal(b.status, 404);
    const c = await chamar('GET', '/reviews');
    assert.equal(c.status, 400);
  } finally { await fechar(); }
});

test('exportação CSV: cabeçalhos de download seguros e sem cache', async () => {
  const { chamar, fechar } = await subir({ papel: 'owner' });
  try {
    const r = await chamar('GET', '/payables/export.csv?dateType=due&from=2026-10-01&to=2026-10-31');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { await fechar(); }
});

test('toda rota declara os campos que aceita (sem campo aceito "por acidente")', () => {
  for (const [chave, campos] of Object.entries(PERMITIDOS)) {
    assert.ok(Array.isArray(campos), chave);
    assert.equal(new Set(campos).size, campos.length, `${chave}: campo repetido`);
    for (const proibido of ['organizationId', 'storeId', 'organization_id', 'store_id']) assert.ok(!campos.includes(proibido), `${chave} aceita ${proibido}`);
  }
});

// ── Campos novos gravados pelo upsert de pedido/itens da INK ─────────────────────────────────────
test('campos do pedido: cupom, descontos e entrega saem do payload completo; evento parcial não afirma nada', () => {
  const agora = new Date('2026-09-10T12:00:00Z');
  const completo = camposDeAfiliadosDoPedido({
    items: [], promotion_code: ' AMANDA10 ', promotion_value: '20.00', payment_discount_value: '5.00', freight_value_difference: '0.00', kickback_value: '30.00',
    delivery: { delivered_at: '2026-09-12T10:00:00Z' },
  }, agora);
  assert.deepEqual(completo, ['AMANDA10', '20.00', '5.00', '0.00', '30.00', '2026-09-12T10:00:00.000Z', agora.toISOString()]);
  const parcial = camposDeAfiliadosDoPedido({ id: 1, payment_status: 'paid' }, agora);
  assert.deepEqual(parcial, [null, null, null, null, null, null, null]);
  assert.equal(camposDeAfiliadosDoPedido({ items: [], promotion_code: '' }, agora)[0], null);
  assert.equal(camposDeAfiliadosDoPedido({ items: [], promotion_code: 'x'.repeat(200) }, agora)[0], null);
  assert.equal(camposDeAfiliadosDoPedido({ items: [], promotion_value: 'abc' }, agora)[1], null);
});

test('campos do item: devolvidas, gratuitas, custo base e ids; financeiroItensPedidoInk os repassa sem mudar a conta', () => {
  const order = {
    total_value: '190.00', shipping_value: '0', promotion_value: '10.00', payment_discount_value: '0', kickback_value: '60.00',
    items: [{
      id: 7, quantity: 2, unit_value: '100.00', total_value: '200.00', sku: 'S1', refunded_quantity: 1, free_quantity: 0, unit_ink_base_price: '60.00', unit_additional_service_price: '2.50',
      product_v2: { id: 111, name: 'Praia', product_cluster_id: 77 }, product_variant: { id: 9, model: 'tradicional' },
    }],
  };
  const [item] = financeiroItensPedidoInk(order);
  assert.equal(item.quantidadeDevolvida, 1);
  assert.equal(item.custoBaseUnitario, '60.00');
  assert.equal(item.servicoAdicionalUnitario, '2.50');
  assert.equal(item.varianteId, 9);
  assert.equal(item.clusterId, 77);
  assert.equal(item.valorUnitario, '100.00');
  assert.equal(item.venda, 200);
  assert.equal(item.produtoId, 111);
  const extras = camposDeAfiliadosDoItem({ unit_value: 'lixo', refunded_quantity: 'x' });
  assert.equal(extras.valorUnitario, null);
  assert.equal(extras.quantidadeDevolvida, 0);
});
