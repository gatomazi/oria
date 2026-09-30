import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Callout, Card, DataTable, EmptyState, ErrorState, Icon, InfoTooltip, KpiCard, KpiStrip, MiniSparkline, PageHeader, PageStack, Skeleton, StatusBadge } from '../../components/ds';
import { copiar, formatValor, plural, tempoDesde, waLink } from '../../lib/format';
import { useLojaAtiva } from '../../auth/AuthContext';
import { mesmaLoja, porEscopo } from './escopoLoja';
import { avisoDeMidiaComProblema, avisoDeMidiaFora, estadoDaMidia, type MidiaFonte } from './estadoMidia';
import { decomporResultado } from './decomposicaoResultado';
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
import { PeriodoGlobalSelect } from '../../components/PeriodoGlobalSelect';
import { usePeriodoGlobal, intervaloDoPeriodo, rotuloDoPeriodo } from '../../lib/periodoGlobal';
import { LucroProdutosCard } from './LucroProdutosCard';
import { OrdersRevenueChart } from './charts/OrdersRevenueChart';
import { OrderStatusDonut } from './charts/OrderStatusDonut';
import { RecoveryChart } from './charts/RecoveryChart';
import { WeekdayHourlyChart } from './charts/WeekdayHourlyChart';
import {
  ESTAGIOS_PIPELINE,
  calcularDelta,
  diasAtrasISO,
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
  type MidiaDia,
  formatDataHoraCurta,
} from './dashboardData';

import '../../dashboard.css';
import '../../pedidos-central.css';

// Porte de src/dashboard.js — reconstruído (docs/claude-dashboard-visual-graficos.md) como
// dashboard operacional com gráficos reais, mantendo tudo que já existia (vincular Pix,
// copiar link, health de integrações) e sem tocar em nenhuma outra página.

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
  midiaFontes,
  erro,
  startDate,
  endDate,
  dias,
  rotuloPeriodo,
}: {
  linhas: FinanceiroDia[] | null;
  midia: MidiaDia[];
  midiaFontes: MidiaFonte[] | null;
  erro: string;
  startDate: string;
  endDate: string;
  dias: number;
  rotuloPeriodo: string;
}) {
  const atual = useMemo(
    () => (linhas ? resultadoFinanceiro(linhas, startDate, endDate, midia) : null),
    [linhas, startDate, endDate, midia]
  );
  // Período anterior de MESMO tamanho, imediatamente antes de startDate — nunca "hoje": um
  // intervalo customizado no passado compara com o que veio antes DELE, não com ontem.
  const anterior = useMemo(
    () => (linhas ? resultadoFinanceiro(linhas, diasAtrasISO(startDate, dias), diasAtrasISO(startDate, 1), midia) : null),
    [linhas, startDate, dias, midia]
  );
  const sparkline = useMemo(
    () => (linhas ? serieLucroOperacional(linhas, Math.max(dias, 7), midia, endDate) : []),
    [linhas, dias, midia, endDate]
  );

  if (erro) {
    return <Callout tone="info" title="Resultado financeiro indisponível">{erro}</Callout>;
  }
  if (!atual || !anterior) return <Skeleton rows={1} height="112px" />;

  // Delta só contra um período anterior completo: um único dia parcial (hoje, ou o próprio dia
  // customizado escolhido) x um dia anterior inteiro sempre "cai", e período anterior com pedido
  // ainda sem custo calculado daria uma variação que não existe.
  const comparavel = dias > 1 && anterior.semFinanceiro === 0;
  const deltaFaturamento = comparavel ? calcularDelta(atual.faturamento, anterior.faturamento) : null;
  const deltaLucro = comparavel ? calcularDelta(atual.lucroAposMidia, anterior.lucroAposMidia) : null;
  // Conta de anúncios da loja conectada = a mídia entra na conta, MESMO com gasto zero no período
  // (isso é "gasto zero" de verdade). Sem conta da loja o painel não sabe quanto foi gasto: não
  // mostra "Mídia R$ 0,00" como se soubesse, e o lucro diz por que não desconta mídia.
  const estadoMidia = estadoDaMidia(midiaFontes);
  const temMidia = estadoMidia === 'conectada' || estadoMidia === 'com_problema' || (estadoMidia === 'desconhecido' && atual.midia > 0);
  const avisoMidia = avisoDeMidiaFora(estadoMidia);
  const avisoConexao = avisoDeMidiaComProblema(estadoMidia);
  const pesoCusto = formatPercentual(atual.custoProducao, atual.lucroBruto);
  // O número que fecha a linha: lucro após mídia quando a mídia é conhecida, senão o lucro bruto.
  const final = temMidia ? atual.lucroAposMidia : atual.lucroOperacional;
  // Margem sobre o FATURAMENTO, não sobre o lucro bruto: "margem de 51%" lida contra a receita é o
  // número que as pessoas comparam entre si, e é assim que a DRE do Meta Ads também calcula.
  const margemFinal = formatPercentual(final, atual.faturamento);
  const decomposicao = decomporResultado(
    { faturamento: atual.faturamento, receitaLiquida: atual.lucroBruto, custoProducao: atual.custoProducao, midia: atual.midia, resultado: final },
    temMidia
  );

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
      {/* Resultado do período: a linha de chegada (o que sobra) ganha destaque próprio, e as saídas
          ficam numa grade de 4 células — com 6 células numa linha só os valores eram cortados
          ("R$ 38.233,…") em 1440px com a sidebar aberta. A barra embaixo é a mesma conta em
          proporção (decomposicaoResultado.ts). */}
      <section className="ad-resultado" aria-label="Resultado do período">
        <div className="ad-resultado__fluxo" role="group" aria-label="Como se chega ao resultado">
          <KpiCard
            title="Faturamento"
            value={formatValor(atual.faturamento) || 'R$ 0,00'}
            delta={deltaFaturamento?.delta}
            trend={deltaFaturamento?.trend}
            helper={`${plural(atual.pedidos, 'pedido pago', 'pedidos pagos')} · ${rotuloPeriodo}`}
          />
          <KpiCard title="Receita líquida" value={formatValor(atual.lucroBruto) || 'R$ 0,00'} helper="Sem frete, já com descontos" />
          <KpiCard
            title="Custo de produção"
            value={formatValor(atual.custoProducao) || 'R$ 0,00'}
            helper={pesoCusto ? `${pesoCusto} da receita líquida` : 'Retido pela Reserva Ink'}
          />
          {/* Lucro bruto = venda menos custo de produção, ANTES da mídia — o mesmo número que o painel
              da Ink chama de "Lucro Bruto". Com mídia conhecida ele é um degrau intermediário (célula);
              sem mídia ele é o resultado final e vai para o destaque ao lado. */}
          {temMidia ? (
            <KpiCard
              title="Mídia"
              value={formatValor(atual.midia) || 'R$ 0,00'}
              helper={avisoConexao || (atual.midia > 0 ? 'Gasto real nas plataformas' : 'Sem gasto registrado no período')}
            />
          ) : (
            <KpiCard title="Mídia" value="Não entra na conta" helper={avisoMidia ? `Sem gasto conhecido · ${avisoMidia}` : 'Sem gasto conhecido no período'} />
          )}
        </div>
        <div className={['ad-resultado__sobra', final < 0 ? 'ad-resultado__sobra--negativa' : null].filter(Boolean).join(' ')}>
          <p className="ad-resultado__sobra-titulo">
            {temMidia ? 'Lucro após mídia' : 'Lucro bruto'}
            {sparkline.length > 1 && (
              <span className="ad-resultado__sobra-linha" aria-hidden="true">
                <MiniSparkline values={sparkline.slice(-7)} width={88} height={24} />
              </span>
            )}
          </p>
          <strong className="ad-resultado__sobra-valor">{formatValor(final) || 'R$ 0,00'}</strong>
          <div className="ad-resultado__sobra-rodape">
            {deltaLucro && <span className={`ds-kpi__delta ds-kpi__delta--${deltaLucro.trend === 'down' ? 'down' : 'up'}`}>{deltaLucro.delta}</span>}
            <span>
              {margemFinal ? `Margem de ${margemFinal} sobre o faturamento` : temMidia ? 'Lucro bruto − mídia' : 'Venda menos custo de produção'}
            </span>
          </div>
          {!temMidia && avisoMidia && <p className="ad-resultado__sobra-aviso">Antes da mídia: {avisoMidia}.</p>}
        </div>
        {decomposicao.partes.length > 0 && (
          <div className="ad-resultado__decomposicao">
            <div className="ad-decomposicao" role="img" aria-label={`Para onde foi o faturamento: ${decomposicao.partes.map((p) => `${p.rotulo} ${Math.round(p.fracao * 100)}%`).join(', ')}`}>
              {decomposicao.partes.map((p) => (
                <i key={p.chave} className={`ad-decomposicao__parte ad-decomposicao__parte--${p.chave}`} style={{ flexGrow: p.fracao }} />
              ))}
            </div>
            <ul className="ad-decomposicao__legenda" aria-hidden="true">
              {decomposicao.partes.map((p) => (
                <li key={p.chave} className={`ad-decomposicao__item ad-decomposicao__item--${p.chave}`}>
                  {p.rotulo} <b>{Math.round(p.fracao * 100)}%</b>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
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

function IntegrationHealth({ erros, escopo, integracoes }: { erros: { loja: string | null }[]; escopo: string; integracoes: IntegrationsData | null }) {
  // A Store nativa do Oria não tem chave legada, então `adminStores.get` não a conhece — e a linha da
  // Reserva Ink sumia do card. Ela aparece sempre; o nome da loja legada só complementa o rótulo.
  const loja = adminStores.get(escopo);
  const temErro = erros.some((e) => mesmaLoja(e.loja, escopo));
  return (
    <Card title="Canais e integrações">
      <ul className="ad-saude-lista">
        <li className="ad-saude-item">
          <span className={`ad-status-dot ad-status-dot--${temErro ? 'erro' : 'ok'}`} />
          <span>{loja ? `Reserva Ink · ${loja.name}` : 'Reserva Ink'}</span>
          <span className="ad-saude-status">{temErro ? 'Atenção' : 'OK'}</span>
        </li>
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
  // Seletor de período GLOBAL (src/lib/periodoGlobal.ts) — compartilhado e persistido entre
  // Dashboard/Desempenho de Produtos/Jornada de Compra; startDate/endDate são explícitos e podem
  // não terminar hoje (intervalo customizado no passado).
  const [periodoGlobal, setPeriodoGlobal] = usePeriodoGlobal();
  const { startDate, endDate, dias } = intervaloDoPeriodo(periodoGlobal);
  const rotuloPeriodo = rotuloDoPeriodo(periodoGlobal).toLowerCase();

  const [pedidos, setPedidos] = useState<Fetched<DashboardOrdersData>>({ data: null, erro: '' });
  // Pedidos do PERÍODO selecionado especificamente — separado do `pedidos` acima (sempre os
  // últimos 90 dias terminando hoje, independente do período): "Últimos pedidos"/"Pedidos com
  // atenção" são operacionais (sempre o mais recente), os gráficos abaixo são do período escolhido.
  const [pedidosPeriodoFetch, setPedidosPeriodoFetch] = useState<Fetched<DashboardOrdersData>>({ data: null, erro: '' });
  const [carrinhos, setCarrinhos] = useState<Fetched<{ carrinhos: DashboardCarrinho[]; erros: { loja: string | null; error: string }[] }>>({ data: null, erro: '' });
  const [integracoes, setIntegracoes] = useState<IntegrationsData | null>(null);
  const [recuperacao, setRecuperacao] = useState<Fetched<RecuperacaoResumo>>({ data: null, erro: '' });
  const [financeiro, setFinanceiro] = useState<Fetched<DashboardFinanceiroData>>({ data: null, erro: '' });

  useEffect(() => {
    getDashboardOrders({ dias: 90 })
      .then((data) => setPedidos({ data, erro: '' }))
      .catch((err: Error) => setPedidos({ data: null, erro: err.message }));
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

  // Refaz a cada troca de período (a pessoa pode escolher qualquer intervalo passado, não só os 4
  // presets de sempre). O financeiro pede também o período ANTERIOR de mesmo tamanho, pro delta de
  // "Resultado do período" — o servidor recorta o início se o total pedido passar do teto (180 dias).
  useEffect(() => {
    let ativo = true;
    getDashboardOrders({ startDate, endDate })
      .then((data) => { if (ativo) setPedidosPeriodoFetch({ data, erro: '' }); })
      .catch((err: Error) => { if (ativo) setPedidosPeriodoFetch({ data: null, erro: err.message }); });
    getDashboardFinanceiro({ startDate: diasAtrasISO(startDate, dias), endDate })
      .then((data) => { if (ativo) setFinanceiro({ data, erro: '' }); })
      .catch((err: Error) => { if (ativo) setFinanceiro({ data: null, erro: err.message }); });
    return () => { ativo = false; };
  }, [startDate, endDate, dias]);

  const todosPedidos = useMemo(() => porEscopo(pedidos.data?.pedidos || [], escopo), [pedidos.data, escopo]);
  const pedidosPeriodoBruto = useMemo(() => porEscopo(pedidosPeriodoFetch.data?.pedidos || [], escopo), [pedidosPeriodoFetch.data, escopo]);
  const todosCarrinhos = useMemo(() => porEscopo(carrinhos.data?.carrinhos || [], escopo), [carrinhos.data, escopo]);
  const linhasFinanceiro = useMemo(() => (financeiro.data ? porEscopo(financeiro.data.linhas, escopo) : null), [financeiro.data, escopo]);
  // Mídia passa pelo MESMO filtro de loja do financeiro: filtrar o painel por uma loja e continuar
  // descontando a mídia de todas mostraria um prejuízo que não existe.
  const midiaFinanceiro = useMemo(() => porEscopo(financeiro.data?.midia || [], escopo), [financeiro.data, escopo]);
  let erros = (pedidos.data?.erros || []).concat(pedidosPeriodoFetch.data?.erros || [], carrinhos.data?.erros || []);
  erros = erros.filter((e) => mesmaLoja(e.loja, escopo));

  // Defensivo: o servidor já devolve só o intervalo pedido, mas recorta de novo aqui — grátis e
  // nunca deixa uma borda escapar (fuso do provider x fuso do navegador).
  const pedidosPeriodo = useMemo(() => pedidosNoPeriodo(pedidosPeriodoBruto, startDate, endDate), [pedidosPeriodoBruto, startDate, endDate]);
  const hoje = hojeISO();
  const ontem = diasAtrasISO(hoje, 1);
  const agoraHM = new Date().toTimeString().slice(0, 5);
  // "Indicadores de hoje" é sempre HOJE de verdade, nunca o período escolhido acima — mesmo
  // navegando um mês inteiro no passado, esta seção continua respondendo "como estamos agora".
  const pedidosHoje = useMemo(() => pedidosDoDia(todosPedidos, hoje), [todosPedidos, hoje]);
  // "Ontem até agora" (mesma janela parcial de hoje), não o dia de ontem inteiro — ver
  // pedidosDoDiaAteHora: comparar hoje-parcial com ontem-inteiro é injusto (sempre "cai").
  const pedidosOntem = useMemo(() => pedidosDoDiaAteHora(todosPedidos, ontem, agoraHM), [todosPedidos, ontem, agoraHM]);
  const pedidosProblema = useMemo(() => todosPedidos.filter((p) => p.paymentBucket === 'problema').length, [todosPedidos]);

  const serieDiariaCompleta = useMemo(() => serieDiaria(todosPedidos, Math.max(dias, 7)), [todosPedidos, dias]);
  const seriePeriodo = useMemo(() => serieDiaria(pedidosPeriodo, dias, endDate), [pedidosPeriodo, dias, endDate]);
  // Com o cache financeiro disponível o gráfico principal lê dele (período completo, com lucro); sem
  // Postgres, cai pra série da lista da Ink, como sempre foi.
  const serieFinanceira = useMemo(() => (linhasFinanceiro ? serieFinanceiraDiaria(linhasFinanceiro, dias, endDate) : null), [linhasFinanceiro, dias, endDate]);
  const sparklinePedidos = useMemo(() => serieDiariaCompleta.slice(-7).map((d) => d.pedidos), [serieDiariaCompleta]);
  const sparklineReceita = useMemo(() => serieDiariaCompleta.slice(-7).map((d) => d.receita), [serieDiariaCompleta]);

  const statusPeriodo = useMemo(() => serieStatus(pedidosPeriodo), [pedidosPeriodo]);
  const weekdaySerie = useMemo(() => serieDiaSemana(pedidosPeriodo), [pedidosPeriodo]);
  const hourlySerie = useMemo(() => serieHorario(pedidosPeriodo), [pedidosPeriodo]);
  const recoverySerie = useMemo(() => (recuperacao.data ? serieRecuperacao(recuperacao.data.porDia, dias, endDate) : []), [recuperacao.data, dias, endDate]);

  function marcarVinculado(indexNoEscopo: number, hotpageId: string) {
    const pedidoAlvo = todosPedidos[indexNoEscopo];
    setPedidos((prev) => {
      if (!prev.data) return prev;
      return { ...prev, data: { ...prev.data, pedidos: prev.data.pedidos.map((p) => (p === pedidoAlvo ? { ...p, hotpageId } : p)) } };
    });
  }

  const carregando = !pedidos.data && !pedidos.erro && !carrinhos.data && !carrinhos.erro;
  // A lacuna do gráfico do período é a do fetch do PERÍODO (não a da lista "recente" de sempre).
  const lacuna = pedidosPeriodoFetch.data?.lojasComLacuna || [];

  return (
    <PageStack className="ad-dashboard">
      <PageHeader
        title="Visão geral"
        description="Resumo da operação da sua loja."
        actions={<PeriodoGlobalSelect value={periodoGlobal} onChange={setPeriodoGlobal} />}
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

          <ResultadoPeriodo
            linhas={linhasFinanceiro} midia={midiaFinanceiro} midiaFontes={financeiro.data?.midiaFontes ?? null} erro={financeiro.erro}
            startDate={startDate} endDate={endDate} dias={dias} rotuloPeriodo={rotuloPeriodo}
          />

          <div className="ad-analytic-grid">
            <Card
              title={serieFinanceira ? `Faturamento e lucro — ${rotuloPeriodo}` : `Pedidos e receita — ${rotuloPeriodo}`}
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

          {!financeiro.erro && <LucroProdutosCard startDate={startDate} endDate={endDate} escopo={escopo} rotuloPeriodo={rotuloPeriodo} />}

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
