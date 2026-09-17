import { Button } from './Button';

// Rodapé de lista paginada (DESIGN.md › Data Table › Rodapé): posição e total à esquerda,
// Anterior/Próxima à direita. `noun` é o rótulo do total já com plural resolvido pela página.
interface PaginationProps {
  page: number;
  totalPages: number;
  totalLabel?: string;
  onPrev: () => void;
  onNext: () => void;
  label?: string;
}

export function Pagination({ page, totalPages, totalLabel, onPrev, onNext, label = 'Paginação' }: PaginationProps) {
  return (
    <nav className="ds-pagination" aria-label={label}>
      <span className="ds-num">
        Página {page} de {totalPages}
        {totalLabel ? ` · ${totalLabel}` : ''}
      </span>
      <div className="ds-pagination__controls">
        <Button variant="secondary" size="sm" disabled={page <= 1} onClick={onPrev}>
          Anterior
        </Button>
        <Button variant="secondary" size="sm" disabled={page >= totalPages} onClick={onNext}>
          Próxima
        </Button>
      </div>
    </nav>
  );
}
