'use strict';

// Visão 360° de um cliente: identidade, indicadores, histórico de pedidos com itens, campanhas já recebidas e o
// estado real de cada canal. Puro: quem chama lê o banco (com escopo) e passa as linhas.
//
// Conciliação de valores. A Ink fecha o pedido assim (lib/ink/financeiro.js, validado em 152/152 pedidos):
//   total pago = Σ itens + frete − descontos        ⇒   subtotal (Σ itens) = total pago − frete + descontos
// O subtotal sai dessa identidade e é CONFERIDO contra a soma dos itens gravados (`conciliado`). Quando os itens
// não estão no cache, ou o frete/desconto do pedido é desconhecido, o campo vem `null` — nunca um valor inventado.
//
// Reembolso: o cache só guarda o status final do pagamento. Pedido `refunded` = devolvido por inteiro; devolução
// parcial NÃO é rastreada e fica `null` (declarada na lista de lacunas), sem estimativa.

const { pedidoValido } = require('./rfm');

const TOLERANCIA_CONCILIACAO = 0.05;

const centavos = (v) => Math.round(v * 100) / 100;
const numero = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function montarPedido(p, itensDoPedido) {
  const total = numero(p.valor);
  const frete = numero(p.frete);
  const descontos = numero(p.descontos);
  const subtotal = total != null && frete != null && descontos != null ? centavos(total - frete + descontos) : null;
  const itens = itensDoPedido.map((i) => {
    const venda = numero(i.valor_venda) ?? 0;
    const desconto = numero(i.desconto_rateado) ?? 0;
    return {
      produto: i.produto_nome || null,
      sku: i.sku || null,
      modelo: i.modelo || null,
      cor: i.cor || null,
      tamanho: i.tamanho || null,
      quantidade: Number(i.quantidade) || 0,
      valorVenda: centavos(venda),
      descontoRateado: centavos(desconto),
      valorLiquido: centavos(venda - desconto),
      // A Ink não entrega a imagem do item no payload de pedido; a tela usa placeholder, sem fabricar URL.
      imagem: null,
    };
  });
  const somaItens = itens.length ? centavos(itens.reduce((acc, i) => acc + i.valorVenda, 0)) : null;
  const valido = pedidoValido(p);
  const devolvidoTotal = p.paymentStatus === 'refunded';
  return {
    inkOrderId: p.inkOrderId,
    criadoEm: p.criadoEm ? new Date(p.criadoEm).toISOString() : null,
    statusPagamento: p.paymentStatus || null,
    statusPedido: p.orderStatus || null,
    troca: !!p.isTroca,
    contaNoLtv: valido,
    quantidade: itens.length ? itens.reduce((acc, i) => acc + i.quantidade, 0) : numero(p.itensQuantidade),
    subtotal,
    desconto: descontos,
    frete,
    totalPago: total,
    devolvido: devolvidoTotal ? total : null,
    devolucaoParcialRastreada: false,
    totalLiquido: valido ? total : 0,
    somaItens,
    conciliado: somaItens != null && subtotal != null ? Math.abs(somaItens - subtotal) <= TOLERANCIA_CONCILIACAO : null,
    itens,
  };
}

// Telefone brasileiro para wa.me: DDD + número (10–11 dígitos) ganha o 55; já com 55 (12–13) fica como está.
function telefoneParaWhatsapp(telefone) {
  const d = String(telefone || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return null;
}

function canaisDoCliente(cliente, { whatsappConectado }) {
  const telefoneWa = telefoneParaWhatsapp(cliente.telefone);
  const email = String(cliente.email || '').trim();
  const emailValido = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return {
    consentimento: {
      aceitaMarketing: cliente.aceitaMarketing == null ? null : !!cliente.aceitaMarketing,
      fonte: 'Consentimento de marketing do checkout na Reserva Ink (pedido mais recente).',
      // O Oria ainda não registra opt-in/opt-out por canal nem supressão própria: não fingir que existe.
      registroPorCanal: false,
    },
    whatsapp: {
      conexaoOria: whatsappConectado ? 'conectada' : 'desconectada',
      telefoneValido: !!telefoneWa,
      // Não há envio 1:1 pelo Oria: o botão só abre o WhatsApp fora do painel e não registra envio.
      acao: telefoneWa ? 'abrir_externo' : 'indisponivel',
      telefoneWa,
      motivo: telefoneWa ? 'Abre uma conversa no WhatsApp fora do Oria; nenhuma mensagem é enviada por aqui.' : 'Cliente sem telefone válido.',
    },
    email: {
      provedorIntegrado: false,
      emailValido,
      acao: emailValido ? 'abrir_cliente_de_email' : 'indisponivel',
      motivo: emailValido ? 'Abre o seu aplicativo de e-mail; o Oria não dispara e-mail.' : 'Cliente sem e-mail válido.',
    },
  };
}

function distintivos({ indicadores, ticketMedioDaBase, canais }) {
  const fatos = [];
  if (indicadores.pedidosPagos === 2) fatos.push({ id: 'segunda_compra', label: '2ª compra' });
  if (indicadores.pedidosPagos >= 3) fatos.push({ id: 'recorrente', label: `${indicadores.pedidosPagos} compras` });
  if (indicadores.pedidosPagos === 1) fatos.push({ id: 'primeira_compra', label: '1 compra' });
  if (indicadores.ticketMedio != null && ticketMedioDaBase != null && indicadores.ticketMedio > ticketMedioDaBase) {
    fatos.push({ id: 'ticket_acima_da_media', label: 'Ticket acima da média da loja', detalhe: `média da base: ${centavos(ticketMedioDaBase)}` });
  }
  if (canais.consentimento.aceitaMarketing === true) fatos.push({ id: 'aceita_marketing', label: 'Aceita marketing (checkout)' });
  return fatos;
}

// `cliente`: saída de `agruparClientes`. `classificacao`: entrada do cliente em `rfm.clientes` (ou undefined).
// `itensPorPedido`: Map inkOrderId → linhas de pedidos_ink_itens. `campanhas`: linhas de campaign_recipients.
function montarDetalhe({ cliente, classificacao, rfm, itensPorPedido, campanhas, whatsappConectado, ticketMedioDaBase, uf }) {
  const pedidos = cliente.pedidos.map((p) => montarPedido(p, itensPorPedido.get(p.inkOrderId) || []));
  const validos = pedidos.filter((p) => p.contaNoLtv);
  const ltv = centavos(validos.reduce((acc, p) => acc + (p.totalPago || 0), 0));
  const itensConhecidos = validos.every((p) => p.itens.length > 0);
  const indicadores = {
    ltv,
    pedidosPagos: validos.length,
    ticketMedio: validos.length ? centavos(ltv / validos.length) : null,
    primeiraCompraEm: classificacao ? classificacao.primeiraCompraEm : null,
    ultimaCompraEm: classificacao ? classificacao.ultimaCompraEm : null,
    diasSemComprar: classificacao ? classificacao.r : null,
    itensComprados: validos.length && itensConhecidos ? validos.reduce((acc, p) => acc + (p.quantidade || 0), 0) : null,
    // Itens vêm do cache por pedido; pedido antigo sem itens gravados torna a soma incompleta e ela some da tela.
    pedidosSemItens: validos.filter((p) => p.itens.length === 0).length,
  };
  const canais = canaisDoCliente(cliente, { whatsappConectado });
  return {
    cliente: {
      nome: cliente.nome || null,
      email: cliente.email || null,
      telefone: cliente.telefone || null,
      documento: cliente.documento || null,
      uf: uf || null,
      loja: cliente.loja,
    },
    identidade: { motivosDeUniao: cliente.motivosDeUniao, pedidosAgrupados: cliente.pedidos.length },
    rfm: classificacao
      ? {
        segmento: classificacao.segmento, escore: classificacao.escore, r: classificacao.r, f: classificacao.f, fVida: classificacao.fVida,
        m: classificacao.m, versao: rfm.versao, asOf: rfm.asOf, amostraSuficiente: rfm.amostraSuficiente, motivoInsuficiencia: rfm.motivoInsuficiencia,
      }
      : null,
    indicadores,
    distintivos: distintivos({ indicadores, ticketMedioDaBase, canais }),
    pedidos,
    campanhas: campanhas.map((c) => ({
      campanhaId: String(c.campaign_id),
      campanha: c.campanha_nome,
      status: c.status,
      enviadoEm: c.sent_at || null,
      entregueEm: c.delivered_at || null,
      lidoEm: c.read_at || null,
      falha: c.failure_code || null,
    })),
    canais,
    lacunas: [
      'Reembolso parcial não é rastreado no cache de pedidos: só o reembolso total (status `refunded`) reduz o LTV.',
      'A imagem do produto não vem no payload de pedido da Ink; a tela mostra placeholder.',
      'Opt-in e opt-out por canal ainda não são registrados no Oria; só o consentimento de marketing do checkout.',
      'Só há histórico de campanhas do Oria (campaign_recipients); respostas e conversões atribuídas não são registradas por cliente.',
    ],
  };
}

module.exports = { montarDetalhe, montarPedido, telefoneParaWhatsapp, canaisDoCliente };
