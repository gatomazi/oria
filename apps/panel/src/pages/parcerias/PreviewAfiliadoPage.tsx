import { useEffect, useState } from 'react';
import { Card, DataTable, EmptyState, ErrorState, KpiCard, KpiStrip, PageStack, Skeleton, StatusBadge } from '../../components/ds';
import { brl, dataCurta, ROTULOS_STATUS_LANCAMENTO } from '../../lib/parcerias';
import '../../parcerias.css';

// Link público (capability URL) do PARCEIRO ver as próprias vendas/comissão/saldo — rota ANÔNIMA,
// fora do AppShell e do ProtectedRoute (ver App.tsx). NÃO é login: não há conta nem senha; quem tem
// o link (o segredo vai no FRAGMENTO da URL — `#key=…` — que o navegador NUNCA envia ao servidor,
// mesmo cuidado de AceitarConvitePage.tsx), vê. Por isso este arquivo não importa nada de
// autenticação/sessão/ParceriasLayout: a página precisa funcionar sem NENHUM dos dois.

interface Venda { inkOrderId: string; saleAt: string; itens: number; commissionCents: number; status: string; dueAt: string | null; estimatedPaymentAt: string | null }
interface PreviewDoAfiliado {
  partnerName: string; level: { key: string; label: string } | null;
  kpis: { unidadesAtribuidas: number; commissionTotalCents: number; commissionPaidCents: number; commissionBalanceCents: number };
  vendas: Venda[]; atualizadoEm: string;
}

function tokenDoFragmento(): string {
  const bruto = window.location.hash.replace(/^#/, '');
  if (!bruto) return '';
  const comChave = /^key=(.+)$/.exec(bruto);
  return decodeURIComponent(comChave ? comChave[1] : bruto).trim();
}

export function PreviewAfiliadoPage() {
  const [dado, setDado] = useState<PreviewDoAfiliado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    document.title = 'Suas vendas · Oria';
    const token = tokenDoFragmento();
    if (!token) { setErro('Link incompleto — falta a chave depois de "#key=". Confira o link que você recebeu.'); setCarregando(false); return; }
    (async () => {
      try {
        const r = await fetch('/api/public/afiliados/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        if (!r.ok) { setErro('Este link não é mais válido — pode ter sido revogado ou expirado. Peça um novo à loja.'); return; }
        setDado(await r.json());
      } catch { setErro('Não deu para carregar agora. Confira sua conexão e tente de novo.'); }
      finally { setCarregando(false); }
    })();
  }, []);

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
                {!dado.vendas.length ? (
                  <EmptyState title="Nenhuma venda ainda" description="Assim que uma venda com sua atribuição entrar, ela aparece aqui." />
                ) : (
                  <DataTable<Venda>
                    label="Vendas atribuídas" rows={dado.vendas} rowKey={(v) => v.inkOrderId}
                    columns={[
                      { key: 'p', label: 'Pedido', render: (v) => `#${v.inkOrderId}` },
                      { key: 'd', label: 'Data', render: (v) => dataCurta(v.saleAt) },
                      { key: 'i', label: 'Itens', align: 'right', render: (v) => String(v.itens) },
                      { key: 'c', label: 'Comissão', align: 'right', render: (v) => brl(v.commissionCents) },
                      { key: 's', label: 'Status', render: (v) => { const s = ROTULOS_STATUS_LANCAMENTO[v.status] ?? { label: v.status, tone: 'neutral' as const }; return <StatusBadge tone={s.tone} label={s.label} />; } },
                    ]}
                  />
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
