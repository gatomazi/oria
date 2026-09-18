import { api } from './client';

// Tipos e chamadas pra /api/admin/promocoes/* — porte do que src/promocoes.js já fazia.
export interface DiscountTier {
  discount?: number;
  min_cart_value?: number;
  min_cart_items?: number;
}

export interface Promocao {
  id: number;
  type: 'standard' | 'progressive' | 'unit_free' | string;
  code: string;
  kind?: 'percentage' | 'value';
  available?: boolean;
  starts_at?: string | null;
  expires_at?: string | null;
  discount_tiers?: DiscountTier[];
}

export function listPromocoes() {
  return api<{ promocoes: Promocao[] }>(`/api/admin/promocoes`);
}

export interface CriarPromocaoInput {
  type: string;
  code: string;
  list_type: string;
  apply_automatically: boolean;
  kind?: string;
  progress_kind?: string;
  product_ids?: number[];
  product_type_ids?: number[];
  collection_ids?: number[];
  discount_tier?: DiscountTier;
  discount_tiers?: DiscountTier[];
}

export function criarPromocao(data: CriarPromocaoInput) {
  return api(`/api/admin/promocoes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function excluirPromocao(id: number) {
  return api(`/api/admin/promocoes/${id}`, { method: 'DELETE' });
}
