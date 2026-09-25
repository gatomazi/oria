'use strict';

// Identidade de cliente a partir de pedidos: dois pedidos são da MESMA pessoa se compartilham documento,
// telefone OU e-mail — de forma transitiva (union-find). Extraído de `buscarClientesAgregados` (server.js) para
// ser a única fonte da regra: a lista de Clientes, a RFM e a audiência de campanha precisam agrupar igual.
//
// Regra por Organization/Store: quem chama passa SÓ pedidos de uma Store (a identidade nunca cruza lojas).
// Trade-off consciente (herdado): duas pessoas que dividem telefone/e-mail de família em pedidos distintos viram
// um cliente só — prioriza nunca duplicar destinatário de campanha sobre esse caso raro.
//
// Merge auditável: cada grupo devolve `motivosDeUniao` (quais campos ligaram pedidos entre si), então dá para
// explicar por que dois pedidos foram unidos — e reverter mudando a regra aqui, já que nada é persistido.

// `pedidos` já ordenados por `criado_em DESC` (a ordem é preservada dentro de cada grupo).
function agruparPedidosPorIdentidade(pedidos) {
  const pai = pedidos.map((_, i) => i);
  const encontrar = (i) => { while (pai[i] !== i) { pai[i] = pai[pai[i]]; i = pai[i]; } return i; };
  const unir = (a, b) => { const ra = encontrar(a); const rb = encontrar(b); if (ra !== rb) pai[ra] = rb; };

  const porDocumento = new Map();
  const porTelefone = new Map();
  const porEmail = new Map();
  const uniaoPorCampo = new Map(); // índice do pedido -> Set de campos que o ligaram a outro
  const marcar = (i, j, campo) => {
    for (const k of [i, j]) {
      if (!uniaoPorCampo.has(k)) uniaoPorCampo.set(k, new Set());
      uniaoPorCampo.get(k).add(campo);
    }
  };

  pedidos.forEach((p, i) => {
    const doc = (p.buyer_documento || '').trim();
    const tel = (p.buyer_telefone || '').trim();
    const email = (p.buyer_email || '').trim();
    if (doc) { if (porDocumento.has(doc)) { unir(i, porDocumento.get(doc)); marcar(i, porDocumento.get(doc), 'documento'); } else porDocumento.set(doc, i); }
    if (tel) { if (porTelefone.has(tel)) { unir(i, porTelefone.get(tel)); marcar(i, porTelefone.get(tel), 'telefone'); } else porTelefone.set(tel, i); }
    if (email) { if (porEmail.has(email)) { unir(i, porEmail.get(email)); marcar(i, porEmail.get(email), 'email'); } else porEmail.set(email, i); }
  });

  const grupos = new Map(); // raiz -> { pedidos, motivos }
  pedidos.forEach((p, i) => {
    const raiz = encontrar(i);
    if (!grupos.has(raiz)) grupos.set(raiz, { pedidos: [], motivosDeUniao: new Set() });
    const g = grupos.get(raiz);
    g.pedidos.push(p);
    for (const campo of uniaoPorCampo.get(i) || []) g.motivosDeUniao.add(campo);
  });

  return Array.from(grupos.values(), (g) => ({ pedidos: g.pedidos, motivosDeUniao: Array.from(g.motivosDeUniao).sort() }));
}

// Chave de identidade usada em novos envios: documento > telefone > e-mail do pedido mais recente do grupo.
function chaveDoPedido(p) {
  return p.buyer_documento || p.buyer_telefone || p.buyer_email;
}

module.exports = { agruparPedidosPorIdentidade, chaveDoPedido };
