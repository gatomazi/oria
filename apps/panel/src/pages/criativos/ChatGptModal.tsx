import { useState } from 'react';
import { Button, Field, Modal, Textarea } from '../../components/ds';
import { toast } from '../../lib/toast';
import { copiar } from '../../lib/format';

// Fluxo "Preencher com ChatGPT" dos cadastros guiados (Brand Kit, Niche Kit, contexto e persona): o
// lojista copia um prompt pronto, conversa no ChatGPT e cola a resposta. `onAplicar` lança Error com
// mensagem amigável quando a resposta não serve; sem erro, o modal limpa e fecha.

interface ChatGptModalProps {
  open: boolean;
  onClose: () => void;
  prompt: string;
  onAplicar: (resposta: string) => void;
  assunto?: string;
}

export function ChatGptModal({ open, onClose, prompt, onAplicar, assunto = 'a sua loja' }: ChatGptModalProps) {
  const [resposta, setResposta] = useState('');
  const [erro, setErro] = useState('');

  function fechar() {
    setErro('');
    onClose();
  }

  function aplicar() {
    setErro('');
    try {
      onAplicar(resposta);
      setResposta('');
      onClose();
    } catch (e) {
      setErro((e as Error).message);
    }
  }

  return (
    <Modal
      open={open}
      onClose={fechar}
      title="Preencher com ChatGPT"
      confirmLabel="Preencher formulário"
      confirmDisabled={!resposta.trim()}
      onConfirm={aplicar}
      maxWidth={640}
    >
      <ol className="criativos-passos">
        <li>
          Copie o prompt e cole numa conversa nova do ChatGPT.
          <div className="criativos-passos__acao">
            <Button size="sm" variant="secondary" onClick={() => copiar(prompt, () => toast('Prompt copiado.', 'sucesso'))}>Copiar prompt</Button>
          </div>
        </li>
        <li>Responda às perguntas que ele fizer sobre {assunto}.</li>
        <li>Copie a resposta final (o bloco de código) e cole abaixo.</li>
      </ol>
      <Field label="Resposta do ChatGPT" hint="Pode colar a mensagem inteira: o JSON é encontrado automaticamente.">
        <Textarea rows={8} spellCheck={false} value={resposta} onChange={(e) => setResposta(e.target.value)} />
      </Field>
      {erro && <p className="ds-form-error" role="alert">{erro}</p>}
    </Modal>
  );
}
