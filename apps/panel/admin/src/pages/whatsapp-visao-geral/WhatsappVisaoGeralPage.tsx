import { useEffect, useState } from 'react';
import { Callout, ErrorState, InfoTooltip, KpiCard, KpiStrip, PageHeader, PageStack, Skeleton } from '../../components/ds';
import { getVisaoGeral, type WhatsappVisaoGeral } from '../../api/whatsapp';

import '../../../../src/dashboard.css';
import '../../../../src/pedidos-central.css';

// Porte de src/whatsapp-visao-geral.js.
export function WhatsappVisaoGeralPage() {
  const [data, setData] = useState<WhatsappVisaoGeral | null>(null);
  const [erro, setErro] = useState('');

  useEffect(() => {
    getVisaoGeral()
      .then(setData)
      .catch((err: Error) => setErro(err.message));
  }, []);

  return (
    <PageStack>
      <PageHeader
        title="WhatsApp"
        description="Visão geral do canal de mensagens."
        actions={
          <InfoTooltip content='Sem "qualidade do número" nesta versão — exigiria integração com a Business Management API da Meta, que este painel ainda não tem. Também não há "entregue"/"lido" separados de "enviado" — a Meta não confirma isso hoje pra este serviço.' />
        }
      />

      {erro && <ErrorState description={erro} />}
      {!erro && !data && <Skeleton rows={4} />}
      {!erro && data && (
        <>
          {data.servicoIndisponivel && (
            <Callout tone="warning" title="Não foi possível conectar ao serviço de WhatsApp agora">
              Os números abaixo podem estar incompletos.
            </Callout>
          )}

          <KpiStrip label="Mensagens">
            <KpiCard title="Mensagens enviadas" value={data.servicoIndisponivel ? '—' : data.stats?.sent} />
            <KpiCard title="Respostas recebidas" value={data.servicoIndisponivel ? '—' : data.stats?.received} />
            <KpiCard title="Falhas" value={data.servicoIndisponivel ? '—' : data.stats?.errors} />
            <KpiCard title="Na fila" value={data.servicoIndisponivel ? '—' : data.pendingQueue} helper="Aguardando revisão manual" />
          </KpiStrip>

          <KpiStrip label="Canal">
            {/* O número é o cadastrado para esta loja (Integrações); o serviço de envio não tem número próprio. */}
            <KpiCard
              title="Número"
              value={!data.connected ? 'Desconectado' : data.phoneNumberId ? 'Conectado' : 'Não cadastrado'}
              helper={!data.connected ? undefined : data.phoneNumberId ? `ID ${data.phoneNumberId}` : 'Cadastre em Integrações'}
            />
            <KpiCard title="Templates aprovados" value={data.templatesAprovados == null ? 'Indisponível' : data.templatesAprovados} />
            <KpiCard title="Automações ativas" value={data.automacoesAtivas} />
          </KpiStrip>
        </>
      )}
    </PageStack>
  );
}
