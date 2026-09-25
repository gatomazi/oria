import { useRef, type ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, type ButtonVariant } from './Button';

// Radix Dialog por baixo (focus trap, ESC, clique fora, aria-modal/role="dialog" de graça) —
// mesma API externa de antes (open/onClose/title/...), então nenhuma página que já usa Modal
// precisa mudar. Ganho é só de comportamento/acessibilidade, não de visual (classes ds-modal-*
// continuam as mesmas).
interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children?: ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  confirmVariant?: ButtonVariant;
  confirmDisabled?: boolean;
  onConfirm?: () => void;
  // Largura máxima do modal — default 480px (diálogos simples). Telas com tabela/preview largo
  // (ex: preview do preset de regras) passam um valor maior pra não espremer o conteúdo.
  maxWidth?: number;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  cancelLabel = 'Cancelar',
  confirmLabel,
  confirmVariant = 'primary',
  confirmDisabled,
  onConfirm,
  maxWidth = 480,
}: ModalProps) {
  // Sem `Dialog.Trigger` (o modal é aberto por estado), o Radix não sabe para onde devolver o foco e o deixa no <body>
  // ao fechar. Guarda quem estava focado ao abrir e devolve a ele ao fechar (se ainda existir na página).
  const retorno = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ds-modal-overlay" />
        <Dialog.Content
          className="ds-modal"
          style={{ width: `min(calc(100% - 32px), ${maxWidth}px)` }}
          onOpenAutoFocus={() => { retorno.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
          onCloseAutoFocus={(ev) => {
            const alvo = retorno.current;
            retorno.current = null;
            if (alvo && alvo.isConnected) { ev.preventDefault(); alvo.focus(); }
          }}
        >
          <Dialog.Title className="ds-modal__title">{title}</Dialog.Title>
          <div className="ds-modal__body">{children}</div>
          <div className="ds-modal__actions">
            <Button variant="secondary" onClick={onClose}>
              {cancelLabel}
            </Button>
            {confirmLabel && (
              <Button
                variant={confirmVariant}
                disabled={confirmDisabled}
                onClick={() => (onConfirm ? onConfirm() : onClose())}
              >
                {confirmLabel}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
