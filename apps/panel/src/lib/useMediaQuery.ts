import { useEffect, useState } from 'react';

// Escuta uma media query (ex.: '(max-width: 700px)'). Serve para decidir ONDE renderizar um bloco (uma única instância no DOM),
// não para duplicar marcação por breakpoint.
export function useMediaQuery(consulta: string): boolean {
  const [ativa, setAtiva] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(consulta).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(consulta);
    const atualizar = () => setAtiva(mq.matches);
    atualizar();
    mq.addEventListener('change', atualizar);
    return () => mq.removeEventListener('change', atualizar);
  }, [consulta]);
  return ativa;
}
