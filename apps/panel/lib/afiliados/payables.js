'use strict';

// Contas a pagar: extrato do ledger, fechamento (lote), pagamento parcial/total com rateio explícito, estorno administrativo,
// vencimento manual auditado e exportação CSV. Gerencial — NÃO é plataforma bancária: nenhum Pix é feito aqui.
//
// Cinco datas, filtros independentes, nunca somadas entre si:
//   sale (pedido) · competence (mês da venda) · estimated (previsão) · due (vencimento) · paid (data EFETIVA do pagamento)
// Cada filtro decide QUAIS lançamentos participam; os totais só somam o que participa (o "pago" de um filtro por data de
// pagamento conta só as alocações pagas no intervalo).

const db = require('./db');
const { intervaloLocal, inicioDoDiaLocal, dataLocal, diasEmAtraso, partesLocais } = require('./schedule');
const { centavosParaDecimal } = require('./money');
const { gerarCsv } = require('./csv');

const { erro, entradaInvalida, naoEncontrado, conflito, exigirUuid, textoOpcional, textoObrigatorio, inteiro, opcao, dataIso } = db;

const TIPOS_DE_DATA = ['sale', 'competence', 'release', 'estimated', 'due', 'paid'];
const STATUS_FINANCEIRO = ['previsto', 'liberado', 'vencido', 'parcial', 'quitado'];
const METODOS = ['pix', 'transfer', 'other'];
const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

function criarPayables({ pool, relogio = () => new Date(), registry }) {
  // ── Filtros ─────────────────────────────────────────────────────────────────────────────────────
  function lerFiltros(q, tz) {
    const f = {};
    f.dateType = opcao(q.dateType, TIPOS_DE_DATA, { nome: 'dateType', padrao: 'due' });
    for (const k of ['from', 'to']) {
      if (q[k] !== undefined && q[k] !== '' && !RE_DATA.test(String(q[k]))) throw entradaInvalida(`${k} deve ser YYYY-MM-DD`);
    }
    if ((q.from && !q.to) || (!q.from && q.to)) throw entradaInvalida('informe from e to juntos');
    if (q.from) {
      try { f.intervalo = intervaloLocal(String(q.from), String(q.to), tz); } catch { throw entradaInvalida('intervalo de datas inválido'); }
      f.from = String(q.from); f.to = String(q.to);
    }
    if (q.partnerId) f.partnerId = exigirUuid(q.partnerId, 'parceiro');
    if (q.modality) f.modality = opcao(q.modality, ['coupon', 'collab', 'hybrid'], { nome: 'modalidade' });
    if (q.collabId) f.collabId = exigirUuid(q.collabId, 'collab');
    if (q.productId) { if (!/^\d{1,18}$/.test(String(q.productId))) throw entradaInvalida('productId inválido'); f.productId = String(q.productId); }
    if (q.level) f.level = String(q.level).slice(0, 31);
    if (q.category) f.category = opcao(q.category, ['commission', 'content_fee'], { nome: 'categoria' });
    if (q.status) f.status = opcao(q.status, STATUS_FINANCEIRO, { nome: 'status' });
    if (q.method) f.method = opcao(q.method, METODOS, { nome: 'forma de pagamento' });
    if (q.settlement) f.settlement = opcao(q.settlement, ['partial', 'settled'], { nome: 'settlement' });
    if (q.overdue === 'true' || q.overdue === true) f.overdue = true;
    f.sort = opcao(q.sort, ['partner', 'competence', 'open', 'due', 'estimated', 'lastPaid'], { nome: 'sort', padrao: 'due' });
    f.dir = q.dir === 'desc' ? 'desc' : 'asc';
    return f;
  }

  // Lançamentos já com valor pago, aberto e estado efetivo (held vencido de carência = released), conforme os filtros.
  async function lancamentosFiltrados(ctx, f, tz, agora, { executor = pool } = {}) {
    const params = [ctx.organizationId, agora];
    const p = (v) => { params.push(v); return `$${params.length}`; };
    const cond = ["l.organization_id = $1", "l.status <> 'reversed'"];
    if (f.partnerId) cond.push(`l.partner_id = ${p(f.partnerId)}`);
    if (f.category) cond.push(`l.category = ${p(f.category)}`);
    if (f.modality) cond.push(`k.modality = ${p(f.modality)}`);
    if (f.collabId) cond.push(`a.collab_id = ${p(f.collabId)}`);
    if (f.productId) cond.push(`a.evidence->>'productId' = ${p(f.productId)}`);
    if (f.level) {
      cond.push(`(SELECT h.level_key FROM partner_level_history h WHERE h.organization_id = l.organization_id AND h.partner_id = l.partner_id ORDER BY h.effective_at DESC, h.created_at DESC LIMIT 1) = ${p(f.level)}`);
    }
    if (f.method) {
      cond.push(`EXISTS (SELECT 1 FROM partner_payment_allocations x JOIN partner_payment_records r ON r.id = x.payment_id AND r.organization_id = x.organization_id WHERE x.organization_id = l.organization_id AND x.ledger_id = l.id AND r.method = ${p(f.method)})`);
    }
    if (f.intervalo) {
      const ini = p(f.intervalo.inicio); const fim = p(f.intervalo.fim);
      if (f.dateType === 'sale') cond.push(`l.sale_at >= ${ini} AND l.sale_at < ${fim}`);
      else if (f.dateType === 'competence') { const fuso = p(tz); cond.push(`l.competence >= (${ini}::timestamptz AT TIME ZONE ${fuso}::text)::date AND l.competence < (${fim}::timestamptz AT TIME ZONE ${fuso}::text)::date`); }
      else if (f.dateType === 'release') cond.push(`l.release_at >= ${ini} AND l.release_at < ${fim}`);
      else if (f.dateType === 'estimated') cond.push(`l.estimated_payment_at >= ${ini} AND l.estimated_payment_at < ${fim}`);
      else if (f.dateType === 'due') cond.push(`l.due_at >= ${ini} AND l.due_at < ${fim}`);
      else cond.push(`EXISTS (SELECT 1 FROM partner_payment_allocations x JOIN partner_payment_records r ON r.id = x.payment_id AND r.organization_id = x.organization_id WHERE x.organization_id = l.organization_id AND x.ledger_id = l.id AND r.paid_at >= ${ini} AND r.paid_at < ${fim})`);
    }
    const periodoPago = f.intervalo && f.dateType === 'paid' ? `AND r.paid_at >= $${params.indexOf(f.intervalo.inicio) + 1} AND r.paid_at < $${params.indexOf(f.intervalo.fim) + 1}` : '';
    const { rows } = await executor.query(
      `SELECT l.id, l.partner_id, l.competence, l.category, l.entry_type, l.amount_cents, l.sale_at, l.release_at, l.estimated_payment_at, l.due_at, l.hold_reason, l.attribution_id,
              CASE WHEN l.status = 'held' AND l.release_at IS NOT NULL AND l.release_at <= $2 THEN 'released' ELSE l.status END AS eff_status,
              COALESCE(al.pago, 0)::bigint AS pago, (l.amount_cents - COALESCE(al.pago, 0))::bigint AS aberto, al.ultimo_pgto, COALESCE(al.pago_periodo, 0)::bigint AS pago_periodo,
              k.modality, a.collab_id, a.basis, a.ink_order_id, a.current_state->>'orderState' AS estado_pedido, (a.current_state->>'eligibleQty')::int AS qtd, (a.current_state->>'baseEligibleCents')::bigint AS base_cents
         FROM partner_commission_ledger l
         LEFT JOIN LATERAL (
           SELECT sum(x.amount_cents) AS pago, max(r.paid_at) FILTER (WHERE r.kind = 'payment') AS ultimo_pgto,
                  sum(x.amount_cents) FILTER (WHERE TRUE ${periodoPago}) AS pago_periodo
             FROM partner_payment_allocations x JOIN partner_payment_records r ON r.id = x.payment_id AND r.organization_id = x.organization_id
            WHERE x.organization_id = l.organization_id AND x.ledger_id = l.id) al ON TRUE
         LEFT JOIN partnership_contract_versions v ON v.id = l.contract_version_id AND v.organization_id = l.organization_id
         LEFT JOIN partnership_contracts k ON k.id = v.contract_id AND k.organization_id = v.organization_id
         LEFT JOIN partnership_attributions a ON a.id = l.attribution_id AND a.organization_id = l.organization_id
        WHERE ${cond.join(' AND ')}
        ORDER BY l.competence, l.sale_at LIMIT 20000`,
      params
    );
    return rows;
  }

  const numero = (v) => Number(v);

  // Agrega em linhas parceiro + competência (+ categoria). Nada de misturar previsão com dívida: `previsto` e `liberado` separados.
  function agregar(rows, tz, agora, dateType) {
    const grupos = new Map();
    const hoje = dataLocal(agora, tz);
    for (const r of rows) {
      const chave = `${r.partner_id}|${dataLocal(new Date(r.competence), 'UTC')}|${r.category}`;
      if (!grupos.has(chave)) {
        grupos.set(chave, {
          partnerId: r.partner_id, competence: dataLocal(new Date(r.competence), 'UTC'), category: r.category, modalities: new Set(),
          orders: new Set(), units: 0, baseCents: 0, grossCents: 0, adjustmentsCents: 0, releasedCents: 0, previstoCents: 0, paidCents: 0, paidInPeriodCents: 0, openReleasedCents: 0, overdueCents: 0, maxDiasAtraso: 0,
          estimatedAt: null, dueAt: null, lastPaidAt: null, ledgerIds: [], _atribuicoes: new Set(), _abertos: 0,
        });
      }
      const g = grupos.get(chave);
      const valor = numero(r.amount_cents); const aberto = numero(r.aberto);
      g.ledgerIds.push(r.id);
      if (r.modality) g.modalities.add(r.modality);
      if (r.attribution_id && !g._atribuicoes.has(r.attribution_id)) {
        g._atribuicoes.add(r.attribution_id);
        g.orders.add(String(r.ink_order_id));
        g.units += r.qtd || 0;
        g.baseCents += numero(r.base_cents || 0);
      }
      if (r.entry_type === 'accrual') g.grossCents += valor; else g.adjustmentsCents += valor;
      g.paidCents += numero(r.pago);
      g.paidInPeriodCents += numero(r.pago_periodo);
      if (r.eff_status === 'released') { g.releasedCents += valor; g.openReleasedCents += aberto; } else if (['provisional', 'held'].includes(r.eff_status)) g.previstoCents += aberto;
      if (aberto !== 0) {
        g._abertos += 1;
        if (r.estimated_payment_at && (!g.estimatedAt || new Date(r.estimated_payment_at) < g.estimatedAt)) g.estimatedAt = new Date(r.estimated_payment_at);
        if (r.eff_status === 'released' && aberto > 0 && r.due_at && (!g.dueAt || new Date(r.due_at) < g.dueAt)) g.dueAt = new Date(r.due_at);
        // Vencido é por LANÇAMENTO: só o saldo liberado cuja data de vencimento já passou (o resto do grupo ainda não venceu).
        if (r.eff_status === 'released' && aberto > 0 && r.due_at) {
          const atraso = diasEmAtraso(new Date(r.due_at), agora, tz);
          if (atraso > 0) { g.overdueCents += aberto; g.maxDiasAtraso = Math.max(g.maxDiasAtraso, atraso); }
        }
      }
      if (r.ultimo_pgto && (!g.lastPaidAt || new Date(r.ultimo_pgto) > g.lastPaidAt)) g.lastPaidAt = new Date(r.ultimo_pgto);
    }
    return [...grupos.values()].map((g) => {
      const diasAtraso = g.maxDiasAtraso;
      let status;
      if (g._abertos === 0) status = 'quitado';
      else if (g.overdueCents > 0) status = 'vencido';
      else if (g.openReleasedCents > 0) status = g.paidCents !== 0 ? 'parcial' : 'liberado';
      else if (g.paidCents !== 0 && g.previstoCents === 0) status = 'parcial';
      else status = 'previsto';
      return {
        partnerId: g.partnerId, competence: g.competence, category: g.category, modalities: [...g.modalities],
        orderCount: g.orders.size, units: g.units, baseCents: g.baseCents, grossCents: g.grossCents, adjustmentsCents: g.adjustmentsCents,
        releasedCents: g.releasedCents, paidCents: g.paidCents, paidInPeriodCents: dateType === 'paid' ? g.paidInPeriodCents : null,
        openCents: g.openReleasedCents, overdueCents: g.overdueCents, forecastCents: g.previstoCents, status, estimatedAt: g.estimatedAt, dueAt: g.dueAt, lastPaidAt: g.lastPaidAt, daysOverdue: diasAtraso,
        ledgerIds: g.ledgerIds, today: hoje,
      };
    });
  }

  const ORDENADORES = {
    partner: (a, b) => (a._nome || '').localeCompare(b._nome || ''),
    competence: (a, b) => a.competence.localeCompare(b.competence),
    open: (a, b) => a.openCents - b.openCents,
    due: (a, b) => (a.dueAt ? +a.dueAt : Infinity) - (b.dueAt ? +b.dueAt : Infinity),
    estimated: (a, b) => (a.estimatedAt ? +a.estimatedAt : Infinity) - (b.estimatedAt ? +b.estimatedAt : Infinity),
    lastPaid: (a, b) => (a.lastPaidAt ? +a.lastPaidAt : 0) - (b.lastPaidAt ? +b.lastPaidAt : 0),
  };

  async function nomesDosParceiros(ctx, ids, executor = pool) {
    if (!ids.length) return new Map();
    const { rows } = await executor.query('SELECT id, public_name FROM partnership_partners WHERE organization_id = $1 AND id = ANY($2::uuid[])', [ctx.organizationId, ids]);
    return new Map(rows.map((r) => [r.id, r.public_name]));
  }

  async function listarAPagar(ctx, query) {
    const agora = relogio();
    const settings = await registry.lerConfig(ctx);
    const tz = settings.timezone;
    const f = lerFiltros(query, tz);
    const { limite, deslocamento } = db.paginacao(query, { padrao: 25, maximo: 200 });
    const rows = await lancamentosFiltrados(ctx, f, tz, agora);
    let linhas = agregar(rows, tz, agora, f.dateType);
    if (f.status) linhas = linhas.filter((l) => l.status === f.status);
    if (f.overdue) linhas = linhas.filter((l) => l.status === 'vencido');
    if (f.settlement === 'partial') linhas = linhas.filter((l) => l.paidCents !== 0 && l.status !== 'quitado');
    if (f.settlement === 'settled') linhas = linhas.filter((l) => l.status === 'quitado');
    const nomes = await nomesDosParceiros(ctx, [...new Set(linhas.map((l) => l.partnerId))]);
    for (const l of linhas) l._nome = nomes.get(l.partnerId) || '';
    linhas.sort((a, b) => (f.dir === 'desc' ? -1 : 1) * ORDENADORES[f.sort](a, b) || a.competence.localeCompare(b.competence));
    const totais = linhas.reduce((t, l) => ({
      grossCents: t.grossCents + l.grossCents, adjustmentsCents: t.adjustmentsCents + l.adjustmentsCents, releasedCents: t.releasedCents + l.releasedCents,
      paidCents: t.paidCents + l.paidCents, openCents: t.openCents + l.openCents, forecastCents: t.forecastCents + l.forecastCents,
    }), { grossCents: 0, adjustmentsCents: 0, releasedCents: 0, paidCents: 0, openCents: 0, forecastCents: 0 });
    return {
      filtros: { dateType: f.dateType, from: f.from || null, to: f.to || null, timezone: tz },
      total: linhas.length, totais,
      itens: linhas.slice(deslocamento, deslocamento + limite).map(({ _nome, ledgerIds, today, ...l }) => ({ ...l, partnerName: _nome, ledgerCount: ledgerIds.length })),
    };
  }

  // KPIs da aba: não misturam previsão com dívida.
  async function resumoDeAPagar(ctx, query = {}) {
    const agora = relogio();
    const settings = await registry.lerConfig(ctx);
    const tz = settings.timezone;
    const { ano, mes } = partesLocais(agora, tz);
    const de = RE_DATA.test(String(query.from || '')) ? String(query.from) : `${ano}-${String(mes).padStart(2, '0')}-01`;
    const ate = RE_DATA.test(String(query.to || '')) ? String(query.to) : dataLocal(agora, tz);
    const { inicio, fim } = intervaloLocal(de, ate, tz);
    const hoje = inicioDoDiaLocal(...dataLocal(agora, tz).split('-').map(Number), tz);
    const em7 = new Date(hoje.getTime() + 7 * 86400000);
    const em30 = new Date(hoje.getTime() + 30 * 86400000);
    const { rows } = await pool.query(
      `WITH l AS (
         SELECT x.amount_cents, x.category, x.due_at, x.release_at, x.status,
                CASE WHEN x.status = 'held' AND x.release_at IS NOT NULL AND x.release_at <= $2 THEN 'released' ELSE x.status END AS eff,
                (x.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = x.organization_id AND a.ledger_id = x.id), 0))::bigint AS aberto
           FROM partner_commission_ledger x WHERE x.organization_id = $1 AND x.status <> 'reversed')
       SELECT
         COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto > 0 AND due_at < $3 AND category = 'commission'), 0)::bigint AS vencido,
         COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto > 0 AND due_at >= $3 AND due_at < $4 AND category = 'commission'), 0)::bigint AS vence_7,
         COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto > 0 AND due_at >= $3 AND due_at < $5 AND category = 'commission'), 0)::bigint AS vence_30,
         COALESCE(sum(aberto) FILTER (WHERE eff IN ('provisional', 'held') AND aberto <> 0 AND category = 'commission'), 0)::bigint AS previsto,
         COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto > 0 AND category = 'commission'), 0)::bigint AS disponivel,
         COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto < 0 AND category = 'commission'), 0)::bigint AS ajustes_pendentes,
         COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto > 0 AND category = 'content_fee'), 0)::bigint AS cache_em_aberto
         FROM l`,
      [ctx.organizationId, agora, hoje, em7, em30]
    );
    const { rows: pago } = await pool.query(
      `SELECT COALESCE(sum(CASE WHEN r.kind = 'payment' THEN r.amount_cents ELSE -r.amount_cents END), 0)::bigint AS pago
         FROM partner_payment_records r WHERE r.organization_id = $1 AND r.paid_at >= $2 AND r.paid_at < $3`, [ctx.organizationId, inicio, fim]
    );
    const k = rows[0];
    return {
      periodoDoPago: { from: de, to: ate, timezone: tz, criterio: 'data efetiva do pagamento (paid_at)' },
      overdueCents: numero(k.vencido), dueIn7Cents: numero(k.vence_7), dueIn30Cents: numero(k.vence_30), forecastCents: numero(k.previsto), availableCents: numero(k.disponivel),
      pendingAdjustmentsCents: numero(k.ajustes_pendentes), paidInPeriodCents: numero(pago[0].pago), contentFeesOpenCents: numero(k.cache_em_aberto),
      notas: ['vence em 7/30 dias conta saldo liberado com vencimento a partir de hoje', 'previsto = ainda não liberado (não é dívida); disponível = liberado e em aberto'],
    };
  }

  // ── Extrato do parceiro ─────────────────────────────────────────────────────────────────────────
  async function extratoDoParceiro(ctx, partnerId, query = {}) {
    const agora = relogio();
    const settings = await registry.lerConfig(ctx);
    await registry.obterParceiroBasico(pool, ctx, partnerId);
    const { limite, deslocamento } = db.paginacao(query, { padrao: 50, maximo: 200 });
    const { rows } = await pool.query(
      `SELECT l.id, l.entry_type, l.category, l.amount_cents, l.hold_reason, l.sale_at, l.release_at, l.estimated_payment_at, l.due_at, l.competence, l.note, l.created_at,
              CASE WHEN l.status = 'held' AND l.release_at IS NOT NULL AND l.release_at <= $3 THEN 'released' ELSE l.status END AS eff_status,
              COALESCE(al.pago, 0)::bigint AS pago, (l.amount_cents - COALESCE(al.pago, 0))::bigint AS aberto,
              a.ink_order_id, a.ink_item_id, a.basis, a.collab_id, a.coupon_link_id, a.status AS attr_status, a.review_reason, a.current_state, k.name AS collab_nome, cl.code_display
         FROM partner_commission_ledger l
         LEFT JOIN (SELECT ledger_id, sum(amount_cents) AS pago FROM partner_payment_allocations WHERE organization_id = $1 GROUP BY ledger_id) al ON al.ledger_id = l.id
         LEFT JOIN partnership_attributions a ON a.id = l.attribution_id AND a.organization_id = l.organization_id
         LEFT JOIN partner_collabs k ON k.id = a.collab_id AND k.organization_id = a.organization_id
         LEFT JOIN partner_coupon_links cl ON cl.id = a.coupon_link_id AND cl.organization_id = a.organization_id
        WHERE l.organization_id = $1 AND l.partner_id = $2 ORDER BY l.created_at DESC, l.id LIMIT $4 OFFSET $5`,
      [ctx.organizationId, partnerId, agora, limite, deslocamento]
    );
    const { rows: totais } = await pool.query(
      `WITH l AS (SELECT x.*, CASE WHEN x.status = 'held' AND x.release_at IS NOT NULL AND x.release_at <= $3 THEN 'released' ELSE x.status END AS eff,
                    (x.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = x.organization_id AND a.ledger_id = x.id), 0))::bigint AS aberto,
                    COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = x.organization_id AND a.ledger_id = x.id), 0)::bigint AS pago
                    FROM partner_commission_ledger x WHERE x.organization_id = $1 AND x.partner_id = $2 AND x.status <> 'reversed')
       SELECT COALESCE(sum(amount_cents) FILTER (WHERE entry_type = 'accrual' AND category = 'commission'), 0)::bigint AS bruto,
              COALESCE(sum(amount_cents) FILTER (WHERE entry_type <> 'accrual' AND category = 'commission'), 0)::bigint AS ajustes,
              COALESCE(sum(pago), 0)::bigint AS pago,
              COALESCE(sum(aberto) FILTER (WHERE eff = 'released'), 0)::bigint AS saldo_liberado,
              COALESCE(sum(aberto) FILTER (WHERE eff IN ('provisional', 'held')), 0)::bigint AS previsto,
              COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto < 0), 0)::bigint AS ajuste_a_compensar,
              COALESCE(sum(aberto) FILTER (WHERE eff = 'released' AND aberto > 0 AND due_at < $4), 0)::bigint AS vencido,
              COALESCE(sum(amount_cents) FILTER (WHERE category = 'content_fee'), 0)::bigint AS cache
         FROM l`, [ctx.organizationId, partnerId, agora, inicioDoDiaLocal(...dataLocal(agora, settings.timezone).split('-').map(Number), settings.timezone)]
    );
    const { rows: retidos } = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(sum(l.amount_cents), 0)::bigint AS total FROM partner_commission_ledger l
        WHERE l.organization_id = $1 AND l.partner_id = $2 AND l.status = 'held' AND l.hold_reason LIKE 'order\\_%'`, [ctx.organizationId, partnerId]
    );
    const t = totais[0];
    return {
      totais: {
        grossCents: numero(t.bruto), adjustmentsCents: numero(t.ajustes), paidCents: numero(t.pago), releasedBalanceCents: numero(t.saldo_liberado), forecastCents: numero(t.previsto),
        adjustmentToOffsetCents: numero(t.ajuste_a_compensar), overdueCents: numero(t.vencido), contentFeesCents: numero(t.cache), suspendedByRefund: { count: retidos[0].n, cents: numero(retidos[0].total) },
        netBalanceCents: numero(t.saldo_liberado) + numero(t.previsto),
        explicacao: 'saldo = comissão bruta + ajustes − pago; ajustes vêm de estorno, cancelamento e devolução; previsto ainda não é dívida.',
      },
      itens: rows.map((r) => ({
        id: r.id, entryType: r.entry_type, category: r.category, amountCents: numero(r.amount_cents), paidCents: numero(r.pago), openCents: r.eff_status === 'reversed' ? 0 : numero(r.aberto), status: r.eff_status, holdReason: r.hold_reason,
        saleAt: r.sale_at, releaseAt: r.release_at, estimatedPaymentAt: r.estimated_payment_at, dueAt: r.due_at, competence: dataLocal(new Date(r.competence), 'UTC'), note: r.note,
        inkOrderId: r.ink_order_id === null ? null : String(r.ink_order_id), inkItemId: r.ink_item_id === null ? null : String(r.ink_item_id), basis: r.basis, collabName: r.collab_nome, couponCode: r.code_display,
        eligibleQty: r.current_state ? r.current_state.eligibleQty ?? null : null, orderState: r.current_state ? r.current_state.orderState ?? null : null, createdAt: r.created_at,
      })),
    };
  }

  // ── Fechamento (lote) ───────────────────────────────────────────────────────────────────────────
  async function entradasPagaveis(c, ctx, partnerId, cutoff, { ids = null, agora, travar = false } = {}) {
    const params = [ctx.organizationId, partnerId, agora, cutoff];
    let filtroIds = '';
    if (ids) { params.push(ids); filtroIds = `AND l.id = ANY($${params.length}::uuid[])`; }
    const { rows } = await c.query(
      `SELECT l.id, l.amount_cents, l.category, l.release_at, l.due_at, l.estimated_payment_at, l.competence, l.contract_version_id, l.attribution_id,
              (l.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = l.organization_id AND a.ledger_id = l.id), 0))::bigint AS aberto,
              v.min_payout_cents, v.accumulate_below_min
         FROM partner_commission_ledger l LEFT JOIN partnership_contract_versions v ON v.id = l.contract_version_id AND v.organization_id = l.organization_id
        WHERE l.organization_id = $1 AND l.partner_id = $2 AND l.category = 'commission'
          AND (l.status = 'released' OR (l.status = 'held' AND l.release_at IS NOT NULL AND l.release_at <= $3))
          AND (l.release_at IS NULL OR l.release_at <= $4) ${filtroIds}
        ORDER BY l.id ${travar ? 'FOR UPDATE OF l' : ''}`, params
    );
    return rows.filter((r) => numero(r.aberto) !== 0);
  }

  function propostaDe(entradas) {
    const liquido = entradas.reduce((s, e) => s + numero(e.aberto), 0);
    const minimo = entradas.reduce((m, e) => Math.max(m, numero(e.min_payout_cents ?? 5000)), 0);
    const acumula = entradas.every((e) => e.accumulate_below_min !== false);
    let situacao = 'ok';
    if (liquido <= 0) situacao = 'nada_a_pagar';
    else if (liquido < minimo && acumula) situacao = 'abaixo_do_minimo';
    return { liquidoCents: liquido, minimoCents: minimo, acumulaAbaixoDoMinimo: acumula, situacao };
  }

  async function previaDeFechamento(ctx, { partnerId, cutoffAt }) {
    const agora = relogio();
    const pid = exigirUuid(partnerId, 'parceiro');
    const corte = dataIso(cutoffAt, { nome: 'cutoffAt', obrigatorio: false }) || agora;
    const c = await pool.connect();
    try {
      const parceiro = await registry.obterParceiroBasico(c, ctx, pid);
      const entradas = await entradasPagaveis(c, ctx, pid, corte, { agora });
      const proposta = propostaDe(entradas);
      return {
        partner: { id: parceiro.id, name: parceiro.public_name }, cutoffAt: corte, ...proposta,
        entradas: entradas.map((e) => ({ ledgerId: e.id, openCents: numero(e.aberto), releaseAt: e.release_at, dueAt: e.due_at, attributionId: e.attribution_id })),
        divergencias: proposta.situacao === 'abaixo_do_minimo' ? [`saldo de ${centavosParaDecimal(proposta.liquidoCents)} abaixo do mínimo de ${centavosParaDecimal(proposta.minimoCents)}: acumula para o próximo ciclo`] : [],
      };
    } finally { c.release(); }
  }

  const mapearLote = (r) => ({
    id: r.id, partnerId: r.partner_id, competenceLabel: r.competence_label, cutoffAt: r.cutoff_at, proposedCents: numero(r.proposed_cents), estimatedPaymentAt: r.estimated_payment_at, dueAt: r.due_at,
    status: r.status, approvedAt: r.approved_at, voidReason: r.void_reason, createdAt: r.created_at,
  });

  async function pagoDoLote(c, ctx, batchId) {
    const { rows } = await c.query(
      `SELECT COALESCE(sum(CASE WHEN kind = 'payment' THEN amount_cents ELSE -amount_cents END), 0)::bigint AS pago FROM partner_payment_records WHERE organization_id = $1 AND batch_id = $2`, [ctx.organizationId, batchId]
    );
    return numero(rows[0].pago);
  }

  function statusFinanceiroDoLote(lote, pago, agora, tz) {
    if (lote.status === 'voided') return 'voided';
    if (lote.status === 'draft') return 'draft';
    if (pago >= lote.proposedCents) return 'paid';
    if (lote.dueAt && diasEmAtraso(lote.dueAt, agora, tz) > 0) return 'overdue';
    if (pago > 0) return 'partially_paid';
    return 'scheduled';
  }

  async function criarLote(ctx, entrada) {
    const agora = relogio();
    const pid = exigirUuid(entrada.partnerId, 'parceiro');
    const corte = dataIso(entrada.cutoffAt, { nome: 'cutoffAt', obrigatorio: false }) || agora;
    const ids = Array.isArray(entrada.ledgerIds) && entrada.ledgerIds.length ? entrada.ledgerIds.map((i) => exigirUuid(i, 'lançamento')) : null;
    const rotulo = textoOpcional(entrada.competenceLabel, { max: 40, nome: 'competência' });
    return db.tx(pool, async (c) => {
      await db.travarChave(c, ctx.organizationId, `payout:${pid}`);
      const parceiro = await registry.obterParceiroBasico(c, ctx, pid);
      const entradas = await entradasPagaveis(c, ctx, pid, corte, { ids, agora, travar: true });
      const proposta = propostaDe(entradas);
      if (proposta.situacao === 'nada_a_pagar') throw conflito('AFILIADOS_NADA_A_PAGAR', 'não há saldo liberado a pagar (ajustes a compensar não formam lote)');
      if (proposta.situacao === 'abaixo_do_minimo' && entrada.abaixoDoMinimo !== true) throw conflito('AFILIADOS_ABAIXO_DO_MINIMO', 'saldo abaixo do mínimo para repasse; acumule ou confirme com abaixoDoMinimo=true', proposta);
      if (ids && ids.length !== entradas.length) throw conflito('AFILIADOS_LANCAMENTO_INDISPONIVEL', 'algum lançamento não está liberado ou já está quitado');
      const { rows: jaEmLote } = await c.query(
        `SELECT DISTINCT i.ledger_id FROM partner_payout_batch_items i JOIN partner_payout_batches b ON b.id = i.batch_id AND b.organization_id = i.organization_id
          WHERE i.organization_id = $1 AND b.status <> 'voided' AND i.ledger_id = ANY($2::uuid[])`, [ctx.organizationId, entradas.map((e) => e.id)]
      );
      if (jaEmLote.length) throw conflito('AFILIADOS_LANCAMENTO_EM_LOTE', 'algum lançamento já pertence a outro lote ativo', { ledgerIds: jaEmLote.map((r) => r.ledger_id) });
      const estimado = entradas.map((e) => e.estimated_payment_at).filter(Boolean).sort((x, y) => new Date(x) - new Date(y))[0] || null;
      const vencimento = dataIso(entrada.dueAt, { nome: 'dueAt', obrigatorio: false }) || entradas.map((e) => e.due_at).filter(Boolean).sort((x, y) => new Date(x) - new Date(y))[0] || null;
      const { rows } = await c.query(
        `INSERT INTO partner_payout_batches (organization_id, store_id, partner_id, competence_label, cutoff_at, proposed_cents, estimated_payment_at, due_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [ctx.organizationId, ctx.storeId, pid, rotulo || `até ${dataLocal(corte)}`, corte, proposta.liquidoCents, estimado, vencimento, ctx.userId || null]
      );
      for (const e of entradas) {
        await c.query('INSERT INTO partner_payout_batch_items (organization_id, batch_id, ledger_id, amount_cents) VALUES ($1,$2,$3,$4)', [ctx.organizationId, rows[0].id, e.id, numero(e.aberto)]);
      }
      await db.auditar(c, ctx, { entidade: 'payout_batch', entidadeId: rows[0].id, acao: 'batch.create', depois: { partnerId: parceiro.id, proposedCents: proposta.liquidoCents, entries: entradas.length } });
      return { ...mapearLote(rows[0]), itens: entradas.map((e) => ({ ledgerId: e.id, amountCents: numero(e.aberto) })) };
    });
  }

  async function aprovarLote(ctx, batchId) {
    return db.tx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM partner_payout_batches WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, exigirUuid(batchId, 'lote')]);
      if (!rows[0]) throw naoEncontrado('lote');
      if (rows[0].status === 'approved') return mapearLote(rows[0]);
      if (rows[0].status !== 'draft') throw conflito('AFILIADOS_TRANSICAO_INVALIDA', `lote ${rows[0].status} não pode ser aprovado`);
      const { rows: mudou } = await c.query(
        `SELECT i.ledger_id FROM partner_payout_batch_items i JOIN partner_commission_ledger l ON l.id = i.ledger_id AND l.organization_id = i.organization_id
          WHERE i.organization_id = $1 AND i.batch_id = $2 AND (i.amount_cents - (l.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = l.organization_id AND a.ledger_id = l.id), 0))) <> 0`,
        [ctx.organizationId, rows[0].id]
      );
      if (mudou.length) throw conflito('AFILIADOS_LOTE_DESATUALIZADO', 'lançamentos do lote mudaram desde a prévia; crie o lote de novo', { ledgerIds: mudou.map((m) => m.ledger_id) });
      const { rows: r2 } = await c.query(`UPDATE partner_payout_batches SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`, [ctx.organizationId, rows[0].id, ctx.userId || null]);
      await db.auditar(c, ctx, { entidade: 'payout_batch', entidadeId: rows[0].id, acao: 'batch.approve', depois: { proposedCents: numero(rows[0].proposed_cents) } });
      return mapearLote(r2[0]);
    });
  }

  async function anularLote(ctx, batchId, { motivo }) {
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM partner_payout_batches WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, exigirUuid(batchId, 'lote')]);
      if (!rows[0]) throw naoEncontrado('lote');
      if (rows[0].status === 'voided') return mapearLote(rows[0]);
      if ((await pagoDoLote(c, ctx, rows[0].id)) !== 0) throw conflito('AFILIADOS_LOTE_COM_PAGAMENTO', 'lote com pagamento registrado só se corrige por estorno do pagamento');
      const { rows: r2 } = await c.query(`UPDATE partner_payout_batches SET status = 'voided', void_reason = $3, voided_by = $4, voided_at = now(), updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`, [ctx.organizationId, rows[0].id, m, ctx.userId || null]);
      await db.auditar(c, ctx, { entidade: 'payout_batch', entidadeId: rows[0].id, acao: 'batch.void', antes: { status: rows[0].status }, motivo: m });
      return mapearLote(r2[0]);
    });
  }

  async function listarLotes(ctx, { partnerId = null } = {}) {
    const agora = relogio();
    const tz = (await registry.lerConfig(ctx)).timezone;
    const params = [ctx.organizationId];
    let filtro = '';
    if (partnerId) { params.push(exigirUuid(partnerId, 'parceiro')); filtro = 'AND b.partner_id = $2'; }
    const { rows } = await pool.query(
      `SELECT b.*, p.public_name,
              COALESCE((SELECT sum(CASE WHEN r.kind = 'payment' THEN r.amount_cents ELSE -r.amount_cents END) FROM partner_payment_records r WHERE r.organization_id = b.organization_id AND r.batch_id = b.id), 0)::bigint AS pago
         FROM partner_payout_batches b JOIN partnership_partners p ON p.id = b.partner_id AND p.organization_id = b.organization_id
        WHERE b.organization_id = $1 ${filtro} ORDER BY b.created_at DESC LIMIT 200`, params
    );
    return rows.map((r) => {
      const lote = mapearLote(r);
      return { ...lote, partnerName: r.public_name, paidCents: numero(r.pago), financialStatus: statusFinanceiroDoLote(lote, numero(r.pago), agora, tz) };
    });
  }

  // ── Pagamento ───────────────────────────────────────────────────────────────────────────────────
  const mapearPagamento = (r) => ({
    id: r.id, partnerId: r.partner_id, batchId: r.batch_id, kind: r.kind, reversesPaymentId: r.reverses_payment_id, amountCents: numero(r.amount_cents), paidAt: r.paid_at, recordedAt: r.recorded_at,
    method: r.method, externalReference: r.external_reference, attachmentRef: r.attachment_ref, notes: r.notes, reversalReason: r.reversal_reason, recordedBy: r.recorded_by,
  });

  async function registrarPagamento(ctx, entrada) {
    const agora = relogio();
    const pid = exigirUuid(entrada.partnerId, 'parceiro');
    const chave = textoObrigatorio(entrada.idempotencyKey, { max: 100, nome: 'idempotencyKey' });
    const metodo = opcao(entrada.method, METODOS, { nome: 'forma de pagamento' });
    const paidAt = dataIso(entrada.paidAt, { nome: 'data efetiva do pagamento' });
    if (paidAt.getTime() > agora.getTime() + 86400000) throw entradaInvalida('a data efetiva do pagamento não pode estar no futuro');
    if (paidAt.getTime() < Date.UTC(2020, 0, 1)) throw entradaInvalida('data efetiva do pagamento inválida');
    const referencia = textoOpcional(entrada.externalReference, { max: 120, nome: 'referência' });
    const anexo = textoOpcional(entrada.attachmentRef, { max: 300, nome: 'comprovante' });
    const notas = textoOpcional(entrada.notes, { max: 1000, nome: 'observação' });
    const batchId = entrada.batchId ? exigirUuid(entrada.batchId, 'lote') : null;
    if (!Array.isArray(entrada.allocations) || entrada.allocations.length === 0 || entrada.allocations.length > 200) throw entradaInvalida('informe de 1 a 200 alocações (rateio explícito por lançamento)');
    const alocacoes = entrada.allocations.map((a) => ({ ledgerId: exigirUuid(a && a.ledgerId, 'lançamento'), amountCents: inteiro(a && a.amountCents, { nome: 'valor alocado (centavos)', min: -1000000000, max: 1000000000 }) }));
    if (alocacoes.some((a) => a.amountCents === 0)) throw entradaInvalida('alocação com valor zero');
    if (new Set(alocacoes.map((a) => a.ledgerId)).size !== alocacoes.length) throw entradaInvalida('lançamento repetido nas alocações');
    const total = alocacoes.reduce((s, a) => s + a.amountCents, 0);
    if (total <= 0) throw entradaInvalida('o pagamento líquido deve ser maior que zero (ajustes a compensar só entram junto de créditos)');
    if (entrada.amountCents !== undefined && Number(entrada.amountCents) !== total) throw entradaInvalida('amountCents não confere com a soma das alocações', { somaDasAlocacoes: total });

    return db.tx(pool, async (c) => {
      const { rows: dup } = await c.query('SELECT * FROM partner_payment_records WHERE organization_id = $1 AND idempotency_key = $2', [ctx.organizationId, chave]);
      if (dup[0]) {
        if (dup[0].partner_id !== pid || numero(dup[0].amount_cents) !== total) throw conflito('AFILIADOS_IDEMPOTENCIA_DIVERGENTE', 'a chave de idempotência já foi usada com outro pagamento');
        return { ...mapearPagamento(dup[0]), deduplicated: true };
      }
      await db.travarChave(c, ctx.organizationId, `payout:${pid}`);
      await registry.obterParceiroBasico(c, ctx, pid, { travar: true });
      const ids = alocacoes.map((a) => a.ledgerId).sort();
      const { rows: lancs } = await c.query(
        `SELECT l.id, l.partner_id, l.amount_cents, l.category, l.release_at,
                CASE WHEN l.status = 'held' AND l.release_at IS NOT NULL AND l.release_at <= $3 THEN 'released' ELSE l.status END AS eff,
                (l.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = l.organization_id AND a.ledger_id = l.id), 0))::bigint AS aberto
           FROM partner_commission_ledger l WHERE l.organization_id = $1 AND l.id = ANY($2::uuid[]) ORDER BY l.id FOR UPDATE OF l`, [ctx.organizationId, ids, agora]
      );
      if (lancs.length !== ids.length) throw naoEncontrado('lançamento');
      const porId = new Map(lancs.map((l) => [l.id, l]));
      for (const a of alocacoes) {
        const l = porId.get(a.ledgerId);
        if (l.partner_id !== pid) throw naoEncontrado('lançamento');
        if (l.eff !== 'released') throw conflito('AFILIADOS_LANCAMENTO_NAO_LIBERADO', 'só lançamentos liberados podem ser pagos (previsão não é dívida)', { ledgerId: l.id });
        const aberto = numero(l.aberto);
        if (Math.sign(a.amountCents) !== Math.sign(numero(l.amount_cents))) throw entradaInvalida('o sinal da alocação deve seguir o do lançamento (crédito paga, ajuste compensa)');
        if (Math.abs(a.amountCents) > Math.abs(aberto)) throw erro(422, 'AFILIADOS_PAGAMENTO_EXCEDE_SALDO', 'o valor alocado excede o saldo em aberto do lançamento', { ledgerId: l.id, abertoCents: aberto });
      }
      if (batchId) {
        const { rows: b } = await c.query('SELECT * FROM partner_payout_batches WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, batchId]);
        if (!b[0] || b[0].partner_id !== pid) throw naoEncontrado('lote');
        if (b[0].status !== 'approved') throw conflito('AFILIADOS_LOTE_NAO_APROVADO', 'aprove o lote antes de registrar pagamento');
        const { rows: itens } = await c.query('SELECT ledger_id FROM partner_payout_batch_items WHERE organization_id = $1 AND batch_id = $2', [ctx.organizationId, batchId]);
        const doLote = new Set(itens.map((i) => i.ledger_id));
        if (alocacoes.some((a) => !doLote.has(a.ledgerId))) throw entradaInvalida('há alocação fora do lote informado');
      }
      let pagamento;
      try {
        ({ rows: [pagamento] } = await c.query(
          `INSERT INTO partner_payment_records (organization_id, store_id, partner_id, batch_id, kind, amount_cents, paid_at, method, external_reference, attachment_ref, notes, recorded_by, idempotency_key)
           VALUES ($1,$2,$3,$4,'payment',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [ctx.organizationId, ctx.storeId, pid, batchId, total, paidAt, metodo, referencia, anexo, notas, ctx.userId, chave]
        ));
        for (const a of alocacoes) await c.query('INSERT INTO partner_payment_allocations (organization_id, payment_id, ledger_id, amount_cents) VALUES ($1,$2,$3,$4)', [ctx.organizationId, pagamento.id, a.ledgerId, a.amountCents]);
      } catch (err) {
        if (err && err.code === '23505') throw conflito('AFILIADOS_PAGAMENTO_DUPLICADO', 'esta referência de pagamento já foi lançada para o parceiro');
        if (err && err.code === '23514') throw erro(422, 'AFILIADOS_PAGAMENTO_EXCEDE_SALDO', 'o pagamento excede o saldo em aberto');
        throw err;
      }
      await db.auditar(c, ctx, { entidade: 'payment', entidadeId: pagamento.id, acao: 'payment.record', depois: { partnerId: pid, amountCents: total, paidAt, method: metodo, allocations: alocacoes.length, batchId } });
      return { ...mapearPagamento(pagamento), deduplicated: false, recibo: await montarRecibo(c, ctx, pagamento, alocacoes) };
    });
  }

  // Recibo GERENCIAL (não é comprovante bancário).
  async function montarRecibo(c, ctx, pagamento, alocacoes) {
    const { rows: p } = await c.query('SELECT public_name FROM partnership_partners WHERE organization_id = $1 AND id = $2', [ctx.organizationId, pagamento.partner_id]);
    const { rows: saldo } = await c.query(
      `SELECT COALESCE(sum(l.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = l.organization_id AND a.ledger_id = l.id), 0)), 0)::bigint AS aberto
         FROM partner_commission_ledger l WHERE l.organization_id = $1 AND l.partner_id = $2 AND l.status = 'released'`, [ctx.organizationId, pagamento.partner_id]
    );
    return {
      tipo: 'recibo gerencial (não é comprovante bancário)', parceiro: p[0] ? p[0].public_name : null, valorCents: numero(pagamento.amount_cents), pagoEm: pagamento.paid_at, registradoEm: pagamento.recorded_at,
      metodo: pagamento.method, referencia: pagamento.external_reference, lancamentos: alocacoes.length, saldoRestanteLiberadoCents: numero(saldo[0].aberto),
    };
  }

  async function estornarPagamento(ctx, paymentId, { motivo }) {
    const agora = relogio();
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    const id = exigirUuid(paymentId, 'pagamento');
    return db.tx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM partner_payment_records WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, id]);
      if (!rows[0]) throw naoEncontrado('pagamento');
      if (rows[0].kind !== 'payment') throw conflito('AFILIADOS_TRANSICAO_INVALIDA', 'só um pagamento pode ser estornado');
      await db.travarChave(c, ctx.organizationId, `payout:${rows[0].partner_id}`);
      const { rows: ja } = await c.query('SELECT id FROM partner_payment_records WHERE organization_id = $1 AND reverses_payment_id = $2', [ctx.organizationId, id]);
      if (ja[0]) throw conflito('AFILIADOS_PAGAMENTO_JA_ESTORNADO', 'este pagamento já foi estornado');
      const { rows: aloc } = await c.query('SELECT ledger_id, amount_cents FROM partner_payment_allocations WHERE organization_id = $1 AND payment_id = $2 ORDER BY ledger_id', [ctx.organizationId, id]);
      await c.query('SELECT 1 FROM partner_commission_ledger WHERE organization_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [ctx.organizationId, aloc.map((a) => a.ledger_id)]);
      const { rows: [est] } = await c.query(
        `INSERT INTO partner_payment_records (organization_id, store_id, partner_id, batch_id, kind, reverses_payment_id, amount_cents, paid_at, method, notes, reversal_reason, recorded_by, idempotency_key)
         VALUES ($1,$2,$3,$4,'reversal',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [ctx.organizationId, ctx.storeId, rows[0].partner_id, rows[0].batch_id, id, rows[0].amount_cents, agora, rows[0].method, `estorno do pagamento ${id}`, m, ctx.userId, `reversal:${id}`]
      );
      for (const a of aloc) await c.query('INSERT INTO partner_payment_allocations (organization_id, payment_id, ledger_id, amount_cents) VALUES ($1,$2,$3,$4)', [ctx.organizationId, est.id, a.ledger_id, -numero(a.amount_cents)]);
      await db.auditar(c, ctx, { entidade: 'payment', entidadeId: id, acao: 'payment.reverse', antes: { amountCents: numero(rows[0].amount_cents), paidAt: rows[0].paid_at }, depois: { reversalId: est.id }, motivo: m });
      return mapearPagamento(est);
    });
  }

  async function listarPagamentos(ctx, { partnerId = null, limite = 50 } = {}) {
    const params = [ctx.organizationId];
    let filtro = '';
    if (partnerId) { params.push(exigirUuid(partnerId, 'parceiro')); filtro = 'AND r.partner_id = $2'; }
    params.push(Math.min(Math.max(Number(limite) || 50, 1), 200));
    const { rows } = await pool.query(
      `SELECT r.*, p.public_name,
              (SELECT count(*) FROM partner_payment_allocations a WHERE a.organization_id = r.organization_id AND a.payment_id = r.id)::int AS lancamentos,
              EXISTS (SELECT 1 FROM partner_payment_records x WHERE x.organization_id = r.organization_id AND x.reverses_payment_id = r.id) AS estornado
         FROM partner_payment_records r JOIN partnership_partners p ON p.id = r.partner_id AND p.organization_id = r.organization_id
        WHERE r.organization_id = $1 ${filtro} ORDER BY r.paid_at DESC, r.recorded_at DESC LIMIT $${params.length}`, params
    );
    return rows.map((r) => ({ ...mapearPagamento(r), partnerName: r.public_name, allocationCount: r.lancamentos, reversed: r.estornado }));
  }

  // Vencimento manual: sempre com motivo e log (antes/depois por lançamento).
  async function alterarVencimento(ctx, { ledgerIds, batchId, dueAt, motivo }) {
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    const novo = dataIso(dueAt, { nome: 'novo vencimento' });
    const agora = relogio();
    const tz = (await registry.lerConfig(ctx)).timezone;
    const diaNovo = inicioDoDiaLocal(...dataLocal(novo, tz).split('-').map(Number), tz);
    return db.tx(pool, async (c) => {
      let ids = Array.isArray(ledgerIds) ? ledgerIds.map((i) => exigirUuid(i, 'lançamento')) : [];
      let lote = null;
      if (batchId) {
        const { rows } = await c.query('SELECT * FROM partner_payout_batches WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, exigirUuid(batchId, 'lote')]);
        if (!rows[0]) throw naoEncontrado('lote');
        lote = rows[0];
        const { rows: itens } = await c.query('SELECT ledger_id FROM partner_payout_batch_items WHERE organization_id = $1 AND batch_id = $2', [ctx.organizationId, lote.id]);
        ids = itens.map((i) => i.ledger_id);
      }
      if (!ids.length) throw entradaInvalida('informe ledgerIds ou batchId');
      const { rows: lancs } = await c.query(
        `SELECT l.id, l.due_at, l.status, (l.amount_cents - COALESCE((SELECT sum(a.amount_cents) FROM partner_payment_allocations a WHERE a.organization_id = l.organization_id AND a.ledger_id = l.id), 0))::bigint AS aberto
           FROM partner_commission_ledger l WHERE l.organization_id = $1 AND l.id = ANY($2::uuid[]) ORDER BY l.id FOR UPDATE OF l`, [ctx.organizationId, ids]
      );
      if (lancs.length !== ids.length) throw naoEncontrado('lançamento');
      let alterados = 0;
      for (const l of lancs) {
        if (numero(l.aberto) === 0) continue; // quitado: não há o que vencer
        await c.query('UPDATE partner_commission_ledger SET due_at = $3, due_at_overridden = true, updated_at = now() WHERE organization_id = $1 AND id = $2', [ctx.organizationId, l.id, diaNovo]);
        await db.auditar(c, ctx, { entidade: 'ledger', entidadeId: l.id, acao: 'ledger.due_at.change', antes: { dueAt: l.due_at }, depois: { dueAt: diaNovo }, motivo: m });
        alterados += 1;
      }
      if (lote) {
        await c.query('UPDATE partner_payout_batches SET due_at = $3, updated_at = now() WHERE organization_id = $1 AND id = $2', [ctx.organizationId, lote.id, diaNovo]);
        await db.auditar(c, ctx, { entidade: 'payout_batch', entidadeId: lote.id, acao: 'batch.due_at.change', antes: { dueAt: lote.due_at }, depois: { dueAt: diaNovo }, motivo: m });
      }
      return { alterados, dueAt: diaNovo, emAtraso: diasEmAtraso(diaNovo, agora, tz) };
    });
  }

  // Lançamento manual: cachê por conteúdo (categoria separada) ou ajuste administrativo, sempre com motivo.
  async function lancarManual(ctx, entrada) {
    const agora = relogio();
    const pid = exigirUuid(entrada.partnerId, 'parceiro');
    const categoria = opcao(entrada.category, ['commission', 'content_fee'], { nome: 'categoria' });
    const valor = inteiro(entrada.amountCents, { nome: 'valor (centavos)', min: -1000000000, max: 1000000000 });
    if (valor === 0) throw entradaInvalida('valor zero');
    const motivo = textoObrigatorio(entrada.reason, { max: 500, nome: 'motivo' });
    const tz = (await registry.lerConfig(ctx)).timezone;
    const venc = dataIso(entrada.dueAt, { nome: 'vencimento', obrigatorio: false });
    return db.tx(pool, async (c) => {
      await registry.obterParceiroBasico(c, ctx, pid);
      const { rows } = await c.query(
        `INSERT INTO partner_commission_ledger (organization_id, store_id, partner_id, entry_type, category, amount_cents, status, sale_at, release_at, estimated_payment_at, due_at, due_at_overridden, competence, origin_key, note, created_by)
         VALUES ($1,$2,$3,'manual_adjustment',$4,$5,'released',$6,$6,$7,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [ctx.organizationId, ctx.storeId, pid, categoria, valor, agora, venc ? inicioDoDiaLocal(...dataLocal(venc, tz).split('-').map(Number), tz) : null, !!venc,
          `${dataLocal(agora, tz).slice(0, 7)}-01`, `manual:${db.novoUuid()}`, motivo, ctx.userId || null]
      );
      await db.auditar(c, ctx, { entidade: 'ledger', entidadeId: rows[0].id, acao: 'ledger.manual', depois: { partnerId: pid, category: categoria, amountCents: valor }, motivo });
      return { id: rows[0].id, amountCents: valor, category: categoria };
    });
  }

  // ── Exportação CSV: mesmos filtros da tela, só colunas necessárias, sem PII de comprador ─────────
  async function exportarCsv(ctx, query) {
    const dados = await listarAPagar(ctx, { ...query, limit: 200, offset: 0 });
    const todas = [];
    let deslocamento = 0;
    const total = dados.total;
    while (deslocamento < total && deslocamento < 5000) {
      const pagina = deslocamento === 0 ? dados : await listarAPagar(ctx, { ...query, limit: 200, offset: deslocamento });
      todas.push(...pagina.itens);
      deslocamento += 200;
    }
    const linhas = todas.map((l) => ({
      parceiro: l.partnerName, modalidade: l.modalities.join('/'), categoria: l.category === 'content_fee' ? 'cachê por conteúdo' : 'comissão por venda', competencia: l.competence,
      pedidos: l.orderCount, unidades: l.units, receita_base: centavosParaDecimal(l.baseCents), comissao_bruta: centavosParaDecimal(l.grossCents), ajustes: centavosParaDecimal(l.adjustmentsCents),
      comissao_liberada: centavosParaDecimal(l.releasedCents), pago: centavosParaDecimal(l.paidCents), saldo_em_aberto: centavosParaDecimal(l.openCents), previsto_nao_liberado: centavosParaDecimal(l.forecastCents),
      status: l.status, data_estimada: l.estimatedAt ? dataLocal(l.estimatedAt, dados.filtros.timezone) : '', vencimento: l.dueAt ? dataLocal(l.dueAt, dados.filtros.timezone) : '',
      ultimo_pagamento: l.lastPaidAt ? dataLocal(l.lastPaidAt, dados.filtros.timezone) : '', dias_em_atraso: l.daysOverdue,
    }));
    const colunas = ['parceiro', 'modalidade', 'categoria', 'competencia', 'pedidos', 'unidades', 'receita_base', 'comissao_bruta', 'ajustes', 'comissao_liberada', 'pago', 'saldo_em_aberto',
      'previsto_nao_liberado', 'status', 'data_estimada', 'vencimento', 'ultimo_pagamento', 'dias_em_atraso'].map((chave) => ({ chave, titulo: chave }));
    return { csv: gerarCsv(colunas, linhas), linhas: linhas.length, filtros: dados.filtros };
  }

  return {
    listarAPagar, resumoDeAPagar, extratoDoParceiro, previaDeFechamento, criarLote, aprovarLote, anularLote, listarLotes, registrarPagamento, estornarPagamento, listarPagamentos,
    alterarVencimento, lancarManual, exportarCsv, lancamentosFiltrados, agregar, lerFiltros,
    constantes: { TIPOS_DE_DATA, STATUS_FINANCEIRO, METODOS },
  };
}

module.exports = { criarPayables };
