'use strict';

// Cadastro do módulo de afiliados: configuração da loja, parceiros, contratos versionados e cupons.
// Toda mudança econômica é uma NOVA versão (append-only) com motivo e autor; nada reescreve comissão já capturada.

const db = require('./db');
const { percentualDe } = require('./money');
const { validarTimezone, TZ_PADRAO } = require('./schedule');
const { REGRAS_PADRAO, validarRegras, nivelDe } = require('./levels');
const { normalizarCodigo } = require('./engine');

const { erro, entradaInvalida, naoEncontrado, conflito, exigirUuid, textoOpcional, textoObrigatorio, inteiro, opcao, dataIso } = db;

const RE_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const RE_TELEFONE = /^[0-9+()\-.\s]{6,40}$/;
const RE_CODIGO_CUPOM = /^[A-Za-z0-9_-]{3,32}$/;
const REDES = ['instagram', 'tiktok', 'youtube', 'x', 'facebook', 'kwai', 'twitch', 'site', 'outro'];
const BASES = ['net_item_revenue_percent', 'verified_margin_percent', 'fixed_per_unit'];
const ROTULO_BASE = Object.freeze({
  net_item_revenue_percent: '% da receita líquida elegível do item',
  verified_margin_percent: '% da margem de produção verificada',
  fixed_per_unit: 'valor fixo por unidade',
});

function criarRegistry({ pool, relogio = () => new Date(), inkPromotions = null }) {
  // ── Configuração da loja ────────────────────────────────────────────────────────────────────────
  const CONFIG_PADRAO = Object.freeze({
    timezone: TZ_PADRAO, alertDays: [7, 3, 1], minContributionBps: 1000, benefitBudgetBps: 2500, progressionCountsBy: 'orders', downgradeGraceDays: 30, lastReconciledAt: null,
  });

  function mapearConfig(r) {
    if (!r) return { ...CONFIG_PADRAO, persistida: false };
    return {
      timezone: r.timezone, alertDays: r.alert_days, minContributionBps: r.min_contribution_bps, benefitBudgetBps: r.benefit_budget_bps,
      progressionCountsBy: r.progression_counts_by, downgradeGraceDays: r.downgrade_grace_days, lastReconciledAt: r.last_reconciled_at, persistida: true,
    };
  }

  async function lerConfig(ctx, executor = pool) {
    const { rows } = await executor.query('SELECT * FROM partnership_settings WHERE organization_id = $1', [ctx.organizationId]);
    return mapearConfig(rows[0]);
  }

  async function salvarConfig(ctx, entrada) {
    const atual = await lerConfig(ctx);
    const timezone = entrada.timezone === undefined ? atual.timezone : String(entrada.timezone);
    if (!validarTimezone(timezone)) throw entradaInvalida('timezone inválido');
    let alertDays = entrada.alertDays === undefined ? atual.alertDays : entrada.alertDays;
    if (!Array.isArray(alertDays) || alertDays.length === 0 || alertDays.length > 6 || alertDays.some((d) => !Number.isInteger(d) || d < 0 || d > 60)) {
      throw entradaInvalida('alertDays deve ter de 1 a 6 inteiros entre 0 e 60');
    }
    alertDays = [...new Set(alertDays)].sort((a, b) => b - a);
    const minContributionBps = entrada.minContributionBps === undefined ? atual.minContributionBps : inteiro(entrada.minContributionBps, { nome: 'minContributionBps', min: 0, max: 10000 });
    const benefitBudgetBps = entrada.benefitBudgetBps === undefined ? atual.benefitBudgetBps : inteiro(entrada.benefitBudgetBps, { nome: 'benefitBudgetBps', min: 0, max: 10000 });
    const progressionCountsBy = entrada.progressionCountsBy === undefined ? atual.progressionCountsBy : opcao(entrada.progressionCountsBy, ['orders', 'units'], { nome: 'progressionCountsBy' });
    const downgradeGraceDays = entrada.downgradeGraceDays === undefined ? atual.downgradeGraceDays : inteiro(entrada.downgradeGraceDays, { nome: 'downgradeGraceDays', min: 0, max: 365 });
    return db.tx(pool, async (c) => {
      await c.query(
        `INSERT INTO partnership_settings (organization_id, store_id, timezone, alert_days, min_contribution_bps, benefit_budget_bps, progression_counts_by, downgrade_grace_days)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (organization_id) DO UPDATE SET timezone = EXCLUDED.timezone, alert_days = EXCLUDED.alert_days, min_contribution_bps = EXCLUDED.min_contribution_bps,
           benefit_budget_bps = EXCLUDED.benefit_budget_bps, progression_counts_by = EXCLUDED.progression_counts_by, downgrade_grace_days = EXCLUDED.downgrade_grace_days, updated_at = now()`,
        [ctx.organizationId, ctx.storeId, timezone, alertDays, minContributionBps, benefitBudgetBps, progressionCountsBy, downgradeGraceDays]
      );
      const nova = { timezone, alertDays, minContributionBps, benefitBudgetBps, progressionCountsBy, downgradeGraceDays };
      await db.auditar(c, ctx, { entidade: 'settings', entidadeId: ctx.organizationId, acao: 'settings.update', antes: { ...atual, lastReconciledAt: undefined }, depois: nova });
      return { ...atual, ...nova, persistida: true };
    });
  }

  // ── Regras de nível (versionadas) ───────────────────────────────────────────────────────────────
  async function lerRegrasDeNivel(ctx, executor = pool) {
    const { rows } = await executor.query(
      'SELECT version, effective_from, rules, reason FROM partnership_level_rule_sets WHERE organization_id = $1 ORDER BY version DESC LIMIT 1', [ctx.organizationId]
    );
    if (!rows[0]) return { version: 0, regras: REGRAS_PADRAO, padrao: true, effectiveFrom: null };
    return { version: rows[0].version, regras: rows[0].rules, padrao: false, effectiveFrom: rows[0].effective_from, reason: rows[0].reason };
  }

  async function salvarRegrasDeNivel(ctx, { regras, motivo }) {
    try { validarRegras(regras); } catch (err) { throw entradaInvalida(err.message); }
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      await db.travarChave(c, ctx.organizationId, 'level-rules');
      const atual = await lerRegrasDeNivel(ctx, c);
      const versao = atual.version + 1;
      await c.query(
        `INSERT INTO partnership_level_rule_sets (organization_id, store_id, version, effective_from, rules, reason, approved_by)
         VALUES ($1,$2,$3,now(),$4,$5,$6)`,
        [ctx.organizationId, ctx.storeId, versao, JSON.stringify(regras), m, ctx.userId]
      );
      await db.auditar(c, ctx, { entidade: 'level_rules', entidadeId: versao, acao: 'level_rules.create', antes: atual.padrao ? null : atual.regras, depois: regras, motivo: m });
      return { version: versao, regras, padrao: false };
    });
  }

  async function nivelAtualDoParceiro(c, ctx, partnerId, regras) {
    const { rows } = await c.query(
      `SELECT level_key, effective_at, source FROM partner_level_history WHERE organization_id = $1 AND partner_id = $2 ORDER BY effective_at DESC, created_at DESC LIMIT 1`,
      [ctx.organizationId, partnerId]
    );
    if (rows[0] && nivelDe(regras, rows[0].level_key)) return { key: rows[0].level_key, desde: rows[0].effective_at, origem: rows[0].source };
    return { key: regras.niveis[0].key, desde: null, origem: 'padrao' };
  }

  // ── Parceiros ───────────────────────────────────────────────────────────────────────────────────
  function lerPerfis(perfis) {
    if (perfis === undefined || perfis === null) return [];
    if (!Array.isArray(perfis) || perfis.length > 10) throw entradaInvalida('perfis deve ser uma lista de até 10 itens');
    return perfis.map((p) => {
      if (!p || typeof p !== 'object') throw entradaInvalida('perfil inválido');
      const rede = opcao(p.network, REDES, { nome: 'perfil.network' });
      const handle = textoOpcional(p.handle, { max: 80, nome: 'perfil.handle' });
      const url = textoOpcional(p.url, { max: 300, nome: 'perfil.url' });
      if (url && !/^https:\/\/[^\s]+$/.test(url)) throw entradaInvalida('perfil.url deve começar com https://');
      return { network: rede, handle, url };
    });
  }

  function lerParceiro(entrada, { parcial = false } = {}) {
    const out = {};
    const campo = (k, fn) => { if (!parcial || entrada[k] !== undefined) out[k] = fn(entrada[k]); };
    campo('publicName', (v) => textoObrigatorio(v, { max: 120, nome: 'nome público' }));
    campo('contactName', (v) => textoOpcional(v, { max: 160, nome: 'contato' }));
    campo('contactEmail', (v) => {
      const e = textoOpcional(v, { max: 254, nome: 'e-mail' });
      if (e && !RE_EMAIL.test(e)) throw entradaInvalida('e-mail comercial inválido');
      return e;
    });
    campo('contactPhone', (v) => {
      const t = textoOpcional(v, { max: 40, nome: 'telefone' });
      if (t && !RE_TELEFONE.test(t)) throw entradaInvalida('telefone inválido');
      return t;
    });
    campo('profiles', lerPerfis);
    campo('origin', (v) => textoOpcional(v, { max: 120, nome: 'origem' }));
    campo('communityRegion', (v) => textoOpcional(v, { max: 120, nome: 'comunidade/região' }));
    campo('internalNotes', (v) => textoOpcional(v, { max: 4000, nome: 'observações' }));
    if (!parcial || entrada.legacyInkAffiliate !== undefined) out.legacyInkAffiliate = entrada.legacyInkAffiliate === true;
    return out;
  }

  const mapearParceiro = (r) => ({
    id: r.id, publicName: r.public_name, contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone, profiles: r.profiles,
    origin: r.origin, communityRegion: r.community_region, internalNotes: r.internal_notes,
    applicationStatus: r.application_status, relationshipStatus: r.relationship_status, termsVersion: r.terms_version, termsAcceptedAt: r.terms_accepted_at,
    legacyInkAffiliate: r.legacy_ink_affiliate, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  async function criarParceiro(ctx, entrada, { aprovarDireto = false } = {}) {
    const p = lerParceiro(entrada);
    return db.tx(pool, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO partnership_partners (organization_id, store_id, public_name, contact_name, contact_email, contact_phone, profiles, origin, community_region, internal_notes,
           legacy_ink_affiliate, application_status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [ctx.organizationId, ctx.storeId, p.publicName, p.contactName, p.contactEmail, p.contactPhone, JSON.stringify(p.profiles), p.origin, p.communityRegion, p.internalNotes,
          p.legacyInkAffiliate, aprovarDireto ? 'approved' : 'candidate', ctx.userId || null]
      );
      if (aprovarDireto) await registrarNivelInicial(c, ctx, rows[0].id);
      await db.auditar(c, ctx, { entidade: 'partner', entidadeId: rows[0].id, acao: 'partner.create', depois: { publicName: p.publicName, applicationStatus: rows[0].application_status } });
      return mapearParceiro(rows[0]);
    });
  }

  async function registrarNivelInicial(c, ctx, partnerId) {
    const regras = (await lerRegrasDeNivel(ctx, c)).regras;
    await c.query(
      `INSERT INTO partner_level_history (organization_id, store_id, partner_id, level_key, effective_at, source, rule_set_version, reason)
       VALUES ($1,$2,$3,$4,now(),'initial',$5,'aprovação do parceiro')`,
      [ctx.organizationId, ctx.storeId, partnerId, regras.niveis[0].key, (await lerRegrasDeNivel(ctx, c)).version]
    );
  }

  async function obterParceiroBasico(c, ctx, id, { travar = false } = {}) {
    const { rows } = await c.query(
      `SELECT * FROM partnership_partners WHERE organization_id = $1 AND id = $2 ${travar ? 'FOR UPDATE' : ''}`, [ctx.organizationId, exigirUuid(id, 'parceiro')]
    );
    if (!rows[0]) throw naoEncontrado('parceiro');
    return rows[0];
  }

  async function atualizarParceiro(ctx, id, entrada) {
    const p = lerParceiro(entrada, { parcial: true });
    return db.tx(pool, async (c) => {
      const antes = await obterParceiroBasico(c, ctx, id, { travar: true });
      const mapa = { publicName: 'public_name', contactName: 'contact_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', profiles: 'profiles',
        origin: 'origin', communityRegion: 'community_region', internalNotes: 'internal_notes', legacyInkAffiliate: 'legacy_ink_affiliate' };
      const sets = []; const valores = [ctx.organizationId, antes.id];
      for (const [k, coluna] of Object.entries(mapa)) {
        if (p[k] === undefined) continue;
        valores.push(k === 'profiles' ? JSON.stringify(p[k]) : p[k]);
        sets.push(`${coluna} = $${valores.length}`);
      }
      if (sets.length === 0) return mapearParceiro(antes);
      const { rows } = await c.query(`UPDATE partnership_partners SET ${sets.join(', ')}, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`, valores);
      const flagMudou = p.legacyInkAffiliate !== undefined && p.legacyInkAffiliate !== antes.legacy_ink_affiliate;
      await db.auditar(c, ctx, {
        entidade: 'partner', entidadeId: antes.id, acao: flagMudou ? 'partner.legacy_ink_affiliate' : 'partner.update',
        antes: { publicName: antes.public_name, legacyInkAffiliate: antes.legacy_ink_affiliate }, depois: { publicName: rows[0].public_name, legacyInkAffiliate: rows[0].legacy_ink_affiliate },
      });
      return mapearParceiro(rows[0]);
    });
  }

  async function decidirCandidatura(ctx, id, { decisao, motivo, termsVersion }) {
    const d = opcao(decisao, ['approved', 'rejected'], { nome: 'decisão' });
    const m = d === 'rejected' ? textoObrigatorio(motivo, { max: 500, nome: 'motivo' }) : textoOpcional(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const antes = await obterParceiroBasico(c, ctx, id, { travar: true });
      if (antes.application_status === d) return mapearParceiro(antes);
      const versaoTermos = textoOpcional(termsVersion, { max: 40, nome: 'versão dos termos' });
      const { rows } = await c.query(
        `UPDATE partnership_partners SET application_status = $3, terms_version = COALESCE($4, terms_version),
           terms_accepted_at = CASE WHEN $4::text IS NOT NULL THEN now() ELSE terms_accepted_at END,
           relationship_status = CASE WHEN $3 = 'rejected' THEN 'ended' ELSE relationship_status END, updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [ctx.organizationId, antes.id, d, versaoTermos]
      );
      if (d === 'approved') {
        const { rows: hist } = await c.query('SELECT 1 FROM partner_level_history WHERE organization_id = $1 AND partner_id = $2 LIMIT 1', [ctx.organizationId, antes.id]);
        if (hist.length === 0) await registrarNivelInicial(c, ctx, antes.id);
      }
      await db.auditar(c, ctx, { entidade: 'partner', entidadeId: antes.id, acao: `partner.application.${d}`, antes: { applicationStatus: antes.application_status }, depois: { applicationStatus: d }, motivo: m });
      return mapearParceiro(rows[0]);
    });
  }

  const TRANSICOES_VINCULO = Object.freeze({ draft: ['active', 'ended'], active: ['paused', 'ended'], paused: ['active', 'ended'], ended: [] });
  async function mudarVinculo(ctx, id, { status, motivo }) {
    const novo = opcao(status, ['draft', 'active', 'paused', 'ended'], { nome: 'status' });
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const antes = await obterParceiroBasico(c, ctx, id, { travar: true });
      if (antes.relationship_status === novo) return mapearParceiro(antes);
      if (!TRANSICOES_VINCULO[antes.relationship_status].includes(novo)) throw conflito('AFILIADOS_TRANSICAO_INVALIDA', `vínculo não pode ir de ${antes.relationship_status} para ${novo}`);
      if (novo === 'active' && antes.application_status !== 'approved') throw conflito('AFILIADOS_PARCEIRO_NAO_APROVADO', 'aprove a candidatura antes de ativar o vínculo');
      const { rows } = await c.query('UPDATE partnership_partners SET relationship_status = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *', [ctx.organizationId, antes.id, novo]);
      await db.auditar(c, ctx, { entidade: 'partner', entidadeId: antes.id, acao: 'partner.relationship', antes: { relationshipStatus: antes.relationship_status }, depois: { relationshipStatus: novo }, motivo: m });
      return mapearParceiro(rows[0]);
    });
  }

  // ── Contratos ───────────────────────────────────────────────────────────────────────────────────
  function lerTermos(entrada, base = null) {
    const t = base ? { ...base } : {};
    const tem = (k) => entrada[k] !== undefined;
    if (!base || tem('commissionBasis')) t.commissionBasis = opcao(entrada.commissionBasis, BASES, { nome: 'base da comissão' });
    if (t.commissionBasis === 'fixed_per_unit') {
      if (!base || tem('fixedPerUnitCents') || tem('commissionBasis')) t.fixedPerUnitCents = inteiro(entrada.fixedPerUnitCents ?? t.fixedPerUnitCents, { nome: 'valor fixo por unidade (centavos)', min: 0, max: 100000000 });
      t.commissionBps = null;
    } else {
      if (!base || tem('commissionBps') || tem('commissionBasis')) t.commissionBps = inteiro(entrada.commissionBps ?? t.commissionBps, { nome: 'percentual (bps)', min: 0, max: 10000 });
      t.fixedPerUnitCents = null;
    }
    if (!base || tem('fixedCampaignFeeCents')) t.fixedCampaignFeeCents = inteiro(entrada.fixedCampaignFeeCents, { nome: 'cachê por conteúdo (centavos)', min: 0, max: 1000000000, obrigatorio: false });
    if (!base || tem('conflictPolicy')) t.conflictPolicy = opcao(entrada.conflictPolicy, ['collab_precedence', 'coupon_precedence', 'split_explicit'], { nome: 'política de conflito', padrao: 'collab_precedence' });
    if (t.conflictPolicy === 'split_explicit') {
      t.splitCollabBps = inteiro(entrada.splitCollabBps ?? t.splitCollabBps, { nome: 'fatia da collab (bps)', min: 1, max: 9999 });
      t.splitCouponBps = 10000 - t.splitCollabBps;
      if (!base || tem('dualCommissionConfirmed') || tem('conflictPolicy')) t.dualCommissionConfirmed = entrada.dualCommissionConfirmed === true;
      if (!t.dualCommissionConfirmed) throw entradaInvalida('comissão dupla exige confirmação administrativa explícita (dualCommissionConfirmed)');
    } else { t.splitCollabBps = null; t.splitCouponBps = null; t.dualCommissionConfirmed = false; }
    if (!base || tem('releasePolicy')) t.releasePolicy = opcao(entrada.releasePolicy, ['delivery_plus_hold', 'payment_plus_days'], { nome: 'política de liberação', padrao: 'delivery_plus_hold' });
    if (!base || tem('releaseHoldDays')) t.releaseHoldDays = inteiro(entrada.releaseHoldDays ?? 7, { nome: 'carência (dias)', min: 0, max: 365 });
    if (!base || tem('payoutDay')) t.payoutDay = inteiro(entrada.payoutDay ?? 10, { nome: 'dia de pagamento', min: 1, max: 28 });
    if (!base || tem('payoutMonthOffset')) t.payoutMonthOffset = inteiro(entrada.payoutMonthOffset ?? 1, { nome: 'meses até o pagamento', min: 0, max: 12 });
    if (!base || tem('minPayoutCents')) t.minPayoutCents = inteiro(entrada.minPayoutCents ?? 5000, { nome: 'mínimo para repasse (centavos)', min: 0, max: 100000000 });
    if (!base || tem('accumulateBelowMin')) t.accumulateBelowMin = entrada.accumulateBelowMin === undefined ? true : entrada.accumulateBelowMin === true;
    if (!base || tem('weekendShift')) t.weekendShift = entrada.weekendShift === undefined ? true : entrada.weekendShift === true;
    if (!base || tem('newCollabMemberPolicy')) t.newCollabMemberPolicy = opcao(entrada.newCollabMemberPolicy, ['require_approval', 'auto_include'], { nome: 'política de novos produtos', padrao: 'require_approval' });
    if (!base || tem('progressionCountsBy')) t.progressionCountsBy = entrada.progressionCountsBy ? opcao(entrada.progressionCountsBy, ['orders', 'units'], { nome: 'contagem para nível' }) : null;
    if (!base || tem('levelCapOverrideReason')) t.levelCapOverrideReason = textoOpcional(entrada.levelCapOverrideReason, { max: 500, nome: 'motivo do override de teto' });
    if (!base || tem('notes')) t.notes = textoOpcional(entrada.notes, { max: 4000, nome: 'observações' });
    return t;
  }

  const mapearVersao = (r) => ({
    id: r.id, contractId: r.contract_id, version: r.version, status: r.status, effectiveFrom: r.effective_from,
    commissionBasis: r.commission_basis, commissionBasisLabel: ROTULO_BASE[r.commission_basis], commissionBps: r.commission_bps, fixedPerUnitCents: r.fixed_per_unit_cents,
    fixedCampaignFeeCents: r.fixed_campaign_fee_cents, conflictPolicy: r.conflict_policy, splitCouponBps: r.split_coupon_bps, splitCollabBps: r.split_collab_bps,
    releasePolicy: r.release_policy, releaseHoldDays: r.release_hold_days, payoutDay: r.payout_day, payoutMonthOffset: r.payout_month_offset, minPayoutCents: Number(r.min_payout_cents),
    accumulateBelowMin: r.accumulate_below_min, weekendShift: r.weekend_shift, newCollabMemberPolicy: r.new_collab_member_policy, progressionCountsBy: r.progression_counts_by,
    levelKey: r.level_key, levelCapOverrideReason: r.level_cap_override_reason, notes: r.notes, reason: r.reason, approvedBy: r.approved_by, createdAt: r.created_at,
  });

  // Amostra: vendas gerais da loja nos últimos 90 dias (paga, sem troca), em centavos. Serve à simulação e à equivalência com o teto.
  async function amostraDeVendas(c, ctx, agora) {
    const { rows } = await c.query(
      `SELECT count(DISTINCT i.ink_order_id)::int AS pedidos, COALESCE(sum(i.quantidade), 0)::bigint AS unidades,
              COALESCE(sum(round((i.valor_venda - i.desconto_rateado) * 100)), 0)::bigint AS receita_cents,
              COALESCE(sum(round(i.custo_producao * 100)), 0)::bigint AS custo_cents
         FROM pedidos_ink_itens i JOIN pedidos_ink p ON p.organization_id = i.organization_id AND p.store_id = i.store_id AND p.ink_order_id = i.ink_order_id
        WHERE i.organization_id = $1 AND p.criado_em >= $2 AND p.payment_status IN ('paid', 'succeeded', 'free') AND p.is_troca IS NOT TRUE`,
      [ctx.organizationId, new Date(agora.getTime() - 90 * 86400000)]
    );
    const r = rows[0];
    return { pedidos: r.pedidos, unidades: Number(r.unidades), receitaCents: Number(r.receita_cents), custoCents: Number(r.custo_cents), margemCents: Number(r.receita_cents) - Number(r.custo_cents), janelaDias: 90, escopo: 'vendas gerais da loja' };
  }

  function comissaoNaAmostra(termos, a) {
    if (termos.commissionBasis === 'fixed_per_unit') return termos.fixedPerUnitCents * a.unidades;
    if (termos.commissionBasis === 'net_item_revenue_percent') return percentualDe(a.receitaCents, termos.commissionBps);
    return a.margemCents > 0 ? percentualDe(a.margemCents, termos.commissionBps) : 0;
  }

  // Simulação e teto do nível: percentual sobre margem compara direto; os demais só por equivalência projetada na amostra.
  async function avaliarTeto(c, ctx, termos, levelKey, agora) {
    const regras = (await lerRegrasDeNivel(ctx, c)).regras;
    const nivel = nivelDe(regras, levelKey) || regras.niveis[0];
    const amostra = await amostraDeVendas(c, ctx, agora);
    const comissao = comissaoNaAmostra(termos, amostra);
    let equivalenteBps = null;
    if (termos.commissionBasis === 'verified_margin_percent') equivalenteBps = termos.commissionBps;
    else if (amostra.margemCents > 0 && amostra.pedidos > 0) equivalenteBps = Math.round((comissao * 10000) / amostra.margemCents);
    return {
      nivel: nivel.key, tetoMargemBps: nivel.tetoMargemBps, equivalenteMargemBps: equivalenteBps, dentroDoTeto: equivalenteBps === null ? null : equivalenteBps <= nivel.tetoMargemBps,
      verificacao: termos.commissionBasis === 'verified_margin_percent' ? 'direta' : (equivalenteBps === null ? 'sem_amostra' : 'equivalencia_projetada'), amostra, comissaoNaAmostraCents: comissao,
    };
  }

  async function simularContrato(ctx, entrada) {
    const agora = relogio();
    const bases = Array.isArray(entrada.comparar) && entrada.comparar.length ? entrada.comparar : [entrada];
    if (bases.length > 5) throw entradaInvalida('compare no máximo 5 alternativas');
    const c = await pool.connect();
    try {
      const resultado = [];
      for (const alt of bases) {
        const termos = lerTermos({ conflictPolicy: 'collab_precedence', ...alt });
        const teto = await avaliarTeto(c, ctx, termos, alt.levelKey || null, agora);
        resultado.push({
          commissionBasis: termos.commissionBasis, rotulo: ROTULO_BASE[termos.commissionBasis], commissionBps: termos.commissionBps, fixedPerUnitCents: termos.fixedPerUnitCents,
          comissaoNaAmostraCents: teto.comissaoNaAmostraCents, equivalenteMargemBps: teto.equivalenteMargemBps, tetoMargemBps: teto.tetoMargemBps, dentroDoTeto: teto.dentroDoTeto, verificacao: teto.verificacao,
        });
      }
      const amostra = await amostraDeVendas(c, ctx, agora);
      return { amostra, alternativas: resultado, aviso: 'Simulação sobre as vendas gerais da loja nos últimos 90 dias; não é previsão de vendas do parceiro. Margem = receita líquida − custo de produção da INK (sem taxas e impostos).' };
    } finally { c.release(); }
  }

  async function inserirVersao(c, ctx, contractId, versao, termos, { status, effectiveFrom, motivo, levelKey }) {
    const t = termos;
    const { rows } = await c.query(
      `INSERT INTO partnership_contract_versions (organization_id, store_id, contract_id, version, status, effective_from, commission_basis, commission_bps, fixed_per_unit_cents,
         fixed_campaign_fee_cents, conflict_policy, split_coupon_bps, split_collab_bps, dual_commission_confirmed_by, release_policy, release_hold_days, payout_day, payout_month_offset,
         min_payout_cents, accumulate_below_min, weekend_shift, new_collab_member_policy, progression_counts_by, level_key, level_cap_override_reason, notes, reason, approved_by, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$28) RETURNING *`,
      [ctx.organizationId, ctx.storeId, contractId, versao, status, effectiveFrom, t.commissionBasis, t.commissionBps, t.fixedPerUnitCents, t.fixedCampaignFeeCents,
        t.conflictPolicy, t.splitCouponBps, t.splitCollabBps, t.dualCommissionConfirmed ? ctx.userId : null, t.releasePolicy, t.releaseHoldDays, t.payoutDay, t.payoutMonthOffset,
        t.minPayoutCents, t.accumulateBelowMin, t.weekendShift, t.newCollabMemberPolicy, t.progressionCountsBy, levelKey, t.levelCapOverrideReason, t.notes, motivo, ctx.userId]
    );
    return rows[0];
  }

  async function exigirTetoOuOverride(c, ctx, termos, levelKey, agora) {
    const teto = await avaliarTeto(c, ctx, termos, levelKey, agora);
    if (teto.dentroDoTeto !== true && !termos.levelCapOverrideReason) {
      throw erro(422, 'AFILIADOS_ACIMA_DO_TETO', teto.dentroDoTeto === false
        ? `a remuneração equivale a ${(teto.equivalenteMargemBps / 100).toFixed(1)}% da margem, acima do teto de ${(teto.tetoMargemBps / 100).toFixed(1)}% do nível ${teto.nivel}; informe o motivo do override`
        : 'sem amostra de vendas para verificar o teto do nível; informe o motivo do override', teto);
    }
    return teto;
  }

  async function criarContrato(ctx, entrada, { podeAtivar = false } = {}) {
    const agora = relogio();
    const partnerId = exigirUuid(entrada.partnerId, 'parceiro');
    const modalidade = opcao(entrada.modality, ['coupon', 'collab', 'hybrid'], { nome: 'modalidade' });
    const titulo = textoObrigatorio(entrada.title, { max: 160, nome: 'título' });
    const motivo = textoObrigatorio(entrada.reason, { max: 500, nome: 'motivo' });
    const status = opcao(entrada.status, ['draft', 'active'], { nome: 'status', padrao: 'draft' });
    if (status === 'active' && !podeAtivar) throw erro(403, 'AFILIADOS_SEM_PERMISSAO', 'ativar contrato exige owner');
    const termos = lerTermos(entrada.terms || {});
    let efetivoDe = dataIso(entrada.effectiveFrom, { nome: 'início da vigência', obrigatorio: false }) || agora;
    if (efetivoDe.getTime() < agora.getTime() - 60000) {
      if (!(entrada.retroactive === true && podeAtivar)) throw entradaInvalida('vigência retroativa exige owner e retroactive=true (não reescreve vendas já capturadas)');
    }
    return db.tx(pool, async (c) => {
      const parceiro = await obterParceiroBasico(c, ctx, partnerId, { travar: true });
      const levelKey = (await nivelAtualDoParceiro(c, ctx, parceiro.id, (await lerRegrasDeNivel(ctx, c)).regras)).key;
      let teto = null;
      if (status === 'active') {
        if (parceiro.application_status !== 'approved') throw conflito('AFILIADOS_PARCEIRO_NAO_APROVADO', 'aprove a candidatura antes de ativar um contrato');
        teto = await exigirTetoOuOverride(c, ctx, termos, levelKey, agora);
      } else teto = await avaliarTeto(c, ctx, termos, levelKey, agora);
      const { rows } = await c.query(
        `INSERT INTO partnership_contracts (organization_id, store_id, partner_id, modality, title, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.organizationId, ctx.storeId, parceiro.id, modalidade, titulo, ctx.userId || null]
      );
      const v = await inserirVersao(c, ctx, rows[0].id, 1, termos, { status, effectiveFrom: efetivoDe, motivo, levelKey });
      if (status === 'active' && parceiro.relationship_status === 'draft' && parceiro.application_status === 'approved') {
        await c.query(`UPDATE partnership_partners SET relationship_status = 'active', updated_at = now() WHERE organization_id = $1 AND id = $2`, [ctx.organizationId, parceiro.id]);
      }
      await db.auditar(c, ctx, { entidade: 'contract', entidadeId: rows[0].id, acao: 'contract.create', depois: { modality: modalidade, version: 1, status, basis: termos.commissionBasis, commissionBps: termos.commissionBps, fixedPerUnitCents: termos.fixedPerUnitCents }, motivo });
      return { contract: { id: rows[0].id, partnerId: parceiro.id, modality: modalidade, title: titulo }, version: mapearVersao(v), teto };
    });
  }

  async function ultimaVersao(c, ctx, contractId, { travar = false } = {}) {
    const { rows } = await c.query(
      `SELECT v.*, k.partner_id, k.modality FROM partnership_contract_versions v JOIN partnership_contracts k ON k.id = v.contract_id AND k.organization_id = v.organization_id
        WHERE v.organization_id = $1 AND v.contract_id = $2 ORDER BY v.version DESC LIMIT 1 ${travar ? 'FOR UPDATE OF v' : ''}`,
      [ctx.organizationId, exigirUuid(contractId, 'contrato')]
    );
    if (!rows[0]) throw naoEncontrado('contrato');
    return rows[0];
  }

  function termosDaVersao(v) {
    return {
      commissionBasis: v.commission_basis, commissionBps: v.commission_bps, fixedPerUnitCents: v.fixed_per_unit_cents === null ? null : Number(v.fixed_per_unit_cents),
      fixedCampaignFeeCents: v.fixed_campaign_fee_cents === null ? null : Number(v.fixed_campaign_fee_cents), conflictPolicy: v.conflict_policy, splitCouponBps: v.split_coupon_bps, splitCollabBps: v.split_collab_bps,
      dualCommissionConfirmed: !!v.dual_commission_confirmed_by, releasePolicy: v.release_policy, releaseHoldDays: v.release_hold_days, payoutDay: v.payout_day, payoutMonthOffset: v.payout_month_offset,
      minPayoutCents: Number(v.min_payout_cents), accumulateBelowMin: v.accumulate_below_min, weekendShift: v.weekend_shift, newCollabMemberPolicy: v.new_collab_member_policy,
      progressionCountsBy: v.progression_counts_by, levelCapOverrideReason: v.level_cap_override_reason, notes: v.notes,
    };
  }

  const TRANSICOES_CONTRATO = Object.freeze({ draft: ['draft', 'active', 'ended'], active: ['active', 'paused', 'ended'], paused: ['paused', 'active', 'ended'], ended: [] });

  // Nova versão: muda termos e/ou estado. `effective_from` nunca reescreve comissão já capturada (cada atribuição guarda a sua versão).
  async function novaVersaoDeContrato(ctx, contractId, entrada, { podeAtivar = false } = {}) {
    const agora = relogio();
    const motivo = textoObrigatorio(entrada.reason, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const atual = await ultimaVersao(c, ctx, contractId, { travar: true });
      const status = opcao(entrada.status, ['draft', 'active', 'paused', 'ended'], { nome: 'status', padrao: atual.status });
      if (!TRANSICOES_CONTRATO[atual.status].includes(status)) throw conflito('AFILIADOS_TRANSICAO_INVALIDA', `contrato não pode ir de ${atual.status} para ${status}`);
      const mudaEstadoParaAtivo = status === 'active' && atual.status !== 'active';
      const mudaEconomia = entrada.terms && Object.keys(entrada.terms).length > 0 && atual.status !== 'draft';
      if ((mudaEstadoParaAtivo || status === 'paused' || status === 'ended' || mudaEconomia) && !podeAtivar) throw erro(403, 'AFILIADOS_SEM_PERMISSAO', 'alterar condições ou estado do contrato exige owner');
      const termos = lerTermos(entrada.terms || {}, termosDaVersao(atual));
      let efetivoDe = dataIso(entrada.effectiveFrom, { nome: 'início da vigência', obrigatorio: false }) || agora;
      if (efetivoDe.getTime() < agora.getTime() - 60000 && !(entrada.retroactive === true && podeAtivar)) throw entradaInvalida('vigência retroativa exige owner e retroactive=true (não reescreve vendas já capturadas)');
      if (efetivoDe.getTime() < new Date(atual.effective_from).getTime()) efetivoDe = new Date(atual.effective_from);
      const parceiro = await obterParceiroBasico(c, ctx, atual.partner_id);
      const levelKey = (await nivelAtualDoParceiro(c, ctx, parceiro.id, (await lerRegrasDeNivel(ctx, c)).regras)).key;
      let teto = null;
      if (status === 'active') {
        if (parceiro.application_status !== 'approved') throw conflito('AFILIADOS_PARCEIRO_NAO_APROVADO', 'aprove a candidatura antes de ativar um contrato');
        teto = await exigirTetoOuOverride(c, ctx, termos, levelKey, agora);
      }
      const v = await inserirVersao(c, ctx, atual.contract_id, atual.version + 1, termos, { status, effectiveFrom: efetivoDe, motivo, levelKey });
      if (status === 'active' && parceiro.relationship_status === 'draft' && parceiro.application_status === 'approved') {
        await c.query(`UPDATE partnership_partners SET relationship_status = 'active', updated_at = now() WHERE organization_id = $1 AND id = $2`, [ctx.organizationId, parceiro.id]);
      }
      await db.auditar(c, ctx, {
        entidade: 'contract', entidadeId: atual.contract_id, acao: 'contract.version',
        antes: { version: atual.version, status: atual.status, ...termosDaVersao(atual) }, depois: { version: v.version, status, ...termos }, motivo,
      });
      return { version: mapearVersao(v), teto };
    });
  }

  async function listarContratosDoParceiro(ctx, partnerId, executor = pool) {
    const { rows } = await executor.query(
      `SELECT k.id AS contract_id, k.modality, k.title, k.created_at AS contract_created_at, v.*
         FROM partnership_contracts k JOIN partnership_contract_versions v ON v.contract_id = k.id AND v.organization_id = k.organization_id
        WHERE k.organization_id = $1 AND k.partner_id = $2 ORDER BY k.created_at, v.version`,
      [ctx.organizationId, exigirUuid(partnerId, 'parceiro')]
    );
    const porContrato = new Map();
    for (const r of rows) {
      if (!porContrato.has(r.contract_id)) porContrato.set(r.contract_id, { id: r.contract_id, modality: r.modality, title: r.title, createdAt: r.contract_created_at, versions: [] });
      porContrato.get(r.contract_id).versions.push(mapearVersao(r));
    }
    return [...porContrato.values()].map((k) => ({ ...k, current: k.versions[k.versions.length - 1] }));
  }

  // ── Cupons ──────────────────────────────────────────────────────────────────────────────────────
  const mapearCupom = (r) => ({
    id: r.id, partnerId: r.partner_id, contractId: r.contract_id, codeDisplay: r.code_display, codeNormalized: r.code_normalized,
    discountKind: r.discount_kind, discountBps: r.discount_bps, discountCents: r.discount_cents === null ? null : Number(r.discount_cents),
    validFrom: r.valid_from, validUntil: r.valid_until, status: r.status, syncMode: r.sync_mode, syncStatus: r.sync_status, inkPromotionId: r.ink_promotion_id === null ? null : Number(r.ink_promotion_id),
    lastSyncedAt: r.last_synced_at, syncError: r.sync_error, createdAt: r.created_at,
  });

  async function obterCupom(c, ctx, id, { travar = false } = {}) {
    const { rows } = await c.query(`SELECT * FROM partner_coupon_links WHERE organization_id = $1 AND id = $2 ${travar ? 'FOR UPDATE' : ''}`, [ctx.organizationId, exigirUuid(id, 'cupom')]);
    if (!rows[0]) throw naoEncontrado('cupom');
    return rows[0];
  }

  function erroDeSobreposicao(err) {
    if (err && err.code === '23P01') return conflito('AFILIADOS_CUPOM_SOBREPOSTO', 'este código já tem vigência sobreposta nesta loja');
    return err;
  }

  async function criarCupom(ctx, entrada) {
    const agora = relogio();
    const codigo = textoObrigatorio(entrada.code, { max: 64, nome: 'código' });
    if (!RE_CODIGO_CUPOM.test(codigo)) throw entradaInvalida('código deve ter 3–32 caracteres (letras, números, _ e -)');
    const partnerId = exigirUuid(entrada.partnerId, 'parceiro');
    const contractId = exigirUuid(entrada.contractId, 'contrato');
    const tipo = entrada.discountKind ? opcao(entrada.discountKind, ['percentage', 'value'], { nome: 'tipo de desconto' }) : null;
    const bps = tipo === 'percentage' ? inteiro(entrada.discountBps, { nome: 'desconto (bps)', min: 1, max: 10000 }) : null;
    const centavos = tipo === 'value' ? inteiro(entrada.discountCents, { nome: 'desconto (centavos)', min: 1, max: 100000000 }) : null;
    const validFrom = dataIso(entrada.validFrom, { nome: 'início da vigência', obrigatorio: false }) || agora;
    const validUntil = dataIso(entrada.validUntil, { nome: 'fim da vigência', obrigatorio: false });
    if (validUntil && validUntil <= validFrom) throw entradaInvalida('fim da vigência deve ser depois do início');
    return db.tx(pool, async (c) => {
      const ultima = await ultimaVersao(c, ctx, contractId);
      if (ultima.partner_id !== partnerId) throw naoEncontrado('contrato');
      if (!['coupon', 'hybrid'].includes(ultima.modality)) throw conflito('AFILIADOS_MODALIDADE_INCOMPATIVEL', 'o contrato não é de cupom nem híbrido');
      try {
        const { rows } = await c.query(
          `INSERT INTO partner_coupon_links (organization_id, store_id, partner_id, contract_id, code_display, code_normalized, discount_kind, discount_bps, discount_cents, valid_from, valid_until,
             status, sync_mode, sync_status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending_validation','manual','manual_unverified',$12) RETURNING *`,
          [ctx.organizationId, ctx.storeId, partnerId, contractId, codigo, normalizarCodigo(codigo), tipo, bps, centavos, validFrom, validUntil, ctx.userId || null]
        );
        await db.auditar(c, ctx, { entidade: 'coupon', entidadeId: rows[0].id, acao: 'coupon.create', depois: { code: rows[0].code_normalized, partnerId, validFrom, validUntil } });
        return mapearCupom(rows[0]);
      } catch (err) { throw erroDeSobreposicao(err); }
    });
  }

  async function ativarCupom(ctx, id, { retroativo = false, motivo = null } = {}) {
    const agora = relogio();
    return db.tx(pool, async (c) => {
      const cupom = await obterCupom(c, ctx, id, { travar: true });
      if (cupom.status === 'active') return mapearCupom(cupom);
      if (!['planned', 'pending_validation'].includes(cupom.status)) throw conflito('AFILIADOS_TRANSICAO_INVALIDA', `cupom ${cupom.status} não pode ser ativado; crie um novo vínculo`);
      const versao = await ultimaVersao(c, ctx, cupom.contract_id);
      if (versao.status !== 'active') throw erro(422, 'AFILIADOS_CONTRATO_INATIVO', 'ative o contrato antes de ativar o cupom');
      if (retroativo && !textoOpcional(motivo, { max: 500, nome: 'motivo' })) throw entradaInvalida('ativação retroativa exige motivo');
      // Nunca retroativo por padrão: pedidos anteriores à ativação não passam a comissionar.
      const validFrom = retroativo ? new Date(cupom.valid_from) : new Date(Math.max(new Date(cupom.valid_from).getTime(), agora.getTime()));
      try {
        const { rows } = await c.query(
          `UPDATE partner_coupon_links SET status = 'active', valid_from = $3, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`, [ctx.organizationId, cupom.id, validFrom]
        );
        await db.auditar(c, ctx, { entidade: 'coupon', entidadeId: cupom.id, acao: retroativo ? 'coupon.activate.retroactive' : 'coupon.activate', antes: { status: cupom.status, validFrom: cupom.valid_from }, depois: { status: 'active', validFrom }, motivo });
        return mapearCupom(rows[0]);
      } catch (err) { throw erroDeSobreposicao(err); }
    });
  }

  // Pausar/encerrar fecha a vigência AGORA: vendas durante a pausa nunca serão remuneradas por reprocessamento posterior.
  async function encerrarVigenciaDoCupom(ctx, id, novoStatus, motivo) {
    const agora = relogio();
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const cupom = await obterCupom(c, ctx, id, { travar: true });
      if (!['active', 'pending_validation', 'planned'].includes(cupom.status) && !(novoStatus === 'ended' && cupom.status === 'paused')) throw conflito('AFILIADOS_TRANSICAO_INVALIDA', `cupom ${cupom.status} não pode ir para ${novoStatus}`);
      const fim = cupom.valid_until && new Date(cupom.valid_until) < agora ? new Date(cupom.valid_until) : (agora > new Date(cupom.valid_from) ? agora : new Date(new Date(cupom.valid_from).getTime() + 1000));
      const { rows } = await c.query(
        `UPDATE partner_coupon_links SET status = $3, valid_until = $4, updated_at = now() WHERE organization_id = $1 AND id = $2 RETURNING *`, [ctx.organizationId, cupom.id, novoStatus, fim]
      );
      await db.auditar(c, ctx, { entidade: 'coupon', entidadeId: cupom.id, acao: `coupon.${novoStatus === 'paused' ? 'pause' : 'end'}`, antes: { status: cupom.status, validUntil: cupom.valid_until }, depois: { status: novoStatus, validUntil: fim }, motivo: m });
      return mapearCupom(rows[0]);
    });
  }
  const pausarCupom = (ctx, id, motivo) => encerrarVigenciaDoCupom(ctx, id, 'paused', motivo);
  const encerrarCupom = (ctx, id, motivo) => encerrarVigenciaDoCupom(ctx, id, 'ended', motivo);

  // Retomar cria um NOVO vínculo (nova vigência) com o mesmo código: a pausa continua sem remuneração no histórico.
  async function retomarCupom(ctx, id, motivo) {
    const agora = relogio();
    const m = textoObrigatorio(motivo, { max: 500, nome: 'motivo' });
    return db.tx(pool, async (c) => {
      const cupom = await obterCupom(c, ctx, id, { travar: true });
      if (cupom.status !== 'paused') throw conflito('AFILIADOS_TRANSICAO_INVALIDA', 'só cupom pausado pode ser retomado');
      const versao = await ultimaVersao(c, ctx, cupom.contract_id);
      if (versao.status !== 'active') throw erro(422, 'AFILIADOS_CONTRATO_INATIVO', 'ative o contrato antes de retomar o cupom');
      try {
        const { rows } = await c.query(
          `INSERT INTO partner_coupon_links (organization_id, store_id, partner_id, contract_id, code_display, code_normalized, discount_kind, discount_bps, discount_cents, valid_from,
             status, sync_mode, sync_status, ink_promotion_id, last_synced_at, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15) RETURNING *`,
          [ctx.organizationId, ctx.storeId, cupom.partner_id, cupom.contract_id, cupom.code_display, cupom.code_normalized, cupom.discount_kind, cupom.discount_bps, cupom.discount_cents, agora,
            cupom.sync_mode, cupom.sync_status, cupom.ink_promotion_id, cupom.last_synced_at, ctx.userId || null]
        );
        await db.auditar(c, ctx, { entidade: 'coupon', entidadeId: rows[0].id, acao: 'coupon.resume', antes: { pausedCouponId: cupom.id }, depois: { validFrom: agora }, motivo: m });
        return mapearCupom(rows[0]);
      } catch (err) { throw erroDeSobreposicao(err); }
    });
  }

  async function previsualizarCriacaoNaInk(ctx, id) {
    const c = await pool.connect();
    try {
      const cupom = mapearCupom(await obterCupom(c, ctx, id));
      const adapter = inkPromotions;
      if (!adapter) return { ok: false, problemas: ['adaptador da INK indisponível'], escritaHabilitada: false, enviaria: false, request: null };
      return adapter.previsualizarCriacao(cupom);
    } finally { c.release(); }
  }

  async function criarCupomNaInk(ctx, id) {
    const c = await pool.connect();
    let cupom;
    try { cupom = mapearCupom(await obterCupom(c, ctx, id)); } finally { c.release(); }
    if (!inkPromotions) throw erro(409, 'INK_PROMOTION_WRITES_DISABLED', 'escrita de promoções na INK está desligada; cadastre o cupom no painel da INK e use o cadastro manual');
    try {
      const r = await inkPromotions.criarPromocao(cupom);
      await db.tx(pool, async (t) => {
        await t.query(
          `UPDATE partner_coupon_links SET ink_promotion_id = $3, sync_mode = 'ink_managed', sync_status = $4, last_synced_at = now(), sync_error = NULL, updated_at = now() WHERE organization_id = $1 AND id = $2`,
          [ctx.organizationId, cupom.id, r.promotionId, r.confirmacao.status === 'confirmed' ? 'confirmed' : 'divergent']
        );
        await db.auditar(t, ctx, { entidade: 'coupon', entidadeId: cupom.id, acao: 'coupon.ink_create', depois: { promotionId: r.promotionId, status: r.confirmacao.status } });
      });
      return r;
    } catch (err) {
      if (err && err.codigo && String(err.codigo).startsWith('INK_')) throw erro(409, err.codigo, err.message);
      throw err;
    }
  }

  async function verificarCupomNaInk(ctx, id) {
    const c = await pool.connect();
    let cupom;
    try { cupom = mapearCupom(await obterCupom(c, ctx, id)); } finally { c.release(); }
    if (!inkPromotions) throw erro(409, 'INK_LEITURA_INDISPONIVEL', 'a INK não está conectada para verificação');
    let r;
    try { r = await inkPromotions.verificarCupom(cupom); } catch (err) {
      await db.tx(pool, (t) => t.query(`UPDATE partner_coupon_links SET sync_status = 'error', sync_error = $3, last_synced_at = now(), updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [ctx.organizationId, cupom.id, String(err.message || 'falha na leitura').slice(0, 500)]));
      throw erro(502, 'INK_LEITURA_FALHOU', 'não foi possível ler as promoções da INK agora');
    }
    if (r.status === 'unavailable') throw erro(409, 'INK_LEITURA_INDISPONIVEL', 'a INK não está conectada para verificação');
    const syncStatus = r.status === 'confirmed' ? 'confirmed' : (r.status === 'divergent' ? 'divergent' : 'not_created');
    return db.tx(pool, async (t) => {
      const { rows } = await t.query(
        `UPDATE partner_coupon_links SET sync_status = $3, ink_promotion_id = COALESCE($4, ink_promotion_id), last_synced_at = now(), sync_error = $5, updated_at = now()
          WHERE organization_id = $1 AND id = $2 RETURNING *`,
        [ctx.organizationId, cupom.id, syncStatus, r.promotionId ?? null, r.divergencias.length ? r.divergencias.join('; ').slice(0, 500) : null]
      );
      await db.auditar(t, ctx, { entidade: 'coupon', entidadeId: cupom.id, acao: 'coupon.ink_verify', depois: { status: r.status, divergencias: r.divergencias } });
      return { coupon: mapearCupom(rows[0]), verificacao: r };
    });
  }

  async function listarCupons(ctx, { partnerId = null } = {}) {
    const params = [ctx.organizationId];
    let where = 'organization_id = $1';
    if (partnerId) { params.push(exigirUuid(partnerId, 'parceiro')); where += ` AND partner_id = $${params.length}`; }
    const { rows } = await pool.query(`SELECT * FROM partner_coupon_links WHERE ${where} ORDER BY created_at DESC LIMIT 500`, params);
    return rows.map(mapearCupom);
  }

  return {
    lerConfig, salvarConfig, lerRegrasDeNivel, salvarRegrasDeNivel, nivelAtualDoParceiro,
    criarParceiro, atualizarParceiro, decidirCandidatura, mudarVinculo, obterParceiroBasico, mapearParceiro,
    criarContrato, novaVersaoDeContrato, listarContratosDoParceiro, simularContrato, avaliarTeto,
    criarCupom, ativarCupom, pausarCupom, retomarCupom, encerrarCupom, previsualizarCriacaoNaInk, criarCupomNaInk, verificarCupomNaInk, listarCupons, mapearCupom,
    constantes: { BASES, ROTULO_BASE },
  };
}

module.exports = { criarRegistry, ROTULO_BASE };
