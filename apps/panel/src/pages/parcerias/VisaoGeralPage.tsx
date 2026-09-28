import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, DataTable, EmptyState, ErrorState, KpiCard, KpiStrip, PageHeader, PageStack, Select, Skeleton, StatusBadge } from '../../components/ds';
import { afiliados, type Alerta, type ParceiroDaLista, type TipoDeData } from '../../api/afiliados';
import { useAsync } from '../../lib/useAsync';
import { useFiltrosUrl } from '../../lib/useFiltrosUrl';
import { toast } from '../../lib/toast';
import {
  NIVEIS_ORDEM, ROTULOS_DATA_GERAL, ROTULOS_MODALIDADE, ROTULOS_STATUS_FINANCEIRO, TOM_STATUS_FINANCEIRO, brl, dataCurta, intervaloDoPreset, mensagemDoErro, plural, type PresetDePeriodo,
} from '../../lib/parcerias';
import { FiltroDePeriodo } from './componentes';
import { useParcerias } from './ParceriasLayout';

const PADRAO = { range: '30d', from: '', to: '', dateType: 'order', partnerId: '', modality: '', level: '' };

const ICONE_PESSOAS = '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9" r="2.4"/><path d="M16.5 14.2A5 5 0 0 1 21 19"/>';
const ICONE_DINHEIRO = '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="17" cy="14.5" r="1.4" fill="currentColor" stroke="none"/>';
const ICONE_PEDIDO = '<path d="M6 8h12l-1 12H7L6 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>';
const ICONE_ALERTA = '<path d="M10.3 3.9 2.4 17.5a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>';

function valorOuTraco(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : brl(v);
}

function GraficoDeComissoes({ serie }: { serie: { date: string; cents: number; coupon: number; collab: number }[] }) {
  const max = Math.max(1, ...serie.map((s) => s.cents));
  const total = serie.reduce((s, x) => s + x.cents, 0);
  return (
    <div>
      <div className="pa-legenda">
        <span className="pa-legenda__item pa-legenda__item--collab">Collab</span>
        <span className="pa-legenda__item pa-legenda__item--coupon">Cupom</span>
        <span className="pa-muted">Total no período: {brl(total)}</span>
      </div>
      <div className="pa-serie" role="img" aria-label={`Comissões por dia: total ${brl(total)} em ${serie.length} dias com lançamentos`}>
        {serie.map((s) => (
          <div className="pa-serie__col" key={s.date} title={`${dataCurta(`${s.date}T12:00:00Z`, 'UTC')}: ${brl(s.cents)} (collab ${brl(s.collab)}, cupom ${brl(s.coupon)})`}>
            <div className="pa-serie__bar pa-serie__bar--coupon" style={{ height: `${(Math.max(0, s.coupon) / max) * 100}%` }} />
            <div className="pa-serie__bar pa-serie__bar--collab" style={{ height: `${(Math.max(0, s.collab) / max) * 100}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ListaDeAlertas({ alertas }: { alertas: Alerta[] }) {
  if (!alertas.length) return <EmptyState title="Nenhuma pendência" description="Contratos, cupons, collabs e pagamentos estão em ordem." />;
  return (
    <ul className="pa-alertas">
      {alertas.map((a) => (
        <li key={`${a.kind}-${a.message}`} className={`pa-alertas__item pa-alertas__item--${a.severity}`}>
          <span>{a.message}{a.cents ? ` (${brl(a.cents)})` : ''}</span>
          {a.href && <Link className="pa-link" to={a.href}>Ver</Link>}
        </li>
      ))}
    </ul>
  );
}

export function VisaoGeralPage() {
  const { isOwner, tz } = useParcerias();
  const navigate = useNavigate();
  const { valores, alterar, limpar, ativos } = useFiltrosUrl(PADRAO);
  const [parceiros, setParceiros] = useState<ParceiroDaLista[]>([]);
  const [reconciliando, setReconciliando] = useState(false);

  // Sem from/to na URL, aplica o preset padrão do fuso da loja (o servidor também resolve presets, mas o front mostra as datas).
  const periodo = useMemo(() => {
    if (valores.from && valores.to) return { from: valores.from, to: valores.to };
    const preset = (valores.range || '30d') as PresetDePeriodo;
    return preset === 'custom' ? intervaloDoPreset('30d', tz) : intervaloDoPreset(preset, tz);
  }, [valores.from, valores.to, valores.range, tz]);

  useEffect(() => { afiliados.parceiros({ limit: 100, sort: 'name' }).then((r) => setParceiros(r.itens)).catch(() => undefined); }, []);

  const { dado, erro, carregando, recarregar } = useAsync(
    () => afiliados.visaoGeral({ from: periodo.from, to: periodo.to, dateType: valores.dateType, partnerId: valores.partnerId || undefined, modality: valores.modality || undefined, level: valores.level || undefined }),
    [periodo.from, periodo.to, valores.dateType, valores.partnerId, valores.modality, valores.level],
  );

  async function reconciliar() {
    setReconciliando(true);
    try {
      const r = await afiliados.reconciliar({});
      toast(`Reconciliação: ${r.pedidosAvaliados} pedidos avaliados, ${r.criadas} atribuições novas, ${r.promovidos} liberações${r.truncado ? ' (lote parcial — rode de novo)' : ''}.`, 'sucesso');
      recarregar();
    } catch (e) { toast(mensagemDoErro(e)); } finally { setReconciliando(false); }
  }

  const k = dado?.kpis;
  const qsAPagar = new URLSearchParams({ dateType: valores.dateType === 'order' ? 'sale' : valores.dateType, from: periodo.from, to: periodo.to, range: 'custom' }).toString();

  return (
    <PageStack>
      <PageHeader
        title="Parcerias e Afiliados"
        description="Cupons, collabs por estampa e o que você deve pagar — tudo apurado por item, com o cálculo à mostra."
        actions={isOwner ? <Button variant="secondary" onClick={reconciliar} disabled={reconciliando}>{reconciliando ? 'Reconciliando…' : 'Reconciliar pedidos agora'}</Button> : undefined}
      />

      <FiltroDePeriodo
        estado={{ range: valores.range, from: periodo.from, to: periodo.to, dateType: valores.dateType }} tz={tz} tiposDeData={ROTULOS_DATA_GERAL} ativos={ativos}
        onChange={(p) => alterar(p)} onLimpar={limpar}
      >
        <Select aria-label="Parceiro" controlSize="sm" value={valores.partnerId} onChange={(e) => alterar({ partnerId: e.target.value })}>
          <option value="">Todos os parceiros</option>
          {parceiros.map((p) => <option key={p.id} value={p.id}>{p.publicName}</option>)}
        </Select>
        <Select aria-label="Modalidade" controlSize="sm" value={valores.modality} onChange={(e) => alterar({ modality: e.target.value })}>
          <option value="">Todas as modalidades</option>
          {(Object.keys(ROTULOS_MODALIDADE) as (keyof typeof ROTULOS_MODALIDADE)[]).map((m) => <option key={m} value={m}>{ROTULOS_MODALIDADE[m]}</option>)}
        </Select>
        <Select aria-label="Nível" controlSize="sm" value={valores.level} onChange={(e) => alterar({ level: e.target.value })}>
          <option value="">Todos os níveis</option>
          {NIVEIS_ORDEM.map((n) => <option key={n} value={n}>{n.charAt(0).toUpperCase() + n.slice(1)}</option>)}
        </Select>
      </FiltroDePeriodo>

      {erro && <ErrorState description={erro} onRetry={recarregar} />}
      {carregando && !dado && <Skeleton variant="table" rows={4} />}

      {dado && k && (
        <>
          <KpiStrip label="Indicadores de parcerias">
            <KpiCard title="Parceiros ativos" value={String(k.activePartners)} icon={ICONE_PESSOAS} helper={`${plural(k.pendingCandidates, 'candidato pendente', 'candidatos pendentes')}`} />
            <KpiCard title="Receita líquida atribuída" value={brl(k.attributedNetRevenueCents)} icon={ICONE_DINHEIRO} helper="não é receita incremental" info={dado.definicoes.attributedNetRevenue} />
            <KpiCard title="Pedidos válidos" value={String(k.validOrders)} icon={ICONE_PEDIDO} helper="pagos ou entregues" />
            <KpiCard title="Unidades de collab" value={String(k.collabUnits)} icon={ICONE_PEDIDO} helper="itens vendidos da arte" />
            <KpiCard title="Divergências de integração" value={String(k.integrationDivergences)} icon={ICONE_ALERTA} helper="cupom/pedido em revisão" />
          </KpiStrip>
          {isOwner && (
            <KpiStrip label="Indicadores financeiros">
              <KpiCard title="Comissão provisionada" value={valorOuTraco(k.forecastCommissionCents)} helper="ainda não liberada" info={dado.definicoes.forecast} />
              <KpiCard title="Comissão liberada" value={valorOuTraco(k.releasedCommissionCents)} helper="pagável, no filtro" />
              <KpiCard title="Total a pagar" value={valorOuTraco(k.payableCents)} helper="liberado e em aberto" />
              <KpiCard title="Vencido" value={valorOuTraco(k.overdueCents)} helper="liberado com prazo vencido" />
              <KpiCard title="Próximo ciclo (30 dias)" value={valorOuTraco(k.nextCycleCents)} helper="previsão, não dívida" />
              <KpiCard title="Pago no período" value={valorOuTraco(k.paidInPeriodCents)} helper="data efetiva do pagamento" info={dado.definicoes.paid} />
              <KpiCard title="Benefícios usados" value={valorOuTraco(k.benefitsUsedCents)} helper="peças concedidas" />
            </KpiStrip>
          )}

          <div className="pa-grid pa-grid--7-5">
            {isOwner ? (
              <Card title="Comissões por dia" description={`Por ${ROTULOS_DATA_GERAL[dado.period.dateType as TipoDeData].toLowerCase()} · ${dado.period.timezone}`}>
                {dado.series.length ? <GraficoDeComissoes serie={dado.series} /> : <EmptyState title="Sem lançamentos no período" description="Cadastre parceiros, ative cupons e collabs e reconcilie os pedidos." />}
              </Card>
            ) : (
              <Card title="Comissões" description="Valores financeiros ficam com o owner da loja.">
                <EmptyState title="Sem acesso a valores" description="Você acompanha parceiros, collabs e vendas atribuídas." />
              </Card>
            )}
            <Card title="Pendências" description="O que precisa de uma decisão sua.">
              <ListaDeAlertas alertas={dado.alerts} />
            </Card>
          </div>

          {isOwner && (
            <Card flush title="Próximos vencimentos" description="Saldos em aberto por parceiro e competência." action={<Link className="pa-link" to={`/admin/parcerias/a-pagar?${qsAPagar}`}>Abrir contas a pagar</Link>}>
              {dado.upcoming.length ? (
                <DataTable
                  label="Próximos vencimentos" rows={dado.upcoming} rowKey={(r) => `${r.partnerId}-${r.competence}`} onRowClick={(r) => navigate(`/admin/parcerias/parceiros/${r.partnerId}`)}
                  columns={[
                    { key: 'p', label: 'Parceiro', render: (r) => r.partnerName },
                    { key: 'c', label: 'Competência', priority: 'low', render: (r) => r.competence.slice(0, 7) },
                    { key: 'a', label: 'Em aberto', align: 'right', render: (r) => brl(r.openCents) },
                    { key: 'f', label: 'Previsto', align: 'right', priority: 'low', render: (r) => brl(r.forecastCents) },
                    { key: 'd', label: 'Vencimento', align: 'right', render: (r) => (r.dueAt ? dataCurta(r.dueAt, tz) : r.estimatedAt ? `prev. ${dataCurta(r.estimatedAt, tz)}` : '—') },
                    { key: 's', label: 'Situação', render: (r) => <StatusBadge tone={TOM_STATUS_FINANCEIRO[r.status as keyof typeof TOM_STATUS_FINANCEIRO] ?? 'neutral'} label={ROTULOS_STATUS_FINANCEIRO[r.status as keyof typeof ROTULOS_STATUS_FINANCEIRO] ?? r.status} /> },
                  ]}
                />
              ) : <EmptyState title="Nada a vencer" description="Quando houver comissão liberada ou prevista, ela aparece aqui." />}
            </Card>
          )}
        </>
      )}
    </PageStack>
  );
}
