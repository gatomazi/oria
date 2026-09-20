'use strict';

// ══════════════════════════════════════════════════════════════════════════════════════════════
// NEGATIVE CONTROLS — o critério de validade do harness (Fase 0, critério de saída 5)
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Ciclo obrigatório, para ao menos um invariant de CADA classe crítica:
//
//   1. o invariant roda e PASSA no estado correto
//   2. introduz-se uma violação deliberada
//   3. o MESMO invariant FALHA
//   4. remove-se a violação
//   5. ele volta a PASSAR
//
// Um harness que nunca reprovou nada não provou nada. É a mitigação declarada do maior risco do
// plano: um harness escrito sob pressão tende a ser escrito PARA PASSAR, e o sintoma disso é
// silêncio — indistinguível de sucesso.
//
// ── Como funciona ──────────────────────────────────────────────────────────────────────────────
// A violação NÃO é uma flag no código de produção ("se HARNESS_QUEBRA=1, comporte-se mal"). Isso
// provaria a flag, não o invariant. Aqui o `lib/` real é copiado para um diretório temporário, o
// defeito HISTÓRICO é escrito por cima do arquivo copiado, e o MESMO arquivo de teste é executado
// contra a cópia via `INVARIANT_SUBJECT_ROOT`. Nada no repositório é modificado em nenhum momento.
//
// Cada violação abaixo é o código que existe (ou existia) em produção, citado por arquivo:linha.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { RAIZ_REPO } = require('./harness');

// ── As violações ───────────────────────────────────────────────────────────────────────────────

const VIOLACOES = [
  {
    classe: 'tenancy/ownership',
    invariant: 'INV-09',
    teste: 'inv-09-tenancy.test.js',
    arquivo: 'lib/platform/ownership.js',
    descricao: 'lojaAtribuidaPadrao(): "se só existe um candidato, use-o" (server.js:11873-11876)',
    de: '  void candidatas;\n\n  if (vazio(organizationIdDoRecurso)) {',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — reintrodução de lojaAtribuidaPadrao()\n'
        + '  if (vazio(organizationIdDoRecurso) && candidatas.length === 1) return String(candidatas[0]);\n\n'
        + '  if (vazio(organizationIdDoRecurso)) {',
  },
  {
    classe: 'auth',
    invariant: 'INV-02',
    teste: 'inv-02-auth.test.js',
    arquivo: 'lib/platform/tenant-context.js',
    descricao: 'tenant lido de um header controlado pelo cliente',
    de: '  void req;\n\n  if (!sessao || typeof sessao !== \'object\') {',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "só para facilitar o suporte"\n'
        + '  const forjado = req && req.headers && req.headers[\'x-organization-id\'];\n'
        + '  if (forjado) return String(forjado);\n\n'
        + '  if (!sessao || typeof sessao !== \'object\') {',
  },
  {
    classe: 'entitlement',
    invariant: 'INV-23',
    teste: 'inv-23-entitlement.test.js',
    arquivo: 'lib/platform/entitlements.js',
    descricao: 'fail-open: fonte de entitlements no chão concede a feature (server.js:13390)',
    de: '    throw new EntitlementDeniedError(feature, `fonte de entitlements indisponível (${err.message})`);',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "não dá pra travar o cliente se o banco cair"\n'
        + '    void err; return true;',
  },
  {
    classe: 'secrets',
    invariant: 'INV-13',
    teste: 'inv-13-secrets.test.js',
    arquivo: 'lib/secrets/store.js',
    descricao: 'handler ecoando o segredo semeado: listarMetadata devolve o ciphertext junto',
    de: '      `SELECT tipo, last4, key_version, expires_at, rotated_at\n'
      + '         FROM integration_secrets WHERE integration_id = $1 ORDER BY tipo`,\n'
      + '      [integrationId]\n'
      + '    );\n'
      + '    return rows.map(metadataDeSegredo);',
    para: '      `SELECT tipo, last4, key_version, expires_at, rotated_at, ciphertext\n'
        + '         FROM integration_secrets WHERE integration_id = $1 ORDER BY tipo`,\n'
        + '      [integrationId]\n'
        + '    );\n'
        + '    // VIOLAÇÃO DELIBERADA (negative control) — "o front precisa do valor pra mostrar"\n'
        + '    return rows.map((r) => ({ ...metadataDeSegredo(r), ciphertext: r.ciphertext }));',
  },
  {
    classe: 'webhook',
    invariant: 'INV-15',
    teste: 'inv-15-webhook.test.js',
    arquivo: 'lib/platform/webhook-routing.js',
    descricao: 'identifyInkWebhookStore(): varre as conexões testando cada segredo (server.js:1280-1291)',
    de: '  void conexoesConhecidas;\n\n  if (!routeToken) {',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — reintrodução de identifyInkWebhookStore()\n'
        + '  if (signature && rawBody) {\n'
        + '    for (const c of conexoesConhecidas) {\n'
        + '      if (!c.webhookSecret) continue;\n'
        + '      if (comparacaoSegura(signature, assinaturaEsperada(c.webhookSecret, rawBody))) {\n'
        + '        return { conexaoId: c.id, organizationId: c.organizationId };\n'
        + '      }\n'
        + '    }\n'
        + '  }\n\n'
        + '  if (!routeToken) {',
  },
  {
    classe: 'tenancy/rls-context',
    invariant: 'TD-001',
    teste: 'td001-rls-contract.test.js',
    arquivo: 'lib/platform/tenant-db.js',
    descricao: 'contexto da Organization gravado na SESSÃO (is_local=false) — sobrevive no pool',
    de: "    await client.query('SELECT set_config($1, $2, true)', [CONFIG_ORGANIZATION, organizationId]);",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "SET sem LOCAL, é a mesma coisa"\n'
        + "    await client.query('SELECT set_config($1, $2, false)', [CONFIG_ORGANIZATION, organizationId]);",
  },
  {
    classe: 'tenancy/mapping',
    invariant: 'PD-019',
    teste: 'tenancy-mapping.test.js',
    arquivo: 'lib/platform/tenancy-mapping.js',
    descricao: 'mapeamento duplicado aceito — "o último vence" em vez de ambíguo',
    de: '    if (vistos.has(id)) {\n      erros.push(',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "o último vence"\n'
        + '    if (vistos.has(id) && false) {\n      erros.push(',
  },
  // ── Fase 2 · auth ──────────────────────────────────────────────────────────────────────────
  {
    classe: 'auth/login-tenant',
    invariant: 'INV-02',
    teste: 'auth-flow.test.js',
    arquivo: 'lib/auth/router.js',
    descricao: 'login volta a aceitar organization_id (e qualquer outro campo) no corpo',
    de: '    if (extras.length) {',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "o front manda a org junto"\n'
        + '    if (extras.length && false) {',
  },
  {
    classe: 'auth/revogacao',
    invariant: 'FASE-2',
    teste: 'auth-flow.test.js',
    arquivo: 'lib/auth/sessions.js',
    descricao: 'sessão revogada continua aceita',
    de: '          AND s.revogada_em IS NULL\n',
    para: '          -- VIOLAÇÃO DELIBERADA (negative control): revogação ignorada\n',
  },
  {
    classe: 'audit/sujeito',
    invariant: 'INV-21',
    teste: 'auth-flow.test.js',
    arquivo: 'lib/platform/audit.js',
    descricao: "actor_user_id volta a ser 'admin'",
    de: '  const ator = validarAtor(entrada.actorUserId);',
    para: "  // VIOLAÇÃO DELIBERADA (negative control) — sujeito sintético\n  const ator = 'admin';",
  },
  // ── Aceite do convite de owner (docs/architecture/invite-acceptance.md) ────────────────────
  {
    classe: 'convite/grant-da-role',
    invariant: 'OPS-14',
    teste: 'convite-aceite.test.js',
    arquivo: 'lib/platform/app-role.js',
    descricao: 'o GRANT EXECUTE das funções do convite some — a rota para de funcionar sob oria_app',
    de: "  'platform_convite_pendente(TEXT)',\n  'platform_consumir_convite(TEXT, UUID)',\n]);",
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "é função do control plane, o painel não precisa"\n]);',
  },
  {
    classe: 'convite/motivo-vazado',
    invariant: 'CONVITE',
    teste: 'convite-aceite.test.js',
    arquivo: 'lib/auth/invites.js',
    descricao: 'a resposta distingue desconhecido/usado/revogado/expirado ("ajuda o suporte")',
    de: "  return new ConviteError('convite_invalido', 404, MENSAGEM_GENERICA, { motivo });",
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "a mensagem genérica confunde o cliente"\n'
        + '  return new ConviteError(`convite_${motivo}`, 404, `convite ${motivo}`, { motivo });',
  },
  {
    classe: 'convite/sessao-de-outro-email',
    invariant: 'CONVITE',
    teste: 'convite-aceite.test.js',
    arquivo: 'lib/auth/invites.js',
    descricao: 'quem já está logado consome o convite de outro e-mail ("aproveita a sessão aberta")',
    de: '        if (auth.email !== c.email) {',
    para: '        // VIOLAÇÃO DELIBERADA (negative control) — "já está logado, aproveita a sessão"\n'
        + '        if (false && auth.email !== c.email) {',
  },
  {
    classe: 'convite/conta-existente-troca-senha',
    invariant: 'CONVITE',
    teste: 'convite-aceite.test.js',
    arquivo: 'lib/auth/invites.js',
    descricao: 'o aceite redefine a senha de uma conta que já existe — tomada de conta pelo token',
    de: '      } else if (existente) {\n'
      + '        // Conta já existe: nada de criar, nada de trocar senha. Autentica primeiro, aceita depois.\n'
      + "        throw new ConviteError('conta_existente', 409,\n"
      + "          'este e-mail já tem conta no Oria — entre nela e aceite o convite de novo');\n"
      + '      } else {',
    para: '      } else if (existente) {\n'
        + '        // VIOLAÇÃO DELIBERADA (negative control) — "o token prova que é a pessoa, então redefine"\n'
        + "        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [senhaHash, existente.id]);\n"
        + '        userId = existente.id;\n'
        + '      } else {',
  },
  {
    classe: 'auth/csrf',
    invariant: 'FASE-2',
    teste: 'auth-flow.test.js',
    arquivo: 'lib/auth/middleware.js',
    descricao: 'escrita autenticada aceita sem token CSRF',
    de: '    if (!METODOS_SEGUROS.has(req.method)) {',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "SameSite=Strict já basta"\n'
        + '    if (false && !METODOS_SEGUROS.has(req.method)) {',
  },
  {
    classe: 'auth/fixation',
    invariant: 'FASE-2',
    teste: 'auth-flow.test.js',
    arquivo: 'lib/auth/router.js',
    descricao: 'id de sessão pré-login continua válido depois do login',
    de: "    if (anterior) await sessoes.revogarPorToken(anterior, { motivo: 'substituida_no_login' });",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — sessão anterior preservada\n    void anterior;',
  },
  // ── Entitlement canônico ───────────────────────────────────────────────────────────────────
  {
    classe: 'entitlement/app-config-como-fonte',
    invariant: 'ENT-01',
    teste: 'entitlement-canonico.test.js',
    arquivo: 'lib/platform/entitlements.js',
    descricao: 'o painel volta a resolver entitlement por app_config — a segunda fonte de verdade que deixou o Tenant #1 sem acesso',
    de: "      'SELECT feature FROM entitlements_efetivos($1)',\n      [ctx.organizationId]\n    );\n    if (!rows.length) return null;\n    return Object.fromEntries(rows.map((r) => [r.feature, true]));",
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — volta para a cópia local\n'
        + "      `SELECT valor FROM app_config WHERE chave = 'entitlements' AND organization_id = $1`,\n"
        + '      [ctx.organizationId]\n    );\n'
        + '    const valor = rows.length === 1 ? rows[0].valor : null;\n'
        + "    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : null;",
  },
  // ── Connector Ink sem loja_legada (§29) ────────────────────────────────────────────────────
  {
    classe: 'connector/leitura-por-loja',
    invariant: 'STORE-01',
    teste: 'fase4-server-integrations.test.js',
    arquivo: 'server.js',
    descricao: 'o escopo de leitura volta a ser a chave legada em vez da Store',
    de: "  if (!loja) {\n    return { sql: `store_id = $${proximoParametro}`, params: [storeId], usados: 1 };\n  }",
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "a loja é o escopo de sempre"\n'
        + '  if (!loja) {\n    return { sql: `loja = $${proximoParametro}`, params: [storeId], usados: 1 };\n  }',
  },
  {
    classe: 'connector/chamador-exige-loja-legada',
    invariant: 'STORE-02',
    teste: 'fase4-server-integrations.test.js',
    arquivo: 'server.js',
    descricao: 'o caminho da Ink volta a exigir chave legada para existir',
    de: '  if (!ctx.storeId || !(await inkConectada())) return [];\n  return [{ storeId: ctx.storeId, loja: ctx.loja || null }];',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "sem loja não há Ink"\n'
        + '  if (!ctx.loja || !(await inkConectada())) return [];\n  return [{ storeId: ctx.storeId, loja: ctx.loja }];',
  },
  {
    classe: 'connector/store-nativa-no-path-legado',
    invariant: 'STORE-03',
    teste: 'fase4-server-integrations.test.js',
    arquivo: 'server.js',
    descricao: 'Store nativa (sem chave legada) passa a enxergar linha histórica pelo ramo de compatibilidade',
    de: "    sql: `(store_id = $${proximoParametro} OR (store_id IS NULL AND loja = $${proximoParametro + 1}))`,",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — ramo legado sem exigir chave\n'
        + '    sql: `(store_id = $${proximoParametro} OR store_id IS NULL)`,',
  },
  {
    classe: 'connector/save-sem-atomicidade',
    invariant: 'STORE-04',
    teste: 'fase4-server-integrations.test.js',
    arquivo: 'lib/platform/integrations.js',
    descricao: 'gravar credencial volta a commitar o segredo antes da auditoria',
    de: '      const resultado = await executar(ligado, cliente);\n      await cliente.query(\'COMMIT\');',
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — commit antes de terminar\n'
        + '      await cliente.query(\'COMMIT\');\n      const resultado = await executar(ligado, cliente);',
  },
  // ── Fase 3 · tenant context + entitlements ─────────────────────────────────────────────────
  {
    classe: 'tenancy/loja-do-request',
    invariant: 'INV-01',
    teste: 'fase3-static.test.js',
    arquivo: 'server.js',
    descricao: 'rota volta a aceitar loja da query (req.query.loja)',
    de: "  if (!pgPool) return res.status(503).json({ error: 'histórico de compras exige Postgres configurado' });\n\n"
      + '  try {\n    // O escopo é canônico (',
    para: "  if (!pgPool) return res.status(503).json({ error: 'histórico de compras exige Postgres configurado' });\n"
        + '  // VIOLAÇÃO DELIBERADA (negative control) — "o filtro de loja da tela"\n'
        + '  const lojas = [req.query.loja || lojaLegadaDoContexto()];\n\n'
        + '  try {\n    // O escopo é canônico (',
  },
  {
    classe: 'tenancy/agregacao-lojas',
    invariant: 'F-02',
    teste: 'fase3-static.test.js',
    arquivo: 'server.js',
    descricao: 'fetchAcrossInkStores() de volta: a consulta percorre todas as lojas da instalação',
    de: '  for (const { loja } of await storesInkDoContexto()) {\n    try {\n      const data = await inkApiRequest(loja, pathAndQuery);',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — reintrodução de fetchAcrossInkStores()\n'
        + '  for (const loja of LOJAS_LEGADAS) {\n    try {\n      const data = await inkApiRequest(loja, pathAndQuery);',
  },
  {
    classe: 'tenancy/candidato-unico',
    invariant: 'INV-09',
    teste: 'fase3-tenant-context.test.js',
    arquivo: 'lib/platform/tenant-pipeline.js',
    descricao: 'User C com duas Organizations recebe a primeira em vez de escolher',
    de: "  throw new TenantContextHttpError(409, 'ORGANIZATION_CONTEXT_REQUIRED', 'escolha uma organization para continuar');",
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "pega a primeira, o usuário troca depois"\n'
        + '  return { membership: memberships[0], memberships, autoSelecionada: true };',
  },
  {
    classe: 'tenancy/ownership-id',
    invariant: 'INV-20',
    teste: 'fase3-tenant-context.test.js',
    arquivo: 'lib/platform/ownership.js',
    descricao: 'recurso por id carregado só pelo id, sem Organization nem conferência de dono',
    de: '        const linha = await buscarDaOrganizacao(pool, tabela, req.params[param], { coluna });\n'
      + "        if (!linha) return res.status(404).json({ error: 'não encontrado' });\n"
      + '        assertOwnership({\n'
      + '          recurso: `${tabela}:${req.params[param]}`,\n'
      + '          organizationIdDoRecurso: linha.organization_id,\n'
      + '          organizationIdDoContexto: ctx && ctx.organizationId,\n'
      + '        });',
    para: '        // VIOLAÇÃO DELIBERADA (negative control) — "a RLS já cuida disso"\n'
        + '        void ctx;\n'
        + '        const { rows: [linha] } = await pool.query(`SELECT * FROM ${tabela} WHERE ${coluna} = $1`, [req.params[param]]);\n'
        + "        if (!linha) return res.status(404).json({ error: 'não encontrado' });",
  },
  {
    classe: 'entitlement/ausencia',
    invariant: 'INV-23',
    teste: 'inv-23-entitlement.test.js',
    arquivo: 'lib/platform/entitlements.js',
    descricao: 'feature ausente do plano concede (default true)',
    de: "    throw new EntitlementDeniedError(feature, 'feature ausente no plano — ausência nega (INV-23)');",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "o que não está no plano é liberado"\n'
        + '    return true;',
  },
  {
    classe: 'recuperacao/escopo',
    invariant: 'INV-24',
    teste: 'inv-24-recuperacao.test.js',
    arquivo: 'lib/recuperacao/compra.js',
    descricao: 'filtro de loja condicional: sem loja no carrinho, casa com pedido de qualquer loja',
    de: "  if (!alvo || typeof alvo.loja !== 'string' || !alvo.loja) {\n"
      + "    throw new Error('recuperação exige a loja do carrinho (escopo obrigatório)');\n"
      + '  }\n',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — escopo opcional\n',
  },
  {
    classe: 'jobs/contexto',
    invariant: 'INV-17',
    teste: 'fase3-tenant-context.test.js',
    arquivo: 'lib/platform/jobs.js',
    descricao: 'job roda sem comOrganization (sem contexto da Organization)',
    de: '        await comContexto({ ...org, origem: `job:${nome}` }, () => fn(org));',
    para: '        // VIOLAÇÃO DELIBERADA (negative control) — "o job já sabe a org"\n'
        + '        await fn(org);',
  },
  {
    classe: 'creative/tenant-env',
    invariant: 'INV-22',
    teste: 'inv-22-creative-tenant.test.js',
    arquivo: 'routes/criativos.js',
    descricao: 'tenant do Creative Core volta a vir de CREATIVE_TENANT_ID',
    de: "    try { tenant = String(deps.tenantAtual() || '').toLowerCase(); } catch { tenant = null; }",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — tenant da instalação\n'
        + "    try { tenant = String(process.env.CREATIVE_TENANT_ID || deps.tenantAtual() || '').toLowerCase(); } catch { tenant = null; }",
  },
  // ── Rodada 19 · OPS-22, leitura dupla temporária dos arquivos do Creative Core ────────────
  {
    classe: 'creative/dual-read-organization',
    invariant: 'OPS-22',
    teste: 'ops22-creative-dual-read.test.js',
    arquivo: 'lib/creative-core/storage.js',
    descricao: 'fallback para o diretório legado sem checar a Organization mapeada ("só existe uma Organization")',
    de: '  const raizLegada = leituraLegada && leituraLegada.organizationId === tenantId\n',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — qualquer Organization lê o legado\n'
        + '  const raizLegada = leituraLegada\n',
  },
  {
    classe: 'creative/dual-read-confinamento',
    invariant: 'OPS-22',
    teste: 'ops22-creative-dual-read.test.js',
    arquivo: 'lib/creative-core/storage.js',
    descricao: 'fallback monta o diretório legado sem validar nem confinar (traversal / diretório de outra Organization)',
    de: "  if (typeof de !== 'string' || !TENANT_RE.test(de) || UUID_RE.test(de)) throw erro('leitura legada: origem inválida', 500);\n"
      + '  const alvo = path.resolve(raizTenants, de);\n'
      + "  if (path.dirname(alvo) !== raizTenants) throw erro('leitura legada: origem fora do diretório de tenants', 500);\n"
      + '  return alvo;\n',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "a env é confiável"\n'
        + '  return path.resolve(raizTenants, String(de));\n',
  },
  // ── Fase 4 · integrações ───────────────────────────────────────────────────────────────────
  {
    classe: 'integracoes/resolver-global',
    invariant: 'INV-12',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/platform/integrations.js',
    descricao: 'integração escolhida por LIMIT 1 do provider, sem a Organization',
    de: '        WHERE organization_id = $1 AND provider = $2 AND escopo IS NULL`,\n      [ctx.organizationId, provider]',
    para: '        WHERE ($1::uuid IS NOT NULL) AND provider = $2 AND escopo IS NULL ORDER BY id DESC LIMIT 1` /* VIOLAÇÃO DELIBERADA */,\n      [ctx.organizationId, provider]',
  },
  {
    classe: 'integracoes/token-de-outra-org',
    invariant: 'INV-12',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/secrets/store.js',
    descricao: 'segredo lido pelo tipo, sem integração nem Organization — B recebe o token de A',
    de: '        WHERE integration_id = $1 AND tipo = $2 AND ($3::uuid IS NULL OR organization_id = $3)`,',
    para: '        WHERE ($1::bigint IS NOT NULL) AND tipo = $2 AND ($3::uuid IS NULL OR TRUE) ORDER BY id LIMIT 1` /* VIOLAÇÃO DELIBERADA */,',
  },
  {
    classe: 'dre/sem-loja',
    invariant: 'INV-11',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/financeiro/midia.js',
    descricao: 'recurso de mídia sem loja atribuída entra no total',
    de: "  if (!conta.loja_atribuida) return 'sem_loja';",
    para: "  // VIOLAÇÃO DELIBERADA (negative control) — \"sem loja é da loja\"\n"
        + "  if (!conta.loja_atribuida) return null;",
  },
  {
    classe: 'dre/customer-de-outra-org',
    invariant: 'INV-11',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/financeiro/midia.js',
    descricao: 'gasto do Google Ads somado pelo customer id, sem a Organization — o de B entra na DRE de A',
    de: "             WHERE organization_id = $1 AND customer_id = $2 AND level = 'customer'",
    para: "             WHERE ($1::uuid IS NOT NULL) AND customer_id = $2 AND level = 'customer' /* VIOLAÇÃO DELIBERADA */",
  },
  {
    classe: 'dre/loja-atribuida-padrao',
    invariant: 'F-07',
    teste: 'fase3-static.test.js',
    arquivo: 'server.js',
    descricao: 'lojaAtribuidaPadrao() reaparece',
    de: 'async function financeiroDaLoja(from, to) {',
    para: '// VIOLAÇÃO DELIBERADA (negative control)\nfunction lojaAtribuidaPadrao() { return lojaLegadaDoContexto(); }\n\n'
        + 'async function financeiroDaLoja(from, to) {',
  },
  {
    classe: 'secrets/resposta',
    invariant: 'INV-13',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/platform/secret-guard.js',
    descricao: 'resposta HTTP sai sem passar pela redação de segredos',
    de: '  return function secretGuard(req, res, next) {\n',
    para: '  return function secretGuard(req, res, next) {\n    return next(); // VIOLAÇÃO DELIBERADA (negative control)\n',
  },
  {
    classe: 'secrets/log',
    invariant: 'INV-13',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/platform/secret-guard.js',
    descricao: 'log/erro escrito sem redação de segredos',
    de: '      return original.apply(alvo, args.map(redigirValor));',
    para: '      return original.apply(alvo, args); // VIOLAÇÃO DELIBERADA (negative control)',
  },
  {
    classe: 'oauth/org-do-navegador',
    invariant: 'INV-12',
    teste: 'fase4-server-integrations.test.js',
    arquivo: 'server.js',
    descricao: 'callback OAuth aceita organization_id vindo do navegador',
    de: "    await comOrganizacaoResolvida(salvo.organizationId, 'oauth:ga4', async () => {",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "o front sabe a org"\n'
        + "    await comOrganizacaoResolvida(req.query.organization_id || salvo.organizationId, 'oauth:ga4', async () => {",
  },
  {
    classe: 'integracoes/desconectar-cruzado',
    invariant: 'INV-12',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/secrets/store.js',
    descricao: 'desconectar A apaga segredos de outras Organizations',
    de: '        WHERE integration_id = $1 AND ($2::uuid IS NULL OR organization_id = $2)\n',
    para: '        WHERE ($1::bigint IS NOT NULL) AND ($2::uuid IS NULL OR TRUE) /* VIOLAÇÃO DELIBERADA */\n',
  },
  {
    classe: 'integracoes/env-global',
    invariant: 'INV-12',
    teste: 'fase4-integrations.test.js',
    arquivo: 'lib/platform/integrations.js',
    descricao: 'fallback de env atende Organization sem loja legada mapeada',
    de: '    const loja = ctx.loja;\n    if (!loja || !LOJAS_LEGADAS.includes(loja) || !ENV_LEGADO_INK[tipo]) return null;',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "usa a variável que existir"\n'
        + '    const loja = ctx.loja || LOJAS_LEGADAS.find((l) => ENV_LEGADO_INK[tipo] && env[ENV_LEGADO_INK[tipo](l)]);\n'
        + '    if (!loja || !ENV_LEGADO_INK[tipo]) return null;',
  },
  // ── Fase 5b · remetente WhatsApp ─────────────────────────────────────────────────────────
  {
    classe: 'whatsapp/par-cruzado',
    invariant: 'INV-28',
    teste: 'fase5b-whatsapp-sender.test.js',
    arquivo: 'lib/platform/whatsapp-sender.js',
    descricao: 'número de outra Organization sai com o token desta (sem conferir a posse do número)',
    de: "      await integracoes.reivindicarRecurso(PROVIDER, 'phone_number', phoneNumberId);\n",
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — "a config é confiável"\n',
  },
  {
    classe: 'whatsapp/ref-forjada',
    invariant: 'INV-25',
    teste: 'fase5b-whatsapp-sender.test.js',
    arquivo: 'lib/platform/whatsapp-sender.js',
    descricao: 'referência do Go aceita sem conferir a assinatura do painel',
    de: '    if (esperada.length !== recebida.length || !crypto.timingSafeEqual(esperada, recebida)) throw invalida();',
    para: '    void esperada; void recebida; // VIOLAÇÃO DELIBERADA (negative control) — "o Go é interno"',
  },
  {
    classe: 'whatsapp/token-serializavel',
    invariant: 'INV-13',
    teste: 'fase5b-whatsapp-sender.test.js',
    arquivo: 'lib/platform/whatsapp-sender.js',
    descricao: 'token do remetente enumerável: vai junto em JSON, log e spread',
    de: "  Object.defineProperty(remetente, 'accessToken', { value: accessToken, enumerable: false });\n"
      + "  Object.defineProperty(remetente, 'toJSON', { value: () => ({ ...publico }), enumerable: false });",
    para: '  remetente.accessToken = accessToken; // VIOLAÇÃO DELIBERADA (negative control)',
  },
  {
    classe: 'whatsapp/remetente-global',
    invariant: 'INV-28',
    teste: 'fase5b-server-whatsapp.test.js',
    arquivo: 'server.js',
    descricao: 'painel reaproveita o primeiro remetente resolvido para todas as chamadas (estado de processo)',
    de: '      return chamarServicoWhatsapp(method, pathAndQuery, body, headers);',
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — "o número é sempre o mesmo"\n'
        + '      globalThis.__remetenteWhatsapp = globalThis.__remetenteWhatsapp || headers;\n'
        + '      return chamarServicoWhatsapp(method, pathAndQuery, body, globalThis.__remetenteWhatsapp);',
  },
  {
    classe: 'whatsapp/health-como-remetente',
    invariant: 'INV-35',
    teste: 'fase5b-server-whatsapp.test.js',
    arquivo: 'server.js',
    descricao: 'painel volta a descobrir o número no /health do serviço Go',
    de: '    phoneNumberId = (await remetenteWhatsappParaTela()).phoneNumberId;',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "o serviço sabe o número"\n'
        + '    phoneNumberId = (healthResult.value && healthResult.value.phone_number_id) || (await remetenteWhatsappParaTela()).phoneNumberId;',
  },
  // ── Fase 5c · entrada multi-tenant ─────────────────────────────────────────────────────────
  {
    classe: 'jobs/lease-ignorado',
    invariant: 'INV-18',
    teste: 'fase5c-leases.test.js',
    arquivo: 'lib/platform/jobs.js',
    descricao: 'réplica roda o job mesmo sem conseguir o lease persistente',
    de: '        if (!ok) {\n          resultado.puladas += 1;\n          continue;\n        }',
    para: '        void ok; // VIOLAÇÃO DELIBERADA (negative control) — "a trava em memória basta"',
  },
  {
    classe: 'webhook/ink-segredo-do-ambiente',
    invariant: 'TD-005',
    teste: 'fase3-static.test.js',
    arquivo: 'server.js',
    descricao: 'entrada da Ink volta a identificar a loja testando o segredo do ambiente',
    de: "app.post('/api/webhooks/ink/:token', async (req, res) => {",
    para: '// VIOLAÇÃO DELIBERADA (negative control)\n'
        + "app.post('/api/webhooks/ink', (req, res) => res.sendStatus(process.env.INK_WEBHOOK_SECRET_SUL ? 200 : 401));\n"
        + "app.post('/api/webhooks/ink/:token', async (req, res) => {",
  },
  {
    classe: 'webhook/ink-segredo-de-outra-org',
    invariant: 'INV-15',
    teste: 'fase3-server-ab.test.js',
    arquivo: 'server.js',
    descricao: 'a URL resolve a Organization, mas a assinatura é aceita se casar com o segredo de qualquer uma',
    de: "        const conexao = { id: String(meta.integracaoId), organizationId, webhookSecret: segredo };",
    para: "        // VIOLAÇÃO DELIBERADA (negative control) — \"o segredo da loja legada serve\"\n"
        + "        const conexao = { id: String(meta.integracaoId), organizationId, webhookSecret: process.env.INK_WEBHOOK_SECRET_SUL || segredo };",
  },
  {
    classe: 'whatsapp/entrada-org-do-corpo',
    invariant: 'INV-31',
    teste: 'fase5b-server-whatsapp.test.js',
    arquivo: 'server.js',
    descricao: 'contexto de entrada aceita organization_id vindo do serviço como autoridade',
    de: "app.post('/api/internal/whatsapp/inbound-context', rotaDeContextoInterno('inbound', ['waba_id', 'phone_number_id'], async (corpo) => {",
    para: '// VIOLAÇÃO DELIBERADA (negative control) — "o Go já sabe a org"\n'
        + "app.post('/api/internal/whatsapp/inbound-context', rotaDeContextoInterno('inbound', ['waba_id', 'phone_number_id', 'organization_id'], async (corpo) => {\n"
        + '  if (corpo.organization_id) return contextoNaOrganizacao(corpo.organization_id, "x", {});',
  },
  {
    classe: 'whatsapp/entrada-divergente',
    invariant: 'INV-15',
    teste: 'fase5b-server-whatsapp.test.js',
    arquivo: 'server.js',
    descricao: 'WABA de uma Organization com número de outra deixa de ser tratado como divergência',
    de: "  if (motivo === 'divergente') {",
    para: "  if (false && motivo === 'divergente') { // VIOLAÇÃO DELIBERADA (negative control)",
  },
  // ── Fase 6 · Tenant #1 sem bypass ──────────────────────────────────────────────────────────
  {
    classe: 'fase6/bypass-interno',
    invariant: 'FASE-6',
    teste: 'fase6-tenant1-static.test.js',
    arquivo: 'server.js',
    descricao: 'caminho especial para a operação interna decidido pelo nome da Organization',
    de: "const INTERNAL_TOOLS_ENABLED = process.env.INTERNAL_TOOLS_ENABLED === 'true';",
    para: "const INTERNAL_TOOLS_ENABLED = process.env.INTERNAL_TOOLS_ENABLED === 'true';\n"
        + '// VIOLAÇÃO DELIBERADA (negative control) — "a nossa loja não precisa de entitlement"\n'
        + "const ehOperacaoInterna = (org) => Boolean(org) && org.nome === 'Use Origens';",
  },
  // ── Fase 7 (construção) · onboarding ───────────────────────────────────────────────────────
  {
    classe: 'onboarding/gate',
    invariant: 'F7-GATE',
    teste: 'fase7-onboarding.test.js',
    arquivo: 'lib/platform/onboarding.js',
    descricao: 'SECOND_TENANT_ENABLED só na UI: o serviço cria Organization com o gate desligado',
    de: '    if (!config.criacaoHabilitada) {',
    para: '    if (false && !config.criacaoHabilitada) { // VIOLAÇÃO DELIBERADA (negative control) — "o gate é da tela"',
  },
  {
    classe: 'onboarding/ja-existe-uma',
    invariant: 'F7-IDEMPOTENCIA',
    teste: 'fase7-onboarding.test.js',
    arquivo: 'lib/platform/onboarding.js',
    descricao: 'idempotência por "a pessoa já tem uma Organization, devolve essa" em vez da chave explícita',
    de: '        const { rows: [reserva] } = await c.query(',
    para: '        // VIOLAÇÃO DELIBERADA (negative control) — "se já é owner de alguma, é essa"\n'
        + "        const { rows: ja } = await c.query(`SELECT organization_id FROM auth_memberships($1) WHERE papel = 'owner'`, [userId]);\n"
        + '        if (ja.length) throw new ChaveJaReservada({ organization_id: ja[0].organization_id, digest, userId });\n'
        + '        const { rows: [reserva] } = await c.query(',
  },
  {
    classe: 'onboarding/chave-sem-pedido',
    invariant: 'F7-IDEMPOTENCIA',
    teste: 'fase7-onboarding.test.js',
    arquivo: 'lib/platform/onboarding.js',
    descricao: 'mesma chave de idempotência com outro pedido devolve a Organization antiga em silêncio',
    de: '      if (reserva.digest !== digest) {',
    para: '      if (false && reserva.digest !== digest) { // VIOLAÇÃO DELIBERADA (negative control)',
  },
  {
    classe: 'onboarding/erro-bruto',
    invariant: 'F7-ERRO',
    teste: 'fase7-onboarding.test.js',
    arquivo: 'lib/platform/onboarding.js',
    descricao: 'mensagem do provider vira last_error_code ("ajuda o suporte")',
    de: '    const codigo = normalizarErro(erro);',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "a mensagem do provider ajuda o suporte"\n'
        + "    const codigo = String((erro && erro.message) || erro).toUpperCase().replace(/[^A-Z0-9_]+/g, '_').replace(/^_+/, '').slice(0, 60);",
  },
  {
    classe: 'onboarding/segunda-fonte',
    invariant: 'F7-PROVIDER',
    teste: 'fase7-onboarding.test.js',
    arquivo: 'lib/platform/onboarding.js',
    descricao: 'passo de provider concluído uma vez fica concluído, mesmo desconectado (segundo source of truth)',
    de: '        if (d.conectado) {',
    para: "        if (d.conectado || p.status === 'complete') { // VIOLAÇÃO DELIBERADA (negative control)",
  },
  // ── Rodada 18 · repasse do serviço Go sem segredo na URL (§22) ────────────────────────────
  {
    classe: 'whatsapp/repasse-segredo-na-query',
    invariant: 'R18-22',
    teste: 'trilha-c-whatsapp-forward.test.js',
    arquivo: 'lib/platform/whatsapp-forward.js',
    descricao: 'versão anterior: `?secret=` igual ao segredo autentica o repasse (server.js, rota /api/webhooks/whatsapp)',
    de: '  if (query && PARAMETROS_PROIBIDOS.some((p) => Object.prototype.hasOwnProperty.call(query, p))) {',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "a URL do Railway já tem o segredo"\n'
        + '  if (query && query.secret === segredo) return { ok: true };\n'
        + '  if (query && PARAMETROS_PROIBIDOS.some((p) => Object.prototype.hasOwnProperty.call(query, p))) {',
  },
  {
    classe: 'whatsapp/repasse-sem-segredo',
    invariant: 'R18-22',
    teste: 'trilha-c-whatsapp-forward.test.js',
    arquivo: 'lib/platform/whatsapp-forward.js',
    descricao: 'versão anterior: sem WHATSAPP_WEBHOOK_SECRET o repasse é aceito sem autenticação',
    de: "    return { ok: false, status: 503, motivo: 'WHATSAPP_WEBHOOK_SECRET ausente ou curto — repasse recusado' };",
    para: '    return { ok: true }; // VIOLAÇÃO DELIBERADA (negative control) — "o segredo é opcional"',
  },
  {
    classe: 'whatsapp/repasse-rota-legada',
    invariant: 'R18-22',
    teste: 'fase3-server-ab.test.js',
    arquivo: 'server.js',
    descricao: 'a rota volta a aceitar o segredo da query string (comparação da versão anterior)',
    de: '    segredo: WHATSAPP_WEBHOOK_SECRET, headers: req.headers, query: req.query, corpoCru: req.rawBody,\n  });',
    para: '    segredo: WHATSAPP_WEBHOOK_SECRET, headers: req.headers, query: req.query, corpoCru: req.rawBody,\n  });\n'
        + '  // VIOLAÇÃO DELIBERADA (negative control)\n'
        + '  if (req.query.secret === WHATSAPP_WEBHOOK_SECRET) verificacao.ok = true;',
  },
  // ── Rodada 19 · transição do repasse sem perda de status (§5) ──────────────────────────────
  {
    classe: 'whatsapp/tolerancia-sem-assinatura',
    invariant: 'R19-5',
    teste: 'r19-whatsapp-forward-transicao.test.js',
    arquivo: 'lib/platform/whatsapp-forward.js',
    descricao: 'na transição, a query legada basta (o repasse sem assinatura é aceito)',
    de: '    queryLegadaTolerada = true;\n',
    para: '    queryLegadaTolerada = true;\n'
        + '    return { ok: true, queryLegadaTolerada }; // VIOLAÇÃO DELIBERADA (negative control) — "o painel antigo também só olhava a query"\n',
  },
  {
    classe: 'whatsapp/tolerancia-compara-query',
    invariant: 'R19-5',
    teste: 'r19-whatsapp-forward-transicao.test.js',
    arquivo: 'lib/platform/whatsapp-forward.js',
    descricao: 'na transição, a query igual ao segredo autentica (comparação da versão anterior)',
    de: '    queryLegadaTolerada = true;\n',
    para: '    queryLegadaTolerada = true;\n'
        + '    if (query.secret === segredo) return { ok: true, queryLegadaTolerada }; // VIOLAÇÃO DELIBERADA (negative control)\n',
  },
  {
    classe: 'whatsapp/tolerancia-sem-flag',
    invariant: 'R19-5',
    teste: 'r19-whatsapp-forward-transicao.test.js',
    arquivo: 'lib/platform/whatsapp-forward.js',
    descricao: 'a tolerância vale sem a flag explícita (ou com valor que não é true)',
    de: '    if (toleraQueryLegada !== true) {',
    para: '    if (!toleraQueryLegada && false) { // VIOLAÇÃO DELIBERADA (negative control) — "tolerar sempre é mais simples"',
  },
  // ── Rodada 19 · segredo do repasse obrigatório no boot de produção (§4) ──────────────────────
  {
    classe: 'whatsapp/repasse-boot-so-avisa',
    invariant: 'R19-04',
    teste: 'r19-whatsapp-webhook-secret-boot.test.js',
    arquivo: 'server.js',
    descricao: 'versão anterior: sem WHATSAPP_WEBHOOK_SECRET o boot de produção só avisa e sobe (repasse 503)',
    de: '    console.error(`[WHATSAPP_WEBHOOK] ${segredoDoRepasse.motivo}`);\n    process.exit(1);',
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "só avisa, o repasse já responde 503"\n'
        + '    console.warn(`[WHATSAPP_WEBHOOK] ${segredoDoRepasse.motivo}`);',
  },
  {
    classe: 'whatsapp/repasse-boot-inferido',
    invariant: 'R19-04',
    teste: 'r19-whatsapp-webhook-secret-boot.test.js',
    arquivo: 'lib/platform/whatsapp-forward.js',
    descricao: 'versão anterior: o segredo só é exigido quando WHATSAPP_SERVICE_URL existe (ausência lida como módulo desligado)',
    de: '  if (!producao || segredoConfigurado(env.WHATSAPP_WEBHOOK_SECRET)) return { ok: true };',
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "sem WHATSAPP_SERVICE_URL o WhatsApp está desligado"\n'
        + '  if (!producao || !env.WHATSAPP_SERVICE_URL || segredoConfigurado(env.WHATSAPP_WEBHOOK_SECRET)) return { ok: true };',
  },
  // ── Rodada de dogfooding (2026-09-19) · Store nativa + handlers async ──────────────────────────
  {
    classe: 'http/async-sem-rede',
    invariant: 'HTTP-01',
    teste: 'http-safety.test.js',
    arquivo: 'lib/platform/http-safety.js',
    descricao: 'a promise rejeitada do handler async deixa de ser observada: a requisição nunca responde (o "Carregando" infinito)',
    de: "  if (retorno && typeof retorno.then === 'function') {",
    para: "  // VIOLAÇÃO DELIBERADA (negative control) — comportamento do Express 4 puro: ninguém olha a promise\n"
        + "  if (false && retorno && typeof retorno.then === 'function') {",
  },
  {
    classe: 'http/erro-vaza-stack',
    invariant: 'HTTP-02',
    teste: 'http-safety.test.js',
    arquivo: 'lib/platform/http-safety.js',
    descricao: 'erro desconhecido devolve o stack no corpo da resposta',
    de: '  return { ...ERRO_INTERNO };',
    para: "  // VIOLAÇÃO DELIBERADA (negative control) — \"ajuda a depurar em produção\"\n"
        + "  return { status: 500, error: String(err && err.stack ? err.stack : err), codigo: 'INTERNAL_ERROR' };",
  },
  {
    classe: 'store-nativa/clientes-exige-loja-legada',
    invariant: 'STORE-05',
    teste: 'store-nativa-dogfooding.test.js',
    arquivo: 'server.js',
    descricao: 'Clientes volta a exigir a chave legada da Store (a variável morta que fazia a tela pendurar)',
    de: "  try {\n    // O escopo é canônico (`organization_id + store_id`, com o ramo de compatibilidade só quando a",
    para: "  const lojas = [lojaLegadaDoContexto()]; // VIOLAÇÃO DELIBERADA (negative control)\n"
        + "  try {\n    // O escopo é canônico (`organization_id + store_id`, com o ramo de compatibilidade só quando a",
  },
  {
    classe: 'store-nativa/financeiro-exige-loja-legada',
    invariant: 'STORE-06',
    teste: 'store-nativa-dogfooding.test.js',
    arquivo: 'server.js',
    descricao: 'Financeiro (saldo) volta a exigir a chave legada da Store',
    de: "  const storeId = storeDoContexto();\n  try {\n    const data = await inkApiRequestDaStore('/v1/stores/balance');",
    para: "  const loja = lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control)\n"
        + "  const storeId = storeDoContexto();\n  try {\n    const data = await inkApiRequestDaStore('/v1/stores/balance');",
  },
  {
    classe: 'store-nativa/lucro-produtos-join-por-loja',
    invariant: 'STORE-07',
    teste: 'store-nativa-dogfooding.test.js',
    arquivo: 'server.js',
    descricao: 'itens do lucro por produto ligados ao pedido só pela chave `loja` (NULA na Store nativa): o ranking some',
    de: '         AND (i.store_id = p.store_id OR (i.store_id IS NULL AND i.loja = p.loja))`;',
    para: '         AND i.loja = p.loja`; // VIOLAÇÃO DELIBERADA (negative control)',
  },
  {
    classe: 'dashboard/escopo-loja-nula',
    invariant: 'DASH-01',
    teste: 'dashboard-escopo-loja.test.js',
    arquivo: 'src/pages/dashboard/escopoLoja.ts',
    descricao: 'o Dashboard volta a comparar `loja === escopo`: null !== \'\' filtra tudo e mostra zeros',
    de: '  return chaveDeLoja(a) === chaveDeLoja(b);',
    para: '  return a === b; // VIOLAÇÃO DELIBERADA (negative control)',
  },
  // ── Rodada de mídia (2026-09-20) · atribuição por organization_id + store_id ───────────────────
  {
    classe: 'midia/atribuicao-canonica-ausente',
    invariant: 'MIDIA-01',
    teste: 'midia-store-nativa.test.js',
    arquivo: 'lib/financeiro/midia.js',
    descricao: 'a fonte única de mídia deixa de reconhecer `store_id`: conta da Store nativa cai em "sem loja" e o gasto some',
    de: "  if (conta.store_id) return storeId && conta.store_id === storeId ? null : 'outra_loja';",
    para: '  // VIOLAÇÃO DELIBERADA (negative control) — "a atribuição é só o texto loja_atribuida"',
  },
  {
    classe: 'midia/store-nativa-no-ramo-legado',
    invariant: 'MIDIA-02',
    teste: 'midia-store-nativa.test.js',
    arquivo: 'lib/financeiro/midia.js',
    descricao: 'Store nativa (sem chave legada) passa a receber o gasto de conta atribuída por texto a outra era',
    de: "  return loja && conta.loja_atribuida === loja ? null : 'outra_loja';",
    para: "  return !loja || conta.loja_atribuida === loja ? null : 'outra_loja'; // VIOLAÇÃO DELIBERADA (negative control)",
  },
  {
    classe: 'midia/conta-de-outra-organization',
    invariant: 'MIDIA-03',
    teste: 'midia-store-nativa.test.js',
    arquivo: 'lib/financeiro/midia.js',
    descricao: 'a conta de anúncio é lida sem o organization_id: o gasto de uma Organization enxerga a conta de outra',
    de: 'FROM meta_ad_accounts\n              WHERE organization_id = $1 AND selecionada`',
    para: 'FROM meta_ad_accounts\n              WHERE ($1::uuid IS NOT NULL) AND selecionada /* VIOLAÇÃO DELIBERADA (negative control) */`',
  },
  {
    classe: 'midia/select-exige-loja-legada',
    invariant: 'MIDIA-04',
    teste: 'midia-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'selecionar a conta Meta volta a exigir a chave legada: a Store nativa não consegue atribuir conta',
    de: '  const storeId = storeDoContexto();\n  const loja = lojaLegadaDoContextoOuNula();\n  if (!metaAccountId)',
    para: '  const storeId = storeDoContexto();\n  const loja = lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control)\n  if (!metaAccountId)',
  },
  {
    classe: 'financeiro/despesas-exige-loja-legada',
    invariant: 'MIDIA-05',
    teste: 'midia-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'despesas voltam a ser lidas pela chave legada: a Store nativa não vê nem cadastra despesa',
    de: '  const escopo = escopoDaStore(2);\n  const { rows } = await pgPool.query(\n    `SELECT id, categoria, descricao,',
    para: "  const escopo = { sql: 'loja = $2', params: [lojaLegadaDoContexto()], usados: 1 }; // VIOLAÇÃO DELIBERADA (negative control)\n"
        + '  const { rows } = await pgPool.query(\n    `SELECT id, categoria, descricao,',
  },
  {
    classe: 'utm/exige-loja-legada',
    invariant: 'MIDIA-06',
    teste: 'midia-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'campanha UTM volta a exigir a chave legada da Store',
    de: "  const loja = lojaLegadaDoContextoOuNula();\n  const nome = String(body?.nome || '').trim();",
    para: "  const loja = lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control)\n  const nome = String(body?.nome || '').trim();",
  },
  {
    classe: 'dashboard/midia-zero-sem-conta',
    invariant: 'DASH-02',
    teste: 'dashboard-estado-midia.test.js',
    arquivo: 'src/pages/dashboard/estadoMidia.ts',
    descricao: 'sem nenhuma conta o Dashboard passa a tratar a mídia como conectada: R$ 0 vira "gasto zero"',
    de: "  return 'nao_conectada';\n}",
    para: "  return 'conectada'; // VIOLAÇÃO DELIBERADA (negative control)\n}",
  },
  // ── Rodada de integrações core (2026-09-20) · Ink, GA4 e Meta por organization_id + store_id ────
  {
    classe: 'ink/categorias-exige-loja-legada',
    invariant: 'INK-01',
    teste: 'ink-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'Categorias volta a exigir a chave legada da Store (a rota que pendurava a tela)',
    de: "    const data = await inkApiRequestDaStore('/v1/stores/collections?per_page=100');",
    para: "    lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control)\n"
        + "    const data = await inkApiRequestDaStore('/v1/stores/collections?per_page=100');",
  },
  {
    classe: 'ink/catalogo-sem-store-id',
    invariant: 'INK-02',
    teste: 'ink-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o cache do catálogo volta a ser gravado sem store_id (só por loja): a Store nativa não tem linha',
    de: '     SELECT $16::uuid, $1, x.produto_id,',
    para: '     SELECT NULL::uuid, $1, x.produto_id, /* VIOLAÇÃO DELIBERADA (negative control) */',
  },
  {
    classe: 'ink/webhook-exige-loja-legada',
    invariant: 'INK-03',
    teste: 'ink-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o webhook verificado volta a exigir a chave legada: o evento é aceito (200) e a ingestão falha em silêncio',
    de: '    const loja = lojaLegadaDoContextoOuNula();\n    await logInkWebhook({',
    para: '    const loja = lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control)\n    await logInkWebhook({',
  },
  {
    classe: 'ink/catalogo-status-exige-loja-legada',
    invariant: 'INK-04',
    teste: 'ink-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o status do cache do catálogo volta a exigir a chave legada (o 500 do card de Integrações)',
    de: '    const loja = lojaLegadaDoContextoOuNula();\n    const escopo = escopoDaStore(2);\n    const { rows: [t] } = await pgPool.query(',
    para: '    const loja = lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control)\n    const escopo = escopoDaStore(2);\n    const { rows: [t] } = await pgPool.query(',
  },
  {
    classe: 'ink/feed-descontinuado-vira-erro',
    invariant: 'INK-05',
    teste: 'ink-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o feed descontinuado volta a ser requisito: a Store nativa recebe erro de integração no status do feed',
    de: '  if (!lojaLegadaDoContextoOuNula()) return res.json({ lojas: [], descontinuado: true });',
    para: '  lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control) — "o feed é obrigatório"',
  },
  {
    classe: 'ink/job-catalogo-so-legado',
    invariant: 'INK-06',
    teste: 'ink-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o job periódico do catálogo volta a enumerar só Stores com chave legada: a nativa nunca é sincronizada',
    de: '  for (const { storeId } of await storesInkDoContexto()) {\n    if (apenasVencidos) {',
    para: '  for (const storeId of await lojasLegadasInkDoContexto()) { // VIOLAÇÃO DELIBERADA (negative control)\n    if (apenasVencidos) {',
  },
  {
    classe: 'ink/lote-sem-store-id',
    invariant: 'INK-07',
    teste: 'ink-lote-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o job de categoria em lote volta a ser criado sem store_id (só por loja): a Store nativa não consegue associar em lote',
    de: "       VALUES ($7, $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, 'queued') RETURNING id`,",
    para: "       VALUES (NULL, $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, 'queued') /* VIOLAÇÃO DELIBERADA (negative control) */ RETURNING id`,",
  },
  {
    classe: 'ga4/connect-exige-loja-legada',
    invariant: 'GA4-01',
    teste: 'ga4-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'Conectar GA4 volta a exigir a chave legada (STORE_WITHOUT_LEGACY_KEY)',
    de: '  const storeId = storeDoContexto();\n  // Configuração da PLATAFORMA (credencial do app OAuth)',
    para: '  const storeId = storeDoContexto();\n  lojaLegadaDoContexto(); // VIOLAÇÃO DELIBERADA (negative control)\n  // Configuração da PLATAFORMA (credencial do app OAuth)',
  },
  {
    classe: 'ga4/oauth-aceita-store-arbitraria',
    invariant: 'GA4-02',
    teste: 'ga4-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o callback do GA4 deixa de conferir a Store do state: state forjado ou antigo grava a conexão',
    de: "      if (!storeId || storeDoContexto() !== storeId) throw new Error('state de outra store');",
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — "o state já vale como prova"',
  },
  {
    classe: 'ga4/cache-sem-store-id',
    invariant: 'GA4-03',
    teste: 'ga4-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o cache de performance do GA4 volta a ser gravado sem store_id (só por loja): a Store nativa não tem cache',
    de: 'VALUES ($1,$4,$2,$3, now())\n     ON CONFLICT (organization_id, store_id, periodo)',
    para: 'VALUES (NULL,$4,$2,$3, now()) /* VIOLAÇÃO DELIBERADA (negative control) */\n     ON CONFLICT (organization_id, store_id, periodo)',
  },
  {
    classe: 'meta/oauth-aceita-store-arbitraria',
    invariant: 'META-01',
    teste: 'meta-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o callback da Meta deixa de conferir a Store do state: state forjado ou antigo grava a conexão',
    de: "      if (!storeDoState || storeDoContexto() !== storeDoState) throw new Error('state de outra store');",
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — "o state já vale como prova"',
  },
  {
    classe: 'meta/conexao-com-problema-vira-saudavel',
    invariant: 'META-02',
    teste: 'meta-store-nativa.test.js',
    arquivo: 'server.js',
    descricao: 'o Dashboard trata a mídia com a conexão em erro/expirada como saudável (esconde o problema)',
    de: "        comProblema: f.conectado && comProblema(f.provider === 'meta' ? cm : cg),",
    para: '        comProblema: false, // VIOLAÇÃO DELIBERADA (negative control)',
  },
  // ── WhatsApp · Embedded Signup ─────────────────────────────────────────────────────────────
  {
    classe: 'whatsapp/es-confia-no-navegador',
    invariant: 'WAES-01',
    teste: 'whatsapp-embedded-signup.test.js',
    arquivo: 'lib/whatsapp/embedded-signup.js',
    descricao: 'a WABA que o navegador afirma passa sem a Meta confirmar que o token a enxerga',
    de: "    if (!concedeuWaba) throw erro('ES_WABA_NOT_GRANTED', 403, 'a Meta não concedeu acesso a esta conta do WhatsApp');",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "o navegador já disse qual é a WABA"',
  },
  {
    classe: 'whatsapp/es-aceita-token-de-outro-app',
    invariant: 'WAES-02',
    teste: 'whatsapp-embedded-signup.test.js',
    arquivo: 'lib/whatsapp/embedded-signup.js',
    descricao: 'um token de outro app da Meta é aceito como se fosse do app do Oria',
    de: "    if (info.appId !== String(appId)) throw erro('ES_TOKEN_OTHER_APP', 403, 'o token não pertence ao app do Oria');",
    para: '    // VIOLAÇÃO DELIBERADA (negative control) — "token válido é token válido"',
  },
  {
    classe: 'whatsapp/es-state-nao-amarrado',
    invariant: 'WAES-03',
    teste: 'whatsapp-embedded-signup.test.js',
    arquivo: 'server.js',
    descricao: 'o complete deixa de conferir que o state é desta pessoa, Organization e Store',
    de: "    if (salvo.userId !== req.auth.userId || salvo.organizationId !== orgDoContexto() || !salvo.dados || salvo.dados.storeId !== storeDoContexto()) {",
    para: '    if (false) { // VIOLAÇÃO DELIBERADA (negative control) — "state válido basta"',
  },
  {
    classe: 'whatsapp/es-sem-posse-do-recurso',
    invariant: 'WAES-04',
    teste: 'whatsapp-embedded-signup.test.js',
    arquivo: 'server.js',
    descricao: 'a WABA e o número deixam de ter uma Organization dona: outra Organization os conecta por cima',
    de: "      await integracoes.reivindicarRecurso('whatsapp', tipo, id);",
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — sem reivindicar o recurso',
  },
  {
    classe: 'whatsapp/es-deixa-claim-orfao',
    invariant: 'WAES-05',
    teste: 'whatsapp-embedded-signup.test.js',
    arquivo: 'server.js',
    descricao: 'uma falha no meio do onboarding deixa a WABA/número reivindicados, sem conexão gravada',
    de: "      await integracoes.liberarRecursos('whatsapp', tipo, id).catch(() => {});",
    para: '      // VIOLAÇÃO DELIBERADA (negative control) — não devolve o que reivindicou',
  },
  {
    classe: 'whatsapp/contexto-sem-store',
    invariant: 'WAES-06',
    teste: 'whatsapp-embedded-signup.test.js',
    arquivo: 'lib/platform/whatsapp-sender.js',
    descricao: 'o contexto que o serviço do webhook recebe perde o store_id (o evento não sabe a qual Store pertence)',
    de: '    store_id: remetente.storeId,',
    para: '    store_id: null, // VIOLAÇÃO DELIBERADA (negative control)',
  },
  {
    classe: 'whatsapp/es-origem-frouxa',
    invariant: 'WAES-07',
    teste: 'whatsapp-es-mensagem.test.js',
    arquivo: 'src/pages/integracoes/embeddedSignup.ts',
    descricao: 'a mensagem do Embedded Signup passa a valer para qualquer host que TERMINE em facebook.com',
    de: "    return new URL(origem).protocol === 'https:' && (host === 'facebook.com' || host.endsWith('.facebook.com'));",
    para: "    return host.endsWith('facebook.com'); // VIOLAÇÃO DELIBERADA (negative control)",
  },
];

// ── Execução ───────────────────────────────────────────────────────────────────────────────────

function copiarLib(destino) {
  fs.cpSync(path.join(RAIZ_REPO, 'lib'), path.join(destino, 'lib'), { recursive: true });
  // Fase 3: os controles de rota e do Creative Core também violam server.js e routes/.
  fs.cpSync(path.join(RAIZ_REPO, 'routes'), path.join(destino, 'routes'), { recursive: true });
  fs.copyFileSync(path.join(RAIZ_REPO, 'server.js'), path.join(destino, 'server.js'));
  // Rodada de dogfooding: o controle do Dashboard viola o front (escopoLoja.ts) e roda o teste dele.
  fs.cpSync(path.join(RAIZ_REPO, 'src', 'pages', 'dashboard'), path.join(destino, 'src', 'pages', 'dashboard'), { recursive: true });
  // WhatsApp · Embedded Signup: o controle da origem da mensagem viola o helper do front.
  fs.cpSync(path.join(RAIZ_REPO, 'src', 'pages', 'integracoes'), path.join(destino, 'src', 'pages', 'integracoes'), { recursive: true });
  // A cópia precisa resolver as mesmas dependências (express, pg) que o lib/ real.
  fs.symlinkSync(path.join(RAIZ_REPO, 'node_modules'), path.join(destino, 'node_modules'), 'dir');
}

// Roda um arquivo de invariant contra uma raiz de sujeito. Devolve { ok, saida }.
function rodarInvariant(arquivoDeTeste, raizDoSujeito) {
  // `NODE_TEST_CONTEXT` precisa sair do ambiente do filho. O runner do Node o injeta em qualquer
  // processo filho e, ao vê-lo, o filho decide que já está DENTRO de uma execução de teste e
  // "skipping running files" — sai com status 0 sem rodar nada. Um negative control que roda zero
  // testes e lê o 0 como sucesso é exatamente o silêncio que este arquivo existe para impedir;
  // por isso `assertRodouDeVerdade` confere a contagem abaixo, e não só o exit code.
  const env = { ...process.env, INVARIANT_SUBJECT_ROOT: raizDoSujeito };
  delete env.NODE_TEST_CONTEXT;

  const r = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', path.join(__dirname, arquivoDeTeste)],
    { cwd: RAIZ_REPO, encoding: 'utf8', env, timeout: 120000 }
  );
  const saida = `${r.stdout || ''}${r.stderr || ''}`;
  const executados = Number((saida.match(/^# tests (\d+)$/m) || [])[1] || 0);
  return { ok: r.status === 0, saida, executados };
}

// Nenhum passo do ciclo vale se o processo filho não executou teste nenhum.
function assertRodouDeVerdade(passo, resultado, invariant) {
  assert.ok(
    resultado.executados > 0,
    `[${passo}] o processo de ${invariant} não executou nenhum teste — o resultado não significa ` +
    `nada.\n${resultado.saida}`
  );
}

function aplicarViolacao(raiz, violacao) {
  const alvo = path.join(raiz, violacao.arquivo);
  const original = fs.readFileSync(alvo, 'utf8');
  const ocorrencias = original.split(violacao.de).length - 1;
  assert.equal(
    ocorrencias, 1,
    `o trecho a substituir em ${violacao.arquivo} apareceu ${ocorrencias}x — a violação não ` +
    'pôde ser aplicada, e um negative control que não aplica nada passaria de graça'
  );
  fs.writeFileSync(alvo, original.replace(violacao.de, violacao.para));
  return () => fs.writeFileSync(alvo, original);
}

for (const v of VIOLACOES) {
  test(`negative control · ${v.classe} · ${v.invariant} · ciclo de 5 passos`, { timeout: 180000 }, (t) => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), `oria-nc-${v.invariant}-`));
    t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
    copiarLib(raiz);

    // Passo 1 — passa no estado correto (a cópia intacta).
    const passo1 = rodarInvariant(v.teste, raiz);
    assertRodouDeVerdade(1, passo1, v.invariant);
    assert.ok(passo1.ok, `[1] ${v.invariant} reprovou no estado CORRETO:\n${passo1.saida}`);

    // Passo 2 — introduz a violação.
    const desfazer = aplicarViolacao(raiz, v);

    // Passo 3 — o MESMO invariant falha.
    const passo3 = rodarInvariant(v.teste, raiz);
    assertRodouDeVerdade(3, passo3, v.invariant);
    assert.equal(
      passo3.ok, false,
      `[3] ${v.invariant} PASSOU com a violação aplicada (${v.descricao}).\n` +
      'Este invariant não detecta o defeito que existe para detectar — ele está escrito para ' +
      `passar, não para medir.\n${passo3.saida}`
    );

    // Passo 4 — remove a violação.
    desfazer();

    // Passo 5 — volta a passar. Prova que a reprovação veio do defeito, não de dano colateral
    // da manipulação de arquivos.
    const passo5 = rodarInvariant(v.teste, raiz);
    assertRodouDeVerdade(5, passo5, v.invariant);
    assert.ok(passo5.ok, `[5] ${v.invariant} não voltou a passar após remover a violação:\n${passo5.saida}`);
    assert.equal(passo5.executados, passo1.executados, '[5] o conjunto de testes executados mudou');

    console.log(`  ✔ ${v.classe.padEnd(18)} ${v.invariant}  passa → viola → FALHA → restaura → passa`);
  });
}

test('negative control · cobre as classes críticas das Fases 0 a 5c e da construção da Fase 7', () => {
  assert.deepEqual(
    [...new Set(VIOLACOES.map((v) => v.classe))].sort(),
    ['audit/sujeito', 'auth', 'auth/csrf', 'auth/fixation', 'auth/login-tenant', 'auth/revogacao',
      'connector/chamador-exige-loja-legada', 'connector/leitura-por-loja',
      'connector/save-sem-atomicidade', 'connector/store-nativa-no-path-legado',
      'convite/conta-existente-troca-senha', 'convite/grant-da-role', 'convite/motivo-vazado',
      'convite/sessao-de-outro-email',
      'creative/dual-read-confinamento', 'creative/dual-read-organization',
      'creative/tenant-env', 'dashboard/escopo-loja-nula', 'dashboard/midia-zero-sem-conta', 'dre/customer-de-outra-org', 'dre/loja-atribuida-padrao', 'dre/sem-loja',
      'entitlement', 'entitlement/app-config-como-fonte', 'entitlement/ausencia', 'fase6/bypass-interno', 'financeiro/despesas-exige-loja-legada', 'ga4/cache-sem-store-id', 'ga4/connect-exige-loja-legada',
      'ga4/oauth-aceita-store-arbitraria', 'http/async-sem-rede', 'http/erro-vaza-stack', 'ink/catalogo-sem-store-id', 'ink/catalogo-status-exige-loja-legada', 'ink/categorias-exige-loja-legada',
      'ink/feed-descontinuado-vira-erro', 'ink/job-catalogo-so-legado', 'ink/lote-sem-store-id', 'ink/webhook-exige-loja-legada', 'integracoes/desconectar-cruzado', 'integracoes/env-global',
      'integracoes/resolver-global', 'integracoes/token-de-outra-org', 'jobs/contexto', 'jobs/lease-ignorado', 'meta/conexao-com-problema-vira-saudavel', 'meta/oauth-aceita-store-arbitraria',
      'midia/atribuicao-canonica-ausente', 'midia/conta-de-outra-organization',
      'midia/select-exige-loja-legada', 'midia/store-nativa-no-ramo-legado', 'oauth/org-do-navegador',
      'onboarding/chave-sem-pedido', 'onboarding/erro-bruto', 'onboarding/gate', 'onboarding/ja-existe-uma', 'onboarding/segunda-fonte',
      'recuperacao/escopo', 'secrets', 'secrets/log', 'secrets/resposta', 'store-nativa/clientes-exige-loja-legada', 'store-nativa/financeiro-exige-loja-legada',
      'store-nativa/lucro-produtos-join-por-loja', 'tenancy/agregacao-lojas',
      'tenancy/candidato-unico', 'tenancy/loja-do-request', 'tenancy/mapping', 'tenancy/ownership',
      'tenancy/ownership-id', 'tenancy/rls-context', 'utm/exige-loja-legada', 'webhook', 'webhook/ink-segredo-de-outra-org', 'webhook/ink-segredo-do-ambiente',
      'whatsapp/entrada-divergente', 'whatsapp/entrada-org-do-corpo', 'whatsapp/health-como-remetente', 'whatsapp/par-cruzado', 'whatsapp/ref-forjada', 'whatsapp/remetente-global',
      'whatsapp/repasse-boot-inferido', 'whatsapp/repasse-boot-so-avisa',
      'whatsapp/repasse-rota-legada', 'whatsapp/repasse-segredo-na-query', 'whatsapp/repasse-sem-segredo',
      'whatsapp/token-serializavel', 'whatsapp/tolerancia-compara-query', 'whatsapp/tolerancia-sem-assinatura',
      'whatsapp/tolerancia-sem-flag']
  );
});

test('negative control · o repositório nunca é modificado pelo ciclo', () => {
  // Cinturão e suspensório: se alguma violação vazasse para o `lib/` real, ela estaria aqui.
  for (const v of VIOLACOES) {
    const conteudo = fs.readFileSync(path.join(RAIZ_REPO, v.arquivo), 'utf8');
    assert.ok(
      !conteudo.includes('VIOLAÇÃO DELIBERADA'),
      `${v.arquivo} contém uma violação de negative control — ela vazou para o repositório`
    );
  }
});
