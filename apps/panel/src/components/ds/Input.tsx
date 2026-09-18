import { forwardRef, type InputHTMLAttributes } from 'react';

// forwardRef pra suportar inputs não-controlados (ex.: campos de variável que recebem texto
// inserido via manipulação direta do DOM — ver pages/campos/CampoCard.tsx). `dsControl` marca o
// componente como controle rotulável pra Field associar <label htmlFor> automaticamente.
type InputProps = InputHTMLAttributes<HTMLInputElement> & { controlSize?: 'md' | 'sm' };

export const Input = Object.assign(
  forwardRef<HTMLInputElement, InputProps>(function Input({ className, controlSize, ...rest }, ref) {
    return <input ref={ref} className={['ds-input', controlSize === 'sm' ? 'ds-input--sm' : null, className].filter(Boolean).join(' ')} {...rest} />;
  }),
  { dsControl: true },
);
