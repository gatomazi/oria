'use strict';

// Superfície HTTP do módulo de afiliados. Montada em server.js com UM `app.use('/api/admin/afiliados', requireAdmin, router)`:
// `requireAdmin` resolve sessão, Organization/Store da SESSÃO (nunca do request — `TENANT_SELECTOR_NOT_ALLOWED`) e o contexto de RLS
// antes de qualquer handler daqui. Nenhum handler lê organization/store de query, body ou header.
//
// Papéis (a tabela só conhece owner|member): owner faz tudo; member cadastra e acompanha (parceiros, candidaturas, collabs em rascunho,
// cupons planejados, contratos em rascunho) e NÃO enxerga nem altera dinheiro: contas a pagar, pagamentos, lotes, exportação, níveis e benefícios.
// Cada rota confere o papel no backend — esconder botão no front é só UX.
//
// Feature flag: sem AFILIADOS_MODULE_ENABLED=true tudo responde 404 (exceto /status, que diz `enabled: false` para o front esconder o menu).

const express = require('express');
const { AfiliadosError, erro } = require('./db');

const PERMITIDOS = Object.freeze({
  settings: ['timezone', 'alertDays', 'minContributionBps', 'benefitBudgetBps', 'progressionCountsBy', 'downgradeGraceDays'],
  levelRules: ['regras', 'motivo'],
  partner: ['publicName', 'contactName', 'contactEmail', 'contactPhone', 'profiles', 'origin', 'communityRegion', 'internalNotes', 'legacyInkAffiliate'],
  partnerCreate: ['publicName', 'contactName', 'contactEmail', 'contactPhone', 'profiles', 'origin', 'communityRegion', 'internalNotes', 'legacyInkAffiliate', 'approve'],
  application: ['decision', 'reason', 'termsVersion'],
  relationship: ['status', 'reason'],
  contractCreate: ['partnerId', 'modality', 'title', 'terms', 'status', 'effectiveFrom', 'reason', 'retroactive'],
  contractVersion: ['terms', 'status', 'effectiveFrom', 'reason', 'retroactive'],
  contractSimulate: ['commissionBasis', 'commissionBps', 'fixedPerUnitCents', 'levelKey', 'comparar'],
  couponCreate: ['partnerId', 'contractId', 'code', 'discountKind', 'discountBps', 'discountCents', 'validFrom', 'validUntil'],
  couponActivate: ['retroactive', 'reason'],
  reasonOnly: ['reason'],
  vazio: [],
  collab: ['name', 'imageUrl', 'collectionUrl', 'startsAt', 'endsAt', 'newMemberPolicy', 'notes', 'status'],
  collabCreator: ['partnerId', 'contractId', 'shareBps'],
  collabProducts: ['products', 'retroativoDesde', 'reason'],
  collabProductApprove: ['retroativoDesde', 'reason'],
  reconcile: ['desde', 'completo'],
  reviewResolve: ['decision', 'reason', 'collabId', 'couponLinkId'],
  payoutPreview: ['partnerId', 'cutoffAt'],
  payoutCreate: ['partnerId', 'cutoffAt', 'ledgerIds', 'competenceLabel', 'dueAt', 'abaixoDoMinimo'],
  payment: ['partnerId', 'batchId', 'allocations', 'amountCents', 'paidAt', 'method', 'externalReference', 'attachmentRef', 'notes', 'idempotencyKey'],
  dueDate: ['ledgerIds', 'batchId', 'dueAt', 'reason'],
  manualEntry: ['partnerId', 'category', 'amountCents', 'reason', 'dueAt'],
  levelDecision: ['decision', 'reason'],
  levelOverride: ['level', 'reason'],
  benefitGrant: ['productionCostCents', 'shippingCostCents', 'description', 'guestCreator', 'deliverables', 'idempotencyKey'],
});

const MEMBRO_SEM_DINHEIRO = ['forecastCommissionCents', 'releasedCommissionCents', 'payableCents', 'overdueCents', 'nextCycleCents', 'paidInPeriodCents', 'benefitsUsedCents'];

function contexto(req) {
  return { organizationId: req.tenant.organizationId, storeId: req.tenant.storeId, userId: req.auth.userId, papel: req.tenant.papel };
}

const ehOwner = (req) => !!req.tenant && req.tenant.papel === 'owner';

function corpo(req, chave) {
  const b = req.body === undefined || req.body === null ? {} : req.body;
  if (typeof b !== 'object' || Array.isArray(b)) throw erro(400, 'AFILIADOS_ENTRADA_INVALIDA', 'corpo deve ser um objeto JSON');
  const extras = Object.keys(b).filter((k) => !PERMITIDOS[chave].includes(k));
  if (extras.length) throw erro(400, 'AFILIADOS_CAMPO_DESCONHECIDO', `campos não aceitos: ${extras.join(', ')}`);
  return b;
}

const exigirOwner = (req) => {
  if (!ehOwner(req)) throw erro(403, 'AFILIADOS_SEM_PERMISSAO', 'esta ação exige o papel owner');
};

function redigirParaMembro(dados) {
  if (dados && dados.kpis) for (const k of MEMBRO_SEM_DINHEIRO) dados.kpis[k] = null;
  if (dados && Array.isArray(dados.series)) dados.series = [];
  if (dados && Array.isArray(dados.upcoming)) dados.upcoming = [];
  return dados;
}

function createAfiliadosRouter({ service, enabled = () => false, logger = console }) {
  const router = express.Router();
  const s = service;
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  router.get('/status', (req, res) => {
    res.json({ enabled: !!enabled(), couponCreation: s.inkPromotions.capacidades(), papel: req.tenant ? req.tenant.papel : null });
  });

  router.use((req, res, next) => {
    if (!enabled()) return res.status(404).json({ error: 'módulo indisponível', codigo: 'AFILIADOS_DESABILITADO' });
    return next();
  });

  // Config e regras
  router.get('/settings', wrap(async (req, res) => res.json(await s.registry.lerConfig(contexto(req)))));
  router.put('/settings', wrap(async (req, res) => { exigirOwner(req); res.json(await s.registry.salvarConfig(contexto(req), corpo(req, 'settings'))); }));
  router.get('/levels/rules', wrap(async (req, res) => res.json(await s.registry.lerRegrasDeNivel(contexto(req)))));
  router.put('/levels/rules', wrap(async (req, res) => { exigirOwner(req); const b = corpo(req, 'levelRules'); res.json(await s.registry.salvarRegrasDeNivel(contexto(req), b)); }));

  // Parceiros
  router.get('/partners', wrap(async (req, res) => {
    const dados = await s.diretorio.listarParceiros(contexto(req), req.query);
    if (!ehOwner(req)) for (const i of dados.itens) i.balance = null;
    res.json(dados);
  }));
  router.post('/partners', wrap(async (req, res) => {
    const b = corpo(req, 'partnerCreate');
    if (b.approve === true) exigirOwner(req);
    res.status(201).json(await s.registry.criarParceiro(contexto(req), b, { aprovarDireto: b.approve === true }));
  }));
  router.get('/partners/:id', wrap(async (req, res) => {
    const dados = await s.diretorio.perfilDoParceiro(contexto(req), req.params.id);
    if (!ehOwner(req)) { dados.balance = null; dados.payments = []; }
    res.json(dados);
  }));
  router.patch('/partners/:id', wrap(async (req, res) => res.json(await s.registry.atualizarParceiro(contexto(req), req.params.id, corpo(req, 'partner')))));
  router.post('/partners/:id/application', wrap(async (req, res) => {
    exigirOwner(req);
    const b = corpo(req, 'application');
    res.json(await s.registry.decidirCandidatura(contexto(req), req.params.id, { decisao: b.decision, motivo: b.reason, termsVersion: b.termsVersion }));
  }));
  router.post('/partners/:id/relationship', wrap(async (req, res) => {
    exigirOwner(req);
    const b = corpo(req, 'relationship');
    res.json(await s.registry.mudarVinculo(contexto(req), req.params.id, { status: b.status, motivo: b.reason }));
  }));
  router.get('/partners/:id/sales', wrap(async (req, res) => res.json(await s.diretorio.listarVendas(contexto(req), { ...req.query, partnerId: req.params.id }))));
  router.get('/partners/:id/statement', wrap(async (req, res) => { exigirOwner(req); res.json(await s.payables.extratoDoParceiro(contexto(req), req.params.id, req.query)); }));
  // Link público de leitura (capability URL) — NÃO é login do afiliado. Ver lib/afiliados/preview.js.
  router.get('/partners/:id/preview-link', wrap(async (req, res) => { exigirOwner(req); res.json(await s.preview.statusDoLink(contexto(req), req.params.id)); }));
  router.post('/partners/:id/preview-link', wrap(async (req, res) => {
    exigirOwner(req); corpo(req, 'vazio');
    // O token cru só existe nesta resposta — não fica gravado em lugar nenhum, nem no log de auditoria.
    res.status(201).json(await s.preview.gerarLink(contexto(req), req.params.id));
  }));
  router.post('/partners/:id/preview-link/revoke', wrap(async (req, res) => { exigirOwner(req); corpo(req, 'vazio'); res.json(await s.preview.revogarLink(contexto(req), req.params.id)); }));
  router.get('/partners/:id/level', wrap(async (req, res) => res.json(await s.progressao.avaliarParceiro(contexto(req), req.params.id))));
  router.post('/partners/:id/level', wrap(async (req, res) => { exigirOwner(req); res.json(await s.progressao.definirNivelManual(contexto(req), req.params.id, corpo(req, 'levelOverride'))); }));
  router.get('/partners/:id/benefits', wrap(async (req, res) => res.json(await s.progressao.listarBeneficios(contexto(req), req.params.id))));
  router.post('/partners/:id/benefits/grant', wrap(async (req, res) => { exigirOwner(req); res.status(201).json(await s.progressao.concederPeca(contexto(req), req.params.id, corpo(req, 'benefitGrant'))); }));
  router.post('/benefits/:id/reverse', wrap(async (req, res) => { exigirOwner(req); res.json(await s.progressao.reverterBeneficio(contexto(req), req.params.id, { motivo: corpo(req, 'reasonOnly').reason })); }));

  // Contratos
  router.post('/contracts/simulate', wrap(async (req, res) => res.json(await s.registry.simularContrato(contexto(req), corpo(req, 'contractSimulate')))));
  router.post('/contracts', wrap(async (req, res) => {
    const b = corpo(req, 'contractCreate');
    res.status(201).json(await s.registry.criarContrato(contexto(req), b, { podeAtivar: ehOwner(req) }));
  }));
  router.post('/contracts/:id/versions', wrap(async (req, res) => {
    res.status(201).json(await s.registry.novaVersaoDeContrato(contexto(req), req.params.id, corpo(req, 'contractVersion'), { podeAtivar: ehOwner(req) }));
  }));

  // Cupons
  router.get('/coupons', wrap(async (req, res) => res.json({ itens: await s.registry.listarCupons(contexto(req), { partnerId: req.query.partnerId || null }) })));
  router.post('/coupons', wrap(async (req, res) => res.status(201).json(await s.registry.criarCupom(contexto(req), corpo(req, 'couponCreate')))));
  router.post('/coupons/:id/activate', wrap(async (req, res) => {
    exigirOwner(req);
    const b = corpo(req, 'couponActivate');
    // Fail-closed: 200 com `activated=false` (aguardando INK / divergente) NÃO é erro nem ativação; falha da INK vira 4xx/5xx.
    res.json(await s.registry.ativarCupom(contexto(req), req.params.id, { retroativo: b.retroactive === true, motivo: b.reason }));
  }));
  router.post('/coupons/:id/pause', wrap(async (req, res) => { exigirOwner(req); res.json(await s.registry.pausarCupom(contexto(req), req.params.id, corpo(req, 'reasonOnly').reason)); }));
  router.post('/coupons/:id/resume', wrap(async (req, res) => { exigirOwner(req); res.json(await s.registry.retomarCupom(contexto(req), req.params.id, corpo(req, 'reasonOnly').reason)); }));
  router.post('/coupons/:id/end', wrap(async (req, res) => { exigirOwner(req); res.json(await s.registry.encerrarCupom(contexto(req), req.params.id, corpo(req, 'reasonOnly').reason)); }));
  router.post('/coupons/:id/verify', wrap(async (req, res) => res.json(await s.registry.verificarCupomNaInk(contexto(req), req.params.id))));
  router.get('/coupons/:id/ink-preview', wrap(async (req, res) => res.json(await s.registry.previsualizarCriacaoNaInk(contexto(req), req.params.id))));
  router.post('/coupons/:id/ink-sync', wrap(async (req, res) => { exigirOwner(req); res.json(await s.registry.sincronizarCupomNaInk(contexto(req), req.params.id)); }));
  router.post('/coupons/:id/ink-delete', wrap(async (req, res) => { exigirOwner(req); res.json(await s.registry.excluirPromocaoNaInk(contexto(req), req.params.id, { motivo: corpo(req, 'reasonOnly').reason })); }));
  router.post('/coupons/:id/ink-create', wrap(async (req, res) => { exigirOwner(req); res.status(201).json(await s.registry.criarCupomNaInk(contexto(req), req.params.id)); }));

  // Collabs
  router.get('/collabs', wrap(async (req, res) => res.json({ itens: await s.collabs.listarCollabs(contexto(req)) })));
  router.post('/collabs', wrap(async (req, res) => res.status(201).json(await s.collabs.criarCollab(contexto(req), corpo(req, 'collab')))));
  router.get('/collabs/:id', wrap(async (req, res) => res.json(await s.collabs.detalharCollab(contexto(req), req.params.id))));
  router.patch('/collabs/:id', wrap(async (req, res) => {
    const b = corpo(req, 'collab');
    if (b.status !== undefined || b.newMemberPolicy !== undefined) exigirOwner(req);
    res.json(await s.collabs.atualizarCollab(contexto(req), req.params.id, b));
  }));
  router.post('/collabs/:id/creators', wrap(async (req, res) => { exigirOwner(req); res.status(201).json(await s.collabs.adicionarCriador(contexto(req), req.params.id, corpo(req, 'collabCreator'))); }));
  router.post('/collabs/:id/creators/:creatorId/end', wrap(async (req, res) => { exigirOwner(req); res.json(await s.collabs.encerrarCriador(contexto(req), req.params.id, req.params.creatorId, { motivo: corpo(req, 'reasonOnly').reason })); }));
  router.post('/collabs/:id/products', wrap(async (req, res) => { exigirOwner(req); res.status(201).json(await s.collabs.adicionarProdutos(contexto(req), req.params.id, corpo(req, 'collabProducts'), { podeRetroagir: true })); }));
  router.post('/collabs/:id/products/discover', wrap(async (req, res) => { exigirOwner(req); res.json(await s.collabs.descobrirPorCluster(contexto(req), req.params.id)); }));
  router.post('/collabs/:id/products/:mid/approve', wrap(async (req, res) => { exigirOwner(req); res.json(await s.collabs.aprovarProduto(contexto(req), req.params.id, req.params.mid, corpo(req, 'collabProductApprove'), { podeRetroagir: true })); }));
  router.post('/collabs/:id/products/:mid/reject', wrap(async (req, res) => { exigirOwner(req); res.json(await s.collabs.rejeitarProduto(contexto(req), req.params.id, req.params.mid, { motivo: corpo(req, 'reasonOnly').reason })); }));
  router.post('/collabs/:id/products/:mid/remove', wrap(async (req, res) => { exigirOwner(req); res.json(await s.collabs.removerProduto(contexto(req), req.params.id, req.params.mid, { motivo: corpo(req, 'reasonOnly').reason })); }));
  router.get('/catalog/products', wrap(async (req, res) => res.json({ itens: await s.collabs.buscarProdutosDoCatalogo(contexto(req), { q: req.query.q, limite: req.query.limit }) })));

  // Vendas, revisões e reconciliação
  router.get('/sales', wrap(async (req, res) => res.json(await s.diretorio.listarVendas(contexto(req), req.query))));
  router.get('/reviews', wrap(async (req, res) => res.json({ itens: await s.diretorio.listarRevisoes(contexto(req), { status: req.query.status }) })));
  router.post('/reviews/:id/resolve', wrap(async (req, res) => {
    exigirOwner(req);
    const b = corpo(req, 'reviewResolve');
    res.json(await s.reconciliador.resolverRevisao(contexto(req), req.params.id, { decision: b.decision, reason: b.reason, collabId: b.collabId, couponLinkId: b.couponLinkId }));
  }));
  router.post('/reconcile', wrap(async (req, res) => {
    exigirOwner(req);
    const b = corpo(req, 'reconcile');
    const opcoes = { completo: b.completo === true };
    if (b.desde) { const d = new Date(b.desde); if (Number.isNaN(d.getTime())) throw erro(400, 'AFILIADOS_ENTRADA_INVALIDA', 'desde inválido'); opcoes.desde = d; }
    res.json(await s.reconciliarTudo(contexto(req), opcoes));
  }));

  // Visão geral
  router.get('/overview', wrap(async (req, res) => {
    const dados = await s.diretorio.visaoGeral(contexto(req), req.query);
    res.json(ehOwner(req) ? dados : redigirParaMembro(dados));
  }));

  // Níveis
  router.get('/levels/proposals', wrap(async (req, res) => res.json({ itens: await s.progressao.listarPropostas(contexto(req), { status: req.query.status }) })));
  router.post('/levels/evaluate', wrap(async (req, res) => { exigirOwner(req); res.json(await s.progressao.gerarPropostas(contexto(req))); }));
  router.post('/levels/proposals/:id/decide', wrap(async (req, res) => {
    exigirOwner(req);
    const b = corpo(req, 'levelDecision');
    res.json(await s.progressao.decidirProposta(contexto(req), req.params.id, { decisao: b.decision, motivo: b.reason }));
  }));

  // Contas a pagar (owner)
  router.get('/payables', wrap(async (req, res) => { exigirOwner(req); res.json(await s.payables.listarAPagar(contexto(req), req.query)); }));
  router.get('/payables/summary', wrap(async (req, res) => { exigirOwner(req); res.json(await s.payables.resumoDeAPagar(contexto(req), req.query)); }));
  router.get('/payables/export.csv', wrap(async (req, res) => {
    exigirOwner(req);
    const r = await s.payables.exportarCsv(contexto(req), req.query);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="parcerias-a-pagar.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(r.csv);
  }));
  router.post('/payouts/preview', wrap(async (req, res) => { exigirOwner(req); res.json(await s.payables.previaDeFechamento(contexto(req), corpo(req, 'payoutPreview'))); }));
  router.post('/payouts', wrap(async (req, res) => { exigirOwner(req); res.status(201).json(await s.payables.criarLote(contexto(req), corpo(req, 'payoutCreate'))); }));
  router.get('/payouts', wrap(async (req, res) => { exigirOwner(req); res.json({ itens: await s.payables.listarLotes(contexto(req), { partnerId: req.query.partnerId || null }) }); }));
  router.post('/payouts/:id/approve', wrap(async (req, res) => { exigirOwner(req); res.json(await s.payables.aprovarLote(contexto(req), req.params.id)); }));
  router.post('/payouts/:id/void', wrap(async (req, res) => { exigirOwner(req); res.json(await s.payables.anularLote(contexto(req), req.params.id, { motivo: corpo(req, 'reasonOnly').reason })); }));
  router.post('/payments', wrap(async (req, res) => {
    exigirOwner(req);
    const r = await s.payables.registrarPagamento(contexto(req), corpo(req, 'payment'));
    res.status(r.deduplicated ? 200 : 201).json(r);
  }));
  router.get('/payments', wrap(async (req, res) => { exigirOwner(req); res.json({ itens: await s.payables.listarPagamentos(contexto(req), { partnerId: req.query.partnerId || null, limite: req.query.limit }) }); }));
  router.post('/payments/:id/reverse', wrap(async (req, res) => { exigirOwner(req); res.status(201).json(await s.payables.estornarPagamento(contexto(req), req.params.id, { motivo: corpo(req, 'reasonOnly').reason })); }));
  router.post('/ledger/due-date', wrap(async (req, res) => {
    exigirOwner(req);
    const b = corpo(req, 'dueDate');
    res.json(await s.payables.alterarVencimento(contexto(req), { ledgerIds: b.ledgerIds, batchId: b.batchId, dueAt: b.dueAt, motivo: b.reason }));
  }));
  router.post('/ledger/manual', wrap(async (req, res) => { exigirOwner(req); res.status(201).json(await s.payables.lancarManual(contexto(req), corpo(req, 'manualEntry'))); }));

  // Erros: domínio → status/código; o resto → 500 genérico (sem vazar SQL, valores ou detalhes de outra Organization).
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err instanceof AfiliadosError) {
      return res.status(err.status).json({ error: err.message, codigo: err.codigo, ...(err.detalhes ? { detalhes: err.detalhes } : {}) });
    }
    if (err && err.code === '22P02') return res.status(400).json({ error: 'valor inválido', codigo: 'AFILIADOS_ENTRADA_INVALIDA' });
    logger.error(`[AFILIADOS] erro inesperado em ${req.method} ${req.baseUrl}${req.path}: ${err && err.code ? err.code : ''} ${err && err.message ? String(err.message).slice(0, 200) : ''}`);
    return res.status(500).json({ error: 'erro interno', codigo: 'AFILIADOS_ERRO_INTERNO' });
  });

  return router;
}

module.exports = { createAfiliadosRouter, PERMITIDOS };
