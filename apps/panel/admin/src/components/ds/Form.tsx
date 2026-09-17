import type { FormHTMLAttributes, ReactNode } from 'react';

// Estrutura de formulário (DESIGN.md › Inputs / Fields › Agrupamento): coluna de até 720px com
// ritmo fixo entre campos, seções com título (sem um card por grupo), grade responsiva pra campos
// curtos lado a lado e barra de ações no fim.
type FormStackProps = FormHTMLAttributes<HTMLFormElement> & { wide?: boolean; as?: 'form' | 'div' };

export function FormStack({ wide, as = 'form', className, children, ...rest }: FormStackProps) {
  const classes = ['ds-form', wide ? 'ds-form--wide' : null, className].filter(Boolean).join(' ');
  if (as === 'div') return <div className={classes}>{children}</div>;
  return (
    <form className={classes} {...rest}>
      {children}
    </form>
  );
}

export function FormSection({ title, description, children }: { title?: ReactNode; description?: ReactNode; children?: ReactNode }) {
  return (
    <section className="ds-form-section">
      {(title || description) && (
        <header className="ds-form-section__header">
          {title && <h2 className="ds-form-section__title">{title}</h2>}
          {description && <p className="ds-form-section__description">{description}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

// Campos curtos lado a lado; cai pra uma coluna quando o espaço não comporta.
export function FormGrid({ children, min = 220 }: { children?: ReactNode; min?: number }) {
  return (
    <div className="ds-form-grid" style={{ ['--form-grid-min' as string]: `${min}px` }}>
      {children}
    </div>
  );
}

// Ações do formulário: secundárias à esquerda (`start`), primária à direita.
export function FormActions({ children, start }: { children?: ReactNode; start?: ReactNode }) {
  return (
    <div className="ds-form-actions">
      {start && <div className="ds-form-actions__start">{start}</div>}
      <div className="ds-form-actions__end">{children}</div>
    </div>
  );
}
