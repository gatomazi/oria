'use strict';

// Link público (capability URL) do PRÓPRIO parceiro ver as vendas, a comissão e o saldo dele — NÃO é
// um portal do afiliado: não existe conta, senha, e-mail nem login. Quem tem o link (segredo opaco de
// 256 bits, no fragmento da URL — nunca na query string; ver src/pages/parcerias/PreviewAfiliadoPage.tsx
// e o mesmo cuidado de lib/auth/invites.js), vê os dados; ninguém mais. Cabeçalho completo da tabela
// e da função de resolução: migrations/sql/0046-parceiro-preview-links.up.sql.
//
// Duas metades:
//   gestão (gerarLink/revogarLink/statusDoLink) — rotas normais do painel, autenticadas, owner-only.
//   leitura pública (montarPreview) — chamada pela rota pública, DEPOIS que server.js já resolveu
//     `{organizationId, storeId, partnerId}` via `publico_organization_do_preview_afiliado` +
//     `comOrganizacaoResolvida` (mesmo caminho de pedido/mídia/agente do WhatsApp Web). Este módulo
//     nunca vê o token cru nem o hash: recebe só o resultado já resolvido.

const crypto = require('crypto');
const db = require('./db');
const { intervaloLocal, dataLocal } = require('./schedule');

const { conflito, exigirUuid } = db;

const TOKEN_BYTES = 32; // 256 bits — mesmo tamanho do token de convite (lib/auth/invites.js)
const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
const TAMANHO_PAGINA_VENDAS = 20;
// Prioridade pra escolher o status "pior caso" de um pedido com vários itens (ex.: um item liberado e
// outro ainda em carência) — o que ainda pesa mais pro afiliado entender o que falta.
const PRIORIDADE_STATUS = { manual_review: 4, held: 3, provisional: 3, released: 2, reversed: 1 };

function criarPreview({ pool, relogio = () => new Date(), registry, payables, progressao }) {
  // ── Gestão (owner autenticado, tenant-scoped) ─────────────────────────────────────────────────
  async function statusDoLink(ctx, partnerId) {
    const pid = exigirUuid(partnerId, 'parceiro');
    await registry.obterParceiroBasico(pool, ctx, pid); // 404 se o parceiro não existir/não for desta Organization
    const { rows } = await pool.query(
      `SELECT created_at, last_accessed_at, access_count FROM partner_preview_links WHERE organization_id = $1 AND partner_id = $2 AND status = 'active'`,
      [ctx.organizationId, pid]
    );
    if (!rows[0]) return { ativo: false };
    return { ativo: true, createdAt: rows[0].created_at, lastAccessedAt: rows[0].last_accessed_at, accessCount: Number(rows[0].access_count) };
  }

  // Gera (ou regenera) o link. O token CRU só existe aqui e na resposta desta chamada — nunca é
  // persistido, nunca é logado, e não há como recuperá-lo depois (igual ao aceite de convite).
  // Regenerar REVOGA o anterior na mesma transação: nunca dois links ativos ao mesmo tempo.
  async function gerarLink(ctx, partnerId) {
    const pid = exigirUuid(partnerId, 'parceiro');
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const hash = sha256(token);
    return db.tx(pool, async (c) => {
      const parceiro = await registry.obterParceiroBasico(c, ctx, pid, { travar: true });
      await c.query(`UPDATE partner_preview_links SET status = 'revoked', revoked_at = now() WHERE organization_id = $1 AND partner_id = $2 AND status = 'active'`, [ctx.organizationId, pid]);
      await c.query(
        `INSERT INTO partner_preview_links (organization_id, store_id, partner_id, key_hash, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [ctx.organizationId, ctx.storeId, pid, hash, ctx.userId || null]
      );
      // Auditoria guarda só o PREFIXO do hash (12 hex, mesma régua de lib/auth/invites.js `referencia()`)
      // — nunca o suficiente para reconstruir o link, só para cruzar com um log de acesso se precisar.
      await db.auditar(c, ctx, { entidade: 'partner', entidadeId: pid, acao: 'partner.preview_link.create', depois: { keyHashPrefix: hash.slice(0, 12) } });
      return { token, partnerName: parceiro.public_name };
    });
  }

  async function revogarLink(ctx, partnerId) {
    const pid = exigirUuid(partnerId, 'parceiro');
    return db.tx(pool, async (c) => {
      await registry.obterParceiroBasico(c, ctx, pid);
      const { rows } = await c.query(
        `UPDATE partner_preview_links SET status = 'revoked', revoked_at = now() WHERE organization_id = $1 AND partner_id = $2 AND status = 'active' RETURNING id`,
        [ctx.organizationId, pid]
      );
      if (!rows[0]) throw conflito('AFILIADOS_SEM_LINK_ATIVO', 'este parceiro não tem link público ativo para revogar');
      await db.auditar(c, ctx, { entidade: 'partner', entidadeId: pid, acao: 'partner.preview_link.revoke' });
      return { revogado: true };
    });
  }

  // ── Leitura pública ────────────────────────────────────────────────────────────────────────────
  // `ctx`/`storeId`/`partnerId` já vêm resolvidos e travados pelo servidor (nunca de entrada do
  // cliente). Devolve `null` para "nada a mostrar" — o servidor traduz para a mesma resposta genérica
  // de link inválido/revogado, sem diferenciar o motivo (mesma lição do aceite de convite).
  // `filtros` vêm do corpo da rota pública, já brutos (nunca confiar) — datas fora do formato ou
  // invertidas são apenas IGNORADAS (mostra tudo), nunca viram erro de validação: é uma página sem
  // login, pro afiliado, não um formulário administrativo.
  async function montarPreview(ctx, partnerId, filtros = {}) {
    const parceiro = await registry.obterParceiroBasico(pool, ctx, partnerId).catch(() => null);
    // Vínculo encerrado: o link não deve seguir mostrando dado vivo de uma parceria que já terminou.
    // Não é "link inválido" no banco — é uma regra de exibição, então fica aqui, não na resolução.
    if (!parceiro || parceiro.relationship_status === 'ended') return null;
    const settings = await registry.lerConfig(ctx);
    const agora = relogio();
    // KPIs são sempre o TOTAL do parceiro — nunca mudam com o filtro da tabela (mesmo padrão do resto
    // do painel: "A pagar" também mantém os KPIs fixos e só filtra a lista abaixo).
    const extrato = await payables.extratoDoParceiro(ctx, partnerId, { limit: '200' });
    const nivel = await progressao.avaliarParceiro(ctx, partnerId).catch(() => null);

    const desde = RE_DATA.test(String(filtros.desde || '')) ? String(filtros.desde) : null;
    const ate = RE_DATA.test(String(filtros.ate || '')) ? String(filtros.ate) : null;
    let intervalo = null;
    if (desde || ate) {
      try { intervalo = intervaloLocal(desde || '2000-01-01', ate || dataLocal(agora, settings.timezone), settings.timezone); } catch { intervalo = null; }
    }
    const statusPagamento = filtros.status === 'pago' || filtros.status === 'pendente' ? filtros.status : null;
    const pagina = Math.max(1, Number.parseInt(filtros.page, 10) || 1);

    // Busca os lançamentos de comissão (não limitados à janela dos KPIs) filtrados por data da venda,
    // pra a paginação/filtro cobrir o histórico inteiro, não só os últimos 200 lançamentos.
    const linhas = await payables.lancamentosFiltrados(
      ctx, { partnerId, category: 'commission', dateType: 'sale', intervalo }, settings.timezone, agora, { executor: pool }
    );

    // Agrupa por pedido da INK (só o id — nunca dado de comprador, que as tabelas do módulo nem
    // guardam) para uma leitura "Pedido · N itens", como o extrato do owner.
    const porPedido = new Map();
    for (const r of linhas) {
      if (r.ink_order_id === null) continue;
      const id = String(r.ink_order_id);
      if (!porPedido.has(id)) {
        porPedido.set(id, { inkOrderId: id, saleAt: r.sale_at, itens: 0, commissionCents: 0, paidCents: 0, abertoCents: 0, status: r.eff_status, dueAt: r.due_at, estimatedPaymentAt: r.estimated_payment_at });
      }
      const p = porPedido.get(id);
      p.itens += 1;
      p.commissionCents += Number(r.amount_cents);
      p.paidCents += Number(r.pago);
      p.abertoCents += Number(r.aberto);
      if (new Date(r.sale_at) < new Date(p.saleAt)) p.saleAt = r.sale_at;
      if ((PRIORIDADE_STATUS[r.eff_status] || 0) > (PRIORIDADE_STATUS[p.status] || 0)) p.status = r.eff_status;
    }

    let vendas = [...porPedido.values()].map((p) => ({
      ...p,
      // "pago" = nada em aberto (quitado); "parcial" = pagou parte; "pendente" = nada pago ainda.
      // Distinto do `status` técnico do lançamento (provisionado/em carência/liberado/…): isso aqui é
      // especificamente "já caiu na sua conta ou não", que é o que o afiliado quer saber primeiro.
      paymentStatus: p.abertoCents === 0 ? 'pago' : p.paidCents > 0 ? 'parcial' : 'pendente',
    }));
    if (statusPagamento === 'pago') vendas = vendas.filter((v) => v.abertoCents === 0);
    else if (statusPagamento === 'pendente') vendas = vendas.filter((v) => v.abertoCents !== 0);
    vendas.sort((a, b) => new Date(b.saleAt) - new Date(a.saleAt));

    const total = vendas.length;
    const totalPages = Math.max(1, Math.ceil(total / TAMANHO_PAGINA_VENDAS));
    const paginaValida = Math.min(pagina, totalPages);
    const vendasDaPagina = vendas
      .slice((paginaValida - 1) * TAMANHO_PAGINA_VENDAS, paginaValida * TAMANHO_PAGINA_VENDAS)
      .map(({ abertoCents, ...v }) => v); // abertoCents é só pra classificar/filtrar — não é dado a expor

    return {
      partnerName: parceiro.public_name,
      level: nivel ? { key: nivel.currentLevel.key, label: nivel.currentLevel.label } : null,
      kpis: {
        // Unidades ELEGÍVEIS atribuídas a ele (mesma métrica de níveis: levels.js `metricasDaJanela`),
        // não o total bruto do pedido — devolução/quantidade grátis já saem daqui.
        unidadesAtribuidas: extrato.itens.reduce((soma, i) => soma + (i.eligibleQty || 0), 0),
        commissionTotalCents: extrato.totais.grossCents + extrato.totais.adjustmentsCents,
        commissionPaidCents: extrato.totais.paidCents,
        commissionBalanceCents: extrato.totais.netBalanceCents,
      },
      vendas: vendasDaPagina,
      paginacao: { page: paginaValida, totalPages, total },
      filtros: { desde, ate, status: statusPagamento },
      atualizadoEm: relogio().toISOString(),
    };
  }

  return { statusDoLink, gerarLink, revogarLink, montarPreview };
}

module.exports = { criarPreview, sha256, TOKEN_BYTES };
