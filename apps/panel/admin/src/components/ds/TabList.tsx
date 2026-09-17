import { useRef, type KeyboardEvent, type ReactNode } from 'react';

// Barra de abas controlada (DESIGN.md › Tabs) pra páginas que já cuidam do próprio conteúdo:
// role="tablist"/"tab", aria-selected, setas ←/→, Home/End e contador opcional.
export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  count?: number | null;
}

interface TabListProps<V extends string> {
  items: TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
}

export function TabList<V extends string>({ items, value, onChange, label }: TabListProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(ev: KeyboardEvent, index: number) {
    let next = -1;
    if (ev.key === 'ArrowRight') next = (index + 1) % items.length;
    else if (ev.key === 'ArrowLeft') next = (index - 1 + items.length) % items.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = items.length - 1;
    if (next < 0) return;
    ev.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].value);
  }

  return (
    <div className="ds-tabs" role="tablist" aria-label={label}>
      {items.map((item, i) => {
        const ativa = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={ativa}
            tabIndex={ativa ? 0 : -1}
            className={'ds-tab' + (ativa ? ' ds-tab--ativa' : '')}
            onClick={() => onChange(item.value)}
            onKeyDown={(ev) => onKeyDown(ev, i)}
          >
            {item.label}
            {item.count != null && <span className="ds-tab__count ds-num">{item.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
