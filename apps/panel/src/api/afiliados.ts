import { api } from './client';

// Parcerias, Afiliados e Collabs — cliente de /api/admin/afiliados/*. Valores monetários são SEMPRE centavos inteiros (nunca float);
// percentuais em basis points (1 bps = 0,01%). O servidor é a autoridade de papel (owner × member); as telas só escondem o que ele nega.

const BASE = '/api/admin/afiliados';

export type Papel = 'owner' | 'member';
export type Modalidade = 'coupon' | 'collab' | 'hybrid';
export type TipoDeData = 'order' | 'release' | 'due' | 'paid';
export type TipoDeDataPagar = 'sale' | 'competence' | 'release' | 'estimated' | 'due' | 'paid';

// `couponCreation`: o que o connector de cupons da loja sabe fazer (INK hoje). Sem `create`, o fluxo é manual: cria-se o cupom na loja e o Oria só vincula.
export interface CapacidadesCupom { provider: string; read: boolean; create: boolean; update: boolean; delete: boolean }
export interface StatusModulo { enabled: boolean; couponCreation: CapacidadesCupom; papel: Papel | null }

export interface ConfigAfiliados {
  timezone: string; alertDays: number[]; minContributionBps: number; benefitBudgetBps: number; progressionCountsBy: 'orders' | 'units'; downgradeGraceDays: number; persistida: boolean;
}

export interface Perfil { network: string; handle: string | null; url: string | null }

export interface Parceiro {
  id: string; publicName: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null; profiles: Perfil[]; origin: string | null; communityRegion: string | null;
  internalNotes: string | null; applicationStatus: 'candidate' | 'approved' | 'rejected'; relationshipStatus: 'draft' | 'active' | 'paused' | 'ended';
  termsVersion: string | null; termsAcceptedAt: string | null; legacyInkAffiliate: boolean; createdAt: string; updatedAt: string;
}

export interface SaldoResumo { releasedCents: number; forecastCents: number; overdueCents: number }
export interface ParceiroDaLista {
  id: string; publicName: string; contactEmail: string | null; applicationStatus: Parceiro['applicationStatus']; relationshipStatus: Parceiro['relationshipStatus']; modalities: Modalidade[];
  level: string | null; lastSaleAt: string | null; coupons: string[]; legacyInkAffiliate: boolean; balance: SaldoResumo | null; health: string[];
}

export interface VersaoContrato {
  id: string; contractId: string; version: number; status: 'draft' | 'active' | 'paused' | 'ended'; effectiveFrom: string; commissionBasis: 'net_item_revenue_percent' | 'verified_margin_percent' | 'fixed_per_unit';
  commissionBasisLabel: string; commissionBps: number | null; fixedPerUnitCents: number | null; fixedCampaignFeeCents: number | null; conflictPolicy: 'collab_precedence' | 'coupon_precedence' | 'split_explicit';
  splitCouponBps: number | null; splitCollabBps: number | null; releasePolicy: 'delivery_plus_hold' | 'payment_plus_days'; releaseHoldDays: number; payoutDay: number; payoutMonthOffset: number;
  minPayoutCents: number; accumulateBelowMin: boolean; weekendShift: boolean; newCollabMemberPolicy: 'require_approval' | 'auto_include'; levelKey: string | null; levelCapOverrideReason: string | null;
  notes: string | null; reason: string; createdAt: string;
}
export interface Contrato { id: string; modality: Modalidade; title: string; createdAt: string; versions: VersaoContrato[]; current: VersaoContrato }

export interface Cupom {
  id: string; partnerId: string; contractId: string; codeDisplay: string; codeNormalized: string; discountKind: 'percentage' | 'value' | null; discountBps: number | null; discountCents: number | null;
  validFrom: string; validUntil: string | null; status: 'planned' | 'pending_validation' | 'active' | 'paused' | 'ended'; syncMode: 'manual' | 'ink_managed';
  syncStatus: 'manual_unverified' | 'not_created' | 'pending' | 'confirmed' | 'divergent' | 'error'; inkPromotionId: number | null; lastSyncedAt: string | null; syncError: string | null;
  // Estado operacional derivado pelo servidor: "ativo" só é `active_verified` quando a INK confirmou a promoção.
  operationalState: 'awaiting_ink' | 'active_verified' | 'active_unverified' | 'paused' | 'ended';
}

export interface ResultadoAtivacao { coupon: Cupom; activated: boolean; outcome: 'already_active' | 'activated' | 'awaiting_ink' | 'divergent'; message: string; divergencias: string[] }

export interface MetricasNivel { contarPor: string; vendasQualificadas: number; pedidosDistintos: number; unidades: number; margemCents: number; margemVerificada: boolean; mesesComVenda: number; vendasUltimos60d: number; vendasUltimos30d: number }
export interface MetaDeNivel { meta: string; exigido: number; atual: number | null; ok: boolean; naoVerificada?: boolean }
export interface AvaliacaoNivel {
  partnerId: string; currentLevel: { key: string; label: string; since: string | null; source: string; marginCapBps: number | null }; metrics: MetricasNivel;
  evaluation: { nivelAlcancado: string; nivelAtual: string; direcao: 'upgrade' | 'downgrade' | 'manter'; proximo: { key: string; label: string; alcancado: boolean; metas: MetaDeNivel[] } | null };
  pendingProposal: { id: string; from: string; to: string; direction: string } | null; observacao: string;
}

export interface TotaisDoParceiro {
  grossCents: number; adjustmentsCents: number; paidCents: number; releasedBalanceCents: number; forecastCents: number; adjustmentToOffsetCents: number; overdueCents: number; contentFeesCents: number;
  suspendedByRefund: { count: number; cents: number }; netBalanceCents: number; explicacao: string;
}

export interface LancamentoDoExtrato {
  id: string; entryType: 'accrual' | 'adjustment' | 'manual_adjustment'; category: 'commission' | 'content_fee'; amountCents: number; paidCents: number; openCents: number; status: string; holdReason: string | null;
  saleAt: string; releaseAt: string | null; estimatedPaymentAt: string | null; dueAt: string | null; competence: string; note: string | null; inkOrderId: string | null; inkItemId: string | null;
  basis: 'collab' | 'coupon' | null; collabName: string | null; couponCode: string | null; eligibleQty: number | null; orderState: string | null; createdAt: string;
}

export interface Pagamento {
  id: string; partnerId: string; batchId: string | null; kind: 'payment' | 'reversal'; reversesPaymentId: string | null; amountCents: number; paidAt: string; recordedAt: string; method: 'pix' | 'transfer' | 'other';
  externalReference: string | null; attachmentRef: string | null; notes: string | null; reversalReason: string | null; partnerName?: string; allocationCount?: number; reversed?: boolean; deduplicated?: boolean;
  recibo?: { tipo: string; parceiro: string | null; valorCents: number; pagoEm: string; registradoEm: string; metodo: string; referencia: string | null; lancamentos: number; saldoRestanteLiberadoCents: number };
}

export interface BeneficiosDoParceiro {
  partner: { id: string; name: string }; balanceCents: number; creditsCents: number; consumedCents: number; level: string; pieceEligibility: { elegivel: boolean; motivo: string | null };
  entries: { id: string; entryType: string; amountCents: number; productionCostCents: number | null; shippingCostCents: number | null; description: string | null; guestCreator: boolean; deliverables: string | null; createdAt: string }[]; nota: string;
}

export interface PerfilDoParceiro {
  partner: Parceiro; health: string[]; contracts: Contrato[]; coupons: Cupom[]; collabs: { id: string; name: string; status: string; shareBps: number; validFrom: string; validTo: string | null }[];
  level: AvaliacaoNivel; levelHistory: { level: string; effectiveAt: string; source: string; reason: string | null }[]; benefits: BeneficiosDoParceiro; balance: TotaisDoParceiro | null; payments: Pagamento[];
  activity: { id: string; entity: string; action: string; reason: string | null; at: string; actor: string | null }[]; generatedAt: string;
}

export interface VendaAtribuida {
  id: string; inkOrderId: string; inkItemId: string; partnerId: string; partnerName: string; basis: 'collab' | 'coupon'; status: 'calculated' | 'manual_review' | 'blocked' | 'void'; reviewReason: string | null;
  manualOverride: boolean; saleAt: string; productName: string | null; quantity: number | null; eligibleQty: number | null; orderState: string | null; collabName: string | null; couponCode: string | null;
  shareBps: number; netRevenueCents: number | null; allocatedDiscountCents: number | null; baseEligibleCents: number | null; costQuality: string | null; marginAlert: boolean; commissionCents: number;
  rule: { basis: string; commissionBps: number | null; fixedPerUnitCents: number | null } | null; couponAlsoMatched: { couponLinkId: string; partnerId: string; paidOnThisLine: boolean } | null;
}

export interface ItemEmRevisao { id: string; inkOrderId: string; inkItemId: string | null; reason: string; details: Record<string, unknown>; status: string; productName: string | null; sku: string | null; createdAt: string; resolutionNote: string | null }

export interface Alerta { kind: string; severity: 'critical' | 'warning' | 'info'; message: string; href?: string; count?: number; cents?: number }

export interface VisaoGeral {
  period: { from: string; to: string; preset: string; timezone: string; dateType: TipoDeData; criterio: string };
  kpis: {
    activePartners: number; pendingCandidates: number; attributedNetRevenueCents: number; validOrders: number; collabUnits: number; forecastCommissionCents: number | null; releasedCommissionCents: number | null;
    payableCents: number | null; overdueCents: number | null; nextCycleCents: number | null; paidInPeriodCents: number | null; benefitsUsedCents: number | null; integrationDivergences: number;
  };
  definicoes: Record<string, string>; series: { date: string; cents: number; coupon: number; collab: number }[];
  upcoming: { partnerId: string; partnerName: string; competence: string; openCents: number; forecastCents: number; dueAt: string | null; estimatedAt: string | null; status: string; daysOverdue: number }[]; alerts: Alerta[];
}

export type StatusFinanceiro = 'previsto' | 'liberado' | 'vencido' | 'parcial' | 'quitado';
export interface LinhaAPagar {
  partnerId: string; partnerName: string; competence: string; category: 'commission' | 'content_fee'; modalities: Modalidade[]; orderCount: number; units: number; baseCents: number; grossCents: number;
  adjustmentsCents: number; releasedCents: number; paidCents: number; paidInPeriodCents: number | null; openCents: number; overdueCents: number; forecastCents: number; status: StatusFinanceiro; estimatedAt: string | null; dueAt: string | null;
  lastPaidAt: string | null; daysOverdue: number; ledgerCount: number;
}
export interface RespostaAPagar {
  filtros: { dateType: TipoDeDataPagar; from: string | null; to: string | null; timezone: string }; total: number;
  totais: { grossCents: number; adjustmentsCents: number; releasedCents: number; paidCents: number; openCents: number; forecastCents: number }; itens: LinhaAPagar[];
}
export interface ResumoAPagar {
  periodoDoPago: { from: string; to: string; timezone: string; criterio: string }; overdueCents: number; dueIn7Cents: number; dueIn30Cents: number; forecastCents: number; availableCents: number;
  pendingAdjustmentsCents: number; paidInPeriodCents: number; contentFeesOpenCents: number; notas: string[];
}
export interface PreviaFechamento {
  partner: { id: string; name: string }; cutoffAt: string; liquidoCents: number; minimoCents: number; acumulaAbaixoDoMinimo: boolean; situacao: 'ok' | 'nada_a_pagar' | 'abaixo_do_minimo';
  entradas: { ledgerId: string; openCents: number; releaseAt: string | null; dueAt: string | null; attributionId: string | null }[]; divergencias: string[];
}
export interface Lote {
  id: string; partnerId: string; partnerName?: string; competenceLabel: string; cutoffAt: string; proposedCents: number; estimatedPaymentAt: string | null; dueAt: string | null; status: 'draft' | 'approved' | 'voided';
  approvedAt: string | null; voidReason: string | null; createdAt: string; paidCents?: number; financialStatus?: 'draft' | 'scheduled' | 'partially_paid' | 'paid' | 'overdue' | 'voided';
}

export interface CollabDaLista {
  id: string; name: string; imageUrl: string | null; collectionUrl: string | null; startsAt: string; endsAt: string | null; status: 'draft' | 'active' | 'ended'; newMemberPolicy: 'require_approval' | 'auto_include';
  notes: string | null; activeProducts: number; pendingProducts: number; creators: { partnerId: string; name: string; shareBps: number }[]; units: number;
}
export interface ProdutoDaCollab {
  id: string; collabId: string; inkProductId: string; inkVariantId: string | null; inkClusterId: string | null; productName: string | null; catalogName?: string | null; imageUrl?: string | null;
  status: 'pending_approval' | 'active' | 'removed'; source: 'manual' | 'cluster_discovery'; validFrom: string | null; validTo: string | null; impactoUltimos90d?: { unidades: number; receitaLiquidaCents: number; observacao: string };
}
export interface DetalheDaCollab {
  collab: CollabDaLista; products: ProdutoDaCollab[]; creators: { id: string; partnerId: string; partnerName: string; contractId: string; shareBps: number; validFrom: string; validTo: string | null }[];
  summary: { orders: number; units: number; netRevenueCents: number; commissionCents: number }; unitsByProduct: { inkProductId: string | null; units: number }[];
}
export interface ProdutoDoCatalogo { inkProductId: string; name: string; imageUrl: string | null; clusterId: string | null; collabId: string | null }

export interface RegrasDeNivel { version: number; regras: { niveis: NivelDeRegra[] }; padrao: boolean; effectiveFrom: string | null }
export interface NivelDeRegra {
  key: string; label: string; ordem: number; janelaDias: number | null; vendasQualificadas: number; margemCents: number; mesesComVenda: number; vendasUltimos60d: number; tetoMargemBps: number;
  beneficio: { tipo: string; aPartirDeVendas?: number; aCadaDias?: number; exigeVendasUltimos30d?: number }; revisaoAposDias?: number;
}
export interface PropostaDeNivel {
  id: string; partnerId: string; partnerName: string; fromLevel: string; toLevel: string; direction: 'upgrade' | 'downgrade'; observed: MetricasNivel; status: string; createdAt: string;
  economicEffect: { newMarginCapBps: number | null; contractRewrite: boolean; note: string };
}

export interface SimulacaoContrato {
  amostra: { pedidos: number; unidades: number; receitaCents: number; custoCents: number; margemCents: number; janelaDias: number; escopo: string }; aviso: string;
  alternativas: { commissionBasis: string; rotulo: string; commissionBps: number | null; fixedPerUnitCents: number | null; comissaoNaAmostraCents: number; equivalenteMargemBps: number | null; tetoMargemBps: number; dentroDoTeto: boolean | null; verificacao: string }[];
}

export interface TermosDeContrato {
  commissionBasis: VersaoContrato['commissionBasis']; commissionBps?: number; fixedPerUnitCents?: number; fixedCampaignFeeCents?: number; conflictPolicy?: VersaoContrato['conflictPolicy']; splitCollabBps?: number;
  dualCommissionConfirmed?: boolean; releasePolicy?: VersaoContrato['releasePolicy']; releaseHoldDays?: number; payoutDay?: number; payoutMonthOffset?: number; minPayoutCents?: number;
  accumulateBelowMin?: boolean; weekendShift?: boolean; newCollabMemberPolicy?: VersaoContrato['newCollabMemberPolicy']; levelCapOverrideReason?: string; notes?: string;
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

const post = <T>(path: string, body?: unknown) => api<T>(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = <T>(path: string, body: unknown) => api<T>(`${BASE}${path}`, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => api<T>(`${BASE}${path}`, { method: 'PATCH', body: JSON.stringify(body) });

export const afiliados = {
  status: () => api<StatusModulo>(`${BASE}/status`),
  config: () => api<ConfigAfiliados>(`${BASE}/settings`),
  salvarConfig: (b: Partial<ConfigAfiliados>) => put<ConfigAfiliados>('/settings', b),
  visaoGeral: (p: Record<string, string | undefined>) => api<VisaoGeral>(`${BASE}/overview${qs(p)}`),

  parceiros: (p: Record<string, string | number | undefined>) => api<{ total: number; itens: ParceiroDaLista[] }>(`${BASE}/partners${qs(p)}`),
  criarParceiro: (b: Partial<Parceiro> & { approve?: boolean }) => post<Parceiro>('/partners', b),
  perfil: (id: string) => api<PerfilDoParceiro>(`${BASE}/partners/${id}`),
  atualizarParceiro: (id: string, b: Partial<Parceiro>) => patch<Parceiro>(`/partners/${id}`, b),
  decidirCandidatura: (id: string, b: { decision: 'approved' | 'rejected'; reason?: string; termsVersion?: string }) => post<Parceiro>(`/partners/${id}/application`, b),
  mudarVinculo: (id: string, b: { status: Parceiro['relationshipStatus']; reason: string }) => post<Parceiro>(`/partners/${id}/relationship`, b),
  vendasDoParceiro: (id: string, p: Record<string, string | number | undefined>) => api<{ total: number; itens: VendaAtribuida[] }>(`${BASE}/partners/${id}/sales${qs(p)}`),
  extrato: (id: string, p: Record<string, string | number | undefined> = {}) => api<{ totais: TotaisDoParceiro; itens: LancamentoDoExtrato[] }>(`${BASE}/partners/${id}/statement${qs(p)}`),

  simularContrato: (b: unknown) => post<SimulacaoContrato>('/contracts/simulate', b),
  criarContrato: (b: { partnerId: string; modality: Modalidade; title: string; status?: 'draft' | 'active'; reason: string; effectiveFrom?: string; terms: TermosDeContrato }) => post<{ contract: { id: string }; version: VersaoContrato }>('/contracts', b),
  novaVersao: (id: string, b: { status?: VersaoContrato['status']; reason: string; terms?: Partial<TermosDeContrato>; effectiveFrom?: string }) => post<{ version: VersaoContrato }>(`/contracts/${id}/versions`, b),

  cupons: (partnerId?: string) => api<{ itens: Cupom[] }>(`${BASE}/coupons${qs({ partnerId })}`),
  criarCupom: (b: { partnerId: string; contractId: string; code: string; discountKind?: 'percentage' | 'value'; discountBps?: number; discountCents?: number; validFrom?: string; validUntil?: string }) => post<Cupom>('/coupons', b),
  sincronizarCupomNaInk: (id: string) => post<{ atualizado: boolean; campos: string[]; naoSincronizaveis: string[]; coupon: Cupom }>(`/coupons/${id}/ink-sync`, {}),
  ativarCupom: (id: string) => post<ResultadoAtivacao>(`/coupons/${id}/activate`, {}),
  pausarCupom: (id: string, reason: string) => post<Cupom>(`/coupons/${id}/pause`, { reason }),
  retomarCupom: (id: string, reason: string) => post<Cupom>(`/coupons/${id}/resume`, { reason }),
  encerrarCupom: (id: string, reason: string) => post<Cupom>(`/coupons/${id}/end`, { reason }),
  verificarCupom: (id: string) => post<{ coupon: Cupom; verificacao: { status: string; divergencias: string[] } }>(`/coupons/${id}/verify`, {}),
  previaCupomNaInk: (id: string) => api<{ ok: boolean; problemas: string[]; criacaoDisponivel: boolean; enviaria: boolean; request: { method: string; path: string; headers: Record<string, string>; body: unknown; escopoExigido: string } | null }>(`${BASE}/coupons/${id}/ink-preview`),

  collabs: () => api<{ itens: CollabDaLista[] }>(`${BASE}/collabs`),
  criarCollab: (b: { name: string; imageUrl?: string; collectionUrl?: string; startsAt?: string; endsAt?: string; newMemberPolicy?: string; notes?: string }) => post<CollabDaLista>('/collabs', b),
  collab: (id: string) => api<DetalheDaCollab>(`${BASE}/collabs/${id}`),
  atualizarCollab: (id: string, b: Record<string, unknown>) => patch<CollabDaLista>(`/collabs/${id}`, b),
  adicionarCriador: (id: string, b: { partnerId: string; contractId: string; shareBps: number }) => post<unknown>(`/collabs/${id}/creators`, b),
  encerrarCriador: (id: string, creatorId: string, reason: string) => post<unknown>(`/collabs/${id}/creators/${creatorId}/end`, { reason }),
  adicionarProdutos: (id: string, b: { products: { inkProductId: string; productName?: string }[]; retroativoDesde?: string; reason?: string }) => post<{ adicionados: ProdutoDaCollab[] }>(`/collabs/${id}/products`, b),
  descobrirProdutos: (id: string) => post<{ clusters: string[]; encontrados: ProdutoDaCollab[] }>(`/collabs/${id}/products/discover`, {}),
  aprovarProduto: (id: string, mid: string, b: { retroativoDesde?: string; reason?: string } = {}) => post<unknown>(`/collabs/${id}/products/${mid}/approve`, b),
  rejeitarProduto: (id: string, mid: string, reason: string) => post<unknown>(`/collabs/${id}/products/${mid}/reject`, { reason }),
  removerProduto: (id: string, mid: string, reason: string) => post<unknown>(`/collabs/${id}/products/${mid}/remove`, { reason }),
  produtosDoCatalogo: (q: string) => api<{ itens: ProdutoDoCatalogo[] }>(`${BASE}/catalog/products${qs({ q })}`),

  vendas: (p: Record<string, string | number | undefined>) => api<{ total: number; itens: VendaAtribuida[] }>(`${BASE}/sales${qs(p)}`),
  revisoes: (status = 'open') => api<{ itens: ItemEmRevisao[] }>(`${BASE}/reviews${qs({ status })}`),
  resolverRevisao: (id: string, b: { decision: 'assign_collab' | 'assign_coupon' | 'dismiss'; reason: string; collabId?: string; couponLinkId?: string }) => post<{ status: string }>(`/reviews/${id}/resolve`, b),
  reconciliar: (b: { desde?: string; completo?: boolean } = {}) => post<{ pedidosAvaliados: number; atribuicoes: number; criadas: number; revisoes: number; promovidos: number; propostasCriadas: number; truncado: boolean }>('/reconcile', b),

  aPagar: (p: Record<string, string | number | undefined>) => api<RespostaAPagar>(`${BASE}/payables${qs(p)}`),
  resumoAPagar: (p: Record<string, string | undefined> = {}) => api<ResumoAPagar>(`${BASE}/payables/summary${qs(p)}`),
  urlDoCsv: (p: Record<string, string | number | undefined>) => `${BASE}/payables/export.csv${qs(p)}`,
  previaFechamento: (b: { partnerId: string; cutoffAt?: string }) => post<PreviaFechamento>('/payouts/preview', b),
  criarLote: (b: { partnerId: string; cutoffAt?: string; ledgerIds?: string[]; competenceLabel?: string; dueAt?: string; abaixoDoMinimo?: boolean }) => post<Lote>('/payouts', b),
  lotes: (partnerId?: string) => api<{ itens: Lote[] }>(`${BASE}/payouts${qs({ partnerId })}`),
  aprovarLote: (id: string) => post<Lote>(`/payouts/${id}/approve`, {}),
  anularLote: (id: string, reason: string) => post<Lote>(`/payouts/${id}/void`, { reason }),
  registrarPagamento: (b: { partnerId: string; batchId?: string; allocations: { ledgerId: string; amountCents: number }[]; amountCents?: number; paidAt: string; method: 'pix' | 'transfer' | 'other'; externalReference?: string; attachmentRef?: string; notes?: string; idempotencyKey: string }) => post<Pagamento>('/payments', b),
  pagamentos: (partnerId?: string) => api<{ itens: Pagamento[] }>(`${BASE}/payments${qs({ partnerId })}`),
  estornarPagamento: (id: string, reason: string) => post<Pagamento>(`/payments/${id}/reverse`, { reason }),
  alterarVencimento: (b: { ledgerIds?: string[]; batchId?: string; dueAt: string; reason: string }) => post<{ alterados: number; dueAt: string }>('/ledger/due-date', b),
  lancarManual: (b: { partnerId: string; category: 'commission' | 'content_fee'; amountCents: number; reason: string; dueAt?: string }) => post<{ id: string }>('/ledger/manual', b),

  regrasDeNivel: () => api<RegrasDeNivel>(`${BASE}/levels/rules`),
  salvarRegrasDeNivel: (regras: RegrasDeNivel['regras'], motivo: string) => put<RegrasDeNivel>('/levels/rules', { regras, motivo }),
  propostasDeNivel: (status = 'pending') => api<{ itens: PropostaDeNivel[] }>(`${BASE}/levels/proposals${qs({ status })}`),
  avaliarNiveis: () => post<{ propostasCriadas: number }>('/levels/evaluate', {}),
  decidirProposta: (id: string, b: { decision: 'approve' | 'dismiss'; reason?: string }) => post<{ status: string; level: string }>(`/levels/proposals/${id}/decide`, b),
  definirNivel: (partnerId: string, b: { level: string; reason: string }) => post<{ level: string }>(`/partners/${partnerId}/level`, b),
  concederPeca: (partnerId: string, b: { productionCostCents: number; shippingCostCents?: number; description: string; guestCreator?: boolean; deliverables?: string; idempotencyKey?: string }) => post<{ id: string; amountCents: number }>(`/partners/${partnerId}/benefits/grant`, b),
  reverterBeneficio: (id: string, reason: string) => post<{ id: string }>(`/benefits/${id}/reverse`, { reason }),
};
