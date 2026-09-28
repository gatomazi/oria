'use strict';

// Leitura: lista e perfil de parceiros, vendas atribuídas (por pedido/item) e visão geral (KPIs, série, pendências).
// Só leitura; toda mutação está nos outros módulos. KPIs sempre com período E tipo de data explícitos — e receita atribuída
// NUNCA é chamada de receita incremental (a atribuição por cupom não prova causalidade).

const db = require('./db');
const levels = require('./levels');
const { intervaloLocal, inicioDoDiaLocal, dataLocal, partesLocais, diasEmAtraso } = require('./schedule');

const { entradaInvalida, exigirUuid, opcao } = db;
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function criarDiretorio({ pool, relogio = () => new Date(), registry, payables, progressao }) {
  const numero = (v) => Number(v);
  const hojeLocal = (agora, tz) => inicioDoDiaLocal(...dataLocal(agora, tz).split('-').map(Number), tz);

  async function saldosPorParceiro(ctx, ids, agora, tz, executor = pool) {
    if (!ids.length) return new Map();
    const hoje = hojeLocal(agora, tz);
    const { rows } = await executor.query(
      `WITH l AS (
         SELECT x.partner_id, x.amount_cents, x.due_at, x.category,
                CASE WHEN x.status = 'held' AND x.release_at IS NOT NULL AND x.release_at <= $3 THEN 'released' ELSE x.status END AS eff,
                (x.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = x.organization_id AND a.ledger_id = x.id), 0))::bigint AS aberto
           FROM partner_commission_ledger x WHERE x.organization_id = $1 AND x.partner_id = ANY($2::uuid[]) AND x.status <> 'reversed')
       SELECT partner_id,
              COALESCE(sum(aberto) FILTER (WHERE eff = 'released'), 0)::bigint AS liberado,
              COALESCE(sum(aberto) FILTER (WHERE eff IN ('provisional', 'held')), 0)::bigint AS previsto,
              COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto > 0 AND due_at < $4), 0)::bigint AS vencido
         FROM l GROUP BY partner_id`, [ctx.organizationId, ids, agora, hoje]
    );
    return new Map(rows.map((r) => [r.partner_id, { releasedCents: numero(r.liberado), forecastCents: numero(r.previsto), overdueCents: numero(r.vencido) }]));
  }

  // ── Lista de parceiros ──────────────────────────────────────────────────────────────────────────
  async function listarParceiros(ctx, q = {}) {
    const agora = relogio();
    const settings = await registry.lerConfig(ctx);
    const tz = settings.timezone;
    const { limite, deslocamento } = db.paginacao(q, { padrao: 25, maximo: 100 });
    const params = [ctx.organizationId];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const cond = ['p.organization_id = $1'];
    if (q.q) {
      const termo = String(q.q).trim().slice(0, 80).replace(/[%_\\]/g, (m) => `\\${m}`);
      const t = p(`%${termo}%`);
      cond.push(`(p.public_name ILIKE ${t} OR p.contact_name ILIKE ${t} OR p.contact_email ILIKE ${t} OR p.profiles::text ILIKE ${t}
        OR EXISTS (SELECT 1 FROM partner_coupon_links cl WHERE cl.organization_id = p.organization_id AND cl.partner_id = p.id AND cl.code_display ILIKE ${t}))`);
    }
    if (q.applicationStatus) cond.push(`p.application_status = ${p(opcao(q.applicationStatus, ['candidate', 'approved', 'rejected'], { nome: 'candidatura' }))}`);
    if (q.relationshipStatus) cond.push(`p.relationship_status = ${p(opcao(q.relationshipStatus, ['draft', 'active', 'paused', 'ended'], { nome: 'vínculo' }))}`);
    if (q.modality) cond.push(`EXISTS (SELECT 1 FROM partnership_contracts k WHERE k.organization_id = p.organization_id AND k.partner_id = p.id AND k.modality = ${p(opcao(q.modality, ['coupon', 'collab', 'hybrid'], { nome: 'modalidade' }))})`);
    if (q.level) cond.push(`(SELECT h.level_key FROM partner_level_history h WHERE h.organization_id = p.organization_id AND h.partner_id = p.id ORDER BY h.effective_at DESC, h.created_at DESC LIMIT 1) = ${p(String(q.level).slice(0, 31))}`);
    if (q.noSaleDays) {
      const dias = Number.parseInt(q.noSaleDays, 10);
      if (!Number.isInteger(dias) || dias < 1 || dias > 3650) throw entradaInvalida('noSaleDays inválido');
      cond.push(`COALESCE((SELECT max(a.sale_at) FROM partnership_attributions a WHERE a.organization_id = p.organization_id AND a.partner_id = p.id AND a.status = 'calculated'), 'epoch') < ${p(new Date(agora.getTime() - dias * 86400000))}`);
    }
    const ordem = { name: 'p.public_name', created: 'p.created_at', lastSale: 'last_sale_at' }[q.sort] || 'p.public_name';
    const dir = q.dir === 'desc' ? 'DESC' : 'ASC';
    const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM partnership_partners p WHERE ${cond.join(' AND ')}`, params);
    params.push(limite, deslocamento);
    const { rows } = await pool.query(
      `SELECT p.*,
         (SELECT COALESCE(array_agg(DISTINCT k.modality), '{}') FROM partnership_contracts k WHERE k.organization_id = p.organization_id AND k.partner_id = p.id) AS modalities,
         (SELECT h.level_key FROM partner_level_history h WHERE h.organization_id = p.organization_id AND h.partner_id = p.id ORDER BY h.effective_at DESC, h.created_at DESC LIMIT 1) AS level_key,
         (SELECT max(a.sale_at) FROM partnership_attributions a WHERE a.organization_id = p.organization_id AND a.partner_id = p.id AND a.status = 'calculated') AS last_sale_at,
         (SELECT COALESCE(array_agg(cl.code_display ORDER BY cl.created_at), '{}') FROM partner_coupon_links cl WHERE cl.organization_id = p.organization_id AND cl.partner_id = p.id AND cl.status IN ('active', 'pending_validation', 'planned')) AS coupons
       FROM partnership_partners p WHERE ${cond.join(' AND ')} ORDER BY ${ordem} ${dir} NULLS LAST, p.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    const ids = rows.map((r) => r.id);
    const [saldos, saude] = await Promise.all([saldosPorParceiro(ctx, ids, agora, tz), saudeDosParceiros(ctx, ids)]);
    return {
      total,
      itens: rows.map((r) => ({
        id: r.id, publicName: r.public_name, contactEmail: r.contact_email, applicationStatus: r.application_status, relationshipStatus: r.relationship_status, modalities: r.modalities,
        level: r.level_key, lastSaleAt: r.last_sale_at, coupons: r.coupons, legacyInkAffiliate: r.legacy_ink_affiliate, balance: saldos.get(r.id) || { releasedCents: 0, forecastCents: 0, overdueCents: 0 },
        health: (saude.get(r.id) || []),
      })),
    };
  }

  // Estado de saúde operacional (cupom não criado, aguardando validação, catálogo não mapeado, divergência, inadimplência, apto a subir).
  async function saudeDosParceiros(ctx, ids, executor = pool) {
    const mapa = new Map(ids.map((i) => [i, new Set()]));
    if (!ids.length) return new Map();
    const marcar = (id, flag) => { if (mapa.has(id)) mapa.get(id).add(flag); };
    const org = ctx.organizationId;
    const cupons = await executor.query(`SELECT partner_id, status, sync_status FROM partner_coupon_links WHERE organization_id = $1 AND partner_id = ANY($2::uuid[]) AND status IN ('planned', 'pending_validation', 'active')`, [org, ids]);
    const pend = await executor.query(
      `SELECT DISTINCT cc.partner_id FROM partner_collab_creators cc JOIN partner_collab_product_memberships m ON m.collab_id = cc.collab_id AND m.organization_id = cc.organization_id
        WHERE cc.organization_id = $1 AND cc.partner_id = ANY($2::uuid[]) AND cc.valid_to IS NULL AND m.status = 'pending_approval'`, [org, ids]
    );
    const revisao = await executor.query(`SELECT DISTINCT partner_id FROM partnership_attributions WHERE organization_id = $1 AND partner_id = ANY($2::uuid[]) AND status IN ('manual_review', 'blocked')`, [org, ids]);
    const propostas = await executor.query(`SELECT partner_id FROM partner_level_proposals WHERE organization_id = $1 AND partner_id = ANY($2::uuid[]) AND status = 'pending' AND direction = 'upgrade'`, [org, ids]);
    const contratos = await executor.query(
      `SELECT p.id, EXISTS (SELECT 1 FROM partnership_contracts k WHERE k.organization_id = p.organization_id AND k.partner_id = p.id AND
          (SELECT v.status FROM partnership_contract_versions v WHERE v.organization_id = k.organization_id AND v.contract_id = k.id ORDER BY v.version DESC LIMIT 1) = 'active') AS tem_ativo
         FROM partnership_partners p WHERE p.organization_id = $1 AND p.id = ANY($2::uuid[]) AND p.application_status = 'approved'`, [org, ids]
    );
    for (const c of cupons.rows) {
      if (c.sync_status === 'not_created') marcar(c.partner_id, 'coupon_not_created');
      if (c.status === 'pending_validation' || c.status === 'planned') marcar(c.partner_id, 'awaiting_validation');
      if (c.sync_status === 'divergent' || c.sync_status === 'error') marcar(c.partner_id, 'coupon_divergent');
    }
    for (const r of pend.rows) marcar(r.partner_id, 'catalog_unmapped');
    for (const r of revisao.rows) marcar(r.partner_id, 'financial_divergence');
    for (const r of propostas.rows) marcar(r.partner_id, 'ready_to_level_up');
    for (const r of contratos.rows) if (!r.tem_ativo) marcar(r.id, 'no_active_contract');
    const agora = relogio();
    const tz = (await registry.lerConfig(ctx, executor)).timezone;
    const saldos = await saldosPorParceiro(ctx, ids, agora, tz, executor);
    for (const [id, s] of saldos) if (s.overdueCents > 0) marcar(id, 'overdue');
    return new Map([...mapa].map(([id, set]) => [id, [...set]]));
  }

  // ── Perfil ──────────────────────────────────────────────────────────────────────────────────────
  async function perfilDoParceiro(ctx, partnerId) {
    const agora = relogio();
    const c = await pool.connect();
    try {
      const parceiro = await registry.obterParceiroBasico(c, ctx, partnerId);
      // Sequencial: parte das leituras usa o cliente `c` (uma conexão só) — pg não aceita queries concorrentes nele.
      const contratos = await registry.listarContratosDoParceiro(ctx, parceiro.id, c);
      const saude = await saudeDosParceiros(ctx, [parceiro.id], c);
      const [cupons, avaliacao, historicoNivel, beneficios, extrato, pagamentos] = await Promise.all([
        registry.listarCupons(ctx, { partnerId: parceiro.id }),
        progressao.avaliarParceiro(ctx, parceiro.id),
        progressao.historicoDeNiveis(ctx, parceiro.id),
        progressao.listarBeneficios(ctx, parceiro.id),
        payables.extratoDoParceiro(ctx, parceiro.id, { limit: 1 }),
        payables.listarPagamentos(ctx, { partnerId: parceiro.id, limite: 20 }),
      ]);
      const { rows: collabs } = await c.query(
        `SELECT k.id, k.name, k.status, cc.share_bps, cc.valid_from, cc.valid_to FROM partner_collab_creators cc JOIN partner_collabs k ON k.id = cc.collab_id AND k.organization_id = cc.organization_id
          WHERE cc.organization_id = $1 AND cc.partner_id = $2 ORDER BY cc.valid_from DESC`, [ctx.organizationId, parceiro.id]
      );
      const ids = [parceiro.id, ...contratos.map((k) => k.id), ...cupons.map((k) => k.id), ...collabs.map((k) => k.id)];
      const { rows: eventos } = await c.query(
        `SELECT id, entity_type, entity_id, action, reason, created_at, actor_user_id FROM partnership_audit_events WHERE organization_id = $1 AND entity_id = ANY($2::text[]) ORDER BY created_at DESC LIMIT 60`, [ctx.organizationId, ids]
      );
      return {
        partner: registry.mapearParceiro(parceiro), health: saude.get(parceiro.id) || [], contracts: contratos, coupons: cupons,
        collabs: collabs.map((k) => ({ id: k.id, name: k.name, status: k.status, shareBps: k.share_bps, validFrom: k.valid_from, validTo: k.valid_to })),
        level: avaliacao, levelHistory: historicoNivel, benefits: beneficios, balance: extrato.totais, payments: pagamentos,
        activity: eventos.map((e) => ({ id: e.id, entity: e.entity_type, action: e.action, reason: e.reason, at: e.created_at, actor: e.actor_user_id })),
        generatedAt: agora,
      };
    } finally { c.release(); }
  }

  // ── Vendas atribuídas (por pedido/item) ─────────────────────────────────────────────────────────
  async function listarVendas(ctx, q = {}) {
    const settings = await registry.lerConfig(ctx);
    const tz = settings.timezone;
    const { limite, deslocamento } = db.paginacao(q, { padrao: 25, maximo: 100 });
    const params = [ctx.organizationId];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const cond = ['a.organization_id = $1'];
    if (q.partnerId) cond.push(`a.partner_id = ${p(exigirUuid(q.partnerId, 'parceiro'))}`);
    if (q.collabId) cond.push(`a.collab_id = ${p(exigirUuid(q.collabId, 'collab'))}`);
    if (q.basis) cond.push(`a.basis = ${p(opcao(q.basis, ['collab', 'coupon'], { nome: 'origem' }))}`);
    if (q.status) cond.push(`a.status = ${p(opcao(q.status, ['calculated', 'manual_review', 'blocked', 'void'], { nome: 'status' }))}`);
    if (q.from || q.to) {
      if (!RE_DATA.test(String(q.from || '')) || !RE_DATA.test(String(q.to || ''))) throw entradaInvalida('informe from e to (YYYY-MM-DD)');
      const { inicio, fim } = intervaloLocal(String(q.from), String(q.to), tz);
      cond.push(`a.sale_at >= ${p(inicio)} AND a.sale_at < ${p(fim)}`);
    }
    const { rows: [{ total }] } = await pool.query(`SELECT count(*)::int AS total FROM partnership_attributions a WHERE ${cond.join(' AND ')}`, params);
    params.push(limite, deslocamento);
    const { rows } = await pool.query(
      `SELECT a.id, a.ink_order_id, a.ink_item_id, a.partner_id, a.basis, a.status, a.review_reason, a.manual_override, a.sale_at, a.current_state, a.snapshot, a.creator_share_bps, a.evidence,
              p.public_name, k.name AS collab_nome, cl.code_display, i.produto_nome, i.quantidade,
              COALESCE((SELECT sum(l.amount_cents) FROM partner_commission_ledger l WHERE l.organization_id = a.organization_id AND l.attribution_id = a.id AND l.status <> 'reversed'), 0)::bigint AS comissao
         FROM partnership_attributions a
         JOIN partnership_partners p ON p.id = a.partner_id AND p.organization_id = a.organization_id
         LEFT JOIN partner_collabs k ON k.id = a.collab_id AND k.organization_id = a.organization_id
         LEFT JOIN partner_coupon_links cl ON cl.id = a.coupon_link_id AND cl.organization_id = a.organization_id
         LEFT JOIN pedidos_ink_itens i ON i.organization_id = a.organization_id AND i.store_id = a.store_id AND i.item_id = a.ink_item_id
        WHERE ${cond.join(' AND ')} ORDER BY a.sale_at DESC, a.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params
    );
    return {
      total,
      itens: rows.map((r) => ({
        id: r.id, inkOrderId: String(r.ink_order_id), inkItemId: String(r.ink_item_id), partnerId: r.partner_id, partnerName: r.public_name, basis: r.basis, status: r.status, reviewReason: r.review_reason,
        manualOverride: r.manual_override, saleAt: r.sale_at, productName: r.produto_nome, quantity: r.quantidade, eligibleQty: r.current_state.eligibleQty ?? null, orderState: r.current_state.orderState ?? null,
        collabName: r.collab_nome, couponCode: r.code_display, shareBps: r.creator_share_bps,
        netRevenueCents: r.snapshot.liquidoCents ?? null, allocatedDiscountCents: r.snapshot.descontoAlocadoCents ?? null, baseEligibleCents: r.current_state.baseEligibleCents ?? null,
        costQuality: r.snapshot.custoQualidade ?? null, marginAlert: !!r.current_state.marginAlert, commissionCents: numero(r.comissao), rule: r.snapshot.rule || null,
        couponAlsoMatched: r.evidence.couponAlsoMatched || null,
      })),
    };
  }

  async function listarRevisoes(ctx, { status = 'open' } = {}) {
    const st = opcao(status, ['open', 'resolved', 'dismissed'], { nome: 'status' });
    const { rows } = await pool.query(
      `SELECT r.*, i.produto_nome, i.sku FROM partnership_review_items r
         LEFT JOIN pedidos_ink_itens i ON i.organization_id = r.organization_id AND i.store_id = r.store_id AND i.item_id = r.ink_item_id
        WHERE r.organization_id = $1 AND r.status = $2 ORDER BY r.created_at DESC LIMIT 200`, [ctx.organizationId, st]
    );
    return rows.map((r) => ({ id: r.id, inkOrderId: String(r.ink_order_id), inkItemId: r.ink_item_id === null ? null : String(r.ink_item_id), reason: r.reason, details: r.details, status: r.status, productName: r.produto_nome, sku: r.sku, createdAt: r.created_at, resolutionNote: r.resolution_note }));
  }

  // ── Visão geral ─────────────────────────────────────────────────────────────────────────────────
  const PRESETS = ['7d', '30d', '90d', 'this_month', 'last_month'];
  function resolverPeriodo(q, agora, tz) {
    const hoje = dataLocal(agora, tz);
    const [a, m, d] = hoje.split('-').map(Number);
    const soma = (dias) => { const x = new Date(Date.UTC(a, m - 1, d + dias)); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };
    if (q.from || q.to) {
      if (!RE_DATA.test(String(q.from || '')) || !RE_DATA.test(String(q.to || ''))) throw entradaInvalida('informe from e to (YYYY-MM-DD)');
      return { from: String(q.from), to: String(q.to), preset: 'custom' };
    }
    const preset = opcao(q.range, PRESETS, { nome: 'range', padrao: '30d' });
    if (preset === '7d') return { from: soma(-6), to: hoje, preset };
    if (preset === '30d') return { from: soma(-29), to: hoje, preset };
    if (preset === '90d') return { from: soma(-89), to: hoje, preset };
    if (preset === 'this_month') return { from: `${a}-${String(m).padStart(2, '0')}-01`, to: hoje, preset };
    const anterior = m === 1 ? [a - 1, 12] : [a, m - 1];
    const ultimo = new Date(Date.UTC(anterior[0], anterior[1], 0)).getUTCDate();
    return { from: `${anterior[0]}-${String(anterior[1]).padStart(2, '0')}-01`, to: `${anterior[0]}-${String(anterior[1]).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}`, preset };
  }

  const DATA_DO_KPI = { order: 'sale', release: 'release', due: 'due', paid: 'paid' };

  async function visaoGeral(ctx, q = {}) {
    const agora = relogio();
    const settings = await registry.lerConfig(ctx);
    const tz = settings.timezone;
    const periodo = resolverPeriodo(q, agora, tz);
    const tipo = opcao(q.dateType, ['order', 'release', 'due', 'paid'], { nome: 'dateType', padrao: 'order' });
    const filtros = payables.lerFiltros({ dateType: DATA_DO_KPI[tipo], from: periodo.from, to: periodo.to, partnerId: q.partnerId, modality: q.modality, collabId: q.collabId, level: q.level, productId: q.productId }, tz);
    const rows = await payables.lancamentosFiltrados(ctx, filtros, tz, agora);
    const hoje = hojeLocal(agora, tz);
    const em30 = new Date(hoje.getTime() + 30 * 86400000);

    const pedidosValidos = new Set(); const atribVistas = new Set();
    let receita = 0; let unidadesCollab = 0; let provisionada = 0; let liberada = 0; let aPagar = 0; let vencido = 0; let proximoCiclo = 0;
    const porDia = new Map();
    for (const r of rows) {
      const valor = numero(r.amount_cents); const aberto = numero(r.aberto);
      const valido = ['paid', 'delivered'].includes(r.estado_pedido);
      if (r.attribution_id && valido && !atribVistas.has(r.attribution_id)) {
        atribVistas.add(r.attribution_id);
        pedidosValidos.add(String(r.ink_order_id));
        receita += numero(r.base_cents || 0);
        if (r.basis === 'collab') unidadesCollab += r.qtd || 0;
      }
      if (['provisional', 'held'].includes(r.eff_status)) provisionada += aberto;
      if (r.eff_status === 'released') {
        liberada += valor; aPagar += aberto;
        if (aberto > 0 && r.due_at && new Date(r.due_at) < hoje) vencido += aberto;
      }
      if (aberto !== 0 && r.estimated_payment_at && new Date(r.estimated_payment_at) >= hoje && new Date(r.estimated_payment_at) < em30 && r.eff_status !== 'reversed') proximoCiclo += aberto;
      const campoData = { order: r.sale_at, release: r.release_at, due: r.due_at, paid: r.ultimo_pgto }[tipo];
      if (campoData && r.entry_type === 'accrual') {
        const dia = dataLocal(new Date(campoData), tz);
        if (!porDia.has(dia)) porDia.set(dia, { date: dia, cents: 0, coupon: 0, collab: 0 });
        const d = porDia.get(dia);
        d.cents += valor; if (r.basis === 'collab') d.collab += valor; else d.coupon += valor;
      }
    }
    const { inicio, fim } = intervaloLocal(periodo.from, periodo.to, tz);
    const pagFiltro = [ctx.organizationId, inicio, fim]; let pagWhere = '';
    if (filtros.partnerId) { pagFiltro.push(filtros.partnerId); pagWhere = `AND r.partner_id = $${pagFiltro.length}`; }
    const [{ rows: pago }, { rows: parceiros }, { rows: benef }, { rows: rev }, { rows: cup }] = await Promise.all([
      pool.query(`SELECT COALESCE(sum(CASE WHEN r.kind = 'payment' THEN r.amount_cents ELSE -r.amount_cents END), 0)::bigint AS pago FROM partner_payment_records r WHERE r.organization_id = $1 AND r.paid_at >= $2 AND r.paid_at < $3 ${pagWhere}`, pagFiltro),
      pool.query(`SELECT count(*) FILTER (WHERE relationship_status = 'active')::int AS ativos, count(*) FILTER (WHERE application_status = 'candidate')::int AS candidatos FROM partnership_partners WHERE organization_id = $1`, [ctx.organizationId]),
      pool.query(`SELECT COALESCE(-sum(amount_cents) FILTER (WHERE amount_cents < 0 AND entry_type IN ('consumption', 'exceptional_grant')), 0)::bigint AS usado FROM partner_benefit_ledger WHERE organization_id = $1 AND created_at >= $2 AND created_at < $3`, [ctx.organizationId, inicio, fim]),
      pool.query(`SELECT count(*)::int AS n FROM partnership_review_items WHERE organization_id = $1 AND status = 'open'`, [ctx.organizationId]),
      pool.query(`SELECT count(*)::int AS n FROM partner_coupon_links WHERE organization_id = $1 AND status IN ('active', 'pending_validation') AND sync_status IN ('divergent', 'error')`, [ctx.organizationId]),
    ]);

    const agregados = payables.agregar(rows, tz, agora, filtros.dateType).filter((g) => g.status !== 'quitado' && g.openCents + g.forecastCents !== 0);
    const nomes = await nomesDosParceiros(ctx, [...new Set(agregados.map((g) => g.partnerId))]);
    const proximos = agregados.filter((g) => g.dueAt || g.estimatedAt).sort((x, y) => (+(x.dueAt || x.estimatedAt)) - (+(y.dueAt || y.estimatedAt))).slice(0, 8)
      .map((g) => ({ partnerId: g.partnerId, partnerName: nomes.get(g.partnerId) || '', competence: g.competence, openCents: g.openCents, forecastCents: g.forecastCents, dueAt: g.dueAt, estimatedAt: g.estimatedAt, status: g.status, daysOverdue: g.daysOverdue }));

    return {
      period: { ...periodo, timezone: tz, dateType: tipo, criterio: { order: 'data do pedido', release: 'data de liberação', due: 'data de vencimento', paid: 'data efetiva do pagamento' }[tipo] },
      kpis: {
        activePartners: parceiros[0].ativos, pendingCandidates: parceiros[0].candidatos, attributedNetRevenueCents: receita, validOrders: pedidosValidos.size, collabUnits: unidadesCollab,
        forecastCommissionCents: provisionada, releasedCommissionCents: liberada, payableCents: aPagar, overdueCents: vencido, nextCycleCents: proximoCiclo,
        paidInPeriodCents: numero(pago[0].pago), benefitsUsedCents: numero(benef[0].usado), integrationDivergences: rev[0].n + cup[0].n,
      },
      definicoes: {
        attributedNetRevenue: 'Receita líquida ATRIBUÍDA por cupom/collab. Não é receita incremental: atribuição por cupom não prova causalidade.',
        forecast: 'Provisionada = ainda não liberada (não é dívida). A pagar = liberada e em aberto.',
        paid: 'Pago no período usa a data efetiva do pagamento, independente do tipo de data do filtro.',
      },
      series: [...porDia.values()].sort((x, y) => x.date.localeCompare(y.date)),
      upcoming: proximos,
      alerts: await alertas(ctx, { agora, tz, alertDays: settings.alertDays, overdue: vencido, revisoes: rev[0].n, cuponsDivergentes: cup[0].n }),
    };
  }

  async function nomesDosParceiros(ctx, ids) {
    if (!ids.length) return new Map();
    const { rows } = await pool.query('SELECT id, public_name FROM partnership_partners WHERE organization_id = $1 AND id = ANY($2::uuid[])', [ctx.organizationId, ids]);
    return new Map(rows.map((r) => [r.id, r.public_name]));
  }

  // Pendências acionáveis, sempre in-app (nenhum envio externo nesta versão).
  async function alertas(ctx, { agora, tz, alertDays = [7, 3, 1], overdue, revisoes, cuponsDivergentes }) {
    const lista = [];
    const org = ctx.organizationId;
    if (overdue > 0) lista.push({ kind: 'overdue', severity: 'critical', message: 'Há comissões liberadas com vencimento passado.', href: '/admin/parcerias/a-pagar?status=vencido', cents: overdue });
    // Avisos de vencimento iminente nos prazos configurados da loja (padrão 7/3/1 dias): uma faixa só aparece quando traz lançamentos novos.
    const prazos = [...new Set(alertDays)].sort((a, b) => a - b);
    let anterior = 0;
    for (const dias of prazos) {
      const { rows: venc } = await pool.query(
        `SELECT count(*)::int AS n FROM partner_commission_ledger l WHERE l.organization_id = $1 AND l.status IN ('released', 'held') AND l.category = 'commission' AND l.due_at >= $2 AND l.due_at < $3
           AND l.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = l.organization_id AND a.ledger_id = l.id), 0) > 0`,
        [org, hojeLocal(agora, tz), new Date(hojeLocal(agora, tz).getTime() + (dias + 1) * 86400000)]
      );
      if (venc[0].n > anterior) {
        lista.push({ kind: 'due_soon', severity: dias <= 1 ? 'critical' : 'warning', message: `${venc[0].n === 1 ? '1 lançamento vence' : `${venc[0].n} lançamentos vencem`} em até ${dias === 0 ? 'hoje' : dias === 1 ? '1 dia' : `${dias} dias`}.`, href: '/admin/parcerias/a-pagar?dateType=due', count: venc[0].n });
      }
      anterior = Math.max(anterior, venc[0].n);
    }
    if (revisoes > 0) lista.push({ kind: 'review_items', severity: 'warning', message: `${revisoes} item(ns) de pedido em revisão manual (produto ausente, dado incompleto ou ambíguo).`, href: '/admin/parcerias/revisoes', count: revisoes });
    if (cuponsDivergentes > 0) lista.push({ kind: 'coupon_divergent', severity: 'warning', message: `${cuponsDivergentes} cupom(ns) divergem do que está na INK.`, href: '/admin/parcerias/parceiros', count: cuponsDivergentes });
    const { rows: pend } = await pool.query(
      `SELECT k.id, k.name, count(*)::int AS n FROM partner_collab_product_memberships m JOIN partner_collabs k ON k.id = m.collab_id AND k.organization_id = m.organization_id
        WHERE m.organization_id = $1 AND m.status = 'pending_approval' GROUP BY k.id, k.name ORDER BY n DESC LIMIT 5`, [org]
    );
    for (const k of pend) lista.push({ kind: 'collab_new_products', severity: 'info', message: `Collab "${k.name}": ${k.n} novo(s) produto(s) do agrupamento aguardam aprovação.`, href: `/admin/parcerias/collabs/${k.id}`, count: k.n });
    const { rows: semCriador } = await pool.query(
      `SELECT k.id, k.name FROM partner_collabs k WHERE k.organization_id = $1 AND k.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM partner_collab_creators cc WHERE cc.organization_id = k.organization_id AND cc.collab_id = k.id AND cc.valid_to IS NULL) LIMIT 5`, [org]
    );
    for (const k of semCriador) lista.push({ kind: 'collab_without_creator', severity: 'warning', message: `Collab "${k.name}" ativa sem criador com participação.`, href: `/admin/parcerias/collabs/${k.id}` });
    const { rows: naoVerif } = await pool.query(
      `SELECT count(*)::int AS n FROM partner_coupon_links WHERE organization_id = $1 AND status = 'active' AND sync_status = 'manual_unverified'`, [org]
    );
    if (naoVerif[0].n > 0) lista.push({ kind: 'coupon_unverified', severity: 'info', message: `${naoVerif[0].n} cupom(ns) ativo(s) cadastrado(s) à mão ainda não verificados na INK.`, href: '/admin/parcerias/parceiros', count: naoVerif[0].n });
    const { rows: prop } = await pool.query(`SELECT count(*)::int AS n FROM partner_level_proposals WHERE organization_id = $1 AND status = 'pending'`, [org]);
    if (prop[0].n > 0) lista.push({ kind: 'level_proposals', severity: 'info', message: `${prop[0].n} proposta(s) de mudança de nível aguardam decisão.`, href: '/admin/parcerias/niveis', count: prop[0].n });
    const { rows: margem } = await pool.query(
      `SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND status = 'calculated' AND (current_state->>'marginAlert')::boolean IS TRUE AND current_state->>'orderState' IN ('paid', 'delivered')`, [org]
    );
    if (margem[0].n > 0) lista.push({ kind: 'margin_alert', severity: 'warning', message: `${margem[0].n} venda(s) com contribuição abaixo do mínimo após a comissão (o pedido não é bloqueado).`, href: '/admin/parcerias/vendas?margem=alerta', count: margem[0].n });
    const { rows: semCusto } = await pool.query(`SELECT count(*)::int AS n FROM partnership_attributions WHERE organization_id = $1 AND status = 'manual_review' AND review_reason = 'cost_unknown'`, [org]);
    if (semCusto[0].n > 0) lista.push({ kind: 'cost_unknown', severity: 'warning', message: `${semCusto[0].n} venda(s) sem custo verificado (base em margem): comissão não liberada.`, href: '/admin/parcerias/vendas?status=manual_review', count: semCusto[0].n });
    return lista;
  }

  return { listarParceiros, perfilDoParceiro, listarVendas, listarRevisoes, visaoGeral, saudeDosParceiros, saldosPorParceiro, resolverPeriodo, alertas, diasEmAtraso, partesLocais, levels };
}

module.exports = { criarDiretorio };
