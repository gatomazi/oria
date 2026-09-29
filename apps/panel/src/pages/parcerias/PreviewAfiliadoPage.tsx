import { useEffect, useState } from 'react';
import { Button, Card, DataTable, EmptyState, ErrorState, Field, Input, KpiCard, KpiStrip, PageStack, Pagination, Select, Skeleton, StatusBadge, Toolbar } from '../../components/ds';
import type { Tone } from '../../components/ds';
import { brl, dataCurta, ROTULOS_STATUS_LANCAMENTO } from '../../lib/parcerias';
import '../../parcerias.css';

// Link público (capability URL) do PARCEIRO ver as próprias vendas/comissão/saldo — rota ANÔNIMA,
// fora do AppShell e do ProtectedRoute (ver App.tsx). NÃO é login: não há conta nem senha; quem tem
// o link (o segredo vai no FRAGMENTO da URL — `#key=…` — que o navegador NUNCA envia ao servidor,
// mesmo cuidado de AceitarConvitePage.tsx), vê. Por isso este arquivo não importa nada de
// autenticação/sessão/ParceriasLayout: a página precisa funcionar sem NENHUM dos dois.

interface Venda {
  inkOrderId: string; saleAt: string; itens: number; commissionCents: number; paidCents: number; status: string;
  paymentStatus: 'pago' | 'parcial' | 'pendente'; dueAt: string | null; estimatedPaymentAt: string | null;
}
interface PreviewDoAfiliado {
  partnerName: string; level: { key: string; label: string } | null;
  kpis: { unidadesAtribuidas: number; commissionTotalCents: number; commissionPaidCents: number; commissionBalanceCents: number };
  vendas: Venda[]; paginacao: { page: number; totalPages: number; total: number }; atualizadoEm: string;
}

const ROTULOS_PAGAMENTO: Record<Venda['paymentStatus'], { label: string; tone: Tone }> = {
  pago: { label: 'Pago', tone: 'success' }, parcial: { label: 'Parcial', tone: 'warning' }, pendente: { label: 'A receber', tone: 'neutral' },
};

function tokenDoFragmento(): string {
  const bruto = window.location.hash.replace(/^#/, '');
  if (!bruto) return '';
  const comChave = /^key=(.+)$/.exec(bruto);
  return decodeURIComponent(comChave ? comChave[1] : bruto).trim();
}

const FILTROS_INICIAIS = { desde: '', ate: '', status: '', page: 1 };

export function PreviewAfiliadoPage() {
  const [dado, setDado] = useState<PreviewDoAfiliado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [filtros, setFiltros] = useState(FILTROS_INICIAIS);
  const [token] = useState(tokenDoFragmento);

  useEffect(() => {
    document.title = 'Suas vendas · Oria';
    if (!token) { setErro('Link incompleto — falta a chave depois de "#key=". Confira o link que você recebeu.'); setCarregando(false); return; }
    setCarregando(true);
    (async () => {
      try {
        const r = await fetch('/api/public/afiliados/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, desde: filtros.desde || undefined, ate: filtros.ate || undefined, status: filtros.status || undefined, page: filtros.page }),
        });
        if (!r.ok) { setErro('Este link não é mais válido — pode ter sido revogado ou expirado. Peça um novo à loja.'); return; }
        setDado(await r.json());
        setErro(null);
      } catch { setErro('Não deu para carregar agora. Confira sua conexão e tente de novo.'); }
      finally { setCarregando(false); }
    })();
  }, [token, filtros]);

  // Qualquer troca de filtro volta pra página 1 — senão a pessoa pode ficar numa página que não existe mais no novo recorte.
  function alterarFiltro(patch: Partial<typeof FILTROS_INICIAIS>) { setFiltros((f) => ({ ...f, ...patch, page: 'page' in patch ? (patch.page as number) : 1 })); }

  return (
    <div className="pa-preview-publico">
      <div className="pa-preview-publico__container">
        <PageStack>
          <header className="pa-preview-publico__cabecalho">
            <span className="pa-preview-publico__marca">Oria</span>
            <h1>{dado ? dado.partnerName : 'Suas vendas'}</h1>
            {dado?.level && <StatusBadge tone="info" label={`Nível ${dado.level.label}`} />}
          </header>

          {carregando && <PageStack><Skeleton rows={1} height="80px" /><Skeleton variant="table" rows={4} /></PageStack>}

          {!carregando && erro && <ErrorState title="Não foi possível abrir" description={erro} />}

          {!carregando && dado && (
            <>
              <KpiStrip label="Resumo">
                <KpiCard title="Unidades atribuídas" value={String(dado.kpis.unidadesAtribuidas)} />
                <KpiCard title="Comissão total" value={brl(dado.kpis.commissionTotalCents)} />
                <KpiCard title="Já pago" value={brl(dado.kpis.commissionPaidCents)} />
                <KpiCard title="Saldo em aberto" value={brl(dado.kpis.commissionBalanceCents)} helper="liberado + previsto, ainda não pago" />
              </KpiStrip>

              <Card title="Vendas" description="Um pedido por linha; a comissão é a soma dos itens seus nele.">
                <Toolbar label="Filtrar vendas" end={<span className="ds-toolbar__meta">{dado.paginacao.total} {dado.paginacao.total === 1 ? 'venda' : 'vendas'}</span>}>
                  <Field label="De"><Input type="date" value={filtros.desde} max={filtros.ate || undefined} onChange={(e) => alterarFiltro({ desde: e.target.value })} /></Field>
                  <Field label="Até"><Input type="date" value={filtros.ate} min={filtros.desde || undefined} onChange={(e) => alterarFiltro({ ate: e.target.value })} /></Field>
                  <Select aria-label="Pagamento" controlSize="sm" value={filtros.status} onChange={(e) => alterarFiltro({ status: e.target.value })}>
                    <option value="">Pago e a receber</option>
                    <option value="pago">Só pago</option>
                    <option value="pendente">Só a receber</option>
                  </Select>
                  {(filtros.desde || filtros.ate || filtros.status) && (
                    <Button variant="ghost" size="sm" onClick={() => setFiltros(FILTROS_INICIAIS)}>Limpar filtros</Button>
                  )}
                </Toolbar>

                {!dado.vendas.length ? (
                  <EmptyState
                    title={filtros.desde || filtros.ate || filtros.status ? 'Nenhuma venda nesse filtro' : 'Nenhuma venda ainda'}
                    description={filtros.desde || filtros.ate || filtros.status ? 'Tente ampliar o período ou trocar o filtro de pagamento.' : 'Assim que uma venda com sua atribuição entrar, ela aparece aqui.'}
                  />
                ) : (
                  <>
                    <DataTable<Venda>
                      label="Vendas atribuídas" rows={dado.vendas} rowKey={(v) => v.inkOrderId}
                      columns={[
                        { key: 'p', label: 'Pedido', render: (v) => `#${v.inkOrderId}` },
                        { key: 'd', label: 'Data', render: (v) => dataCurta(v.saleAt) },
                        { key: 'i', label: 'Itens', align: 'right', render: (v) => String(v.itens) },
                        { key: 'c', label: 'Comissão', align: 'right', render: (v) => brl(v.commissionCents) },
                        { key: 'g', label: 'Pagamento', render: (v) => { const s = ROTULOS_PAGAMENTO[v.paymentStatus]; return <StatusBadge tone={s.tone} label={s.label} />; } },
                        { key: 's', label: 'Status', render: (v) => { const s = ROTULOS_STATUS_LANCAMENTO[v.status] ?? { label: v.status, tone: 'neutral' as const }; return <StatusBadge tone={s.tone} label={s.label} />; } },
                      ]}
                    />
                    {dado.paginacao.totalPages > 1 && (
                      <Pagination
                        page={dado.paginacao.page} totalPages={dado.paginacao.totalPages} label="Paginação das vendas"
                        onPrev={() => alterarFiltro({ page: dado.paginacao.page - 1 })} onNext={() => alterarFiltro({ page: dado.paginacao.page + 1 })}
                      />
                    )}
                  </>
                )}
              </Card>
              <p className="pa-preview-publico__rodape">Atualizado em {dataCurta(dado.atualizadoEm)}, {new Date(dado.atualizadoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Valores previstos podem mudar até serem liberados.</p>
            </>
          )}
        </PageStack>
      </div>
    </div>
  );
}
