'use strict';

// Agregado de clientes para a Audiência de Campanhas — extraído, SEM mudar comportamento, de `buscarClientesAgregados`
// (server.js) para poder ser testado com relógio controlado e comparado, por IDs sintéticos, à classificação RFM.
//
// Semântica HERDADA (a que os filtros genéricos de Campanhas sempre usaram — não é a da RFM):
//   · "compra" = pedido com `payment_status` convertido (paid/succeeded/free), INCLUINDO troca paga e sem olhar `order_status`;
//   · `totalCompras`/`totalGasto`/`ticketMedio` somam TODO o histórico (sem janela de 365 dias);
//   · `diasSemComprar` = ⌊(agora − última compra) / 24h⌋ — janela móvel de 24 horas, não dia de calendário;
//   · pedidos duplicados (mesmo `ink_order_id` em duas linhas) contam duas vezes, a menos que quem chama já os deduplique.
// A RFM (lib/clientes/rfm.js) exclui troca, dia de calendário no fuso da Organização e janela de frequência. As diferenças
// são exatamente o que `lib/clientes/audiencia-rfm.js` elimina para segmentos de origem RFM.

const { agruparPedidosPorIdentidade } = require('./identidade');
const { STATUS_VALIDOS } = require('./rfm');

const temIdentidade = (r) => !!(r.buyer_documento || r.buyer_telefone || r.buyer_email);

// `linhas`: pedidos_ink em ordem `criado_em DESC` (a ordem é preservada dentro de cada grupo de identidade).
// `agora`: instante da avaliação (ms) — entra por parâmetro para o relógio ser controlável.
function agregarClientesDePedidos(linhas, { agora = Date.now(), chaveDoContexto, statusConvertido = STATUS_VALIDOS } = {}) {
  const rows = linhas.filter(temIdentidade);

  // Identidade nunca cruza lojas diferentes; a Store nativa grava `loja` nula e usa a chave do contexto.
  const pedidosPorLoja = new Map();
  for (const r of rows) {
    const chave = r.loja || chaveDoContexto;
    if (!pedidosPorLoja.has(chave)) pedidosPorLoja.set(chave, []);
    pedidosPorLoja.get(chave).push(r);
  }

  const clientes = [];
  for (const [loja, pedidos] of pedidosPorLoja) {
    const grupos = agruparPedidosPorIdentidade(pedidos).map((g) => g.pedidos);

    for (const pedidosDoGrupo of grupos) {
      const maisRecente = pedidosDoGrupo[0];
      const pedidosPagos = pedidosDoGrupo.filter((p) => statusConvertido.has(p.payment_status));
      const totalCompras = pedidosPagos.length;
      const totalGasto = pedidosPagos.reduce((acc, p) => acc + (Number(p.total_value) || 0), 0);
      // Lucro que o cliente deixou pra loja: troca não é venda e fica fora; pedido pago sem custo calculado é contado à parte.
      const pagosSemTroca = pedidosPagos.filter((p) => !p.is_troca);
      const lucroOperacional = pagosSemTroca.reduce((acc, p) => acc + (Number(p.lucro_operacional) || 0), 0);
      const pedidosSemFinanceiro = pagosSemTroca.filter((p) => p.lucro_operacional == null).length;
      const ultimaCompraEm = pedidosPagos.reduce((max, p) => (!max || p.criado_em > max ? p.criado_em : max), null);
      const primeiraCompraEm = pedidosPagos.reduce((min, p) => (!min || p.criado_em < min ? p.criado_em : min), null);
      // UF do pedido mais recente QUE TEM uf preenchida (pedidos antigos não têm buyer_uf).
      const ufRecente = pedidosDoGrupo.find((p) => p.buyer_uf);

      // Toda chave de identidade que já apareceu no grupo: o histórico de campanha pode estar gravado sob uma chave antiga.
      const chavesHistoricas = new Set();
      for (const p of pedidosDoGrupo) {
        const chave = p.buyer_documento || p.buyer_telefone || p.buyer_email;
        if (chave) chavesHistoricas.add(chave);
      }

      clientes.push({
        loja,
        customerKey: maisRecente.buyer_documento || maisRecente.buyer_telefone || maisRecente.buyer_email,
        legacyCustomerKeys: Array.from(chavesHistoricas),
        nome: maisRecente.buyer_nome,
        telefone: maisRecente.buyer_telefone,
        email: maisRecente.buyer_email,
        documento: maisRecente.buyer_documento,
        aceitaMarketing: maisRecente.buyer_aceita_marketing,
        uf: ufRecente ? ufRecente.buyer_uf : null,
        totalCompras,
        totalGasto,
        ticketMedio: totalCompras > 0 ? totalGasto / totalCompras : null,
        lucroOperacional: Math.round(lucroOperacional * 100) / 100,
        pedidosSemFinanceiro,
        ultimaCompraEm,
        primeiraCompraEm,
        diasSemComprar: ultimaCompraEm ? Math.floor((agora - new Date(ultimaCompraEm).getTime()) / 86400000) : null,
      });
    }
  }

  clientes.sort((a, b) => b.totalCompras - a.totalCompras);
  return clientes;
}

// Comparação numérica dos filtros genéricos de Audiência (`gt|gte|lt|lte|eq`); valor ou alvo ausente nunca casa.
function compararNumero(valor, op, alvo) {
  if (valor == null || alvo == null) return false;
  switch (op) {
    case 'gt': return valor > alvo;
    case 'gte': return valor >= alvo;
    case 'lt': return valor < alvo;
    case 'lte': return valor <= alvo;
    case 'eq': return valor === alvo;
    default: return false;
  }
}

// Avalia UM filtro numérico genérico sobre um cliente agregado (a semântica herdada; server.js delega para cá).
function avaliarFiltroNumerico(cliente, { field, op, value }) {
  switch (field) {
    case 'diasSemComprar':
      // "nunca comprou" (null) só bate em "há mais de N dias" — pra "menos de N dias" não se aplica.
      if (cliente.diasSemComprar == null) return op === 'gte' || op === 'gt';
      return compararNumero(cliente.diasSemComprar, op, value);
    case 'quantidadePedidos': return compararNumero(cliente.totalCompras, op, value);
    case 'totalGasto': return compararNumero(cliente.totalGasto, op, value);
    case 'ticketMedio': return compararNumero(cliente.ticketMedio, op, value);
    default: return false;
  }
}

module.exports = { agregarClientesDePedidos, temIdentidade, compararNumero, avaliarFiltroNumerico };
