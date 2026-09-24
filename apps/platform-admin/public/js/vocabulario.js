// Vocabulários fechados do control plane, como a UI precisa exibi-los.
//
// São CÓPIAS DECLARADAS do backend (lib/entitlements.js, lib/organizations.js, lib/audit.js). A UI
// usa esta cópia só para ROTULAR e para montar filtros; a autoridade continua sendo a resposta da
// API. Quando o backend devolve um valor que não está aqui, a UI mostra o valor cru — nunca
// esconde e nunca inventa um rótulo.

// Módulo capability (modos do Gerador) NÃO aparece como checkbox de plano — é outro eixo, e a
// tela de planos não é o lugar dele. Catálogo, Trocas e Reembolsos aparecem: já foram
// classificados como capacidade do Connector Ink, mas o painel ainda os confere como entitlement,
// então tirá-los do formulário esconderia do operador uma chave que decide acesso de verdade.
export const FEATURES = Object.freeze([
  'whatsapp',
  'instagram',
  'advancedAutomations',
  'financial',
  'creative_generator',
  'meta_ads',
  'google_ads',
  'analytics_ga4',
  'analytics_product_performance',
  'catalog',
  'exchanges',
  'refunds',
]);

export const ROTULO_FEATURE = Object.freeze({
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  advancedAutomations: 'Automações avançadas',
  financial: 'Financeiro',
  creative_generator: 'Gerador de Criativos',
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  analytics_ga4: 'Analytics (GA4)',
  analytics_product_performance: 'Desempenho de Produtos',
  catalog: 'Catálogo',
  exchanges: 'Trocas',
  refunds: 'Reembolsos',
});

// Agrupamento comercial da tela de plano (comando §11 · complemento §7). É só apresentação: a
// autoridade continua sendo FEATURES. Toda feature precisa estar em exatamente um grupo — a tela
// monta a lista a partir dos grupos, então feature fora de grupo sumiria do formulário.
export const GRUPOS_DE_FEATURES = Object.freeze([
  Object.freeze({ titulo: 'Comunicação', features: Object.freeze(['whatsapp', 'instagram', 'advancedAutomations']) }),
  Object.freeze({ titulo: 'Financeiro', features: Object.freeze(['financial']) }),
  Object.freeze({ titulo: 'Criativos', features: Object.freeze(['creative_generator']) }),
  Object.freeze({ titulo: 'Mídia e analytics', features: Object.freeze(['meta_ads', 'google_ads', 'analytics_ga4', 'analytics_product_performance']) }),
  // Em transição para capacidade do Connector Ink: continuam no formulário enquanto o painel as
  // conferir como entitlement. Ver docs/architecture/features-vs-connectors.md § Plano de retirada.
  Object.freeze({ titulo: 'Loja (Connector Ink)', features: Object.freeze(['catalog', 'exchanges', 'refunds']) }),
]);

// Read-only, para o detalhe do plano (complemento §24): o que uma feature inclui hoje por dentro.
// Não é editável e não é entitlement — é o registry de module capabilities do painel, rotulado.
export const INCLUI_ATUALMENTE = Object.freeze({
  creative_generator: Object.freeze(['Ângulos limpos', 'Remarketing', 'Funil visual', 'Multiproduto']),
});

// Como a feature ficou como ficou (contrato §10.6 — `entitlements.origem`).
export const ROTULO_ORIGEM = Object.freeze({
  override: 'Override da organização',
  plano: 'Plano',
  ausente: 'Ausente (negado)',
  organization_suspensa: 'Organização suspensa',
  sem_assinatura: 'Sem assinatura ativa',
});

export const PASSOS_ONBOARDING = Object.freeze([
  'org_store', 'owner', 'ink', 'meta', 'google', 'ga4', 'openai_byok', 'whatsapp', 'entitlements', 'readiness',
]);

// Estruturais: o backend exige `required` nestes três (lib/organizations.js · PASSOS_ESTRUTURAIS).
export const PASSOS_ESTRUTURAIS = Object.freeze(['org_store', 'owner', 'readiness']);

export const ROTULO_PASSO = Object.freeze({
  org_store: 'Organização e loja',
  owner: 'Owner',
  ink: 'Ink',
  meta: 'Meta',
  google: 'Google Ads',
  ga4: 'GA4',
  openai_byok: 'OpenAI (BYOK)',
  whatsapp: 'WhatsApp',
  entitlements: 'Entitlements',
  readiness: 'Prontidão',
});

export const REQUISITOS = Object.freeze(['required', 'optional', 'disabled']);

export const ROTULO_REQUISITO = Object.freeze({
  required: 'Obrigatório',
  optional: 'Opcional',
  disabled: 'Desligado',
});

export const ACOES_AUDITORIA = Object.freeze([
  'admin.login', 'admin.logout', 'admin.login_failed',
  'admin.created', 'admin.deactivated', 'admin.reactivated', 'admin.role_changed',
  'plan.created', 'plan.updated', 'plan.archived', 'plan.features_replaced',
  'organization.created', 'organization.suspended', 'organization.reactivated',
  'subscription.created', 'subscription.changed',
  'entitlement.override_set', 'entitlement.override_removed',
  'invite.issued', 'invite.reissued', 'invite.revoked',
  'member.removed',
  'integration.tested',
]);

export const PAPEIS_ADMIN = Object.freeze(['platform_owner', 'platform_operator']);

export const ROTULO_PAPEL_ADMIN = Object.freeze({
  platform_owner: 'Platform owner',
  platform_operator: 'Platform operator',
});

// Mensagens por CÓDIGO de erro. O contrato promete códigos estáveis (§5.2); o texto do servidor é
// curto e seguro, mas quem explica o que fazer é a UI. Sem entrada aqui, cai na mensagem da API.
export const MENSAGEM_DE_ERRO = Object.freeze({
  credenciais_invalidas: 'E-mail ou senha incorretos.',
  rate_limited: 'Tentativas demais. Espere antes de tentar de novo.',
  bootstrap_pendente: 'Nenhum platform admin cadastrado ainda. Rode `npm run platform-admin:bootstrap` no serviço antes de entrar.',
  origem_nao_permitida: 'Esta origem não pode alterar o control plane.',
  autenticacao_indisponivel: 'Autenticação indisponível no momento (dependência fora).',
  nao_autenticado: 'Sessão encerrada. Entre de novo.',
  csrf: 'Sessão inconsistente. Recarregue a página e tente de novo.',
  papel_insuficiente: 'Seu papel não permite esta ação.',
  nao_encontrado: 'Não encontrado.',
  second_tenant_disabled: 'A criação de organizações externas está desligada (SECOND_TENANT_ENABLED).',
  bootstrap_interno_indisponivel: 'O bootstrap interno só existe enquanto não há nenhuma organização — e já existe uma. Se você acabou de enviar este formulário, confira a lista antes de tentar de novo: a organização pode ter sido criada.',
  plano_desconhecido: 'Plano inexistente.',
  plano_arquivado: 'Plano arquivado não aceita novas assinaturas.',
  onboarding_config_required: 'Defina os requisitos de onboarding: não existe configuração padrão.',
  onboarding_config_invalida: 'Configuração de passos inválida.',
  idempotency_key_reutilizada: 'Esta chave de idempotência já foi usada com outros dados. Confira a lista de organizations e gere uma chave nova.',
  idempotency_key_invalida: 'Chave de idempotência inválida: de 16 a 200 caracteres, apenas letras, dígitos e _ . : -',
  email_invalido: 'E-mail inválido.',
  nome_invalido: 'Nome inválido.',
  organization_no_corpo: 'A organização alvo vem da rota, nunca do corpo.',
  campo_desconhecido: 'Campo não reconhecido no corpo da requisição.',
  cursor_invalido: 'Paginação inválida. Recarregue a listagem.',
  feature_desconhecida: 'Feature fora do vocabulário.',
  chave_em_uso: 'Já existe um plano com essa chave.',
  plano_com_assinatura_ativa: 'Este plano tem assinatura ativa e não pode ser arquivado.',
  email_em_uso: 'Já existe um platform admin com esse e-mail.',
  ultimo_platform_owner: 'Precisa sobrar ao menos um platform owner ativo.',
  senha_fraca: 'Senha curta demais.',
  convite_pendente_existe: 'Já existe um convite pendente para esse e-mail.',
  convite_ja_usado: 'Este convite já foi usado.',
  convite_ja_revogado: 'Este convite já foi revogado.',
  ultimo_owner: 'A organização ficaria sem nenhum caminho para um owner.',
  override_inexistente: 'Não existe override para essa feature.',
  action_desconhecida: 'Ação fora do vocabulário de auditoria.',
  q_invalido: 'A busca precisa de ao menos 2 caracteres.',
  corpo_grande: 'Conteúdo grande demais.',
  rede_indisponivel: 'Não foi possível falar com o Oria Admin.',
  erro_interno: 'Falha ao processar a requisição.',
});
