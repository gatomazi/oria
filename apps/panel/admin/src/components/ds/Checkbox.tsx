import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

// Checkbox com rótulo clicável e descrição opcional (checkbox nativo, accent-color do tema).
type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; description?: ReactNode };

export function Checkbox({ label, description, className, id, ...rest }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <div className={['ds-checkbox', className].filter(Boolean).join(' ')}>
      <input type="checkbox" id={inputId} aria-describedby={description ? `${inputId}-desc` : undefined} {...rest} />
      <label htmlFor={inputId} className="ds-checkbox__text">
        <span className="ds-checkbox__label">{label}</span>
        {description && (
          <span className="ds-checkbox__description" id={`${inputId}-desc`}>
            {description}
          </span>
        )}
      </label>
    </div>
  );
}
