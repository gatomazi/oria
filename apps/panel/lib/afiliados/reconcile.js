'use strict';

// Reconciliação: lê pedidos/itens JÁ sincronizados (pedidos_ink*), roda o motor por item e persiste atribuições, ledger,
// itens em revisão e créditos de benefício — de forma IDEMPOTENTE e sob lock por pedido.
//
//   - Nenhuma chamada à API da INK: a fonte é o cache que o sync/webhook existentes alimentam. `begin_date` da INK busca por
//     data de CRIAÇÃO; por isso pedidos com comissão ainda não final são reavaliados a cada rodada.
//   - O ledger só recebe DELTAS (alvo − soma dos lançamentos da atribuição): reprocessar o mesmo estado não duplica; um estorno
//     vira lançamento compensatório e o histórico original permanece. Valor já pago nunca é editado.
//   - Evento antigo não reabre pedido cancelado: o estado é sempre o CORRENTE do cache, não o do evento.

const db = require('./db');
const { centavosDeDecimal, percentualDe } = require('./money');
const { apurarPedido, normalizarCodigo } = require('./engine');
const { calcularLiberacao, calcularVencimento, competenciaDoMes } = require('./schedule');

const ESTADOS_SEM_COMISSAO = new Set(['canceled', 'refunded', 'chargeback']);
const LIMITE_POR_RODADA = 3000;
const TAMANHO_LOTE = 100;

function criarReconciliador({ pool, relogio = () => new Date(), registry }) {
  // ── Configuração em memória (pequena: dezenas/centenas de linhas por loja) ───────────────────────
  async function carregarConfiguracao(c, ctx) {
    const org = [ctx.organizationId];
    // Sequencial de propósito: `c` é UM cliente; pg não aceita queries concorrentes na mesma conexão (deprecado no pg 8, removido no 9).
    const cupons = await c.query('SELECT * FROM partner_coupon_links WHERE organization_id = $1', org);
    const collabs = await c.query('SELECT * FROM partner_collabs WHERE organization_id = $1', org);
    const membros = await c.query('SELECT * FROM partner_collab_product_memberships WHERE organization_id = $1', org);
    const criadores = await c.query('SELECT * FROM partner_collab_creators WHERE organization_id = $1', org);
    const parceiros = await c.query('SELECT id, legacy_ink_affiliate FROM partnership_partners WHERE organization_id = $1', org);
    const versoes = await c.query(
      `SELECT v.*, k.modality, k.partner_id FROM partnership_contract_versions v JOIN partnership_contracts k ON k.id = v.contract_id AND k.organization_id = v.organization_id
        WHERE v.organization_id = $1 ORDER BY v.contract_id, v.effective_from, v.version`, org
    );
    const porContrato = new Map();
    const porId = new Map();
    for (const v of versoes.rows) {
      const m = {
        id: v.id, contractId: v.contract_id, version: v.version, status: v.status, modality: v.modality, partnerId: v.partner_id, effectiveFrom: new Date(v.effective_from),
        commissionBasis: v.commission_basis, commissionBps: v.commission_bps, fixedPerUnitCents: v.fixed_per_unit_cents === null ? null : Number(v.fixed_per_unit_cents),
        conflictPolicy: v.conflict_policy, splitCouponBps: v.split_coupon_bps, splitCollabBps: v.split_collab_bps, levelKey: v.level_key,
        releasePolicy: v.release_policy, releaseHoldDays: v.release_hold_days, payoutDay: v.payout_day, payoutMonthOffset: v.payout_month_offset,
        minPayoutCents: Number(v.min_payout_cents), weekendShift: v.weekend_shift,
      };
      if (!porContrato.has(v.contract_id)) porContrato.set(v.contract_id, []);
      porContrato.get(v.contract_id).push(m);
      porId.set(v.id, m);
    }
    const versionAt = (contractId, instante) => {
      const lista = porContrato.get(contractId) || [];
      let escolhida = null;
      for (const v of lista) if (v.effectiveFrom.getTime() <= instante.getTime()) escolhida = v; // lista já ordenada por (effective_from, version)
      return escolhida;
    };
    const membrosPorCollab = new Map();
    for (const m of membros.rows) {
      if (!membrosPorCollab.has(m.collab_id)) membrosPorCollab.set(m.collab_id, []);
      membrosPorCollab.get(m.collab_id).push({
        productId: String(m.ink_product_id), variantId: m.ink_variant_id === null ? null : String(m.ink_variant_id), status: m.status, validFrom: m.valid_from, validTo: m.valid_to,
      });
    }
    const criadoresPorCollab = new Map();
    for (const cr of criadores.rows) {
      if (!criadoresPorCollab.has(cr.collab_id)) criadoresPorCollab.set(cr.collab_id, []);
      criadoresPorCollab.get(cr.collab_id).push({ partnerId: cr.partner_id, contractId: cr.contract_id, shareBps: cr.share_bps, validFrom: cr.valid_from, validTo: cr.valid_to });
    }
    return {
      coupons: cupons.rows.map((l) => ({ id: l.id, partnerId: l.partner_id, contractId: l.contract_id, codeNormalized: l.code_normalized, validFrom: l.valid_from, validUntil: l.valid_until, status: l.status })),
      collabs: collabs.rows.map((k) => ({ id: k.id, startsAt: k.starts_at, endsAt: k.ends_at, memberships: membrosPorCollab.get(k.id) || [], creators: criadoresPorCollab.get(k.id) || [] })),
      partners: Object.fromEntries(parceiros.rows.map((p) => [p.id, { legacyInkAffiliate: p.legacy_ink_affiliate }])),
      versionAt,
      versionById: (id) => porId.get(id) || null,
      inicioMinimo: [...cupons.rows.filter((l) => !['planned', 'pending_validation'].includes(l.status)).map((l) => new Date(l.valid_from)),
        ...membros.rows.filter((m) => m.valid_from).map((m) => new Date(m.valid_from))].reduce((min, d) => (min === null || d < min ? d : min), null),
    };
  }

  // ── Pedido do cache → entrada do motor ──────────────────────────────────────────────────────────
  function montarEntrada(pedido, itens, cfg, overrides, settings) {
    const dec = (v) => centavosDeDecimal(v) ?? 0;
    const completo = pedido.affiliate_snapshot_at !== null;
    return {
      order: {
        inkOrderId: String(pedido.ink_order_id), createdAt: new Date(pedido.criado_em), paymentStatus: pedido.payment_status, orderStatus: pedido.order_status,
        isExchange: pedido.is_troca === true, deliveredAt: pedido.delivered_at ? new Date(pedido.delivered_at) : null, snapshotComplete: completo,
        promotionCode: pedido.promotion_code, promotionValueCents: dec(pedido.promotion_value), paymentDiscountCents: dec(pedido.payment_discount_value),
        freightDifferenceCents: dec(pedido.freight_value_difference), kickbackCents: pedido.kickback_value === null ? null : dec(pedido.kickback_value),
      },
      items: itens.map((i) => ({
        itemId: String(i.item_id), productId: i.produto_id === null ? null : String(i.produto_id), variantId: i.product_variant_id === null ? null : String(i.product_variant_id),
        clusterId: i.product_cluster_id === null ? null : String(i.product_cluster_id), quantity: i.quantidade, freeQuantity: i.free_quantity || 0, refundedQuantity: i.refunded_quantity || 0,
        totalValueCents: dec(i.valor_venda), sku: i.sku,
        unitCostCents: completo && i.unit_ink_base_price !== null ? dec(i.unit_ink_base_price) + dec(i.unit_additional_service_price) : null,
      })),
      coupons: cfg.coupons, collabs: cfg.collabs, partners: cfg.partners, versionAt: cfg.versionAt, minContributionBps: settings.minContributionBps, overrides,
    };
  }

  // ── Ciclo de vida do lançamento ─────────────────────────────────────────────────────────────────
  function cicloDeVida({ orderState, versao, entregueEm, pagoObservadoEm, agora, tz }) {
    if (ESTADOS_SEM_COMISSAO.has(orderState)) return { status: 'held', holdReason: `order_${orderState}`, releaseAt: null, estimatedAt: null, dueAt: null };
    if (orderState === 'awaiting_payment') return { status: 'provisional', holdReason: 'awaiting_payment', releaseAt: null, estimatedAt: null, dueAt: null };
    if (orderState === 'disputed') return { status: 'held', holdReason: 'dispute', releaseAt: null, estimatedAt: null, dueAt: null };
    const releaseAt = calcularLiberacao({ politica: versao.releasePolicy, holdDias: versao.releaseHoldDays, entregueEm: orderState === 'delivered' ? entregueEm : null, pagoObservadoEm });
    if (!releaseAt) return { status: 'provisional', holdReason: versao.releasePolicy === 'payment_plus_days' ? 'awaiting_payment' : 'awaiting_delivery', releaseAt: null, estimatedAt: null, dueAt: null };
    const estimatedAt = calcularVencimento({ liberadoEm: releaseAt, diaPagamento: versao.payoutDay, mesesDepois: versao.payoutMonthOffset, deslocarFimDeSemana: versao.weekendShift, tz });
    const liberado = releaseAt.getTime() <= agora.getTime();
    return { status: liberado ? 'released' : 'held', holdReason: liberado ? null : 'release_hold', releaseAt, estimatedAt, dueAt: liberado ? estimatedAt : null };
  }

  async function sincronizarLedger(c, ctx, cfg, attr, atual, pedido, settings, agora) {
    const versao = cfg.versionById(attr.contract_version_id);
    if (!versao) return;
    const { rows: lancs } = await c.query(
      `SELECT l.*, COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = l.organization_id AND a.ledger_id = l.id), 0)::bigint AS pago
         FROM partner_commission_ledger l WHERE l.organization_id = $1 AND l.attribution_id = $2 AND l.category = 'commission' ORDER BY l.created_at, l.id FOR UPDATE OF l`,
      [ctx.organizationId, attr.id]
    );
    const alvo = attr.status === 'calculated' ? Number(atual.targetCommissionCents) : null;
    const estado = atual.orderState;
    let soma = lancs.reduce((s, l) => s + Number(l.amount_cents), 0);
    const pagoAlgum = lancs.some((l) => Number(l.pago) !== 0);
    const ciclo = cicloDeVida({ orderState: estado, versao, entregueEm: pedido.delivered_at ? new Date(pedido.delivered_at) : null, pagoObservadoEm: atual.paidObservedAt ? new Date(atual.paidObservedAt) : null, agora, tz: settings.timezone });

    let todos = lancs;
    if (alvo !== null && alvo !== soma) {
      const delta = alvo - soma;
      const { rows } = await c.query(
        `INSERT INTO partner_commission_ledger (organization_id, store_id, partner_id, attribution_id, contract_version_id, entry_type, category, amount_cents, status, sale_at, competence, origin_key, note)
         VALUES ($1,$2,$3,$4,$5,$6,'commission',$7,$8,$9,$10,$11,$12) ON CONFLICT (organization_id, partner_id, origin_key) DO NOTHING RETURNING *`,
        [ctx.organizationId, ctx.storeId, attr.partner_id, attr.id, attr.contract_version_id, lancs.length === 0 ? 'accrual' : 'adjustment', delta, ciclo.status, attr.sale_at,
          competenciaDoMes(new Date(attr.sale_at), settings.timezone), `attr:${attr.id}:seq:${lancs.length}`,
          lancs.length === 0 ? null : `ajuste por mudança no pedido (${estado})`]
      );
      if (rows[0]) { todos = [...lancs, { ...rows[0], pago: 0 }]; soma += delta; }
    }
    if (todos.length === 0) return;

    // Estorno líquido sem pagamento algum: os lançamentos se anulam e saem da fila de pagamento (histórico intacto).
    const anulado = soma === 0 && !pagoAlgum;
    for (const l of todos) {
      if (Number(l.pago) !== 0) continue; // lançamento já (parcialmente) pago: datas congeladas
      const positivo = Number(l.amount_cents) > 0;
      let novo;
      if (anulado) novo = { status: 'reversed', holdReason: 'net_zero', releaseAt: l.release_at, estimatedAt: l.estimated_payment_at, dueAt: null };
      else if (!positivo && pagoAlgum) novo = { status: 'released', holdReason: null, releaseAt: agora, estimatedAt: null, dueAt: null }; // compensa no próximo pagamento
      else novo = ciclo;
      const dueAt = l.due_at_overridden ? l.due_at : novo.dueAt;
      const mudou = l.status !== novo.status || (l.hold_reason || null) !== (novo.holdReason || null)
        || +new Date(l.release_at || 0) !== +new Date(novo.releaseAt || 0) || +new Date(l.estimated_payment_at || 0) !== +new Date(novo.estimatedAt || 0) || +new Date(l.due_at || 0) !== +new Date(dueAt || 0);
      if (!mudou) continue;
      await c.query(
        `UPDATE partner_commission_ledger SET status = $3, hold_reason = $4, release_at = $5, estimated_payment_at = $6, due_at = $7, updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, l.id, novo.status, novo.holdReason, novo.releaseAt, novo.estimatedAt, dueAt]
      );
    }
  }

  // ── Créditos da carteira de benefícios (25% da contribuição pós-parceria, só de venda entregue) ─────────
  async function sincronizarBeneficio(c, ctx, attr, atual, settings) {
    const { rows } = await c.query(
      `SELECT COALESCE(sum(amount_cents), 0)::bigint AS soma, count(*)::int AS n FROM partner_benefit_ledger WHERE organization_id = $1 AND attribution_id = $2 AND entry_type IN ('budget_credit', 'reversal')`,
      [ctx.organizationId, attr.id]
    );
    const contrib = atual.contributionAfterPartnerCents;
    const elegivel = attr.status === 'calculated' && atual.orderState === 'delivered' && Number.isSafeInteger(contrib) && contrib > 0;
    const alvo = elegivel ? percentualDe(percentualDe(contrib, settings.benefitBudgetBps), attr.creator_share_bps) : 0;
    const delta = alvo - Number(rows[0].soma);
    if (delta === 0) return;
    await c.query(
      `INSERT INTO partner_benefit_ledger (organization_id, store_id, partner_id, attribution_id, entry_type, amount_cents, description, origin_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (organization_id, partner_id, origin_key) DO NOTHING`,
      [ctx.organizationId, ctx.storeId, attr.partner_id, attr.id, delta > 0 ? 'budget_credit' : 'reversal', delta,
        delta > 0 ? 'crédito de orçamento sobre contribuição verificada' : 'estorno de crédito por mudança no pedido', `budget:${attr.id}:seq:${rows[0].n}`]
    );
  }

  // ── Persistência de um pedido ───────────────────────────────────────────────────────────────────
  async function persistirPedido(ctx, cfg, settings, pedido, itens, agora, { forcarOverrides = null } = {}) {
    return db.tx(pool, async (c) => {
      await db.travarChave(c, ctx.organizationId, `order:${pedido.ink_order_id}`);
      const { rows: existentes } = await c.query('SELECT * FROM partnership_attributions WHERE organization_id = $1 AND ink_order_id = $2', [ctx.organizationId, pedido.ink_order_id]);
      const overrides = {};
      for (const e of existentes) if (e.manual_override) overrides[String(e.ink_item_id)] = e.collab_id ? { collabId: e.collab_id } : { couponLinkId: e.coupon_link_id };
      if (forcarOverrides) Object.assign(overrides, forcarOverrides);
      const resultado = apurarPedido(montarEntrada(pedido, itens, cfg, overrides, settings));
      const porChave = new Map(existentes.map((e) => [e.idempotency_key, e]));
      const vistas = new Set();
      const estatisticas = { atribuicoes: 0, criadas: 0, revisoes: resultado.reviews.length };

      for (const a of resultado.attributions) {
        vistas.add(a.idempotencyKey);
        const existente = porChave.get(a.idempotencyKey);
        const pagoObservadoEm = (existente && existente.current_state && existente.current_state.paidObservedAt)
          || (['paid', 'delivered'].includes(a.current.orderState) ? agora.toISOString() : null);
        const atual = { ...a.current, paidObservedAt: pagoObservadoEm };
        let linha;
        if (!existente) {
          if (ESTADOS_SEM_COMISSAO.has(a.current.orderState)) continue; // nunca chegou a valer: não cria atribuição só para zerar
          const { rows } = await c.query(
            `INSERT INTO partnership_attributions (organization_id, store_id, ink_order_id, ink_item_id, partner_id, contract_id, contract_version_id, basis, collab_id, coupon_link_id,
               creator_share_bps, evidence, snapshot, current_state, status, review_reason, manual_override, sale_at, idempotency_key)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
             ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING *`,
            [ctx.organizationId, ctx.storeId, pedido.ink_order_id, a.inkItemId, a.partnerId, a.contractId, a.contractVersionId, a.basis, a.collabId, a.couponLinkId,
              a.creatorShareBps, JSON.stringify(a.evidence), JSON.stringify(a.snapshot), JSON.stringify(atual), a.status, a.reviewReason, a.manualOverride === true, a.saleAt, a.idempotencyKey]
          );
          linha = rows[0];
          if (!linha) continue;
          estatisticas.criadas += 1;
        } else {
          // O snapshot ORIGINAL e a versão de contrato não mudam; só o estado corrente e o status de revisão.
          const status = existente.manual_override && existente.status === 'calculated' ? 'calculated' : a.status;
          const { rows } = await c.query(
            `UPDATE partnership_attributions SET current_state = $3, status = $4, review_reason = $5, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`,
            [ctx.organizationId, existente.id, JSON.stringify(atual), status, a.reviewReason]
          );
          linha = rows[0];
        }
        estatisticas.atribuicoes += 1;
        await sincronizarLedger(c, ctx, cfg, linha, atual, pedido, settings, agora);
        await sincronizarBeneficio(c, ctx, linha, atual, settings);
      }

      // Atribuição existente que o motor já não produz (item removido, janela mudou): alvo zero, com trilha.
      const semResolucao = resultado.reviews.some((r) => r.inkItemId === null);
      if (!semResolucao) {
        for (const e of existentes) {
          if (vistas.has(e.idempotency_key) || e.manual_override || e.status !== 'calculated') continue;
          const atual = { ...e.current_state, orderState: 'unmatched', targetCommissionCents: 0, eligibleQty: 0, marginEligibleCents: 0, baseEligibleCents: 0, contributionAfterPartnerCents: 0 };
          const { rows } = await c.query('UPDATE partnership_attributions SET current_state = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *', [ctx.organizationId, e.id, JSON.stringify(atual)]);
          await sincronizarLedger(c, ctx, cfg, rows[0], atual, pedido, settings, agora);
          await sincronizarBeneficio(c, ctx, rows[0], atual, settings);
        }
      }

      // Itens em revisão: upsert dos atuais e resolução automática dos que deixaram de valer.
      for (const r of resultado.reviews) {
        await c.query(
          `INSERT INTO partnership_review_items (organization_id, store_id, ink_order_id, ink_item_id, reason, details) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (organization_id, ink_order_id, COALESCE(ink_item_id, 0), reason) DO UPDATE SET details = EXCLUDED.details, updated_at = now() WHERE partnership_review_items.status = 'open'`,
          [ctx.organizationId, ctx.storeId, pedido.ink_order_id, r.inkItemId, r.reason, JSON.stringify(r.details || {})]
        );
      }
      const chavesAtuais = resultado.reviews.map((r) => `${r.inkItemId ?? 0}:${r.reason}`);
      await c.query(
        `UPDATE partnership_review_items SET status = 'resolved', resolved_at = now(), resolution_note = 'auto: a condição não se repete no último processamento', updated_at = now()
          WHERE organization_id = $1 AND ink_order_id = $2 AND status = 'open' AND (COALESCE(ink_item_id, 0)::text || ':' || reason) <> ALL($3::text[])`,
        [ctx.organizationId, pedido.ink_order_id, chavesAtuais]
      );
      return { ...estatisticas, orderState: resultado.orderState };
    });
  }

  async function carregarItens(c, ctx, ids) {
    if (!ids.length) return new Map();
    const { rows } = await c.query(
      `SELECT * FROM pedidos_ink_itens WHERE organization_id = $1 AND store_id = $2 AND ink_order_id = ANY($3::bigint[]) ORDER BY item_id`, [ctx.organizationId, ctx.storeId, ids]
    );
    const mapa = new Map();
    for (const i of rows) {
      const k = String(i.ink_order_id);
      if (!mapa.has(k)) mapa.set(k, []);
      mapa.get(k).push(i);
    }
    return mapa;
  }

  // ── Transições por tempo: held → released quando a carência termina ─────────────────────────────
  async function promoverLiberacoes(ctx, agora = relogio(), executor = pool) {
    const settings = await registry.lerConfig(ctx, executor);
    const { rows } = await executor.query(
      `SELECT l.id, l.release_at, l.due_at, l.due_at_overridden, l.estimated_payment_at, l.contract_version_id FROM partner_commission_ledger l
        WHERE l.organization_id = $1 AND l.status = 'held' AND l.release_at IS NOT NULL AND l.release_at <= $2 LIMIT 5000`, [ctx.organizationId, agora]
    );
    let n = 0;
    for (const l of rows) {
      const due = l.due_at_overridden ? l.due_at : l.estimated_payment_at;
      await executor.query(`UPDATE partner_commission_ledger SET status = 'released', hold_reason = NULL, due_at = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 AND status = 'held'`, [ctx.organizationId, l.id, due]);
      n += 1;
    }
    return { promovidos: n, timezone: settings.timezone };
  }

  /**
   * @param {{organizationId:string, storeId:string, userId?:string}} ctx
   * @param {{desde?: Date, pedidos?: string[], completo?: boolean}} opcoes
   */
  async function reconciliar(ctx, opcoes = {}) {
    const agora = relogio();
    const { cfg, settings, pedidos } = await lerBase(ctx, opcoes, agora);
    const stats = { pedidosAvaliados: pedidos.length, atribuicoes: 0, criadas: 0, revisoes: 0, truncado: pedidos.length >= LIMITE_POR_RODADA, promovidos: 0 };
    for (let i = 0; i < pedidos.length; i += TAMANHO_LOTE) {
      const lote = pedidos.slice(i, i + TAMANHO_LOTE);
      const itensPorPedido = await carregarItens(pool, ctx, lote.map((p) => p.ink_order_id));
      for (const pedido of lote) {
        const r = await persistirPedido(ctx, cfg, settings, pedido, itensPorPedido.get(String(pedido.ink_order_id)) || [], agora);
        stats.atribuicoes += r.atribuicoes; stats.criadas += r.criadas; stats.revisoes += r.revisoes;
      }
    }
    stats.promovidos = (await promoverLiberacoes(ctx, agora)).promovidos;
    if (!stats.truncado && !opcoes.pedidos) {
      await db.tx(pool, (c) => c.query(
        `INSERT INTO partnership_settings (organization_id, store_id, last_reconciled_at) VALUES ($1,$2,$3)
         ON CONFLICT (organization_id) DO UPDATE SET last_reconciled_at = EXCLUDED.last_reconciled_at`, [ctx.organizationId, ctx.storeId, agora]
      ));
    }
    return stats;
  }

  async function lerBase(ctx, opcoes, agora) {
    const c = await pool.connect();
    try {
      const settings = await registry.lerConfig(ctx, c);
      const cfg = await carregarConfiguracao(c, ctx);
      const params = [ctx.organizationId, ctx.storeId];
      let filtro;
      if (Array.isArray(opcoes.pedidos) && opcoes.pedidos.length) {
        params.push(opcoes.pedidos.map(String));
        filtro = `p.ink_order_id = ANY($${params.length}::bigint[])`;
      } else {
        const inicio = opcoes.desde || cfg.inicioMinimo;
        const abertos = `p.ink_order_id IN (SELECT a.ink_order_id FROM partnership_attributions a WHERE a.organization_id = p.organization_id AND a.status = 'calculated'
                          AND EXISTS (SELECT 1 FROM partner_commission_ledger l WHERE l.attribution_id = a.id AND l.organization_id = a.organization_id AND l.status IN ('provisional', 'held')))`;
        if (!inicio) {
          filtro = abertos; // sem cupom/collab vigente ainda: só o que já tem comissão em aberto
        } else {
          params.push(inicio);
          const base = `p.criado_em >= $${params.length}`;
          if (opcoes.completo || opcoes.desde || !settings.lastReconciledAt) filtro = base;
          else {
            params.push(new Date(new Date(settings.lastReconciledAt).getTime() - 3600000));
            filtro = `(${base} AND p.atualizado_em >= $${params.length}) OR ${abertos}`;
          }
        }
      }
      const { rows } = await c.query(
        `SELECT p.* FROM pedidos_ink p WHERE p.organization_id = $1 AND p.store_id = $2 AND (${filtro}) ORDER BY p.criado_em LIMIT ${LIMITE_POR_RODADA}`, params
      );
      return { cfg, settings, pedidos: rows };
    } finally { c.release(); }
  }

  // ── Revisão manual auditável: associar um item a collab/cupom explicitamente ────────────────────
  async function resolverRevisao(ctx, reviewId, entrada) {
    const agora = relogio();
    const motivo = db.textoObrigatorio(entrada.reason, { max: 500, nome: 'motivo' });
    const decisao = db.opcao(entrada.decision, ['assign_collab', 'assign_coupon', 'dismiss'], { nome: 'decisão' });
    const id = db.exigirUuid(reviewId, 'item em revisão');
    const c0 = await pool.connect();
    let revisao; let cfg; let settings; let pedido; let itens;
    try {
      const { rows } = await c0.query('SELECT * FROM partnership_review_items WHERE organization_id = $1 AND id = $2', [ctx.organizationId, id]);
      if (!rows[0]) throw db.naoEncontrado('item em revisão');
      revisao = rows[0];
      if (revisao.status !== 'open') throw db.conflito('AFILIADOS_REVISAO_FECHADA', 'este item já foi tratado');
      if (decisao !== 'dismiss') {
        settings = await registry.lerConfig(ctx, c0);
        cfg = await carregarConfiguracao(c0, ctx);
        const { rows: p } = await c0.query('SELECT * FROM pedidos_ink WHERE organization_id = $1 AND store_id = $2 AND ink_order_id = $3', [ctx.organizationId, ctx.storeId, revisao.ink_order_id]);
        pedido = p[0];
        if (!pedido) throw db.naoEncontrado('pedido');
        itens = (await carregarItens(c0, ctx, [pedido.ink_order_id])).get(String(pedido.ink_order_id)) || [];
      }
    } finally { c0.release(); }

    if (decisao === 'dismiss') {
      return db.tx(pool, async (c) => {
        await c.query(`UPDATE partnership_review_items SET status = 'dismissed', resolved_by = $3, resolved_at = now(), resolution_note = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`, [ctx.organizationId, id, ctx.userId || null, motivo]);
        await db.auditar(c, ctx, { entidade: 'review_item', entidadeId: id, acao: 'review.dismiss', antes: { reason: revisao.reason }, motivo });
        return { status: 'dismissed' };
      });
    }
    if (revisao.ink_item_id === null) throw db.entradaInvalida('esta revisão é do pedido inteiro; reprocesse o pedido quando o dado chegar');
    const override = decisao === 'assign_collab'
      ? { collabId: db.exigirUuid(entrada.collabId, 'collab') }
      : { couponLinkId: db.exigirUuid(entrada.couponLinkId, 'cupom') };
    if (override.collabId && !cfg.collabs.some((k) => k.id === override.collabId)) throw db.naoEncontrado('collab');
    if (override.couponLinkId && !cfg.coupons.some((k) => k.id === override.couponLinkId)) throw db.naoEncontrado('cupom');
    const r = await persistirPedido(ctx, cfg, settings, pedido, itens, agora, { forcarOverrides: { [String(revisao.ink_item_id)]: override } });
    await db.tx(pool, async (c) => {
      await c.query(`UPDATE partnership_review_items SET status = 'resolved', resolved_by = $3, resolved_at = now(), resolution_note = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`, [ctx.organizationId, id, ctx.userId || null, motivo]);
      await db.auditar(c, ctx, { entidade: 'review_item', entidadeId: id, acao: 'review.assign', antes: { reason: revisao.reason, inkOrderId: String(revisao.ink_order_id), inkItemId: String(revisao.ink_item_id) }, depois: override, motivo });
    });
    return { status: 'resolved', atribuicoes: r.atribuicoes };
  }

  return { carregarConfiguracao, reconciliar, promoverLiberacoes, resolverRevisao, cicloDeVida, normalizarCodigo };
}

module.exports = { criarReconciliador, ESTADOS_SEM_COMISSAO };
