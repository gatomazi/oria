import type { ReactNode } from 'react';
import { Button } from './Button';
import { Icon } from './Icon';

// Estados de conteúdo (DESIGN.md › Empty State / Error State). Dentro de um painel ou ao lado de
// outro conteúdo ficam compactos automaticamente (CSS: .ds-card__body .ds-empty); soltos na página
// ganham mais respiro. Vazio aponta o próximo passo (`action`); erro oferece "Tentar novamente".
interface StateBoxProps {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ title, description, action }: StateBoxProps) {
  return (
    <div className="ds-empty">
      {title && <p className="ds-empty__title">{title}</p>}
      {description && <p className="ds-empty__description">{description}</p>}
      {action && <div className="ds-empty__action">{action}</div>}
    </div>
  );
}

interface ErrorStateProps extends StateBoxProps {
  onRetry?: () => void;
}

export function ErrorState({ title = 'Não foi possível carregar', description, action, onRetry }: ErrorStateProps) {
  return (
    <div className="ds-empty ds-empty--erro" role="alert">
      <Icon name="alert-triangle" size={20} className="ds-empty__icon" />
      <p className="ds-empty__title">{title}</p>
      {description && <p className="ds-empty__description">{description}</p>}
      {(action || onRetry) && (
        <div className="ds-empty__action">
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Tentar novamente
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
