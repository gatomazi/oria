import { ICONS } from './icons';

// Ícone SVG do conjunto único (icons.ts). Decorativo por padrão (aria-hidden); quando o ícone é
// o único conteúdo de um controle, o rótulo acessível fica no controle (aria-label), não aqui.
export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  const inner = ICONS[name];
  if (!inner) return null;
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}
