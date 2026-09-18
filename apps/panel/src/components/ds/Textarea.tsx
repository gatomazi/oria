import { forwardRef, type TextareaHTMLAttributes } from 'react';

export const Textarea = Object.assign(
  forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={['ds-textarea', className].filter(Boolean).join(' ')} {...rest} />;
  }),
  { dsControl: true },
);
