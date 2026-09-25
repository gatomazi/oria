import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Button, Callout, Checkbox, DataTable, EmptyState, ErrorState, Field, Icon, Input, KpiCard, KpiStrip, PageHeader, PageStack, Pagination, SearchInput, Select, Skeleton, StatusBadge, Tabs, Toolbar, type TableSort,
} from '../../components/ds';
import { formatValor, plural } from '../../lib/format';
import { lookup, PRODUCT_STATUS_MAP } from '../../lib/statusMap';
import {
  getProductAnalyticsStatus, getProductAnalyticsSummary, listProductAnalytics,
  syncCommerceCatalog, getCommerceCatalogSyncStatus,
  type ProductAnalyticsFiltros, type ProductAnalyticsItem, type ProductAnalyticsListResponse, type ProductAnalyticsSortField,
  type ProductAnalyticsStatus, type ProductAnalyticsStatusFiltro, type ProductAnalyticsSummary,
  type CommerceCatalogSyncStatus,
} from '../../api/productAnalytics';
import { ProdutoPerformanceDrawer } from './ProdutoPerformanceDrawer';
import { ReconciliacaoPanel } from './ReconciliacaoPanel';
import { formatarRazao, DIAGNOSTICO_LABEL, diagnosticoTone } from './formatadores';

import '../../pedidos-central.css';
import '../../produtos.css';
import './desempenho-produtos.css';

const HOJE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const TRINTA_DIAS_ATRAS = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() - 29 * 86_400_000));
const LIMIT = 20;

// Ordenação sempre feita no servidor, sobre o conjunto elegível INTEIRO da Store antes de paginar
// (Fase G.1) — nunca só a página visível (DataTable no modo controlado, ver TrocasPage/ProdutosPage).
//
// Rodada J (achado do smoke real): ordenar por MÉTRICA (ex.: itemsPurchased) restringe o conjunto
// elegível aos produtos com identity JÁ resolvida no namespace de analytics (design deliberado da
// Fase G.1 — não dá pra rankear o que nunca foi observado). Como PADRÃO da tela isso escondia o
// resto do catálogo sem aviso nenhum (piloto real: 3 produtos no catálogo, só 1 com atividade GA4 →
// a tabela mostrava "1 produto" por padrão, parecendo um catálogo vazio/quebrado).
//
// Rodada "mais dados primeiro + filtros": o padrão agora é `data` — quem tem dado observado no período
// vem primeiro (mais volume antes) e o RESTO do catálogo vem logo depois, por nome. Ranqueia sem
// esconder ninguém, que é o que a Rodada J pedia. Clicar numa coluna ordena por ela; o botão "Mais dados
// primeiro" volta ao padrão.
const SORT_INICIAL: TableSort = { key: 'data', direction: 'desc' };

// Filtros (o que o lojista digita fica em texto; só vira número na hora de pedir). Mínimos são ">="
// sobre as contagens de item do período — 0 ou vazio = sem filtro. Regra única no servidor
// (lib/product-analytics/performance-filters.js).
//
// `busca` (nome do produto) VENCE todo o resto: preenchida, a tela só manda `q` e o servidor devolve o
// produto de qualquer situação — quem busca um produto quer achá-lo, não descobrir que um filtro o
// escondeu. Os outros campos ficam desabilitados enquanto a busca está em uso.
interface FiltrosUI {
  busca: string;
  status: ProductAnalyticsStatusFiltro;
  minViewed: string;
  minAddedToCart: string;
  minCheckedOut: string;
  minPurchased: string;
  minRevenue: string;
  hasData: boolean;
}
const FILTROS_VAZIOS: FiltrosUI = { busca: '', status: 'active', minViewed: '', minAddedToCart: '', minCheckedOut: '', minPurchased: '', minRevenue: '', hasData: false };
const CAMPOS_MINIMO = [
  { chave: 'minViewed', label: 'Visualizados (mín.)' },
  { chave: 'minAddedToCart', label: 'No carrinho (mín.)' },
  { chave: 'minCheckedOut', label: 'Em checkout (mín.)' },
  { chave: 'minPurchased', label: 'Comprados (mín.)' },
  { chave: 'minRevenue', label: 'Receita GA4 (mín., R$)' },
] as const;
const DEBOUNCE_FILTROS_MS = 400;

function numeroPositivo(texto: string): number | undefined {
  if (!texto.trim()) return undefined;
  const n = Number(texto.replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function paraFiltros(f: FiltrosUI): ProductAnalyticsFiltros & { q?: string } {
  const q = f.busca.trim();
  if (q) return { q };
  return {
    status: f.status,
    minViewed: numeroPositivo(f.minViewed),
    minAddedToCart: numeroPositivo(f.minAddedToCart),
    minCheckedOut: numeroPositivo(f.minCheckedOut),
    minPurchased: numeroPositivo(f.minPurchased),
    minRevenue: numeroPositivo(f.minRevenue),
    hasData: f.hasData,
  };
}

// Comparação por valor efetivo (o que de fato vai pro servidor), não por texto digitado: "05" e "5",
// ou "0" e vazio, são o mesmo filtro e não devem refazer a consulta.
const chaveDosFiltros = (f: FiltrosUI) => JSON.stringify(paraFiltros(f));
const temFiltroAtivo = (f: FiltrosUI) => chaveDosFiltros(f) !== chaveDosFiltros(FILTROS_VAZIOS);

type Periodo = { startDate: string; endDate: string };

function Thumb({ item }: { item: ProductAnalyticsItem }) {
  if (item.product.imageUrl) return <img className="pr-thumb" src={item.product.imageUrl} alt="" loading="lazy" />;
  return (
    <div className="pr-thumb pr-thumb--placeholder" title="Sem foto">
      <Icon name="image" />
      <span className="ds-sr-only">Sem foto</span>
    </div>
  );
}

function ConexaoIndisponivel({ status }: { status: ProductAnalyticsStatus }) {
  if (!status.analytics.connected) {
    return (
      <Callout tone="warning" title="Google Analytics 4 não conectado">
        Conecte o GA4 e escolha uma propriedade em Integrações para ver o desempenho de produtos.
        <div className="pa-callout__acao">
          <Link to="/admin/integracoes" className="ds-btn ds-btn--secondary ds-btn--sm">Ir para Integrações</Link>
        </div>
      </Callout>
    );
  }
  if (status.analytics.apt === false) {
    return (
      <Callout tone="warning" title="Propriedade GA4 não está apta para Desempenho de Produtos">
        {status.analytics.reason === 'GA4_ITEM_ID_UNAVAILABLE'
          ? 'Esta propriedade não expõe a dimensão de item (itemId) — confirme que o rastreamento de e-commerce está ativo no GA4.'
          : 'Esta propriedade não expõe itens visualizados (itemsViewed) — confirme o rastreamento de e-commerce/eventos no GA4.'}
      </Callout>
    );
  }
  return null;
}

// Rodada J.4 · cartões de totais STORE-WIDE do período inteiro (nunca a soma da página visível da
// tabela). `observed` é sempre o principal (a verdade crua do GA4); o helper de cada card mostra
// quanto disso já resolveu a produto (`matched`) — os dois grupos ficam visíveis, nunca um só.
function CartoesDeTotais({ resumo }: { resumo: ProductAnalyticsSummary }) {
  if (resumo.coverage.status === 'insufficient_data' || !resumo.observed) {
    return (
      <KpiStrip label="Totais do período (GA4)">
        <KpiCard title="Itens visualizados" value="—" helper="Sem dado de analytics neste período" />
      </KpiStrip>
    );
  }
  const { observed, matched } = resumo;
  const helperAtribuido = (campo: keyof NonNullable<typeof matched>) => {
    const m = matched?.[campo];
    return m != null ? `${m.toLocaleString('pt-BR')} atribuídos a produto` : undefined;
  };
  return (
    <KpiStrip label="Totais do período (GA4) — Store inteira">
      <KpiCard title="Itens visualizados" value={observed.itemsViewed} helper={helperAtribuido('itemsViewed')} />
      <KpiCard title="Itens adicionados ao carrinho" value={observed.itemsAddedToCart} helper={helperAtribuido('itemsAddedToCart')} />
      <KpiCard title="Itens em checkout" value={observed.itemsCheckedOut} helper={helperAtribuido('itemsCheckedOut')} />
      <KpiCard title="Itens comprados (observados)" value={observed.itemsPurchased} helper={helperAtribuido('itemsPurchased')} />
      <KpiCard title="Receita GA4 (itemRevenue)" value={observed.itemRevenue != null ? formatValor(observed.itemRevenue) : null} helper={matched?.itemRevenue != null ? `${formatValor(matched.itemRevenue)} atribuídos a produto` : undefined} />
    </KpiStrip>
  );
}

// Rodada M · achado real: o catálogo canônico (commerce_products) — do qual TODA identidade de
// produto nesta tela depende — não tinha NENHUM jeito de ser sincronizado em produção antes desta
// rodada (runCatalogSync só era chamada em teste). Catálogo vazio aqui não significa "sem produto
// na loja"; significa "nunca sincronizado" — daí o botão em vez de só uma mensagem, e o polling do
// status (a varredura é de minutos, nunca síncrona numa resposta HTTP — mesmo padrão do botão
// "Sincronizar catálogo" de /admin/produtos, que sincroniza uma tabela DIFERENTE e não resolve isto).
function CatalogoVazio({ onSincronizado }: { onSincronizado: () => void }) {
  const [statusSync, setStatusSync] = useState<CommerceCatalogSyncStatus | null>(null);
  const [erro, setErro] = useState('');
  const [disparando, setDisparando] = useState(false);

  function carregarStatus() {
    getCommerceCatalogSyncStatus().then(setStatusSync).catch(() => setStatusSync(null));
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregarStatus, []);

  // Enquanto uma sincronização está rodando (disparada aqui ou em outra aba/sessão), acompanha por
  // polling; para assim que o último run sair de "syncing" — nunca um intervalo permanente.
  useEffect(() => {
    if (!statusSync?.syncing) return undefined;
    const id = setInterval(carregarStatus, 15000);
    return () => clearInterval(id);
  }, [statusSync?.syncing]);

  useEffect(() => {
    if (statusSync && !statusSync.syncing && statusSync.lastRun && statusSync.lastRun.status !== 'failed') onSincronizado();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSync?.syncing]);

  function disparar() {
    setErro('');
    setDisparando(true);
    syncCommerceCatalog()
      .then(() => { setTimeout(carregarStatus, 3000); })
      .catch((err: Error) => setErro(err.message))
      .finally(() => setDisparando(false));
  }

  const rodando = disparando || !!statusSync?.syncing;
  const ultimoRun = statusSync?.lastRun;
  const falhou = ultimoRun?.status === 'failed' && !rodando;

  return (
    <EmptyState
      title="Nenhum produto no catálogo"
      description={
        falhou
          ? `A última sincronização do catálogo falhou${ultimoRun?.errorCode ? ` (${ultimoRun.errorCode})` : ''}. Tente novamente.`
          : 'O catálogo canônico — usado por Desempenho de Produtos e pela Jornada de Compra — ainda não foi sincronizado com a Ink.'
      }
      action={(
        <div className="ds-stack">
          <Button variant="secondary" size="sm" onClick={disparar} disabled={rodando}>
            {rodando ? 'Sincronizando catálogo…' : 'Sincronizar catálogo'}
          </Button>
          {rodando && (
            <span className="ds-note">
              {ultimoRun ? `${ultimoRun.pagesProcessed} página(s) · ${ultimoRun.productsSeen} produto(s) vistos até agora — ` : ''}
              pode levar alguns minutos; esta tela atualiza sozinha.
            </span>
          )}
          {erro && <span className="ds-note ds-note--warning">{erro}</span>}
        </div>
      )}
    />
  );
}

// Barra de filtros da tabela. Fica SEMPRE montada (mesmo carregando ou sem resultado) — se sumisse a
// cada consulta, o campo que a pessoa está digitando perderia o foco. Situação e "somente com dados"
// valem na hora; os mínimos esperam a pessoa parar de digitar (debounce em VisaoGeral).
function FiltrosDaTabela({ filtros, onChange, onLimpar, ativo }: {
  filtros: FiltrosUI; onChange: (proximo: FiltrosUI) => void; onLimpar: () => void; ativo: boolean;
}) {
  const buscando = filtros.busca.trim() !== '';
  return (
    <section className="pa-filtros" aria-label="Filtros da tabela de produtos">
      <div className="pa-filtros__busca">
        <Field
          label="Buscar produto pelo nome"
          hint={buscando ? 'Busca em uso: os demais filtros ficam de lado e o produto aparece qualquer que seja a situação dele.' : undefined}
        >
          <SearchInput
            aria-label="Buscar produto pelo nome"
            placeholder="Ex.: camiseta preta"
            maxLength={100}
            value={filtros.busca}
            onChange={(e) => onChange({ ...filtros, busca: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Situação do produto" hint={buscando ? undefined : 'Ativo = publicado na Ink'}>
        <Select disabled={buscando} value={filtros.status} onChange={(e) => onChange({ ...filtros, status: e.target.value as ProductAnalyticsStatusFiltro })}>
          <option value="active">Ativos (publicados)</option>
          <option value="inactive">Desativados</option>
          <option value="all">Todos</option>
        </Select>
      </Field>
      {CAMPOS_MINIMO.map(({ chave, label }) => (
        <Field key={chave} label={label}>
          <Input
            type="number"
            min={0}
            step={chave === 'minRevenue' ? 'any' : 1}
            inputMode={chave === 'minRevenue' ? 'decimal' : 'numeric'}
            placeholder="0"
            disabled={buscando}
            value={filtros[chave]}
            onChange={(e) => onChange({ ...filtros, [chave]: e.target.value })}
          />
        </Field>
      ))}
      <div className="pa-filtros__acoes">
        <Checkbox
          label="Somente com dados"
          description="Esconde produtos sem nenhum evento no período"
          disabled={buscando}
          checked={filtros.hasData}
          onChange={(e) => onChange({ ...filtros, hasData: e.target.checked })}
        />
        {ativo && <Button variant="ghost" size="sm" onClick={onLimpar}>{buscando ? 'Limpar busca' : 'Limpar filtros'}</Button>}
      </div>
    </section>
  );
}

// "Desativado" sem motivo é pouco: a Ink diz por que (Não publicado, Recusado, Arte inválida…) e a tela
// Produtos já traduz isso — mesmo mapa aqui. Sem status conhecido, cai em "Desativado".
function SeloDesativado({ item }: { item: ProductAnalyticsItem }) {
  if (item.product.isActive !== false) return null;
  const { label } = lookup(PRODUCT_STATUS_MAP, item.product.providerStatus, 'Desativado');
  return <> <StatusBadge tone="neutral" label={label === 'Publicado' ? 'Fora da Ink' : label} /></>;
}

function VisaoGeral({ periodo, onAbrirProduto }: { periodo: Periodo; onAbrirProduto: (id: string) => void }) {
  const [sort, setSort] = useState<TableSort>(SORT_INICIAL);
  const [page, setPage] = useState(1);
  const [filtros, setFiltros] = useState<FiltrosUI>(FILTROS_VAZIOS);
  const [aplicados, setAplicados] = useState<FiltrosUI>(FILTROS_VAZIOS);
  const [data, setData] = useState<ProductAnalyticsListResponse | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [resumo, setResumo] = useState<ProductAnalyticsSummary | null>(null);
  const [erro, setErro] = useState('');
  const [erroResumo, setErroResumo] = useState('');
  // Só a resposta da consulta MAIS RECENTE vale: digitar rápido ou trocar de página dispara várias, e
  // uma resposta antiga que chega atrasada não pode sobrescrever a atual.
  const requisicao = useRef(0);

  function carregar() {
    const id = ++requisicao.current;
    setErro('');
    setCarregando(true);
    listProductAnalytics({
      startDate: periodo.startDate, endDate: periodo.endDate, limit: LIMIT,
      cursor: page > 1 ? String(page) : undefined,
      sort: sort.key as ProductAnalyticsSortField, sortDir: sort.direction,
      ...paraFiltros(aplicados),
    })
      .then((r) => { if (id === requisicao.current) setData(r); })
      .catch((err: Error) => { if (id === requisicao.current) setErro(err.message); })
      .finally(() => { if (id === requisicao.current) setCarregando(false); });
  }

  function carregarResumo() {
    setErroResumo('');
    setResumo(null);
    getProductAnalyticsSummary(periodo).then(setResumo).catch((err: Error) => setErroResumo(err.message));
  }

  // Espera a pessoa parar de digitar antes de consultar, e volta pra página 1 quando o filtro muda.
  useEffect(() => {
    const t = setTimeout(() => {
      setAplicados(filtros);
      setPage(1);
    }, DEBOUNCE_FILTROS_MS);
    return () => clearTimeout(t);
  }, [filtros]);

  const chaveAplicada = chaveDosFiltros(aplicados);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregar, [periodo.startDate, periodo.endDate, sort.key, sort.direction, page, chaveAplicada]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(carregarResumo, [periodo.startDate, periodo.endDate]);

  function onSortChange(novo: TableSort) {
    setSort(novo);
    setPage(1);
  }

  function limparFiltros() {
    setFiltros(FILTROS_VAZIOS);
    setAplicados(FILTROS_VAZIOS);
    setPage(1);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.totalCount / LIMIT)) : 1;
  const filtroAtivo = temFiltroAtivo(aplicados);
  const buscando = aplicados.busca.trim() !== '';

  return (
    <div className="ds-stack">
      {erroResumo && <ErrorState description={erroResumo} onRetry={carregarResumo} />}
      {!erroResumo && !resumo && <Skeleton rows={2} />}
      {!erroResumo && resumo && <CartoesDeTotais resumo={resumo} />}

      {data && (
        <KpiStrip label="Cobertura de identidade no período">
          <KpiCard title="Produtos na tabela" value={data.totalCount} helper={buscando ? 'Resultado da busca' : filtroAtivo ? 'Com os filtros aplicados' : 'Ativos (publicados) da Store'} />
          <KpiCard title="Ids observados pelo GA4" value={data.coverage.observedAnalyticsIds} helper="itemId distintos no período (produto, variante ou SKU)" />
          <KpiCard
            title="Identidade resolvida"
            value={data.coverage.status === 'insufficient_data' ? '—' : `${data.coverage.matchedAnalyticsIds}/${data.coverage.observedAnalyticsIds}`}
            helper={data.coverage.coverageRate != null ? `${Math.round(data.coverage.coverageRate * 100)}% de cobertura` : 'Sem dado suficiente no período'}
          />
        </KpiStrip>
      )}

      {data && data.coverage.status === 'insufficient_data' && (
        <Callout tone="info" title="Sem dados de analytics neste período">
          Nenhum evento foi observado pelo GA4 entre {periodo.startDate} e {periodo.endDate}. Isso não significa zero vendas — pode ser um período sem dado coletado ainda.
        </Callout>
      )}

      <FiltrosDaTabela filtros={filtros} onChange={setFiltros} onLimpar={limparFiltros} ativo={temFiltroAtivo(filtros)} />

      <div className="pa-ordem">
        {buscando ? (
          <span className="ds-note">
            Resultados da busca: produtos de qualquer situação, com mais dados primeiro (depois, por nome). A ordenação por coluna fica desligada durante a busca.
          </span>
        ) : sort.key === 'data' ? (
          <span className="ds-note">
            Mais dados primeiro: ordenado por visualizações + carrinho + checkout + compras no período. Produtos sem dado vêm depois, por nome. Clique numa coluna para ordenar por ela.
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onSortChange(SORT_INICIAL)}>Voltar para “mais dados primeiro”</Button>
        )}
      </div>

      {erro ? (
        <ErrorState description={erro} onRetry={carregar} />
      ) : !data ? (
        <Skeleton variant="table" rows={6} />
      ) : data.items.length === 0 ? (
        filtroAtivo ? (
          <EmptyState
            title={buscando ? 'Nenhum produto com esse nome' : 'Nenhum produto com esses filtros'}
            description={buscando
              ? `Nenhum produto do catálogo tem “${aplicados.busca.trim()}” no nome. Confira a grafia ou busque só uma palavra.`
              : 'Nenhum produto atende a todos os filtros neste período. Afrouxe um mínimo ou troque a situação para ver mais.'}
            action={<Button variant="secondary" size="sm" onClick={limparFiltros}>{buscando ? 'Limpar busca' : 'Limpar filtros'}</Button>}
          />
        ) : (
          <CatalogoVazio onSincronizado={carregar} />
        )
      ) : (
        <div className={carregando ? 'pa-tabela pa-tabela--carregando' : 'pa-tabela'} aria-busy={carregando}>
          <DataTable
            label="Desempenho de produtos"
            rows={data.items}
            rowKey={(it) => it.product.id}
            onRowClick={(it: ProductAnalyticsItem) => onAbrirProduto(it.product.id)}
            sort={sort}
            onSortChange={onSortChange}
            sortable={!buscando}
            columns={[
              { key: 'img', priority: 'low', label: 'Foto', hideLabel: true, width: 48, render: (it) => <Thumb item={it} /> },
              { key: 'name', label: 'Produto', truncate: true, width: 240, render: (it) => it.product.name, sortValue: (it) => it.product.name },
              {
                key: 'provider', label: 'Origem', priority: 'low', muted: true, truncate: true,
                render: (it) => (
                  <>
                    {`${it.product.provider} · ${it.product.providerProductId}`}
                    <SeloDesativado item={it} />
                  </>
                ),
              },
              { key: 'itemsViewed', label: 'Visualizados', align: 'right', firstSortDirection: 'desc', render: (it) => it.metrics?.itemsViewed ?? '—', sortValue: (it) => it.metrics?.itemsViewed },
              { key: 'itemsAddedToCart', label: 'No carrinho', align: 'right', firstSortDirection: 'desc', priority: 'low', render: (it) => it.metrics?.itemsAddedToCart ?? '—', sortValue: (it) => it.metrics?.itemsAddedToCart },
              { key: 'itemsCheckedOut', label: 'Em checkout', align: 'right', firstSortDirection: 'desc', priority: 'low', render: (it) => it.metrics?.itemsCheckedOut ?? '—', sortValue: (it) => it.metrics?.itemsCheckedOut },
              { key: 'itemsPurchased', label: 'Comprados (obs.)', align: 'right', firstSortDirection: 'desc', render: (it) => it.metrics?.itemsPurchased ?? '—', sortValue: (it) => it.metrics?.itemsPurchased },
              { key: 'itemRevenue', label: 'Receita GA4', align: 'right', firstSortDirection: 'desc', render: (it) => (it.metrics?.itemRevenue != null ? formatValor(it.metrics.itemRevenue) : '—'), sortValue: (it) => it.metrics?.itemRevenue },
              {
                key: 'itemsPurchasedPerItemViewed', label: 'Compra/visualização', align: 'right', priority: 'low', firstSortDirection: 'desc',
                render: (it) => formatarRazao(it.itemRatios.itemsPurchasedPerItemViewed), sortValue: (it) => it.itemRatios.itemsPurchasedPerItemViewed,
              },
              {
                key: 'diagnostico', label: 'Qualidade do dado', priority: 'low',
                render: (it) => (it.diagnostics.length === 0
                  ? <StatusBadge tone="success" label="Resolvido" />
                  : <StatusBadge tone={diagnosticoTone(it.diagnostics[0])} label={DIAGNOSTICO_LABEL[it.diagnostics[0]] || it.diagnostics[0]} />),
              },
            ]}
          />
          <Pagination
            label="Paginação de desempenho de produtos"
            page={page}
            totalPages={totalPages}
            totalLabel={plural(data.totalCount, 'produto', 'produtos')}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => data.nextCursor && setPage((p) => p + 1)}
          />
        </div>
      )}
    </div>
  );
}

export function DesempenhoProdutosPage() {
  const [periodo, setPeriodo] = useState<Periodo>({ startDate: TRINTA_DIAS_ATRAS, endDate: HOJE });
  const [status, setStatus] = useState<ProductAnalyticsStatus | null>(null);
  const [statusErro, setStatusErro] = useState('');
  // Gate D ("Jornada de Valor"): CTA de "Prioridades de hoje" (Jornada de Compra) chega aqui como
  // /admin/desempenho-produtos?productId=<id> — abre o drawer direto, sem forçar o lojista a
  // procurar o produto de novo na tabela. `productId` some da URL depois de abrir (nunca preso no
  // histórico do navegador — fechar/reabrir o drawer manualmente não reabre o mesmo produto).
  const [searchParams, setSearchParams] = useSearchParams();
  const [drawerId, setDrawerId] = useState<string | null>(() => searchParams.get('productId'));

  useEffect(() => {
    if (searchParams.get('productId')) {
      const proximos = new URLSearchParams(searchParams);
      proximos.delete('productId');
      setSearchParams(proximos, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    getProductAnalyticsStatus().then(setStatus).catch((err: Error) => setStatusErro(err.message));
  }, []);

  const bloqueado = !!status && (!status.analytics.connected || status.analytics.apt === false);

  return (
    <PageStack>
      <PageHeader
        title="Desempenho de produtos"
        description="Itens observados pelo Google Analytics 4, por produto do catálogo — quantidades de item, nunca de usuário, sessão ou pedido."
      />

      <div className="ds-stack">
        <Toolbar label="Filtrar por período">
          <Input type="date" aria-label="Início do período" value={periodo.startDate} max={periodo.endDate} onChange={(e) => setPeriodo((p) => ({ ...p, startDate: e.target.value }))} />
          <Input type="date" aria-label="Fim do período" value={periodo.endDate} min={periodo.startDate} max={HOJE} onChange={(e) => setPeriodo((p) => ({ ...p, endDate: e.target.value }))} />
        </Toolbar>

        {statusErro && <ErrorState description={statusErro} onRetry={() => window.location.reload()} />}
        {!statusErro && !status && <Skeleton rows={3} />}
        {status && <ConexaoIndisponivel status={status} />}

        {!bloqueado && status && (
          <Tabs
            label="Desempenho de produtos"
            tabs={[
              { label: 'Visão geral', render: () => <VisaoGeral periodo={periodo} onAbrirProduto={setDrawerId} /> },
              { label: 'Reconciliação', render: () => <ReconciliacaoPanel periodo={periodo} /> },
            ]}
          />
        )}
      </div>

      {drawerId && <ProdutoPerformanceDrawer productId={drawerId} periodo={periodo} onClose={() => setDrawerId(null)} />}
    </PageStack>
  );
}
