// Entitlements da Organization ativa (TD-012 V1). Espelho do backend, que é a autoridade: a tela só
// usa isto para esconder o que o servidor já nega. Fail-closed: erro ou ausência = sem a feature.
//
// Catálogo, Trocas e Reembolsos JÁ foram classificados como capacidade do Connector Ink, mas
// continuam aqui: o backend ainda as confere como entitlement, e o espelho precisa refletir o que
// o servidor faz — não o que ele vai fazer. Saem quando o guard de connector for ligado, junto com
// o read model do connector. Ver docs/architecture/features-vs-connectors.md § Plano de retirada.
import { api } from '../api/client';

export interface Entitlements {
  whatsapp: boolean;
  instagram: boolean;
  advancedAutomations: boolean;
  catalog: boolean;
  exchanges: boolean;
  refunds: boolean;
  financial: boolean;
  creative_generator: boolean;
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
