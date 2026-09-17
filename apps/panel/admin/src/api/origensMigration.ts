import { api } from './client';

// Client de "Migração Use Origens" (docs/claude-categorias-lote-migracao-use-origens.md, Partes
// 4-7). Rotas protegidas no backend por requireInternalTools — se a env var estiver desligada,
// toda chamada aqui devolve 404 (tratado como erro comum pelo client `api()`).

export type OperadorRegra = 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'equals';

// current_category: coleções especiais que só dá pra identificar pela categoria de origem do
// produto, não pelo nome (doc: claude-migracao-final-categorias-snapshot-especiais.md, Grupo B).
export type FonteCondicaoRegra = 'product_name' | 'current_category';

export interface CondicaoRegra {
  field: FonteCondicaoRegra;
  operator: OperadorRegra;
  value: string;
}

export interface MigrationRule {
  id: number;
  loja: string;
  nome: string;
  habilitada: boolean;
  prioridade: number;
  dimensao: string | null;
  condicoes: CondicaoRegra[];
  categoria_ids_saida: number[];
  criado_em: string;
  atualizado_em: string;
}

export interface MigrationRuleInput {
  nome?: string;
  habilitada?: boolean;
  prioridade?: number;
  dimensao?: string | null;
  condicoes?: CondicaoRegra[];
  categoriaIdsSaida?: number[];
}

export function listMigrationRules() {
  return api<{ regras: MigrationRule[] }>(`/api/admin/internal/origens-migration/rules`);
}

export function createMigrationRule(input: MigrationRuleInput) {
  return api<{ regra: MigrationRule }>('/api/admin/internal/origens-migration/rules', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

export function updateMigrationRule(id: number, input: Partial<MigrationRuleInput>) {
  return api<{ regra: MigrationRule }>(`/api/admin/internal/origens-migration/rules/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

export function deleteMigrationRule(id: number) {
  return api(`/api/admin/internal/origens-migration/rules/${id}`, { method: 'DELETE' });
}

export interface SimulationSummary {
  totalAnalisados: number;
  totalProntos: number;
  totalSemRegra: number;
  totalConflito: number;
}

// Só cria a simulação e devolve o id — o processamento roda em background, página por página da
// Ink (loja com muitos produtos demorava mais que uma request HTTP e travava sem feedback nenhum,
// bug real reportado pelo usuário, 2026-09-09). Acompanhar via getMigrationSimulation (polling).
export function simularMigracao() {
  return api<{ simulationId: number }>('/api/admin/internal/origens-migration/simulate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
}

export type MigrationSimulationStatus = 'processando' | 'simulada' | 'falhou' | 'executando' | 'executada';

export interface MigrationSimulation {
  id: number;
  loja: string;
  total_analisados: number;
  total_prontos: number;
  total_sem_regra: number;
  total_conflito: number;
  status: MigrationSimulationStatus;
  paginas_processadas: number;
  paginas_total: number | null;
  produtos_processados: number;
  erro: string | null;
  job_id: number | null;
  criado_em: string;
  executada_em: string | null;
  job_status?: string | null;
  job_processed?: number | null;
  job_total?: number | null;
  job_succeeded?: number | null;
  job_failed?: number | null;
}

export function listMigrationSimulations() {
  return api<{ simulacoes: MigrationSimulation[] }>(`/api/admin/internal/origens-migration/simulations`);
}

// Polling de progresso enquanto status === 'processando'.
export function getMigrationSimulation(id: number) {
  return api<{ simulacao: MigrationSimulation }>(`/api/admin/internal/origens-migration/simulations/${id}`);
}

// Reclassifica só os itens 'sem_regra'/'conflito' de uma simulação já existente (ex: depois de
// importar o dicionário de cidades, ou criar regra/categoria nova) — sem paginar o catálogo de
// novo na Ink, bem mais rápido que rodar uma simulação inteira nova.
export function reavaliarConflitosSimulacao(simulationId: number) {
  return api<{ reavaliados: number; resolvidos: number; aindaPendente: number }>(
    `/api/admin/internal/origens-migration/simulations/${simulationId}/reavaliar-conflitos`,
    { method: 'POST' }
  );
}

export type MigrationItemStatus = 'pronto' | 'sem_regra' | 'conflito';

export interface MigrationSimulationItem {
  id: number;
  simulation_id: number;
  product_id: number;
  product_name: string | null;
  matched_rule_ids: number[];
  collection_detectada: string | null;
  uf_detectada: string | null;
  regiao_detectada: string | null;
  categorias_finais: number[];
  status: MigrationItemStatus;
  conflito_motivo: string | null;
  override_categorias: number[] | null;
  override_ignorar: boolean;
  cidade_detectada: string | null;
  fonte_uf: 'titulo' | 'mapa_cidade' | null;
  confianca: 'alta' | 'revisar' | null;
}

export function listMigrationSimulationItems(simulationId: number, status: string, page: number, pageSize = 50) {
  const params = new URLSearchParams({ status, page: String(page), pageSize: String(pageSize) });
  return api<{ itens: MigrationSimulationItem[]; total: number; page: number; pageSize: number }>(
    `/api/admin/internal/origens-migration/simulations/${simulationId}/items?${params.toString()}`
  );
}

export function overrideMigrationItem(simulationId: number, itemId: number, input: { overrideCategorias?: number[] | null; overrideIgnorar?: boolean }) {
  return api<{ item: MigrationSimulationItem }>(`/api/admin/internal/origens-migration/simulations/${simulationId}/items/${itemId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}

// escopo 'todos' (padrão) = tudo que está pronto, inclusive o classificado pelo fallback cidade→UF
// (catálogo inteiro). 'regras' = só produtos que bateram em regra explícita; com regraIds, só nas
// regras escolhidas — é o recorte pra rodar poucas regras novas sem mexer no catálogo todo.
export interface ExecutarMigracaoOpcoes {
  escopo?: 'todos' | 'regras';
  regraIds?: number[];
}

export function executarMigracao(simulationId: number, opcoes: ExecutarMigracaoOpcoes = {}) {
  return api<{ jobId: number; total: number }>(`/api/admin/internal/origens-migration/simulations/${simulationId}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opcoes),
  });
}

export interface ContagemPorRegra {
  id: number;
  nome: string;
  habilitada: boolean;
  total: number;
}

export function getMigrationRuleCounts(simulationId: number) {
  return api<{ regras: ContagemPorRegra[]; totalPorRegra: number; totalPorFallback: number }>(
    `/api/admin/internal/origens-migration/simulations/${simulationId}/rule-counts`
  );
}

export function exportMigrationCsvUrl(simulationId: number) {
  return `/api/admin/internal/origens-migration/simulations/${simulationId}/export.csv`;
}

// ── Preload de regras padrão + Mapa Cidade → UF
// (docs/claude-preload-regras-use-origens-cidade-uf.md) ─────────────────────

export type PresetItemStatus = 'pronta' | 'ja_existe' | 'atualizar_categoria' | 'categoria_ausente' | 'sem_categoria_origem';

export interface PresetCandidatoCategoria {
  nome: string;
  candidatos: { id: number; nome: string }[];
}

// Campos comuns aos 2 presets (cidade e especial) — o que muda entre eles é só o "rótulo" da
// combinação (colecao/uf vs origem/destino); o resto (resolução de categoria, idempotência,
// status) é idêntico e resolvido pelo mesmo backend nos dois casos.
export interface PresetRuleItemBase {
  nome: string;
  dimensao: string;
  prioridade: number;
  condicoes: CondicaoRegra[];
  categoriasNomes: string[];
  categoriaIdsSaida: number[] | null;
  // Resolução individual por posição (1 categoria pode resolver mesmo que outra do mesmo combo
  // não resolva) — categoriaIdsSaida só vem preenchido quando TODAS resolvem (é o gate de
  // "pronta pra criar"), então a UI usa este campo pra saber quais posições já têm categoria
  // real, em vez de tratar a linha inteira como ausente por causa de 1 categoria faltando.
  categoriaIdsPorPosicao: (number | null)[];
  candidatosAmbiguos: PresetCandidatoCategoria[];
  regraIdParaAtualizar: number | null;
  status: PresetItemStatus;
}

export interface PresetRuleItem extends PresetRuleItemBase {
  colecao: string;
  uf: string;
}

// Grupo B (doc: claude-migracao-final-categorias-snapshot-especiais.md) — coleções especiais,
// classificadas pela categoria ATUAL do produto (não pelo nome). `origem` pode não existir em
// toda loja (status 'sem_categoria_origem' nesse caso, não é erro).
export interface PresetEspecialItem extends PresetRuleItemBase {
  origem: string;
  destino: string;
}

export function presetPreviewRules() {
  return api<{
    presetSize: number; itens: PresetRuleItem[];
    resumo: { pronta: number; jaExiste: number; atualizarCategoria: number; categoriaAusente: number };
  }>(`/api/admin/internal/origens-migration/rules/preset-preview`);
}

export function presetEspeciaisPreviewRules() {
  return api<{
    presetSize: number; itens: PresetEspecialItem[];
    resumo: { pronta: number; jaExiste: number; atualizarCategoria: number; categoriaAusente: number; semCategoriaOrigem: number };
  }>(`/api/admin/internal/origens-migration/rules/preset-especiais-preview`);
}

// Reaproveitado pelos 2 presets — o create já é genérico (não depende de nada específico do
// Grupo A), não existe endpoint separado pro Grupo B.
export function presetCreateRules(itens: PresetRuleItemBase[]) {
  return api<{ criadas: number; jaExistiam: number; atualizadas: number; falharam: { nome: string; erro: string }[] }>(
    '/api/admin/internal/origens-migration/rules/preset-create',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens }) }
  );
}

export interface CityUfEntry {
  id: number;
  loja: string;
  cidade_normalizada: string;
  cidade_display: string;
  uf: string;
  criado_em: string;
  atualizado_em: string;
}

export function listCityUfMap() {
  return api<{ cidades: CityUfEntry[] }>(`/api/admin/internal/origens-migration/city-uf-map`);
}

export function createCityUfEntry(cidade: string, uf: string) {
  return api<{ cidade: CityUfEntry }>('/api/admin/internal/origens-migration/city-uf-map', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cidade, uf }),
  });
}

export function updateCityUfEntry(id: number, uf: string) {
  return api<{ cidade: CityUfEntry }>(`/api/admin/internal/origens-migration/city-uf-map/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uf }),
  });
}

export function deleteCityUfEntry(id: number) {
  return api(`/api/admin/internal/origens-migration/city-uf-map/${id}`, { method: 'DELETE' });
}

export interface CityUfBulkPreviewItem {
  linha: string;
  cidade: string;
  uf: string | null;
  status: 'pronta' | 'ja_existe' | 'duplicada_na_lista' | 'uf_invalida';
}

export function bulkPreviewCityUfMap(texto: string) {
  return api<{ itens: CityUfBulkPreviewItem[]; resumo: { total: number; pronta: number; jaExiste: number; duplicada: number; invalida: number } }>(
    '/api/admin/internal/origens-migration/city-uf-map/bulk-preview',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ texto }) }
  );
}

export function bulkCreateCityUfMap(itens: { cidade: string; uf: string }[]) {
  return api<{ criadas: number; falharam: { cidade: string; erro: string }[] }>(
    '/api/admin/internal/origens-migration/city-uf-map/bulk-create',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens }) }
  );
}

export function importarDicionarioMunicipios() {
  return api<{ importados: number; jaExistiam: number; total: number }>(
    '/api/admin/internal/origens-migration/city-uf-map/importar-dicionario',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }
  );
}

export interface DiscoveredCity {
  cidadeDisplay: string;
  cidadeNormalizada: string;
  quantidadeProdutos: number;
}

export function discoverCities() {
  return api<{ cidades: DiscoveredCity[] }>('/api/admin/internal/origens-migration/city-uf-map/discover', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
}

export interface CategoriaAntiga {
  id: number;
  nome: string;
  totalProdutos: number;
  produtosSemDestino: number;
  exemplos: string[];
  bloqueada: boolean;
  motivo: string | null;
}

export interface CategoriasAntigasResultado {
  simulacaoUsada: { id: number; criado_em: string; status: string } | null;
  simulacaoNecessaria: boolean;
  categorias: CategoriaAntiga[];
}

export function listarCategoriasAntigas(simulationId?: number) {
  const query = new URLSearchParams();
  if (simulationId) query.set('simulationId', String(simulationId));
  return api<CategoriasAntigasResultado>(`/api/admin/internal/origens-migration/categorias-antigas?${query.toString()}`);
}

export interface ExcluirCategoriasAntigasResultado {
  resultados: { id: number; status: 'excluida' | 'bloqueada' | 'falhou'; motivo?: string; error?: string }[];
  resumo: { excluidas: number; bloqueadas: number; falharam: number };
}

export function excluirCategoriasAntigas(ids: number[], simulationId?: number) {
  return api<ExcluirCategoriasAntigasResultado>('/api/admin/internal/origens-migration/categorias-antigas/excluir', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, simulationId }),
  });
}
