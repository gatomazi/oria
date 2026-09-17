// Porte de loadProductSettings() em src/admin/admin-shell.js — cache 1x por sessão de página.
// Fase 3: não existe mais "modo multi-loja" — cada sessão trabalha numa Organization.
import { api } from '../api/client';

export interface ProductSettings {
  productName: string;
}

const DEFAULTS: ProductSettings = { productName: 'Orgulho Regional' };

let cache: ProductSettings | null = null;

export function loadProductSettings(): Promise<ProductSettings> {
  if (cache) return Promise.resolve(cache);
  return api<ProductSettings>('/api/admin/settings/product')
    .then((data) => {
      cache = data;
      return cache;
    })
    .catch(() => {
      cache = DEFAULTS;
      return cache;
    });
}
