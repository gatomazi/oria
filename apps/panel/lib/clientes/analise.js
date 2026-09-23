'use strict';

// Junta identidade + RFM + indicadores a partir das LINHAS de `pedidos_ink` (uma Store). Puro: quem chama lê o
// banco (com escopo de Organization/Store) e passa as linhas; aqui não há SQL, relógio nem rede.
//
// Universo: só pedido com identidade (documento, telefone ou e-mail) vira cliente. Pedido sem nenhuma dessas
// chaves não pode ser atribuído a ninguém — fica FORA de todos os indicadores (mesmo universo em todos os cards) e
// é contado em `cobertura.pedidosSemIdentidade`, para a tela declarar o buraco em vez de escondê-lo.

const { agruparPedidosPorIdentidade, chaveDoPedido } = require('./identidade');
const { classificarRfm, pedidoValido } = require('./rfm');
const { calcularIndicadores, dataLocal } = require('./metricas');

const FUSO_PADRAO = 'America/Sao_Paulo';

function temIdentidade(r) {
  return !!(r.buyer_documento || r.buyer_telefone || r.buyer_email);
}

function pedidoDaLinha(r) {
  return {
    inkOrderId: r.ink_order_id == null ? null : String(r.ink_order_id),
    criadoEm: r.criado_em,
    valor: r.total_value == null ? null : Number(r.total_value),
    paymentStatus: r.payment_status,
    orderStatus: r.order_status || null,
    isTroca: !!r.is_troca,
    frete: r.frete == null ? null : Number(r.frete),
    descontos: r.descontos == null ? null : Number(r.descontos),
    itensQuantidade: r.items_count == null ? null : Number(r.items_count),
  };
}

// `linhas`: pedidos_ink em ordem `criado_em DESC`. `chaveDoContexto`: chave da Store para linhas sem `loja`.
function agruparClientes(linhas, { chaveDoContexto }) {
  const porLoja = new Map();
  for (const r of linhas) {
    if (!temIdentidade(r)) continue;
    const loja = r.loja || chaveDoContexto;
    if (!porLoja.has(loja)) porLoja.set(loja, []);
    porLoja.get(loja).push(r);
  }
  const clientes = [];
  for (const [loja, pedidos] of porLoja) {
    for (const grupo of agruparPedidosPorIdentidade(pedidos)) {
      const maisRecente = grupo.pedidos[0];
      clientes.push({
        // `id` interno é só posição/loja: nunca sai da API (a chave pública é `customerKey`).
        id: `${loja}#${clientes.length}`,
        loja,
        customerKey: chaveDoPedido(maisRecente),
        nome: maisRecente.buyer_nome,
        telefone: maisRecente.buyer_telefone,
        email: maisRecente.buyer_email,
        documento: maisRecente.buyer_documento,
        aceitaMarketing: maisRecente.buyer_aceita_marketing,
        motivosDeUniao: grupo.motivosDeUniao,
        pedidos: grupo.pedidos.map(pedidoDaLinha),
      });
    }
  }
  return clientes;
}

function coberturaDe(linhas, clientes) {
  let primeiro = null;
  let ultimo = null;
  let semIdentidade = 0;
  let validos = 0;
  for (const r of linhas) {
    const t = r.criado_em ? new Date(r.criado_em).getTime() : NaN;
    if (Number.isFinite(t)) {
      if (primeiro == null || t < primeiro) primeiro = t;
      if (ultimo == null || t > ultimo) ultimo = t;
    }
    const valido = pedidoValido(pedidoDaLinha(r));
    if (valido && !temIdentidade(r)) semIdentidade += 1;
    if (valido && temIdentidade(r)) validos += 1;
  }
  return {
    pedidosTotal: linhas.length,
    pedidosValidos: validos,
    pedidosSemIdentidade: semIdentidade,
    clientesIdentificados: clientes.length,
    primeiroPedidoEm: primeiro == null ? null : new Date(primeiro).toISOString(),
    ultimoPedidoEm: ultimo == null ? null : new Date(ultimo).toISOString(),
  };
}

// `hoje` (YYYY-MM-DD no fuso) só serve de teto do período; `asOf` é a data de CLASSIFICAÇÃO da RFM e não muda
// quando o usuário troca o período dos indicadores.
function analisarPedidos(linhas, { asOf, periodo, fuso = FUSO_PADRAO, chaveDoContexto, opcoesRfm = {} }) {
  const clientes = agruparClientes(linhas, { chaveDoContexto });
  const cobertura = coberturaDe(linhas, clientes);
  const rfm = classificarRfm(clientes, { asOf, fuso, ...opcoesRfm });
  const indicadores = calcularIndicadores(clientes, periodo, { fuso, primeiroPedidoEm: cobertura.primeiroPedidoEm });
  const classificacaoPorId = new Map(rfm.clientes.map((c) => [c.id, c]));
  return { clientes, cobertura, rfm, indicadores, classificacaoPorId };
}

// Chave de junção com a lista de Clientes (a mesma `loja + customerKey` que ela usa).
const chaveDeJuncao = (loja, customerKey) => `${loja}\u0000${customerKey}`;

module.exports = { analisarPedidos, agruparClientes, coberturaDe, pedidoDaLinha, chaveDeJuncao, dataLocal };
