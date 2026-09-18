import { useState } from 'react';

// Dado pessoal mascarado com ação "Mostrar" (decisão D7). Mantém só os 3 primeiros e os 2 últimos
// dígitos visíveis; o valor completo aparece sob demanda, sem sair da tela.
export function mascararDocumento(valor: string): string {
  const digitos = valor.replace(/\D/g, '');
  if (digitos.length < 6) return '•'.repeat(Math.max(digitos.length, 3));
  const meio = '•'.repeat(digitos.length - 5);
  return `${digitos.slice(0, 3)}${meio}${digitos.slice(-2)}`;
}

export function MaskedValue({ value, label }: { value: string | null | undefined; label: string }) {
  const [visivel, setVisivel] = useState(false);
  if (!value) return <>—</>;
  return (
    <span className="ds-masked">
      <span className="ds-num">{visivel ? value : mascararDocumento(value)}</span>
      <button type="button" className="ds-masked__toggle" aria-label={`${visivel ? 'Ocultar' : 'Mostrar'} ${label}`} onClick={() => setVisivel((v) => !v)}>
        {visivel ? 'Ocultar' : 'Mostrar'}
      </button>
    </span>
  );
}
