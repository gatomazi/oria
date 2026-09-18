import { forwardRef, type SelectHTMLAttributes } from 'react';

// <select> nativo com o visual do design system (chevron próprio, control-bg, estados). Nativo de
// propósito: teclado, leitor de tela e mobile de graça, sem biblioteca nova.
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { controlSize?: 'md' | 'sm' };

export const Select = Object.assign(
  forwardRef<HTMLSelectElement, SelectProps>(function Select({ className, controlSize, children, ...rest }, ref) {
    return (
      <select ref={ref} className={['ds-select', controlSize === 'sm' ? 'ds-select--sm' : null, className].filter(Boolean).join(' ')} {...rest}>
        {children}
      </select>
    );
  }),
  { dsControl: true },
);
