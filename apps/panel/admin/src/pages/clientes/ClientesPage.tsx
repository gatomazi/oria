import { useEffect, useMemo, useState } from 'react';
import { DataTable, EmptyState, ErrorState, PageHeader, PageStack, SearchInput, Select, Skeleton, StatusBadge, Toolbar } from '../../components/ds';
import { formatData, formatValor, plural } from '../../lib/format';
import { useLojaAtiva } from '../../auth/AuthContext';
import { adminStores } from '../../state/adminStores';
import { getComprasOpcional, getCustomers, type ClienteCompra, type ClienteInk } from '../../api/clientes';

import '../../../../src/pedidos-central.css';
import '../../../../src/clientes.css';

// Porte de src/clientes.js.
interface ClienteCruzado {
  loja: string;
  nome: string;
  email: string | null;
  telefone: string | null;
  documento: string | null;
  aceitaMarketing: boolean;
  totalCompras: number;
  lucroOperacional: number;
  pedidosSemFinanceiro: number;
  ultimaCompraEm: string | null;
  diasSemComprar: number | null;
}

function apenasDigitos(texto: string | null | undefined): string {
  return String(texto || '').replace(/\D/g, '');
}

function normalizar(texto: string | null | undefined): string {
  return String(texto || '').toLowerCase();
}

// Cruza o registro de clientes (API da Ink) com o histórico de compras (agregado do cache local)
// — casa por documento primeiro, depois telefone, mesma ordem de confiabilidade usada no
// anti-spam de carrinho (`clienteJaComprou` no servidor).
function cruzarComCompras(clientes: ClienteInk[], compras: ClienteCompra[]): ClienteCruzado[] {
  const porDocumento: Record<string, ClienteCompra> = {};
  const porTelefone: Record<string, ClienteCompra> = {};
  compras.forEach((c) => {
    const doc = apenasDigitos(c.documento);
    const tel = apenasDigitos(c.telefone);
    if (doc) porDocumento[c.loja + ':' + doc] = c;
    if (tel) porTelefone[c.loja + ':' + tel] = c;
  });

  return clientes.map((c) => {
    const doc = apenasDigitos(c.documento);
    const tel = apenasDigitos(c.telefone);
    const match = (doc && porDocumento[c.loja + ':' + doc]) || (tel && porTelefone[c.loja + ':' + tel]) || null;
    return {
      loja: c.loja,
      nome: c.nome,
      email: c.email,
      telefone: c.telefone,
      documento: c.documento,
      aceitaMarketing: c.aceitaMarketing,
      totalCompras: match ? match.totalCompras : 0,
      lucroOperacional: match ? match.lucroOperacional || 0 : 0,
      pedidosSemFinanceiro: match ? match.pedidosSemFinanceiro || 0 : 0,
      ultimaCompraEm: match ? match.ultimaCompraEm : null,
      diasSemComprar: match ? match.diasSemComprar : null,
    };
  });
}

type Ordem = 'compras_desc' | 'lucro_desc' | 'inativos_primeiro' | 'nome';

export function ClientesPage() {
  const escopo = useLojaAtiva() ?? '';
  const [dados, setDados] = useState<ClienteCruzado[] | null>(null);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [ordem, setOrdem] = useState<Ordem>('compras_desc');
  const [inatividade, setInatividade] = useState('');

  useEffect(() => {
    setErro('');
    setDados(null);
    Promise.all([getCustomers(), getComprasOpcional()])
      .then(([customers, compras]) => setDados(cruzarComCompras(customers.clientes || [], compras.clientes || [])))
      .catch((err: Error) => setErro(err.message));
  }, []);

  const filtrados = useMemo(() => {
    if (!dados) return [];
    // O servidor já devolve só os clientes da Organization ativa.
    const escopados = dados;
    const buscaNorm = normalizar(busca);
    const diasMinimo = inatividade ? Number(inatividade) : null;

    let lista = escopados.filter((c) => {
      const bateBusca =
        !buscaNorm ||
        normalizar(c.nome).includes(buscaNorm) ||
        normalizar(c.email).includes(buscaNorm) ||
        normalizar(c.telefone).includes(buscaNorm);
      if (!bateBusca) return false;
      if (diasMinimo == null) return true;
      // "Sem comprar há X+ dias" também inclui quem nunca teve compra confirmada nenhuma.
      return c.diasSemComprar == null || c.diasSemComprar >= diasMinimo;
    });

    lista = lista.slice().sort((a, b) => {
      if (ordem === 'nome') return (a.nome || '').localeCompare(b.nome || '');
      if (ordem === 'lucro_desc') return b.lucroOperacional - a.lucroOperacional;
      if (ordem === 'inativos_primeiro') {
        const da = a.diasSemComprar == null ? Infinity : a.diasSemComprar;
        const db = b.diasSemComprar == null ? Infinity : b.diasSemComprar;
        return db - da;
      }
      return (b.totalCompras || 0) - (a.totalCompras || 0);
    });

    return lista;
  }, [dados, escopo, busca, ordem, inatividade]);

  return (
    <PageStack>
      <PageHeader
        title="Clientes"
        description={
          dados ? 'Contagem de compras vem do histórico de pedidos já sincronizado (cache local) — não é uma consulta ao vivo.' : undefined
        }
      />

      {erro && <ErrorState description={erro} />}
      {!erro && !dados && <Skeleton variant="table" rows={8} />}
      {!erro && dados && (
        <div className="ds-stack">
          <Toolbar label="Filtrar clientes" end={<span className="ds-toolbar__meta">{plural(filtrados.length, 'cliente encontrado', 'clientes encontrados')}</span>}>
            <SearchInput
              aria-label="Buscar por nome, email ou telefone"
              placeholder="Buscar por nome, email ou telefone…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
            <Select aria-label="Ordenar clientes" value={ordem} onChange={(e) => setOrdem(e.target.value as Ordem)}>
              <option value="compras_desc">Mais compras primeiro</option>
              <option value="lucro_desc">Maior lucro primeiro</option>
              <option value="inativos_primeiro">Sem comprar há mais tempo primeiro</option>
              <option value="nome">Nome (A-Z)</option>
            </Select>
            <Select aria-label="Filtrar por tempo sem comprar" value={inatividade} onChange={(e) => setInatividade(e.target.value)}>
              <option value="">Qualquer cliente</option>
              <option value="30">Sem comprar há 30+ dias</option>
              <option value="60">Sem comprar há 60+ dias</option>
              <option value="90">Sem comprar há 90+ dias</option>
              <option value="180">Sem comprar há 180+ dias</option>
            </Select>
          </Toolbar>

          {!filtrados.length ? (
            <EmptyState title="Nenhum cliente encontrado" />
          ) : (
            <DataTable
              label="Clientes"
              rows={filtrados}
              rowKey={(c, i) => c.loja + ':' + (c.documento || c.telefone || i)}
              columns={[
                { key: 'nome', label: 'Nome', truncate: true, width: 240, render: (c) => c.nome || 'Sem nome', sortValue: (c) => c.nome },
                { key: 'loja', priority: 'low', label: 'Loja', muted: true, render: (c) => adminStores.name(c.loja), sortValue: (c) => adminStores.name(c.loja) },
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
                  render: (c) => (!c.totalCompras ? <span className="ds-table__cell--muted">Sem compra</span> : plural(c.totalCompras, 'compra', 'compras')),
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
          )}
        </div>
      )}
    </PageStack>
  );
}
