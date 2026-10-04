import { substituirVariaveisNomeadas } from '../lib/templateVariables';
import { formatarTextoWhatsapp } from '../lib/whatsappFormat';

import '../templates.css';

// Prévia de mensagem do WhatsApp Web — mesma bolha do PreviewWhatsapp da API, só que sem
// cabeçalho/rodapé/botões e com a formatação do WhatsApp aplicada.
export function PreviewMensagemWeb({ corpo, overrides, dica = 'Prévia — como a mensagem chega pro cliente (com dados de exemplo).' }: { corpo: string; overrides?: Record<string, string> | null; dica?: string }) {
  const texto = substituirVariaveisNomeadas(corpo, overrides);
  return (
    <div className="oa-wa-preview">
      <div className="pa-field-hint">{dica}</div>
      <div className="oa-wa-preview__bolha">
        {texto.trim() ? (
          <div className="oa-wa-preview__corpo wa-msg-preview">{formatarTextoWhatsapp(texto)}</div>
        ) : (
          <div className="oa-wa-preview__vazio">A mensagem aparece aqui conforme você escreve…</div>
        )}
      </div>
    </div>
  );
}
