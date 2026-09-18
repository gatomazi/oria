import type { ReactNode } from 'react';

// Barra de filtros acima de listas (DESIGN.md › Toolbar de filtros): busca, filtros e "Limpar"
// à esquerda; contagem e ações de visualização à direita (`end`). Quebra de linha no mobile.
interface ToolbarProps {
  children?: ReactNode;
  end?: ReactNode;
  label?: string;
}

export function Toolbar({ children, end, label = 'Filtros' }: ToolbarProps) {
  return (
    <div className="ds-toolbar" role="search" aria-label={label}>
      {children}
      {end && <div className="ds-toolbar__end">{end}</div>}
    </div>
  );
}
