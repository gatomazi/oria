// Entitlements da Organization ativa (TD-012 V1). Espelho do backend, que é a autoridade: a tela só
// usa isto para esconder o que o servidor já nega. Fail-closed: erro ou ausência = sem a feature.
//
// Catálogo, Trocas e Reembolsos JÁ foram classificados como capacidade do Connector Ink, mas
// continuam aqui: o backend ainda as confere como entitlement, e o espelho precisa refletir o que
// o servidor faz — não o que ele vai fazer. Saem quando o guard de connector for ligado, junto com
// o read model do connector. Ver docs/architecture/features-vs-connectors.md § Plano de retirada.
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export interface Entitlements {
  whatsapp: boolean;
  instagram: boolean;
  advancedAutomations: boolean;
  catalog: boolean;
  exchanges: boolean;
  refunds: boolean;
  financial: boolean;
  creative_generator: boolean;
  // Rodada H→I: Desempenho de Produtos (GA4 + Commerce reconciliado) — guard real desde o início
  // (lib/platform/feature-routes.js), diferente de meta_ads/google_ads/analytics_ga4 (sem_guard).
  analytics_product_performance: boolean;
}

const NADA: Entitlements = {
  whatsapp: false,
  instagram: false,
  advancedAutomations: false,
  catalog: false,
  exchanges: false,
  refunds: false,
  financial: false,
  creative_generator: false,
  analytics_product_performance: false,
};

let cache: Entitlements | null = null;
let pending: Promise<Entitlements> | null = null;

export function loadEntitlements(): Promise<Entitlements> {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  pending = api<Partial<Record<keyof Entitlements, unknown>>>('/api/admin/entitlements')
    .then((data) => {
      // Só o booleano true concede; qualquer outra coisa (ausente, "true", 1) é false.
      const plano = { ...NADA };
      for (const chave of Object.keys(NADA) as (keyof Entitlements)[]) plano[chave] = data[chave] === true;
      cache = plano;
      return cache;
    })
    .catch(() => {
      // Sem cache: a próxima tela tenta de novo, em vez de fixar "nada" para a sessão inteira.
      return { ...NADA };
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export function hasEntitlement(key: keyof Entitlements): boolean {
  return cache ? cache[key] === true : false;
}

// Diferencia "o servidor disse que não há plano" de "não consegui perguntar": o cache só existe
// depois de uma resposta válida. Quem só exibe informação (cabeçalho do menu da loja) usa isto
// para omitir a linha em vez de afirmar "sem plano".
export function entitlementsCarregados(): boolean {
  return cache !== null;
}

// Para a tela decidir se mostra uma ação: só é `true` depois de o servidor responder que a Organization ATIVA tem a feature.
// Carregando, falha de leitura ou troca de Organization = `false` (nunca um botão que o servidor recusaria, nunca o plano da
// Organization anterior). O servidor continua sendo a autoridade: esconder é UX, não segurança.
export function useEntitlement(chave: keyof Entitlements): boolean {
  const organizacaoId = useAuth().organizacaoAtiva?.id ?? null;
  const [lido, setLido] = useState<{ organizacaoId: string | null; liberado: boolean } | null>(null);
  useEffect(() => {
    let vivo = true;
    setLido(null);
    loadEntitlements().then(() => {
      if (vivo) setLido({ organizacaoId, liberado: entitlementsCarregados() && hasEntitlement(chave) });
    });
    return () => {
      vivo = false;
    };
  }, [organizacaoId, chave]);
  return lido !== null && lido.organizacaoId === organizacaoId && lido.liberado;
}
