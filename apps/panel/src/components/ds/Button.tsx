import type { ButtonHTMLAttributes } from 'react';

// Classes ds-btn/ds-btn--* (DESIGN.md › Buttons). `danger` é o destrutivo tintado do dia a dia;
// `danger-solid` fica reservado ao confirmar de diálogo destrutivo (ConfirmDialog faz a troca).
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-solid';
export type ButtonSize = 'md' | 'sm';

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  block?: boolean;
}

export function Button({ variant = 'primary', size = 'md', block, className, type = 'button', children, ...rest }: ButtonProps) {
  const classes = ['ds-btn', `ds-btn--${variant}`, size === 'sm' ? 'ds-btn--sm' : null, block ? 'ds-btn--block' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
