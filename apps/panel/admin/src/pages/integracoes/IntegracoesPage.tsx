import { useEffect, useState } from 'react';
import { Card, DataTable, ErrorState, PageHeader, Skeleton, StatusBadge } from '../../components/ds';
import { formatData } from '../../lib/format';
import { adminStores } from '../../state/adminStores';
import { getIntegrations, type IntegrationsData } from '../../api/integracoes';
import { hasEntitlement, loadEntitlements } from '../../state/entitlements';
import { BackfillPedidosCard } from './BackfillPedidosCard';
import { CatalogoCacheCard } from './CatalogoCacheCard';
import { InkCredenciaisCard } from './InkCredenciaisCard';
import { GoogleAnalyticsIntegracaoCard } from './GoogleAnalyticsIntegracaoCard';
import { GoogleAdsIntegracaoCard } from './GoogleAdsIntegracaoCard';
import { MetaAdsIntegracaoCard } from './MetaAdsIntegracaoCard';
import { OpenAiIntegracaoCard } from './OpenAiIntegracaoCard';
import { WhatsappIntegracaoCard } from './WhatsappIntegracaoCard';
import { WhatsappRemetenteCard } from './WhatsappRemetenteCard';

import '../../../../src/pedidos-central.css';
import '../../../../src/integracoes.css';

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
          <Card title="Reserva Ink" flush>
            <DataTable
              label="Conexões com a Reserva Ink"
              rows={data.reservaInk}
              rowKey={(item) => item.loja}
              columns={[
                { key: 'loja', label: 'Loja', render: (item) => adminStores.name(item.loja), sortValue: (item) => adminStores.name(item.loja) },
                {
                  key: 'status',
                  label: 'Status',
                  render: (item) => {
                    const ok = item.tokenConfigurado && item.webhookConfigurado;
                    // Configuração pendente é ação necessária, não falha (DESIGN.md › Status Badge).
                    return <StatusBadge tone={ok ? 'success' : 'warning'} label={ok ? 'OK' : 'Pendente'} />;
                  },
                  sortValue: (item) => (item.tokenConfigurado && item.webhookConfigurado ? 1 : 0),
                },
                { key: 'token', label: 'Token', muted: true, render: (item) => (item.tokenConfigurado ? 'Configurado' : 'Não configurado'), sortValue: (item) => (item.tokenConfigurado ? 1 : 0) },
                { key: 'webhook', label: 'Webhook', muted: true, render: (item) => (item.webhookConfigurado ? 'Configurado' : 'Não configurado'), sortValue: (item) => (item.webhookConfigurado ? 1 : 0) },
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
          </Card>

          <InkCredenciaisCard onAlterado={recarregar} />

          <WhatsappIntegracaoCard
            conectadoApi={data.whatsapp.conectado}
            observacao={data.whatsapp.observacao}
            entitlementsProntos={entitlementsProntos}
          />

          <WhatsappRemetenteCard />

          <BackfillPedidosCard lojas={data.reservaInk.filter((item) => item.tokenConfigurado).map((item) => item.loja)} />

          <CatalogoCacheCard lojas={data.reservaInk.filter((item) => item.tokenConfigurado).map((item) => item.loja)} />

          <GoogleAnalyticsIntegracaoCard />

          <GoogleAdsIntegracaoCard />

          <MetaAdsIntegracaoCard />

          <OpenAiIntegracaoCard />

          <Card title="Instagram">
            <div className="ad-integracao-item__topo">
              {entitlementsProntos && (
                <StatusBadge
                  tone={hasEntitlement('instagram') ? 'success' : 'neutral'}
                  label={hasEntitlement('instagram') ? 'Incluído no plano' : 'Não incluído no plano'}
                />
              )}
              <StatusBadge tone="neutral" label="Em breve" />
            </div>
            <p className="pc-nota">Integração ainda não implementada neste painel.</p>
          </Card>
        </div>
      )}
    </>
  );
}
