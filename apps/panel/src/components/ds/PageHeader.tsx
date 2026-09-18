import { Children, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

// Cabeçalho de página (DESIGN.md › Layout, anatomia): voltar opcional (página filha), h1 único,
// descrição em uma linha, metadados e ações (no máximo uma primária).
interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode | ReactNode[];
  back?: { to: string; label: string };
  meta?: ReactNode;
}

export function PageHeader({ title, description, actions, back, meta }: PageHeaderProps) {
  // Children.toArray dá chave estável a ações passadas como array literal (sem `key` em cada botão).
  const actionList = Children.toArray(actions);
  return (
    <div className="ds-page-header">
      <div className="ds-page-header__main">
        {back && (
          <Link to={back.to} className="ds-page-header__back">
            <Icon name="arrow-left" />
            {back.label}
          </Link>
        )}
        <h1 className="ds-page-header__title">{title}</h1>
        {description && <p className="ds-page-header__description">{description}</p>}
        {meta && <div className="ds-page-header__meta">{meta}</div>}
      </div>
      {actionList.length > 0 && <div className="ds-page-header__actions">{actionList}</div>}
    </div>
  );
}
