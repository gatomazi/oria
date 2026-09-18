'use strict';

// "Quanto essa campanha vendeu?" — atribuição por último toque de mensagem. Não há clique rastreado
// (o link da mensagem vai direto pra loja), então a regra é por janela de tempo:
//
//   um pedido pago da mesma loja conta pra campanha quando o comprador recebeu a mensagem dela
//   até JANELA_DIAS antes do pedido E nenhuma OUTRA campanha chegou pra ele entre esse envio e o
//   pedido (a mensagem mais recente leva o crédito; o pedido nunca é contado em duas campanhas).
//
// Comprador é casado por telefone (com/sem DDI), documento ou e-mail — a mesma regra do carrinho
// abandonado (lib/recuperacao/compra.js), indexado por chave. Fica fora do server.js pra ter teste unitário
// (test/campanhas-atribuicao.test.js).

const { variantesTelefone } = require('../recuperacao/compra');

const JANELA_DIAS = 7;
// Janelas que o painel oferece — o endpoint só aceita uma destas (espelhada em
// src/state/janelaAtribuicao.ts).
const JANELAS_DIAS_PERMITIDAS = [1, 3, 7, 14, 30];

// Valor vindo da query string: inválido/ausente cai no padrão em vez de virar erro.
function janelaDiasValida(valor) {
  const n = Number(valor);
  return JANELAS_DIAS_PERMITIDAS.includes(n) ? n : JANELA_DIAS;
}
const DIA_MS = 86400000;

function digitos(v) {
  return String(v == null ? '' : v).replace(/\D/g, '');
}

// Chaves de casamento de um envio. customer_key do snapshot é documento || telefone || e-mail do
// cliente (buscarClientesAgregados); entra junto com o telefone gravado no destinatário.
function chavesDoEnvio(envio) {
  const chaves = new Set(variantesTelefone(envio.telefone).map((t) => `t:${t}`));
  const chave = String(envio.customerKey || '').trim();
  if (chave.includes('@')) chaves.add(`e:${chave.toLowerCase()}`);
  else if (digitos(chave)) {
    chaves.add(`d:${digitos(chave)}`);
    // Sem documento, a chave é o próprio telefone.
    for (const t of variantesTelefone(chave)) chaves.add(`t:${t}`);
  }
  return chaves;
}

function chavesDoPedido(p) {
  const chaves = [];
  if (digitos(p.telefone)) chaves.push(`t:${digitos(p.telefone)}`);
  if (digitos(p.documento)) chaves.push(`d:${digitos(p.documento)}`);
  const email = String(p.email || '').trim().toLowerCase();
  if (email) chaves.push(`e:${email}`);
  return chaves;
}

function ms(iso) {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

// Índice chave -> envios, pra não varrer milhares de destinatários a cada pedido.
function indexar(envios) {
  const indice = new Map();
  for (const e of envios || []) {
    const em = ms(e.sentAt);
    if (em == null) continue;
    const item = { em, lote: e.lote ?? null };
    for (const k of chavesDoEnvio(e)) {
      if (!indice.has(k)) indice.set(k, []);
      indice.get(k).push(item);
    }
  }
  return indice;
}

function candidatos(indice, pedido) {
  const vistos = new Set();
  for (const k of chavesDoPedido(pedido)) for (const e of indice.get(k) || []) vistos.add(e);
  return vistos;
}

// envios: destinatários ENVIADOS desta campanha ({ lote, sentAt, telefone, customerKey }).
// outrosEnvios: envios de outras campanhas da mesma loja no período (mesmo formato).
// pedidos: pagos, sem troca, da loja da campanha ({ inkOrderId, criadoEm, valor, telefone, documento, email }).
function atribuirPedidosCampanha({ envios, outrosEnvios = [], pedidos, janelaDias = JANELA_DIAS }) {
  const janelaMs = janelaDias * DIA_MS;
  const indiceCampanha = indexar(envios);
  const indiceOutras = indexar(outrosEnvios);

  const atribuidos = [];
  for (const p of pedidos || []) {
    const pedidoEm = ms(p.criadoEm);
    if (pedidoEm == null) continue;

    // Envio desta campanha mais recente antes do pedido, dentro da janela.
    let toque = null;
    for (const e of candidatos(indiceCampanha, p)) {
      if (e.em > pedidoEm || pedidoEm - e.em > janelaMs) continue;
      if (!toque || e.em > toque.em) toque = e;
    }
    if (!toque) continue;

    // Outra campanha falou com o comprador depois deste envio e antes do pedido: o crédito é dela.
    let perdeu = false;
    for (const c of candidatos(indiceOutras, p)) if (c.em > toque.em && c.em <= pedidoEm) { perdeu = true; break; }
    if (perdeu) continue;

    atribuidos.push({ inkOrderId: p.inkOrderId, lote: toque.lote, valor: Number(p.valor) || 0 });
  }

  const arred = (v) => Math.round(v * 100) / 100;
  const porLote = new Map();
  for (const a of atribuidos) {
    const atual = porLote.get(a.lote) || { pedidos: 0, receita: 0 };
    atual.pedidos += 1;
    atual.receita += a.valor;
    porLote.set(a.lote, atual);
  }
  for (const v of porLote.values()) v.receita = arred(v.receita);

  return {
    pedidos: atribuidos.length,
    receita: arred(atribuidos.reduce((acc, a) => acc + a.valor, 0)),
    porLote,
  };
}

module.exports = { JANELA_DIAS, JANELAS_DIAS_PERMITIDAS, janelaDiasValida, atribuirPedidosCampanha };
