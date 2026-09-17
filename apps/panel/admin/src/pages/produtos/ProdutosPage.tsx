import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Button, DataTable, EmptyState, ErrorState, Icon, InfoTooltip, PageHeader, PageStack, Pagination, SearchInput, Select, Skeleton, StatusBadge, Toolbar, type TableSort,
} from '../../components/ds';
import { formatData, formatValor, idadeDoCache, plural } from '../../lib/format';
import { lookup, PRODUCT_APPROVAL_STATUS_MAP, PRODUCT_STATUS_MAP } from '../../lib/statusMap';
import { useLojaAtiva } from '../../auth/AuthContext';
import {
  listProdutos, sincronizarFeedProdutos, getFeedProdutosStatus,
  sincronizarCatalogoCache, getCatalogoCacheStatus,
  type ProdutoSummary, type FeedProdutosStatusLoja, type CatalogoCacheStatusLoja,
} from '../../api/produtos';
import { ProdutoDrawer } from './ProdutoDrawer';

import '../../../../src/pedidos-central.css';
import '../../../../src/produtos.css';

// Página piloto do design system (DESIGN.md): PageStack + PageHeader com status do cache em
// metadado, toolbar de filtros, tabela com colunas tipadas e paginação de rodapé. Mesma lógica,
// mesmos endpoints e mesmos textos de antes — só a composição mudou.
// "Todas as lojas" é um modo real (aproximado, sem paginação) tratado pelo próprio backend — não
// cai pra 1ª loja.
function Thumb({ p }: { p: ProdutoSummary }) {
  if (p.mainImageUrl) return <img className="pr-thumb" src={p.mainImageUrl} alt="" loading="lazy" />;
  return (
    <div className="pr-thumb pr-thumb--placeholder" title="Sem foto">
      <Icon name="image" />
      <span className="ds-sr-only">Sem foto</span>
    </div>
  );
}

export function ProdutosPage() {
  const loja = useLojaAtiva() ?? '';

  const [visivel, setVisivel] = useState('');
  const [aprovacao, setAprovacao] = useState('');
  const [nome, setNome] = useState('');
  const [page, setPage] = useState(1);
  // Ordenação feita no banco sobre o catálogo inteiro (só quando a fonte é o cache do catálogo).
  const [ordenacao, setOrdenacao] = useState<TableSort>({ key: 'atualizado', direction: 'desc' });

  const [data, setData] = useState<Awaited<ReturnType<typeof listProdutos>> | null>(null);
  const [erro, setErro] = useState('');
  const [drawerId, setDrawerId] = useState<{ loja: string; id: number } | null>(null);
  // 'auto' deixa o servidor decidir (cache do catálogo primeiro, feed depois); 'ink' é o escape
  // pra ver o estado ao vivo da Ink sem esperar o próximo sync, e volta pra 'auto' assim que o
  // filtro muda.
  const [fonte, setFonte] = useState<'auto' | 'ink'>('auto');
  const [avisoCache, setAvisoCache] = useState('');
  // Status do cache fica visível sempre, não só quando a busca cai nele: sem isso não dá pra saber
  // se o cache existe, está vazio ou falhou — o fallback pra Ink é silencioso de propósito.
  const [feedStatus, setFeedStatus] = useState<FeedProdutosStatusLoja[] | null>(null);
  const [catalogoStatus, setCatalogoStatus] = useState<CatalogoCacheStatusLoja[] | null>(null);

  function carregarFeedStatus() {
    getFeedProdutosStatus().then((r) => setFeedStatus(r.lojas)).catch(() => setFeedStatus(null));
  }
  function carregarCatalogoStatus() {
    getCatalogoCacheStatus().then((r) => setCatalogoStatus(r.lojas)).catch(() => setCatalogoStatus(null));
  }
  useEffect(carregarFeedStatus, []);
  useEffect(carregarCatalogoStatus, []);

  function carregar() {
    setErro('');
    setData(null);
    listProdutos({
      visible_in_store: visivel, approval_status: aprovacao, name: nome, page, per_page: 20,
      fonte: fonte === 'ink' ? 'ink' : undefined,
      sort: fonte === 'ink' ? undefined : ordenacao.key,
      order: fonte === 'ink' ? undefined : ordenacao.direction,
    })
      .then(setData)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [loja, visivel, aprovacao, nome, page, fonte, ordenacao.key, ordenacao.direction]);

  function onBuscaChange(v: string) {
    setNome(v);
    setPage(1);
    setFonte('auto');
  }
  function onVisivelChange(v: string) {
    setVisivel(v);
    setPage(1);
    setFonte('auto');
  }
  function onAprovacaoChange(v: string) {
    setAprovacao(v);
    setPage(1);
    setFonte('auto');
  }

  function atualizarCache() {
    setAvisoCache('Atualizando o cache em segundo plano — leva cerca de 1 minuto. Refaça a busca depois disso.');
    sincronizarFeedProdutos()
      .then(() => { setTimeout(carregarFeedStatus, 30000); })
      .catch((err: Error) => setAvisoCache(err.message));
  }

  function atualizarCatalogo() {
    setAvisoCache('Varrendo o catálogo completo da Ink em segundo plano — leva alguns minutos. Acompanhe em Integrações; a busca continua respondendo com o cache atual enquanto isso.');
    sincronizarCatalogoCache()
      .then(() => { setTimeout(carregarCatalogoStatus, 15000); })
      .catch((err: Error) => setAvisoCache(err.message));
  }

  const catalogoRelevante = (catalogoStatus || []).filter((s) => loja === 'all' || s.loja === loja);
  const totalNoCatalogo = catalogoRelevante.reduce((soma, s) => soma + s.total, 0);
  const catalogoSincronizadoMaisAntigo = catalogoRelevante
    .map((s) => s.sincronizadoEm)
    .filter((d): d is string => !!d)
    .sort()[0] || null;
  const catalogoSincronizando = catalogoRelevante.some((s) => s.sincronizando);
  const catalogoComErro = catalogoRelevante.find((s) => s.erro && !s.sincronizando);

  const statusRelevante = (feedStatus || []).filter((s) => loja === 'all' || s.loja === loja);
  const totalEmCache = statusRelevante.reduce((soma, s) => soma + s.total, 0);
  const sincronizadoMaisAntigo = statusRelevante
    .map((s) => s.sincronizadoEm)
    .filter((d): d is string => !!d)
    .sort()[0] || null;
  const lojasSemFeed = statusRelevante.filter((s) => !s.configurado).map((s) => s.loja);
  const lojaComErro = statusRelevante.find((s) => s.erro);

  // Status do cache do catálogo como metadado do cabeçalho: número e idade visíveis, explicação
  // longa sob demanda (InfoTooltip), falha em destaque de atenção.
  const metaCatalogo = catalogoStatus && (
    <>
      {totalNoCatalogo > 0 ? (
        <>
          <span className="ds-num">
            Cache do catálogo: {plural(totalNoCatalogo, 'produto', 'produtos')}
            {catalogoSincronizadoMaisAntigo ? ` · atualizado ${idadeDoCache(catalogoSincronizadoMaisAntigo)}` : ''}
          </span>
          <InfoTooltip content="Inclui desativados e ocultos, e responde todos os filtros desta tela." />
        </>
      ) : (
        <span>
          Cache do catálogo vazio — a busca vai direto na Ink e analisa só os primeiros 5.000 produtos.
          Sincronize pra varrer o catálogo inteiro uma vez.
        </span>
      )}
      {catalogoComErro && (
        <span className="ds-note ds-note--warning">
          Última varredura falhou ({catalogoComErro.loja}): {catalogoComErro.erro}
        </span>
      )}
    </>
  );

  const acoes = [
    catalogoStatus && (
      <Button key="sync" variant="secondary" onClick={atualizarCatalogo} disabled={catalogoSincronizando}>
        {catalogoSincronizando ? 'Sincronizando catálogo…' : 'Sincronizar catálogo'}
      </Button>
    ),
    <Link key="novo" to="/admin/produtos/novo" className="ds-btn ds-btn--primary">
      Novo produto
    </Link>,
  ].filter(Boolean);

  return (
    <PageStack>
      <PageHeader title="Produtos" description="Catálogo sob demanda da sua loja Reserva Ink." meta={metaCatalogo} actions={acoes} />

      {feedStatus && totalNoCatalogo === 0 && (
        <div className="ds-note">
          {totalEmCache > 0 ? (
            <span>
              Cache de produtos ativos: {plural(totalEmCache, 'produto', 'produtos')}
              {sincronizadoMaisAntigo ? ` · atualizado ${idadeDoCache(sincronizadoMaisAntigo)}` : ''}
              {' '}— usado automaticamente quando você busca por nome.
            </span>
          ) : (
            <span>
              Cache de produtos ativos vazio
              {lojasSemFeed.length ? ` — feed de produtos não configurado para: ${lojasSemFeed.join(', ')}` : ' — ainda não sincronizado'}.
              {' '}A busca por nome vai direto na Ink e analisa só os primeiros 5.000 produtos.
            </span>
          )}
          {lojaComErro && (
            <span className="ds-note--warning">
              Última sincronização falhou ({lojaComErro.loja}): {lojaComErro.erro}
            </span>
          )}
          {statusRelevante.some((s) => s.configurado) && (
            <Button variant="secondary" size="sm" onClick={atualizarCache}>
              {statusRelevante.some((s) => s.sincronizando) ? 'Sincronizando…' : 'Atualizar cache'}
            </Button>
          )}
        </div>
      )}

      <div className="ds-stack">
        <Toolbar label="Filtrar produtos">
          <SearchInput
            aria-label="Buscar produtos por nome"
            placeholder="Buscar por nome…"
            defaultValue={nome}
            onBlur={(e) => onBuscaChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onBuscaChange((e.target as HTMLInputElement).value);
            }}
          />
          <Select aria-label="Filtrar por visibilidade" value={visivel} onChange={(e) => onVisivelChange(e.target.value)}>
            <option value="">Visibilidade (todas)</option>
            <option value="true">Visível</option>
            <option value="false">Oculto</option>
          </Select>
          <Select aria-label="Filtrar por aprovação" value={aprovacao} onChange={(e) => onAprovacaoChange(e.target.value)}>
            <option value="">Aprovação (todas)</option>
            {Object.keys(PRODUCT_APPROVAL_STATUS_MAP).map((key) => (
              <option key={key} value={key}>
                {PRODUCT_APPROVAL_STATUS_MAP[key].label}
              </option>
            ))}
          </Select>
        </Toolbar>

        {erro && <ErrorState description={erro} onRetry={carregar} />}
        {!erro && !data && <Skeleton variant="table" rows={8} />}
        {!erro && data && (
          <>
            {data.erros.length > 0 && <p className="ds-note ds-note--warning">{plural(data.erros.length, 'loja', 'lojas')} com falha ao consultar a Reserva Ink agora.</p>}

            {data.fonte === 'catalogo' && (
              <div className="ds-note">
                <span>
                  Resultado do cache do catálogo{data.cacheSincronizadoEm ? ` · atualizado ${idadeDoCache(data.cacheSincronizadoEm)}` : ''}
                  {' '}· catálogo inteiro, sem o limite de 5.000 da busca direta.
                </span>
                <Button variant="ghost" size="sm" onClick={() => setFonte('ink')}>
                  Consultar direto na Ink
                </Button>
              </div>
            )}
            {data.fonte === 'cache' && (
              <div className="ds-note">
                <span>
                  Busca no cache de produtos ativos{data.cacheSincronizadoEm ? ` · atualizado ${idadeDoCache(data.cacheSincronizadoEm)}` : ''}
                  {' '}· inclui todo o catálogo publicado, não só os primeiros 5.000.
                </span>
                <Button variant="ghost" size="sm" onClick={() => setFonte('ink')}>
                  Buscar na Ink (inclui desativados)
                </Button>
                <Button variant="ghost" size="sm" onClick={atualizarCache}>
                  Atualizar cache
                </Button>
              </div>
            )}
            {avisoCache && <p className="ds-note">{avisoCache}</p>}
            {fonte === 'ink' && data.truncado && (
              <p className="ds-note ds-note--warning">
                Busca direta na Ink: só os primeiros 5.000 produtos da loja foram analisados — o resultado pode estar incompleto.
              </p>
            )}

            {!data.produtos.length ? (
              <EmptyState title="Nenhum produto encontrado" description="Ajuste os filtros ou crie um novo produto." />
            ) : (
              <DataTable
                label="Produtos"
                rows={data.produtos}
                rowKey={(p) => `${p.loja}-${p.id}`}
                onRowClick={(p) => setDrawerId({ loja: p.loja, id: p.id })}
                // Só o cache do catálogo ordena no servidor; nas outras fontes ordenar a página
                // visível daria a impressão errada de ordenar o catálogo todo.
                sortable={data.fonte === 'catalogo'}
                sort={ordenacao}
                onSortChange={(s) => {
                  setOrdenacao(s);
                  setPage(1);
                }}
                columns={[
                  { key: 'img', priority: 'low', label: 'Foto', hideLabel: true, width: 48, render: (p) => <Thumb p={p} /> },
                  { key: 'nome', label: 'Produto', truncate: true, width: 360, render: (p) => p.name || 'Sem nome', sortValue: (p) => p.name },
                  { key: 'tipo', priority: 'low', label: 'Tipo', truncate: true, width: 200, muted: true, render: (p) => p.productType || '—', sortValue: (p) => p.productType },
                  { key: 'preco', label: 'Preço', align: 'right', firstSortDirection: 'desc', render: (p) => formatValor(p.price) || '—', sortValue: (p) => (p.price != null ? Number(p.price) : null) },
                  {
                    key: 'status',
                    label: 'Status',
                    // `status` é o que vale (Publicado / Não publicado / Arte inválida / Recusado).
                    // approval_status NÃO é exibido: a Ink o deixa em "waiting" mesmo com o produto
                    // publicado e vendendo — confirmado no produto 4934698 (approval_status
                    // "waiting", status "published", visible_in_store true e presente no feed da
                    // loja) —, o que fazia a tela inteira dizer "Em curadoria" sem motivo.
                    render: (p) => {
                      const m = lookup(PRODUCT_STATUS_MAP, p.status);
                      return <StatusBadge tone={m.tone} label={m.label} />;
                    },
                    sortValue: (p) => lookup(PRODUCT_STATUS_MAP, p.status).label,
                  },
                  {
                    key: 'visivel',
                    priority: 'low',
                    label: 'Visível',
                    render: (p) => <StatusBadge tone={p.visibleInStore ? 'success' : 'neutral'} label={p.visibleInStore ? 'Visível' : 'Oculto'} />,
                    sortValue: (p) => (p.visibleInStore ? 1 : 0),
                  },
                  { key: 'variantes', priority: 'low', label: 'Variantes', align: 'right', firstSortDirection: 'desc', render: (p) => p.variantsCount ?? '—', sortValue: (p) => p.variantsCount },
                  { key: 'atualizado', priority: 'low', label: 'Atualizado', align: 'right', muted: true, firstSortDirection: 'desc', render: (p) => formatData(p.updatedAt), sortValue: (p) => p.updatedAt },
                ]}
              />
            )}

            {!data.approximated && data.produtos.length > 0 && (
              <Pagination
                label="Paginação de produtos"
                page={data.page}
                totalPages={data.totalPages}
                totalLabel={data.totalCount != null ? plural(data.totalCount, 'produto', 'produtos') : undefined}
                onPrev={() => setPage((p) => p - 1)}
                onNext={() => setPage((p) => p + 1)}
              />
            )}
          </>
        )}
      </div>

      {drawerId && (
        <ProdutoDrawer loja={drawerId.loja} id={drawerId.id} onClose={() => setDrawerId(null)} onChanged={carregar} />
      )}
    </PageStack>
  );
}
