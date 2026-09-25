import { Tabs } from '../../components/ds';
import { WhatsappIntegracaoCard } from './WhatsappIntegracaoCard';
import { WhatsappRemetenteCard } from './WhatsappRemetenteCard';

export const ABAS_WHATSAPP = ['conexao', 'envio'] as const;

// Conteúdo expandido do WhatsApp. Separa o que estava misturado num só lugar: a aba Conexão trata do
// número e da autorização da Meta (é onde "token recusado" aparece e onde se reconecta); a aba Canal
// de envio trata de COMO as mensagens saem — API oficial ou WhatsApp Web, sem apagar nenhuma opção.
export function WhatsappIntegracao({
  conectadoApi,
  observacao,
  modoWeb,
  aba,
  onAba,
}: {
  conectadoApi: boolean;
  observacao?: string | null;
  modoWeb: boolean;
  aba: string;
  onAba: (aba: string) => void;
}) {
  const indice = Math.max(0, ABAS_WHATSAPP.indexOf(aba as (typeof ABAS_WHATSAPP)[number]));
  return (
    <div className="ig-abas">
      <Tabs
        label="Seções do WhatsApp"
        activeIndex={indice}
        onChangeIndex={(i) => onAba(ABAS_WHATSAPP[i])}
        tabs={[
          { label: 'Conexão', render: () => <WhatsappRemetenteCard modoWeb={modoWeb} /> },
          { label: 'Canal de envio', render: () => <WhatsappIntegracaoCard conectadoApi={conectadoApi} observacao={observacao} /> },
        ]}
      />
    </div>
  );
}
