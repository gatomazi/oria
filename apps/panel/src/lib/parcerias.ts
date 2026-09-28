// Formatação, rótulos e filtros do módulo Parcerias e Afiliados. Dinheiro é SEMPRE centavos inteiros; o texto digitado pelo lojista vira
// centavos por parsing de string (nunca por float). Rótulos explicam o termo financeiro em português — sem jargão de tabela.
import type { StatusFinanceiro, Modalidade, TipoDeData, TipoDeDataPagar } from '../api/afiliados';
import type { Tone } from '../components/ds';

export const TZ_PADRAO = 'America/Sao_Paulo';

export function brl(centavos: number | null | undefined): string {
  if (centavos === null || centavos === undefined || !Number.isFinite(centavos)) return '—';
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// "1.234,56", "1234.56", "R$ 12,3" → centavos. Devolve null se não for um valor monetário válido.
export function centavosDeTexto(texto: string): number | null {
  const limpo = texto.replace(/[R$\s]/g, '');
  if (!limpo) return null;
  let normal = limpo;
  if (limpo.includes(',')) normal = limpo.replace(/\./g, '').replace(',', '.');
  else if ((limpo.match(/\./g) || []).length > 1) normal = limpo.replace(/\./g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(normal);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] || '').padEnd(2, '0'));
  return m[1] ? -cents : cents;
}

export function pct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  return `${(bps / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

// bps ← "12,5" (%)
export function bpsDeTexto(texto: string): number | null {
  const n = centavosDeTexto(texto.replace('%', ''));
  return n === null ? null : n; // "12,5" → 1250 bps (mesma escala de 2 casas)
}

export function dataCurta(iso: string | null | undefined, tz: string = TZ_PADRAO): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { timeZone: tz });
}

export function dataHora(iso: string | null | undefined, tz: string = TZ_PADRAO): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('pt-BR', { timeZone: tz })} ${d.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`;
}

// 'YYYY-MM' → "set/2026"
export function competenciaLabel(iso: string): string {
  const [a, m] = iso.split('-');
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return `${meses[Number(m) - 1] ?? m}/${a}`;
}

// 'YYYY-MM-DD' de hoje NO timezone da loja (nunca o do navegador).
export function hojeNoFuso(tz: string = TZ_PADRAO, agora: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + dias));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`;
}

export type PresetDePeriodo = '7d' | '30d' | '90d' | 'this_month' | 'last_month' | 'custom';
export const ROTULOS_DE_PERIODO: Record<PresetDePeriodo, string> = {
  '7d': 'Últimos 7 dias', '30d': 'Últimos 30 dias', '90d': 'Últimos 90 dias', this_month: 'Mês atual', last_month: 'Mês anterior', custom: 'Personalizado',
};

export function intervaloDoPreset(preset: Exclude<PresetDePeriodo, 'custom'>, tz: string = TZ_PADRAO): { from: string; to: string } {
  const hoje = hojeNoFuso(tz);
  const [a, m] = hoje.split('-').map(Number);
  if (preset === '7d') return { from: somarDias(hoje, -6), to: hoje };
  if (preset === '30d') return { from: somarDias(hoje, -29), to: hoje };
  if (preset === '90d') return { from: somarDias(hoje, -89), to: hoje };
  if (preset === 'this_month') return { from: `${a}-${String(m).padStart(2, '0')}-01`, to: hoje };
  const anterior = m === 1 ? [a - 1, 12] : [a, m - 1];
  const ultimo = new Date(Date.UTC(anterior[0], anterior[1], 0)).getUTCDate();
  return { from: `${anterior[0]}-${String(anterior[1]).padStart(2, '0')}-01`, to: `${anterior[0]}-${String(anterior[1]).padStart(2, '0')}-${String(ultimo).padStart(2, '0')}` };
}

export const ROTULOS_MODALIDADE: Record<Modalidade, string> = { coupon: 'Cupom', collab: 'Collab', hybrid: 'Híbrida' };

export const ROTULOS_DATA_GERAL: Record<TipoDeData, string> = { order: 'Data do pedido', release: 'Data de liberação', due: 'Vencimento', paid: 'Pagamento efetivo' };
export const ROTULOS_DATA_PAGAR: Record<TipoDeDataPagar, string> = {
  sale: 'Data do pedido', competence: 'Competência (mês da venda)', release: 'Liberação', estimated: 'Previsão de pagamento', due: 'Vencimento', paid: 'Pagamento efetivo',
};
export const EXPLICACAO_DATAS: Record<TipoDeDataPagar, string> = {
  sale: 'Quando o cliente fez o pedido.',
  competence: 'Mês da venda, para fechamento mensal.',
  release: 'Quando a comissão fica pagável (pagamento confirmado + entrega + carência).',
  estimated: 'Previsão calculada pela política do contrato para o que ainda não foi liberado.',
  due: 'Data em que o repasse deve ser feito.',
  paid: 'Dia em que você efetivamente transferiu o dinheiro (não o dia em que registrou aqui).',
};

export const ROTULOS_STATUS_FINANCEIRO: Record<StatusFinanceiro, string> = { previsto: 'Previsto', liberado: 'Liberado', vencido: 'Vencido', parcial: 'Parcialmente pago', quitado: 'Quitado' };
export const TOM_STATUS_FINANCEIRO: Record<StatusFinanceiro, Tone> = { previsto: 'neutral', liberado: 'info', vencido: 'danger', parcial: 'warning', quitado: 'success' };

export const ROTULOS_SAUDE: Record<string, { label: string; tone: Tone }> = {
  coupon_not_created: { label: 'Cupom não criado na INK', tone: 'warning' },
  awaiting_validation: { label: 'Aguardando validação', tone: 'warning' },
  coupon_divergent: { label: 'Cupom divergente da INK', tone: 'danger' },
  catalog_unmapped: { label: 'Produtos sem correspondência', tone: 'warning' },
  financial_divergence: { label: 'Divergência financeira', tone: 'danger' },
  overdue: { label: 'Pagamento vencido', tone: 'danger' },
  ready_to_level_up: { label: 'Apto a subir de nível', tone: 'premium' },
  no_active_contract: { label: 'Sem contrato ativo', tone: 'neutral' },
};

export const ROTULOS_CANDIDATURA = { candidate: 'Candidato', approved: 'Aprovado', rejected: 'Reprovado' } as const;
export const ROTULOS_VINCULO = { draft: 'Rascunho', active: 'Ativo', paused: 'Pausado', ended: 'Encerrado' } as const;
export const TOM_VINCULO = { draft: 'neutral', active: 'success', paused: 'warning', ended: 'neutral' } as const;
export const ROTULOS_CUPOM = { planned: 'Planejado', pending_validation: 'Aguardando validação', active: 'Ativo', paused: 'Pausado', ended: 'Encerrado' } as const;
export const ROTULOS_SYNC_CUPOM = { manual_unverified: 'Cadastro manual · não verificado na INK', not_created: 'Não criado na INK', pending: 'Pendente', confirmed: 'Confirmado na INK', divergent: 'Divergente da INK', error: 'Erro ao verificar' } as const;
export const ROTULOS_BASE_COMISSAO = {
  net_item_revenue_percent: '% da receita líquida do item', verified_margin_percent: '% da margem de produção verificada', fixed_per_unit: 'Valor fixo por unidade',
} as const;
export const ROTULOS_POLITICA_CONFLITO = { collab_precedence: 'Collab tem precedência (padrão)', coupon_precedence: 'Cupom tem precedência', split_explicit: 'Divisão explícita (comissão dupla)' } as const;

export const ROTULOS_MOTIVO_REVISAO: Record<string, string> = {
  order_data_incomplete: 'Pedido ainda sem cupom/devolução conhecidos (anterior à captura).',
  item_without_product_id: 'Item sem identificador de produto: não dá para saber se é de uma collab.',
  variant_unresolved: 'A collab exige variante específica e o item não informa a variante.',
  multiple_collab_match: 'O produto casa com mais de uma collab.',
  multiple_coupon_match: 'Mais de um cupom possível para o mesmo código.',
  conflict_policy_mismatch: 'Criadores da collab com políticas de conflito diferentes.',
  collab_without_valid_creator: 'Collab sem criador com contrato ativo na data da venda.',
  free_quantity_unconfirmed: 'Item com unidades grátis (semântica de valor não confirmada).',
  unknown_payment_status: 'Status de pagamento desconhecido.',
  cost_unknown: 'Custo de produção desconhecido: comissão sobre margem não liberada.',
  legacy_ink_affiliate_conflict: 'Parceiro com afiliado nativo da INK: bloqueado para não pagar em dobro.',
};

export const ROTULOS_ESTADO_PEDIDO: Record<string, string> = {
  awaiting_payment: 'Aguardando pagamento', paid: 'Pago', delivered: 'Entregue', disputed: 'Em disputa', canceled: 'Cancelado', refunded: 'Reembolsado', chargeback: 'Chargeback', unmatched: 'Sem correspondência',
};

export const ROTULOS_STATUS_LANCAMENTO: Record<string, { label: string; tone: Tone }> = {
  provisional: { label: 'Provisionado', tone: 'neutral' }, held: { label: 'Em carência', tone: 'neutral' }, released: { label: 'Liberado', tone: 'info' },
  manual_review: { label: 'Em revisão', tone: 'warning' }, reversed: { label: 'Anulado', tone: 'neutral' },
};
export const ROTULOS_RETENCAO: Record<string, string> = {
  awaiting_payment: 'aguardando confirmação do pagamento', awaiting_delivery: 'aguardando entrega', release_hold: 'em carência após a entrega', dispute: 'pedido em disputa',
  order_canceled: 'pedido cancelado', order_refunded: 'pedido reembolsado', order_chargeback: 'chargeback', net_zero: 'anulado por estorno',
};

export const ROTULOS_METODO = { pix: 'Pix', transfer: 'Transferência', other: 'Outro' } as const;
export const ROTULOS_ORIGEM = { collab: 'Collab', coupon: 'Cupom' } as const;

export const NIVEIS_ORDEM = ['raiz', 'voz', 'referencia', 'embaixador'];
export const ROTULOS_META: Record<string, string> = {
  vendasQualificadas: 'Vendas qualificadas', margemCents: 'Margem de produção verificada', mesesComVenda: 'Meses com venda', vendasUltimos60d: 'Vendas nos últimos 60 dias',
};

// Nova chave de idempotência por TENTATIVA de pagamento (reenviar a mesma tentativa não paga duas vezes).
export function novaChave(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Exibe o motivo cru de um ApiError ou Error.
export function mensagemDoErro(err: unknown): string {
  return err instanceof Error ? err.message : 'Não foi possível concluir a ação.';
}

// Plural resolvido em português ("1 parceiro", "2 parceiros") — nunca "parceiro(s)".
export function plural(n: number, singular: string, pluralForma?: string): string {
  return `${n.toLocaleString('pt-BR')} ${n === 1 ? singular : pluralForma ?? `${singular}s`}`;
}
