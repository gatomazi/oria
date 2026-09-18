import { useId, type ReactNode } from 'react';

// Liga/desliga de configuração (role="switch"). Quem usa decide se aplica na hora ou junto de um "Salvar".
interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  const id = useId();
  return (
    <div className="ds-switch-row">
      <div className="ds-switch-row__text">
        <span className="ds-switch-row__label" id={`${id}-label`}>
          {label}
        </span>
        {description && (
          <span className="ds-switch-row__description" id={`${id}-desc`}>
            {description}
          </span>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        className={'ds-switch' + (checked ? ' ds-switch--on' : '')}
        onClick={() => onChange(!checked)}
      >
        <span className="ds-switch__thumb" />
      </button>
    </div>
  );
}
