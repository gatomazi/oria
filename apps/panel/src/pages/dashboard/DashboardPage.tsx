import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, Card, DataTable, EmptyState, ErrorState, Icon, InfoTooltip, KpiCard, KpiStrip, PageHeader, PageStack, Skeleton, StatusBadge } from '../../components/ds';
import { copiar, formatValor, plural, tempoDesde, waLink } from '../../lib/format';
import { useLojaAtiva } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import {
  getDashboardAbandonedCarts,
  getDashboardFinanceiro,
  getDashboardOrders,
  getDashboardRecuperacaoResumo,
  vincularPedidoInk,
  type DashboardCarrinho,
  type DashboardFinanceiroData,
  type DashboardOrdersData,
  type FinanceiroDia,
  type DashboardPedido,
  type RecuperacaoResumo,
} from '../../api/dashboard';
import { getIntegrations, type IntegrationsData } from '../../api/integracoes';
import { lookup, ORDER_STATUS_MAP } from '../../lib/statusMap';
import { DashboardPeriodSelect } from './DashboardPeriodSelect';
import { LucroProdutosCard } from './LucroProdutosCard';
import { OrdersRevenueChart } from './charts/OrdersRevenueChart';
import { OrderStatusDonut } from './charts/OrderStatusDonut';
import { RecoveryChart } from './charts/RecoveryChart';
import { WeekdayHourlyChart } from './charts/WeekdayHourlyChart';
import {
  ESTAGIOS_PIPELINE,
  PERIODO_PADRAO,
  calcularDelta,
  diasAtrasISO,
  diasDoPeriodo,
  hojeISO,
  pedidosDoDia,
  pedidosDoDiaAteHora,
  pedidosNoPeriodo,
  resultadoFinanceiro,
  serieDiaSemana,
  serieFinanceiraDiaria,
  serieLucroOperacional,
  serieDiaria,
  serieHorario,
  serieRecuperacao,
  serieStatus,
  somaValor,
  tomDoEstagio,
  type PeriodoId,
  type MidiaDia,
  formatDataHoraCurta,
} from './dashboardData';

import '../../dashboard.css';
import '../../pedidos-central.css';

// Porte de src/dashboard.js — reconstruído (docs/claude-dashboard-visual-graficos.md) como
// dashboard operacional com gráficos reais, mantendo tudo que já existia (vincular Pix,
// copiar link, health de integrações) e sem tocar em nenhuma outra página.

function porEscopo<T extends { loja: string }>(lista: T[], escopo: string): T[] {
  return lista.filter((item) => item.loja === escopo);
}

interface Fetched<T> {
  data: T | null;
  erro: string;
}

// Fila de atenção: um Callout por assunto, na ordem de urgência. O CTA leva pra tela que resolve.
function AttentionBanner({ carrinhos, pedidosProblema, errosIntegracao }: { carrinhos: DashboardCarrinho[]; pedidosProblema: number; errosIntegracao: number }) {
  const recuperaveis = carrinhos.filter((c) => c.contactable).length;
  const avisos: { tom: 'warning' | 'danger'; titulo: string; descricao: string; href: string; cta: string }[] = [];
  if (errosIntegracao > 0) {
    avisos.push({
      tom: 'danger',
      titulo: `${plural(errosIntegracao, 'loja', 'lojas')} com falha ao consultar a Reserva Ink agora`,
      descricao: 'Os números desta tela podem estar incompletos enquanto isso persistir.',
      href: '/admin/integracoes',
      cta: 'Ver integrações',
    });
  }
  if (pedidosProblema > 0) {
    avisos.push({
      tom: 'warning',
      titulo: `${plural(pedidosProblema, 'pedido', 'pedidos')} com problema de pagamento`,
      descricao: 'Reembolso, expiração ou recusa — vale conferir antes que o cliente pergunte.',
      href: '/admin/pedidos-central',
      cta: 'Ver pedidos',
    });
  }
  if (recuperaveis > 0) {
    avisos.push({
      tom: 'warning',
      titulo: `${plural(recuperaveis, 'carrinho recuperável', 'carrinhos recuperáveis')}`,
      descricao: 'Clientes que demonstraram interesse e podem ser recuperados via WhatsApp.',
      href: '/admin/recuperacao',
      cta: 'Ver carrinhos',
    });
  }
  if (!avisos.length) return null;

  return (
    <div className="ds-stack">
      {avisos.map((av) => (
        <Callout
          key={av.href}
          tone={av.tom}
          title={av.titulo}
          action={
            <Link className="ds-btn ds-btn--secondary ds-btn--sm" to={av.href}>
              {av.cta}
            </Link>
          }
        >
          {av.descricao}
        </Callout>
      ))}
    </div>
  );
}

function Kpis({
  pedidosHoje,
  pedidosOntem,
  carrinhos,
  pedidosProblema,
  recuperacao,
  sparklinePedidos,
  sparklineReceita,
}: {
  pedidosHoje: DashboardPedido[];
  pedidosOntem: DashboardPedido[];
  carrinhos: DashboardCarrinho[];
  pedidosProblema: number;
  recuperacao: RecuperacaoResumo | null;
  sparklinePedidos: number[];
  sparklineReceita: number[];
}) {
  const deltaPedidos = calcularDelta(pedidosHoje.length, pedidosOntem.length);
  const receitaHoje = somaValor(pedidosHoje);
  const receitaOntem = somaValor(pedidosOntem);
  const deltaReceita = calcularDelta(receitaHoje, receitaOntem);
  const recuperaveis = carrinhos.filter((c) => c.contactable).length;
  const taxaRecuperacao = recuperacao && recuperacao.taxaConversao != null ? `${Math.round(recuperacao.taxaConversao * 100)}%` : '—';

  return (
    <KpiStrip label="Indicadores de hoje">
      <KpiCard
        title="Pedidos hoje"
        value={pedidosHoje.length}
        delta={deltaPedidos?.delta}
        trend={deltaPedidos?.trend}
        helper={deltaPedidos ? 'vs. ontem até esta hora' : undefined}
        sparkline={sparklinePedidos}
      />
      <KpiCard
        title="Receita estimada hoje"
        value={formatValor(receitaHoje) || 'R$ 0,00'}
        delta={deltaReceita?.delta}
        trend={deltaReceita?.trend}
        helper={deltaReceita ? 'vs. ontem até esta hora' : undefined}
        sparkline={sparklineReceita}
      />
      <KpiCard title="Carrinhos recuperáveis" value={recuperaveis} helper="Com contato disponível agora" />
      <KpiCard
        title="Taxa de recuperação"
        value={taxaRecuperacao}
        helper={
          recuperacao && recuperacao.carrinhosTentados > 0
            ? `${recuperacao.carrinhosConvertidos} de ${plural(recuperacao.carrinhosTentados, 'tentativa', 'tentativas')}`
            : 'Ainda sem tentativa registrada'
        }
      />
      <KpiCard
        title="Pedidos com atenção"
        value={pedidosProblema}
        helper={pedidosProblema ? 'Reembolso, expiração ou recusa' : 'Nenhum problema agora'}
      />
    </KpiStrip>
  );
}

function formatPercentual(parte: number, todo: number): string | null {
  if (todo <= 0) return null;
  return `${Math.round((parte / todo) * 100)}%`;
}

// Resultado do período no modelo do painel da Reserva Ink: faturamento (o que o cliente pagou),
// lucro bruto (sem frete, já com todo desconto, que é sempre do lojista), custo de produção (o que a
// Ink retém por peça) e lucro operacional (o que sobra pra loja). Só pedido pago e sem troca.
function ResultadoPeriodo({
  linhas,
  midia,
  erro,
  periodo,
  dias,
}: {
  linhas: FinanceiroDia[] | null;
  midia: MidiaDia[];
  erro: string;
  periodo: PeriodoId;
  dias: number;
}) {
  const hoje = hojeISO();
  const atual = useMemo(
    () => (linhas ? resultadoFinanceiro(linhas, diasAtrasISO(hoje, dias - 1), hoje, midia) : null),
    [linhas, hoje, dias, midia]
  );
  const anterior = useMemo(
    () => (linhas ? resultadoFinanceiro(linhas, diasAtrasISO(hoje, dias * 2 - 1), diasAtrasISO(hoje, dias), midia) : null),
    [linhas, hoje, dias, midia]
  );
  const sparkline = useMemo(
    () => (linhas ? serieLucroOperacional(linhas, Math.max(dias, 7), midia) : []),
    [linhas, dias, midia]
  );

  if (erro) {
    return <Callout tone="info" title="Resultado financeiro indisponível">{erro}</Callout>;
  }
  if (!atual || !anterior) return <Skeleton rows={1} height="112px" />;

  // Delta só contra um período anterior completo: "hoje" parcial x ontem inteiro sempre "cai", e
  // período anterior com pedido ainda sem custo calculado daria uma variação que não existe.
  const comparavel = periodo !== 'hoje' && anterior.semFinanceiro === 0;
  const deltaFaturamento = comparavel ? calcularDelta(atual.faturamento, anterior.faturamento) : null;
  const deltaLucro = comparavel ? calcularDelta(atual.lucroAposMidia, anterior.lucroAposMidia) : null;
  const rotuloPeriodo = periodo === 'hoje' ? 'hoje' : `${dias} dias`;
  // Margem sobre o FATURAMENTO, não sobre o lucro bruto: "margem de 51%" lida contra a receita é o
  // número que as pessoas comparam entre si, e é assim que a DRE do Meta Ads também calcula.
  const margem = formatPercentual(atual.lucroAposMidia, atual.faturamento);
  const temMidia = atual.midia > 0;
  const pesoCusto = formatPercentual(atual.custoProducao, atual.lucroBruto);

  return (
    <div className="ds-stack">
      {atual.semFinanceiro > 0 && (
        <Callout
          tone="warning"
          title={`${plural(atual.semFinanceiro, 'pedido pago', 'pedidos pagos')} do período ainda sem custo de produção`}
          action={
            <Link className="ds-btn ds-btn--secondary ds-btn--sm" to="/admin/integracoes">
              Rodar backfill
            </Link>
          }
        >
          Ficam fora do faturamento e do lucro abaixo até o sync de hora em hora ou o backfill de pedidos passar por eles.
        </Callout>
      )}
      <KpiStrip label="Resultado do período">
        <KpiCard
          title="Faturamento"
          value={formatValor(atual.faturamento) || 'R$ 0,00'}
          delta={deltaFaturamento?.delta}
          trend={deltaFaturamento?.trend}
          helper={`${plural(atual.pedidos, 'pedido pago', 'pedidos pagos')} · ${rotuloPeriodo}`}
        />
        <KpiCard title="Lucro bruto" value={formatValor(atual.lucroBruto) || 'R$ 0,00'} helper="Sem frete, já com descontos" />
        <KpiCard
          title="Custo de produção"
          value={formatValor(atual.custoProducao) || 'R$ 0,00'}
          helper={pesoCusto ? `${pesoCusto} do lucro bruto` : 'Retido pela Reserva Ink'}
        />
        {/* Mídia só aparece quando existe conta de anúncios atribuída a alguma loja do escopo —
            um card zerado sugeriria que a operação não investe, o que é diferente de "o painel não
            sabe quanto foi investido". */}
        {temMidia && (
          <KpiCard
            title="Mídia"
            value={formatValor(atual.midia) || 'R$ 0,00'}
            helper="Gasto real nas plataformas"
          />
        )}
        <KpiCard
          title={temMidia ? 'Lucro após mídia' : 'Lucro do produto'}
          value={formatValor(temMidia ? atual.lucroAposMidia : atual.lucroOperacional) || 'R$ 0,00'}
          delta={deltaLucro?.delta}
          trend={deltaLucro?.trend}
          helper={
            temMidia
              ? (margem ? `Margem de ${margem} sobre o faturamento` : 'Lucro do produto − mídia')
              : 'Venda menos custo de produção'
          }
          sparkline={sparkline.slice(-7)}
        />
      </KpiStrip>
    </div>
  );
}

// Fluxo: contagem por estágio, lado a lado, em números tabulares. A cor do estágio fica só no
// traço superior (mesmo tom do donut), sem bolhas coloridas.
function OrderFlow({ pedidos }: { pedidos: DashboardPedido[] }) {
  const total = pedidos.length;
  const contagens = ESTAGIOS_PIPELINE.map((e) => pedidos.filter((p) => p.orderStatus && e.statuses.includes(p.orderStatus)).length);
  if (!total) return null;
  return (
    <Card title="Fluxo de pedidos">
      <ol className="ad-flow-row">
        {ESTAGIOS_PIPELINE.map((estagio, i) => (
          <li className="ad-flow-item" key={estagio.key} style={{ ['--estagio-cor' as string]: estagio.color, ['--estagio-opacidade' as string]: String(estagio.opacidade) }}>
            <span className="ad-flow-label">{estagio.label}</span>
            <span className="ad-flow-valor">{contagens[i].toLocaleString('pt-BR')}</span>
            <span className="ad-flow-pct">{Math.round((contagens[i] / total) * 100)}%</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function IntegrationHealth({ erros, escopo, integracoes }: { erros: { loja: string }[]; escopo: string; integracoes: IntegrationsData | null }) {
  const lojas = [adminStores.get(escopo)].filter(Boolean);
  return (
    <Card title="Canais e integrações">
      <ul className="ad-saude-lista">
        {lojas.map((loja) => {
          if (!loja) return null;
          const temErro = erros.some((e) => e.loja === loja.id);
          return (
            <li className="ad-saude-item" key={loja.id}>
              <span className={`ad-status-dot ad-status-dot--${temErro ? 'erro' : 'ok'}`} />
              <span>Reserva Ink · {loja.name}</span>
              <span className="ad-saude-status">{temErro ? 'Atenção' : 'OK'}</span>
            </li>
          );
        })}
        {integracoes && (
          <>
            <li className="ad-saude-item">
              <span className={`ad-status-dot ad-status-dot--${integracoes.whatsapp.conectado ? 'ok' : 'erro'}`} />
              <span>WhatsApp</span>
              <span className="ad-saude-status">{integracoes.whatsapp.conectado ? 'Conectado' : 'Não conectado'}</span>
            </li>
            <li className="ad-saude-item">
              <span className="ad-status-dot ad-status-dot--pendente" />
              <span>Instagram</span>
              <span className="ad-saude-status">Não conectado</span>
            </li>
          </>
        )}
      </ul>
    </Card>
  );
}

function HotCartsList({ carrinhos }: { carrinhos: DashboardCarrinho[] }) {
  const quentes = carrinhos
    .filter((c) => c.contactable)
    .slice()
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .slice(0, 5);

  return (
    <Card
      title="Carrinhos quentes"
      action={
        <Link to="/admin/recuperacao" className="ds-btn ds-btn--ghost ds-btn--sm">
          Ver todos
        </Link>
      }
    >
      {!quentes.length ? (
        <EmptyState title="Nenhum carrinho recuperável agora" description="Quando um cliente abandonar o carrinho com contato disponível, ele aparece aqui." />
      ) : (
        <ul className="ad-hotcarts">
          {quentes.map((c, i) => {
            const tempo = tempoDesde(c.updatedAt);
            const primeiroNome = c.buyerName ? c.buyerName.split(' ')[0] : '';
            const mensagem = `Olá${primeiroNome ? ' ' + primeiroNome : ''}! Vi que você deixou ${c.itemsCount || 'alguns'} item(ns) no carrinho. Posso te ajudar a finalizar a compra? 😊`;
            const link = waLink(c.buyerPhone, mensagem);
            return (
              <li className="ad-hotcart-row" key={i}>
                <div className="ad-hotcart-info">
                  <strong>{c.buyerName || 'Cliente sem nome'}</strong>
                  <span>
                    {adminStores.name(c.loja)} · {plural(c.itemsCount || 0, 'item', 'itens')}
                    {tempo ? ` · há ${tempo.texto}` : ''}
                  </span>
                </div>
                <span className="ad-hotcart-valor">{formatValor(c.valor) || '—'}</span>
                {link && (
                  <a
                    href={link}
                    target="_blank"
                    rel="noopener"
                    className="ds-btn ds-btn--secondary ds-btn--sm ad-hotcart-btn"
                    aria-label={`Enviar WhatsApp para ${c.buyerName || 'o cliente'} (abre em nova aba)`}
                  >
                    <Icon name="phone" size={14} />
                    WhatsApp
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function AcaoPedido({ pedido, onVinculado }: { pedido: DashboardPedido; onVinculado: (hotpageId: string) => void }) {
  const [copiado, setCopiado] = useState(false);
  const [vinculando, setVinculando] = useState(false);
  const [erro, setErro] = useState('');

  if (pedido.hotpageId) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={(ev) => {
          ev.stopPropagation();
          copiar(window.location.origin + '/' + pedido.hotpageId, () => {
            setCopiado(true);
            setTimeout(() => setCopiado(false), 1800);
          });
        }}
      >
        {copiado ? 'Copiado!' : 'Copiar link'}
      </Button>
    );
  }

  if (!pedido.temPixPendente || pedido.inkOrderId == null) return null;

  return (
    <div>
      <Button
        variant="secondary"
        size="sm"
        disabled={vinculando}
        onClick={(ev) => {
          ev.stopPropagation();
          setErro('');
          setVinculando(true);
          vincularPedidoInk(pedido.inkOrderId!)
            .then((data) => {
              onVinculado(data.id);
              copiar(window.location.origin + data.url, () => {
                setVinculando(false);
              });
            })
            .catch((err: Error) => {
              setErro(err.message);
              setVinculando(false);
            });
        }}
      >
        Vincular
      </Button>
      {erro && <div className="ds-form-error">{erro}</div>}
    </div>
  );
}

function RecentOrdersTable({ pedidos, mostrarLoja, onVinculado }: { pedidos: DashboardPedido[]; mostrarLoja: boolean; onVinculado: (index: number, hotpageId: string) => void }) {
  const visiveis = pedidos.slice(0, 8);
  return (
    <Card
      title="Últimos pedidos"
      flush
      action={
        <Link to="/admin/pedidos-central" className="ds-btn ds-btn--ghost ds-btn--sm">
          Ver todos
        </Link>
      }
    >
      {!visiveis.length ? (
        <EmptyState title="Nenhum pedido encontrado" />
      ) : (
        <DataTable
          label="Últimos pedidos"
          rows={visiveis}
          rowKey={(_, i) => i}
          sortable={false}
          columns={[
            ...(mostrarLoja ? [{ key: 'loja', label: 'Loja', muted: true, render: (p: DashboardPedido) => adminStores.name(p.loja) }] : []),
            { key: 'cliente', label: 'Cliente', truncate: true, width: mostrarLoja ? 150 : 200, render: (p) => p.cliente || '—' },
            { key: 'valor', label: 'Valor', align: 'right', render: (p) => formatValor(p.valor) || '—' },
            {
              key: 'status',
              label: 'Status',
              render: (p) => {
                // Cor pelo estágio do pedido (o que o texto do badge realmente diz) — problema de
                // pagamento sempre prevalece (some sobre a cor do estágio), já que é o mais urgente.
                const tone = p.paymentBucket === 'problema' ? 'danger' : tomDoEstagio(p.orderStatus);
                return <StatusBadge tone={tone} label={lookup(ORDER_STATUS_MAP, p.orderStatus, p.orderStatusLabel || p.paymentStatus || '—').label} />;
              },
            },
            { key: 'data', priority: 'low', label: 'Criado em', align: 'right', muted: true, render: (p) => formatDataHoraCurta(p.createdAt) },
            {
              key: 'acao',
              label: 'Ações',
              hideLabel: true,
              align: 'right',
              render: (p) => {
                const i = pedidos.indexOf(p);
                return <AcaoPedido pedido={p} onVinculado={(hotpageId) => onVinculado(i, hotpageId)} />;
              },
            },
          ]}
        />
      )}
    </Card>
  );
}

export function DashboardPage() {
  const escopo = useLojaAtiva() ?? '';
  const [periodo, setPeriodo] = useState<PeriodoId>(PERIODO_PADRAO);
  const [pedidos, setPedidos] = useState<Fetched<DashboardOrdersData>>({ data: null, erro: '' });
  const [carrinhos, setCarrinhos] = useState<Fetched<{ carrinhos: DashboardCarrinho[]; erros: { loja: string; error: string }[] }>>({ data: null, erro: '' });
  const [integracoes, setIntegracoes] = useState<IntegrationsData | null>(null);
  const [recuperacao, setRecuperacao] = useState<Fetched<RecuperacaoResumo>>({ data: null, erro: '' });
  const [financeiro, setFinanceiro] = useState<Fetched<DashboardFinanceiroData>>({ data: null, erro: '' });

  useEffect(() => {
    getDashboardOrders(90)
      .then((data) => setPedidos({ data, erro: '' }))
      .catch((err: Error) => setPedidos({ data: null, erro: err.message }));
    // 180 dias: cobre o maior período do seletor (90d) e o período anterior do mesmo tamanho.
    getDashboardFinanceiro(180)
      .then((data) => setFinanceiro({ data, erro: '' }))
      .catch((err: Error) => setFinanceiro({ data: null, erro: err.message }));
    getDashboardAbandonedCarts()
      .then((data) => setCarrinhos({ data, erro: '' }))
      .catch((err: Error) => setCarrinhos({ data: null, erro: err.message }));
    getIntegrations()
      .then(setIntegracoes)
      .catch(() => setIntegracoes(null));
  }, []);

  useEffect(() => {
    getDashboardRecuperacaoResumo()
      .then((data) => setRecuperacao({ data, erro: '' }))
      .catch((err: Error) => setRecuperacao({ data: null, erro: err.message }));
  }, [escopo]);

  const dias = diasDoPeriodo(periodo);

  const todosPedidos = useMemo(() => porEscopo(pedidos.data?.pedidos || [], escopo), [pedidos.data, escopo]);
  const todosCarrinhos = useMemo(() => porEscopo(carrinhos.data?.carrinhos || [], escopo), [carrinhos.data, escopo]);
  const linhasFinanceiro = useMemo(() => (financeiro.data ? porEscopo(financeiro.data.linhas, escopo) : null), [financeiro.data, escopo]);
  // Mídia passa pelo MESMO filtro de loja do financeiro: filtrar o painel por uma loja e continuar
  // descontando a mídia de todas mostraria um prejuízo que não existe.
  const midiaFinanceiro = useMemo(() => porEscopo(financeiro.data?.midia || [], escopo), [financeiro.data, escopo]);
  let erros = (pedidos.data?.erros || []).concat(carrinhos.data?.erros || []);
  erros = erros.filter((e) => e.loja === escopo);

  const pedidosPeriodo = useMemo(() => pedidosNoPeriodo(todosPedidos, dias), [todosPedidos, dias]);
  const hoje = hojeISO();
  const ontem = diasAtrasISO(hoje, 1);
  const agoraHM = new Date().toTimeString().slice(0, 5);
  const pedidosHoje = useMemo(() => pedidosDoDia(todosPedidos, hoje), [todosPedidos, hoje]);
  // "Ontem até agora" (mesma janela parcial de hoje), não o dia de ontem inteiro — ver
  // pedidosDoDiaAteHora: comparar hoje-parcial com ontem-inteiro é injusto (sempre "cai").
  const pedidosOntem = useMemo(() => pedidosDoDiaAteHora(todosPedidos, ontem, agoraHM), [todosPedidos, ontem, agoraHM]);
  const pedidosProblema = useMemo(() => todosPedidos.filter((p) => p.paymentBucket === 'problema').length, [todosPedidos]);

  const serieDiariaCompleta = useMemo(() => serieDiaria(todosPedidos, Math.max(dias, 7)), [todosPedidos, dias]);
  const seriePeriodo = useMemo(() => serieDiaria(pedidosPeriodo, dias), [pedidosPeriodo, dias]);
  // Com o cache financeiro disponível o gráfico principal lê dele (período completo, com lucro); sem
  // Postgres, cai pra série da lista da Ink, como sempre foi.
  const serieFinanceira = useMemo(() => (linhasFinanceiro ? serieFinanceiraDiaria(linhasFinanceiro, dias) : null), [linhasFinanceiro, dias]);
  const sparklinePedidos = useMemo(() => serieDiariaCompleta.slice(-7).map((d) => d.pedidos), [serieDiariaCompleta]);
  const sparklineReceita = useMemo(() => serieDiariaCompleta.slice(-7).map((d) => d.receita), [serieDiariaCompleta]);

  const statusPeriodo = useMemo(() => serieStatus(pedidosPeriodo), [pedidosPeriodo]);
  const weekdaySerie = useMemo(() => serieDiaSemana(pedidosPeriodo), [pedidosPeriodo]);
  const hourlySerie = useMemo(() => serieHorario(pedidosPeriodo), [pedidosPeriodo]);
  const recoverySerie = useMemo(() => (recuperacao.data ? serieRecuperacao(recuperacao.data.porDia, dias) : []), [recuperacao.data, dias]);

  function marcarVinculado(indexNoEscopo: number, hotpageId: string) {
    const pedidoAlvo = todosPedidos[indexNoEscopo];
    setPedidos((prev) => {
      if (!prev.data) return prev;
      return { ...prev, data: { ...prev.data, pedidos: prev.data.pedidos.map((p) => (p === pedidoAlvo ? { ...p, hotpageId } : p)) } };
    });
  }

  const carregando = !pedidos.data && !pedidos.erro && !carrinhos.data && !carrinhos.erro;
  const lacuna = pedidos.data?.lojasComLacuna || [];

  return (
    <PageStack>
      <PageHeader
        title="Visão geral"
        description="Resumo da operação da sua loja em tempo real."
        actions={<DashboardPeriodSelect value={periodo} onChange={setPeriodo} />}
      />

      {carregando && (
        <>
          <Skeleton rows={1} height="112px" />
          <div className="ad-analytic-grid">
            <Skeleton rows={1} height="320px" />
            <Skeleton rows={1} height="320px" />
            <Skeleton rows={1} height="320px" />
          </div>
        </>
      )}

      {!carregando && pedidos.erro && carrinhos.erro && <ErrorState description="Não foi possível carregar os dados da visão geral." />}

      {!carregando && !(pedidos.erro && carrinhos.erro) && (
        <>
          <AttentionBanner carrinhos={todosCarrinhos} pedidosProblema={pedidosProblema} errosIntegracao={erros.length} />

          <Kpis
            pedidosHoje={pedidosHoje}
            pedidosOntem={pedidosOntem}
            carrinhos={todosCarrinhos}
            pedidosProblema={pedidosProblema}
            recuperacao={recuperacao.data}
            sparklinePedidos={sparklinePedidos}
            sparklineReceita={sparklineReceita}
          />

          <ResultadoPeriodo linhas={linhasFinanceiro} midia={midiaFinanceiro} erro={financeiro.erro} periodo={periodo} dias={dias} />

          <div className="ad-analytic-grid">
            <Card
              title={
                serieFinanceira
                  ? `Faturamento e lucro — ${dias === 1 ? 'hoje' : `últimos ${dias} dias`}`
                  : `Pedidos e receita — ${dias === 1 ? 'hoje' : `últimos ${dias} dias`}`
              }
              className="ad-analytic-grid__principal"
              action={
                <div className="ad-chart-legenda">
                  <span className="ad-chart-legenda__item ad-chart-legenda__item--barra">{serieFinanceira ? 'Pedidos pagos' : 'Pedidos'}</span>
                  <span className="ad-chart-legenda__item ad-chart-legenda__item--linha">{serieFinanceira ? 'Faturamento' : 'Receita'}</span>
                  {serieFinanceira && <span className="ad-chart-legenda__item ad-chart-legenda__item--lucro">Lucro operacional</span>}
                  {!serieFinanceira && !!lacuna.length && (
                    <InfoTooltip
                      content={`${lacuna.map((l) => adminStores.name(l)).join(', ')}: volume alto no período. O gráfico usa os pedidos mais recentes e pode faltar dado no meio (a Reserva Ink entrega no máximo 100 pedidos por página).`}
                    />
                  )}
                </div>
              }
            >
              {serieFinanceira ? (
                !serieFinanceira.some((d) => d.pedidos > 0) ? (
                  <EmptyState title="Ainda não há pedidos pagos neste período" />
                ) : (
                  <OrdersRevenueChart dados={serieFinanceira} />
                )
              ) : pedidos.erro ? (
                <ErrorState description="Não foi possível carregar pedidos." />
              ) : !seriePeriodo.some((d) => d.pedidos > 0) ? (
                <EmptyState title="Ainda não há dados suficientes neste período" />
              ) : (
                <OrdersRevenueChart dados={seriePeriodo} />
              )}
            </Card>

            <Card title="Status dos pedidos" className="ad-analytic-grid__status">
              {pedidos.erro ? (
                <ErrorState description="Não foi possível carregar status." />
              ) : !pedidosPeriodo.length ? (
                <EmptyState title="Sem pedidos neste período" />
              ) : (
                <OrderStatusDonut dados={statusPeriodo} />
              )}
            </Card>

            <Card title="Recuperação via WhatsApp" className="ad-analytic-grid__recuperacao">
              {recuperacao.erro ? (
                <ErrorState description="Não foi possível carregar recuperação." />
              ) : !recuperacao.data ? (
                <Skeleton rows={2} />
              ) : recuperacao.data.mensagensEnviadas === 0 ? (
                <EmptyState title="Ainda não há mensagens de recuperação registradas" />
              ) : (
                <div className="ad-recuperacao">
                  <dl className="ad-recuperacao-numeros">
                    <div>
                      <dt>Mensagens enviadas</dt>
                      <dd>{recuperacao.data.mensagensEnviadas.toLocaleString('pt-BR')}</dd>
                    </div>
                    {recuperacao.data.taxaConversao != null && (
                      <div>
                        <dt>Taxa de conversão</dt>
                        <dd>{Math.round(recuperacao.data.taxaConversao * 100)}%</dd>
                      </div>
                    )}
                    <div>
                      <dt>Conversões</dt>
                      <dd>{recuperacao.data.carrinhosConvertidos.toLocaleString('pt-BR')}</dd>
                    </div>
                    <div>
                      <dt>Receita recuperada</dt>
                      <dd>{formatValor(recuperacao.data.receitaRecuperada) || 'R$ 0,00'}</dd>
                    </div>
                  </dl>
                  <div className="ad-recuperacao-grafico">
                    <span className="ad-recuperacao-grafico__rotulo">Mensagens por dia</span>
                    <RecoveryChart dados={recoverySerie} />
                  </div>
                </div>
              )}
            </Card>
          </div>

          {!financeiro.erro && <LucroProdutosCard dias={dias} escopo={escopo} rotuloPeriodo={dias === 1 ? 'hoje' : `últimos ${dias} dias`} />}

          <OrderFlow pedidos={pedidosPeriodo} />

          <div className="ad-behavior-grid">
            <Card title="Pedidos por dia da semana">
              {!pedidosPeriodo.length ? <EmptyState title="Sem dados neste período" /> : <WeekdayHourlyChart dados={weekdaySerie} />}
            </Card>
            <Card title="Melhores horários">
              {!pedidosPeriodo.length ? <EmptyState title="Sem dados neste período" /> : <WeekdayHourlyChart dados={hourlySerie} />}
            </Card>
            <IntegrationHealth erros={erros} escopo={escopo} integracoes={integracoes} />
          </div>

          <div className="ad-operation-grid">
            <HotCartsList carrinhos={todosCarrinhos} />
            <RecentOrdersTable pedidos={todosPedidos} mostrarLoja={false} onVinculado={marcarVinculado} />
          </div>
        </>
      )}
    </PageStack>
  );
}
