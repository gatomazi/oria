'use strict';

// Rodada 5 — matriz de estados financeiros: o que CADA consumidor faz hoje com `payment_status × order_status × troca`.
// Não decide política: DOCUMENTA a atual e seus riscos com fixtures SINTÉTICAS (docs/features/oria-clientes-rfm-rodada5.md §3).
// Os quatro consumidores comparados usam funções reais:
//   · RFM / indicadores / 360°      → `pedidoValido` (lib/clientes/rfm.js) — payment_status ∈ {paid, succeeded, free}, sem troca;
//   · Campanhas (filtros genéricos) → `agregarClientesDePedidos` — payment_status convertido, INCLUI troca, ignora order_status;
//   · Audiência exata (segmento RFM) → mesma população da RFM (audiencia-rfm.js).
// Se uma linha desta tabela mudar, é decisão de negócio: o teste falha de propósito para forçar a revisão do documento.

const test = require('node:test');
const assert = require('node:assert/strict');

const { pedidoValido } = require('../lib/clientes/rfm');
const { calcularIndicadores } = require('../lib/clientes/metricas');
const { agregarClientesDePedidos } = require('../lib/clientes/agregado');
const { montarPedido } = require('../lib/clientes/detalhe');

const QUANDO = '2026-09-10T15:00:00.000Z';
const PERIODO = { de: '2026-09-01', ate: '2026-09-30' };

//   pay/order/troca         = o que foi observado
//   rfm / campanhas         = o pedido conta como compra? (true/false)
//   valor                   = valor financeiro usado (total_value, com frete e líquido de desconto) quando conta
//   ausente                 = informação que o cache não tem
//   pendente                = decisão de negócio que só o dado real pode fechar
const MATRIZ = [
  { id: 'pago', pay: 'paid', order: 'sent', rfm: true, campanhas: true, ausente: null, pendente: null },
  { id: 'pago-gratuito', pay: 'free', order: 'sent', rfm: true, campanhas: true, total: 0, ausente: null, pendente: null },
  { id: 'pago-pedido-cancelado', pay: 'paid', order: 'canceled', rfm: true, campanhas: true, ausente: 'motivo/instante do cancelamento e se houve estorno', pendente: 'RISCO: pagamento válido com pedido encerrado conta como venda' },
  { id: 'pago-pedido-devolvido', pay: 'paid', order: 'returned', rfm: true, campanhas: true, ausente: 'valor devolvido', pendente: 'RISCO: idem, devolvido' },
  { id: 'pago-pedido-reembolsado', pay: 'paid', order: 'refunded', rfm: true, campanhas: true, ausente: 'valor reembolsado', pendente: 'RISCO: idem, reembolsado por status de PEDIDO' },
  { id: 'reembolso-total', pay: 'refunded', order: 'sent', rfm: false, campanhas: false, ausente: null, pendente: null },
  { id: 'reembolso-total-rotulo-pt', pay: 'Reembolsado', order: 'sent', rfm: false, campanhas: false, ausente: 'a entrada NÃO normaliza o rótulo "Reembolsado" (só o contador de reembolsados o reconhece)', pendente: 'mapear o rótulo com amostra confiável' },
  { id: 'reembolso-solicitado', pay: 'refund_requested', order: 'sent', rfm: false, campanhas: false, ausente: 'se o reembolso foi concluído', pendente: 'compra sai dos dois enquanto o reembolso está só solicitado' },
  { id: 'reembolso-parcial', pay: 'partially_refunded', order: 'sent', rfm: false, campanhas: false, ausente: 'VALOR reembolsado (o cache só guarda o status final)', pendente: 'RISCO: a pessoa inteira some da RFM; nunca se infere o valor parcial' },
  { id: 'cancelado', pay: 'canceled', order: 'canceled', rfm: false, campanhas: false, ausente: null, pendente: null },
  { id: 'pendente', pay: 'waiting_payment', order: 'created', rfm: false, campanhas: false, ausente: null, pendente: null },
  { id: 'expirado', pay: 'expired', order: 'canceled', rfm: false, campanhas: false, ausente: null, pendente: null },
  { id: 'nao-autorizado', pay: 'not_authorized', order: 'created', rfm: false, campanhas: false, ausente: null, pendente: null },
  { id: 'aguardando-analise', pay: 'awaiting_analysis', order: 'created', rfm: false, campanhas: false, ausente: null, pendente: null },
  { id: 'troca-paga', pay: 'paid', order: 'sent', troca: true, rfm: false, campanhas: true, ausente: null, pendente: 'DIVERGÊNCIA conhecida: a troca conta como compra nos filtros genéricos de Campanhas e não na RFM (a Audiência exata segue a RFM)' },
];

const linha = (m, valor = m.total ?? 80) => ({
  loja: 'sul', ink_order_id: 1, buyer_nome: 'Sintético M', buyer_telefone: '51900000000', buyer_documento: 'DOC-M', buyer_email: null,
  buyer_aceita_marketing: true, buyer_uf: 'RS', payment_status: m.pay, order_status: m.order, total_value: valor, criado_em: QUANDO,
  is_troca: !!m.troca, frete: 10, descontos: 5, items_count: 1, lucro_operacional: null,
});
const pedidoRfm = (m, valor = m.total ?? 80) => ({ criadoEm: QUANDO, valor, paymentStatus: m.pay, orderStatus: m.order, isTroca: !!m.troca, frete: 10, descontos: 5, itensQuantidade: 1, inkOrderId: '1' });

for (const m of MATRIZ) {
  test(`matriz financeira · ${m.id} (${m.pay}/${m.order}${m.troca ? ', troca' : ''}): RFM ${m.rfm ? 'conta' : 'não conta'}, Campanhas genérico ${m.campanhas ? 'conta' : 'não conta'}`, () => {
    assert.equal(pedidoValido(pedidoRfm(m)), m.rfm, 'pedidoValido (RFM, indicadores, 360°)');
    const agregado = agregarClientesDePedidos([linha(m)], { agora: Date.parse('2026-09-24T15:00:00Z'), chaveDoContexto: 'sul' })[0];
    assert.equal(agregado.totalCompras > 0, m.campanhas, 'agregado de Campanhas (filtros genéricos)');
    const ind = calcularIndicadores([{ id: 'x', pedidos: [pedidoRfm(m)] }], PERIODO, { primeiroPedidoEm: QUANDO }).atual;
    assert.equal(ind.pedidos, m.rfm ? 1 : 0, 'indicadores: pedidos válidos');
    assert.equal(ind.faturamento, m.rfm ? (m.total ?? 80) : 0, 'indicadores: valor financeiro usado');
    assert.equal(montarPedido(pedidoRfm(m), []).contaNoLtv, m.rfm, 'detalhe 360°: conta no LTV');
    if (m.rfm) assert.equal(agregado.totalGasto, m.total ?? 80, 'Campanhas soma o mesmo total_value');
  });
}

test('valor financeiro: total_value já é líquido de desconto e INCLUI o frete pago; frete/desconto separados não são somados de novo', () => {
  const m = MATRIZ[0];
  const ind = calcularIndicadores([{ id: 'x', pedidos: [pedidoRfm(m, 123.45)] }], PERIODO, { primeiroPedidoEm: QUANDO }).atual;
  assert.equal(ind.faturamento, 123.45);
  assert.equal(montarPedido(pedidoRfm(m, 123.45), []).totalPago, 123.45);
});

test('pedido zerado (free) é compra válida com valor 0: conta em pedidos e frequência, não em faturamento', () => {
  const ind = calcularIndicadores([{ id: 'x', pedidos: [pedidoRfm({ pay: 'free', order: 'sent' }, 0)] }], PERIODO, { primeiroPedidoEm: QUANDO }).atual;
  assert.equal(ind.pedidos, 1);
  assert.equal(ind.faturamento, 0);
});

test('pedido sem valor ou sem data nunca conta (não se infere nem se assume 0)', () => {
  assert.equal(pedidoValido({ ...pedidoRfm(MATRIZ[0]), valor: null }), false);
  assert.equal(pedidoValido({ ...pedidoRfm(MATRIZ[0]), criadoEm: null }), false);
});

test('o contador de reembolsados reconhece "Reembolsado" (rótulo PT) mesmo sem a entrada normalizá-lo: o número exibido não muda a política', () => {
  const clientes = [
    { id: 'a', pedidos: [pedidoRfm({ pay: 'refunded', order: 'sent' })] },
    { id: 'b', pedidos: [pedidoRfm({ pay: 'Reembolsado', order: 'sent' })] },
    { id: 'c', pedidos: [pedidoRfm({ pay: 'partially_refunded', order: 'sent' })] },
  ];
  const ind = calcularIndicadores(clientes, PERIODO, { primeiroPedidoEm: QUANDO }).atual;
  assert.equal(ind.pedidosReembolsados, 2, 'total (enum) + total (rótulo PT); o parcial não é contado nem descontado');
  assert.equal(ind.faturamento, 0);
});
