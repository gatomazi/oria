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
  get(id: string): StoreInfo | null {
    return STORES[id] ?? null;
  },
  list(): StoreInfo[] {
    return ORDER.map((id) => STORES[id]);
  },
  ids(): string[] {
    return [...ORDER];
  },
  name(id: string): string {
    return STORES[id]?.name ?? id;
  },
  color(id: string): string {
    return STORES[id]?.color ?? '#4d543d';
  },
};
