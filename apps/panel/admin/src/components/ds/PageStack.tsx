import type { ReactNode } from 'react';

// Dono do espaçamento vertical da página (Stack Owns Spacing Rule): blocos a 24px, sem margem
// externa nos componentes. Páginas migram pra ele uma a uma.
export function PageStack({ children, className }: { children?: ReactNode; className?: string }) {
  return <div className={['ds-page-stack', className].filter(Boolean).join(' ')}>{children}</div>;
}
