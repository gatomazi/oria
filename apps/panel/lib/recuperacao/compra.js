'use strict';

// "Esse carrinho abandonado já virou compra?" — a API da Ink não responde isso (o painel dela mostra
// "Comprou?", mas o endpoint de abandoned_carts não traz o campo). Casa o comprador do carrinho
// contra pedidos pagos criados depois do carrinho, por telefone, documento ou e-mail. Fica fora do
// server.js pra ter teste unitário (test/recuperacao-compra.test.js).
//
// Achado real (2026-09-15, cliente Paula Cunha): o registro de carrinho guarda o telefone já no
// formato do WhatsApp (DDI 55 na frente) e o cache de pedidos guarda só os dígitos que a Ink manda
// (sem DDI) — comparação exata nunca batia, a compra passava despercebida e o carrinho seguia
// "Aguardando" com reenvio agendado.

function digitos(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// Mesmo telefone brasileiro com e sem DDI 55 — cobre os dois formatos que circulam no sistema.
function variantesTelefone(v) {
  const d = digitos(v);
  if (!d) return [];
  if (d.length > 11 && d.startsWith('55')) return [d, d.slice(2)];
  if (d.length <= 11) return [d, `55${d}`];
  return [d];
}

function chavesComprador({ telefone, documento, email } = {}) {
  return {
    telefones: variantesTelefone(telefone),
    documento: digitos(documento) || null,
    email: String(email || '').trim().toLowerCase() || null,
  };
}

function mesmoComprador(alvo, pedido) {
  const a = chavesComprador(alvo);
  const telPedido = digitos(pedido.telefone);
  if (telPedido && a.telefones.includes(telPedido)) return true;
  if (a.documento && digitos(pedido.documento) === a.documento) return true;
  if (a.email && String(pedido.email || '').trim().toLowerCase() === a.email) return true;
  return false;
}

// Primeiro pedido pago do mesmo comprador (e mesma loja) criado a partir de `alvo.desde`. `pedidos`
// já vêm filtrados por status pago; devolve null quando não há compra (ou o carrinho não tem
// nenhum dado de contato pra casar).
//
// INV-24: o escopo é obrigatório e o filtro é incondicional. Sem loja no alvo não há como saber de
// quem é o carrinho — erro, nunca "procura em todos os pedidos".
function acharCompraDoCarrinho(alvo, pedidos) {
  if (!alvo || typeof alvo.loja !== 'string' || !alvo.loja) {
    throw new Error('recuperação exige a loja do carrinho (escopo obrigatório)');
  }
  const a = chavesComprador(alvo);
  if (!a.telefones.length && !a.documento && !a.email) return null;
  const desde = alvo.desde ? new Date(alvo.desde).getTime() : null;

  let primeira = null;
  for (const p of pedidos || []) {
    if (p.loja !== alvo.loja) continue;
    const em = new Date(p.criadoEm).getTime();
    if (!Number.isFinite(em)) continue;
    if (desde != null && Number.isFinite(desde) && em < desde) continue;
    if (!mesmoComprador(alvo, p)) continue;
    if (!primeira || em < new Date(primeira.criadoEm).getTime()) primeira = p;
  }
  return primeira;
}

module.exports = { variantesTelefone, mesmoComprador, acharCompraDoCarrinho };
