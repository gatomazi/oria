import * as RadixDropdown from '@radix-ui/react-dropdown-menu';

// Menu de ações contextuais por linha (o "..." que falta hoje) — Templates e Promoções mostram
// "Excluir" vermelho em toda linha da tabela, competindo com o conteúdo principal (achado do
// refinamento visual, doc/claude-refinamento-visual-completo-29-paginas.md). Ações destrutivas só
// devem aparecer depois de 1 clique de intenção, não já visíveis por padrão.
export interface DropdownMenuItem {
  label: string;
  onSelect: () => void;
  variant?: 'default' | 'danger';
  disabled?: boolean;
}

const KEBAB_ICON = (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor">
    <circle cx="12" cy="5" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="12" cy="19" r="1.6" />
  </svg>
);

export type DropdownMenuEntry = DropdownMenuItem | 'separator';

export function RowActionsMenu({ items }: { items: DropdownMenuEntry[] }) {
  return (
    <RadixDropdown.Root>
      <RadixDropdown.Trigger asChild>
        <button
          type="button"
          className="ds-icon-btn"
          aria-label="Mais ações"
          onClick={(ev) => ev.stopPropagation()}
        >
          {KEBAB_ICON}
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          className="ds-dropdown"
          align="end"
          sideOffset={4}
          onClick={(ev) => ev.stopPropagation()}
        >
          {items.map((item, i) =>
            item === 'separator' ? (
              <RadixDropdown.Separator key={i} className="ds-dropdown__separator" />
            ) : (
              <RadixDropdown.Item
                key={i}
                disabled={item.disabled}
                className={'ds-dropdown__item' + (item.variant === 'danger' ? ' ds-dropdown__item--danger' : '')}
                onSelect={item.onSelect}
              >
                {item.label}
              </RadixDropdown.Item>
            ),
          )}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}
