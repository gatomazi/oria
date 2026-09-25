import { api } from './client';

// Rodada "Observabilidade e controle do catalog sync" · o full sync do catálogo canônico
// (commerce_products) já roda sozinho (automático, no boot e a cada hora — ver server.js) e também
// por clique manual. Este client cobre as duas pontas que faltavam: acompanhar o progresso ao vivo
// (não só o resultado final) e um kill switch pra destravar um run que ficou 'running' sem nunca
// fechar — achado real de dogfooding (Use Sul, 2026-09-24).

export type CatalogSyncState =
  | 'never_synced' | 'queued' | 'running' | 'completed' | 'partial_failure' | 'failed' | 'cancelled';

export interface CatalogSyncLastRun {
  status: 'running' | 'success' | 'partial_failure' | 'failed' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  pagesProcessed: number;
  pagesTotal: number | null;
  productsSeen: number;
  productsInserted: number;
  productsUpdated: number;
  productsDeactivated: number;
  errorCode: string | null;
}

export interface CatalogSyncStatus {
  syncing: boolean;
  state: CatalogSyncState;
  lastRun: CatalogSyncLastRun | null;
}

export function getCatalogSyncStatus() {
  return api<CatalogSyncStatus>('/api/admin/product-analytics/catalog-sync/status');
}

export function iniciarCatalogSync() {
  return api<{ ok: true; status: 'started' | 'already_running' }>('/api/admin/product-analytics/catalog-sync', {
    method: 'POST',
  });
}

export function cancelarCatalogSync() {
  return api<{ status: 'cancelled' | 'nothing_to_cancel'; syncRunIds: string[]; leaseLiberado: boolean }>(
    '/api/admin/product-analytics/catalog-sync/cancelar',
    { method: 'POST' },
  );
}
