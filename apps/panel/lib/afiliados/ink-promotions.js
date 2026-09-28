'use strict';

// Provider de PROMOÇÕES da INK (subtipo `standard`) usado como infraestrutura de cupom/desconto. O Oria NÃO usa o programa de afiliados
// da INK: cadastro do parceiro, contrato, comissão, ledger e tracking ficam no Oria. A INK só guarda "o código dá X% de desconto".
// Comissão, nível, benefício, saldo e cachê NUNCA entram no corpo enviado à INK.
//
// Fonte de verdade: https://developers.reserva.ink/referencia/#tag/promoções e /guias/promocoes (conferidas em 28/09/2026).
//   GET    /v1/stores/promotions?code=&type=&page=&per_page=   store.promotions.read   → { promotions[], page, per_page, total_pages, total_count }
//   GET    /v1/stores/promotions/{id}                          store.promotions.read   → { promotion }
//   POST   /v1/stores/promotions/standard                      store.promotions.write + Idempotency-Key → 201 { promotion }
//   PATCH  /v1/stores/promotions/standard/{id}                 store.promotions.write + Idempotency-Key → 200 { promotion } (parcial)
//   DELETE /v1/stores/promotions/{id}                          store.promotions.write + Idempotency-Key → 204 (soft delete; o código volta a ficar livre)
// Assimetria do contrato: o corpo de escrita usa `discount_tier` (objeto, `discount` NUMBER); a leitura devolve `discount_tiers` (array,
// `discount` STRING como "10.0"). `available` é CALCULADO pela INK (não expirada, não agendada, sem estourar usage_limit) — nunca é configuração.
//
// Escrita: é FUNCIONALIDADE do painel quando o connector da INK existe (o server.js injeta o cliente completo `get/post/patch/delete`), sem flag.
// Continua fail-closed: só sai POST/PATCH/DELETE por ação explícita de owner (ativar cupom, ink-create/ink-sync/ink-delete), com `Idempotency-Key`,
// e nada é ativado sem `201` válido + leitura de volta. Se o connector não suporta criação (cliente sem `post`) ou outro connector futuro não
// tiver integração de cupom, o fluxo cai no modo MANUAL: cria-se o cupom na loja e o Oria só cria o vínculo/verifica.
// Não validado ponta a ponta contra uma credencial real da loja (ver docs/afiliados/auditoria-integracao.md §7).

const crypto = require('node:crypto');
const { normalizarCodigo } = require('./engine');
const { dataLocal, TZ_PADRAO } = require('./schedule');

const ESCOPO_LEITURA = 'store.promotions.read';
const ESCOPO_ESCRITA = 'store.promotions.write';

// O connector atual não expõe essa escrita (ex.: cliente só de leitura, ou outro connector sem integração de cupom).
class PromotionWritesUnavailableError extends Error {
  constructor(motivo = 'este connector não suporta criar/alterar promoções; crie o cupom na loja e vincule-o aqui') {
    super(motivo);
    this.name = 'PromotionWritesUnavailableError';
    this.codigo = 'INK_PROMOTION_WRITES_UNAVAILABLE';
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

// Erro da chamada à INK já traduzido: nunca carrega token, cabeçalhos nem o corpo bruto da resposta.
class PromotionApiError extends Error {
  constructor(codigo, message, { status = null, detalhes = null } = {}) {
    super(message);
    this.name = 'PromotionApiError';
    this.codigo = codigo;
    this.status = status;
    this.detalhes = detalhes;
  }
}

function traduzirErro(err) {
  if (err instanceof PromotionApiError) return err;
  const status = Number.isInteger(err && err.status) ? err.status : null;
  if (status === 401) return new PromotionApiError('INK_UNAUTHORIZED', 'a INK recusou a credencial (401): token ausente, inválido ou revogado', { status });
  if (status === 403) return new PromotionApiError('INK_FORBIDDEN', 'a INK recusou por permissão (403): o token não tem o escopo necessário ou o plano não permite', { status });
  if (status === 404) return new PromotionApiError('INK_NOT_FOUND', 'promoção não encontrada na INK (404)', { status });
  if (status === 409) return new PromotionApiError('INK_CONFLICT', 'a INK respondeu conflito (409)', { status });
  if (status === 422) {
    const lista = err.details && Array.isArray(err.details.errors) ? err.details.errors.filter((x) => typeof x === 'string').slice(0, 5) : [];
    return new PromotionApiError('INK_VALIDATION', `a INK recusou os dados da promoção (422)${lista.length ? `: ${lista.join('; ')}` : ''}`.slice(0, 400), { status, detalhes: lista });
  }
  if (status === 429) return new PromotionApiError('INK_RATE_LIMITED', 'limite de requisições da INK atingido (429); tente novamente em instantes', { status });
  if (status === 503 && /integração/i.test(String((err && err.message) || ''))) return new PromotionApiError('INK_NOT_CONFIGURED', 'esta loja não tem a integração com a INK configurada', { status });
  if (status !== null && status >= 500) return new PromotionApiError('INK_UNAVAILABLE', `a INK está indisponível (${status})`, { status });
  const nome = String((err && (err.name || err.code)) || '');
  if (/Timeout|Abort|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(nome + String((err && err.message) || ''))) {
    return new PromotionApiError('INK_TIMEOUT', 'sem resposta da INK (tempo esgotado ou falha de rede)');
  }
  return new PromotionApiError('INK_ERROR', 'falha inesperada ao falar com a INK');
}

// ── Idempotência ────────────────────────────────────────────────────────────────────────────────
// A chave é DETERMINÍSTICA pela intenção lógica (operação + vínculo + conteúdo): retry da mesma intenção reenvia a mesma chave (a INK devolve
// o resultado original em vez de duplicar); outra intenção/payload gera outra chave. Só contém UUID interno e hash — nada pessoal, nada secreto.
function estavel(valor) {
  if (Array.isArray(valor)) return valor.map(estavel);
  if (valor && typeof valor === 'object') return Object.fromEntries(Object.keys(valor).sort().map((k) => [k, estavel(valor[k])]));
  return valor;
}
const resumo = (conteudo) => crypto.createHash('sha256').update(JSON.stringify(estavel(conteudo))).digest('hex').slice(0, 16);
const chaveDeCriacao = (linkId, corpo) => `oria-aff-create-${linkId}-${resumo(corpo)}`;
const chaveDeAtualizacao = (linkId, promotionId, patch) => `oria-aff-update-${linkId}-${promotionId}-${resumo(patch)}`;
const chaveDeExclusao = (linkId, promotionId) => `oria-aff-delete-${linkId}-${promotionId}`;

const TRANSITORIOS = new Set(['INK_TIMEOUT', 'INK_UNAVAILABLE', 'INK_RATE_LIMITED']);

const iso = (data) => (data ? new Date(data).toISOString() : undefined);

// ── Configuração esperada (Oria → INK) ──────────────────────────────────────────────────────────
// Só o que pertence à promoção: código, desconto do CLIENTE, vigência e comportamento do cupom no checkout. Sem gatilho mínimo (nenhum
// valor é inventado); a INK pode recusar `discount_tier` sem gatilho — isso só se sabe com a conta real (pendência documentada).
function configuracaoEsperada(link) {
  const kind = link.discountKind;
  const desconto = kind === 'percentage' ? (link.discountBps ?? 0) / 100 : (link.discountCents ?? 0) / 100;
  return {
    type: 'standard',
    code: normalizarCodigo(link.codeDisplay || link.codeNormalized),
    kind,
    discount: desconto,
    min_cart_value: null,
    min_cart_items: null,
    list_type: 'all',
    product_ids: [],
    product_type_ids: [],
    collection_ids: [],
    first_purchase: false,
    usage_limit: null,
    apply_automatically: false,
    show_on_product_page: false,
    show_in_cart: false,
    starts_at: link.validFrom ? new Date(link.validFrom) : null,
    expires_at: link.validUntil ? new Date(link.validUntil) : null,
  };
}

// Corpo do POST standard. Puro; valida antes de montar. Nada de comissão aqui.
function montarPedidoDeCriacao(link) {
  const problemas = [];
  const esperado = configuracaoEsperada(link);
  if (!esperado.code) problemas.push('código ausente');
  if (esperado.code && !/^[A-Z0-9_-]{3,32}$/.test(esperado.code)) problemas.push('código deve ter 3–32 caracteres (A–Z, 0–9, _ e -)');
  if (!['percentage', 'value'].includes(link.discountKind)) problemas.push('tipo de desconto ausente (percentual ou valor fixo)');
  else if (link.discountKind === 'percentage' && !(Number.isInteger(link.discountBps) && link.discountBps >= 1 && link.discountBps <= 10000)) problemas.push('percentual inválido');
  else if (link.discountKind === 'value' && !(Number.isInteger(link.discountCents) && link.discountCents >= 1)) problemas.push('valor fixo inválido');
  if (!link.validFrom) problemas.push('início da vigência ausente');
  const corpo = {
    code: esperado.code,
    kind: link.discountKind,
    list_type: esperado.list_type,
    apply_automatically: esperado.apply_automatically,
    show_on_product_page: esperado.show_on_product_page,
    show_in_cart: esperado.show_in_cart,
    first_purchase: esperado.first_purchase,
    usage_limit: esperado.usage_limit,
    starts_at: iso(link.validFrom),
    expires_at: iso(link.validUntil),
    discount_tier: { discount: esperado.discount },
  };
  if (!corpo.expires_at) delete corpo.expires_at;
  if (!corpo.starts_at) delete corpo.starts_at;
  return {
    ok: problemas.length === 0,
    problemas,
    request: {
      method: 'POST',
      path: '/v1/stores/promotions/standard',
      headers: { 'Idempotency-Key': chaveDeCriacao(link.id, corpo) },
      body: corpo,
      escopoExigido: ESCOPO_ESCRITA,
    },
  };
}

// ── Leitura normalizada e comparação ────────────────────────────────────────────────────────────
const numeroOuNulo = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : NaN));
const listaOrdenada = (v) => (Array.isArray(v) ? [...v].map(Number).sort((a, b) => a - b) : []);
const mesmaLista = (a, b) => JSON.stringify(listaOrdenada(a)) === JSON.stringify(listaOrdenada(b));
const TOLERANCIA_MS = 60000;

// O que a INK devolve, em formato comparável (a INK manda `discount` como string; o corpo de escrita, como número).
function normalizarPromocao(p) {
  const tiers = Array.isArray(p.discount_tiers) ? p.discount_tiers : [];
  const tier = tiers[0] || null;
  return {
    id: p.id ?? null,
    type: p.type ?? null,
    code: p.code ? normalizarCodigo(p.code) : null,
    kind: p.kind ?? null,
    tiers: tiers.length,
    discount: tier ? numeroOuNulo(tier.discount) : null,
    min_cart_value: tier ? numeroOuNulo(tier.min_cart_value) : null,
    min_cart_items: tier ? numeroOuNulo(tier.min_cart_items) : null,
    list_type: p.list_type ?? null,
    product_ids: p.product_ids || [],
    product_type_ids: p.product_type_ids || [],
    collection_ids: p.collection_ids || [],
    first_purchase: p.first_purchase,
    usage_limit: p.usage_limit === undefined ? undefined : p.usage_limit,
    apply_automatically: p.apply_automatically,
    show_on_product_page: p.show_on_product_page,
    show_in_cart: p.show_in_cart,
    starts_at: p.starts_at ? new Date(p.starts_at) : null,
    expires_at: p.expires_at ? new Date(p.expires_at) : null,
    available: p.available,
  };
}

// Divergências entre o esperado no Oria e a promoção observada. `campo` identifica o que difere (para relatório e para o PATCH).
// `available` é estado OPERACIONAL calculado pela INK: só vira divergência se a promoção deveria estar valendo agora e não está.
function diferencas(link, promocao, agora = new Date()) {
  const e = configuracaoEsperada(link);
  const o = normalizarPromocao(promocao);
  const d = [];
  const add = (campo, mensagem, patchavel = true) => d.push({ campo, mensagem, patchavel });
  if (o.type !== 'standard') add('type', `tipo ${o.type || 'desconhecido'} (esperado standard; o tipo não pode ser alterado)`, false);
  if (o.code !== e.code) add('code', 'código diferente', false);
  if (o.kind !== e.kind) add('kind', 'tipo de desconto diferente (percentual/valor)');
  if (o.tiers !== 1) add('discount_tier', `${o.tiers} patamares de desconto (esperado 1)`, false);
  else {
    if (!Number.isFinite(o.discount) || Math.abs(o.discount - e.discount) > 0.0001) add('discount_tier', 'valor do desconto diferente');
    const semGatilho = (v) => v === null || v === 0;
    if (!semGatilho(o.min_cart_value) || !semGatilho(o.min_cart_items)) add('trigger', 'a INK exige valor/quantidade mínima no carrinho (o Oria espera desconto sem gatilho)', false);
  }
  if (o.list_type !== e.list_type) add('list_type', `alcance ${o.list_type || 'desconhecido'} (esperado toda a loja)`);
  else if (!mesmaLista(o.product_ids, e.product_ids) || !mesmaLista(o.product_type_ids, e.product_type_ids) || !mesmaLista(o.collection_ids, e.collection_ids)) add('scope_ids', 'IDs de escopo diferentes');
  if (o.first_purchase !== e.first_purchase) add('first_purchase', 'restrição de primeira compra diferente');
  if (o.usage_limit !== undefined && (o.usage_limit ?? null) !== e.usage_limit) add('usage_limit', 'limite de usos diferente');
  if (o.apply_automatically !== e.apply_automatically) add('apply_automatically', 'aplicação automática diferente (o cupom de afiliado é digitado pelo cliente)');
  if (o.show_on_product_page !== e.show_on_product_page) add('show_on_product_page', 'exibição na página do produto diferente');
  if (o.show_in_cart !== e.show_in_cart) add('show_in_cart', 'exibição no carrinho diferente');
  // Vigência, comparada por DIA no fuso da loja (a INK e o Oria falam em datas; o painel da INK grava o "fim do dia" em fusos/horas próprios).
  // Início da INK em dia POSTERIOR ao do Oria = o cupom não funciona quando o Oria acha que sim. Fim da INK em dia POSTERIOR (ou sem fim) = o desconto
  // continua depois de o Oria parar de comissionar. Fim da INK até 1 dia ANTES é tolerado (normalização de fuso; só encurta o desconto).
  const tz = link.timezone || TZ_PADRAO;
  const dia = (d) => dataLocal(d, tz);
  const br = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  const dias = (iso) => { const [a, m, dd] = iso.split('-').map(Number); return Date.UTC(a, m - 1, dd) / 86400000; };
  if (o.starts_at && e.starts_at && dia(o.starts_at) > dia(e.starts_at)) add('starts_at', `início da vigência na INK (${br(dia(o.starts_at))}) é posterior ao do Oria (${br(dia(e.starts_at))})`);
  if (!o.expires_at && e.expires_at) add('expires_at', `fim da vigência diferente: a INK não tem fim e o Oria termina em ${br(dia(e.expires_at))}`);
  else if (o.expires_at && !e.expires_at) add('expires_at', `fim da vigência diferente: a INK termina em ${br(dia(o.expires_at))} e o cupom no Oria não tem fim`);
  else if (o.expires_at && e.expires_at) {
    const adiantamento = dias(dia(e.expires_at)) - dias(dia(o.expires_at)); // >0: a INK termina antes do Oria
    if (adiantamento < 0 || adiantamento > 1) add('expires_at', `fim da vigência diferente: INK ${br(dia(o.expires_at))} × Oria ${br(dia(e.expires_at))}`);
  }
  // Janela do Oria já encerrada (cupom pausado/encerrado): a promoção também estar fora do ar é o esperado, não divergência.
  const janelaAberta = !(e.expires_at && e.expires_at.getTime() <= agora.getTime());
  if (janelaAberta && o.available === false && !(o.starts_at && o.starts_at.getTime() > agora.getTime() - TOLERANCIA_MS) && !d.some((x) => x.campo === 'expires_at')) add('available', 'promoção indisponível agora na INK (expirada ou limite de usos atingido)', false);
  return d;
}

const compararComPromocao = (link, promocao, agora) => (promocao ? diferencas(link, promocao, agora).map((x) => x.mensagem) : ['cupom não encontrado na INK']);

// PATCH parcial só com campos que pertencem à promoção; o que a INK não deixa alterar (código, tipo, gatilho) volta em `naoSincronizaveis`.
function montarAtualizacao(link, promocao, agora) {
  const e = configuracaoEsperada(link);
  const dif = diferencas(link, promocao, agora);
  const patch = {};
  for (const x of dif.filter((y) => y.patchavel)) {
    if (x.campo === 'kind' || x.campo === 'discount_tier') { patch.kind = e.kind; patch.discount_tier = { discount: e.discount }; }
    else if (x.campo === 'list_type' || x.campo === 'scope_ids') { patch.list_type = e.list_type; patch.product_ids = []; patch.product_type_ids = []; patch.collection_ids = []; }
    else if (x.campo === 'starts_at') patch.starts_at = iso(e.starts_at);
    else if (x.campo === 'expires_at') patch.expires_at = e.expires_at ? iso(e.expires_at) : null;
    else patch[x.campo] = e[x.campo];
  }
  return { patch, campos: dif.filter((y) => y.patchavel).map((y) => y.campo), naoSincronizaveis: dif.filter((y) => !y.patchavel).map((y) => y.mensagem) };
}

function instantaneo(promocao) {
  const n = normalizarPromocao(promocao);
  return {
    inkPromotionId: n.id, type: n.type, code: n.code, kind: n.kind, discount: n.discount, minCartValue: n.min_cart_value, minCartItems: n.min_cart_items,
    listType: n.list_type, firstPurchase: n.first_purchase ?? null, usageLimit: n.usage_limit ?? null, applyAutomatically: n.apply_automatically ?? null,
    showOnProductPage: n.show_on_product_page ?? null, showInCart: n.show_in_cart ?? null,
    startsAt: n.starts_at ? n.starts_at.toISOString() : null, expiresAt: n.expires_at ? n.expires_at.toISOString() : null, available: n.available ?? null,
  };
}

/**
 * @param {{ client?: {get?: Function, post?: Function, patch?: Function, delete?: Function}|null,
 *           scopes?: string[]|null, relogio?: () => Date, tentativas?: number, esperar?: (ms:number)=>Promise }} deps
 *   `client.get(path)`, `client.post(path, body, headers)`, `client.patch(path, body, headers)`, `client.delete(path, headers)` — injetados.
 *   `scopes` (opcional) = escopos declarados do connector: se informado e sem `store.promotions.write`, nenhuma escrita sai; se ausente, tenta e a INK responde 403.
 */
function createInkPromotionsAdapter({ client = null, scopes = null, relogio = () => new Date(), tentativas = 2, esperar = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  // Capacidades do connector (é o que decide entre "criar na INK" e o modo manual). Nenhum request é feito para descobrir.
  const capacidades = () => ({ provider: 'ink', read: !!client && typeof client.get === 'function', create: !!client && typeof client.post === 'function', update: !!client && typeof client.patch === 'function', delete: !!client && typeof client.delete === 'function' });

  // Por que uma escrita não pode acontecer agora (null = pode). Se `scopes` foi declarado, precisa listar o de escrita.
  function bloqueioDeEscrita(metodo) {
    if (!client || typeof client[metodo] !== 'function') return new PromotionWritesUnavailableError();
    if (Array.isArray(scopes) && !scopes.includes(ESCOPO_ESCRITA)) return new PromotionPermissionError(ESCOPO_ESCRITA);
    return null;
  }
  const exigirEscrita = (metodo) => { const b = bloqueioDeEscrita(metodo); if (b) throw b; };

  // Retry só de falha TRANSITÓRIA e sempre com o MESMO pedido (mesma Idempotency-Key, já calculada fora): se a 1ª tentativa chegou na INK e só a
  // resposta se perdeu, a INK devolve o resultado original em vez de duplicar. 401/403/404/409/422 nunca são repetidos.
  const escrever = async (fn) => {
    for (let i = 1; ; i += 1) {
      try { return await fn(); } catch (err) {
        const t = traduzirErro(err);
        if (!TRANSITORIOS.has(t.codigo) || i >= tentativas) throw t;
        await esperar(200 * i);
      }
    }
  };
  const lerCom = async (caminho) => {
    if (!client || typeof client.get !== 'function') return null;
    try { return await client.get(caminho); } catch (err) { throw traduzirErro(err); }
  };

  // Só monta o pedido: NUNCA faz chamada. É o "preview".
  function previsualizarCriacao(link) {
    const montado = montarPedidoDeCriacao(link);
    const bloqueio = bloqueioDeEscrita('post');
    return { ...montado, criacaoDisponivel: bloqueio === null, enviaria: montado.ok && bloqueio === null, bloqueio: bloqueio ? bloqueio.codigo : null };
  }

  // GET /v1/stores/promotions?code=… — o envelope precisa ter `promotions` (array); qualquer outro formato é ERRO, nunca "não achou".
  async function buscarPorCodigo(codigo) {
    if (!client || typeof client.get !== 'function') return { disponivel: false, motivo: 'cliente_indisponivel', promocoes: [], total: 0 };
    const code = normalizarCodigo(codigo);
    const dados = await lerCom(`/v1/stores/promotions?code=${encodeURIComponent(code)}&per_page=5`);
    if (!dados || !Array.isArray(dados.promotions)) throw new PromotionApiError('INK_BAD_RESPONSE', 'resposta da INK sem a lista de promoções');
    const total = Number.isInteger(dados.total_count) ? dados.total_count : dados.promotions.length;
    return { disponivel: true, promocoes: dados.promotions, total };
  }

  // GET /v1/stores/promotions/{id} → { promotion } · 404 = promoção inexistente/excluída (null).
  async function buscarPorId(id) {
    if (!client || typeof client.get !== 'function') return { disponivel: false, promocao: null };
    if (!Number.isInteger(Number(id)) || Number(id) < 1) throw new PromotionApiError('INK_INVALID_ID', 'ID de promoção inválido');
    try {
      const dados = await client.get(`/v1/stores/promotions/${Number(id)}`);
      if (!dados || typeof dados.promotion !== 'object' || dados.promotion === null) throw new PromotionApiError('INK_BAD_RESPONSE', 'resposta da INK sem a promoção');
      return { disponivel: true, promocao: dados.promotion };
    } catch (err) {
      const t = traduzirErro(err);
      if (t.codigo === 'INK_NOT_FOUND') return { disponivel: true, promocao: null };
      throw t;
    }
  }

  function avaliar(link, promocao) {
    const dif = diferencas(link, promocao, relogio());
    return { status: dif.length ? 'divergent' : 'confirmed', divergencias: dif.map((x) => x.mensagem), campos: dif.map((x) => x.campo), promotionId: promocao.id ?? null, observada: instantaneo(promocao) };
  }

  // Verificação por código (caso A). Vários resultados exatos, ou mais do que cabe na página, é anomalia: não escolhemos uma ao acaso.
  async function verificarCupom(link) {
    const r = await buscarPorCodigo(link.codeNormalized);
    if (!r.disponivel) return { status: 'unavailable', divergencias: [], promocoes: 0 };
    const exatas = r.promocoes.filter((p) => normalizarCodigo(p.code) === normalizarCodigo(link.codeNormalized));
    if (exatas.length > 1 || (exatas.length === 0 && r.total > r.promocoes.length)) {
      return { status: 'ambiguous', divergencias: ['a INK devolveu mais de uma promoção para o código; resolva no painel da INK'], promocoes: Math.max(exatas.length, r.total) };
    }
    if (exatas.length === 0) return { status: 'not_found', divergencias: ['cupom não encontrado na INK'], promocoes: 0 };
    return { ...avaliar(link, exatas[0]), promocoes: 1 };
  }

  // Confere uma promoção já conhecida pelo ID (usado depois do POST e nas sincronizações).
  async function verificarPorId(link, promotionId) {
    const r = await buscarPorId(promotionId);
    if (!r.disponivel) return { status: 'unavailable', divergencias: [] };
    if (!r.promocao) return { status: 'not_found', divergencias: ['promoção não existe mais na INK'] };
    return avaliar(link, r.promocao);
  }

  // POST standard (caso C). Ordem: flag → cliente → escopo → validação → conflito por código → POST → leitura de volta.
  async function criarPromocao(link) {
    exigirEscrita('post');
    const montado = montarPedidoDeCriacao(link);
    if (!montado.ok) throw Object.assign(new Error(`cupom inválido: ${montado.problemas.join('; ')}`), { codigo: 'INK_PROMOTION_INVALID', problemas: montado.problemas });
    const existentes = await buscarPorCodigo(link.codeNormalized);
    const conflito = existentes.promocoes.filter((p) => normalizarCodigo(p.code) === normalizarCodigo(link.codeNormalized));
    if (conflito.length > 0) throw new PromotionConflictError(link.codeNormalized, conflito);
    const criada = await escrever(() => client.post(montado.request.path, montado.request.body, montado.request.headers));
    const promocao = criada && criada.promotion && typeof criada.promotion === 'object' ? criada.promotion : null;
    if (!promocao || !Number.isInteger(Number(promocao.id))) throw new PromotionApiError('INK_BAD_RESPONSE', 'a INK respondeu sem uma promoção válida');
    // Leitura de volta: só "confirmado" se a INK devolver, por ID, o que foi criado. Falha aqui NÃO desfaz a criação (o ID já existe na INK).
    let confirmacao;
    try { confirmacao = await verificarPorId({ ...link }, Number(promocao.id)); } catch (err) { confirmacao = { status: 'unverified', divergencias: [], erro: err.codigo || 'INK_ERROR' }; }
    return { promotionId: Number(promocao.id), promocao, snapshot: instantaneo(promocao), confirmacao, idempotencyKey: montado.request.headers['Idempotency-Key'] };
  }

  // PATCH standard (parcial). Sem diferença patchável = não envia nada.
  async function atualizarPromocao(link, promotionId) {
    exigirEscrita('patch');
    const atual = await buscarPorId(promotionId);
    if (!atual.disponivel || !atual.promocao) throw new PromotionApiError('INK_NOT_FOUND', 'promoção não encontrada na INK (404)', { status: 404 });
    const plano = montarAtualizacao(link, atual.promocao, relogio());
    if (Object.keys(plano.patch).length === 0) return { atualizado: false, campos: [], naoSincronizaveis: plano.naoSincronizaveis, promotionId: Number(promotionId) };
    const chave = chaveDeAtualizacao(link.id, promotionId, plano.patch);
    const r = await escrever(() => client.patch(`/v1/stores/promotions/standard/${Number(promotionId)}`, plano.patch, { 'Idempotency-Key': chave }));
    const promocao = r && r.promotion && typeof r.promotion === 'object' ? r.promotion : null;
    if (!promocao) throw new PromotionApiError('INK_BAD_RESPONSE', 'a INK respondeu sem a promoção atualizada');
    return { atualizado: true, campos: plano.campos, naoSincronizaveis: plano.naoSincronizaveis, promotionId: Number(promotionId), snapshot: instantaneo(promocao), confirmacao: avaliar(link, promocao), idempotencyKey: chave };
  }

  // DELETE (soft delete; libera o código). Operação explícita — nunca é consequência de pausar/encerrar no Oria.
  async function excluirPromocao(linkId, promotionId) {
    exigirEscrita('delete');
    if (!Number.isInteger(Number(promotionId)) || Number(promotionId) < 1) throw new PromotionApiError('INK_INVALID_ID', 'ID de promoção inválido');
    const chave = chaveDeExclusao(linkId, promotionId);
    await escrever(() => client.delete(`/v1/stores/promotions/${Number(promotionId)}`, { 'Idempotency-Key': chave }));
    return { excluida: true, promotionId: Number(promotionId), idempotencyKey: chave };
  }

  return { previsualizarCriacao, buscarPorCodigo, buscarPorId, verificarCupom, verificarPorId, criarPromocao, atualizarPromocao, excluirPromocao, bloqueioDeEscrita, capacidades };
}

module.exports = {
  ESCOPO_LEITURA, ESCOPO_ESCRITA,
  PromotionWritesUnavailableError, PromotionConflictError, PromotionPermissionError, PromotionApiError,
  chaveDeCriacao, chaveDeAtualizacao, chaveDeExclusao, configuracaoEsperada, montarPedidoDeCriacao, montarAtualizacao, compararComPromocao, diferencas, instantaneo,
  traduzirErro, createInkPromotionsAdapter,
};
