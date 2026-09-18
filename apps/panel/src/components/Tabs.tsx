import { useState, type ReactNode } from 'react';
import { TabList } from './ds/TabList';

// Abas com conteúdo (DESIGN.md › Tabs). A barra é o TabList do design system (role="tablist",
// setas, aria-selected); este componente só guarda qual aba está ativa e renderiza o painel.
export interface TabDef {
  label: string;
  render: () => ReactNode;
  count?: number | null;
}

// activeIndex/onChangeIndex são opcionais e aditivos — controle externo (ex: "Ver" no Histórico
// da Migração Use Origens abrindo direto na aba de Simulação) sem afetar quem já usa Tabs sem
// controlar o índice de fora (continua com o estado interno de sempre).
export function Tabs({ tabs, activeIndex, onChangeIndex, label = 'Seções' }: { tabs: TabDef[]; activeIndex?: number; onChangeIndex?: (i: number) => void; label?: string }) {
  const [internalActive, setInternalActive] = useState(0);
  const active = activeIndex ?? internalActive;
  function setActive(i: number) {
    if (onChangeIndex) onChangeIndex(i);
    else setInternalActive(i);
  }
  return (
    <div>
      <TabList
        label={label}
        value={String(active)}
        onChange={(v) => setActive(Number(v))}
        items={tabs.map((t, i) => ({ value: String(i), label: t.label, count: t.count }))}
      />
      <div role="tabpanel">{tabs[active].render()}</div>
    </div>
  );
}
