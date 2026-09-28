'use strict';

// Níveis (avaliação, propostas com aprovação do lojista, override auditado) e carteira de benefícios (peças).
// Nível NUNCA reescreve contrato em vigor nem comissão de venda passada: cada atribuição guarda a versão e o nível da data.
// Peça grátis não existe ao ingressar: é recompensa condicionada a vendas, saldo e atividade — ou exceção "criador convidado"
// autorizada e documentada, que não sobe nível.

const db = require('./db');
const levels = require('./levels');

const { erro, entradaInvalida, naoEncontrado, conflito, exigirUuid, textoOpcional, textoObrigatorio, inteiro, opcao } = db;

function criarProgressao({ pool, relogio = () => new Date(), registry }) {
  async function linhasDeAtribuicao(c, ctx, partnerId, desde) {
    const { rows } = await c.query(
      `SELECT ink_order_id, ink_item_id, status, sale_at, current_state FROM partnership_attributions
        WHERE organization_id = $1 AND partner_id = $2 AND sale_at >= $3`, [ctx.organizationId, partnerId, desde]
    );
    return rows.map((r) => ({
      inkOrderId: String(r.ink_order_id), inkItemId: String(r.ink_item_id), status: r.status, saleAt: r.sale_at,
      eligibleQty: Number(r.current_state.eligibleQty || 0), marginEligibleCents: r.current_state.marginEligibleCents === undefined ? null : r.current_state.marginEligibleCents,
      orderState: r.current_state.orderState,
    }));
  }

  function janelaMaxima(regras) { return Math.max(...regras.niveis.map((n) => n.janelaDias || 0), 90); }

  async function avaliar(c, ctx, partnerId, agora, config) {
    const { regras, version } = await registry.lerRegrasDeNivel(ctx, c);
    const atual = await registry.nivelAtualDoParceiro(c, ctx, partnerId, regras);
    const janela = janelaMaxima(regras);
    const linhas = await linhasDeAtribuicao(c, ctx, partnerId, new Date(agora.getTime() - janela * 86400000));
    const metricas = levels.metricasDaJanela(linhas, { agora, janelaDias: janela, contarPor: config.progressionCountsBy });
    const avaliacao = levels.avaliarNivel(metricas, regras, atual.key);
    return { regras, versaoDasRegras: version, atual, metricas, avaliacao };
  }

  async function avaliarParceiro(ctx, partnerId) {
    const agora = relogio();
    const c = await pool.connect();
    try {
      const parceiro = await registry.obterParceiroBasico(c, ctx, partnerId);
      const config = await registry.lerConfig(ctx, c);
      const r = await avaliar(c, ctx, parceiro.id, agora, config);
      const nivelAtual = levels.nivelDe(r.regras, r.atual.key);
      const { rows: pend } = await c.query(`SELECT * FROM partner_level_proposals WHERE organization_id = $1 AND partner_id = $2 AND status = 'pending'`, [ctx.organizationId, parceiro.id]);
      return {
        partnerId: parceiro.id, currentLevel: { key: r.atual.key, label: nivelAtual ? nivelAtual.label : r.atual.key, since: r.atual.desde, source: r.atual.origem, marginCapBps: nivelAtual ? nivelAtual.tetoMargemBps : null },
        metrics: r.metricas, evaluation: r.avaliacao, ruleSetVersion: r.versaoDasRegras, pendingProposal: pend[0] ? { id: pend[0].id, from: pend[0].from_level, to: pend[0].to_level, direction: pend[0].direction } : null,
        observacao: 'Metas de margem sem custo verificado ficam "não verificadas": não se promove com lucro inventado.',
      };
    } finally { c.release(); }
  }

  // Gera propostas (idempotente: no máximo uma pendente por parceiro). Rebaixamento só depois da carência configurada.
  async function gerarPropostas(ctx) {
    const agora = relogio();
    const c0 = await pool.connect();
    let parceiros; let config;
    try {
      config = await registry.lerConfig(ctx, c0);
      ({ rows: parceiros } = await c0.query(`SELECT id FROM partnership_partners WHERE organization_id = $1 AND application_status = 'approved' AND relationship_status IN ('active', 'paused')`, [ctx.organizationId]));
    } finally { c0.release(); }
    let criadas = 0;
    for (const p of parceiros) {
      await db.tx(pool, async (c) => {
        const r = await avaliar(c, ctx, p.id, agora, config);
        if (r.avaliacao.direcao === 'manter') return;
        const { rows: pend } = await c.query(`SELECT 1 FROM partner_level_proposals WHERE organization_id = $1 AND partner_id = $2 AND status = 'pending'`, [ctx.organizationId, p.id]);
        if (pend[0]) return;
        if (r.avaliacao.direcao === 'downgrade') {
          const desde = r.atual.desde ? new Date(r.atual.desde) : null;
          if (!desde || (agora.getTime() - desde.getTime()) < config.downgradeGraceDays * 86400000) return;
        }
        await c.query(
          `INSERT INTO partner_level_proposals (organization_id, store_id, partner_id, from_level, to_level, direction, observed, rule_set_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [ctx.organizationId, ctx.storeId, p.id, r.atual.key, r.avaliacao.nivelAlcancado, r.avaliacao.direcao, JSON.stringify(r.metricas), r.versaoDasRegras]
        );
        criadas += 1;
      });
    }
    return { propostasCriadas: criadas };
  }

  async function listarPropostas(ctx, { status = 'pending' } = {}) {
    const st = opcao(status, ['pending', 'approved', 'dismissed'], { nome: 'status' });
    const { rows } = await pool.query(
      `SELECT pr.*, p.public_name FROM partner_level_proposals pr JOIN partnership_partners p ON p.id = pr.partner_id AND p.organization_id = pr.organization_id
        WHERE pr.organization_id = $1 AND pr.status = $2 ORDER BY pr.created_at DESC LIMIT 200`, [ctx.organizationId, st]
    );
    const regras = (await registry.lerRegrasDeNivel(ctx)).regras;
    return rows.map((r) => ({
      id: r.id, partnerId: r.partner_id, partnerName: r.public_name, fromLevel: r.from_level, toLevel: r.to_level, direction: r.direction, observed: r.observed, status: r.status, createdAt: r.created_at,
      economicEffect: { newMarginCapBps: (levels.nivelDe(regras, r.to_level) || {}).tetoMargemBps ?? null, contractRewrite: false, note: 'O nível altera elegibilidade e benefícios e pode gerar proposta de novo contrato; nenhum contrato em vigor é reescrito.' },
    }));
  }

  async function decidirProposta(ctx, proposalId, { decisao, motivo }) {
    const d = opcao(decisao, ['approve', 'dismiss'], { nome: 'decisão' });
    const m = textoOpcional(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM partner_level_proposals WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, exigirUuid(proposalId, 'proposta')]);
      if (!rows[0]) throw naoEncontrado('proposta');
      if (rows[0].status !== 'pending') throw conflito('AFILIADOS_PROPOSTA_DECIDIDA', 'esta proposta já foi decidida');
      const status = d === 'approve' ? 'approved' : 'dismissed';
      await c.query('UPDATE partner_level_proposals SET status = $3, decided_by = $4, decided_at = now() WHERE organization_id = $1 AND id = $2', [ctx.organizationId, rows[0].id, status, ctx.userId || null]);
      if (d === 'approve') {
        await c.query(
          `INSERT INTO partner_level_history (organization_id, store_id, partner_id, level_key, effective_at, source, observed, rule_set_version, reason, approved_by)
           VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,$9)`,
          [ctx.organizationId, ctx.storeId, rows[0].partner_id, rows[0].to_level, rows[0].direction === 'downgrade' ? 'downgrade' : 'proposal_approved', JSON.stringify(rows[0].observed), rows[0].rule_set_version, m, ctx.userId || null]
        );
      }
      await db.auditar(c, ctx, { entidade: 'level_proposal', entidadeId: rows[0].id, acao: `level.proposal.${status}`, antes: { level: rows[0].from_level }, depois: { level: d === 'approve' ? rows[0].to_level : rows[0].from_level }, motivo: m });
      return { status, level: d === 'approve' ? rows[0].to_level : rows[0].from_level };
    });
  }

  async function definirNivelManual(ctx, partnerId, { level, reason }) {
    const m = textoObrigatorio(reason, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const parceiro = await registry.obterParceiroBasico(c, ctx, partnerId, { travar: true });
      const { regras, version } = await registry.lerRegrasDeNivel(ctx, c);
      const chave = String(level || '');
      if (!levels.nivelDe(regras, chave)) throw entradaInvalida('nível desconhecido nas regras da loja');
      const atual = await registry.nivelAtualDoParceiro(c, ctx, parceiro.id, regras);
      if (atual.key === chave) throw conflito('AFILIADOS_SEM_MUDANCA', 'o parceiro já está neste nível');
      await c.query(
        `INSERT INTO partner_level_history (organization_id, store_id, partner_id, level_key, effective_at, source, rule_set_version, reason, approved_by) VALUES ($1,$2,$3,$4,now(),'manual_override',$5,$6,$7)`,
        [ctx.organizationId, ctx.storeId, parceiro.id, chave, version, m, ctx.userId]
      );
      await c.query(`UPDATE partner_level_proposals SET status = 'dismissed', decided_by = $3, decided_at = now() WHERE organization_id = $1 AND partner_id = $2 AND status = 'pending'`, [ctx.organizationId, parceiro.id, ctx.userId || null]);
      await db.auditar(c, ctx, { entidade: 'partner', entidadeId: parceiro.id, acao: 'level.override', antes: { level: atual.key }, depois: { level: chave }, motivo: m });
      return { level: chave };
    });
  }

  async function historicoDeNiveis(ctx, partnerId) {
    const { rows } = await pool.query(
      `SELECT level_key, effective_at, source, reason, rule_set_version, observed FROM partner_level_history WHERE organization_id = $1 AND partner_id = $2 ORDER BY effective_at DESC, created_at DESC LIMIT 100`,
      [ctx.organizationId, exigirUuid(partnerId, 'parceiro')]
    );
    return rows.map((r) => ({ level: r.level_key, effectiveAt: r.effective_at, source: r.source, reason: r.reason, ruleSetVersion: r.rule_set_version, observed: r.observed }));
  }

  // ── Carteira de benefícios ──────────────────────────────────────────────────────────────────────
  async function saldoDeBeneficios(ctx, partnerId, executor = pool) {
    const { rows } = await executor.query(
      `SELECT COALESCE(sum(amount_cents), 0)::bigint AS saldo,
              COALESCE(sum(amount_cents) FILTER (WHERE entry_type = 'budget_credit'), 0)::bigint AS creditos,
              COALESCE(-sum(amount_cents) FILTER (WHERE entry_type IN ('consumption', 'exceptional_grant') AND amount_cents < 0), 0)::bigint AS consumido
         FROM partner_benefit_ledger WHERE organization_id = $1 AND partner_id = $2`, [ctx.organizationId, partnerId]
    );
    return { balanceCents: Number(rows[0].saldo), creditsCents: Number(rows[0].creditos), consumedCents: Number(rows[0].consumido) };
  }

  async function listarBeneficios(ctx, partnerId) {
    const pid = exigirUuid(partnerId, 'parceiro');
    const agora = relogio();
    const c = await pool.connect();
    try {
      const parceiro = await registry.obterParceiroBasico(c, ctx, pid);
      const saldo = await saldoDeBeneficios(ctx, pid, c);
      const { rows } = await c.query(
        `SELECT id, entry_type, amount_cents, production_cost_cents, shipping_cost_cents, description, guest_creator, deliverables, created_at, attribution_id
           FROM partner_benefit_ledger WHERE organization_id = $1 AND partner_id = $2 ORDER BY created_at DESC LIMIT 100`, [ctx.organizationId, pid]
      );
      const av = await avaliar(c, ctx, pid, agora, await registry.lerConfig(ctx, c));
      const nivel = levels.nivelDe(av.regras, av.atual.key);
      const { rows: ult } = await c.query(`SELECT max(created_at) AS ultima FROM partner_benefit_ledger WHERE organization_id = $1 AND partner_id = $2 AND entry_type = 'consumption'`, [ctx.organizationId, pid]);
      const elegibilidade = levels.elegibilidadeDePeca({ nivel, metricas: av.metricas, saldoBeneficioCents: saldo.balanceCents, custoPecaCents: null, ultimaPecaEm: ult[0].ultima, agora });
      return {
        partner: { id: parceiro.id, name: parceiro.public_name }, ...saldo, level: av.atual.key, pieceEligibility: elegibilidade,
        entries: rows.map((r) => ({
          id: r.id, entryType: r.entry_type, amountCents: Number(r.amount_cents), productionCostCents: r.production_cost_cents === null ? null : Number(r.production_cost_cents),
          shippingCostCents: r.shipping_cost_cents === null ? null : Number(r.shipping_cost_cents), description: r.description, guestCreator: r.guest_creator, deliverables: r.deliverables, createdAt: r.created_at,
        })),
        nota: 'A carteira de benefícios é separada das comissões e nunca vira dinheiro a pagar.',
      };
    } finally { c.release(); }
  }

  // Concede peça: debita produção + frete REAIS. Normal = precisa de elegibilidade e saldo. Criador convidado = exceção documentada.
  async function concederPeca(ctx, partnerId, entrada) {
    const agora = relogio();
    const producao = inteiro(entrada.productionCostCents, { nome: 'custo de produção (centavos)', min: 0, max: 100000000 });
    const frete = inteiro(entrada.shippingCostCents ?? 0, { nome: 'frete (centavos)', min: 0, max: 100000000 });
    const total = producao + frete;
    if (total <= 0) throw entradaInvalida('o custo real da peça (produção + frete) deve ser maior que zero');
    const descricao = textoObrigatorio(entrada.description, { max: 300, nome: 'descrição da peça' });
    const convidado = entrada.guestCreator === true;
    const entregaveis = convidado ? textoObrigatorio(entrada.deliverables, { max: 1000, nome: 'entregáveis combinados' }) : null;
    const chave = entrada.idempotencyKey ? textoObrigatorio(entrada.idempotencyKey, { max: 100, nome: 'idempotencyKey' }) : db.novoUuid();
    return db.tx(pool, async (c) => {
      const parceiro = await registry.obterParceiroBasico(c, ctx, partnerId, { travar: true });
      if (parceiro.application_status !== 'approved') throw conflito('AFILIADOS_PARCEIRO_NAO_APROVADO', 'aprove a candidatura antes de conceder benefícios');
      const dup = await c.query('SELECT id, amount_cents FROM partner_benefit_ledger WHERE organization_id = $1 AND partner_id = $2 AND origin_key = $3', [ctx.organizationId, parceiro.id, `grant:${chave}`]);
      if (dup.rows[0]) return { id: dup.rows[0].id, amountCents: Number(dup.rows[0].amount_cents), deduplicated: true };
      const saldo = await saldoDeBeneficios(ctx, parceiro.id, c);
      let tipo = 'consumption';
      if (convidado) tipo = 'exceptional_grant';
      else {
        const av = await avaliar(c, ctx, parceiro.id, agora, await registry.lerConfig(ctx, c));
        const nivel = levels.nivelDe(av.regras, av.atual.key);
        const { rows: ult } = await c.query(`SELECT max(created_at) AS ultima FROM partner_benefit_ledger WHERE organization_id = $1 AND partner_id = $2 AND entry_type = 'consumption'`, [ctx.organizationId, parceiro.id]);
        const el = levels.elegibilidadeDePeca({ nivel, metricas: av.metricas, saldoBeneficioCents: saldo.balanceCents, custoPecaCents: total, ultimaPecaEm: ult[0].ultima, agora });
        if (!el.elegivel) throw erro(422, 'AFILIADOS_PECA_NAO_ELEGIVEL', `peça não liberada: ${el.motivo}`, el);
      }
      const { rows } = await c.query(
        `INSERT INTO partner_benefit_ledger (organization_id, store_id, partner_id, entry_type, amount_cents, production_cost_cents, shipping_cost_cents, description, guest_creator, deliverables, origin_key, approved_by, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
        [ctx.organizationId, ctx.storeId, parceiro.id, tipo, -total, producao, frete, descricao, convidado, entregaveis, `grant:${chave}`, ctx.userId]
      );
      await db.auditar(c, ctx, { entidade: 'benefit', entidadeId: rows[0].id, acao: convidado ? 'benefit.guest_creator' : 'benefit.grant', depois: { partnerId: parceiro.id, amountCents: -total, guestCreator: convidado } });
      return { id: rows[0].id, amountCents: -total, deduplicated: false, balanceAfterCents: saldo.balanceCents - total };
    });
  }

  async function reverterBeneficio(ctx, entryId, { motivo }) {
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const { rows } = await c.query('SELECT * FROM partner_benefit_ledger WHERE organization_id = $1 AND id = $2 FOR UPDATE', [ctx.organizationId, exigirUuid(entryId, 'lançamento de benefício')]);
      if (!rows[0]) throw naoEncontrado('lançamento de benefício');
      if (!['consumption', 'exceptional_grant'].includes(rows[0].entry_type) || Number(rows[0].amount_cents) >= 0) throw conflito('AFILIADOS_TRANSICAO_INVALIDA', 'só consumo ou concessão excepcional pode ser revertido');
      const { rows: ins } = await c.query(
        `INSERT INTO partner_benefit_ledger (organization_id, store_id, partner_id, entry_type, amount_cents, description, origin_key, approved_by, created_by)
         VALUES ($1,$2,$3,'reversal',$4,$5,$6,$7,$7) ON CONFLICT (organization_id, partner_id, origin_key) DO NOTHING RETURNING id`,
        [ctx.organizationId, ctx.storeId, rows[0].partner_id, -Number(rows[0].amount_cents), `estorno: ${m}`.slice(0, 300), `reversal:${rows[0].id}`, ctx.userId]
      );
      if (!ins[0]) throw conflito('AFILIADOS_JA_REVERTIDO', 'este lançamento já foi revertido');
      await db.auditar(c, ctx, { entidade: 'benefit', entidadeId: rows[0].id, acao: 'benefit.reverse', antes: { amountCents: Number(rows[0].amount_cents) }, motivo: m });
      return { id: ins[0].id };
    });
  }

  return {
    avaliarParceiro, gerarPropostas, listarPropostas, decidirProposta, definirNivelManual, historicoDeNiveis, saldoDeBeneficios, listarBeneficios, concederPeca, reverterBeneficio,
  };
}

module.exports = { criarProgressao };
