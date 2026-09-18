import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Callout, Card, DataTable, EmptyState, ErrorState, KpiCard, KpiStrip, PageHeader, PageStack,
  Select, Skeleton, type Column,
} from '../../components/ds';
import { metaNumero, metaPercentual, metaReais, metaRoas } from '../../lib/meta';
import { formatData, formatDiaISO } from '../../lib/format';
import {
  getGoogleAdsOverview, type GoogleAdsCampanha, type GoogleAdsOverview,
} from '../../api/googleAds';

// Os números vêm todos do Postgres, gravados pelo sync — esta tela nunca fala com o Google. Por
// isso trocar o período é instantâneo e não gasta cota da API.
//
// As taxas (CTR, CPC, CPA, ROAS) são recalculadas no backend a partir dos somatórios do período,
// nunca lidas da API nem tiradas de média de taxas diárias. Os formatadores são os mesmos do Meta
// de propósito: as duas integrações falam a mesma unidade, então o mesmo número significa a mesma
// coisa nas duas telas.

const PERIODOS = [
  { dias: 7, rotulo: 'Últimos 7 dias' },
  { dias: 14, rotulo: 'Últimos 14 dias' },
  { dias: 30, rotulo: 'Últimos 30 dias' },
  { dias: 90, rotulo: 'Últimos 90 dias' },
];

export function GoogleAdsPage() {
  const [params, setParams] = useSearchParams();
  const dias = Number(params.get('dias')) || 30;
  const [dados, setDados] = useState<GoogleAdsOverview | null>(null);
  const [erro, setErro] = useState('');

  function carregar() {
    setErro('');
    setDados(null);
    getGoogleAdsOverview(dias)
      .then(setDados)
      .catch((err: Error) => setErro(err.message));
  }

  useEffect(carregar, [dias]); // eslint-disable-line react-hooks/exhaustive-deps

  const colunas: Column<GoogleAdsCampanha>[] = useMemo(() => [
    { key: 'nome', label: 'Campanha', render: (c) => c.nome },
    {
      key: 'custo', label: 'Investimento', align: 'right', firstSortDirection: 'desc',
      sortValue: (c) => c.custo, render: (c) => metaReais(c.custo),
    },
    {
      key: 'impressoes', label: 'Impressões', align: 'right', muted: true, priority: 'low',
      sortValue: (c) => c.impressoes, render: (c) => metaNumero(c.impressoes),
    },
    {
      key: 'cliques', label: 'Cliques', align: 'right', muted: true,
      sortValue: (c) => c.cliques, render: (c) => metaNumero(c.cliques),
    },
    {
      key: 'ctr', label: 'CTR', align: 'right', priority: 'low',
      sortValue: (c) => c.ctr ?? -1, render: (c) => metaPercentual(c.ctr),
    },
    {
      key: 'conversoes', label: 'Conversões', align: 'right',
      // Conversão é fracionária no Google (atribuição parcial): uma casa decimal, senão "0,5" vira
      // "1" ou some, e o total da coluna deixa de fechar com a soma das linhas.
      sortValue: (c) => c.conversoes,
      render: (c) => (c.conversoes ? c.conversoes.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'),
    },
    {
      key: 'cpa', label: 'Custo por conversão', align: 'right', priority: 'low',
      sortValue: (c) => c.cpa ?? -1, render: (c) => metaReais(c.cpa),
    },
    {
      key: 'roas', label: 'ROAS', align: 'right',
      sortValue: (c) => c.roas ?? -1, render: (c) => metaRoas(c.roas),
    },
  ], []);

  const seletor = (
    <Select
      aria-label="Período"
      value={String(dias)}
      onChange={(e) => setParams({ dias: e.target.value }, { replace: true })}
    >
      {PERIODOS.map((p) => <option key={p.dias} value={p.dias}>{p.rotulo}</option>)}
    </Select>
  );

  if (erro) {
    return (
      <PageStack>
        <PageHeader title="Google Ads" actions={seletor} />
        <ErrorState description={erro} onRetry={carregar} />
      </PageStack>
    );
  }

  if (!dados) {
    return (
      <PageStack>
        <PageHeader title="Google Ads" actions={seletor} />
        <Skeleton rows={1} height="88px" />
        <Skeleton variant="table" rows={5} />
      </PageStack>
    );
  }

  if (!dados.conectado || !dados.conta) {
    return (
      <PageStack>
        <PageHeader title="Google Ads" />
        <EmptyState
          title="Google Ads não conectado"
          description="Conecte a conta de anúncios em Integrações para ver o desempenho das campanhas aqui."
          action={<Link className="ds-btn ds-btn--primary" to="/admin/integracoes">Ir para Integrações</Link>}
        />
      </PageStack>
    );
  }

  const t = dados.total;
  const semEntrega = !t || (t.impressoes === 0 && t.custo === 0);

  return (
    <PageStack>
      <PageHeader
        title="Google Ads"
        description={dados.conta.nome || dados.conta.customerIdFormatado || dados.conta.customerId}
        actions={seletor}
      />

      {/* O recorte exato, escrito. "Últimos 7 dias" no Google EXCLUI hoje e aqui INCLUI — sem as
          datas à vista, os dois números divergem e ninguém consegue dizer por quê. A hora do sync
          entra junto porque o dia corrente muda ao longo do dia. */}
      <p className="pc-nota">
        {dados.de && dados.ate
          ? `Dados de ${formatDiaISO(dados.de)} a ${formatDiaISO(dados.ate)} — o último dia ainda está em andamento.`
          : null}
        {dados.sincronizadoEm ? ` Sincronizado em ${formatData(dados.sincronizadoEm)}.` : ' Ainda não sincronizado.'}
      </p>

      {semEntrega ? (
        <EmptyState
          title="Nenhuma entrega neste período"
          description="A conta está conectada e sincronizada, mas não houve impressão nem investimento no intervalo escolhido. Experimente um período maior."
        />
      ) : (
        <>
          <KpiStrip label="Desempenho do período">
            <KpiCard
              title="Investimento"
              value={metaReais(t.custo)}
              helper={dados.de && dados.ate ? `${formatDiaISO(dados.de)} a ${formatDiaISO(dados.ate)}` : `${dados.serie.length} dias com dado`}
            />
            <KpiCard title="Impressões" value={metaNumero(t.impressoes)} helper={`CTR de ${metaPercentual(t.ctr)}`} />
            <KpiCard title="Cliques" value={metaNumero(t.cliques)} helper={`CPC de ${metaReais(t.cpc)}`} />
            <KpiCard
              title="Conversões"
              value={t.conversoes ? t.conversoes.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'}
              helper={t.cpa ? `${metaReais(t.cpa)} por conversão` : 'Sem conversão no período'}
            />
            <KpiCard
              title="ROAS"
              value={metaRoas(t.roas)}
              helper={t.valorConversoes ? `${metaReais(t.valorConversoes)} em valor de conversão` : 'Sem valor de conversão'}
            />
          </KpiStrip>

          {/* O valor de conversão é medido pelo próprio Google, por atribuição — não é a receita
              real da loja. Sem dizer isso, o ROAS aqui seria lido como lucro, e ele não é. */}
          <Callout tone="info" title="De onde vem o ROAS">
            O valor de conversão é o que o <strong>Google</strong> atribui às campanhas, não a receita
            registrada na loja. Serve para comparar campanhas entre si. Para o resultado real, use o{' '}
            <Link to="/admin/financeiro">Financeiro</Link>, que divide a receita da loja pelo gasto
            de mídia de todas as plataformas.
          </Callout>

          {dados.campanhas.length === 0 ? (
            <Card title="Campanhas">
              <EmptyState
                title="Nenhuma campanha com entrega"
                description="Houve investimento na conta, mas nenhuma campanha com dado no período."
              />
            </Card>
          ) : (
            <DataTable
              label="Campanhas"
              rows={dados.campanhas}
              rowKey={(c) => c.campaignId}
              columns={colunas}
              defaultSort={{ key: 'custo', direction: 'desc' }}
            />
          )}

          {dados.serie.length > 0 && (
            <Card title="Dia a dia">
              <DataTable
                label="Desempenho diário"
                rows={dados.serie}
                rowKey={(d) => d.data}
                columns={[
                  { key: 'data', label: 'Dia', render: (d) => formatDiaISO(d.data) },
                  { key: 'custo', label: 'Investimento', align: 'right', render: (d) => metaReais(d.custo) },
                  { key: 'cliques', label: 'Cliques', align: 'right', muted: true, render: (d) => metaNumero(d.cliques) },
                  {
                    key: 'conversoes', label: 'Conversões', align: 'right',
                    render: (d) => (d.conversoes ? d.conversoes.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '—'),
                  },
                ]}
              />
            </Card>
          )}
        </>
      )}
    </PageStack>
  );
}
