import { Disclosure } from '../../components/ds';
import { eventoLabel } from '../../lib/eventLabels';

// Eventos que o Oria consome da Reserva Ink. Todo evento com pedido atualiza o pedido no painel; os de
// carrinho e pagamento também alimentam as automações. Fica num lugar só para o guia e o teste
// (test/invariants/ink-webhook-guia.test.js) concordarem com o que o servidor entende.
export const EVENTOS_WEBHOOK_INK = [
  'order.created',
  'order.canceled',
  'payment.approved',
  'payment.card_not_authorized',
  'payment.pix_boleto_expired',
  'cart.abandoned',
  'shipping.waiting_to_be_sent',
  'shipping.sent',
  'shipping.delivery_in_progress',
  'shipping.left_for_delivery',
  'shipping.delivered',
] as const;

// Passo a passo do cadastro do webhook na Reserva Ink. A ORDEM importa: o segredo só existe depois que
// a URL foi cadastrada na Reserva Ink, e o Oria só aceita eventos com o segredo já salvo. Nada aqui
// mostra o segredo: ele entra no campo do formulário, é cifrado no servidor e nunca volta inteiro.
export function InkWebhookGuia({ pendente, segredoFinal }: { pendente: boolean; segredoFinal: string | null }) {
  return (
    <Disclosure summary={pendente ? 'Como cadastrar o webhook na Reserva Ink' : 'Como o webhook foi configurado'} defaultOpen={pendente}>
      <ol className="ds-stack pc-nota">
        <li>
          <strong>Gere a URL</strong> aqui no Oria (botão “Gerar URL do webhook”) e copie. Ela aparece uma única vez —
          se perder, gere outra: a anterior deixa de funcionar na hora.
        </li>
        <li>
          <strong>No painel da Reserva Ink</strong>, abra o cadastro de webhooks da sua loja, crie um webhook novo e
          cole a URL copiada.
        </li>
        <li>
          <strong>Marque os eventos</strong> abaixo (é o que o Oria entende):
          <ul className="ds-lista-meta">
            {EVENTOS_WEBHOOK_INK.map((evento) => (
              <li key={evento}>
                {eventoLabel(evento)} <code>{evento}</code>
              </li>
            ))}
          </ul>
        </li>
        <li>
          <strong>Copie o segredo</strong> que a Reserva Ink mostra ao criar o webhook, cole em “Segredo do webhook” e
          clique em Salvar. Ele é guardado cifrado e nunca aparece de novo
          {segredoFinal ? ` (hoje: final ${segredoFinal})` : ''}. Sem o segredo salvo o Oria recusa os eventos.
        </li>
        <li>
          <strong>Confirme:</strong> o selo muda para “Webhook configurado” e, assim que a Reserva Ink enviar o primeiro
          evento (um pedido novo ou uma mudança de status), a coluna “Último evento verificado” da loja deixa de dizer
          “Nenhum ainda” e o evento aparece em Webhooks e logs.
        </li>
      </ol>
    </Disclosure>
  );
}
