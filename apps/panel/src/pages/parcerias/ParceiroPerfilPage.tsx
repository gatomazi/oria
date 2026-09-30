import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Button, Callout, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, KpiCard, KpiStrip, Modal, PageHeader, PageStack, Pagination, ProgressBar, Select, Skeleton, StatusBadge,
  TabList, Textarea,
} from '../../components/ds';
import {
  afiliados, type Contrato, type Cupom, type ResultadoAtivacao, type LancamentoDoExtrato, type PerfilDoParceiro, type VendaAtribuida, type VersaoContrato,
} from '../../api/afiliados';
import { PreviewLinkCard } from './PreviewLinkCard';
import { useAsync } from '../../lib/useAsync';
import { useFiltrosUrl } from '../../lib/useFiltrosUrl';
import { toast } from '../../lib/toast';
import {
  ROTULOS_BASE_COMISSAO, ROTULOS_CANDIDATURA, ROTULOS_ESTADO_PEDIDO, ROTULOS_META, ROTULOS_METODO, ROTULOS_MODALIDADE, ROTULOS_MOTIVO_REVISAO, ROTULOS_ORIGEM,
  ROTULOS_POLITICA_CONFLITO, ROTULOS_RETENCAO, ROTULOS_STATUS_LANCAMENTO, ROTULOS_SYNC_CUPOM, resumoInkDoFechamento, situacaoDoCupom, ROTULOS_VINCULO, TOM_VINCULO, brl, competenciaLabel, dataCurta, dataHora, mensagemDoErro, pct, plural,
} from '../../lib/parcerias';
import { Definicao, Saude } from './componentes';
import { ContratoDialog, CupomDialog, MotivoDialog, PagamentoDialog } from './modais';
import { useParcerias } from './ParceriasLayout';

type Aba = 'resumo' | 'contratos' | 'collabs' | 'vendas' | 'comissoes' | 'pagamentos' | 'niveis' | 'atividades';

const ROTULOS_ACAO: Record<string, string> = {
  'partner.create': 'Parceiro cadastrado', 'partner.update': 'Dados atualizados', 'partner.legacy_ink_affiliate': 'Marca de afiliado nativo da INK alterada', 'partner.relationship': 'Vínculo alterado',
  'partner.application.approved': 'Candidatura aprovada', 'partner.application.rejected': 'Candidatura reprovada', 'contract.create': 'Contrato criado', 'contract.version': 'Nova versão de contrato',
  'coupon.create': 'Cupom cadastrado', 'coupon.activate': 'Cupom ativado', 'coupon.activate.retroactive': 'Cupom ativado (retroativo)', 'coupon.pause': 'Cupom pausado', 'coupon.resume': 'Cupom retomado',
  'coupon.end': 'Cupom encerrado', 'coupon.ink_verify': 'Cupom verificado na INK', 'payment.record': 'Pagamento registrado', 'payment.reverse': 'Pagamento estornado', 'ledger.due_at.change': 'Vencimento alterado',
  'ledger.manual': 'Lançamento manual', 'level.override': 'Nível alterado manualmente', 'level.proposal.approved': 'Proposta de nível aprovada', 'level.proposal.dismissed': 'Proposta de nível descartada',
  'benefit.grant': 'Peça concedida', 'benefit.guest_creator': 'Peça de criador convidado', 'benefit.reverse': 'Benefício revertido', 'collab.creator.add': 'Criador adicionado à collab', 'collab.creator.end': 'Criador removido da collab',
  'review.assign': 'Item associado manualmente', 'review.dismiss': 'Item de revisão descartado', 'collab.create': 'Collab criada', 'collab.update': 'Collab atualizada',
  'collab.product.add': 'Produto adicionado à collab', 'collab.product.add.retroactive': 'Produto adicionado à collab (retroativo)', 'collab.product.approve': 'Produto da collab aprovado',
  'collab.product.approve.retroactive': 'Produto da collab aprovado (retroativo)', 'collab.product.reject': 'Produto da collab rejeitado', 'collab.product.remove': 'Produto removido da collab',
  'collab.product.discovered': 'Produto novo encontrado no agrupamento', 'collab.product.auto_include': 'Produto incluído automaticamente na collab', 'coupon.ink_create': 'Cupom criado na INK',
  'batch.create': 'Lote de fechamento criado', 'batch.approve': 'Lote aprovado', 'batch.void': 'Lote anulado', 'batch.due_at.change': 'Vencimento do lote alterado', 'settings.update': 'Configuração alterada',
  'level_rules.create': 'Regras de nível alteradas', 'coupon.ink_sync': 'Promoção sincronizada com a INK', 'coupon.ink_delete': 'Promoção excluída na INK',
  'coupon.end.partner_ended': 'Cupom encerrado (vínculo do parceiro encerrado)', 'coupon.end.contract_ended': 'Cupom encerrado (contrato encerrado)',
  'partner.preview_link.create': 'Link público gerado', 'partner.preview_link.revoke': 'Link público revogado',
};

function statusDeContrato(s: VersaoContrato['status']) {
  return { draft: { t: 'neutral', l: 'Rascunho' }, active: { t: 'success', l: 'Ativo' }, paused: { t: 'warning', l: 'Pausado' }, ended: { t: 'neutral', l: 'Encerrado' } }[s] as { t: 'neutral' | 'success' | 'warning'; l: string };
}

function descreverRegra(v: VersaoContrato): string {
  if (v.commissionBasis === 'fixed_per_unit') return `${brl(v.fixedPerUnitCents)} por unidade`;
  return `${pct(v.commissionBps)} ${v.commissionBasis === 'verified_margin_percent' ? 'da margem de produção verificada' : 'da receita líquida do item'}`;
}

function descreverPolitica(v: VersaoContrato): string {
  const lib = v.releasePolicy === 'delivery_plus_hold' ? `libera ${plural(v.releaseHoldDays, 'dia')} após a entrega` : `libera ${plural(v.releaseHoldDays, 'dia')} após o pagamento confirmado`;
  const pag = `paga no dia ${v.payoutDay} ${v.payoutMonthOffset === 0 ? 'do mês da liberação' : v.payoutMonthOffset === 1 ? 'do mês seguinte' : `${v.payoutMonthOffset} meses depois`}${v.weekendShift ? ' (fim de semana → segunda)' : ''}`;
  return `${lib}; ${pag}; mínimo ${brl(v.minPayoutCents)}${v.accumulateBelowMin ? ' (abaixo disso acumula)' : ''}`;
}

// ── Contratos e cupons ──────────────────────────────────────────────────────────────────────────
function AbaContratos({ perfil, isOwner, recarregar }: { perfil: PerfilDoParceiro; isOwner: boolean; recarregar: () => void }) {
  const [contratoDialog, setContratoDialog] = useState<{ aberto: boolean; contrato: Contrato | null }>({ aberto: false, contrato: null });
  const [cupomDialog, setCupomDialog] = useState(false);
  const [acaoCupom, setAcaoCupom] = useState<{ tipo: 'pausar' | 'retomar' | 'encerrar'; cupom: Cupom } | null>(null);
  const [retro, setRetro] = useState<Cupom | null>(null);
  const [excluir, setExcluir] = useState<Cupom | null>(null);
  const [resultadoAtivacao, setResultadoAtivacao] = useState<{ cupom: Cupom; r: ResultadoAtivacao } | null>(null);
  const { tz, cupons: capacidades } = useParcerias();

  async function verificar(c: Cupom) {
    try {
      const r = await afiliados.verificarCupom(c.id);
      toast(r.verificacao.status === 'confirmed' ? 'Cupom confirmado na INK.' : r.verificacao.divergencias.join('; ') || 'Cupom não encontrado na INK.', r.verificacao.status === 'confirmed' ? 'sucesso' : 'erro');
      recarregar();
    } catch (e) { toast(mensagemDoErro(e)); }
  }
  async function sincronizar(c: Cupom) {
    try {
      const r = await afiliados.sincronizarCupomNaInk(c.id);
      toast(r.atualizado ? `Promoção atualizada na INK (${r.campos.join(', ')}).` : (r.naoSincronizaveis.length ? `Nada a sincronizar; ajuste na INK: ${r.naoSincronizaveis.join('; ')}` : 'Já está igual na INK.'), r.atualizado ? 'sucesso' : 'erro');
      recarregar();
    } catch (e) { toast(mensagemDoErro(e)); }
  }
  async function ativar(c: Cupom) {
    // Fail-closed: o servidor só ativa depois de a INK confirmar a promoção. Sem isso, explica o que falta em vez de mostrar "ativo".
    const r = await afiliados.ativarCupom(c.id);
    if (r.activated) toast('Promoção verificada na INK e cupom ativado. Só pedidos a partir de agora comissionam.', 'sucesso');
    else setResultadoAtivacao({ cupom: c, r });
    recarregar();
  }

  return (
    <div className="pa-shell">
      <Card
        title="Contratos" description="Cada mudança de condição é uma versão nova; o histórico é imutável e vendas passadas ficam com a versão da data."
        action={<Button size="sm" onClick={() => setContratoDialog({ aberto: true, contrato: null })}>Novo contrato</Button>}
      >
        {!perfil.contracts.length && <EmptyState title="Nenhum contrato" description="Sem contrato ativo não há comissão. Comece por um rascunho e simule antes de ativar." />}
        {perfil.contracts.map((k) => {
          const st = statusDeContrato(k.current.status);
          return (
            <div key={k.id} className="pa-shell pa-mb-5">
              <div className="ds-toolbar">
                <strong>{k.title}</strong><StatusBadge tone="info" label={ROTULOS_MODALIDADE[k.modality]} /><StatusBadge tone={st.t} label={st.l} />
                <div className="ds-toolbar__end"><Button size="sm" variant="secondary" onClick={() => setContratoDialog({ aberto: true, contrato: k })}>Nova versão</Button></div>
              </div>
              <dl className="pa-kv">
                <Definicao rotulo="Remuneração vigente">{descreverRegra(k.current)}</Definicao>
                <Definicao rotulo="Base do cálculo">{ROTULOS_BASE_COMISSAO[k.current.commissionBasis]}</Definicao>
                <Definicao rotulo="Conflito collab × cupom">{ROTULOS_POLITICA_CONFLITO[k.current.conflictPolicy]}</Definicao>
                <Definicao rotulo="Política de pagamento">{descreverPolitica(k.current)}</Definicao>
                {k.current.fixedCampaignFeeCents ? <Definicao rotulo="Cachê por conteúdo">{brl(k.current.fixedCampaignFeeCents)} (separado de comissão)</Definicao> : null}
                {k.current.levelCapOverrideReason ? <Definicao rotulo="Override do teto do nível">{k.current.levelCapOverrideReason}</Definicao> : null}
              </dl>
              <DataTable<VersaoContrato>
                label={`Histórico de versões · ${k.title}`} rows={[...k.versions].reverse()} rowKey={(v) => v.id} compact
                columns={[
                  { key: 'v', label: 'Versão', render: (v) => `v${v.version}` },
                  { key: 'e', label: 'Vigente desde', render: (v) => dataCurta(v.effectiveFrom, tz) },
                  { key: 's', label: 'Estado', render: (v) => { const s = statusDeContrato(v.status); return <StatusBadge tone={s.t} label={s.l} />; } },
                  { key: 'r', label: 'Remuneração', priority: 'low', render: (v) => descreverRegra(v) },
                  { key: 'm', label: 'Motivo', priority: 'low', render: (v) => v.reason },
                ]}
              />
            </div>
          );
        })}
      </Card>

      <Card title="Cupons" description="O cupom só fica ativo depois que a promoção standard com este código for confirmada na INK (o Oria a cria lá quando o connector permite); o código só comissiona ativo, dentro da vigência e com contrato ativo. Comissão e tracking são do Oria — a INK só aplica o desconto." action={<Button size="sm" variant="secondary" onClick={() => setCupomDialog(true)}>Cadastrar cupom</Button>}>
        {!perfil.coupons.length && <EmptyState title="Nenhum cupom" description="Cadastre o código aqui e clique em Ativar: o Oria cria a promoção comum (standard) na INK e ativa depois de confirmar. Se a promoção já existir na INK, use Verificar na INK. Não use o programa de afiliados da INK." />}
        {perfil.coupons.length > 0 && (
          <DataTable<Cupom>
            label="Cupons do parceiro" rows={perfil.coupons} rowKey={(c) => c.id}
            columns={[
              { key: 'c', label: 'Código', render: (c) => <strong>{c.codeDisplay}</strong> },
              { key: 's', label: 'Situação', render: (c) => { const s = situacaoDoCupom(c); return <StatusBadge tone={s.tone} label={s.label} />; } },
              { key: 'd', label: 'Desconto', priority: 'low', render: (c) => (c.discountKind === 'percentage' ? pct(c.discountBps) : c.discountKind === 'value' ? brl(c.discountCents) : '—') },
              { key: 'v', label: 'Vigência', priority: 'low', render: (c) => `${dataCurta(c.validFrom, tz)} → ${c.validUntil ? dataCurta(c.validUntil, tz) : 'sem fim'}` },
              { key: 'i', label: 'Promoção na INK', render: (c) => <span title={c.syncError ?? undefined}>{ROTULOS_SYNC_CUPOM[c.syncStatus]}{c.inkPromotionId ? ` · #${c.inkPromotionId}` : ''}</span> },
              {
                key: 'a', label: 'Ações', align: 'right',
                render: (c) => (
                  <span className="pa-badges">
                    {capacidades.read && <Button size="sm" variant="ghost" onClick={() => verificar(c)}>Verificar na INK</Button>}
                    {isOwner && capacidades.update && c.syncStatus === 'divergent' && !!c.inkPromotionId && <Button size="sm" variant="secondary" onClick={() => sincronizar(c)}>Sincronizar com a INK</Button>}
                    {isOwner && capacidades.delete && !!c.inkPromotionId && (c.status === 'paused' || c.status === 'ended') && <Button size="sm" variant="ghost" onClick={() => setExcluir(c)}>Excluir na INK</Button>}
                    {isOwner && (c.status === 'pending_validation' || c.status === 'planned') && <Button size="sm" onClick={() => setRetro(c)}>Ativar</Button>}
                    {isOwner && c.status === 'active' && <Button size="sm" variant="secondary" onClick={() => setAcaoCupom({ tipo: 'pausar', cupom: c })}>Pausar</Button>}
                    {isOwner && c.status === 'paused' && <Button size="sm" variant="secondary" onClick={() => setAcaoCupom({ tipo: 'retomar', cupom: c })}>Retomar</Button>}
                    {isOwner && c.status !== 'ended' && <Button size="sm" variant="danger" onClick={() => setAcaoCupom({ tipo: 'encerrar', cupom: c })}>Encerrar</Button>}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <ContratoDialog open={contratoDialog.aberto} onClose={() => setContratoDialog({ aberto: false, contrato: null })} partnerId={perfil.partner.id} contrato={contratoDialog.contrato} isOwner={isOwner} onSalvo={recarregar} />
      <CupomDialog open={cupomDialog} onClose={() => setCupomDialog(false)} partnerId={perfil.partner.id} contratos={perfil.contracts} onSalvo={recarregar} />
      <MotivoDialog
        open={!!acaoCupom} onClose={() => setAcaoCupom(null)} titulo={`${acaoCupom?.tipo === 'pausar' ? 'Pausar' : acaoCupom?.tipo === 'retomar' ? 'Retomar' : 'Encerrar'} o cupom ${acaoCupom?.cupom.codeDisplay ?? ''}`}
        descricao={acaoCupom?.tipo === 'retomar' ? 'Retomar cria uma nova vigência a partir de agora, reabre o fim da promoção na INK; o período pausado continua sem comissão.' : 'A vigência fecha agora: pedidos feitos depois não comissionam, e o Oria encerra também o desconto na INK (a promoção não é apagada).'}
        confirmVariant={acaoCupom?.tipo === 'encerrar' ? 'danger-solid' : 'primary'}
        onConfirm={async (m) => {
          if (!acaoCupom) return;
          const r = acaoCupom.tipo === 'pausar' ? await afiliados.pausarCupom(acaoCupom.cupom.id, m)
            : acaoCupom.tipo === 'retomar' ? await afiliados.retomarCupom(acaoCupom.cupom.id, m) : await afiliados.encerrarCupom(acaoCupom.cupom.id, m);
          const ink = resumoInkDoFechamento(r.inkSync ? [r.inkSync] : []);
          toast(ink.texto ? `Cupom atualizado · ${ink.texto}` : 'Cupom atualizado.', ink.ok ? 'sucesso' : 'erro');
          recarregar();
        }}
      />
      <MotivoDialog
        open={!!excluir} onClose={() => setExcluir(null)} titulo={`Excluir a promoção ${excluir?.codeDisplay ?? ''} na INK`} confirmVariant="danger-solid"
        descricao="Apaga a promoção na INK (o código fica livre para reuso). Não afeta o histórico de vendas e comissões no Oria. Só para cupons pausados ou encerrados."
        onConfirm={async (m) => { if (!excluir) return; const r = await afiliados.excluirPromocaoNaInk(excluir.id, m); toast(r.jaEstavaExcluida ? 'Já estava excluída na INK; vínculo limpo no Oria.' : 'Promoção excluída na INK.', 'sucesso'); recarregar(); }}
      />
      <ConfirmDialog
        open={!!retro} onClose={() => setRetro(null)} title={`Ativar o cupom ${retro?.codeDisplay ?? ''}?`} confirmLabel="Ativar" confirmVariant="primary"
        description="O Oria confere a promoção na INK e, se ela não existir, cria (connector com criação); se divergir ou a INK falhar, o cupom continua aguardando. A ativação NÃO é retroativa: só pedidos feitos a partir de agora podem comissionar. O contrato precisa estar ativo."
        onConfirm={async () => { if (retro) await ativar(retro); }}
      />
      <Modal open={!!resultadoAtivacao} onClose={() => setResultadoAtivacao(null)} title={`Cupom ${resultadoAtivacao?.cupom.codeDisplay ?? ''} não foi ativado`} maxWidth={620}>
        <p className="pa-aviso">{resultadoAtivacao?.r.message}</p>
        {!!resultadoAtivacao?.r.divergencias.length && <ul className="pa-lista">{resultadoAtivacao.r.divergencias.map((d) => <li key={d}>{d}</li>)}</ul>}
      </Modal>
    </div>
  );
}

// ── Vendas atribuídas ───────────────────────────────────────────────────────────────────────────
function linkDoPedido(id: string): string { return `/admin/pedidos-central?order=${encodeURIComponent(id)}`; }

export function TabelaDeVendas({ vendas, tz, mostrarParceiro }: { vendas: VendaAtribuida[]; tz: string; mostrarParceiro?: boolean }) {
  return (
    <DataTable<VendaAtribuida>
      label="Vendas atribuídas" rows={vendas} rowKey={(v) => v.id}
      columns={[
        { key: 'p', label: 'Pedido', render: (v) => <Link className="pa-link" to={linkDoPedido(v.inkOrderId)}>#{v.inkOrderId}</Link> },
        { key: 'd', label: 'Data', priority: 'low', render: (v) => dataCurta(v.saleAt, tz) },
        ...(mostrarParceiro ? [{ key: 'pt', label: 'Parceiro', render: (v: VendaAtribuida) => v.partnerName }] : []),
        { key: 'o', label: 'Origem', render: (v) => (v.basis === 'collab' ? `Collab${v.collabName ? ` · ${v.collabName}` : ''}` : `Cupom ${v.couponCode ?? ''}`) },
        { key: 'i', label: 'Item', priority: 'low', render: (v) => `${v.productName ?? `item ${v.inkItemId}`}${v.quantity ? ` ×${v.quantity}` : ''}` },
        { key: 'e', label: 'Estado', priority: 'low', render: (v) => ROTULOS_ESTADO_PEDIDO[v.orderState ?? ''] ?? v.orderState ?? '—' },
        { key: 'b', label: 'Base líquida', align: 'right', priority: 'low', render: (v) => brl(v.baseEligibleCents) },
        { key: 'c', label: 'Comissão', align: 'right', render: (v) => brl(v.commissionCents) },
        {
          key: 's', label: 'Situação',
          render: (v) => v.status === 'calculated'
            ? (v.marginAlert ? <StatusBadge tone="warning" label="Margem baixa" /> : <StatusBadge tone="success" label={v.manualOverride ? 'Manual' : 'Calculada'} />)
            : <span title={ROTULOS_MOTIVO_REVISAO[v.reviewReason ?? ''] ?? ''}><StatusBadge tone={v.status === 'blocked' ? 'danger' : 'warning'} label={v.status === 'blocked' ? 'Bloqueada' : 'Em revisão'} /></span>,
        },
      ]}
    />
  );
}

function AbaVendas({ partnerId, tz }: { partnerId: string; tz: string }) {
  const [pagina, setPagina] = useState(1);
  const { dado, erro, carregando, recarregar } = useAsync(() => afiliados.vendasDoParceiro(partnerId, { limit: 25, offset: (pagina - 1) * 25 }), [partnerId, pagina]);
  if (erro) return <ErrorState description={erro} onRetry={recarregar} />;
  if (carregando && !dado) return <Skeleton variant="table" rows={5} />;
  if (!dado || !dado.itens.length) return <EmptyState title="Nenhuma venda atribuída" description="Pedidos com o cupom deste parceiro, ou com produtos da collab, aparecem aqui — por item." />;
  return (
    <div className="pa-shell">
      <TabelaDeVendas vendas={dado.itens} tz={tz} />
      <Pagination page={pagina} totalPages={Math.max(1, Math.ceil(dado.total / 25))} totalLabel={plural(dado.total, 'linha')} onPrev={() => setPagina((p) => p - 1)} onNext={() => setPagina((p) => p + 1)} />
    </div>
  );
}

// ── Comissões (extrato) ─────────────────────────────────────────────────────────────────────────
function AbaComissoes({ partnerId, tz }: { partnerId: string; tz: string }) {
  const { dado, erro, carregando, recarregar } = useAsync(() => afiliados.extrato(partnerId, { limit: 100 }), [partnerId]);
  if (erro) return <ErrorState description={erro} onRetry={recarregar} />;
  if (carregando && !dado) return <Skeleton variant="table" rows={5} />;
  if (!dado) return null;
  const t = dado.totais;
  return (
    <div className="pa-shell">
      <KpiStrip label="Saldo do parceiro">
        <KpiCard title="Comissão bruta" value={brl(t.grossCents)} helper="acúmulo das vendas" />
        <KpiCard title="Ajustes" value={brl(t.adjustmentsCents)} helper="devolução, cancelamento, chargeback" />
        <KpiCard title="Já pago" value={brl(t.paidCents)} />
        <KpiCard title="Saldo liberado" value={brl(t.releasedBalanceCents)} helper="a pagar agora" />
        <KpiCard title="Previsto" value={brl(t.forecastCents)} helper="ainda não liberado" />
        <KpiCard title="Ajuste a compensar" value={brl(t.adjustmentToOffsetCents)} helper="débito que abate o próximo pagamento" />
      </KpiStrip>
      <p className="pa-aviso">{t.explicacao}{t.suspendedByRefund.count ? ` ${plural(t.suspendedByRefund.count, 'lançamento suspenso', 'lançamentos suspensos')} (${brl(t.suspendedByRefund.cents)}) por cancelamento, reembolso ou chargeback.` : ''}</p>
      <DataTable<LancamentoDoExtrato>
        label="Extrato de comissões" rows={dado.itens} rowKey={(l) => l.id}
        columns={[
          { key: 'c', label: 'Competência', render: (l) => competenciaLabel(l.competence.slice(0, 7)) },
          { key: 'o', label: 'Origem', render: (l) => (l.entryType === 'accrual' ? `${l.basis ? ROTULOS_ORIGEM[l.basis] : ''}${l.couponCode ? ` ${l.couponCode}` : ''}${l.collabName ? ` · ${l.collabName}` : ''} · #${l.inkOrderId}` : l.category === 'content_fee' ? 'Cachê por conteúdo' : `Ajuste${l.inkOrderId ? ` · #${l.inkOrderId}` : ''}${l.note ? ` — ${l.note}` : ''}`) },
          { key: 'v', label: 'Valor', align: 'right', render: (l) => brl(l.amountCents) },
          { key: 'p', label: 'Pago', align: 'right', priority: 'low', render: (l) => brl(l.paidCents) },
          { key: 'a', label: 'Em aberto', align: 'right', render: (l) => brl(l.openCents) },
          { key: 's', label: 'Estado', render: (l) => { const r = ROTULOS_STATUS_LANCAMENTO[l.status] ?? { label: l.status, tone: 'neutral' as const }; return <span title={l.holdReason ? ROTULOS_RETENCAO[l.holdReason] ?? l.holdReason : undefined}><StatusBadge tone={r.tone} label={r.label} /></span>; } },
          { key: 'l', label: 'Liberação', priority: 'low', align: 'right', render: (l) => dataCurta(l.releaseAt, tz) },
          { key: 'u', label: 'Vencimento', priority: 'low', align: 'right', render: (l) => (l.dueAt ? dataCurta(l.dueAt, tz) : l.estimatedPaymentAt ? `prev. ${dataCurta(l.estimatedPaymentAt, tz)}` : '—') },
        ]}
      />
    </div>
  );
}

// ── Pagamentos ──────────────────────────────────────────────────────────────────────────────────
function AbaPagamentos({ perfil, tz, recarregar }: { perfil: PerfilDoParceiro; tz: string; recarregar: () => void }) {
  const [pagar, setPagar] = useState(false);
  const [estorno, setEstorno] = useState<string | null>(null);
  const [cache, setCache] = useState(false);
  const lotes = useAsync(() => afiliados.lotes(perfil.partner.id), [perfil.partner.id]);
  const parcial = perfil.balance;
  return (
    <div className="pa-shell">
      <Card
        title="Pagamentos" description="O Oria registra o que você já transferiu; não faz Pix nem saque."
        action={<span className="pa-badges"><Button size="sm" variant="secondary" onClick={() => setCache(true)}>Lançar cachê/ajuste</Button><Button size="sm" onClick={() => setPagar(true)} disabled={!parcial || parcial.releasedBalanceCents <= 0}>Registrar pagamento</Button></span>}
      >
        {parcial && <p className="pa-aviso">Saldo liberado: <strong>{brl(parcial.releasedBalanceCents)}</strong> · previsto: {brl(parcial.forecastCents)} · vencido: {brl(parcial.overdueCents)}.</p>}
        {!perfil.payments.length ? <EmptyState title="Nenhum pagamento registrado" /> : (
          <DataTable
            label="Pagamentos do parceiro" rows={perfil.payments} rowKey={(p) => p.id}
            columns={[
              { key: 'd', label: 'Pago em', render: (p) => dataCurta(p.paidAt, tz) },
              { key: 'k', label: 'Tipo', render: (p) => (p.kind === 'reversal' ? <StatusBadge tone="warning" label="Estorno" /> : p.reversed ? <StatusBadge tone="neutral" label="Estornado" /> : <StatusBadge tone="success" label="Pagamento" />) },
              { key: 'v', label: 'Valor', align: 'right', render: (p) => (p.kind === 'reversal' ? `− ${brl(p.amountCents)}` : brl(p.amountCents)) },
              { key: 'm', label: 'Forma', priority: 'low', render: (p) => ROTULOS_METODO[p.method] },
              { key: 'r', label: 'Referência', priority: 'low', render: (p) => p.externalReference ?? '—' },
              { key: 'g', label: 'Registrado em', priority: 'low', render: (p) => dataHora(p.recordedAt, tz) },
              { key: 'a', label: 'Ações', align: 'right', render: (p) => (p.kind === 'payment' && !p.reversed ? <Button size="sm" variant="danger" onClick={() => setEstorno(p.id)}>Estornar</Button> : null) },
            ]}
          />
        )}
      </Card>
      <Card title="Lotes de fechamento">
        {lotes.dado && lotes.dado.itens.length ? (
          <DataTable
            label="Lotes" rows={lotes.dado.itens} rowKey={(l) => l.id}
            columns={[
              { key: 'c', label: 'Competência', render: (l) => l.competenceLabel },
              { key: 'v', label: 'Proposto', align: 'right', render: (l) => brl(l.proposedCents) },
              { key: 'p', label: 'Pago', align: 'right', render: (l) => brl(l.paidCents ?? 0) },
              { key: 'd', label: 'Vencimento', render: (l) => dataCurta(l.dueAt, tz) },
              { key: 's', label: 'Situação', render: (l) => <StatusBadge tone={l.financialStatus === 'paid' ? 'success' : l.financialStatus === 'overdue' ? 'danger' : l.financialStatus === 'voided' ? 'neutral' : 'info'} label={{ draft: 'Rascunho', scheduled: 'Agendado', partially_paid: 'Parcialmente pago', paid: 'Pago', overdue: 'Vencido', voided: 'Anulado' }[l.financialStatus ?? 'draft']} /> },
            ]}
          />
        ) : <EmptyState title="Nenhum lote" description="Feche um lote na aba A pagar para congelar o que será pago." />}
      </Card>
      <PagamentoDialog open={pagar} onClose={() => setPagar(false)} partnerId={perfil.partner.id} partnerName={perfil.partner.publicName} tz={tz} onRegistrado={() => { recarregar(); lotes.recarregar(); }} />
      <MotivoDialog
        open={!!estorno} onClose={() => setEstorno(null)} titulo="Estornar pagamento" confirmLabel="Estornar" confirmVariant="danger-solid"
        descricao="O estorno cria um contralançamento e devolve o saldo. O registro original continua visível no histórico."
        onConfirm={async (m) => { if (estorno) { await afiliados.estornarPagamento(estorno, m); toast('Pagamento estornado.', 'sucesso'); recarregar(); } }}
      />
      <LancamentoManualDialog open={cache} onClose={() => setCache(false)} partnerId={perfil.partner.id} onSalvo={recarregar} />
    </div>
  );
}

function LancamentoManualDialog({ open, onClose, partnerId, onSalvo }: { open: boolean; onClose: () => void; partnerId: string; onSalvo: () => void }) {
  const [categoria, setCategoria] = useState<'content_fee' | 'commission'>('content_fee');
  const [valor, setValor] = useState('');
  const [motivo, setMotivo] = useState('');
  const [venc, setVenc] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  async function salvar() {
    setEnviando(true); setErro('');
    try {
      const negativo = valor.trim().startsWith('-');
      const numero = Number(valor.replace('-', '').replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(numero) || numero <= 0) throw new Error('Informe um valor válido.');
      await afiliados.lancarManual({ partnerId, category: categoria, amountCents: (negativo ? -1 : 1) * Math.round(numero * 100), reason: motivo.trim(), dueAt: venc ? new Date(`${venc}T12:00:00-03:00`).toISOString() : undefined });
      toast('Lançamento registrado.', 'sucesso'); onSalvo(); onClose();
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title="Lançamento manual" confirmLabel={enviando ? 'Aguarde…' : 'Lançar'} confirmDisabled={enviando || !valor.trim() || !motivo.trim()} onConfirm={salvar} maxWidth={520}>
      <div className="pa-form">
        <p className="pa-aviso">Cachê por conteúdo entra como <strong>categoria separada</strong> de comissão por venda (mesma trilha de pagamento, somas separadas). Use valor negativo para um ajuste a compensar.</p>
        <Field label="Categoria"><Select value={categoria} onChange={(e) => setCategoria(e.target.value as typeof categoria)}><option value="content_fee">Cachê por conteúdo</option><option value="commission">Ajuste de comissão</option></Select></Field>
        <div className="pa-form__linha">
          <Field label="Valor (R$)" required><Input inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} placeholder="300,00" /></Field>
          <Field label="Vencimento" optional><Input type="date" value={venc} onChange={(e) => setVenc(e.target.value)} /></Field>
        </div>
        <Field label="Motivo" required><Textarea rows={2} value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></Field>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

// ── Níveis e benefícios ─────────────────────────────────────────────────────────────────────────
function AbaNiveis({ perfil, isOwner, tz, recarregar }: { perfil: PerfilDoParceiro; isOwner: boolean; tz: string; recarregar: () => void }) {
  const [nivel, setNivel] = useState(false);
  const [peca, setPeca] = useState(false);
  const [reverter, setReverter] = useState<string | null>(null);
  const av = perfil.level;
  const prox = av.evaluation.proximo;
  return (
    <div className="pa-shell">
      <Card title={`Nível atual: ${av.currentLevel.label}`} description={`Desde ${dataCurta(av.currentLevel.since, tz)} · teto de remuneração sobre margem ${pct(av.currentLevel.marginCapBps)}`} action={isOwner ? <Button size="sm" variant="secondary" onClick={() => setNivel(true)}>Alterar nível (override)</Button> : undefined}>
        <p className="pa-aviso">Elegibilidade considera só vendas com pagamento confirmado, sem devolução, na janela móvel. Cupom + collab sobre a mesma linha contam uma vez. Meta de margem sem custo verificado fica “não verificada”.</p>
        <dl className="pa-kv">
          <Definicao rotulo="Vendas qualificadas (90 dias)">{av.metrics.vendasQualificadas} ({av.metrics.contarPor === 'units' ? 'unidades' : 'pedidos distintos'})</Definicao>
          <Definicao rotulo="Unidades">{av.metrics.unidades}</Definicao>
          <Definicao rotulo="Margem de produção verificada">{av.metrics.margemVerificada ? brl(av.metrics.margemCents) : 'não verificada (falta custo)'}</Definicao>
          <Definicao rotulo="Meses com venda">{av.metrics.mesesComVenda}</Definicao>
        </dl>
        {av.pendingProposal && <Callout tone="info" title="Proposta pendente">Mudança de {av.pendingProposal.from} para {av.pendingProposal.to} aguarda decisão na aba Níveis e benefícios do módulo.</Callout>}
        {prox ? (
          <div className="pa-progresso pa-mt-4">
            <strong>Progresso para {prox.label}</strong>
            {prox.metas.map((m) => (
              <div key={m.meta} className="pa-progresso__linha">
                <span>{ROTULOS_META[m.meta] ?? m.meta}</span>
                <ProgressBar label={`Progresso: ${ROTULOS_META[m.meta] ?? m.meta}`} value={m.atual === null ? 0 : Math.min(m.exigido, m.atual)} max={Math.max(1, m.exigido)} />
                <span className="pa-num">{m.naoVerificada ? 'não verificada' : m.meta === 'margemCents' ? `${brl(m.atual)} / ${brl(m.exigido)}` : `${m.atual} / ${m.exigido}`}{m.ok ? ' ✓' : ''}</span>
              </div>
            ))}
          </div>
        ) : <p className="pa-aviso">Nível máximo.</p>}
        <h3 className="ds-card__title pa-mt-5">Histórico de níveis</h3>
        <DataTable
          label="Histórico de níveis" rows={perfil.levelHistory} rowKey={(h) => `${h.level}-${h.effectiveAt}`} compact
          columns={[{ key: 'n', label: 'Nível', render: (h) => h.level }, { key: 'd', label: 'Efetivo em', render: (h) => dataCurta(h.effectiveAt, tz) }, { key: 's', label: 'Origem', render: (h) => h.source }, { key: 'r', label: 'Motivo', render: (h) => h.reason ?? '—' }]}
        />
      </Card>

      <Card title="Carteira de benefícios" description="Separada das comissões: nunca vira dinheiro a pagar. Peça só por venda/saldo, ou exceção de criador convidado." action={isOwner ? <Button size="sm" onClick={() => setPeca(true)}>Conceder peça</Button> : undefined}>
        <KpiStrip label="Carteira">
          <KpiCard title="Saldo" value={brl(perfil.benefits.balanceCents)} />
          <KpiCard title="Créditos acumulados" value={brl(perfil.benefits.creditsCents)} helper="até 25% da contribuição verificada" />
          <KpiCard title="Consumido" value={brl(perfil.benefits.consumedCents)} helper="produção + frete reais" />
        </KpiStrip>
        <p className="pa-aviso">{perfil.benefits.pieceEligibility.elegivel ? 'Elegível a uma peça agora (sujeito ao custo e ao saldo).' : `Peça não liberada agora: ${{ nivel_sem_peca: 'o nível não prevê peça', vendas_insuficientes: 'vendas acumuladas insuficientes', periodo_nao_cumprido: 'período mínimo entre peças não cumprido', atividade_insuficiente: 'atividade recente insuficiente', saldo_insuficiente: 'saldo insuficiente' }[perfil.benefits.pieceEligibility.motivo ?? ''] ?? perfil.benefits.pieceEligibility.motivo}.`}</p>
        {perfil.benefits.entries.length > 0 && (
          <DataTable
            label="Lançamentos da carteira" rows={perfil.benefits.entries} rowKey={(e) => e.id} compact
            columns={[
              { key: 'd', label: 'Data', render: (e) => dataCurta(e.createdAt, tz) },
              { key: 't', label: 'Tipo', render: (e) => ({ budget_credit: 'Crédito', consumption: 'Peça concedida', reversal: 'Estorno', exceptional_grant: e.guestCreator ? 'Criador convidado' : 'Concessão excepcional' }[e.entryType] ?? e.entryType) },
              { key: 'v', label: 'Valor', align: 'right', render: (e) => brl(e.amountCents) },
              { key: 'x', label: 'Descrição', priority: 'low', render: (e) => `${e.description ?? ''}${e.deliverables ? ` · entregáveis: ${e.deliverables}` : ''}` },
              { key: 'a', label: 'Ações', align: 'right', render: (e) => (isOwner && e.amountCents < 0 ? <Button size="sm" variant="ghost" onClick={() => setReverter(e.id)}>Reverter</Button> : null) },
            ]}
          />
        )}
      </Card>

      <NivelDialog open={nivel} onClose={() => setNivel(false)} partnerId={perfil.partner.id} atual={av.currentLevel.key} onSalvo={recarregar} />
      <PecaDialog open={peca} onClose={() => setPeca(false)} partnerId={perfil.partner.id} onSalvo={recarregar} />
      <MotivoDialog open={!!reverter} onClose={() => setReverter(null)} titulo="Reverter lançamento de benefício" onConfirm={async (m) => { if (reverter) { await afiliados.reverterBeneficio(reverter, m); toast('Benefício revertido.', 'sucesso'); recarregar(); } }} />
    </div>
  );
}

function NivelDialog({ open, onClose, partnerId, atual, onSalvo }: { open: boolean; onClose: () => void; partnerId: string; atual: string; onSalvo: () => void }) {
  const [nivel, setNivel] = useState(atual);
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const regras = useAsync(() => (open ? afiliados.regrasDeNivel() : Promise.resolve(null)), [open]);
  const niveis = regras.dado ? regras.dado.regras.niveis : [];

  async function salvar() {
    setEnviando(true); setErro('');
    try {
      await afiliados.definirNivel(partnerId, { level: nivel, reason: motivo.trim() });
      toast('Nível alterado.', 'sucesso'); onSalvo(); onClose(); setMotivo('');
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }

  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title="Alterar nível (override)" maxWidth={480} confirmLabel={enviando ? 'Aguarde…' : 'Alterar nível'} confirmDisabled={enviando || !motivo.trim() || nivel === atual} onConfirm={salvar}>
      <div className="pa-form">
        <p className="pa-aviso">Override exige motivo e fica na auditoria. Não reescreve nenhum contrato em vigor nem comissões já capturadas.</p>
        <Field label="Novo nível">
          <Select value={nivel} onChange={(e) => setNivel(e.target.value)}>{niveis.map((n) => <option key={n.key} value={n.key} disabled={n.key === atual}>{n.label}{n.key === atual ? ' (atual)' : ''}</option>)}</Select>
        </Field>
        <Field label="Motivo" required><Textarea rows={3} value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></Field>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

function PecaDialog({ open, onClose, partnerId, onSalvo }: { open: boolean; onClose: () => void; partnerId: string; onSalvo: () => void }) {
  const [producao, setProducao] = useState('');
  const [frete, setFrete] = useState('');
  const [descricao, setDescricao] = useState('');
  const [convidado, setConvidado] = useState(false);
  const [entregaveis, setEntregaveis] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  const toCents = (t: string) => { const n = Number(t.replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
  async function salvar() {
    setEnviando(true); setErro('');
    try {
      await afiliados.concederPeca(partnerId, { productionCostCents: toCents(producao), shippingCostCents: frete ? toCents(frete) : 0, description: descricao.trim(), guestCreator: convidado, deliverables: convidado ? entregaveis.trim() : undefined });
      toast('Peça registrada na carteira.', 'sucesso'); onSalvo(); onClose();
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title="Conceder peça" confirmLabel={enviando ? 'Aguarde…' : 'Conceder'} confirmDisabled={enviando || !producao.trim() || !descricao.trim() || (convidado && !entregaveis.trim())} onConfirm={salvar} maxWidth={560}>
      <div className="pa-form">
        <p className="pa-aviso">Debita produção + frete <strong>reais</strong> da carteira. Não existe peça grátis ao ingressar: só por venda/saldo, ou exceção de criador convidado com entregáveis combinados.</p>
        <Field label="Descrição da peça" required><Input value={descricao} maxLength={300} onChange={(e) => setDescricao(e.target.value)} /></Field>
        <div className="pa-form__linha">
          <Field label="Custo de produção (R$)" required><Input inputMode="decimal" value={producao} onChange={(e) => setProducao(e.target.value)} /></Field>
          <Field label="Frete (R$)" optional><Input inputMode="decimal" value={frete} onChange={(e) => setFrete(e.target.value)} /></Field>
        </div>
        <label className="ds-checkbox"><input type="checkbox" checked={convidado} onChange={(e) => setConvidado(e.target.checked)} /> <span className="ds-checkbox__text"><span className="ds-checkbox__label">Criador convidado (permuta antecipada)</span><span className="ds-checkbox__description">Exceção documentada; não sobe de nível e não depende de saldo.</span></span></label>
        {convidado && <Field label="Entregáveis combinados" required><Textarea rows={2} value={entregaveis} maxLength={1000} onChange={(e) => setEntregaveis(e.target.value)} /></Field>}
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

// ── Página ──────────────────────────────────────────────────────────────────────────────────────
export function ParceiroPerfilPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { isOwner, tz } = useParcerias();
  const { valores, alterar } = useFiltrosUrl({ aba: 'resumo' });
  const aba = (valores.aba || 'resumo') as Aba;
  const [decisao, setDecisao] = useState<'approved' | 'rejected' | null>(null);
  const [vinculo, setVinculo] = useState<'active' | 'paused' | 'ended' | null>(null);

  const { dado: perfil, erro, carregando, recarregar } = useAsync(() => afiliados.perfil(id), [id]);

  const itens = useMemo(() => [
    { value: 'resumo' as Aba, label: 'Resumo' }, { value: 'contratos' as Aba, label: 'Contratos e cupons' }, { value: 'collabs' as Aba, label: 'Collabs' }, { value: 'vendas' as Aba, label: 'Vendas' },
    ...(isOwner ? [{ value: 'comissoes' as Aba, label: 'Comissões' }, { value: 'pagamentos' as Aba, label: 'Pagamentos' }] : []),
    { value: 'niveis' as Aba, label: 'Níveis e benefícios' }, { value: 'atividades' as Aba, label: 'Atividades' },
  ], [isOwner]);

  if (erro) return <PageStack><ErrorState title="Parceiro não encontrado" description={erro} onRetry={recarregar} action={<Button variant="secondary" onClick={() => navigate('/admin/parcerias/parceiros')}>Voltar à lista</Button>} /></PageStack>;
  if (carregando && !perfil) return <PageStack><Skeleton rows={1} height="48px" width="40%" /><Skeleton variant="table" rows={5} /></PageStack>;
  if (!perfil) return null;
  const p = perfil.partner;
  const contratoAtivo = perfil.contracts.find((k) => k.current.status === 'active');

  return (
    <PageStack>
      <PageHeader
        title={p.publicName} back={{ to: '/admin/parcerias/parceiros', label: 'Parceiros' }}
        description={p.contactEmail ?? undefined}
        meta={<span className="pa-badges"><StatusBadge tone={p.applicationStatus === 'approved' ? 'success' : p.applicationStatus === 'rejected' ? 'danger' : 'warning'} label={ROTULOS_CANDIDATURA[p.applicationStatus]} /><StatusBadge tone={TOM_VINCULO[p.relationshipStatus]} label={ROTULOS_VINCULO[p.relationshipStatus]} />{p.legacyInkAffiliate && <StatusBadge tone="danger" label="Afiliado nativo da INK (bloqueado)" />}</span>}
        actions={isOwner ? [
          ...(p.applicationStatus === 'candidate' ? [<Button key="ap" onClick={() => setDecisao('approved')}>Aprovar candidatura</Button>, <Button key="rj" variant="danger" onClick={() => setDecisao('rejected')}>Reprovar</Button>] : []),
          ...(p.applicationStatus === 'approved' && p.relationshipStatus === 'active' ? [<Button key="pz" variant="secondary" onClick={() => setVinculo('paused')}>Pausar vínculo</Button>] : []),
          ...(p.applicationStatus === 'approved' && ['draft', 'paused'].includes(p.relationshipStatus) ? [<Button key="at" variant="secondary" onClick={() => setVinculo('active')}>Ativar vínculo</Button>] : []),
          ...(p.relationshipStatus !== 'ended' && p.applicationStatus === 'approved' ? [<Button key="en" variant="danger" onClick={() => setVinculo('ended')}>Encerrar</Button>] : []),
        ] : undefined}
      />
      <TabList<Aba> label="Seções do parceiro" items={itens} value={aba} onChange={(a) => alterar({ aba: a })} />

      {aba === 'resumo' && (
        <div className="pa-shell">
          <div className="pa-grid pa-grid--2">
            <Card title="Dados do parceiro">
              <dl className="pa-kv">
                <Definicao rotulo="Contato comercial">{p.contactName ?? '—'}</Definicao>
                <Definicao rotulo="E-mail">{p.contactEmail ?? '—'}</Definicao>
                <Definicao rotulo="Telefone">{p.contactPhone ?? '—'}</Definicao>
                <Definicao rotulo="Perfis">{p.profiles.length ? p.profiles.map((x) => `${x.network}${x.handle ? ` ${x.handle}` : ''}`).join(', ') : '—'}</Definicao>
                <Definicao rotulo="Origem da candidatura">{p.origin ?? '—'}</Definicao>
                <Definicao rotulo="Comunidade / região">{p.communityRegion ?? '—'}</Definicao>
                <Definicao rotulo="Termos aceitos">{p.termsVersion ? `${p.termsVersion} em ${dataCurta(p.termsAcceptedAt, tz)}` : '—'}</Definicao>
                <Definicao rotulo="Observações internas">{p.internalNotes ?? '—'}</Definicao>
              </dl>
            </Card>
            <Card title="Situação operacional" description="O que precisa de atenção neste parceiro.">
              <Saude flags={perfil.health} />
              {contratoAtivo && <p className="pa-aviso pa-mt-3"><strong>Política aplicada:</strong> {descreverPolitica(contratoAtivo.current)}. A previsão de cada pagamento usa esta política — datas da versão do contrato vigente na venda.</p>}
              {!contratoAtivo && <Callout tone="warning">Sem contrato ativo: nada comissiona. Vá em Contratos e cupons.</Callout>}
            </Card>
          </div>
          {isOwner && perfil.balance && (
            <KpiStrip label="Saldo">
              <KpiCard title="Em apuração / previsto" value={brl(perfil.balance.forecastCents)} helper="ainda não liberado" />
              <KpiCard title="Liberado a pagar" value={brl(perfil.balance.releasedBalanceCents)} />
              <KpiCard title="Vencido" value={brl(perfil.balance.overdueCents)} />
              <KpiCard title="Pago" value={brl(perfil.balance.paidCents)} helper={perfil.payments[0] ? `último em ${dataCurta(perfil.payments.find((x) => x.kind === 'payment')?.paidAt, tz)}` : 'nenhum ainda'} />
              <KpiCard title="Ajuste a compensar" value={brl(perfil.balance.adjustmentToOffsetCents)} />
              <KpiCard title="Saldo líquido" value={brl(perfil.balance.netBalanceCents)} helper="liberado + previsto" />
            </KpiStrip>
          )}
          {isOwner && <PreviewLinkCard partnerId={p.id} />}
          <Card title="Atividade recente"><ListaDeAtividades itens={perfil.activity.slice(0, 6)} tz={tz} /></Card>
        </div>
      )}
      {aba === 'contratos' && <AbaContratos perfil={perfil} isOwner={isOwner} recarregar={recarregar} />}
      {aba === 'collabs' && (
        <Card title="Collabs em que participa" description="A comissão de collab vem dos itens vendidos vinculados à arte — com ou sem cupom.">
          {perfil.collabs.length ? (
            <DataTable rows={perfil.collabs} rowKey={(k) => `${k.id}-${k.validFrom}`} label="Collabs do parceiro" onRowClick={(k) => navigate(`/admin/parcerias/collabs/${k.id}`)}
              columns={[{ key: 'n', label: 'Collab', render: (k) => k.name }, { key: 'p', label: 'Participação', align: 'right', render: (k) => pct(k.shareBps) }, { key: 'v', label: 'Vigência', render: (k) => `${dataCurta(k.validFrom, tz)} → ${k.validTo ? dataCurta(k.validTo, tz) : 'atual'}` }]} />
          ) : <EmptyState title="Sem collab" description="Crie uma collab na aba Collabs e vincule este parceiro como criador (contrato de collab ou híbrido)." />}
        </Card>
      )}
      {aba === 'vendas' && <AbaVendas partnerId={p.id} tz={tz} />}
      {aba === 'comissoes' && isOwner && <AbaComissoes partnerId={p.id} tz={tz} />}
      {aba === 'pagamentos' && isOwner && <AbaPagamentos perfil={perfil} tz={tz} recarregar={recarregar} />}
      {aba === 'niveis' && <AbaNiveis perfil={perfil} isOwner={isOwner} tz={tz} recarregar={recarregar} />}
      {aba === 'atividades' && <Card title="Linha do tempo" description="Alterações de contrato, cupom, nível, pagamento e integração."><ListaDeAtividades itens={perfil.activity} tz={tz} /></Card>}

      <MotivoDialog
        open={decisao !== null} onClose={() => setDecisao(null)} titulo={decisao === 'approved' ? 'Aprovar candidatura' : 'Reprovar candidatura'} obrigatorio={decisao === 'rejected'}
        descricao={decisao === 'approved' ? 'Aprovar não dá comissão: falta um contrato ativo. Também não concede peça grátis.' : 'O parceiro fica reprovado e o vínculo, encerrado.'} confirmVariant={decisao === 'rejected' ? 'danger-solid' : 'primary'}
        onConfirm={async (m) => { if (decisao) { await afiliados.decidirCandidatura(p.id, { decision: decisao, reason: m || undefined }); toast('Candidatura atualizada.', 'sucesso'); recarregar(); } }}
      />
      <MotivoDialog
        open={vinculo !== null} onClose={() => setVinculo(null)} titulo={vinculo === 'active' ? 'Ativar vínculo' : vinculo === 'paused' ? 'Pausar vínculo' : 'Encerrar vínculo'} confirmVariant={vinculo === 'ended' ? 'danger-solid' : 'primary'}
        descricao={vinculo === 'ended' ? 'Encerrar o vínculo encerra os cupons abertos do parceiro e o desconto deles na INK (as promoções não são apagadas — exclua depois, se quiser). Vendas já capturadas continuam com as condições da data.' : 'Vendas já capturadas continuam com as condições da data; o vínculo só afeta o que vem depois.'}
        onConfirm={async (m) => {
          if (!vinculo) return;
          const r = await afiliados.mudarVinculo(p.id, { status: vinculo, reason: m });
          const ink = resumoInkDoFechamento(r.cupons?.ink ?? []);
          toast(r.cupons ? `Vínculo encerrado · ${plural(r.cupons.encerrados, 'cupom encerrado', 'cupons encerrados')}${ink.texto ? ` · ${ink.texto}` : ''}.` : 'Vínculo atualizado.', ink.ok ? 'sucesso' : 'erro');
          recarregar();
        }}
      />
    </PageStack>
  );
}

function ListaDeAtividades({ itens, tz }: { itens: PerfilDoParceiro['activity']; tz: string }) {
  if (!itens.length) return <EmptyState title="Sem atividade registrada" />;
  return (
    <ul className="pa-alertas">
      {itens.map((a) => (
        <li key={a.id} className="pa-alertas__item">
          <span><strong>{ROTULOS_ACAO[a.action] ?? a.action}</strong>{a.reason ? ` — ${a.reason}` : ''}</span>
          <span className="pa-muted">{dataHora(a.at, tz)}</span>
        </li>
      ))}
    </ul>
  );
}
