import type { ReactNode } from 'react';
import * as RadixTooltip from '@radix-ui/react-tooltip';

// Tooltip genérico (hover/focus) — usar pra explicar um termo/comportamento sem ocupar espaço
// fixo na tela. Para blocos de texto explicativo mais longos (parágrafo inteiro), preferir
// InfoTooltip abaixo, que é mais fácil de ler num popover do que espremido num hover simples.
export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={300}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className="ds-tooltip" sideOffset={6}>
            {content}
            <RadixTooltip.Arrow className="ds-tooltip__arrow" />
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

const INFO_ICON = (
  <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <circle cx="12" cy="8" r=".6" fill="currentColor" stroke="none" />
  </svg>
);

// Ícone "i" com o texto explicativo dentro — pra tirar parágrafo técnico longo de cima da tela
// (achado do refinamento visual: texto introdutório grande demais em Estoque, WhatsApp Visão
// Geral etc.) sem perder a explicação, só deixando ela sob demanda.
export function InfoTooltip({ content }: { content: ReactNode }) {
  return (
    <Tooltip content={<div className="ds-tooltip__texto">{content}</div>}>
      <button type="button" className="ds-icon-btn ds-icon-btn--info" aria-label="Mais informações">
        {INFO_ICON}
      </button>
    </Tooltip>
  );
}
