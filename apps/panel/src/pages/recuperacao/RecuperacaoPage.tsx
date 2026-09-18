import { useEffect, useState } from 'react';
import { Button, Checkbox, DataTable, EmptyState, ErrorState, Icon, InfoTooltip, KpiCard, KpiStrip, PageHeader, PageStack, SearchInput, Select, Skeleton, StatusBadge, TabList, Toolbar, Tooltip } from '../../components/ds';
import { copiar, formatData, formatTelefone, formatValor, plural, tempoDesde, waLink } from '../../lib/format';
import { lookup, RECUPERACAO_STATUS_MAP } from '../../lib/statusMap';
import { useLojaAtiva } from '../../auth/AuthContext';
import { getRecuperacao, type RecuperacaoCarrinho, type RecuperacaoData, type RecuperacaoPix } from '../../api/recuperacao';
import { AcoesRecuperacao } from './AcoesRecuperacao';
import { CarrinhoDrawer } from './CarrinhoDrawer';
import { PedidoCentralDrawer } from '../pedidos-central/PedidoCentralDrawer';

import '../../pedidos-central.css';
import '../../recuperacao.css';

// Porte de src/recuperacao.js.
type Tab = 'carrinhos' | 'pix';

// Carrinhos e Pix pendentes vêm sem paginação real do lado da Ink (agregado de todas as lojas,
// pode passar de 300 linhas) — diferente de Pedidos/Trocas/Produtos, que paginam de verdade no
// servidor. Em vez de renderizar tudo de uma vez (achado do usuário: página lenta com listagem
// grande), mostra um lote por vez e carrega mais sob demanda — puramente client-side, não muda
// o que já foi buscado do servidor.
const LOTE = 30;

function BotaoCarregarMais({ total, visivel, onClick }: { total: number; visivel: number; onClick: () => void }) {
  if (total <= visivel) return null;
  return (
    <div className="rc-carregar-mais">
      <Button variant="secondary" onClick={onClick}>
        Carregar mais ({total - visivel} restante{total - visivel === 1 ? '' : 's'})
      </Button>
    </div>
  );
}

function statusBadgeFor(status: string) {
  const meta = lookup(RECUPERACAO_STATUS_MAP, status);
  return <StatusBadge tone={meta.tone} label={meta.label} />;
}

function tentativasLabel(row: { tentativas: number; maxTentativas?: number | null }) {
  return row.tentativas + (row.maxTentativas ? '/' + row.maxTentativas : '');
}

function abandonadoHa(iso: string | null) {
  const t = tempoDesde(iso);
  return t ? t.texto : '—';
}

function ClienteComTelefone({ nome, telefone }: { nome: string | null; telefone: string | null }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <span className="rc-cliente">
      {nome || 'Cliente sem nome'}
      {telefone && (
        <Tooltip content={copiado ? 'Copiado!' : `Copiar: ${telefone}`}>
          <button
            type="button"
            className="ds-icon-btn ds-icon-btn--info"
            aria-label={`Copiar telefone de ${nome || 'cliente'}`}
            onClick={(ev) => {
              ev.stopPropagation();
              copiar(telefone, () => {
                setCopiado(true);
                setTimeout(() => setCopiado(false), 1500);
              });
            }}
          >
            <Icon name="phone" size={14} />
          </button>
        </Tooltip>
      )}
    </span>
  );
}

function resumoCompra(compra: NonNullable<RecuperacaoCarrinho['compra']>) {
  return `Pedido #${compra.inkOrderId}${compra.em ? ' em ' + formatData(compra.em) : ''}${compra.valor != null ? ' · ' + formatValor(compra.valor) : ''}`;
}

// Nome + contato numa célula só (e-mail e telefone numa linha de apoio) — o telefone sozinho num
// ícone escondia com quem se estava falando.
function ClienteCarrinho({ c }: { c: RecuperacaoCarrinho }) {
  const contato = [c.buyerEmail, formatTelefone(c.buyerPhone)].filter(Boolean).join(' · ');
  return (
    <span className="rc-cliente-bloco">
      <ClienteComTelefone nome={c.buyerName} telefone={c.buyerPhone} />
      {contato && <span className="rc-contato">{contato}</span>}
    </span>
  );
}

// Botões de linha não podem abrir o detalhe junto (a linha inteira é clicável).
function naoPropagar(ev: { stopPropagation: () => void }) {
  ev.stopPropagation();
}

export function RecuperacaoPage() {
  const escopo = useLojaAtiva() ?? '';
  const [dados, setDados] = useState<RecuperacaoData | null>(null);
  const [erro, setErro] = useState('');
  const [tab, setTab] = useState<Tab>('carrinhos');
  const [busca, setBusca] = useState('');
  const [status, setStatus] = useState('');
  const [limiteCarrinhos, setLimiteCarrinhos] = useState(LOTE);
  const [limitePix, setLimitePix] = useState(LOTE);
  const [esconderComprados, setEsconderComprados] = useState(false);
  const [detalhe, setDetalhe] = useState<RecuperacaoCarrinho | null>(null);
  const [pedidoAberto, setPedidoAberto] = useState<{ loja: string; inkOrderId: string | number } | null>(null);

  function carregar() {
    setErro('');
    getRecuperacao()
      .then(setDados)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [escopo]);
  // Filtro/busca nova ou troca de aba recomeça o lote — senão o usuário via poucos resultados
  // filtrados "sumindo" atrás de um limite pensado pra lista inteira.
  useEffect(() => {
    setLimiteCarrinhos(LOTE);
    setLimitePix(LOTE);
  }, [tab, busca, status, escopo, esconderComprados]);

  if (erro) {
    return (
      <>
        <PageHeader title="Recuperação" />
        <ErrorState description={erro} onRetry={carregar} />
      </>
    );
  }
  if (!dados) {
    // Cabeçalho aparece já no carregamento (a consulta à Ink pode levar alguns segundos).
    return (
      <PageStack>
        <PageHeader title="Recuperação" description="Recupere carrinhos abandonados e pagamentos PIX pendentes." />
        <Skeleton rows={1} height="88px" />
        <Skeleton variant="table" rows={6} />
      </PageStack>
    );
  }

  function filtrar<T>(rows: T[], nomeGetter: (r: T) => string | null): T[] {
    return rows.filter((r) => {
      if (status && (r as unknown as { status: string }).status !== status) return false;
      if (busca && !(nomeGetter(r) || '').toLowerCase().includes(busca.toLowerCase())) return false;
      return true;
    });
  }

  const carrinhosFiltrados = filtrar(dados.carrinhos, (c: RecuperacaoCarrinho) => [c.buyerName, c.buyerEmail].filter(Boolean).join(' ')).filter(
    (c) => !esconderComprados || c.status !== 'comprou',
  );

  function acoesCarrinho(c: RecuperacaoCarrinho) {
    if (!c.contactable) return null;
    return (
      <AcoesRecuperacao
        mensagemTemplate={c.mensagemTemplate}
        podeEnviarViaMeta={c.podeEnviarViaMeta}
        waLinkFallback={() => {
          const primeiroNome = c.buyerName ? c.buyerName.split(' ')[0] : '';
          const msg = `Olá${primeiroNome ? ' ' + primeiroNome : ''}! Vi que você deixou ${c.itemsCount || 'alguns'} item(ns) no carrinho. Posso te ajudar a finalizar a compra? 😊`;
          return waLink(c.buyerPhone, msg);
        }}
        enviarUrl="/api/admin/recuperacao/carrinho/enviar"
        enviarBody={{ loja: c.loja, cartId: c.id }}
        onSucesso={carregar}
      />
    );
  }
  const pixFiltrados = filtrar(dados.pix, (p: RecuperacaoPix) => p.cliente);

  return (
    <PageStack>
      <PageHeader title="Recuperação" description="Recupere carrinhos abandonados e pagamentos PIX pendentes." />

      <KpiStrip label="Resultados da recuperação">
        <KpiCard title="Recuperáveis" value={dados.metricas.recuperaveis} />
        {dados.metricas.carrinhosJaComprados != null && (
          <KpiCard title="Já compraram" value={dados.metricas.carrinhosJaComprados} helper="Pedido pago depois do carrinho — não recebem mensagem" />
        )}
        <KpiCard title="Mensagens enviadas" value={dados.metricas.mensagensEnviadas} />
        <KpiCard title="Conversões" value={dados.metricas.carrinhosConvertidos} helper="Só carrinhos — confirmado por nova compra do cliente" />
        <KpiCard title="Receita recuperada" value={formatValor(dados.metricas.receitaRecuperada) || 'R$ 0,00'} helper="Estimada a partir dos carrinhos convertidos" />
      </KpiStrip>

      {dados.erros && dados.erros.length > 0 && <p className="ds-note ds-note--warning">{plural(dados.erros.length, 'loja', 'lojas')} com falha ao consultar a Reserva Ink agora.</p>}

      <div className="ds-stack">
      <TabList
        label="Tipo de recuperação"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'carrinhos', label: 'Carrinhos abandonados', count: dados.carrinhos.length },
          { value: 'pix', label: 'PIX pendentes', count: dados.pix.length },
        ]}
      />

      <Toolbar
        label="Filtrar recuperação"
        end={
          tab === 'pix' && (
            <>
              <a href="/admin/pedidos/novo" className="ds-btn ds-btn--secondary">
                Cadastrar PIX manual
              </a>
              <a href="/admin/pedidos/vincular" className="ds-btn ds-btn--secondary">
                Vincular pedido
              </a>
            </>
          )
        }
      >
        <SearchInput
          aria-label={tab === 'carrinhos' ? 'Buscar por nome ou e-mail do cliente' : 'Buscar por cliente'}
          placeholder={tab === 'carrinhos' ? 'Buscar por nome ou e-mail…' : 'Buscar por cliente…'}
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
        <Select aria-label="Filtrar por status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status (todos)</option>
          {Object.keys(RECUPERACAO_STATUS_MAP).map((key) => (
            <option key={key} value={key}>
              {RECUPERACAO_STATUS_MAP[key].label}
            </option>
          ))}
        </Select>
        {tab === 'carrinhos' && (
          <Checkbox label="Esconder quem já comprou" checked={esconderComprados} onChange={(e) => setEsconderComprados(e.target.checked)} />
        )}
      </Toolbar>

      {tab === 'carrinhos' ? (
        !carrinhosFiltrados.length ? (
          <EmptyState title="Nenhum carrinho encontrado" description="Carrinhos abandonados das lojas aparecem aqui assim que a Ink registra. Ajuste a busca ou os filtros acima." />
        ) : (
          <>
          <DataTable
            rows={carrinhosFiltrados.slice(0, limiteCarrinhos)}
            rowKey={(c) => `${c.loja}:${c.id}`}
            label="Carrinhos abandonados"
            onRowClick={setDetalhe}
            columns={[
              {
                key: 'cliente',
                label: 'Cliente',
                render: (c) => <ClienteCarrinho c={c} />,
                sortValue: (c) => c.buyerName,
              },
              { key: 'itens', priority: 'low', label: 'Itens', align: 'right', render: (c) => c.itemsCount || 0, sortValue: (c) => c.itemsCount },
              { key: 'valor', priority: 'low', label: 'Valor', align: 'right', render: (c) => formatValor(c.valor) || '—', sortValue: (c) => (c.valor != null ? Number(c.valor) : null) },
              { key: 'ha', priority: 'low', label: 'Abandonado há', align: 'right', render: (c) => abandonadoHa(c.updatedAt), sortValue: (c) => c.updatedAt },
              { key: 'tentativas', priority: 'low', label: 'Tentativas', align: 'right', render: tentativasLabel, sortValue: (c) => c.tentativas },
              {
                key: 'status',
                label: 'Status',
                render: (c) => (
                  <span className="rc-status-cell">
                    {statusBadgeFor(c.status)}
                    {c.compra && <InfoTooltip content={`${resumoCompra(c.compra)}. Recuperação encerrada — nenhuma mensagem é enviada.`} />}
                    {c.arquivado && (
                      <InfoTooltip content="A Ink já apagou esse carrinho (30+ dias) — dados salvos aqui no primeiro momento em que foi observado." />
                    )}
                  </span>
                ),
                sortValue: (c) => c.status,
              },
              {
                key: 'acao',
                label: 'Ações',
                hideLabel: true,
                align: 'right',
                render: (c) => (
                  <span className="rc-acoes-cell" onClick={naoPropagar}>
                    {c.compra ? (
                      <Button variant="ghost" size="sm" onClick={() => setPedidoAberto({ loja: c.loja, inkOrderId: c.compra!.inkOrderId })}>
                        Ver pedido
                      </Button>
                    ) : (
                      acoesCarrinho(c) || '—'
                    )}
                  </span>
                ),
              },
            ]}
          />
          <BotaoCarregarMais total={carrinhosFiltrados.length} visivel={limiteCarrinhos} onClick={() => setLimiteCarrinhos((l) => l + LOTE)} />
          </>
        )
      ) : !pixFiltrados.length ? (
        <EmptyState title="Nenhum PIX pendente encontrado" />
      ) : (
        <>
        <DataTable
          rows={pixFiltrados.slice(0, limitePix)}
          rowKey={(p) => `${p.loja}:${p.inkOrderId}`}
          columns={[
            { key: 'pedido', label: 'Pedido', render: (p) => `#${p.inkOrderId}`, sortValue: (p) => Number(p.inkOrderId) || null },
            {
              key: 'cliente',
              label: 'Cliente',
              render: (p) => <ClienteComTelefone nome={p.cliente} telefone={p.buyerPhone} />,
              sortValue: (p) => p.cliente,
            },
            { key: 'valor', label: 'Valor', align: 'right', render: (p) => formatValor(p.valor) || '—', sortValue: (p) => (p.valor != null ? Number(p.valor) : null) },
            { key: 'criado', priority: 'low', label: 'Criado', align: 'right', muted: true, render: (p) => formatData(p.criadoEm), sortValue: (p) => p.criadoEm },
            { key: 'expiracao', priority: 'low', label: 'Expiração', align: 'right', muted: true, render: (p) => (p.expiracao ? formatData(p.expiracao) : '—'), sortValue: (p) => p.expiracao },
            { key: 'tentativas', priority: 'low', label: 'Tentativas', align: 'right', render: tentativasLabel, sortValue: (p) => p.tentativas },
            { key: 'status', label: 'Status', render: (p) => statusBadgeFor(p.status), sortValue: (p) => p.status },
            {
              key: 'acao',
              label: 'Ações',
              hideLabel: true,
              align: 'right',
              render: (p) => (
                <AcoesRecuperacao
                  mensagemTemplate={p.mensagemTemplate}
                  podeEnviarViaMeta={p.podeEnviarViaMeta}
                  waLinkFallback={() => waLink(p.buyerPhone, 'Olá! Seu pagamento PIX ainda está pendente, posso te ajudar a finalizar?')}
                  enviarUrl="/api/admin/recuperacao/pix/enviar"
                  enviarBody={{ loja: p.loja, inkOrderId: p.inkOrderId }}
                  onSucesso={carregar}
                />
              ),
            },
          ]}
        />
        <BotaoCarregarMais total={pixFiltrados.length} visivel={limitePix} onClick={() => setLimitePix((l) => l + LOTE)} />
        </>
      )}
      </div>

      {detalhe && (
        <CarrinhoDrawer
          carrinho={detalhe}
          onClose={() => setDetalhe(null)}
          onVerPedido={(inkOrderId) => {
            setDetalhe(null);
            setPedidoAberto({ loja: detalhe.loja, inkOrderId });
          }}
          acoes={acoesCarrinho(detalhe)}
        />
      )}
      {pedidoAberto && <PedidoCentralDrawer loja={pedidoAberto.loja} inkOrderId={pedidoAberto.inkOrderId} onClose={() => setPedidoAberto(null)} />}
    </PageStack>
  );
}
