import { api } from './client';

export interface ProductSettingsData {
  productName: string;
}

export function getProductSettings() {
  return api<ProductSettingsData>('/api/admin/settings/product');
}

export function updateProductSettings(data: ProductSettingsData) {
  return api('/api/admin/settings/product', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
