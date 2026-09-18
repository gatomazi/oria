import { api } from './client';

// Porte de src/simular-frete.js.
export interface DeliveryOption {
  name?: string;
  cost?: number | string;
  estimated_business_days?: number;
}

export interface ReferenceProduct {
  description?: string;
  weight?: number;
  width?: number;
  height?: number;
  length?: number;
}

export interface SimulacaoFrete {
  cep?: string;
  delivery_options?: DeliveryOption[];
  reference_product?: ReferenceProduct;
}

export function simularFrete(cep: string) {
  return api<{ simulacao: SimulacaoFrete }>(`/api/admin/frete/simular?cep=${encodeURIComponent(cep)}`);
}
