import { useState } from 'react';
import { Button } from '../../components/ds';
import { copiar } from '../../lib/format';
import { api } from '../../api/client';
import { useWhatsappProvider } from '../../state/whatsappProvider';

// Porte de renderAcoesRecuperacao() em src/recuperacao.js. "Copiar template" copia o texto real
// do template já com os dados trocados (pra colar manualmente no WhatsApp — sem envio automático
// por aqui, pedido do usuário 2026-09-05). Sem template vinculado, cai pro link manual (wa.me).
// "Enviar via Meta" força o envio automático agora (cobre pedidos cadastrados/vinculados na mão).
interface AcoesRecuperacaoProps {
  mensagemTemplate?: string | null;
  podeEnviarViaMeta?: boolean;
  waLinkFallback: () => string | null;
  enviarUrl: string;
  enviarBody: Record<string, unknown>;
  onSucesso: () => void;
}

export function AcoesRecuperacao({ mensagemTemplate, podeEnviarViaMeta, waLinkFallback, enviarUrl, enviarBody, onSucesso }: AcoesRecuperacaoProps) {
  const [copiado, setCopiado] = useState(false);
  const [estadoEnvio, setEstadoEnvio] = useState<'idle' | 'enviando' | 'enviado'>('idle');
  // No modo WhatsApp Web o mesmo botão só coloca a mensagem na fila do agente — o rótulo precisa
  // dizer isso, senão "Enviado!" sugere que já chegou no cliente.
  const modoWeb = useWhatsappProvider() === 'whatsapp_web';

  const link = !mensagemTemplate ? waLinkFallback() : null;
  if (!mensagemTemplate && !link && !podeEnviarViaMeta) return <>—</>;

  function enviarViaMeta() {
    setEstadoEnvio('enviando');
    api(enviarUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(enviarBody),
    })
      .then(() => {
        setEstadoEnvio('enviado');
        setTimeout(onSucesso, 900);
      })
      .catch(() => {
        // api() já mostra o erro num toast — só devolve o botão pro estado normal.
        setEstadoEnvio('idle');
      });
  }

  return (
    <div className="rc-acoes">
      {mensagemTemplate ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            copiar(mensagemTemplate, () => {
              setCopiado(true);
              setTimeout(() => setCopiado(false), 1800);
            })
          }
        >
          {copiado ? 'Copiado!' : modoWeb ? 'Copiar mensagem' : 'Copiar template'}
        </Button>
      ) : (
        link && (
          <a href={link} target="_blank" rel="noopener" className="ds-btn ds-btn--secondary ds-btn--sm">
            Enviar WhatsApp
          </a>
        )
      )}
      {podeEnviarViaMeta && (
        <Button variant="ghost" size="sm" disabled={estadoEnvio !== 'idle'} onClick={enviarViaMeta}>
          {estadoEnvio === 'enviando' ? 'Enviando…' : estadoEnvio === 'enviado' ? (modoWeb ? 'Na fila!' : 'Enviado!') : modoWeb ? 'Enviar pelo WhatsApp Web' : 'Enviar via Meta'}
        </Button>
      )}
    </div>
  );
}
