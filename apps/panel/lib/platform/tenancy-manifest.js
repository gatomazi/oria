'use strict';

// Manifesto CANÔNICO das tabelas tenant-owned (Fase 1 · TD-001).
//
// É a única lista. Os gates (INV-04/05/06/07), a verificação de role, o teste de isolamento e o
// documento `docs/productization/tenant-owned-tables.md` (gerado por
// `scripts/tenancy/gerar-manifesto.mjs`) saem daqui. Um teste reprova se existir tabela no schema
// que não esteja aqui nem em `TABELAS_GLOBAIS` — tabela nova sem classificação não passa.
//
// ── Regras de ownership (como a linha legada ganha organization_id) ───────────────────────────
// Todas são MAPEAMENTO EXPLÍCITO, lido de `tenancy_mapeamentos`. Nenhuma é "o único candidato".
//
//   loja             coluna `loja` NOT NULL        → mapeamento ('loja', loja)
//   loja_ou_sem_loja coluna `loja` nullable        → ('loja', loja); se NULL → ('sem_loja', <tabela>)
//   pai              herda da linha-pai (FK)       → organization_id do pai
//   integracao       organization_id já existente, ou `escopo` (= loja) → ('loja', escopo)
//   instalacao       estado hoje por instalação    → ('instalacao', '*')
//   meta             dados da conexão Meta         → ('meta', '*')
//   google_ads       dados da conexão Google Ads   → ('google_ads', '*')
//   creative         `tenant_id` do Creative Core  → ('creative_tenant', tenant_id)
//
// ── Chaves (INV-05, binário) ─────────────────────────────────────────────────────────────────────
// Toda UNIQUE e toda PK de tabela tenant-owned inclui organization_id — inclusive a PK surrogate
// (`id`), que vira (organization_id, id); as FKs entre tabelas tenant-owned viram compostas. Sem
// exceção: uma chave global numa tabela tenant-owned impede "Org A: X / Org B: X" mesmo com RLS.
//
// `uniquesLegadas` é o mecanismo para declarar uma UNIQUE global TRANSITÓRIA durante um
// expand/contract. O gate reprova se a lista não estiver vazia: fechar uma fase exige zero.

// O enum de lojas do código atual (`LOJAS` em server.js). Um teste confere que os dois batem.
const LOJAS_LEGADAS = Object.freeze(['sul', 'centro', 'norte']);

const REGRAS = Object.freeze([
  'loja', 'loja_ou_sem_loja', 'pai', 'integracao', 'instalacao', 'meta', 'google_ads', 'creative',
]);

const t = (tabela, regra, extra = {}) => Object.freeze({
  tabela,
  regra,
  pai: null,
  // PK final: (organization_id, ...colunas). `promover` = UNIQUE nova que vira a PK.
  pk: { colunas: ['id'], promover: null },
  uniques: [],
  // Transitórias (ver acima). Precisa estar vazia para o INV-05 passar.
  uniquesLegadas: [],
  // Índices NÃO únicos que acompanham a troca (ex.: busca por id depois da PK composta).
  indices: [],
  // FKs para tabelas tenant-owned: viram compostas (organization_id, coluna) → pai (organization_id, id).
  fks: [],
  singleton: null,
  legado: false,
  nota: '',
  ...extra,
});

const TABELAS_TENANT = Object.freeze([
  // ── loja NOT NULL ─────────────────────────────────────────────────────────────────────────
  t('bulk_category_jobs', 'loja', {
    nota: 'A 0026 acrescentou `store_id` (FK composta com organization_id → stores) e liberou `loja`, que '
      + 'virou compatibilidade histórica (nula na Store nativa). CHECK NOT VALID: toda linha nova identifica a Store.',
  }),
  t('campaigns', 'loja', {
    fks: [{ coluna: 'segmento_id', pai: 'segments', onDelete: 'SET NULL' }],
  }),
  t('controle_estoque_observacoes', 'loja'),
  t('despesas_operacionais', 'loja', {
    nota: 'A 0025 acrescentou `store_id` (FK composta com organization_id → stores) e liberou `loja`, '
      + 'que virou compatibilidade histórica (nula na Store nativa). CHECK NOT VALID: toda linha nova '
      + 'identifica a Store por `store_id` OU `loja`.',
  }),
  t('estoque_observacoes', 'loja'),
  t('ga4_performance_cache', 'loja', {
    nota: 'A 0027 acrescentou `store_id` (FK composta com organization_id → stores) e liberou `loja`. A unicidade '
      + 'canônica é `uq_ga4_performance_cache_store`, parcial em store_id; o índice legado por `loja` continua.',
    uniques: [{ nome: 'uq_ga4_performance_cache_org', colunas: ['organization_id', 'loja', 'periodo'] }],
  }),
  t('google_analytics_connections', 'loja', {
    nota: 'A 0027 acrescentou `store_id` (FK composta com organization_id → stores) e liberou `loja`. Uma conexão por '
      + 'Store: `uq_google_analytics_connections_store`, parcial em store_id; o índice legado por `loja` continua.',
    uniques: [{ nome: 'uq_google_analytics_connections_org', colunas: ['organization_id', 'loja'] }],
  }),
  t('pedidos_backfill_jobs', 'loja', {
    nota: 'A 0026 acrescentou `store_id` (FK composta com organization_id → stores) e liberou `loja`, que '
      + 'virou compatibilidade histórica (nula na Store nativa). CHECK NOT VALID: toda linha nova identifica a Store.',
  }),
  t('pedidos_ink', 'loja', {
    uniques: [{ nome: 'uq_pedidos_ink_org', colunas: ['organization_id', 'loja', 'ink_order_id'] }],
    nota: 'A 0021 acrescentou `store_id` (FK composta com organization_id → stores) e a unicidade '
      + 'canônica `uq_pedidos_ink_store`, parcial em store_id. `loja` deixou de ser obrigatória e o '
      + 'índice legado continua para as releases já publicadas. Linha nova identifica a Store.',
  }),
  t('pedidos_ink_itens', 'loja', {
    pk: { colunas: ['loja', 'item_id'], promover: 'uq_pedidos_ink_itens_org' },
    uniques: [{ nome: 'uq_pedidos_ink_itens_org', colunas: ['organization_id', 'loja', 'item_id'] }],
    nota: 'A 0021 trocou a PK por substituta (organization_id, id) — coluna de PK não pode ser nula '
      + 'e `loja` passou a ser opcional. A unicidade de negócio canônica é `uq_pedidos_ink_itens_store`.',
  }),
  t('produtos_feed', 'loja', {
    pk: { colunas: ['loja', 'produto_id'], promover: 'uq_produtos_feed_org' },
    uniques: [{ nome: 'uq_produtos_feed_org', colunas: ['organization_id', 'loja', 'produto_id'] }],
  }),
  t('produtos_feed_sync', 'loja', {
    pk: { colunas: ['loja'], promover: 'uq_produtos_feed_sync_org' },
    uniques: [{ nome: 'uq_produtos_feed_sync_org', colunas: ['organization_id', 'loja'] }],
  }),
  t('produtos_ink', 'loja', {
    nota: 'A 0026 acrescentou `store_id` (FK composta com organization_id → stores), trocou a PK por substituta '
      + '(organization_id, id) e liberou `loja` (compatibilidade histórica, nula na Store nativa). A unicidade '
      + 'canônica é `uq_produtos_ink_store`, parcial em store_id; o índice legado por `loja` continua com o mesmo nome.',
    pk: { colunas: ['loja', 'produto_id'], promover: 'uq_produtos_ink_org' },
    uniques: [{ nome: 'uq_produtos_ink_org', colunas: ['organization_id', 'loja', 'produto_id'] }],
  }),
  t('produtos_ink_sync', 'loja', {
    nota: 'A 0026 acrescentou `store_id` (FK composta com organization_id → stores), trocou a PK por substituta '
      + '(organization_id, id) e liberou `loja` (compatibilidade histórica, nula na Store nativa). A unicidade '
      + 'canônica é `uq_produtos_ink_sync_store`, parcial em store_id; o índice legado por `loja` continua com o mesmo nome.',
    pk: { colunas: ['loja'], promover: 'uq_produtos_ink_sync_org' },
    uniques: [{ nome: 'uq_produtos_ink_sync_org', colunas: ['organization_id', 'loja'] }],
  }),
  t('sync_estado', 'loja', {
    pk: { colunas: ['loja'], promover: 'uq_sync_estado_org' },
    uniques: [{ nome: 'uq_sync_estado_org', colunas: ['organization_id', 'loja'] }],
    nota: 'A 0021 trocou a PK por substituta (organization_id, id) e acrescentou `store_id`; a marca '
      + 'de sincronização de Store nativa é identificada por `uq_sync_estado_store`.',
  }),
  t('utm_campaigns', 'loja', {
    nota: 'A 0025 acrescentou `store_id` (FK composta com organization_id → stores) e liberou `loja`, '
      + 'que virou compatibilidade histórica (nula na Store nativa). CHECK NOT VALID: toda linha nova '
      + 'identifica a Store por `store_id` OU `loja`.',
  }),
  t('origens_migration_city_uf_map', 'loja', {
    legado: true,
    uniques: [{ nome: 'uq_origens_city_uf_map_org', colunas: ['organization_id', 'loja', 'cidade_normalizada'] }],
    nota: 'R-01 LEGACY / TO_REMOVE — sem DROP; tenantizada para a RLS proteger o dado enquanto existir',
  }),
  t('origens_migration_rules', 'loja', { legado: true, nota: 'R-01 LEGACY / TO_REMOVE — sem DROP' }),
  t('origens_migration_simulations', 'loja', {
    fks: [{ coluna: 'job_id', pai: 'bulk_category_jobs', onDelete: 'SET NULL' }],
    legado: true,
    nota: 'R-01 LEGACY / TO_REMOVE — sem DROP',
  }),

  // ── loja nullable ─────────────────────────────────────────────────────────────────────────
  t('audit_log', 'loja_ou_sem_loja', { nota: 'loja NULL = ação sem loja; dono declarado por sem_loja' }),
  t('media_assets', 'loja_ou_sem_loja', {
    uniques: [{
      nome: 'uq_media_assets_public_token_org',
      colunas: ['organization_id', 'public_token'],
      where: 'public_token IS NOT NULL',
    }],
    indices: [{ nome: 'idx_media_assets_public_token_busca', colunas: ['public_token'] }],
    nota: 'o link público resolve por token: índice não-único para a busca; unicidade por Organization (token de 192 bits)',
  }),
  t('webhook_eventos', 'loja_ou_sem_loja', {
    nota: 'loja NULL = entrega que não se identificou; dono declarado por sem_loja, nunca inferido. '
      + 'A 0021 acrescentou `store_id` (FK composta com organization_id → stores) e o índice de leitura '
      + 'por Store. NÃO há CHECK exigindo identidade de Store aqui, ao contrário de pedidos_ink: esta '
      + 'tabela registra a entrega que não se identificou, e exigir Store transformaria "não atribuí" '
      + 'em "não registro".',
  }),
  t('whatsapp_web_outbox', 'loja_ou_sem_loja', {
    fks: [{ coluna: 'campaign_recipient_id', pai: 'campaign_recipients', onDelete: 'CASCADE' }],
    uniques: [{
      nome: 'uq_wa_web_outbox_dedupe_org',
      expressao: '(organization_id, dedupe_key)',
      where: "status IN ('aguardando_aprovacao', 'pending', 'claimed', 'sent', 'desconhecido')",
    }],
  }),

  // ── herda do pai ──────────────────────────────────────────────────────────────────────────
  t('bulk_category_job_items', 'pai', {
    pai: { tabela: 'bulk_category_jobs', coluna: 'job_id' },
    fks: [{ coluna: 'job_id', pai: 'bulk_category_jobs', onDelete: 'CASCADE' }],
  }),
  t('campaign_recipients', 'pai', {
    fks: [
      { coluna: 'campaign_id', pai: 'campaigns', onDelete: 'CASCADE' },
      { coluna: 'media_asset_id', pai: 'media_assets', onDelete: 'SET NULL' },
    ],
    pai: { tabela: 'campaigns', coluna: 'campaign_id' },
    uniques: [{ nome: 'uq_campaign_recipients_org', colunas: ['organization_id', 'campaign_id', 'customer_key'] }],
  }),
  t('origens_migration_simulation_items', 'pai', {
    fks: [{ coluna: 'simulation_id', pai: 'origens_migration_simulations', onDelete: 'CASCADE' }],
    pai: { tabela: 'origens_migration_simulations', coluna: 'simulation_id' },
    legado: true,
    nota: 'R-01 LEGACY / TO_REMOVE — sem DROP',
  }),
  t('integration_secrets', 'pai', {
    fks: [{ coluna: 'integration_id', pai: 'integrations', onDelete: 'CASCADE' }],
    pai: { tabela: 'integrations', coluna: 'integration_id' },
    uniques: [{ nome: 'uq_integration_secrets_org', colunas: ['organization_id', 'integration_id', 'tipo'] }],
    nota: 'organization_id já existia (nullable, sem FK) desde a Fase 0',
  }),
  t('integrations', 'integracao', {
    nota: 'organization_id já existia (nullable, sem FK); a UNIQUE da Fase 0 já o incluía',
  }),

  // ── estado por instalação ─────────────────────────────────────────────────────────────────
  t('app_config', 'instalacao', {
    pk: { colunas: ['chave'], promover: 'uq_app_config_org' },
    uniques: [{ nome: 'uq_app_config_org', colunas: ['organization_id', 'chave'] }],
  }),
  t('custos_api_precos', 'instalacao', {
    pk: { colunas: ['chave'], promover: 'uq_custos_api_precos_org' },
    uniques: [{ nome: 'uq_custos_api_precos_org', colunas: ['organization_id', 'chave'] }],
  }),
  t('segments', 'instalacao'),
  t('utm_presets', 'instalacao'),
  t('whatsapp_web_mensagens', 'instalacao', {
    uniques: [{ nome: 'uq_wa_web_mensagens_nome_org', expressao: '(organization_id, lower(nome))' }],
  }),

  // ── Meta Ads (a conexão pertence a UMA Organization — PD-016) ─────────────────────────────
  t('meta_connections', 'meta', {
    singleton: { constraint: 'meta_connections_id_check', sequencia: 'meta_connections_id_seq' },
    uniques: [{ nome: 'uq_meta_connections_org', colunas: ['organization_id'] }],
  }),
  t('meta_ad_accounts', 'meta', {
    nota: 'A 0025 acrescentou `store_id` (FK composta com organization_id → stores): a Store a que a conta '
      + 'atribui o tráfego. `loja_atribuida` é só compatibilidade histórica (texto; nula na Store nativa). '
      + '`store_id` nulo é estado legítimo (conta ainda sem loja): o gasto fica fora do resultado, sinalizado.',
    uniques: [
      { nome: 'uq_meta_ad_accounts_org', colunas: ['organization_id', 'meta_account_id'] },
      { nome: 'uq_meta_ad_accounts_selecionada_org', colunas: ['organization_id'], where: 'selecionada' },
    ],
  }),
  t('meta_campaigns', 'meta', {
    uniques: [{ nome: 'uq_meta_campaigns_org', colunas: ['organization_id', 'meta_campaign_id'] }],
  }),
  t('meta_adsets', 'meta', {
    uniques: [{ nome: 'uq_meta_adsets_org', colunas: ['organization_id', 'meta_adset_id'] }],
  }),
  t('meta_ads', 'meta', {
    uniques: [{ nome: 'uq_meta_ads_org', colunas: ['organization_id', 'meta_ad_id'] }],
  }),
  t('meta_creatives', 'meta', {
    uniques: [{ nome: 'uq_meta_creatives_org', colunas: ['organization_id', 'meta_creative_id'] }],
  }),
  t('meta_insights_daily', 'meta', {
    uniques: [{
      nome: 'uq_meta_insights_daily_org',
      colunas: ['organization_id', 'meta_account_id', 'level', 'entidade_id', 'data', 'attribution_setting'],
    }],
  }),
  t('meta_sync_logs', 'meta'),

  // ── Google Ads ────────────────────────────────────────────────────────────────────────────
  t('google_ads_connections', 'google_ads', {
    singleton: { constraint: 'google_ads_connections_id_check', sequencia: 'google_ads_connections_id_seq' },
    uniques: [{ nome: 'uq_google_ads_connections_org', colunas: ['organization_id'] }],
  }),
  t('google_ads_customers', 'google_ads', {
    nota: 'A 0025 acrescentou `store_id` (FK composta com organization_id → stores): a Store a que a conta '
      + 'atribui o tráfego. `loja_atribuida` é só compatibilidade histórica (texto; nula na Store nativa). '
      + '`store_id` nulo é estado legítimo (conta ainda sem loja): o gasto fica fora do resultado, sinalizado.',
    uniques: [
      { nome: 'uq_google_ads_customers_org', colunas: ['organization_id', 'customer_id'] },
      { nome: 'uq_google_ads_customers_selecionada_org', colunas: ['organization_id'], where: 'selecionada' },
    ],
  }),
  t('google_ads_campaigns', 'google_ads', {
    uniques: [{ nome: 'uq_google_ads_campaigns_org', colunas: ['organization_id', 'customer_id', 'campaign_id'] }],
  }),
  t('google_ads_insights_daily', 'google_ads', {
    uniques: [{
      nome: 'uq_google_ads_insights_daily_org',
      colunas: ['organization_id', 'customer_id', 'level', 'entidade_id', 'data', 'contagem_conversao'],
    }],
  }),
  t('google_ads_sync_logs', 'google_ads'),

  // ── Creative Core (tenant_id legado → organization_id canônico; tenant_id fica, por ora) ──
  t('creative_settings', 'creative', {
    pk: { colunas: [], promover: 'uq_creative_settings_org' },
    uniques: [{ nome: 'uq_creative_settings_org', colunas: ['organization_id'] }],
    nota: 'um registro por tenant; PK tenant_id vira legado',
  }),
  t('creative_brand_profiles', 'creative'),
  t('creative_niche_profiles', 'creative'),
  t('creative_context_profiles', 'creative'),
  t('creative_personas', 'creative'),
  t('creative_products', 'creative'),
  t('creative_jobs', 'creative'),
  t('creative_generations', 'creative', { pk: { colunas: ['creative_id'], promover: null } }),
  t('creative_assets', 'creative'),
]);

// Tabelas da plataforma (Fase 1; onboarding na Fase 7). Têm organization_id (ou são a própria
// Organization) e também ficam sob RLS forçada, com policy própria para `organizations`. Não têm
// regra de ownership legada: nascem com organization_id explícito.
const TABELAS_PLATAFORMA = Object.freeze([
  Object.freeze({ tabela: 'organizations', colunaTenant: 'id' }),
  Object.freeze({ tabela: 'stores', colunaTenant: 'organization_id' }),
  Object.freeze({ tabela: 'organization_members', colunaTenant: 'organization_id' }),
  // Fase 7 · estado de onboarding (lib/platform/onboarding.js). Filho depois do pai.
  Object.freeze({ tabela: 'onboarding_sessions', colunaTenant: 'organization_id' }),
  Object.freeze({ tabela: 'onboarding_steps', colunaTenant: 'organization_id' }),
  // Fase D · catálogo canônico de Commerce (lib/connectors/*, lib/product-analytics/catalog-sync.js).
  // Nasce com organization_id/store_id explícitos — nunca teve `loja`. Ordem importa: variants e o
  // log de sync são filhos de commerce_products só pela FK composta, não pela regra 'pai' (essa é
  // exclusiva de TABELAS_TENANT — ver tenancy-schema.test.js).
  Object.freeze({ tabela: 'commerce_products', colunaTenant: 'organization_id' }),
  Object.freeze({ tabela: 'commerce_product_variants', colunaTenant: 'organization_id' }),
  Object.freeze({ tabela: 'commerce_catalog_sync_logs', colunaTenant: 'organization_id' }),
]);

// Globais DECLARADAS. Não recebem RLS. A role da aplicação acessa só as de identidade
// (`TABELAS_GLOBAIS_DA_APLICACAO`); o resto é da migration.
const TABELAS_GLOBAIS = Object.freeze([
  Object.freeze({ tabela: 'pgmigrations', motivo: 'controle do node-pg-migrate' }),
  Object.freeze({
    tabela: 'users',
    motivo: 'identidade da pessoa (PD-004): existe antes de qualquer Organization e pode pertencer a várias',
  }),
  Object.freeze({
    tabela: 'sessions',
    motivo: 'sessão é do usuário; a Organization ativa é resolvida por request (Fase 3)',
  }),
  Object.freeze({
    tabela: 'tenancy_mapeamentos',
    motivo: 'mapeamento legado → Organization; lido só pelo trigger SECURITY DEFINER e pelo backfill',
  }),
  Object.freeze({
    tabela: 'oauth_states',
    motivo: 'state de OAuth da pessoa/sessão (Fase 4); a Organization é dado validado no callback contra o membership',
  }),
  Object.freeze({
    tabela: 'external_resource_claims',
    motivo: 'posse de recurso externo entre Organizations (PD-016); só funções SECURITY DEFINER com a Organization do contexto',
  }),
  Object.freeze({
    tabela: 'job_leases',
    motivo: 'lease dos jobs entre réplicas (TD-006); só funções SECURITY DEFINER, pedidas pelo scheduler antes do contexto',
  }),
  Object.freeze({
    tabela: 'onboarding_invites',
    motivo: 'convite do primeiro owner (Fase 7): existe antes da Organization; só o hash do token, lido e consumido por funções SECURITY DEFINER',
  }),
  Object.freeze({
    tabela: 'onboarding_idempotencia',
    motivo: 'chave de idempotência (pessoa, chave) → Organization criada (Fase 7); só função SECURITY DEFINER, com a Organization do contexto',
  }),

  // ── Control Plane (Oria Admin · apps/platform-admin) ───────────────────────────────────────
  // Nenhuma delas é tenant-owned: elas FALAM SOBRE Organizations (FK de referência), não pertencem
  // a uma. Ficam fora da RLS e fora do alcance da role da aplicação do painel — quem as usa é
  // outro deployable, com a sua própria conexão. Contrato: docs/architecture/control-plane.md.
  Object.freeze({
    tabela: 'platform_admins',
    motivo: 'identidade do operador da plataforma (control plane); é o par de `users`, e não pertence a nenhuma Organization',
  }),
  Object.freeze({
    tabela: 'platform_admin_sessions',
    motivo: 'sessão do platform admin (só o SHA-256 do token); cookie e segredo separados dos do painel',
  }),
  Object.freeze({
    tabela: 'plans',
    motivo: 'vocabulário técnico de acesso do control plane; existe antes de qualquer assinatura e é compartilhado por todas as Organizations',
  }),
  Object.freeze({
    tabela: 'plan_features',
    motivo: 'features de um plano; filha de `plans`, mesma natureza global',
  }),
  Object.freeze({
    tabela: 'organization_subscriptions',
    motivo: 'quem assina o quê é decisão de PLATAFORMA: o tenant não pode ler nem alterar a própria assinatura',
  }),
  Object.freeze({
    tabela: 'organization_entitlement_overrides',
    motivo: 'override concedido pela plataforma; se fosse tenant-owned, o tenant poderia conceder features a si mesmo',
  }),
  Object.freeze({
    tabela: 'organization_owner_invites',
    motivo: 'convite do owner emitido pelo control plane: só o hash do token, consumido por função SECURITY DEFINER',
  }),
  Object.freeze({
    tabela: 'platform_organization_creations',
    motivo: 'idempotência da criação de Organization pelo control plane: (platform admin, chave) → Organization; nasce antes da própria Organization (FK adiada)',
  }),
  Object.freeze({
    tabela: 'platform_audit_logs',
    motivo: 'rastro das ações do control plane; atravessa Organizations por desenho e não pode ser lido nem apagado pelo tenant',
  }),
]);

const TABELAS_GLOBAIS_DA_APLICACAO = Object.freeze(['users', 'sessions', 'oauth_states']);

// Globais que a role da aplicação NÃO pode ler nem escrever diretamente.
const TABELAS_GLOBAIS_PRIVADAS = Object.freeze([
  'tenancy_mapeamentos', 'external_resource_claims', 'job_leases', 'onboarding_invites', 'onboarding_idempotencia',
  'platform_admins', 'platform_admin_sessions', 'plans', 'plan_features',
  'organization_subscriptions', 'organization_entitlement_overrides', 'organization_owner_invites',
  'platform_organization_creations', 'platform_audit_logs',
]);

function nomesTenant() {
  return TABELAS_TENANT.map((x) => x.tabela);
}

// Tudo que fica sob RLS forçada: tenant-owned + plataforma.
function nomesSobRls() {
  return [...nomesTenant(), ...TABELAS_PLATAFORMA.map((x) => x.tabela)];
}

function porTabela(nome) {
  return TABELAS_TENANT.find((x) => x.tabela === nome) || null;
}

module.exports = {
  LOJAS_LEGADAS,
  REGRAS,
  TABELAS_TENANT,
  TABELAS_PLATAFORMA,
  TABELAS_GLOBAIS,
  TABELAS_GLOBAIS_DA_APLICACAO,
  TABELAS_GLOBAIS_PRIVADAS,
  nomesTenant,
  nomesSobRls,
  porTabela,
};
