import { useEffect, useState } from 'react';
import { Card, DataTable, EmptyState, ErrorState, PageHeader, Skeleton, StatusBadge } from '../../components/ds';
import { formatData } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import { getIntegrations, type IntegrationsData } from '../../api/integracoes';
import { loadEntitlements } from '../../state/entitlements';
import { NOME_DO_PROVIDER, rotuloDaApiInk, rotuloDoWebhookInk, seloDoEstado } from './estadoIntegracao';
import { BackfillPedidosCard } from './BackfillPedidosCard';
import { CatalogoCacheCard } from './CatalogoCacheCard';
import { lojasComTokenInk } from './lojaOpcao';
import { InkCredenciaisCard } from './InkCredenciaisCard';
import { GoogleAnalyticsIntegracaoCard } from './GoogleAnalyticsIntegracaoCard';
import { GoogleAdsIntegracaoCard } from './GoogleAdsIntegracaoCard';
import { MetaAdsIntegracaoCard } from './MetaAdsIntegracaoCard';
import { OpenAiIntegracaoCard } from './OpenAiIntegracaoCard';
import { WhatsappIntegracaoCard } from './WhatsappIntegracaoCard';
import { WhatsappRemetenteCard } from './WhatsappRemetenteCard';

import '../../pedidos-central.css';
import '../../integracoes.css';

// Porte de src/integracoes.js.
// Achado do refinamento visual: "conectado" e "incluído no plano" são conceitos diferentes, mas
// só o 2º apareciam misturados num badge só. Não inventa um 3º eixo "saudável" pro WhatsApp — a
// API só dá esses 2 sinais reais (ver IntegrationsData); Instagram nem isso, só o plano.
export function IntegracoesPage() {
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [erro, setErro] = useState('');
  const [entitlementsProntos, setEntitlementsProntos] = useState(false);

  const recarregar = () => {
    getIntegrations()
      .then(setData)
      .catch((err: Error) => setErro(err.message));
  };

  useEffect(() => {
    recarregar();
    loadEntitlements().then(() => setEntitlementsProntos(true));
  }, []);

  return (
    <>
      <PageHeader title="Integrações" description={data ? 'Saúde das conexões com a Reserva Ink e o WhatsApp.' : undefined} />

      {erro && <ErrorState description={erro} />}
      {!erro && !data && <Skeleton rows={4} />}
      {!erro && data && (
        <div className="ad-integracoes-grid">
          <Card title="Estado das integrações" description="Cada integração tem um único estado, calculado no servidor.">
            <ul className="ad-integracoes-resumo" aria-label="Estado das integrações">
              {data.integracoes.map((i) => {
                const selo = seloDoEstado(i.estado);
                return (
                  <li key={i.provider}>
                    <span>{NOME_DO_PROVIDER[i.provider] || i.provider}</span>
                    <StatusBadge tone={selo.tone} label={selo.label} />
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Reserva Ink" flush>
            {/* Organization nova não tem loja ligada à Ink. Uma tabela só com cabeçalho não diz
                isso — diz que algo falhou. O estado é "ainda não configurada". */}
            {data.reservaInk.length === 0 ? (
              <EmptyState
                title="Reserva Ink ainda não configurada"
                description="Esta loja ainda não tem credencial da Reserva Ink. Configure abaixo, em Credenciais da Ink, para começar a receber pedidos."
              />
            ) : (
            <DataTable
              label="Conexões com a Reserva Ink"
              rows={data.reservaInk}
              rowKey={(item) => item.storeId}
              columns={[
                // Nome da Store. `adminStores.name` só sabe traduzir a chave legada; Store nativa do
                // Oria não tem uma, e o nome vem do próprio registro.
                { key: 'loja', label: 'Loja', render: (item) => item.nome || (item.loja ? adminStores.name(item.loja) : '—'), sortValue: (item) => item.nome || (item.loja ? adminStores.name(item.loja) : '') },
                {
                  key: 'status',
                  label: 'API',
                  render: (item) => {
                    const r = rotuloDaApiInk(item.tokenConfigurado ? 'connected' : 'not_configured');
                    return <StatusBadge tone={r.tone} label={r.label} />;
                  },
                  sortValue: (item) => (item.tokenConfigurado ? 1 : 0),
                },
                { key: 'webhook', label: 'Webhook', muted: true, render: (item) => rotuloDoWebhookInk(item.webhookConfigurado ? 'connected' : 'deferred').label, sortValue: (item) => (item.webhookConfigurado ? 1 : 0) },
                {
                  key: 'evento',
                  label: 'Último evento verificado',
                  align: 'right',
                  muted: true,
                  render: (item) => (item.ultimoEventoEm ? formatData(item.ultimoEventoEm) : 'Nenhum ainda'),
                  sortValue: (item) => item.ultimoEventoEm,
                },
              ]}
            />
            )}
          </Card>

          <InkCredenciaisCard onAlterado={recarregar} />

          <WhatsappIntegracaoCard
            conectadoApi={data.whatsapp.conectado}
            observacao={data.whatsapp.observacao}
            entitlementsProntos={entitlementsProntos}
          />

          <WhatsappRemetenteCard />

          <BackfillPedidosCard stores={lojasComTokenInk(data.reservaInk)} />

          <CatalogoCacheCard stores={lojasComTokenInk(data.reservaInk)} />

          <GoogleAnalyticsIntegracaoCard />

          <GoogleAdsIntegracaoCard />

          <MetaAdsIntegracaoCard />

          <OpenAiIntegracaoCard />

          <Card title="Instagram">
            <div className="ad-integracao-item__topo">
              <StatusBadge tone="neutral" label="Em breve" />
            </div>
            <p className="pc-nota">Integração ainda não implementada neste painel.</p>
          </Card>
        </div>
      )}
    </>
  );
}
