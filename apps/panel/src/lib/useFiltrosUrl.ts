import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

// Filtros na URL: navegar para um perfil e voltar preserva período, tipo de data e status; e um link com filtro (ex.: "vencidos") abre a
// tela já filtrada. Só chaves declaradas em `padrao` são lidas; valor igual ao padrão nem entra na URL.
export function useFiltrosUrl<T extends Record<string, string>>(padrao: T) {
  const [params, setParams] = useSearchParams();
  const chaves = Object.keys(padrao) as (keyof T & string)[];
  const valores = useMemo(() => {
    const v = { ...padrao } as Record<string, string>;
    for (const k of chaves) v[k] = params.get(k) ?? padrao[k];
    return v as T;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const alterar = useCallback((patch: Partial<T>) => {
    setParams((anterior) => {
      const n = new URLSearchParams(anterior);
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '' || v === padrao[k]) n.delete(k);
        else n.set(k, String(v));
      }
      if (!('page' in patch)) n.delete('page');
      return n;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setParams]);

  const limpar = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);
  const ativos = chaves.filter((k) => valores[k] !== padrao[k] && k !== 'page').length;
  return { valores, alterar, limpar, ativos };
}
