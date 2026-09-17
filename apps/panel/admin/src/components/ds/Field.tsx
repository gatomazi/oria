import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

// Rótulo + controle + hint/erro (DESIGN.md › Inputs / Fields). Associa <label htmlFor> ao
// controle automaticamente quando o filho é um controle rotulável (input/select/textarea nativos
// ou Input/Select/Textarea do DS) — antes o label ficava solto e o leitor de tela não anunciava
// o campo. Filhos compostos (grupos, dropzone) continuam funcionando como antes, sem associação.
interface FieldProps {
  label?: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  optional?: boolean;
  htmlFor?: string;
  children?: ReactNode;
}

const NATIVE_CONTROLS = new Set(['input', 'select', 'textarea']);

function isControl(el: ReactElement): boolean {
  if (typeof el.type === 'string') return NATIVE_CONTROLS.has(el.type);
  return !!(el.type as { dsControl?: boolean }).dsControl;
}

export function Field({ label, hint, error, required, optional, htmlFor, children }: FieldProps) {
  const autoId = useId();
  const hintId = hint ? `${autoId}-hint` : undefined;
  const errorId = error ? `${autoId}-error` : undefined;

  let controlId = htmlFor;
  let control = children;
  if (!htmlFor && isValidElement(children) && isControl(children)) {
    const props = children.props as { id?: string; 'aria-describedby'?: string };
    controlId = props.id ?? `${autoId}-control`;
    const describedBy = [props['aria-describedby'], errorId, hintId].filter(Boolean).join(' ') || undefined;
    control = cloneElement(children as ReactElement<Record<string, unknown>>, {
      id: controlId,
      'aria-describedby': describedBy,
      ...(error ? { 'aria-invalid': true } : {}),
      ...(required ? { 'aria-required': true } : {}),
    });
  }

  return (
    <div className="ds-field">
      {label && (
        <label className="ds-field__label" htmlFor={controlId}>
          {label}
          {required && <span className="ds-field__required" aria-hidden="true">*</span>}
          {optional && <span className="ds-field__optional"> (opcional)</span>}
        </label>
      )}
      {control}
      {error && (
        <div className="ds-field__error" id={errorId}>
          {error}
        </div>
      )}
      {hint && (
        <div className="ds-field__hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}
