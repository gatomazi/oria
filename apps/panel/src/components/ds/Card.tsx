import type { ReactNode } from 'react';

// Porte de card() em components.js.
interface CardProps {
  // flush: corpo sem padding, pra tabela/lista encostar nas bordas do painel.
  flush?: boolean;
  title?: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function Card({ flush, title, description, action, className, children }: CardProps) {
  return (
    <section className={['ds-card', flush ? 'ds-card--flush' : null, className].filter(Boolean).join(' ')}>
      {(title || action) && (
        <div className="ds-card__header">
          <div>
            {title && <h2 className="ds-card__title">{title}</h2>}
            {description && <p className="ds-card__description">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="ds-card__body">{children}</div>
    </section>
  );
}
