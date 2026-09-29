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

const { conflito, exigirUuid } = db;

const TOKEN_BYTES = 32; // 256 bits — mesmo tamanho do token de convite (lib/auth/invites.js)
const sha256 = (valor) => crypto.createHash('sha256').update(valor).digest('hex');

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
  async function montarPreview(ctx, partnerId) {
    const parceiro = await registry.obterParceiroBasico(pool, ctx, partnerId).catch(() => null);
    // Vínculo encerrado: o link não deve seguir mostrando dado vivo de uma parceria que já terminou.
    // Não é "link inválido" no banco — é uma regra de exibição, então fica aqui, não na resolução.
    if (!parceiro || parceiro.relationship_status === 'ended') return null;
    const extrato = await payables.extratoDoParceiro(ctx, partnerId, { limit: '100' });
    const nivel = await progressao.avaliarParceiro(ctx, partnerId).catch(() => null);

    // Agrupa os lançamentos de comissão por pedido da INK (só o id — nunca dado de comprador, que
    // as tabelas do módulo nem guardam) para uma leitura "Pedido · N itens", como o extrato do owner.
    const porPedido = new Map();
    for (const item of extrato.itens) {
      if (item.category !== 'commission' || item.inkOrderId === null) continue;
      if (!porPedido.has(item.inkOrderId)) {
        porPedido.set(item.inkOrderId, { inkOrderId: item.inkOrderId, saleAt: item.saleAt, itens: 0, commissionCents: 0, status: item.status, dueAt: item.dueAt, estimatedPaymentAt: item.estimatedPaymentAt });
      }
      const p = porPedido.get(item.inkOrderId);
      p.itens += 1;
      p.commissionCents += item.amountCents;
      if (new Date(item.saleAt) < new Date(p.saleAt)) p.saleAt = item.saleAt;
    }
    const vendas = [...porPedido.values()].sort((a, b) => new Date(b.saleAt) - new Date(a.saleAt)).slice(0, 50);

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
      vendas,
      atualizadoEm: relogio().toISOString(),
    };
  }

  return { statusDoLink, gerarLink, revogarLink, montarPreview };
}

module.exports = { criarPreview, sha256, TOKEN_BYTES };
