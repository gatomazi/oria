'use strict';

// Parcerias, Afiliados e Collabs · integração contra Postgres REAL, sob a role da aplicação (oria_app, RLS forçada) e a fachada de
// tenant. Cobre: fluxo completo (cadastro → contrato → cupom/collab → pedido misto → atribuição → ledger → contas a pagar → pagamento
// parcial/estorno), idempotência e concorrência, devolução/cancelamento/chargeback, contrato retroativo, isolamento entre dois
// workspaces (IDOR), imutabilidade dos históricos e fail-closed nos dados ambíguos. Nada sai para a rede.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const h = require('./harness');
const { sqlProvisionarAppRole } = h.sujeito('lib/platform/app-role.js');
const manifesto = h.sujeito('lib/platform/tenancy-manifest.js');
const runtime = h.sujeito('lib/platform/tenant-runtime.js');
const { criarAfiliados } = h.sujeito('lib/afiliados/index.js');

const ORG_A = 'af000000-0000-4000-8000-00000000000a';
const ORG_B = 'af000000-0000-4000-8000-00000000000b';
const STORE_A = 'af1a0000-0000-4000-8000-0000000000a1';
const STORE_B = 'af1b0000-0000-4000-8000-0000000000b1';
const USER_A = 'af2a0000-0000-4000-8000-0000000000a1';
const USER_B = 'af2b0000-0000-4000-8000-0000000000b1';
const ROLE = `oria_app_afil_${crypto.randomBytes(4).toString('hex')}`;
const SENHA = crypto.randomBytes(16).toString('hex');

const ctxA = { organizationId: ORG_A, storeId: STORE_A, userId: USER_A };
const ctxB = { organizationId: ORG_B, storeId: STORE_B, userId: USER_B };

let db;
let sup;
let appPoolReal;
let svc;
let agora = new Date('2026-09-01T12:00:00Z');
const relogio = () => new Date(agora);
const definirAgora = (iso) => { agora = new Date(iso); };

const em = (ctx, fn) => runtime.comContexto({ organizationId: ctx.organizationId, storeId: ctx.storeId, origem: 'teste' }, fn);
const emA = (fn) => em(ctxA, fn);
const emB = (fn) => em(ctxB, fn);
const pool = () => runtime.criarPoolTenant(appPoolReal);

test.before(async () => {
  db = await h.criarBancoDescartavel('oria_afil');
  const r = h.migrar(db.url);
  assert.equal(r.status, 0, `${r.stdout.slice(-2000)}${r.stderr}`);
  sup = h.abrirPoolDescartavel(db.url, { max: 4 });
  for (const sql of sqlProvisionarAppRole({ role: ROLE, senha: SENHA, tabelasSobRls: manifesto.nomesSobRls() })) await sup.query(sql);
  appPoolReal = h.abrirPoolDescartavel(h.urlComUsuario(db.url, ROLE, SENHA), { max: 12 });
  for (const [org, store, nome] of [[ORG_A, STORE_A, 'Org A'], [ORG_B, STORE_B, 'Org B']]) {
    await sup.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [org, nome]);
    await sup.query('INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)', [store, org, nome]);
  }
  svc = criarAfiliados({ pool: pool(), relogio, flags: { inkPromotionWritesEnabled: false } });
});

test.after(async () => {
  await appPoolReal?.end();
  if (sup) {
    await sup.query(`DROP OWNED BY ${ROLE}`).catch(() => {});
    await sup.end();
  }
  await db?.destruir();
  const admin = h.abrirPoolDescartavel(h.urlDoBanco(), { max: 1 });
  try { await admin.query(`DROP ROLE IF EXISTS ${ROLE}`); } finally { await admin.end(); }
});

// ── Semeadura de pedidos (cache já sincronizado da INK, com os campos novos) ─────────────────────
let proximoItem = 100;
async function semearPedido(ctx, { id, pagamento = 'paid', situacao = 'paid', criadoEm, entregueEm = null, cupom = null, promocao = '0', descontoPgto = '0', troca = false, completo = true, itens }) {
  await sup.query(
    `INSERT INTO pedidos_ink (organization_id, store_id, ink_order_id, payment_status, order_status, total_value, criado_em, is_troca, promotion_code, promotion_value, payment_discount_value, delivered_at, affiliate_snapshot_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [ctx.organizationId, ctx.storeId, id, pagamento, situacao, '200', criadoEm, troca, cupom, promocao, descontoPgto, entregueEm, completo ? new Date(criadoEm) : null]
  );
  for (const it of itens) {
    proximoItem += 1;
    await sup.query(
      `INSERT INTO pedidos_ink_itens (organization_id, store_id, ink_order_id, item_id, produto_id, produto_nome, sku, quantidade, valor_venda, desconto_rateado, custo_producao, lucro_operacional,
         unit_value, refunded_quantity, free_quantity, unit_ink_base_price, unit_additional_service_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,0,$11,$12,$13,$14,$15)`,
      [ctx.organizationId, ctx.storeId, id, it.itemId ?? proximoItem, it.produtoId, it.nome ?? `Produto ${it.produtoId}`, it.sku ?? null, it.qtd ?? 1, it.total ?? '100.00', it.custoTotal ?? '60',
        it.unitario ?? '100.00', it.devolvidas ?? 0, it.gratis ?? 0, it.custoBase === undefined ? '60.00' : it.custoBase, it.servico ?? '0']
    );
  }
}

async function contar(sql, params = []) {
  return (await sup.query(sql, params)).rows[0].n;
}

const ledgerDe = async (partnerId) => (await sup.query(
  `SELECT * FROM partner_commission_ledger WHERE organization_id = $1 AND partner_id = $2 ORDER BY created_at, id`, [ORG_A, partnerId]
)).rows;

// ── Cenário-base (compartilhado, sequencial) ─────────────────────────────────────────────────────
const cen = {};

test('cadastro: parceiros, contratos versionados, cupom manual e collab com produto isolado', async () => {
  await emA(async () => {
    cen.p1 = await svc.registry.criarParceiro(ctxA, { publicName: 'Amanda Criadora', contactEmail: 'amanda@exemplo.com', profiles: [{ network: 'instagram', handle: '@amanda' }] }, { aprovarDireto: true });
    cen.p2 = await svc.registry.criarParceiro(ctxA, { publicName: 'Bruno Cupom' }, { aprovarDireto: true });
    assert.equal(cen.p1.applicationStatus, 'approved');
    assert.equal(cen.p1.relationshipStatus, 'draft');

    // 20% de margem excede o teto de 15% do nível Raiz: exige o motivo do override (e nunca passa em silêncio).
    await assert.rejects(svc.registry.criarContrato(ctxA, {
      partnerId: cen.p1.id, modality: 'collab', title: 'Collab Amanda', status: 'active', reason: 'acordo comercial',
      terms: { commissionBasis: 'verified_margin_percent', commissionBps: 2000 },
    }, { podeAtivar: true }), (e) => e.codigo === 'AFILIADOS_ACIMA_DO_TETO');
    const k1 = await svc.registry.criarContrato(ctxA, {
      partnerId: cen.p1.id, modality: 'collab', title: 'Collab Amanda', status: 'active', reason: 'acordo comercial',
      terms: { commissionBasis: 'verified_margin_percent', commissionBps: 2000, levelCapOverrideReason: 'negociado com o time comercial' },
    }, { podeAtivar: true });
    cen.k1 = k1.contract.id; cen.k1v1 = k1.version.id;
    const k2 = await svc.registry.criarContrato(ctxA, {
      partnerId: cen.p2.id, modality: 'coupon', title: 'Cupom Bruno', status: 'active', reason: 'programa de cupons',
      terms: { commissionBasis: 'verified_margin_percent', commissionBps: 1500 },
    }, { podeAtivar: true });
    cen.k2 = k2.contract.id;
    assert.equal(k2.teto.dentroDoTeto, true);

    cen.collab = await svc.collabs.criarCollab(ctxA, { name: 'Praia do Rosa', collectionUrl: 'https://loja.exemplo.com/praia' });
    await svc.collabs.adicionarCriador(ctxA, cen.collab.id, { partnerId: cen.p1.id, contractId: cen.k1, shareBps: 10000 });
    const add = await svc.collabs.adicionarProdutos(ctxA, cen.collab.id, { products: [{ inkProductId: '111', productName: 'Camiseta Praia' }] });
    assert.equal(add.adicionados.length, 1);

    const cupom = await svc.registry.criarCupom(ctxA, { partnerId: cen.p2.id, contractId: cen.k2, code: 'Bruno10', discountKind: 'percentage', discountBps: 1000 });
    assert.equal(cupom.codeNormalized, 'BRUNO10');
    assert.equal(cupom.syncStatus, 'manual_unverified');
    assert.equal(cupom.status, 'pending_validation');
    cen.cupom = await svc.registry.ativarCupom(ctxA, cupom.id);
    assert.equal(cen.cupom.status, 'active');
  });
  assert.equal(await contar(`SELECT count(*)::int AS n FROM partnership_audit_events WHERE organization_id = $1`, [ORG_A]) >= 8, true);
});

test('cupom: sobreposição de vigência do MESMO código é recusada; outro código na mesma loja segue livre', async () => {
  await emA(async () => {
    await assert.rejects(svc.registry.criarCupom(ctxA, { partnerId: cen.p2.id, contractId: cen.k2, code: 'BRUNO10', discountKind: 'percentage', discountBps: 500 }), (e) => e.codigo === 'AFILIADOS_CUPOM_SOBREPOSTO');
    const outro = await svc.registry.criarCupom(ctxA, { partnerId: cen.p2.id, contractId: cen.k2, code: 'BRUNO20', discountKind: 'percentage', discountBps: 2000 });
    assert.equal(outro.status, 'pending_validation');
  });
});

test('pedido misto: cada modalidade paga na linha certa, sem duplicar, e o ledger fecha em R$ 10,50', async () => {
  definirAgora('2026-09-10T15:00:00Z');
  // Cupom ativado em 01/09 (antes do pedido). Pedido de 10/09, entregue em 12/09.
  await semearPedido(ctxA, {
    id: 5001, criadoEm: '2026-09-10T15:00:00Z', entregueEm: '2026-09-12T15:00:00Z', cupom: ' bruno10 ', promocao: '20.00',
    itens: [{ produtoId: 111, total: '100.00' }, { produtoId: 222, total: '100.00' }],
  });
  definirAgora('2026-10-20T12:00:00Z');
  const r = await emA(() => svc.reconciliarTudo(ctxA));
  assert.equal(r.atribuicoes, 2);
  const l1 = await ledgerDe(cen.p1.id);
  const l2 = await ledgerDe(cen.p2.id);
  assert.equal(l1.length, 1);
  assert.equal(Number(l1[0].amount_cents), 600);
  assert.equal(Number(l2[0].amount_cents), 450);
  assert.equal(Number(l1[0].amount_cents) + Number(l2[0].amount_cents), 1050);
  // Nenhum crédito de cupom sobre o item da collab (R$ 4,50 extra) e nenhum de collab sobre o item comum.
  assert.equal(await contar(`SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5001`, [ORG_A]), 2);
  // Datas: entrega 12/09 + 7d = 19/09 liberada; vence dia 10 do mês seguinte (10/10 é sábado → segunda 12/10).
  assert.equal(l1[0].status, 'released');
  assert.equal(new Date(l1[0].release_at).toISOString(), '2026-09-19T15:00:00.000Z');
  assert.equal(new Date(l1[0].due_at).toISOString(), '2026-10-12T03:00:00.000Z');
  assert.equal(l1[0].competence.toISOString().slice(0, 10), '2026-09-01');
  cen.led1 = l1[0]; cen.led2 = l2[0];
});

test('idempotência: reprocessar o mesmo pedido (inclusive em paralelo) não cria crédito duplicado', async () => {
  const antes = await contar('SELECT count(*)::int AS n FROM partner_commission_ledger WHERE organization_id = $1', [ORG_A]);
  await emA(() => svc.reconciliador.reconciliar(ctxA, { pedidos: ['5001'] }));
  await emA(() => Promise.all([
    svc.reconciliador.reconciliar(ctxA, { pedidos: ['5001'] }),
    svc.reconciliador.reconciliar(ctxA, { pedidos: ['5001'] }),
    svc.reconciliador.reconciliar(ctxA, { completo: true }),
  ]));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partner_commission_ledger WHERE organization_id = $1', [ORG_A]), antes);
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1', [ORG_A]), 2);
});

test('contas a pagar: vencido considera só saldo liberado após o vencimento; previsto não entra na dívida', async () => {
  const resumo = await emA(() => svc.payables.resumoDeAPagar(ctxA));
  assert.equal(resumo.overdueCents, 1050);
  assert.equal(resumo.availableCents, 1050);
  assert.equal(resumo.forecastCents, 0);
  const lista = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'due', from: '2026-10-01', to: '2026-10-31' }));
  assert.equal(lista.total, 2);
  const amanda = lista.itens.find((i) => i.partnerName === 'Amanda Criadora');
  assert.equal(amanda.status, 'vencido');
  assert.equal(amanda.daysOverdue, 8);
  assert.equal(amanda.openCents, 600);
  assert.equal(amanda.orderCount, 1);
  assert.equal(amanda.units, 1);
  assert.equal(amanda.baseCents, 9000);
  // Filtro por data de pagamento: ninguém pagou ainda.
  const pagos = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'paid', from: '2026-09-01', to: '2026-10-31' }));
  assert.equal(pagos.total, 0);
  // Filtro por modalidade e por collab.
  const soCupom = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'due', from: '2026-10-01', to: '2026-10-31', modality: 'coupon' }));
  assert.deepEqual(soCupom.itens.map((i) => i.partnerName), ['Bruno Cupom']);
  const soCollab = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'due', from: '2026-10-01', to: '2026-10-31', collabId: cen.collab.id }));
  assert.deepEqual(soCollab.itens.map((i) => i.partnerName), ['Amanda Criadora']);
});

test('lote de R$ 6,00 com pagamento de R$ 2,40 fica parcial (saldo R$ 3,60); a 2ª parcela quita; a 3ª e a concorrente não passam do saldo', async () => {
  // Saldo abaixo do mínimo de R$ 50 acumula: o lote só sai com confirmação explícita.
  const previa = await emA(() => svc.payables.previaDeFechamento(ctxA, { partnerId: cen.p1.id }));
  assert.equal(previa.situacao, 'abaixo_do_minimo');
  await assert.rejects(emA(() => svc.payables.criarLote(ctxA, { partnerId: cen.p1.id })), (e) => e.codigo === 'AFILIADOS_ABAIXO_DO_MINIMO');
  const lote = await emA(() => svc.payables.criarLote(ctxA, { partnerId: cen.p1.id, abaixoDoMinimo: true }));
  assert.equal(lote.proposedCents, 600);
  await assert.rejects(emA(() => svc.payables.registrarPagamento(ctxA, {
    partnerId: cen.p1.id, batchId: lote.id, idempotencyKey: 'k-rascunho', method: 'pix', paidAt: '2026-10-13T12:00:00Z', allocations: [{ ledgerId: cen.led1.id, amountCents: 240 }],
  })), (e) => e.codigo === 'AFILIADOS_LOTE_NAO_APROVADO');
  await emA(() => svc.payables.aprovarLote(ctxA, lote.id));

  const pg1 = await emA(() => svc.payables.registrarPagamento(ctxA, {
    partnerId: cen.p1.id, batchId: lote.id, idempotencyKey: 'k-1', method: 'pix', paidAt: '2026-10-13T12:00:00Z', externalReference: 'E2E-001', allocations: [{ ledgerId: cen.led1.id, amountCents: 240 }],
  }));
  assert.equal(pg1.amountCents, 240);
  assert.equal(pg1.recibo.saldoRestanteLiberadoCents, 360);
  cen.pg1 = pg1;
  let lotes = await emA(() => svc.payables.listarLotes(ctxA, { partnerId: cen.p1.id }));
  assert.equal(lotes[0].financialStatus, 'overdue'); // 12/10 já passou e o saldo residual continua vencido
  assert.equal(lotes[0].paidCents, 240);
  const parcial = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'due', from: '2026-10-01', to: '2026-10-31', partnerId: cen.p1.id }));
  assert.equal(parcial.itens[0].openCents, 360);
  assert.equal(parcial.itens[0].paidCents, 240);
  assert.equal(parcial.itens[0].status, 'vencido');

  // Reenvio com a mesma chave não paga de novo (idempotência); a mesma referência externa também é recusada.
  const repetido = await emA(() => svc.payables.registrarPagamento(ctxA, {
    partnerId: cen.p1.id, batchId: lote.id, idempotencyKey: 'k-1', method: 'pix', paidAt: '2026-10-13T12:00:00Z', externalReference: 'E2E-001', allocations: [{ ledgerId: cen.led1.id, amountCents: 240 }],
  }));
  assert.equal(repetido.deduplicated, true);
  await assert.rejects(emA(() => svc.payables.registrarPagamento(ctxA, {
    partnerId: cen.p1.id, idempotencyKey: 'k-dup-ref', method: 'pix', paidAt: '2026-10-13T12:00:00Z', externalReference: 'E2E-001', allocations: [{ ledgerId: cen.led1.id, amountCents: 10 }],
  })), (e) => e.codigo === 'AFILIADOS_PAGAMENTO_DUPLICADO');

  // Concorrência: duas quitações simultâneas de R$ 3,60; só uma vence.
  const tentativas = await emA(() => Promise.allSettled([
    svc.payables.registrarPagamento(ctxA, { partnerId: cen.p1.id, batchId: lote.id, idempotencyKey: 'k-c1', method: 'pix', paidAt: '2026-10-14T12:00:00Z', allocations: [{ ledgerId: cen.led1.id, amountCents: 360 }] }),
    svc.payables.registrarPagamento(ctxA, { partnerId: cen.p1.id, batchId: lote.id, idempotencyKey: 'k-c2', method: 'pix', paidAt: '2026-10-14T12:00:00Z', allocations: [{ ledgerId: cen.led1.id, amountCents: 360 }] }),
  ]));
  assert.equal(tentativas.filter((t) => t.status === 'fulfilled').length, 1);
  assert.equal(tentativas.filter((t) => t.status === 'rejected').length, 1);
  assert.equal(tentativas.find((t) => t.status === 'rejected').reason.codigo, 'AFILIADOS_PAGAMENTO_EXCEDE_SALDO');
  cen.pg2 = tentativas.find((t) => t.status === 'fulfilled').value;

  // Terceira tentativa: nada mais a pagar.
  await assert.rejects(emA(() => svc.payables.registrarPagamento(ctxA, {
    partnerId: cen.p1.id, idempotencyKey: 'k-3', method: 'pix', paidAt: '2026-10-15T12:00:00Z', allocations: [{ ledgerId: cen.led1.id, amountCents: 1 }],
  })), (e) => e.codigo === 'AFILIADOS_PAGAMENTO_EXCEDE_SALDO');
  lotes = await emA(() => svc.payables.listarLotes(ctxA, { partnerId: cen.p1.id }));
  assert.equal(lotes[0].financialStatus, 'paid');
  const quitado = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'due', from: '2026-10-01', to: '2026-10-31', partnerId: cen.p1.id }));
  assert.equal(quitado.itens[0].status, 'quitado');
  assert.equal(quitado.itens[0].openCents, 0);
});

test('"pago no período" usa a data EFETIVA do pagamento, não a do pedido nem a de registro', async () => {
  // Os dois pagamentos têm paid_at em outubro, registrados agora (recorded_at). Setembro não tem nada pago.
  const set = await emA(() => svc.payables.resumoDeAPagar(ctxA, { from: '2026-09-01', to: '2026-09-30' }));
  assert.equal(set.paidInPeriodCents, 0);
  const out = await emA(() => svc.payables.resumoDeAPagar(ctxA, { from: '2026-10-01', to: '2026-10-31' }));
  assert.equal(out.paidInPeriodCents, 600);
  const so13 = await emA(() => svc.payables.resumoDeAPagar(ctxA, { from: '2026-10-13', to: '2026-10-13' }));
  assert.equal(so13.paidInPeriodCents, 240);
  const porPagamento = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'paid', from: '2026-10-13', to: '2026-10-13' }));
  assert.equal(porPagamento.total, 1);
  assert.equal(porPagamento.itens[0].paidInPeriodCents, 240);
  const visao = await emA(() => svc.diretorio.visaoGeral(ctxA, { from: '2026-10-01', to: '2026-10-31', dateType: 'paid' }));
  assert.equal(visao.kpis.paidInPeriodCents, 600);
  assert.equal(visao.period.criterio, 'data efetiva do pagamento');
});

test('estorno de pagamento: contralançamento auditável; o registro original continua visível e o saldo volta', async () => {
  const est = await emA(() => svc.payables.estornarPagamento(ctxA, cen.pg2.id, { motivo: 'Pix devolvido pelo banco' }));
  assert.equal(est.kind, 'reversal');
  assert.equal(est.reversesPaymentId, cen.pg2.id);
  await assert.rejects(emA(() => svc.payables.estornarPagamento(ctxA, cen.pg2.id, { motivo: 'de novo' })), (e) => e.codigo === 'AFILIADOS_PAGAMENTO_JA_ESTORNADO');
  const pagamentos = await emA(() => svc.payables.listarPagamentos(ctxA, { partnerId: cen.p1.id }));
  assert.equal(pagamentos.filter((p) => p.kind === 'payment').length, 2);
  assert.equal(pagamentos.find((p) => p.id === cen.pg2.id).reversed, true);
  const extrato = await emA(() => svc.payables.extratoDoParceiro(ctxA, cen.p1.id));
  assert.equal(extrato.totais.releasedBalanceCents, 360);
  assert.equal(extrato.totais.paidCents, 240);
  const auditoria = await contar(`SELECT count(*)::int AS n FROM partnership_audit_events WHERE organization_id = $1 AND action = 'payment.reverse' AND reason = 'Pix devolvido pelo banco'`, [ORG_A]);
  assert.equal(auditoria, 1);
  // O histórico é append-only: nem o superusuário edita/apaga um pagamento pelo caminho normal.
  await assert.rejects(sup.query('UPDATE partner_payment_records SET amount_cents = 1 WHERE id = $1', [cen.pg2.id]), /append-only/);
  await assert.rejects(sup.query('DELETE FROM partner_payment_records WHERE id = $1', [cen.pg2.id]), /append-only|violates foreign key/);
});

test('devolução parcial DEPOIS do pagamento parcial: ajuste compensatório, nada de pago é alterado', async () => {
  // Pedido de 2 unidades da collab, 1 devolvida depois.
  definirAgora('2026-09-10T15:00:00Z');
  await semearPedido(ctxA, { id: 5002, criadoEm: '2026-09-11T15:00:00Z', entregueEm: '2026-09-13T15:00:00Z', itens: [{ itemId: 9001, produtoId: 111, qtd: 2, total: '200.00', custoBase: '60.00' }] });
  definirAgora('2026-10-20T12:00:00Z');
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5002'] }));
  const antes = (await ledgerDe(cen.p1.id)).filter((l) => l.attribution_id && Number(l.amount_cents) === 1600);
  assert.equal(antes.length, 1); // 20% de (200 − 120) = 16,00
  await sup.query('UPDATE pedidos_ink_itens SET refunded_quantity = 1 WHERE organization_id = $1 AND item_id = 9001', [ORG_A]);
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5002'] }));
  const depois = (await ledgerDe(cen.p1.id)).filter((l) => l.attribution_id === antes[0].attribution_id);
  assert.deepEqual(depois.map((l) => [l.entry_type, Number(l.amount_cents)]), [['accrual', 1600], ['adjustment', -800]]);
  assert.equal(await contar('SELECT count(*)::int AS n FROM partner_commission_ledger WHERE attribution_id = $1', [antes[0].attribution_id]), 2);
  // Reprocessar o mesmo estado não cria terceiro lançamento.
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5002'] }));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partner_commission_ledger WHERE attribution_id = $1', [antes[0].attribution_id]), 2);
  const snap = (await sup.query('SELECT snapshot, current_state FROM partnership_attributions WHERE id = $1', [antes[0].attribution_id])).rows[0];
  assert.equal(snap.snapshot.qtdPaga, 2);
  assert.equal(snap.current_state.eligibleQty, 1);
});

test('chargeback/reembolso total antes de qualquer pagamento anula os lançamentos sem apagar o histórico', async () => {
  await semearPedido(ctxA, { id: 5003, criadoEm: '2026-09-12T15:00:00Z', entregueEm: '2026-09-14T15:00:00Z', itens: [{ itemId: 9002, produtoId: 111, total: '100.00' }] });
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5003'] }));
  const attr = (await sup.query('SELECT id FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5003', [ORG_A])).rows[0].id;
  assert.equal(await contar('SELECT count(*)::int AS n FROM partner_commission_ledger WHERE attribution_id = $1', [attr]), 1);
  await sup.query(`UPDATE pedidos_ink SET payment_status = 'chargeback' WHERE organization_id = $1 AND ink_order_id = 5003`, [ORG_A]);
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5003'] }));
  const lancs = (await sup.query('SELECT entry_type, amount_cents, status FROM partner_commission_ledger WHERE attribution_id = $1 ORDER BY created_at, id', [attr])).rows;
  assert.deepEqual(lancs.map((l) => [l.entry_type, Number(l.amount_cents), l.status]), [['accrual', 800, 'reversed'], ['adjustment', -800, 'reversed']]);
  // Um evento ANTIGO (estado corrente ainda é chargeback) não reabre comissão: reprocessar é no-op.
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5003'] }));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partner_commission_ledger WHERE attribution_id = $1', [attr]), 2);
  const extrato = await emA(() => svc.payables.extratoDoParceiro(ctxA, cen.p1.id));
  assert.ok(extrato.itens.every((i) => i.openCents === 0 || i.status !== 'reversed'));
});

test('chargeback DEPOIS de paga: vira ajuste a compensar (débito), nunca altera o Pix registrado', async () => {
  // Pedido 5004 liberado e pago integralmente; depois estorno.
  await semearPedido(ctxA, { id: 5004, criadoEm: '2026-09-05T15:00:00Z', entregueEm: '2026-09-06T15:00:00Z', itens: [{ itemId: 9003, produtoId: 111, total: '100.00' }] });
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5004'] }));
  const attr = (await sup.query('SELECT id FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5004', [ORG_A])).rows[0].id;
  const accrual = (await sup.query('SELECT * FROM partner_commission_ledger WHERE attribution_id = $1', [attr])).rows[0];
  assert.equal(accrual.status, 'released');
  const pg = await emA(() => svc.payables.registrarPagamento(ctxA, {
    partnerId: cen.p1.id, idempotencyKey: 'k-cb', method: 'transfer', paidAt: '2026-10-19T12:00:00Z', allocations: [{ ledgerId: accrual.id, amountCents: 800 }],
  }));
  await sup.query(`UPDATE pedidos_ink SET payment_status = 'chargeback' WHERE organization_id = $1 AND ink_order_id = 5004`, [ORG_A]);
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5004'] }));
  const lancs = (await sup.query('SELECT id, entry_type, amount_cents, status FROM partner_commission_ledger WHERE attribution_id = $1 ORDER BY created_at, id', [attr])).rows;
  assert.deepEqual(lancs.map((l) => [l.entry_type, Number(l.amount_cents), l.status]), [['accrual', 800, 'released'], ['adjustment', -800, 'released']]);
  assert.equal(Number((await sup.query('SELECT amount_cents FROM partner_payment_records WHERE id = $1', [pg.id])).rows[0].amount_cents), 800);
  const extrato = await emA(() => svc.payables.extratoDoParceiro(ctxA, cen.p1.id));
  // Débitos liberados em aberto: -8,00 do chargeback do 5004 + -8,00 da devolução parcial do 5002 (ainda não compensada).
  assert.equal(extrato.totais.adjustmentToOffsetCents, -1600);
  // Um novo pagamento só sai líquido: o débito é compensado junto de outro crédito, nunca sozinho.
  await assert.rejects(emA(() => svc.payables.registrarPagamento(ctxA, {
    partnerId: cen.p1.id, idempotencyKey: 'k-so-debito', method: 'pix', paidAt: '2026-10-19T12:00:00Z', allocations: [{ ledgerId: lancs[1].id, amountCents: -800 }],
  })), (e) => e.codigo === 'AFILIADOS_ENTRADA_INVALIDA');
  cen.debito = lancs[1].id;
});

test('mudança de contrato hoje não altera comissões de pedidos de ontem', async () => {
  const antes = (await ledgerDe(cen.p1.id)).map((l) => [l.id, Number(l.amount_cents)]);
  const v = await emA(() => svc.registry.novaVersaoDeContrato(ctxA, cen.k1, {
    reason: 'renegociação', terms: { commissionBps: 2500, levelCapOverrideReason: 'renegociação aprovada' },
  }, { podeAtivar: true }));
  assert.equal(v.version.version, 2);
  assert.equal(v.version.commissionBps, 2500);
  await emA(() => svc.reconciliarTudo(ctxA, { completo: true }));
  const depois = (await ledgerDe(cen.p1.id)).map((l) => [l.id, Number(l.amount_cents)]);
  assert.deepEqual(depois, antes);
  // Um pedido NOVO (depois da vigência) usa a versão nova.
  await semearPedido(ctxA, { id: 5005, criadoEm: '2026-10-21T15:00:00Z', itens: [{ itemId: 9004, produtoId: 111, total: '100.00' }] });
  definirAgora('2026-10-22T12:00:00Z');
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5005'] }));
  const nova = (await sup.query(`SELECT l.amount_cents, l.status, a.contract_version_id FROM partner_commission_ledger l JOIN partnership_attributions a ON a.id = l.attribution_id WHERE a.ink_order_id = 5005`)).rows[0];
  assert.equal(Number(nova.amount_cents), 1000); // 25% de (100 − 60)
  assert.equal(nova.status, 'provisional'); // pago, ainda sem entrega: nunca liberado
  const versoes = await sup.query('SELECT version FROM partnership_contract_versions WHERE contract_id = $1 ORDER BY version', [cen.k1]);
  assert.deepEqual(versoes.rows.map((r) => r.version), [1, 2]);
  await assert.rejects(sup.query('UPDATE partnership_contract_versions SET commission_bps = 1 WHERE contract_id = $1', [cen.k1]), /append-only/);
});

test('pedido não pago, de troca ou com custo desconhecido nunca vira obrigação liberada', async () => {
  definirAgora('2026-10-22T12:00:00Z');
  await semearPedido(ctxA, { id: 5006, pagamento: 'waiting_payment', situacao: 'waiting_payment', criadoEm: '2026-10-22T10:00:00Z', itens: [{ itemId: 9005, produtoId: 111 }] });
  await semearPedido(ctxA, { id: 5007, criadoEm: '2026-10-22T10:00:00Z', troca: true, itens: [{ itemId: 9006, produtoId: 111 }] });
  await semearPedido(ctxA, { id: 5008, criadoEm: '2026-10-22T10:00:00Z', entregueEm: '2026-10-22T11:00:00Z', itens: [{ itemId: 9007, produtoId: 111, custoBase: null }] });
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5006', '5007', '5008'] }));
  const aguardando = (await sup.query(`SELECT l.status FROM partner_commission_ledger l JOIN partnership_attributions a ON a.id = l.attribution_id WHERE a.ink_order_id = 5006`)).rows;
  assert.deepEqual(aguardando.map((r) => r.status), ['provisional']);
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5007', [ORG_A]), 0);
  const semCusto = (await sup.query('SELECT status, review_reason FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5008', [ORG_A])).rows[0];
  assert.equal(semCusto.status, 'manual_review');
  assert.equal(semCusto.review_reason, 'cost_unknown');
  assert.equal(await contar(`SELECT count(*)::int AS n FROM partner_commission_ledger l JOIN partnership_attributions a ON a.id = l.attribution_id WHERE a.ink_order_id = 5008`), 0);
});

test('pedido antigo sem snapshot completo vai para revisão; item sem produto também; resolução manual é auditada', async () => {
  definirAgora('2026-10-22T12:00:00Z');
  await semearPedido(ctxA, { id: 5009, criadoEm: '2026-10-22T09:00:00Z', completo: false, itens: [{ itemId: 9008, produtoId: 111 }] });
  await semearPedido(ctxA, { id: 5010, criadoEm: '2026-10-22T09:00:00Z', entregueEm: '2026-10-22T11:00:00Z', itens: [{ itemId: 9009, produtoId: null, sku: 'SKU-X' }] });
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5009', '5010'] }));
  const revisoes = await emA(() => svc.diretorio.listarRevisoes(ctxA, {}));
  const r9 = revisoes.find((r) => r.inkOrderId === '5009');
  const r10 = revisoes.find((r) => r.inkOrderId === '5010');
  assert.equal(r9.reason, 'order_data_incomplete');
  assert.equal(r10.reason, 'item_without_product_id');
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id IN (5009, 5010)', [ORG_A]), 0);
  await assert.rejects(emA(() => svc.reconciliador.resolverRevisao(ctxA, r10.id, { decision: 'assign_collab', collabId: cen.collab.id })), (e) => e.codigo === 'AFILIADOS_ENTRADA_INVALIDA');
  const res = await emA(() => svc.reconciliador.resolverRevisao(ctxA, r10.id, { decision: 'assign_collab', collabId: cen.collab.id, reason: 'conferido no painel da INK: é a Praia do Rosa' }));
  assert.equal(res.status, 'resolved');
  const manual = (await sup.query('SELECT manual_override, status FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5010', [ORG_A])).rows[0];
  assert.deepEqual([manual.manual_override, manual.status], [true, 'calculated']);
  // O override sobrevive ao reprocessamento (não volta para revisão).
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5010'] }));
  assert.equal(await contar(`SELECT count(*)::int AS n FROM partnership_review_items WHERE organization_id = $1 AND ink_order_id = 5010 AND status = 'open'`, [ORG_A]), 0);
  assert.equal(await contar(`SELECT count(*)::int AS n FROM partnership_audit_events WHERE organization_id = $1 AND action = 'review.assign'`, [ORG_A]), 1);
});

test('collab: nova cópia no cluster aguarda aprovação, não é retroativa, e remoção não altera venda passada', async () => {
  await sup.query(
    `INSERT INTO commerce_products (organization_id, store_id, provider, provider_product_id, name, last_seen_sync_id, metadata)
     VALUES ($1,$2,'reserva_ink','111','Camiseta Praia',$3,'{"productClusterId": 77}'), ($1,$2,'reserva_ink','333','Caneca Praia',$3,'{"productClusterId": 77}'), ($1,$2,'reserva_ink','444','Outra estampa',$3,'{"productClusterId": 88}')`,
    [ORG_A, STORE_A, crypto.randomUUID()]
  );
  const desc = await emA(() => svc.collabs.descobrirPorCluster(ctxA, cen.collab.id));
  assert.deepEqual(desc.encontrados.map((e) => e.inkProductId), ['333']);
  assert.equal(desc.encontrados[0].status, 'pending_approval');
  assert.match(desc.encontrados[0].impactoUltimos90d.observacao, /Não retroativo/);

  // Pedido de 333 ANTES da aprovação: não comissiona.
  definirAgora('2026-10-23T12:00:00Z');
  await semearPedido(ctxA, { id: 5011, criadoEm: '2026-10-23T10:00:00Z', entregueEm: '2026-10-23T11:00:00Z', itens: [{ itemId: 9010, produtoId: 333 }] });
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5011'] }));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5011', [ORG_A]), 0);

  definirAgora('2026-10-23T13:00:00Z');
  const mid = desc.encontrados[0].id;
  await emA(() => svc.collabs.aprovarProduto(ctxA, cen.collab.id, mid, {}, { podeRetroagir: true }));
  await emA(() => svc.reconciliarTudo(ctxA, { completo: true }));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5011', [ORG_A]), 0); // sem retroatividade
  await semearPedido(ctxA, { id: 5012, criadoEm: '2026-10-23T14:00:00Z', itens: [{ itemId: 9011, produtoId: 333 }] });
  definirAgora('2026-10-23T15:00:00Z');
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['5012'] }));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5012', [ORG_A]), 1);

  // Remover o produto DEPOIS: a venda 5012 continua atribuída; venda nova não.
  const detalhe = await emA(() => svc.collabs.detalharCollab(ctxA, cen.collab.id));
  const m333 = detalhe.products.find((p) => p.inkProductId === '333');
  definirAgora('2026-10-24T09:00:00Z');
  await emA(() => svc.collabs.removerProduto(ctxA, cen.collab.id, m333.id, { motivo: 'saiu da coleção' }));
  await semearPedido(ctxA, { id: 5013, criadoEm: '2026-10-24T10:00:00Z', itens: [{ itemId: 9012, produtoId: 333 }] });
  definirAgora('2026-10-24T11:00:00Z');
  await emA(() => svc.reconciliarTudo(ctxA, { completo: true }));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5012', [ORG_A]), 1);
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 5013', [ORG_A]), 0);
});

test('o mesmo produto não pode estar em duas collabs ativas; participações passam de 100% são recusadas', async () => {
  await emA(async () => {
    const outra = await svc.collabs.criarCollab(ctxA, { name: 'Outra collab' });
    await assert.rejects(svc.collabs.adicionarProdutos(ctxA, outra.id, { products: [{ inkProductId: '111' }] }), (e) => e.codigo === 'AFILIADOS_PRODUTO_EM_OUTRA_COLLAB');
    const k3 = await svc.registry.criarContrato(ctxA, { partnerId: cen.p2.id, modality: 'collab', title: 'Collab Bruno', status: 'draft', reason: 'rascunho', terms: { commissionBasis: 'fixed_per_unit', fixedPerUnitCents: 500 } });
    await svc.collabs.adicionarCriador(ctxA, outra.id, { partnerId: cen.p2.id, contractId: k3.contract.id, shareBps: 6000 });
    const k4 = await svc.registry.criarContrato(ctxA, { partnerId: cen.p1.id, modality: 'collab', title: 'Collab Amanda 2', status: 'draft', reason: 'rascunho', terms: { commissionBasis: 'fixed_per_unit', fixedPerUnitCents: 500 } });
    await assert.rejects(svc.collabs.adicionarCriador(ctxA, outra.id, { partnerId: cen.p1.id, contractId: k4.contract.id, shareBps: 5000 }), (e) => e.codigo === 'AFILIADOS_PARTICIPACAO_EXCEDIDA');
    await svc.collabs.adicionarCriador(ctxA, outra.id, { partnerId: cen.p1.id, contractId: k4.contract.id, shareBps: 4000 });
  });
});

test('isolamento entre workspaces: B não vê, não lê por id nem altera nada de A (CRUD, relatórios, pagamentos, exportação)', async () => {
  // B tem a própria loja e um parceiro. Tudo o que é de A responde "não encontrado".
  const pB = await emB(() => svc.registry.criarParceiro(ctxB, { publicName: 'Parceiro de B' }, { aprovarDireto: true }));
  const listaB = await emB(() => svc.diretorio.listarParceiros(ctxB, {}));
  assert.deepEqual(listaB.itens.map((p) => p.publicName), ['Parceiro de B']);
  for (const fn of [
    () => svc.diretorio.perfilDoParceiro(ctxB, cen.p1.id),
    () => svc.registry.atualizarParceiro(ctxB, cen.p1.id, { publicName: 'invadido' }),
    () => svc.registry.decidirCandidatura(ctxB, cen.p1.id, { decisao: 'rejected', motivo: 'x' }),
    () => svc.registry.novaVersaoDeContrato(ctxB, cen.k1, { reason: 'x', terms: { commissionBps: 1 } }, { podeAtivar: true }),
    () => svc.registry.ativarCupom(ctxB, cen.cupom.id),
    () => svc.collabs.detalharCollab(ctxB, cen.collab.id),
    () => svc.collabs.adicionarProdutos(ctxB, cen.collab.id, { products: [{ inkProductId: '999' }] }),
    () => svc.payables.extratoDoParceiro(ctxB, cen.p1.id),
    () => svc.payables.registrarPagamento(ctxB, { partnerId: cen.p1.id, idempotencyKey: 'x', method: 'pix', paidAt: '2026-10-01T00:00:00Z', allocations: [{ ledgerId: cen.led2.id, amountCents: 1 }] }),
    () => svc.payables.registrarPagamento(ctxB, { partnerId: pB.id, idempotencyKey: 'y', method: 'pix', paidAt: '2026-10-01T00:00:00Z', allocations: [{ ledgerId: cen.led2.id, amountCents: 1 }] }),
    () => svc.payables.estornarPagamento(ctxB, cen.pg1.id, { motivo: 'x' }),
    () => svc.payables.aprovarLote(ctxB, crypto.randomUUID()),
    () => svc.progressao.avaliarParceiro(ctxB, cen.p1.id),
  ]) {
    await assert.rejects(emB(fn), (e) => e.status === 404, String(fn));
  }
  const aPagarB = await emB(() => svc.payables.listarAPagar(ctxB, { dateType: 'due' }));
  assert.equal(aPagarB.total, 0);
  const csvB = await emB(() => svc.payables.exportarCsv(ctxB, {}));
  assert.equal(csvB.linhas, 0);
  assert.doesNotMatch(csvB.csv, /Amanda|Bruno/);
  assert.equal((await emB(() => svc.diretorio.visaoGeral(ctxB, {}))).kpis.payableCents, 0);
  assert.equal((await emB(() => svc.diretorio.listarVendas(ctxB, {}))).total, 0);
  // Sem contexto de tenant a fachada nem deixa consultar.
  await assert.rejects(pool().query('SELECT * FROM partner_commission_ledger'), /contexto|TENANT_CONTEXT_REQUIRED/);
  // A role da aplicação não apaga histórico nem de A com contexto de A.
  await assert.rejects(emA(() => pool().query('DELETE FROM partnership_audit_events')), /append-only/);
  // Dados de A intactos.
  assert.equal((await emA(() => svc.diretorio.perfilDoParceiro(ctxA, cen.p1.id))).partner.publicName, 'Amanda Criadora');
});

test('exportação CSV: mesmos filtros, sem PII de comprador, sem segredo e com fórmulas neutralizadas', async () => {
  await emA(() => svc.registry.atualizarParceiro(ctxA, cen.p2.id, { publicName: '=HYPERLINK("http://evil","x")', contactEmail: 'bruno@exemplo.com' }));
  const todos = await emA(() => svc.payables.exportarCsv(ctxA, { dateType: 'due', from: '2026-10-01', to: '2026-10-31' }));
  assert.match(todos.csv, /"'=HYPERLINK/);
  assert.doesNotMatch(todos.csv, /bruno@exemplo\.com|amanda@exemplo\.com/);
  assert.doesNotMatch(todos.csv, /^=|,=HYPER/m);
  const soAmanda = await emA(() => svc.payables.exportarCsv(ctxA, { dateType: 'due', from: '2026-10-01', to: '2026-10-31', partnerId: cen.p1.id }));
  assert.equal(soAmanda.linhas, 1);
  assert.doesNotMatch(soAmanda.csv, /HYPERLINK/);
});

test('vencimento manual: exige motivo, é auditado e a recalculação por política não o sobrescreve', async () => {
  await assert.rejects(emA(() => svc.payables.alterarVencimento(ctxA, { ledgerIds: [cen.led2.id], dueAt: '2026-11-20T12:00:00Z' })), (e) => e.codigo === 'AFILIADOS_ENTRADA_INVALIDA');
  const r = await emA(() => svc.payables.alterarVencimento(ctxA, { ledgerIds: [cen.led2.id], dueAt: '2026-11-20T12:00:00Z', motivo: 'acordado com o parceiro' }));
  assert.equal(r.alterados, 1);
  await emA(() => svc.reconciliarTudo(ctxA, { completo: true }));
  const l = (await sup.query('SELECT due_at, due_at_overridden FROM partner_commission_ledger WHERE id = $1', [cen.led2.id])).rows[0];
  assert.equal(l.due_at_overridden, true);
  assert.equal(new Date(l.due_at).toISOString(), '2026-11-20T03:00:00.000Z');
  assert.equal(await contar(`SELECT count(*)::int AS n FROM partnership_audit_events WHERE organization_id = $1 AND action = 'ledger.due_at.change' AND reason = 'acordado com o parceiro'`, [ORG_A]), 1);
});

test('níveis: progressão só com vendas elegíveis; proposta depende de aprovação e não reescreve contrato', async () => {
  // Bruno acumula vendas de cupom até a meta de Voz (5 pedidos + R$ 150 de margem verificada).
  definirAgora('2026-10-25T12:00:00Z');
  for (let i = 0; i < 5; i += 1) {
    await semearPedido(ctxA, {
      id: 6000 + i, criadoEm: `2026-10-${10 + i}T12:00:00Z`, entregueEm: `2026-10-${11 + i}T12:00:00Z`, cupom: 'BRUNO10',
      itens: [{ itemId: 9500 + i, produtoId: 555, total: '200.00', custoBase: '50.00' }],
    });
  }
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['6000', '6001', '6002', '6003', '6004'] }));
  const av = await emA(() => svc.progressao.avaliarParceiro(ctxA, cen.p2.id));
  assert.equal(av.currentLevel.key, 'raiz');
  assert.equal(av.evaluation.nivelAlcancado, 'voz');
  assert.equal(av.metrics.vendasQualificadas, 6); // 5 novos + o pedido 5001 (cupom BRUNO10 sobre o item comum)
  const propostas = await emA(() => svc.progressao.listarPropostas(ctxA, {}));
  const prop = propostas.find((p) => p.partnerId === cen.p2.id);
  assert.equal(prop.toLevel, 'voz');
  assert.equal(prop.economicEffect.contractRewrite, false);
  const versoesAntes = await contar('SELECT count(*)::int AS n FROM partnership_contract_versions WHERE contract_id = $1', [cen.k2]);
  await emA(() => svc.progressao.decidirProposta(ctxA, prop.id, { decisao: 'approve', motivo: 'metas cumpridas' }));
  assert.equal((await emA(() => svc.progressao.avaliarParceiro(ctxA, cen.p2.id))).currentLevel.key, 'voz');
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_contract_versions WHERE contract_id = $1', [cen.k2]), versoesAntes);
  await assert.rejects(emA(() => svc.progressao.decidirProposta(ctxA, prop.id, { decisao: 'approve' })), (e) => e.codigo === 'AFILIADOS_PROPOSTA_DECIDIDA');
  // Comissões já capturadas não mudam por subir de nível.
  assert.equal(Number((await ledgerDe(cen.p2.id))[0].amount_cents), 450);
});

test('carteira de benefícios: crédito só de venda entregue, peça exige nível/saldo, convidado é exceção documentada', async () => {
  const saldo = await emA(() => svc.progressao.saldoDeBeneficios(ctxA, cen.p2.id));
  assert.ok(saldo.creditsCents > 0);
  // Voz: primeira peça só após 12 vendas acumuladas.
  await assert.rejects(emA(() => svc.progressao.concederPeca(ctxA, cen.p2.id, { productionCostCents: 1000, shippingCostCents: 500, description: 'camiseta' })), (e) => e.codigo === 'AFILIADOS_PECA_NAO_ELEGIVEL');
  await assert.rejects(emA(() => svc.progressao.concederPeca(ctxA, cen.p2.id, { productionCostCents: 1000, description: 'convidado sem entregáveis', guestCreator: true })), (e) => e.codigo === 'AFILIADOS_ENTRADA_INVALIDA');
  const g = await emA(() => svc.progressao.concederPeca(ctxA, cen.p2.id, { productionCostCents: 3000, shippingCostCents: 1000, description: 'peça de criador convidado', guestCreator: true, deliverables: '3 stories + 1 reels' }));
  assert.equal(g.amountCents, -4000);
  const rev = await emA(() => svc.progressao.reverterBeneficio(ctxA, g.id, { motivo: 'parceiro não entregou' }));
  assert.ok(rev.id);
  await assert.rejects(emA(() => svc.progressao.reverterBeneficio(ctxA, g.id, { motivo: 'de novo' })), (e) => e.codigo === 'AFILIADOS_JA_REVERTIDO');
  const depois = await emA(() => svc.progressao.saldoDeBeneficios(ctxA, cen.p2.id));
  assert.equal(depois.balanceCents, saldo.balanceCents);
  // Benefício nunca vira dinheiro a pagar: nenhuma linha do ledger de comissão nasce dele.
  assert.equal(await contar(`SELECT count(*)::int AS n FROM partner_commission_ledger WHERE organization_id = $1 AND entry_type = 'manual_adjustment'`, [ORG_A]), 0);
});

test('cachê por conteúdo é categoria separada e não se mistura à comissão nos totais', async () => {
  await emA(() => svc.payables.lancarManual(ctxA, { partnerId: cen.p1.id, category: 'content_fee', amountCents: 30000, reason: 'reels de lançamento', dueAt: '2026-11-10T12:00:00Z' }));
  const sem = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'due', from: '2026-11-01', to: '2026-11-30', partnerId: cen.p1.id, category: 'commission' }));
  const cache = await emA(() => svc.payables.listarAPagar(ctxA, { dateType: 'due', from: '2026-11-01', to: '2026-11-30', partnerId: cen.p1.id, category: 'content_fee' }));
  assert.equal(sem.total, 0);
  assert.equal(cache.itens[0].openCents, 30000);
  assert.equal(cache.itens[0].category, 'content_fee');
  const resumo = await emA(() => svc.payables.resumoDeAPagar(ctxA));
  assert.equal(resumo.contentFeesOpenCents, 30000);
});

test('escrita remota de promoções está desligada: preview monta o pedido, criação recusa e nada é enviado', async () => {
  const preview = await emA(() => svc.registry.previsualizarCriacaoNaInk(ctxA, cen.cupom.id));
  assert.equal(preview.ok, true);
  assert.equal(preview.enviaria, false);
  assert.equal(preview.request.headers['Idempotency-Key'], `oria-affiliate-coupon-${cen.cupom.id}`);
  await assert.rejects(emA(() => svc.registry.criarCupomNaInk(ctxA, cen.cupom.id)), (e) => e.codigo === 'INK_PROMOTION_WRITES_DISABLED');
  await assert.rejects(emA(() => svc.registry.verificarCupomNaInk(ctxA, cen.cupom.id)), (e) => e.codigo === 'INK_LEITURA_INDISPONIVEL');
});

test('cupom pausado fecha a vigência: venda durante a pausa não remunera nem depois de retomado', async () => {
  definirAgora('2026-11-01T12:00:00Z');
  const cupom = await emA(() => svc.registry.criarCupom(ctxA, { partnerId: cen.p2.id, contractId: cen.k2, code: 'PAUSA10', discountKind: 'percentage', discountBps: 1000 }));
  await emA(() => svc.registry.ativarCupom(ctxA, cupom.id));
  definirAgora('2026-11-02T12:00:00Z');
  const pausado = await emA(() => svc.registry.pausarCupom(ctxA, cupom.id, 'campanha suspensa'));
  assert.equal(pausado.status, 'paused');
  definirAgora('2026-11-03T12:00:00Z');
  await semearPedido(ctxA, { id: 7001, criadoEm: '2026-11-03T10:00:00Z', cupom: 'PAUSA10', itens: [{ itemId: 9700, produtoId: 666 }] });
  await emA(() => svc.registry.retomarCupom(ctxA, cupom.id, 'voltou'));
  definirAgora('2026-11-04T12:00:00Z');
  await semearPedido(ctxA, { id: 7002, criadoEm: '2026-11-04T10:00:00Z', cupom: 'PAUSA10', itens: [{ itemId: 9701, produtoId: 666 }] });
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['7001', '7002'] }));
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 7001', [ORG_A]), 0);
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 7002', [ORG_A]), 1);
});

test('parceiro com afiliado nativo da INK declarado: atribuição bloqueada e sem crédito', async () => {
  definirAgora('2026-11-05T12:00:00Z');
  const p = await emA(() => svc.registry.criarParceiro(ctxA, { publicName: 'Legado INK', legacyInkAffiliate: true }, { aprovarDireto: true }));
  const k = await emA(() => svc.registry.criarContrato(ctxA, { partnerId: p.id, modality: 'coupon', title: 'Legado', status: 'active', reason: 'teste', terms: { commissionBasis: 'verified_margin_percent', commissionBps: 1000 } }, { podeAtivar: true }));
  const cupom = await emA(() => svc.registry.criarCupom(ctxA, { partnerId: p.id, contractId: k.contract.id, code: 'LEGADO10', discountKind: 'percentage', discountBps: 1000 }));
  await emA(() => svc.registry.ativarCupom(ctxA, cupom.id));
  definirAgora('2026-11-06T12:00:00Z');
  await semearPedido(ctxA, { id: 7100, criadoEm: '2026-11-06T10:00:00Z', cupom: 'LEGADO10', itens: [{ itemId: 9800, produtoId: 777 }] });
  await emA(() => svc.reconciliarTudo(ctxA, { pedidos: ['7100'] }));
  const a = (await sup.query('SELECT status, review_reason FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = 7100', [ORG_A])).rows[0];
  assert.deepEqual([a.status, a.review_reason], ['blocked', 'legacy_ink_affiliate_conflict']);
  assert.equal(await contar('SELECT count(*)::int AS n FROM partner_commission_ledger WHERE organization_id = $1 AND partner_id = $2', [ORG_A, p.id]), 0);
});

test('regras de nível são versionadas por loja e a de outra Organization não interfere', async () => {
  const regras = JSON.parse(JSON.stringify((await emA(() => svc.registry.lerRegrasDeNivel(ctxA))).regras));
  regras.niveis[1].vendasQualificadas = 3;
  await assert.rejects(emA(() => svc.registry.salvarRegrasDeNivel(ctxA, { regras })), (e) => e.codigo === 'AFILIADOS_ENTRADA_INVALIDA');
  const v1 = await emA(() => svc.registry.salvarRegrasDeNivel(ctxA, { regras, motivo: 'piloto mais fácil' }));
  assert.equal(v1.version, 1);
  assert.equal((await emA(() => svc.registry.lerRegrasDeNivel(ctxA))).regras.niveis[1].vendasQualificadas, 3);
  assert.equal((await emB(() => svc.registry.lerRegrasDeNivel(ctxB))).padrao, true);
});

test('visão geral: KPIs com período e tipo de data explícitos, sem chamar receita atribuída de incremental', async () => {
  definirAgora('2026-11-10T12:00:00Z');
  const v = await emA(() => svc.diretorio.visaoGeral(ctxA, { from: '2026-09-01', to: '2026-09-30', dateType: 'order' }));
  assert.equal(v.period.dateType, 'order');
  assert.equal(v.period.timezone, 'America/Sao_Paulo');
  assert.ok(v.kpis.validOrders >= 2);
  assert.ok(v.kpis.attributedNetRevenueCents > 0);
  assert.match(v.definicoes.attributedNetRevenue, /não é receita incremental/i);
  assert.equal(v.kpis.activePartners >= 2, true);
  assert.ok(Array.isArray(v.alerts));
  const semAtribuicao = await emA(() => svc.diretorio.visaoGeral(ctxA, { range: '7d' }));
  assert.equal(semAtribuicao.period.preset, '7d');
  await assert.rejects(emA(() => svc.diretorio.visaoGeral(ctxA, { dateType: 'qualquer' })), (e) => e.status === 400);
});

test('lista de parceiros: busca por cupom/nome, filtros e paginação server-side', async () => {
  const porCupom = await emA(() => svc.diretorio.listarParceiros(ctxA, { q: 'bruno10' }));
  assert.equal(porCupom.total, 1);
  assert.deepEqual(porCupom.itens[0].coupons.includes('Bruno10'), true);
  const modalidade = await emA(() => svc.diretorio.listarParceiros(ctxA, { modality: 'collab' }));
  assert.ok(modalidade.itens.some((p) => p.publicName === 'Amanda Criadora'));
  const pagina = await emA(() => svc.diretorio.listarParceiros(ctxA, { limit: 1, offset: 1 }));
  assert.equal(pagina.itens.length, 1);
  assert.ok(pagina.total >= 3);
  // % e _ na busca são literais (sem curinga) e sem injeção.
  const curinga = await emA(() => svc.diretorio.listarParceiros(ctxA, { q: "%'; DROP TABLE partnership_partners; --" }));
  assert.equal(curinga.total, 0);
  assert.equal(await contar('SELECT count(*)::int AS n FROM partnership_partners WHERE organization_id = $1', [ORG_A]) >= 3, true);
});

test('migrations 0044/0045 descem e sobem de novo num banco descartável', async () => {
  const d = await h.criarBancoDescartavel('oria_afil_rev');
  try {
    assert.equal(h.migrar(d.url).status, 0);
    const down = h.migrar(d.url, { comando: 'down', posicionais: ['2'] });
    assert.equal(down.status, 0, `${down.stdout.slice(-1500)}${down.stderr}`);
    const p = h.abrirPoolDescartavel(d.url, { max: 1 });
    try {
      const { rows } = await p.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('partnership_partners', 'partner_commission_ledger')`);
      assert.equal(rows[0].n, 0);
      const { rows: cols } = await p.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'pedidos_ink' AND column_name = 'promotion_code'`);
      assert.equal(cols[0].n, 0);
    } finally { await p.end(); }
    assert.equal(h.migrar(d.url).status, 0);
  } finally { await d.destruir(); }
});
