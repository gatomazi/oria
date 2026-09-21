// Porte 1:1 de src/admin/admin-stores.js — única fonte de verdade sobre as lojas.
export interface StoreInfo {
  id: string;
  name: string;
  shortName: string;
  color: string;
}

const STORES: Record<string, StoreInfo> = {
  sul: { id: 'sul', name: 'Use Sul', shortName: 'Sul', color: '#4d543d' },
  centro: { id: 'centro', name: 'Use Centro', shortName: 'Centro', color: '#8b5e3c' },
  norte: { id: 'norte', name: 'Use Norte', shortName: 'Norte', color: '#2d4a2b' },
};
const ORDER = ['sul', 'centro', 'norte'];

export const adminStores = {
  get(id: string | null | undefined): StoreInfo | null {
    return (id && STORES[id]) || null;
  },
  list(): StoreInfo[] {
    return ORDER.map((id) => STORES[id]);
  },
  ids(): string[] {
    return [...ORDER];
  },
  // Store nativa do Oria não tem chave legada (`id` nulo): não há nome a mostrar.
  name(id: string | null | undefined): string {
    return id ? STORES[id]?.name ?? id : '—';
  },
  // Nome para exibir: chave legada conhecida, senão `fallback` (o nome da Store nativa). A chave de
  // uma Store nativa é o `store_id` — um id opaco que nunca deve aparecer como nome.
  nameOr(id: string | null | undefined, fallback: string): string {
    return (id && STORES[id]?.name) || fallback || '—';
  },
  color(id: string | null | undefined): string {
    return (id && STORES[id]?.color) || '#4d543d';
  },
};
