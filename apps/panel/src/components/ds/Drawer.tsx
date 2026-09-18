import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Icon } from './Icon';

// Radix Dialog por baixo, mesma ideia do Modal — um drawer é semanticamente um dialog ancorado
// na lateral. Ganha focus trap, ESC e aria de graça; classes ds-drawer-* continuam as mesmas
// (nenhuma mudança visual, nenhuma página precisa mudar a chamada).
interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  // Rodapé fixo com ações (DESIGN.md › Drawer): destrutivas ficam aqui, nunca no topo.
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, description, children, footer }: DrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ds-drawer-overlay" />
        <Dialog.Content className="ds-drawer">
          <div className="ds-drawer__header">
            <div>
              <Dialog.Title className="ds-card__title">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="ds-card__description">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="ds-sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close className="ds-drawer__close" aria-label="Fechar">
              <Icon name="close" size={18} />
            </Dialog.Close>
          </div>
          <div className="ds-drawer__body">{children}</div>
          {footer && <div className="ds-drawer__footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
