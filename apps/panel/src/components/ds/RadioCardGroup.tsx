import type { ReactNode } from 'react';

// Escolha entre opções com explicação (DESIGN.md › Inputs / Fields): fieldset + legend, rádio
// nativo (teclado e leitor de tela de graça) dentro de cartão clicável; selecionado com borda accent.
export interface RadioCardOption<V extends string> {
  value: V;
  title: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

interface RadioCardGroupProps<V extends string> {
  name: string;
  legend: string;
  hideLegend?: boolean;
  value: V | null | undefined;
  options: RadioCardOption<V>[];
  onChange: (value: V) => void;
  columns?: 1 | 2;
}

export function RadioCardGroup<V extends string>({ name, legend, hideLegend, value, options, onChange, columns = 2 }: RadioCardGroupProps<V>) {
  return (
    <fieldset className={`ds-radio-cards ds-radio-cards--${columns}`}>
      <legend className={hideLegend ? 'ds-sr-only' : 'ds-field__label'}>{legend}</legend>
      <div className="ds-radio-cards__grid">
        {options.map((opt) => {
          const checked = value === opt.value;
          return (
            <label
              key={opt.value}
              className={['ds-radio-card', checked ? 'ds-radio-card--checked' : null, opt.disabled ? 'ds-radio-card--disabled' : null].filter(Boolean).join(' ')}
            >
              <input type="radio" name={name} value={opt.value} checked={checked} disabled={opt.disabled} onChange={() => onChange(opt.value)} />
              <span className="ds-radio-card__text">
                <span className="ds-radio-card__title">{opt.title}</span>
                {opt.description && <span className="ds-radio-card__description">{opt.description}</span>}
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
