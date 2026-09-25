import type { ReactNode } from 'react';
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

interface GuiaProps {
  aberto: boolean;
  onAlternar: (aberto: boolean) => void;
  segredoFinal: string | null;
  // Controles que ficam DENTRO dos passos: gerar a URL (passo 1) e salvar o segredo (passo 4).
  passoUrl?: ReactNode;
  passoSegredo?: ReactNode;
}

// Ativação do recebimento automático de pedidos: o único passo manual que o lojista precisa fazer
// no painel da Reserva Ink. A ORDEM importa: o segredo só existe depois que a URL foi cadastrada na
// Reserva Ink, e o Oria só aceita eventos com o segredo já salvo. Nada aqui mostra o segredo: ele
// entra no campo do formulário, é cifrado no servidor e nunca volta inteiro.
export function InkWebhookGuia({ aberto, onAlternar, segredoFinal, passoUrl, passoSegredo }: GuiaProps) {
  return (
    <details
      id="ink-guia-recebimento"
      className="ds-disclosure ig-guia"
      open={aberto}
      onToggle={(ev) => onAlternar(ev.currentTarget.open)}
    >
      <summary className="ds-disclosure__summary">Passo a passo para ativar o recebimento automático</summary>
      <div className="ds-disclosure__body">
        <ol className="ds-stack pc-nota ig-passos">
          <li>
            <strong>Gere a URL</strong> aqui no Oria e copie. Ela aparece uma única vez — se perder, gere outra: a anterior deixa de
            funcionar na hora.
            {passoUrl}
          </li>
          <li>
            <strong>No painel da Reserva Ink</strong>, abra o cadastro de webhooks da sua loja, crie um webhook novo e cole a URL copiada.
          </li>
          <li>
            <strong>Marque os eventos</strong> que o Oria entende.
            <Disclosure summary={`Ver os ${EVENTOS_WEBHOOK_INK.length} eventos`}>
              <ul className="ds-lista-meta">
                {EVENTOS_WEBHOOK_INK.map((evento) => (
                  <li key={evento}>
                    {eventoLabel(evento)} <code>{evento}</code>
                  </li>
                ))}
              </ul>
            </Disclosure>
          </li>
          <li>
            <strong>Copie o segredo</strong> que a Reserva Ink mostra ao criar o webhook, cole abaixo e clique em Salvar segredo. Ele é
            guardado cifrado e nunca aparece de novo
            {segredoFinal ? ` (hoje: final ${segredoFinal})` : ''}. Sem o segredo salvo o Oria recusa os eventos.
            {passoSegredo}
          </li>
          <li>
            <strong>Confirme:</strong> o estado muda para “Recebimento automático ativo” e, assim que a Reserva Ink enviar o primeiro evento
            (um pedido novo ou uma mudança de status), o “Último evento recebido” deixa de dizer “Nenhum ainda”.
          </li>
        </ol>
      </div>
    </details>
  );
}
