import { useCallback, useEffect, useRef, useState } from 'react';

// Carrega dado assíncrono com estados explícitos (carregando / erro / dado) e descarta respostas antigas: trocar de filtro rápido nunca deixa a
// resposta lenta da consulta anterior sobrescrever a atual.
export function useAsync<T>(carregar: () => Promise<T>, deps: unknown[]) {
  const [dado, setDado] = useState<T | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const versao = useRef(0);

  const executar = useCallback(() => {
    const minha = ++versao.current;
    setCarregando(true);
    setErro('');
    carregar()
      .then((d) => { if (versao.current === minha) { setDado(d); setCarregando(false); } })
      .catch((err: unknown) => {
        if (versao.current !== minha) return;
        setErro(err instanceof Error ? err.message : 'Não foi possível carregar.');
        setCarregando(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { executar(); }, [executar]);
  return { dado, erro, carregando, recarregar: executar };
}
