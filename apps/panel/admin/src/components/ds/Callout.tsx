import type { ReactNode } from 'react';
import { Icon } from './Icon';

// Alerta de página (DESIGN.md › Callout): tintado no tom, ícone, título curto, descrição e ação
// opcional. Sem faixa lateral grossa. `info` = oportunidade/contexto; `warning`/`danger` = decisão.
export type CalloutTone = 'info' | 'warning' | 'danger' | 'success';

const ICON_BY_TONE: Record<CalloutTone, string> = {
  info: 'info',
  warning: 'alert-triangle',
  danger: 'alert-triangle',
  success: 'check-circle',
};

interface CalloutProps {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
  className?: string;
}

export function Callout({ tone = 'info', title, children, action, role = 'status', className }: CalloutProps) {
  return (
    <div className={['ds-callout', `ds-callout--${tone}`, className].filter(Boolean).join(' ')} role={role}>
      <Icon name={ICON_BY_TONE[tone]} className="ds-callout__icon" />
      <div className="ds-callout__body">
        {title && <strong className="ds-callout__title">{title}</strong>}
        {children && <div className="ds-callout__text">{children}</div>}
      </div>
      {action && <div className="ds-callout__action">{action}</div>}
    </div>
  );
}
