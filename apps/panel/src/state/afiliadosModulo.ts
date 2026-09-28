// Estado do módulo Parcerias e Afiliados para a Organization ativa: flag do servidor (AFILIADOS_MODULE_ENABLED) e papel. Fail-closed:
// erro ou ausência = módulo desligado. O servidor é a autoridade — esconder o item de menu é só navegação, nunca autorização.
import { useEffect, useState } from 'react';
import { afiliados, type StatusModulo } from '../api/afiliados';
import { useAuth } from '../auth/AuthContext';

const SEM_CAPACIDADE = { provider: 'ink', read: false, create: false, update: false, delete: false };
const DESLIGADO: StatusModulo = { enabled: false, couponCreation: SEM_CAPACIDADE, papel: null };

let cache: { organizacaoId: string | null; status: StatusModulo } | null = null;
let pendente: Promise<StatusModulo> | null = null;

export function carregarStatusAfiliados(organizacaoId: string | null): Promise<StatusModulo> {
  if (cache && cache.organizacaoId === organizacaoId) return Promise.resolve(cache.status);
  if (pendente) return pendente;
  pendente = afiliados
    .status()
    .then((s) => {
      cache = { organizacaoId, status: { enabled: s.enabled === true, couponCreation: s.couponCreation ?? SEM_CAPACIDADE, papel: s.papel === 'owner' || s.papel === 'member' ? s.papel : null } };
      return cache.status;
    })
    .catch(() => DESLIGADO)
    .finally(() => { pendente = null; });
  return pendente;
}

export function useStatusAfiliados(): StatusModulo | null {
  const organizacaoId = useAuth().organizacaoAtiva?.id ?? null;
  const [lido, setLido] = useState<{ organizacaoId: string | null; status: StatusModulo } | null>(null);
  useEffect(() => {
    let vivo = true;
    setLido(null);
    carregarStatusAfiliados(organizacaoId).then((status) => { if (vivo) setLido({ organizacaoId, status }); });
    return () => { vivo = false; };
  }, [organizacaoId]);
  return lido && lido.organizacaoId === organizacaoId ? lido.status : null;
}
