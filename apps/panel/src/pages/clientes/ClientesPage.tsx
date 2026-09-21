import { useEffect, useState } from 'react';
import { DataTable, EmptyState, ErrorState, PageHeader, PageStack, Pagination, SearchInput, Select, Skeleton, StatusBadge, Toolbar } from '../../components/ds';
import { formatData, formatValor, plural } from '../../lib/format';
import { useLojaAtiva } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import { useNomeDaStore } from '../../auth/AuthContext';
import { listClientes, type ListaDeClientes, type OrdemClientes, type TipoClientes } from '../../api/clientes';

import '../../pedidos-central.css';
import '../../clientes.css';

const CLIENTES_POR_PAGINA = 25;
// A busca só vai ao servidor depois de uma pausa na digitação (uma chamada por tecla seria ruído).
const ATRASO_DA_BUSCA_MS = 300;

export function ClientesPage() {
  const nomeStore = useNomeDaStore();
  const escopo = useLojaAtiva() ?? '';
  const [lista, setLista] = useState<ListaDeClientes | null>(null);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');
  const [ordem, setOrdem] = useState<OrdemClientes>('compras_desc');
  const [inatividade, setInatividade] = useState('');
  const [tipo, setTipo] = useState<TipoClientes>('todos');
  const [pagina, setPagina] = useState(1);

  // Filtro ou ordem novos mudam a lista inteira: volta para a primeira página.
  useEffect(() => {
    const t = setTimeout(() => {
      setBuscaAplicada(busca);
      setPagina(1);
    }, ATRASO_DA_BUSCA_MS);
    return () => clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    let atual = true;
    setErro('');
    listClientes({ page: pagina, perPage: CLIENTES_POR_PAGINA, ordem, busca: buscaAplicada, inativoDias: inatividade, tipo })
      .then((r) => {
        if (!atual) return;
        setLista(r);
        // O servidor devolve a página real (a lista pode ter encolhido com o filtro).
        if (r.page !== pagina) setPagina(r.page);
      })
      .catch((err: Error) => { if (atual) setErro(err.message); });
    return () => { atual = false; };
  }, [escopo, pagina, ordem, buscaAplicada, inatividade, tipo]);

  const clientes = lista?.clientes ?? [];

  return (
    <PageStack>
      <PageHeader
        title="Clientes"
        description={
          lista ? 'Quem já fez pedido e quem só tem cadastro na Reserva Ink. A contagem de compras vem do histórico de pedidos já sincronizado (cache local) — não é uma consulta ao vivo.' : undefined
        }
      />

      {erro && <ErrorState description={erro} />}
      {!erro && !lista && <Skeleton variant="table" rows={8} />}
      {!erro && lista && (
        <div className="ds-stack">
          <Toolbar label="Filtrar clientes" end={<span className="ds-toolbar__meta">{plural(lista.total, 'cliente encontrado', 'clientes encontrados')}</span>}>
            <SearchInput
              aria-label="Buscar por nome, email ou telefone"
              placeholder="Buscar por nome, email ou telefone…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <Select aria-label="Filtrar por pedido" value={tipo} onChange={(e) => { setTipo(e.target.value as TipoClientes); setPagina(1); }}>
              <option value="todos">Todos os clientes</option>
              <option value="com_pedido">Com pedido</option>
              <option value="sem_pedido">Só cadastro (nunca pediu)</option>
            </Select>
            <Select aria-label="Ordenar clientes" value={ordem} onChange={(e) => { setOrdem(e.target.value as OrdemClientes); setPagina(1); }}>
              <option value="compras_desc">Mais compras primeiro</option>
              <option value="lucro_desc">Maior lucro primeiro</option>
              <option value="inativos_primeiro">Sem comprar há mais tempo primeiro</option>
              <option value="nome">Nome (A-Z)</option>
            </Select>
            <Select aria-label="Filtrar por tempo sem comprar" value={inatividade} onChange={(e) => { setInatividade(e.target.value); setPagina(1); }}>
              <option value="">Qualquer cliente</option>
              <option value="30">Sem comprar há 30+ dias</option>
              <option value="60">Sem comprar há 60+ dias</option>
              <option value="90">Sem comprar há 90+ dias</option>
              <option value="180">Sem comprar há 180+ dias</option>
            </Select>
          </Toolbar>

          {!lista.cadastro.disponivel && (
            <ErrorState description="O cadastro da Reserva Ink não respondeu agora. Mostrando só quem já fez pedido — tente de novo em instantes." />
          )}
          {lista.cadastro.parcial && (
            <p className="ds-form-note">Cadastro carregado parcialmente: a loja tem mais clientes do que o limite lido de uma vez.</p>
          )}
          {!clientes.length ? (
            <EmptyState title="Nenhum cliente encontrado" />
          ) : (
            <>
            <DataTable
              label="Clientes"
              // A ordem é a do seletor, aplicada no servidor sobre a lista inteira; ordenar pelo cabeçalho só
              // reordenaria a página atual e enganaria.
              sortable={false}
              rows={clientes}
              rowKey={(c) => c.loja + ':' + c.customerKey}
              columns={[
                { key: 'nome', label: 'Nome', truncate: true, width: 240, render: (c) => c.nome || 'Sem nome', sortValue: (c) => c.nome },
                { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (c) => adminStores.nameOr(c.loja, nomeStore), sortValue: (c) => adminStores.nameOr(c.loja, nomeStore) },
                {
                  key: 'contato',
                  priority: 'low',
                  label: 'Contato',
                  truncate: true,
                  width: 320,
                  muted: true,
                  render: (c) => [c.email, c.telefone].filter(Boolean).join(' · ') || '—',
                  sortValue: (c) => c.email || c.telefone,
                },
                {
                  key: 'compras',
                  label: 'Compras',
                  align: 'right',
                  // Contagem não é estado: texto tabular, sem cor semântica (Semantic-Only Rule).
                  render: (c) => (!c.totalCompras ? <span className="ds-table__cell--muted">{c.origem === 'cadastro' ? 'Só cadastro' : 'Sem compra'}</span> : plural(c.totalCompras, 'compra', 'compras')),
                  sortValue: (c) => c.totalCompras,
                },
                {
                  key: 'lucro',
                  label: 'Lucro operacional',
                  align: 'right',
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
                  sortValue: (c) => c.lucroOperacional,
                },
                {
                  key: 'ultimaCompra',
                  priority: 'low',
                  label: 'Última compra',
                  align: 'right',
                  muted: true,
                  render: (c) => (c.ultimaCompraEm ? `${formatData(c.ultimaCompraEm)} (${c.diasSemComprar}d atrás)` : '—'),
                  sortValue: (c) => c.ultimaCompraEm,
                },
                {
                  key: 'marketing',
                  priority: 'low',
                  label: 'Marketing',
                  render: (c) => (c.aceitaMarketing ? <StatusBadge tone="info" label="Aceita" /> : '—'),
                  sortValue: (c) => (c.aceitaMarketing ? 1 : 0),
                },
              ]}
            />
            {lista.totalPages > 1 && (
              <Pagination
                label="Paginação de clientes"
                page={lista.page}
                totalPages={lista.totalPages}
                totalLabel={plural(lista.total, 'cliente', 'clientes')}
                onPrev={() => setPagina((p) => Math.max(1, p - 1))}
                onNext={() => setPagina((p) => Math.min(lista.totalPages, p + 1))}
              />
            )}
            </>
          )}
        </div>
      )}
    </PageStack>
  );
}
