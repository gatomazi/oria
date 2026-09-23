import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Button, Callout, ConfirmDialog, DataTable, EmptyState, ErrorState, Field, Input, KpiCard, KpiStrip, PageHeader, PageStack, Pagination,
  SearchInput, Select, Skeleton, StatusBadge, Toolbar, Card, Disclosure,
} from '../../components/ds';
import { formatValor, plural } from '../../lib/format';
import { useLojaAtiva, useNomeDaStore } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import { toast } from '../../lib/toast';
import {
  criarSegmentoDeFiltros, criarSegmentoRfm, exportarClientes, filtrosComoObjeto, getResumoClientes, listClientes,
  type Cliente, type FiltrosAvancados, type IndicadoresPeriodo, type ListaDeClientes, type ResumoClientes, type SegmentoFiltro, type SegmentoResumo,
} from '../../api/clientes';
import { ClienteDrawer } from './ClienteDrawer';
import { GrupoBadge, RfmMatriz, type MetricaMatriz } from './RfmMatriz';
import { SegmentoPanel } from './SegmentoPanel';
import { ESTADO_INICIAL, gravarFiltros, lerFiltros, ROTULOS_AVANCADOS, temAvancados, UF_LISTA, type EstadoFiltros } from './filtrosUrl';
import { estiloDe } from './rfmSegmentos';
import { dataCurta, dataHora, decimal, dia, numero, pct } from './rfmTexto';

import '../../pedidos-central.css';
import '../../clientes.css';

const CLIENTES_POR_PAGINA = 25;
// A busca só vai ao servidor depois de uma pausa na digitação (uma chamada por tecla seria ruído).
const ATRASO_DA_BUSCA_MS = 300;

const PERIODOS_ROTULO: Record<string, string> = {
  '30': 'Últimos 30 dias', '90': 'Últimos 90 dias', '180': 'Últimos 180 dias', '365': 'Últimos 365 dias', tudo: 'Todo o histórico sincronizado',
};

const moeda = (v: number | null | undefined) => (v == null ? '—' : (formatValor(v) ?? '—'));

// Variação percentual contra o período anterior, só quando os dois lados existem e o anterior não é zero.
function variacao(atual: number | null, anterior: number | null | undefined): { delta: string; trend: 'up' | 'down' } | null {
  if (atual == null || anterior == null || anterior === 0) return null;
  const v = (atual - anterior) / anterior;
  return { delta: `${v >= 0 ? '+' : ''}${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`, trend: v >= 0 ? 'up' : 'down' };
}

function Kpis({ resumo }: { resumo: ResumoClientes }) {
  const a = resumo.indicadores.atual;
  const ant: IndicadoresPeriodo | null = resumo.indicadores.comparacao.anterior;
  const comparavel = ant != null;
  const contexto = comparavel ? `vs. ${dia(resumo.indicadores.comparacao.periodo.de)}–${dia(resumo.indicadores.comparacao.periodo.ate)}` : undefined;
  const cartao = (
    title: string, valor: string, atualN: number | null, antN: number | null | undefined, info: string, helper?: string,
  ) => {
    const v = variacao(atualN, antN);
    return <KpiCard title={title} value={valor} info={info} delta={v?.delta} trend={v?.trend} helper={v ? contexto : helper} />;
  };
  return (
    <KpiStrip label="Indicadores do período">
      {cartao('Faturamento', moeda(a.faturamento), a.faturamento, ant?.faturamento,
        'Soma do valor pago (já líquido de desconto, com o frete pago) dos pedidos válidos do período. Pedido cancelado, pendente, reembolsado por inteiro e troca ficam de fora.')}
      {cartao('Pedidos válidos', numero(a.pedidos), a.pedidos, ant?.pedidos, 'Pedidos pagos, sem troca, com cliente identificável.',
        a.pedidosReembolsados ? `${plural(a.pedidosReembolsados, 'reembolsado', 'reembolsados')} fora` : undefined)}
      {cartao('Clientes compradores', numero(a.clientes), a.clientes, ant?.clientes, 'Pessoas distintas (documento, telefone ou e-mail em comum viram uma só) com ao menos um pedido válido no período.',
        a.clientesPrimeiraCompra ? `${numero(a.clientesPrimeiraCompra)} na 1ª compra` : undefined)}
      {cartao('Taxa de recompra', pct(a.taxaRecompra), a.taxaRecompra, ant?.taxaRecompra,
        'Clientes com 2 ou mais pedidos válidos DENTRO do período, divididos pelos clientes compradores do período. Compra anterior ao período não conta como recompra aqui.',
        `${numero(a.recorrentes)} de ${numero(a.clientes)}`)}
      {cartao('Ticket médio', moeda(a.ticketMedio), a.ticketMedio, ant?.ticketMedio, 'Faturamento ÷ pedidos válidos do período.')}
      {cartao('Receita por cliente', moeda(a.receitaPorCliente), a.receitaPorCliente, ant?.receitaPorCliente, 'Faturamento ÷ clientes compradores do período.',
        a.receitaRecorrente ? `${moeda(a.receitaRecorrente)} de recorrentes` : undefined)}
    </KpiStrip>
  );
}

export function ClientesPage() {
  const nomeStore = useNomeDaStore();
  const escopo = useLojaAtiva() ?? '';
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filtros: EstadoFiltros = useMemo(() => lerFiltros(params), [params]);

  const atualizar = useCallback((mudanca: Partial<EstadoFiltros>, { manterPagina = false } = {}) => {
    const proximo = { ...lerFiltros(params), ...mudanca };
    if (!manterPagina && !('pagina' in mudanca)) proximo.pagina = 1;
    setParams(gravarFiltros(proximo), { replace: true });
  }, [params, setParams]);

  // Busca fica só em memória (nome/e-mail/telefone não vão para a URL).
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [metrica, setMetrica] = useState<MetricaMatriz>('clientes');
  const [avancadosAbertos, setAvancadosAbertos] = useState(temAvancados(filtros.avancados));

  const [resumo, setResumo] = useState<ResumoClientes | null>(null);
  const [erroResumo, setErroResumo] = useState('');
  const [lista, setLista] = useState<ListaDeClientes | null>(null);
  const [erroLista, setErroLista] = useState('');
  const [aberto, setAberto] = useState<{ chave: string; nome: string | null } | null>(null);
  const [criando, setCriando] = useState(false);
  const [exportando, setExportando] = useState<{ quantidade: number } | null>(null);
  const [nomeSegmentoFiltros, setNomeSegmentoFiltros] = useState<string | null>(null);
  const secaoLista = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setBuscaAplicada(busca);
      if (busca !== buscaAplicada) atualizar({ pagina: 1 });
    }, ATRASO_DA_BUSCA_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busca]);

  const carregarResumo = useCallback(() => {
    setErroResumo('');
    getResumoClientes({ dias: filtros.periodo })
      .then(setResumo)
      .catch((err: Error) => setErroResumo(err.message));
  }, [filtros.periodo]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregarResumo, [carregarResumo, escopo]);

  const chaveLista = JSON.stringify([escopo, filtros, buscaAplicada]);
  useEffect(() => {
    let atual = true;
    setErroLista('');
    listClientes({
      page: filtros.pagina, perPage: CLIENTES_POR_PAGINA, ordem: filtros.ordem, busca: buscaAplicada, inativoDias: filtros.inatividade,
      tipo: filtros.tipo, segmentos: filtros.segmentos, avancados: filtros.avancados,
    })
      .then((r) => {
        if (!atual) return;
        setLista(r);
        // O servidor devolve a página real (a lista pode ter encolhido com o filtro).
        if (r.page !== filtros.pagina) atualizar({ pagina: r.page }, { manterPagina: true });
      })
      .catch((err: Error) => { if (atual) setErroLista(err.message); });
    return () => { atual = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chaveLista]);

  const segmentos = resumo?.rfm.segmentos ?? [];
  const selecionados = useMemo(() => segmentos.filter((s) => (filtros.segmentos as string[]).includes(s.id)), [segmentos, filtros.segmentos]);

  function alternarSegmento(id: string) {
    const atuais = filtros.segmentos;
    const proximo = (atuais as string[]).includes(id) ? atuais.filter((s) => s !== id) : [...atuais, id as SegmentoFiltro];
    atualizar({ segmentos: proximo });
  }

  async function criarCampanha(s: SegmentoResumo) {
    if (!resumo) return;
    setCriando(true);
    try {
      const nome = `RFM · ${s.nome} · ${dia(resumo.rfm.classificadoEm.slice(0, 10))}`;
      const r = await criarSegmentoRfm(nome, s.id);
      toast(r.reaproveitado ? 'Segmento já existia com esta regra: reaproveitado.' : 'Segmento dinâmico criado.', 'sucesso');
      navigate(`/admin/campanhas/nova?segmento=${encodeURIComponent(r.segmento.id)}`);
    } catch {
      /* erro já avisado por toast em api() */
    } finally {
      setCriando(false);
    }
  }

  const filtrosDaConsulta = () => filtrosComoObjeto({
    ordem: filtros.ordem, busca: buscaAplicada, inativoDias: filtros.inatividade, tipo: filtros.tipo, segmentos: filtros.segmentos, avancados: filtros.avancados,
  });

  // Prévia da exportação: quantos clientes COM COMPRA batem nos filtros atuais (o CSV nunca leva quem só tem cadastro).
  async function abrirExportacao() {
    try {
      const r = await listClientes({
        page: 1, perPage: 1, ordem: filtros.ordem, busca: buscaAplicada, inativoDias: filtros.inatividade, tipo: 'com_pedido',
        segmentos: filtros.segmentos, avancados: filtros.avancados,
      });
      setExportando({ quantidade: r.total });
    } catch (err) {
      toast((err as Error).message, 'erro');
    }
  }

  async function confirmarExportacao() {
    if (!exportando) return;
    const { blob, nome } = await exportarClientes({ ...filtrosDaConsulta(), tipo: 'com_pedido' }, exportando.quantidade);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`${plural(exportando.quantidade, 'cliente exportado', 'clientes exportados')}.`, 'sucesso');
  }

  async function salvarSegmentoDeFiltros() {
    if (nomeSegmentoFiltros == null) return;
    const r = await criarSegmentoDeFiltros(nomeSegmentoFiltros.trim(), filtrosDaConsulta());
    if (r.naoConvertidos.length) toast(`Não entraram no segmento: ${r.naoConvertidos.join(', ')}.`, 'erro');
    navigate(`/admin/campanhas/nova?segmento=${encodeURIComponent(r.segmento.id)}`);
  }

  const chipsAtivos: { chave: string; rotulo: string; remover: () => void }[] = [];
  for (const s of selecionados) chipsAtivos.push({ chave: `seg-${s.id}`, rotulo: `Segmento: ${s.nome}`, remover: () => alternarSegmento(s.id) });
  for (const id of filtros.segmentos.filter((x) => x === 'sem_compra')) chipsAtivos.push({ chave: `seg-${id}`, rotulo: 'Segmento: Sem compra válida', remover: () => alternarSegmento(id) });
  if (filtros.tipo !== 'todos') chipsAtivos.push({ chave: 'tipo', rotulo: filtros.tipo === 'com_pedido' ? 'Com pedido' : 'Só cadastro', remover: () => atualizar({ tipo: 'todos' }) });
  if (filtros.inatividade) chipsAtivos.push({ chave: 'inativo', rotulo: `Sem comprar há ${filtros.inatividade}+ dias`, remover: () => atualizar({ inatividade: '' }) });
  if (buscaAplicada.trim()) chipsAtivos.push({ chave: 'busca', rotulo: `Busca: ${buscaAplicada.trim()}`, remover: () => { setBusca(''); setBuscaAplicada(''); atualizar({}); } });
  for (const [campo, valor] of Object.entries(filtros.avancados) as [keyof FiltrosAvancados, string][]) {
    if (!valor) continue;
    chipsAtivos.push({
      chave: `av-${campo}`,
      rotulo: `${ROTULOS_AVANCADOS[campo]}: ${campo === 'marketing' ? (valor === 'sim' ? 'aceita' : 'não aceita') : campo.startsWith('primeira') || campo.startsWith('ultima') ? dia(valor) : valor}`,
      remover: () => atualizar({ avancados: { ...filtros.avancados, [campo]: '' } }),
    });
  }
  function limparFiltros() {
    setBusca('');
    setBuscaAplicada('');
    setParams(gravarFiltros({ ...ESTADO_INICIAL, periodo: filtros.periodo }), { replace: true });
  }
  const podeSalvarFiltros = filtros.segmentos.length === 0 && temAvancados(filtros.avancados);

  const clientes = lista?.clientes ?? [];
  const cob = resumo?.cobertura;
  const historicoConfirmado = cob?.backfill?.status === 'concluido';

  return (
    <PageStack>
      <PageHeader
        title="Clientes"
        description="Central de inteligência de clientes: indicadores de compra, segmentação RFM explicável e o caminho da análise até a campanha."
        actions={
          <Select aria-label="Período dos indicadores" value={filtros.periodo} onChange={(e) => atualizar({ periodo: e.target.value })}>
            {Object.entries(PERIODOS_ROTULO).map(([v, r]) => <option key={v} value={v}>{r}</option>)}
          </Select>
        }
        meta={resumo && cob && (
          <span className="cli-meta">
            <span>Período: {dia(resumo.periodo.de)} a {dia(resumo.periodo.ate)}</span>
            <span>Última sincronização: {cob.ultimoSyncEm ? dataHora(cob.ultimoSyncEm) : 'não registrada'}</span>
            <span>Histórico sincronizado desde {cob.primeiroPedidoEm ? dataCurta(cob.primeiroPedidoEm) : '—'} · {plural(cob.pedidosTotal, 'pedido', 'pedidos')}</span>
            <StatusBadge tone={historicoConfirmado ? 'success' : 'warning'} label={historicoConfirmado ? 'Backfill concluído' : 'Histórico não confirmado'} />
          </span>
        )}
      />

      {erroResumo && <ErrorState description={erroResumo} onRetry={carregarResumo} />}
      {!erroResumo && !resumo && <Skeleton variant="table" rows={4} />}

      {resumo && cob && (
        <>
          {!historicoConfirmado && (
            <Callout tone="warning" title="Cobertura histórica não confirmada">
              {cob.backfill
                ? `O último backfill de pedidos está "${cob.backfill.status}" (desde ${dia(String(cob.backfill.desde).slice(0, 10))}).`
                : 'Nenhum backfill de pedidos foi registrado para esta loja.'}{' '}
              Os números abaixo cobrem só os pedidos já sincronizados ({cob.primeiroPedidoEm ? `desde ${dataCurta(cob.primeiroPedidoEm)}` : 'nenhum'}); não os trate como o histórico completo da loja.
            </Callout>
          )}
          {cob.pedidosSemIdentidade > 0 && (
            <Callout tone="info">
              {plural(cob.pedidosSemIdentidade, 'pedido válido sem documento, telefone ou e-mail não pôde', 'pedidos válidos sem documento, telefone ou e-mail não puderam')} ser atribuído{cob.pedidosSemIdentidade === 1 ? '' : 's'} a um cliente e ficam fora destes indicadores.
            </Callout>
          )}

          <Kpis resumo={resumo} />
          {resumo.indicadores.comparacao.anterior == null && (
            <p className="ds-form-note">Sem comparação com o período anterior: {resumo.indicadores.comparacao.motivo ?? 'dados incompletos'}.</p>
          )}

          <Card
            title="Matriz RFM"
            description={`Classificação ${resumo.rfm.regraVersao} em ${dataCurta(resumo.rfm.classificadoEm)} · ${numero(resumo.rfm.universo)} clientes com compra válida · janela de frequência ${resumo.rfm.janelaFrequenciaDias} dias · fonte: pedidos sincronizados. Não muda com o período dos indicadores.`}
            action={(
              <div className="cli-segmentado" role="group" aria-label="Tamanho das células">
                {(['clientes', 'receita'] as const).map((m) => (
                  <button key={m} type="button" aria-pressed={metrica === m} className={metrica === m ? 'is-ativo' : ''} onClick={() => setMetrica(m)}>
                    {m === 'clientes' ? 'Por clientes' : 'Por receita'}
                  </button>
                ))}
              </div>
            )}
          >
            {!resumo.rfm.suficiente ? (
              <Callout tone="warning" title="Dados insuficientes para classificar com segurança">
                {resumo.rfm.motivoInsuficiencia}. Mostrar segmentos de recompra com pouca base ou histórico curto seria enganoso; as sugestões de campanha ficam ocultas até haver cobertura.
              </Callout>
            ) : (
              <div className="cli-rfm-grade">
                <RfmMatriz segmentos={segmentos} selecionados={filtros.segmentos as string[]} onToggle={alternarSegmento} metrica={metrica} />
                <SegmentoPanel
                  rfm={resumo.rfm}
                  selecionados={selecionados}
                  criando={criando}
                  onCriarCampanha={criarCampanha}
                  onVerClientes={() => secaoLista.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  onExportar={abrirExportacao}
                  onLimpar={() => atualizar({ segmentos: [] })}
                />
              </div>
            )}
            {!resumo.rfm.janelaCobreHistorico && (
              <p className="ds-form-note">A janela de frequência ({resumo.rfm.janelaFrequenciaDias} dias) é menor que o histórico observado ({numero(resumo.rfm.historicoDias)} dias): compras mais antigas contam no LTV, não na frequência.</p>
            )}
            {resumo.rfm.identidadesSemCompraValida > 0 && (
              <p className="ds-form-note">
                {plural(resumo.rfm.identidadesSemCompraValida, 'cliente tem', 'clientes têm')} pedido, mas nenhum válido (cancelado, reembolsado ou troca): ficam fora da matriz, no filtro “Sem compra válida”.
              </p>
            )}
          </Card>

          {resumo.rfm.suficiente && (
            <Card flush title="Distribuição por segmento" description="Tabela equivalente à matriz. Números do histórico observado até a data de classificação.">
              <DataTable
                label="Distribuição de clientes por segmento RFM"
                rows={segmentos}
                rowKey={(s) => s.id}
                defaultSort={{ key: 'clientes', direction: 'desc' }}
                onRowClick={(s) => alternarSegmento(s.id)}
                columns={[
                  {
                    key: 'nome', label: 'Segmento',
                    render: (s) => (
                      <span className="cli-segnome">
                        <span className="cli-segnome__marca" style={{ background: estiloDe(s.id).tint, opacity: 0.4 + estiloDe(s.id).opacidade }} aria-hidden="true" />
                        {s.nome}
                        {(filtros.segmentos as string[]).includes(s.id) && <StatusBadge tone="info" label="Selecionado" />}
                      </span>
                    ),
                    sortValue: (s) => s.nome,
                  },
                  { key: 'grupo', priority: 'low', label: 'Grupo', muted: true, render: (s) => <GrupoBadge id={s.id} />, sortValue: (s) => estiloDe(s.id).grupo },
                  { key: 'clientes', label: 'Clientes', align: 'right', firstSortDirection: 'desc', render: (s) => numero(s.clientes), sortValue: (s) => s.clientes },
                  { key: 'pctBase', priority: 'low', label: '% da base', align: 'right', firstSortDirection: 'desc', render: (s) => pct(s.pctBase), sortValue: (s) => s.pctBase },
                  { key: 'pedidos', priority: 'low', label: 'Pedidos', align: 'right', firstSortDirection: 'desc', render: (s) => numero(s.pedidos), sortValue: (s) => s.pedidos },
                  { key: 'ppc', priority: 'low', label: 'Pedidos/cliente', align: 'right', firstSortDirection: 'desc', render: (s) => decimal(s.pedidosPorCliente), sortValue: (s) => s.pedidosPorCliente },
                  { key: 'ticket', priority: 'low', label: 'Ticket médio', align: 'right', firstSortDirection: 'desc', render: (s) => moeda(s.ticketMedio), sortValue: (s) => s.ticketMedio },
                  { key: 'mediana', priority: 'low', label: 'Recência (mediana)', align: 'right', render: (s) => (s.recenciaMedianaDias == null ? '—' : `${numero(s.recenciaMedianaDias)} d`), sortValue: (s) => s.recenciaMedianaDias },
                  { key: 'receita', label: 'Receita líquida', align: 'right', firstSortDirection: 'desc', render: (s) => moeda(s.receita), sortValue: (s) => s.receita },
                  { key: 'pctReceita', label: '% da receita', align: 'right', firstSortDirection: 'desc', render: (s) => pct(s.pctReceita), sortValue: (s) => s.pctReceita },
                ]}
              />
            </Card>
          )}
        </>
      )}

      <div ref={secaoLista} id="clientes-lista" className="ds-stack cli-lista">
        <h2 className="cli-lista__titulo">Lista de clientes</h2>
        <Toolbar
          label="Filtrar clientes"
          end={(
            <>
              {lista && <span className="ds-toolbar__meta">{plural(lista.total, 'cliente encontrado', 'clientes encontrados')}</span>}
              <Button variant="secondary" size="sm" onClick={abrirExportacao} disabled={!lista}>Exportar</Button>
            </>
          )}
        >
          <SearchInput
            aria-label="Buscar por nome, email ou telefone"
            placeholder="Buscar por nome, email ou telefone…"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
          <Select aria-label="Filtrar por pedido" value={filtros.tipo} onChange={(e) => atualizar({ tipo: e.target.value as EstadoFiltros['tipo'] })}>
            <option value="todos">Todos os clientes</option>
            <option value="com_pedido">Com pedido</option>
            <option value="sem_pedido">Só cadastro (nunca pediu)</option>
          </Select>
          <Select aria-label="Ordenar clientes" value={filtros.ordem} onChange={(e) => atualizar({ ordem: e.target.value as EstadoFiltros['ordem'] })}>
            <option value="compras_desc">Mais compras primeiro</option>
            <option value="ltv_desc">Maior LTV primeiro</option>
            <option value="lucro_desc">Maior lucro primeiro</option>
            <option value="inativos_primeiro">Sem comprar há mais tempo primeiro</option>
            <option value="nome">Nome (A-Z)</option>
          </Select>
          <Select aria-label="Filtrar por tempo sem comprar" value={filtros.inatividade} onChange={(e) => atualizar({ inatividade: e.target.value })}>
            <option value="">Qualquer cliente</option>
            <option value="30">Sem comprar há 30+ dias</option>
            <option value="60">Sem comprar há 60+ dias</option>
            <option value="90">Sem comprar há 90+ dias</option>
            <option value="180">Sem comprar há 180+ dias</option>
          </Select>
          <Button variant="ghost" size="sm" aria-expanded={avancadosAbertos} onClick={() => setAvancadosAbertos((v) => !v)}>
            Filtros avançados{temAvancados(filtros.avancados) ? ' •' : ''}
          </Button>
        </Toolbar>

        {avancadosAbertos && <FiltrosAvancadosForm valor={filtros.avancados} onChange={(avancados) => atualizar({ avancados })} />}

        {chipsAtivos.length > 0 && (
          <div className="cli-chips" role="group" aria-label="Filtros ativos">
            {chipsAtivos.map((c) => (
              <button key={c.chave} type="button" className="cli-chip cli-chip--remover" onClick={c.remover} aria-label={`Remover filtro ${c.rotulo}`}>
                {c.rotulo}<span aria-hidden="true"> ×</span>
              </button>
            ))}
            <Button variant="ghost" size="sm" onClick={limparFiltros}>Limpar filtros</Button>
            {podeSalvarFiltros && <Button variant="secondary" size="sm" onClick={() => setNomeSegmentoFiltros('')}>Salvar como segmento</Button>}
          </div>
        )}

        {lista && !lista.cadastro.disponivel && (
          <ErrorState description="O cadastro da Reserva Ink não respondeu agora. Mostrando só quem já fez pedido — tente de novo em instantes." />
        )}
        {lista?.cadastro.parcial && <p className="ds-form-note">Cadastro carregado parcialmente: a loja tem mais clientes do que o limite lido de uma vez.</p>}

        {erroLista && <ErrorState description={erroLista} />}
        {!erroLista && !lista && <Skeleton variant="table" rows={8} />}
        {!erroLista && lista && (!clientes.length ? (
          <EmptyState
            title="Nenhum cliente encontrado"
            description={chipsAtivos.length ? 'Nenhum cliente bate com todos os filtros ativos.' : undefined}
            action={chipsAtivos.length ? <Button variant="secondary" size="sm" onClick={limparFiltros}>Limpar filtros</Button> : undefined}
          />
        ) : (
          <>
            <DataTable
              label="Clientes"
              // A ordem é a do seletor, aplicada no servidor sobre a lista inteira; ordenar pelo cabeçalho só
              // reordenaria a página atual e enganaria.
              sortable={false}
              rows={clientes}
              // Só quem tem pedido tem 360°: cadastro sem compra não abre o drawer.
              onRowClick={(c: Cliente) => { if (c.origem === 'pedido') setAberto({ chave: c.customerKey, nome: c.nome }); }}
              // A chave leva a posição: a lista é trocada inteira a cada página/filtro, e uma chave repetida faria o React duplicar linhas.
              rowKey={(c, i) => c.loja + ':' + c.customerKey + ':' + i}
              columns={[
                { key: 'nome', label: 'Nome', truncate: true, width: 220, render: (c) => c.nome || 'Sem nome' },
                {
                  key: 'segmento', label: 'Segmento',
                  render: (c) => (c.segmento ? (
                    <span className="cli-segnome" title={c.rfm ? `R${c.rfm.r} · F${c.rfm.f} · M${c.rfm.m}` : undefined}>
                      {c.segmentoNome}
                      {c.rfm && <span className="cli-escore">R{c.rfm.r}·F{c.rfm.f}·M{c.rfm.m}</span>}
                    </span>
                  ) : <span className="ds-table__cell--muted">{c.origem === 'cadastro' ? 'Só cadastro' : 'Sem compra válida'}</span>),
                },
                { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (c) => adminStores.nameOr(c.loja, nomeStore) },
                {
                  key: 'contato', priority: 'low', label: 'Contato', truncate: true, width: 260, muted: true,
                  render: (c) => [c.email, c.telefone].filter(Boolean).join(' · ') || '—',
                },
                { key: 'compras', label: 'Pedidos', align: 'right', render: (c) => (c.pedidosValidos ? numero(c.pedidosValidos) : <span className="ds-table__cell--muted">—</span>) },
                { key: 'ltv', label: 'LTV', align: 'right', render: (c) => (c.ltv == null ? <span className="ds-table__cell--muted">—</span> : moeda(c.ltv)) },
                { key: 'ticket', priority: 'low', label: 'Ticket médio', align: 'right', muted: true, render: (c) => moeda(c.ticketMedioValido) },
                {
                  key: 'lucro', priority: 'low', label: 'Lucro operacional', align: 'right',
                  // Pedido pago ainda sem custo calculado fica fora da soma: marcado como parcial em
                  // vez de mostrar um lucro menor que o real sem aviso.
                  render: (c) => {
                    if (!c.totalCompras) return <span className="ds-table__cell--muted">—</span>;
                    if (c.pedidosSemFinanceiro > 0 && !c.lucroOperacional) return <span className="ds-table__cell--muted">Sem cálculo</span>;
                    return (
                      <span title={c.pedidosSemFinanceiro > 0 ? `${plural(c.pedidosSemFinanceiro, 'pedido', 'pedidos')} ainda sem custo calculado` : undefined}>
                        {formatValor(c.lucroOperacional)}
                        {c.pedidosSemFinanceiro > 0 && <span className="ds-table__cell--muted"> · parcial</span>}
                      </span>
                    );
                  },
                },
                { key: 'primeira', priority: 'low', label: '1ª compra', align: 'right', muted: true, render: (c) => dataCurta(c.primeiraCompraEm) },
                { key: 'ultimaCompra', label: 'Última compra', align: 'right', muted: true, render: (c) => (c.ultimaCompraEm ? `${dataCurta(c.ultimaCompraEm)} · ${c.diasSemComprar}d` : '—') },
                { key: 'marketing', priority: 'low', label: 'Marketing', render: (c) => (c.aceitaMarketing ? <StatusBadge tone="info" label="Aceita" /> : '—') },
              ]}
            />
            {lista.totalPages > 1 && (
              <Pagination
                label="Paginação de clientes"
                page={lista.page}
                totalPages={lista.totalPages}
                totalLabel={plural(lista.total, 'cliente', 'clientes')}
                onPrev={() => atualizar({ pagina: Math.max(1, lista.page - 1) }, { manterPagina: true })}
                onNext={() => atualizar({ pagina: Math.min(lista.totalPages, lista.page + 1) }, { manterPagina: true })}
              />
            )}
          </>
        ))}
      </div>

      <ClienteDrawer customerKey={aberto?.chave ?? null} nomeInicial={aberto?.nome ?? null} onClose={() => setAberto(null)} />

      <ConfirmDialog
        open={exportando != null}
        onClose={() => setExportando(null)}
        title="Exportar clientes"
        confirmLabel="Exportar CSV"
        confirmVariant="primary"
        onConfirm={confirmarExportacao}
        description={exportando && (
          <>
            <p><strong>{plural(exportando.quantidade, 'cliente', 'clientes')}</strong> com compra batem nos filtros atuais e entram no arquivo.</p>
            <p className="ds-form-note">O CSV traz nome, e-mail, telefone, segmento, pedidos, LTV e datas — sem CPF. A exportação fica registrada no histórico de auditoria. Quem só tem cadastro (sem pedido) não é incluído.</p>
            {exportando.quantidade === 0 && <p className="ds-form-error">Nenhum cliente para exportar.</p>}
          </>
        )}
      />

      <ConfirmDialog
        open={nomeSegmentoFiltros != null}
        onClose={() => setNomeSegmentoFiltros(null)}
        title="Salvar filtros como segmento"
        confirmLabel="Salvar e criar campanha"
        confirmVariant="primary"
        onConfirm={salvarSegmentoDeFiltros}
        description={(
          <>
            <Field label="Nome do segmento">
              <Input type="text" value={nomeSegmentoFiltros ?? ''} maxLength={120} onChange={(e) => setNomeSegmentoFiltros(e.target.value)} placeholder="ex: LTV alto sem comprar há 90 dias" />
            </Field>
            <p className="ds-form-note">Vira um segmento dinâmico: a audiência é reavaliada a cada uso. Busca e datas absolutas não entram no segmento; o que ficar de fora é avisado.</p>
          </>
        )}
      />
    </PageStack>
  );
}

function FiltrosAvancadosForm({ valor, onChange }: { valor: FiltrosAvancados; onChange: (v: FiltrosAvancados) => void }) {
  const set = (campo: keyof FiltrosAvancados, v: string) => onChange({ ...valor, [campo]: v });
  const numeroCampo = (campo: keyof FiltrosAvancados, rotulo: string) => (
    <Field label={rotulo}>
      <Input type="number" inputMode="decimal" min={0} value={valor[campo]} onChange={(e) => set(campo, /^\d{0,9}(\.\d{0,2})?$/.test(e.target.value) ? e.target.value : valor[campo])} />
    </Field>
  );
  const dataCampo = (campo: keyof FiltrosAvancados, rotulo: string) => (
    <Field label={rotulo}><Input type="date" value={valor[campo]} onChange={(e) => set(campo, e.target.value)} /></Field>
  );
  return (
    <Disclosure summary="Faixas de recência, pedidos, LTV, ticket, datas e consentimento" defaultOpen>
      <div className="cli-avancados">
        {numeroCampo('recenciaMin', 'Sem comprar há (dias, mín.)')}
        {numeroCampo('recenciaMax', 'Sem comprar há (dias, máx.)')}
        {numeroCampo('pedidosMin', 'Pedidos válidos (mín.)')}
        {numeroCampo('pedidosMax', 'Pedidos válidos (máx.)')}
        {numeroCampo('ltvMin', 'LTV mínimo (R$)')}
        {numeroCampo('ltvMax', 'LTV máximo (R$)')}
        {numeroCampo('ticketMin', 'Ticket médio mínimo (R$)')}
        {numeroCampo('ticketMax', 'Ticket médio máximo (R$)')}
        {dataCampo('primeiraDe', 'Primeira compra desde')}
        {dataCampo('primeiraAte', 'Primeira compra até')}
        {dataCampo('ultimaDe', 'Última compra desde')}
        {dataCampo('ultimaAte', 'Última compra até')}
        <Field label="UF de entrega">
          <Select value={valor.uf} onChange={(e) => set('uf', e.target.value)}>
            <option value="">Qualquer</option>
            {UF_LISTA.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
          </Select>
        </Field>
        <Field label="Consentimento de marketing">
          <Select value={valor.marketing} onChange={(e) => set('marketing', e.target.value)}>
            <option value="">Qualquer</option>
            <option value="sim">Aceita marketing</option>
            <option value="nao">Não aceita</option>
          </Select>
        </Field>
      </div>
      <p className="ds-form-note">Produto e categoria ainda não são filtros aqui: só entram quando o dado estiver capturado por cliente de forma confiável. A UF vem do endereço de entrega do pedido mais recente que a informa.</p>
    </Disclosure>
  );
}
