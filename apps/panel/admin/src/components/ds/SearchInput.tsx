import { forwardRef, type InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

// Campo de busca com lupa. O rótulo acessível vem de `aria-label` (o placeholder não substitui
// rótulo pra leitor de tela).
type SearchInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { 'aria-label': string; wrapperClassName?: string };

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(function SearchInput({ className, wrapperClassName, ...rest }, ref) {
  return (
    <span className={['ds-search', wrapperClassName].filter(Boolean).join(' ')}>
      <Icon name="search" className="ds-search__icon" />
      <input ref={ref} type="search" className={['ds-input', className].filter(Boolean).join(' ')} {...rest} />
    </span>
  );
});
