'use strict';

// Era `backfillPaymentStatusPortugues()` no boot (`server.js:1153` em 8a7ea3d).
//
// A Reserva Ink devolve `payment_status` como rótulo em PORTUGUÊS no objeto do pedido ("Pago",
// "Pendente", ...) enquanto a documentação lista o enum em inglês. `upsertPedidoInkPostgres` já
// normaliza na escrita; isto corrige as linhas gravadas antes disso.
//
// Idempotente por natureza: depois da primeira passada não sobra linha com rótulo em português.
// O mapa é o mesmo `PAGAMENTO_LABEL_PT_PARA_ENUM` do server.js, validado contra 500 eventos reais.

exports.shorthands = undefined;

const PT_PARA_ENUM = {
  'pago': 'paid',
  'pendente': 'waiting_payment',
  'expirado': 'expired',
  'não autorizado': 'not_authorized',
  'aguardando análise': 'awaiting_analysis',
  'cancelado': 'canceled',
};

exports.up = async (pgm) => {
  let total = 0;
  for (const [rotuloPt, canonico] of Object.entries(PT_PARA_ENUM)) {
    const res = await pgm.db.query(
      'UPDATE pedidos_ink SET payment_status = $1 WHERE LOWER(payment_status) = $2',
      [canonico, rotuloPt]
    );
    total += res.rowCount || 0;
  }
  if (total > 0) console.log(`[migrate] payment_status: ${total} pedido(s) normalizado(s)`);
};

// Não desfaz: o mapeamento pt→enum não é injetivo no sentido inverso útil (uma linha que já
// nascesse em inglês seria indistinguível de uma convertida), e voltar ao rótulo em português
// reintroduziria o defeito que esta migration existe para remover.
exports.down = () => {
  throw new Error('backfill-payment-status-portugues é irreversível por desenho.');
};
