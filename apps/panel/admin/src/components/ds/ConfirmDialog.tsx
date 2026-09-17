import { useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import type { ButtonVariant } from './Button';

// Substitui window.confirm() (usado hoje em 9 lugares pra ações destrutivas) — mesmo visual dos
// demais modais do produto, focus trap/ESC/aria de graça via Modal, sem travar a aba do
// navegador com um dialog nativo fora do design system.
//
// onConfirm pode devolver uma Promise (ex: disparo real de campanha) — o dialog só fecha depois
// dela resolver. Antes fechava na hora (fire-and-forget), o que deixava qualquer ação assíncrona
// mais lenta parecendo travada: o modal sumia e a página ficava sem nenhum indicador de "ainda
// processando" até o retorno chegar. Em erro, o dialog fica aberto de novo pra tentar de novo (o
// toast de erro já vem de api(), em client.ts).
interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  confirmVariant?: ButtonVariant;
  onConfirm: () => void | Promise<void>;
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = 'Excluir',
  confirmVariant = 'danger',
  onConfirm,
}: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);

  return (
    <Modal
      open={open}
      onClose={() => { if (!pending) onClose(); }}
      title={title}
      confirmLabel={pending ? 'Aguarde…' : confirmLabel}
      // Destrutivo confirmado é o único lugar do vermelho sólido (DESIGN.md › Buttons).
      confirmVariant={confirmVariant === 'danger' ? 'danger-solid' : confirmVariant}
      confirmDisabled={pending}
      onConfirm={async () => {
        setPending(true);
        try {
          await onConfirm();
          onClose();
        } catch {
          // erro já sinalizado (toast em api(), ou msg própria da página) — mantém o dialog
          // aberto pra o usuário tentar de novo em vez de fingir que deu certo.
        } finally {
          setPending(false);
        }
      }}
    >
      {description}
    </Modal>
  );
}
