import { api } from './client';

// "Migração Use Origens" (docs/claude-categorias-lote-migracao-use-origens.md) não é feature de
// cliente SaaS normal. O backend bloqueia de verdade via env var (INTERNAL_TOOLS_ENABLED) — este
// endpoint só serve pro frontend decidir se mostra o item de menu; esconder o link sozinho nunca
// seria proteção real (o backend recusa com 404 mesmo que alguém acesse a rota direto).
export function getInternalToolsStatus() {
  return api<{ enabled: boolean }>('/api/admin/internal-tools/status');
}
