import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button, Callout, Card, Checkbox, DataTable, EmptyState, ErrorState, Field, Input, KpiCard, KpiStrip, Modal, PageHeader, PageStack, Pagination, Select, Skeleton, StatusBadge, TabList,
} from '../../components/ds';
import {
  afiliados, type LinhaAPagar, type Lote, type ParceiroDaLista, type PreviaFechamento, type StatusFinanceiro,
} from '../../api/afiliados';
import { useAsync } from '../../lib/useAsync';
import { useFiltrosUrl } from '../../lib/useFiltrosUrl';
import { toast } from '../../lib/toast';
import {
  ROTULOS_DATA_PAGAR, ROTULOS_METODO, ROTULOS_MODALIDADE, ROTULOS_STATUS_FINANCEIRO, TOM_STATUS_FINANCEIRO, brl, competenciaLabel, dataCurta, intervaloDoPreset, mensagemDoErro, plural,
  type PresetDePeriodo,
} from '../../lib/parcerias';
import { FiltroDePeriodo } from './componentes';
import { MotivoDialog, PagamentoDialog } from './modais';
import { useParcerias } from './ParceriasLayout';

const PADRAO = {
  range: 'this_month', from: '', to: '', dateType: 'due', status: '', partnerId: '', modality: '', category: '', method: '', settlement: '', overdue: '', collabId: '', sort: 'due', dir: 'asc', page: '1', aba: 'pendencias',
};
const POR_PAGINA = 25;
type Aba = 'pendencias' | 'lotes' | 'pagamentos';

// ── Fechamento (lote) ─────────────────────────────────────────────────────────────────────────
function FechamentoDialog({ open, onClose, partnerId, partnerName, onCriado }: { open: boolean; onClose: () => void; partnerId: string; partnerName: string; onCriado: () => void }) {
  const [previa, setPrevia] = useState<PreviaFechamento | null>(null);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [abaixo, setAbaixo] = useState(false);
  const { tz } = useParcerias();

  useEffect(() => {
    if (!open) return;
    setPrevia(null); setErro(''); setAbaixo(false);
    afiliados.previaFechamento({ partnerId }).then(setPrevia).catch((e) => setErro(mensagemDoErro(e)));
  }, [open, partnerId]);

  const podeCriar = previa && previa.situacao !== 'nada_a_pagar' && (previa.situacao === 'ok' || abaixo);
  async function criar() {
    setEnviando(true); setErro('');
    try { await afiliados.criarLote({ partnerId, abaixoDoMinimo: abaixo }); toast('Lote criado em rascunho. Aprove para poder registrar pagamentos.', 'sucesso'); onCriado(); onClose(); }
    catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }

  return (
    <Modal open={open} onClose={() => { if (!enviando) onClose(); }} title={`Fechamento · ${partnerName}`} confirmLabel={enviando ? 'Aguarde…' : 'Criar lote'} confirmDisabled={enviando || !podeCriar} onConfirm={criar} maxWidth={620}>
      <div className="pa-form">
        {!previa && !erro && <Skeleton rows={3} />}
        {previa && (
          <>
            <dl className="pa-kv">
              <div className="pa-kv__item"><dt>Valor proposto (líquido)</dt><dd><strong>{brl(previa.liquidoCents)}</strong></dd></div>
              <div className="pa-kv__item"><dt>Mínimo para repasse</dt><dd>{brl(previa.minimoCents)}{previa.acumulaAbaixoDoMinimo ? ' (abaixo disso acumula)' : ''}</dd></div>
              <div className="pa-kv__item"><dt>Corte</dt><dd>{dataCurta(previa.cutoffAt, tz)}</dd></div>
              <div className="pa-kv__item"><dt>Lançamentos</dt><dd>{previa.entradas.length}</dd></div>
            </dl>
            {previa.situacao === 'nada_a_pagar' && <Callout tone="warning">Não há saldo liberado a pagar. Ajustes a compensar só entram junto de créditos.</Callout>}
            {previa.situacao === 'abaixo_do_minimo' && (
              <Callout tone="info" title="Abaixo do mínimo">
                {previa.divergencias.join(' ')}
                <div className="pa-mt-2"><Checkbox label="Fechar mesmo assim" checked={abaixo} onChange={(e) => setAbaixo(e.target.checked)} /></div>
              </Callout>
            )}
            <p className="pa-aviso">O lote congela o que será pago. Ele precisa ser aprovado antes de registrar pagamentos; se algo mudar nos lançamentos, ele é recusado e você refaz.</p>
          </>
        )}
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}

function AbaLotes({ tz, onPagar }: { tz: string; onPagar: (l: Lote) => void }) {
  const { dado, erro, carregando, recarregar } = useAsync(() => afiliados.lotes(), []);
  const [anular, setAnular] = useState<Lote | null>(null);
  if (erro) return <ErrorState description={erro} onRetry={recarregar} />;
  if (carregando && !dado) return <Skeleton variant="table" rows={4} />;
  if (!dado || !dado.itens.length) return <EmptyState title="Nenhum lote de fechamento" description="Use “Fechar lote” em uma linha de pendências para congelar o valor de um parceiro." />;
  const rotulo: Record<NonNullable<Lote['financialStatus']>, [string, 'neutral' | 'info' | 'warning' | 'success' | 'danger']> = {
    draft: ['Rascunho', 'neutral'], scheduled: ['Agendado', 'info'], partially_paid: ['Parcialmente pago', 'warning'], paid: ['Pago', 'success'], overdue: ['Vencido', 'danger'], voided: ['Anulado', 'neutral'],
  };
  return (
    <>
      <DataTable<Lote>
        label="Lotes de fechamento" rows={dado.itens} rowKey={(l) => l.id}
        columns={[
          { key: 'p', label: 'Parceiro', render: (l) => <Link className="pa-link" to={`/admin/parcerias/parceiros/${l.partnerId}`}>{l.partnerName}</Link> },
          { key: 'c', label: 'Competência', render: (l) => l.competenceLabel },
          { key: 'v', label: 'Proposto', align: 'right', render: (l) => brl(l.proposedCents) },
          { key: 'g', label: 'Pago', align: 'right', render: (l) => brl(l.paidCents ?? 0) },
          { key: 'd', label: 'Vencimento', align: 'right', render: (l) => dataCurta(l.dueAt, tz) },
          { key: 's', label: 'Situação', render: (l) => { const [t, tom] = rotulo[l.financialStatus ?? 'draft']; return <StatusBadge tone={tom} label={t} />; } },
          {
            key: 'a', label: 'Ações', align: 'right',
            render: (l) => (
              <span className="pa-badges">
                {l.status === 'draft' && <Button size="sm" onClick={async () => { try { await afiliados.aprovarLote(l.id); toast('Lote aprovado.', 'sucesso'); recarregar(); } catch (e) { toast(mensagemDoErro(e)); } }}>Aprovar</Button>}
                {l.status === 'approved' && (l.financialStatus !== 'paid') && <Button size="sm" onClick={() => onPagar(l)}>Registrar pagamento</Button>}
                {l.status !== 'voided' && (l.paidCents ?? 0) === 0 && <Button size="sm" variant="ghost" onClick={() => setAnular(l)}>Anular</Button>}
              </span>
            ),
          },
        ]}
      />
      <MotivoDialog open={!!anular} onClose={() => setAnular(null)} titulo="Anular lote" confirmLabel="Anular" confirmVariant="danger-solid" descricao="Só lote sem pagamento pode ser anulado; com pagamento, estorne o pagamento."
        onConfirm={async (m) => { if (anular) { await afiliados.anularLote(anular.id, m); toast('Lote anulado.', 'sucesso'); recarregar(); } }} />
    </>
  );
}

function AbaPagamentos({ tz }: { tz: string }) {
  const { dado, erro, carregando, recarregar } = useAsync(() => afiliados.pagamentos(), []);
  const [estorno, setEstorno] = useState<string | null>(null);
  if (erro) return <ErrorState description={erro} onRetry={recarregar} />;
  if (carregando && !dado) return <Skeleton variant="table" rows={4} />;
  if (!dado || !dado.itens.length) return <EmptyState title="Nenhum pagamento registrado" />;
  return (
    <>
      <DataTable
        label="Pagamentos registrados" rows={dado.itens} rowKey={(p) => p.id}
        columns={[
          { key: 'd', label: 'Pago em (efetivo)', render: (p) => dataCurta(p.paidAt, tz) },
          { key: 'r', label: 'Registrado em', priority: 'low', render: (p) => dataCurta(p.recordedAt, tz) },
          { key: 'p', label: 'Parceiro', render: (p) => <Link className="pa-link" to={`/admin/parcerias/parceiros/${p.partnerId}`}>{p.partnerName}</Link> },
          { key: 'k', label: 'Tipo', render: (p) => (p.kind === 'reversal' ? <StatusBadge tone="warning" label="Estorno" /> : p.reversed ? <StatusBadge tone="neutral" label="Estornado" /> : <StatusBadge tone="success" label="Pagamento" />) },
          { key: 'v', label: 'Valor', align: 'right', render: (p) => (p.kind === 'reversal' ? `− ${brl(p.amountCents)}` : brl(p.amountCents)) },
          { key: 'm', label: 'Forma', priority: 'low', render: (p) => ROTULOS_METODO[p.method] },
          { key: 'e', label: 'Referência', priority: 'low', render: (p) => p.externalReference ?? '—' },
          { key: 'a', label: 'Ações', align: 'right', render: (p) => (p.kind === 'payment' && !p.reversed ? <Button size="sm" variant="danger" onClick={() => setEstorno(p.id)}>Estornar</Button> : null) },
        ]}
      />
      <MotivoDialog open={!!estorno} onClose={() => setEstorno(null)} titulo="Estornar pagamento" confirmLabel="Estornar" confirmVariant="danger-solid" descricao="Cria um contralançamento; o pagamento original permanece no histórico."
        onConfirm={async (m) => { if (estorno) { await afiliados.estornarPagamento(estorno, m); toast('Pagamento estornado.', 'sucesso'); recarregar(); } }} />
    </>
  );
}

// ── Página ──────────────────────────────────────────────────────────────────────────────────────
export function APagarPage() {
  const { isOwner, tz } = useParcerias();
  const { valores, alterar, limpar, ativos } = useFiltrosUrl(PADRAO);
  const pagina = Math.max(1, Number.parseInt(valores.page, 10) || 1);
  const aba = (valores.aba || 'pendencias') as Aba;
  const [parceiros, setParceiros] = useState<ParceiroDaLista[]>([]);
  const [pagar, setPagar] = useState<{ linha: LinhaAPagar | null; partnerId: string; nome: string; lote: Lote | null } | null>(null);
  const [fechar, setFechar] = useState<{ partnerId: string; nome: string } | null>(null);
  const [prorrogar, setProrrogar] = useState<LinhaAPagar | null>(null);
  const [novaData, setNovaData] = useState('');

  useEffect(() => { if (isOwner) afiliados.parceiros({ limit: 100, sort: 'name' }).then((r) => setParceiros(r.itens)).catch(() => undefined); }, [isOwner]);

  const periodo = useMemo(() => {
    if (valores.from && valores.to) return { from: valores.from, to: valores.to };
    const preset = (valores.range || 'this_month') as PresetDePeriodo;
    return intervaloDoPreset(preset === 'custom' ? 'this_month' : preset, tz);
  }, [valores.from, valores.to, valores.range, tz]);

  const filtros = useMemo(() => ({
    dateType: valores.dateType, from: periodo.from, to: periodo.to, status: valores.status || undefined, partnerId: valores.partnerId || undefined, modality: valores.modality || undefined,
    category: valores.category || undefined, method: valores.method || undefined, settlement: valores.settlement || undefined, overdue: valores.overdue === 'true' ? 'true' : undefined,
    collabId: valores.collabId || undefined, sort: valores.sort, dir: valores.dir,
  }), [valores, periodo]);

  const resumo = useAsync(() => (isOwner ? afiliados.resumoAPagar({ from: periodo.from, to: periodo.to }) : Promise.resolve(null)), [isOwner, periodo.from, periodo.to]);
  const lista = useAsync(
    () => (isOwner && aba === 'pendencias' ? afiliados.aPagar({ ...filtros, limit: POR_PAGINA, offset: (pagina - 1) * POR_PAGINA }) : Promise.resolve(null)),
    [isOwner, aba, JSON.stringify(filtros), pagina],
  );

  if (!isOwner) return <PageStack><PageHeader title="A pagar" /><EmptyState title="Área do owner" description="Valores a pagar e pagamentos são visíveis apenas para o owner da loja." /></PageStack>;

  const k = resumo.dado;
  const total = lista.dado?.total ?? 0;
  const totalPaginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const recarregarTudo = () => { resumo.recarregar(); lista.recarregar(); };

  async function salvarProrrogacao() {
    if (!prorrogar || !novaData) return;
    // Vencimento manual por linha: usa todos os lançamentos abertos do parceiro na competência (extrato) — sempre com motivo (ver diálogo).
  }
  void salvarProrrogacao;

  return (
    <PageStack>
      <PageHeader title="A pagar" description="Quanto e quando pagar, por parceiro e competência. Previsão não é dívida: só o que já foi liberado vence." actions={<a className="ds-btn ds-btn--secondary" href={afiliados.urlDoCsv({ ...filtros, limit: 200 })} download>Exportar CSV</a>} />

      {k && (
        <KpiStrip label="Contas a pagar">
          <KpiCard title="Vencido" value={brl(k.overdueCents)} helper="liberado com prazo vencido" />
          <KpiCard title="Vence em 7 dias" value={brl(k.dueIn7Cents)} />
          <KpiCard title="Vence em 30 dias" value={brl(k.dueIn30Cents)} />
          <KpiCard title="Previsto (não liberado)" value={brl(k.forecastCents)} helper="ainda não é dívida" />
          <KpiCard title="Disponível para pagamento" value={brl(k.availableCents)} helper="liberado e em aberto" />
          <KpiCard title="Pago no período" value={brl(k.paidInPeriodCents)} helper={`${k.periodoDoPago.criterio}`} />
          <KpiCard title="Ajustes pendentes" value={brl(k.pendingAdjustmentsCents)} helper="débitos a compensar" />
        </KpiStrip>
      )}
      {k && k.contentFeesOpenCents > 0 && <Callout tone="info">Cachês por conteúdo em aberto: {brl(k.contentFeesOpenCents)} — categoria separada de comissão por venda (filtre por categoria).</Callout>}

      <TabList<Aba> label="Visões de contas a pagar" value={aba} onChange={(a) => alterar({ aba: a })} items={[{ value: 'pendencias', label: 'Por parceiro e competência' }, { value: 'lotes', label: 'Lotes' }, { value: 'pagamentos', label: 'Pagamentos' }]} />

      {aba === 'pendencias' && (
        <>
          <FiltroDePeriodo
            estado={{ range: valores.range, from: periodo.from, to: periodo.to, dateType: valores.dateType }} tz={tz} tiposDeData={ROTULOS_DATA_PAGAR} ativos={ativos - (valores.aba !== 'pendencias' ? 1 : 0)}
            onChange={(p) => alterar(p)} onLimpar={limpar}
            fim={<span className="ds-toolbar__meta">{plural(total, 'linha')}</span>}
          >
            <Select aria-label="Parceiro" controlSize="sm" value={valores.partnerId} onChange={(e) => alterar({ partnerId: e.target.value })}>
              <option value="">Todos os parceiros</option>{parceiros.map((p) => <option key={p.id} value={p.id}>{p.publicName}</option>)}
            </Select>
            <Select aria-label="Situação" controlSize="sm" value={valores.status} onChange={(e) => alterar({ status: e.target.value })}>
              <option value="">Toda situação</option>{(Object.keys(ROTULOS_STATUS_FINANCEIRO) as StatusFinanceiro[]).map((s) => <option key={s} value={s}>{ROTULOS_STATUS_FINANCEIRO[s]}</option>)}
            </Select>
            <Select aria-label="Modalidade" controlSize="sm" value={valores.modality} onChange={(e) => alterar({ modality: e.target.value })}>
              <option value="">Toda modalidade</option>{(Object.keys(ROTULOS_MODALIDADE) as (keyof typeof ROTULOS_MODALIDADE)[]).map((m) => <option key={m} value={m}>{ROTULOS_MODALIDADE[m]}</option>)}
            </Select>
            <Select aria-label="Categoria" controlSize="sm" value={valores.category} onChange={(e) => alterar({ category: e.target.value })}>
              <option value="">Comissão e cachê</option><option value="commission">Comissão por venda</option><option value="content_fee">Cachê por conteúdo</option>
            </Select>
            <Select aria-label="Forma de pagamento" controlSize="sm" value={valores.method} onChange={(e) => alterar({ method: e.target.value })}>
              <option value="">Toda forma</option>{(Object.keys(ROTULOS_METODO) as (keyof typeof ROTULOS_METODO)[]).map((m) => <option key={m} value={m}>{ROTULOS_METODO[m]}</option>)}
            </Select>
            <Select aria-label="Quitação" controlSize="sm" value={valores.settlement} onChange={(e) => alterar({ settlement: e.target.value })}>
              <option value="">Parcial ou quitado</option><option value="partial">Só parciais</option><option value="settled">Só quitados</option>
            </Select>
            <Checkbox label="Só vencidos" checked={valores.overdue === 'true'} onChange={(e) => alterar({ overdue: e.target.checked ? 'true' : '' })} />
          </FiltroDePeriodo>

          {lista.erro && <ErrorState description={lista.erro} onRetry={lista.recarregar} />}
          {lista.carregando && !lista.dado && <Skeleton variant="table" rows={6} />}
          {lista.dado && lista.dado.itens.length === 0 && (
            <EmptyState title="Nada neste filtro" description="Mude o tipo de data ou o período: cada data (pedido, competência, liberação, previsão, vencimento, pagamento) responde a uma pergunta diferente." action={ativos > 0 ? <Button variant="secondary" onClick={limpar}>Limpar filtros</Button> : undefined} />
          )}
          {lista.dado && lista.dado.itens.length > 0 && (
            <>
              <p className="pa-total">
                <span>Bruta: <strong>{brl(lista.dado.totais.grossCents)}</strong></span><span>Ajustes: <strong>{brl(lista.dado.totais.adjustmentsCents)}</strong></span><span>Liberada: <strong>{brl(lista.dado.totais.releasedCents)}</strong></span>
                <span>Paga: <strong>{brl(lista.dado.totais.paidCents)}</strong></span><span>Em aberto: <strong>{brl(lista.dado.totais.openCents)}</strong></span><span>Previsto: <strong>{brl(lista.dado.totais.forecastCents)}</strong></span>
              </p>
              <DataTable<LinhaAPagar>
                label="Contas a pagar por parceiro e competência" rows={lista.dado.itens} rowKey={(l) => `${l.partnerId}-${l.competence}-${l.category}`}
                sortable sort={{ key: valores.sort, direction: valores.dir === 'desc' ? 'desc' : 'asc' }} onSortChange={(s) => alterar({ sort: s.key, dir: s.direction })}
                columns={[
                  { key: 'partner', label: 'Parceiro', sortValue: (l) => l.partnerName, render: (l) => <Link className="pa-link" to={`/admin/parcerias/parceiros/${l.partnerId}`}>{l.partnerName}</Link> },
                  { key: 'mod', label: 'Modalidade', priority: 'low', render: (l) => l.modalities.map((m) => ROTULOS_MODALIDADE[m]).join(' + ') || '—' },
                  { key: 'competence', label: 'Competência', sortValue: (l) => l.competence, render: (l) => `${competenciaLabel(l.competence.slice(0, 7))}${l.category === 'content_fee' ? ' · cachê' : ''}` },
                  { key: 'q', label: 'Vendas / un.', priority: 'low', align: 'right', render: (l) => `${l.orderCount} / ${l.units}` },
                  { key: 'b', label: 'Receita-base', priority: 'low', align: 'right', render: (l) => brl(l.baseCents) },
                  { key: 'g', label: 'Bruta', priority: 'low', align: 'right', render: (l) => brl(l.grossCents) },
                  { key: 'j', label: 'Ajustes', priority: 'low', align: 'right', render: (l) => brl(l.adjustmentsCents) },
                  { key: 'l', label: 'Liberada', priority: 'low', align: 'right', render: (l) => brl(l.releasedCents) },
                  { key: 'pg', label: 'Já pago', priority: 'low', align: 'right', render: (l) => brl(l.paidCents) },
                  { key: 'open', label: 'Saldo aberto', align: 'right', sortValue: (l) => l.openCents, render: (l) => <strong>{brl(l.openCents)}</strong> },
                  { key: 's', label: 'Situação', render: (l) => <StatusBadge tone={TOM_STATUS_FINANCEIRO[l.status]} label={ROTULOS_STATUS_FINANCEIRO[l.status]} /> },
                  { key: 'estimated', label: 'Data estimada', priority: 'low', align: 'right', sortValue: (l) => l.estimatedAt, render: (l) => dataCurta(l.estimatedAt, tz) },
                  { key: 'due', label: 'Vencimento', align: 'right', sortValue: (l) => l.dueAt, render: (l) => (l.dueAt ? <span>{dataCurta(l.dueAt, tz)}{l.daysOverdue > 0 ? <span className="pa-muted"> · {l.daysOverdue}d em atraso</span> : null}</span> : '—') },
                  { key: 'lastPaid', label: 'Último pagamento', priority: 'low', align: 'right', sortValue: (l) => l.lastPaidAt, render: (l) => dataCurta(l.lastPaidAt, tz) },
                  {
                    key: 'acoes', label: 'Ações', align: 'right',
                    render: (l) => (
                      <span className="pa-badges">
                        {l.openCents > 0 && <Button size="sm" onClick={() => setPagar({ linha: l, partnerId: l.partnerId, nome: l.partnerName, lote: null })}>Registrar pagamento</Button>}
                        {l.openCents > 0 && <Button size="sm" variant="ghost" onClick={() => setFechar({ partnerId: l.partnerId, nome: l.partnerName })}>Fechar lote</Button>}
                        {l.openCents > 0 && <Button size="sm" variant="ghost" onClick={() => { setProrrogar(l); setNovaData(''); }}>Alterar vencimento</Button>}
                      </span>
                    ),
                  },
                ]}
              />
              <Pagination page={pagina} totalPages={totalPaginas} totalLabel={plural(total, 'linha')} onPrev={() => alterar({ page: String(pagina - 1) })} onNext={() => alterar({ page: String(pagina + 1) })} />
            </>
          )}
        </>
      )}
      {aba === 'lotes' && <Card flush><AbaLotes tz={tz} onPagar={async (l) => { setPagar({ linha: null, partnerId: l.partnerId, nome: l.partnerName ?? '', lote: l }); }} /></Card>}
      {aba === 'pagamentos' && <Card flush><AbaPagamentos tz={tz} /></Card>}

      {pagar && <PagamentoDialog open onClose={() => setPagar(null)} partnerId={pagar.partnerId} partnerName={pagar.nome} tz={tz} lote={pagar.lote} onRegistrado={recarregarTudo} />}
      {fechar && <FechamentoDialog open onClose={() => setFechar(null)} partnerId={fechar.partnerId} partnerName={fechar.nome} onCriado={() => alterar({ aba: 'lotes' })} />}
      <ProrrogarDialog linha={prorrogar} novaData={novaData} setNovaData={setNovaData} onClose={() => setProrrogar(null)} onSalvo={recarregarTudo} />
    </PageStack>
  );
}

// Alterar vencimento: sempre com motivo; vale para os lançamentos liberados em aberto do parceiro/competência.
function ProrrogarDialog({ linha, novaData, setNovaData, onClose, onSalvo }: { linha: LinhaAPagar | null; novaData: string; setNovaData: (d: string) => void; onClose: () => void; onSalvo: () => void }) {
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState('');
  useEffect(() => { setMotivo(''); setErro(''); }, [linha]);
  async function salvar() {
    if (!linha) return;
    setEnviando(true); setErro('');
    try {
      const extrato = await afiliados.extrato(linha.partnerId, { limit: 200 });
      const ids = extrato.itens.filter((i) => i.status === 'released' && i.openCents !== 0 && i.competence.slice(0, 7) === linha.competence.slice(0, 7) && i.category === linha.category).map((i) => i.id);
      if (!ids.length) throw new Error('Nenhum lançamento liberado em aberto nesta competência.');
      const r = await afiliados.alterarVencimento({ ledgerIds: ids, dueAt: new Date(`${novaData}T12:00:00-03:00`).toISOString(), reason: motivo.trim() });
      toast(`Vencimento alterado em ${plural(r.alterados, 'lançamento', 'lançamentos')}.`, 'sucesso'); onSalvo(); onClose();
    } catch (e) { setErro(mensagemDoErro(e)); } finally { setEnviando(false); }
  }
  return (
    <Modal open={!!linha} onClose={() => { if (!enviando) onClose(); }} title={`Alterar vencimento · ${linha?.partnerName ?? ''}`} confirmLabel={enviando ? 'Aguarde…' : 'Alterar'} confirmDisabled={enviando || !novaData || !motivo.trim()} onConfirm={salvar} maxWidth={520}>
      <div className="pa-form">
        <p className="pa-aviso">Vale para os lançamentos liberados em aberto desta competência. A recalculação por política não desfaz uma data definida à mão; fica log com antes/depois e motivo.</p>
        <Field label="Novo vencimento" required><Input type="date" value={novaData} onChange={(e) => setNovaData(e.target.value)} /></Field>
        <Field label="Motivo" required><Input value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} /></Field>
        {erro && <Callout tone="danger" role="alert">{erro}</Callout>}
      </div>
    </Modal>
  );
}
