import type { ReactNode } from 'react';

// Formatação nativa do WhatsApp (*negrito*, _itálico_, ~riscado~, ```mono```) convertida em
// elementos React — nunca via innerHTML, o texto vem do usuário. Links viram <a> clicáveis como no
// app. Regra igual à do WhatsApp: o marcador precisa abrir e fechar na mesma linha.
const PADRAO = /(```[^`]+```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|https?:\/\/[^\s]+)/g;

export function formatarTextoWhatsapp(texto: string): ReactNode[] {
  const partes: ReactNode[] = [];
  let ultimo = 0;
  let chave = 0;
  for (const match of texto.matchAll(PADRAO)) {
    const inicio = match.index ?? 0;
    if (inicio > ultimo) partes.push(texto.slice(ultimo, inicio));
    const trecho = match[0];
    if (trecho.startsWith('```')) partes.push(<code key={chave++}>{trecho.slice(3, -3)}</code>);
    else if (trecho.startsWith('*')) partes.push(<strong key={chave++}>{trecho.slice(1, -1)}</strong>);
    else if (trecho.startsWith('_')) partes.push(<em key={chave++}>{trecho.slice(1, -1)}</em>);
    else if (trecho.startsWith('~')) partes.push(<s key={chave++}>{trecho.slice(1, -1)}</s>);
    else {
      partes.push(
        <a key={chave++} href={trecho} target="_blank" rel="noopener noreferrer">
          {trecho}
        </a>,
      );
    }
    ultimo = inicio + trecho.length;
  }
  if (ultimo < texto.length) partes.push(texto.slice(ultimo));
  return partes;
}

// Variáveis {{...}} presentes no texto que não estão entre as permitidas.
export function variaveisInvalidas(texto: string, permitidas: string[]): string[] {
  const achadas = new Set<string>();
  for (const m of texto.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) achadas.add(m[1]);
  return [...achadas].filter((v) => !permitidas.includes(v));
}
