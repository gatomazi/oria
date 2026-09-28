'use strict';

// Adaptador de PROMOÇÕES COMUNS da INK para cupons de parceiro. Isolado e testado só com fakes/contrato:
// nesta versão a ESCRITA remota está DESLIGADA (`ink_promotion_writes_enabled=false`) e nenhum cliente de escrita
// é injetado pelo server.js — o adaptador falha fechado antes de qualquer chamada. O cadastro MANUAL de cupom
// (criado no painel da INK) é o fallback integral e não depende de nada daqui.
//
// O que a especificação da API (apps/panel/documentacao-api-ink.yaml) confirma, e o que este arquivo NÃO presume:
//   confirmado no contrato  GET  /v1/stores/promotions?code=&type=&page=&per_page=   (escopo store.promotions.read)
//                           POST /v1/stores/promotions/standard  (escopo store.promotions.write, header Idempotency-Key obrigatório,
//                                 corpo: code, kind percentage|value, list_type, apply_automatically, first_purchase, usage_limit,
//                                 starts_at, expires_at, discount_tier{discount,min_cart_value,min_cart_items}, product_ids, ...)
//                           PATCH /v1/stores/promotions/standard/{id} · DELETE /v1/stores/promotions/{id}  (idem escopo + Idempotency-Key)
//   NÃO confirmado          que o plano da loja habilita escrita de promoções; que o código "comum" comporta o mesmo cupom em
//                           vários pedidos sem `usage_limit`; qualquer semântica de afiliado da INK (não é usada).
// Primeira operação remota futura, após autorização: GET /v1/stores/promotions?code=<CÓDIGO> (leitura, 1 chamada) para
// validar o cupom manual; só depois, com a flag ligada em ambiente de teste, o POST standard com Idempotency-Key estável.

const { normalizarCodigo } = require('./engine');

class PromotionWritesDisabledError extends Error {
  constructor() {
    super('escrita de promoções na INK está desligada (ink_promotion_writes_enabled=false)');
    this.name = 'PromotionWritesDisabledError';
    this.codigo = 'INK_PROMOTION_WRITES_DISABLED';
  }
}

class PromotionConflictError extends Error {
  constructor(code, existentes) {
    super(`já existe promoção com o código ${code} na INK`);
    this.name = 'PromotionConflictError';
    this.codigo = 'INK_PROMOTION_CONFLICT';
    this.existentes = existentes;
  }
}

class PromotionPermissionError extends Error {
  constructor(escopo) {
    super(`o token da INK não tem o escopo ${escopo}`);
    this.name = 'PromotionPermissionError';
    this.codigo = 'INK_PROMOTION_SCOPE_MISSING';
    this.escopo = escopo;
  }
}

// Idempotency-Key ESTÁVEL por vínculo de cupom: um retry nunca duplica a promoção.
const chaveDeIdempotencia = (linkId) => `oria-affiliate-coupon-${linkId}`;

function iso(data) { return data ? new Date(data).toISOString() : undefined; }

// Corpo do POST /v1/stores/promotions/standard a partir do vínculo local. Puro; valida antes de montar.
function montarPedidoDeCriacao(link) {
  const problemas = [];
  const code = normalizarCodigo(link.codeDisplay || link.codeNormalized);
  if (!code) problemas.push('código ausente');
  if (code && !/^[A-Z0-9_-]{3,32}$/.test(code)) problemas.push('código deve ter 3–32 caracteres (A–Z, 0–9, _ e -)');
  if (!['percentage', 'value'].includes(link.discountKind)) problemas.push('tipo de desconto ausente (percentual ou valor fixo)');
  let desconto;
  if (link.discountKind === 'percentage') {
    if (!Number.isInteger(link.discountBps) || link.discountBps < 1 || link.discountBps > 10000) problemas.push('percentual inválido');
    else desconto = link.discountBps / 100;
  } else if (link.discountKind === 'value') {
    if (!Number.isInteger(link.discountCents) || link.discountCents < 1) problemas.push('valor fixo inválido');
    else desconto = link.discountCents / 100;
  }
  if (!link.validFrom) problemas.push('início da vigência ausente');
  const corpo = {
    code,
    kind: link.discountKind,
    list_type: 'all',
    apply_automatically: false,
    first_purchase: false,
    starts_at: iso(link.validFrom),
    expires_at: iso(link.validUntil),
    discount_tier: { discount: desconto },
  };
  return {
    ok: problemas.length === 0,
    problemas,
    request: {
      method: 'POST',
      path: '/v1/stores/promotions/standard',
      headers: { 'Idempotency-Key': chaveDeIdempotencia(link.id) },
      body: corpo,
      escopoExigido: 'store.promotions.write',
    },
  };
}

// Compara a promoção lida da INK com o cupom local; devolve divergências legíveis (relatório técnico).
function compararComPromocao(link, promocao) {
  const divergencias = [];
  if (!promocao) return ['cupom não encontrado na INK'];
  if (normalizarCodigo(promocao.code) !== normalizarCodigo(link.codeNormalized)) divergencias.push('código diferente');
  if (promocao.type && promocao.type !== 'standard') divergencias.push(`tipo ${promocao.type} (esperado standard)`);
  if (promocao.available === false) divergencias.push('promoção indisponível na INK');
  if (link.discountKind && promocao.kind && promocao.kind !== link.discountKind) divergencias.push('tipo de desconto diferente');
  const tier = Array.isArray(promocao.discount_tiers) ? promocao.discount_tiers[0] : null;
  if (tier && tier.discount !== undefined && tier.discount !== null) {
    const valor = Number(tier.discount);
    const esperado = link.discountKind === 'percentage' ? (link.discountBps ?? 0) / 100 : (link.discountCents ?? 0) / 100;
    if (link.discountKind && Number.isFinite(valor) && Math.abs(valor - esperado) > 0.0001) divergencias.push('valor do desconto diferente');
  }
  if (promocao.starts_at && link.validFrom && Math.abs(new Date(promocao.starts_at) - new Date(link.validFrom)) > 60000) divergencias.push('início da vigência diferente');
  if (promocao.expires_at && link.validUntil && Math.abs(new Date(promocao.expires_at) - new Date(link.validUntil)) > 60000) divergencias.push('fim da vigência diferente');
  return divergencias;
}

/**
 * @param {{ client?: {get: Function, post: Function}|null, flags?: {inkPromotionWritesEnabled?: boolean}, scopes?: string[]|null }} deps
 *   `client.get(path)` / `client.post(path, body, headers)` — injetados; em produção nesta rodada só `get` existe.
 */
function createInkPromotionsAdapter({ client = null, flags = {}, scopes = null } = {}) {
  const escritaLigada = () => flags.inkPromotionWritesEnabled === true;

  // Só monta o pedido: NUNCA faz chamada. É o "preview" do fluxo preferido.
  function previsualizarCriacao(link) {
    const montado = montarPedidoDeCriacao(link);
    return { ...montado, escritaHabilitada: escritaLigada(), enviaria: montado.ok && escritaLigada() };
  }

  // Leitura (1 chamada, filtrada por código): valida um cupom cadastrado manualmente.
  async function buscarPorCodigo(codigo) {
    if (!client || typeof client.get !== 'function') return { disponivel: false, motivo: 'cliente_indisponivel', promocoes: [] };
    const code = normalizarCodigo(codigo);
    const dados = await client.get(`/v1/stores/promotions?code=${encodeURIComponent(code)}&per_page=5`);
    return { disponivel: true, promocoes: Array.isArray(dados && dados.promotions) ? dados.promotions : [] };
  }

  async function verificarCupom(link) {
    const r = await buscarPorCodigo(link.codeNormalized);
    if (!r.disponivel) return { status: 'unavailable', divergencias: [] };
    const exata = r.promocoes.find((p) => normalizarCodigo(p.code) === normalizarCodigo(link.codeNormalized)) || null;
    if (!exata) return { status: 'not_found', divergencias: ['cupom não encontrado na INK'] };
    const divergencias = compararComPromocao(link, exata);
    return { status: divergencias.length ? 'divergent' : 'confirmed', divergencias, promotionId: exata.id ?? null };
  }

  // Escrita: fail-closed por flag, por cliente, por escopo, por validação e por conflito — nessa ordem, antes do POST.
  async function criarPromocao(link) {
    if (!escritaLigada()) throw new PromotionWritesDisabledError();
    if (!client || typeof client.post !== 'function') throw new PromotionWritesDisabledError();
    if (Array.isArray(scopes) && !scopes.includes('store.promotions.write')) throw new PromotionPermissionError('store.promotions.write');
    const montado = montarPedidoDeCriacao(link);
    if (!montado.ok) throw Object.assign(new Error(`cupom inválido: ${montado.problemas.join('; ')}`), { codigo: 'INK_PROMOTION_INVALID', problemas: montado.problemas });
    const existentes = await buscarPorCodigo(link.codeNormalized);
    const conflito = existentes.promocoes.filter((p) => normalizarCodigo(p.code) === normalizarCodigo(link.codeNormalized));
    if (conflito.length > 0) throw new PromotionConflictError(link.codeNormalized, conflito);
    const criada = await client.post(montado.request.path, montado.request.body, montado.request.headers);
    const promocao = criada && criada.promotion ? criada.promotion : null;
    if (!promocao || promocao.id === undefined) throw Object.assign(new Error('resposta da INK sem promoção'), { codigo: 'INK_PROMOTION_BAD_RESPONSE' });
    // Leitura de volta: o vínculo só é confirmado se a INK devolver o que foi criado.
    const conferido = await verificarCupom({ ...link, ink_promotion_id: promocao.id });
    return { promotionId: promocao.id, confirmacao: conferido };
  }

  return { previsualizarCriacao, buscarPorCodigo, verificarCupom, criarPromocao };
}

module.exports = {
  PromotionWritesDisabledError, PromotionConflictError, PromotionPermissionError,
  chaveDeIdempotencia, montarPedidoDeCriacao, compararComPromocao, createInkPromotionsAdapter,
};
