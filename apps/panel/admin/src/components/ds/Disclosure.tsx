import type { ReactNode } from 'react';

// Detalhe sob demanda (<details> nativo): informação técnica que o lojista raramente precisa
// (variável de ambiente, código do evento) fica disponível sem ocupar a tela.
export function Disclosure({ summary, children, defaultOpen }: { summary: ReactNode; children?: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="ds-disclosure" open={defaultOpen}>
      <summary className="ds-disclosure__summary">{summary}</summary>
      <div className="ds-disclosure__body">{children}</div>
    </details>
  );
}
