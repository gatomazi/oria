'use strict';

// Rotas do control plane (§23). Prefixo único: `/api/platform`.
//
// Nada aqui toca `/api/admin/*` nem a sessão do painel. Um token de tenant não vale (tabelas
// diferentes), e o cookie tem outro nome.
//
// Pipeline de toda rota autenticada, nesta ordem:
//
//     cookie host-only → sessão no banco (válida, não revogada, não expirada, admin ativo)
//       → Origin == PLATFORM_ADMIN_URL (se o método não é seguro)
//       → CSRF (se o método não é seguro)
//       → papel exigido pela rota
//       → :organizationId da ROTA como alvo (o corpo nunca decide)
//       → serviço → auditoria na mesma transação

const path = require('path');
const fs = require('fs');
const http = require('./http');
const { CSRF_HEADER, METODOS_SEGUROS, cookieDeSessao, cookieApagado, tokenDoRequest } = require('./sessions');
const { PAPEIS } = require('./admins');
const { VALIDADE_PADRAO_HORAS, VALIDADE_MAXIMA_HORAS } = require('./organizations');
const { FEATURES } = require('./entitlements');
const { ACOES } = require('./audit');
const { origemPermitida, resolverRetorno } = require('./urls');

const TIPOS_ESTATICOS = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
});

function criarApp({ config, pool, sessoes, admins, planos, organizations, readModels }) {
  const router = http.criarRouter();

  // ── Helpers de rota ────────────────────────────────────────────────────────────────────────

  const ator = (req) => ({ adminId: req.auth.adminId, email: req.auth.email });

  function exigirPapel(req, papel) {
    if (req.auth.papel !== papel) {
      throw new http.HttpError(403, 'papel_insuficiente', `esta ação exige o papel ${papel}`);
    }
  }

  // O alvo é SEMPRE o parâmetro da rota. Esta é a única função que produz um organizationId de
  // trabalho, e ela só olha `params`.
  const alvo = (params) => http.uuid(params.organizationId, 'organizationId');

  function listar({ itens, proximoCursor }, mapear) {
    return { itens: itens.map(mapear), proximoCursor };
  }

  function cursorDaQuery(query) {
    return http.decodificarCursor(query.get('cursor'));
  }

  // ── Health (público) ───────────────────────────────────────────────────────────────────────
  // Sem versão, sem host, sem estado do banco, sem contagem.
  router.get('/health', async (req, res) => http.responderJson(res, 200, { status: 'ok' }), { publico: true });

  // ── Auth ───────────────────────────────────────────────────────────────────────────────────
  router.post('/api/platform/auth/login', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['email', 'senha', 'manterOutrasSessoes', 'returnUrl']);
    const email = http.email(corpo.email);
    const senha = typeof corpo.senha === 'string' ? corpo.senha : '';
    const { sessao, admin } = await admins.login({
      email,
      senha,
      manterOutrasSessoes: http.booleano(corpo.manterOutrasSessoes, 'manterOutrasSessoes', { padrao: false }),
    });
    // Open redirect (§23, §38): `returnUrl` só pode ser um caminho LOCAL. Host externo,
    // `//evil.example` e `javascript:` viram o destino padrão, não erro — o login não falha por
    // causa de um parâmetro de navegação, mas também não obedece a ele.
    const destino = resolverRetorno(corpo.returnUrl) || '/';
    http.responderJson(res, 200, {
      admin,
      csrfToken: sessao.csrfToken,
      expiraEm: sessao.expiraEm,
      // Absoluto quando há URL canônica configurada; relativo em desenvolvimento.
      destino: config.urls.platformAdmin ? config.urls.platformAdmin.link(destino) : destino,
    }, {
      'Set-Cookie': cookieDeSessao({ producao: config.producao, token: sessao.token, expiraEm: sessao.expiraEm }),
    });
  }, { publico: true });

  router.post('/api/platform/auth/logout', async (req, res) => {
    await admins.logout(req.auth);
    http.responderJson(res, 204, undefined, { 'Set-Cookie': cookieApagado({ producao: config.producao }) });
  });

  router.get('/api/platform/auth/session', async (req, res) => {
    http.responderJson(res, 200, {
      admin: { id: req.auth.adminId, email: req.auth.email, nome: req.auth.nome, papel: req.auth.papel },
      csrfToken: req.auth.csrfToken,
      expiraEm: req.auth.expiraEm,
    });
  });

  // ── Visão geral ────────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/overview', async (req, res) => {
    const [o, convites, admins_, planos_] = await Promise.all([
      readModels.overview(),
      pool.query(
        `SELECT count(*) FILTER (WHERE usado_em IS NULL AND revogado_em IS NULL AND expira_em > now())::int AS pendentes,
                count(*) FILTER (WHERE usado_em IS NULL AND revogado_em IS NULL AND expira_em <= now())::int AS expirados
           FROM organization_owner_invites`
      ),
      pool.query(`SELECT count(*)::int AS ativos FROM platform_admins WHERE status = 'active'`),
      pool.query(`SELECT count(*)::int AS ativos FROM plans WHERE status = 'active'`),
    ]);
    http.responderJson(res, 200, {
      organizations: { total: o.organizations_total, ativas: o.organizations_ativas, suspensas: o.organizations_suspensas },
      onboardings: {
        emAndamento: o.onboardings_em_andamento,
        bloqueados: o.onboardings_bloqueados,
        concluidos: o.onboardings_concluidos,
      },
      convites: { pendentes: convites.rows[0].pendentes, expirados: convites.rows[0].expirados },
      integracoes: {
        conectadas: o.integracoes_conectadas,
        erro: o.integracoes_erro,
        desconectadas: o.integracoes_desconectadas,
      },
      planos: { ativos: planos_.rows[0].ativos },
      admins: { ativos: admins_.rows[0].ativos },
      // O bootstrap interno só existe enquanto não há Organization nenhuma.
      bootstrapInternoDisponivel: o.organizations_total === 0,
      secondTenantEnabled: config.criacaoExternaHabilitada,
    });
  });

  // ── Platform admins ────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/admins', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const { rows, paraApi } = await admins.listar({ limite, cursor: cursorDaQuery(req.query) });
    const pagina = paginarLocal(rows, limite, (r) => ({ em: r.criado_em, id: r.id }));
    http.responderJson(res, 200, listar(pagina, paraApi));
  });

  router.post('/api/platform/admins', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    const corpo = http.exigirCampos(await http.lerJson(req), ['email', 'nome', 'senha', 'papel']);
    const novo = await admins.criar({
      ator: ator(req),
      email: http.email(corpo.email),
      nome: http.texto(corpo.nome, 'nome', { obrigatorio: false, maximo: 200 }),
      senha: typeof corpo.senha === 'string' ? corpo.senha : '',
      papel: http.umDe(corpo.papel, 'papel', PAPEIS, { padrao: 'platform_operator' }),
    });
    http.responderJson(res, 201, novo, { Location: `/api/platform/admins/${novo.id}` });
  });

  router.post('/api/platform/admins/:adminId/deactivate', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    http.exigirCampos(await http.lerJson(req), []);
    http.responderJson(res, 200, await admins.mudarStatus({
      ator: ator(req), adminId: http.uuid(req.params.adminId), destino: 'disabled',
    }));
  });

  router.post('/api/platform/admins/:adminId/reactivate', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    http.exigirCampos(await http.lerJson(req), []);
    http.responderJson(res, 200, await admins.mudarStatus({
      ator: ator(req), adminId: http.uuid(req.params.adminId), destino: 'active',
    }));
  });

  router.post('/api/platform/admins/:adminId/role', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    const corpo = http.exigirCampos(await http.lerJson(req), ['papel']);
    http.responderJson(res, 200, await admins.mudarPapel({
      ator: ator(req),
      adminId: http.uuid(req.params.adminId),
      papel: http.umDe(corpo.papel, 'papel', PAPEIS),
    }));
  });

  // ── Planos ─────────────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/plans', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const { rows, paraApi } = await planos.listar({ limite, cursor: cursorDaQuery(req.query) });
    const pagina = paginarLocal(rows, limite, (r) => ({ em: r.criado_em, id: r.id }));
    http.responderJson(res, 200, listar(pagina, paraApi));
  });

  router.post('/api/platform/plans', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    const corpo = http.exigirCampos(await http.lerJson(req), ['chave', 'nome', 'descricao', 'features']);
    const plano = await planos.criar({
      ator: ator(req),
      chave: http.texto(corpo.chave, 'chave', { maximo: 63 }),
      nome: http.texto(corpo.nome, 'nome', { maximo: 200 }),
      descricao: http.texto(corpo.descricao, 'descricao', { obrigatorio: false, maximo: 1000 }),
      features: listaDeFeatures(corpo.features),
    });
    http.responderJson(res, 201, plano, { Location: `/api/platform/plans/${plano.id}` });
  });

  router.get('/api/platform/plans/:planId', async (req, res) => {
    const plano = await planos.buscar(http.uuid(req.params.planId));
    if (!plano) throw http.erro404();
    http.responderJson(res, 200, plano);
  });

  router.patch('/api/platform/plans/:planId', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    const corpo = http.exigirCampos(await http.lerJson(req), ['nome', 'descricao']);
    http.responderJson(res, 200, await planos.atualizar({
      ator: ator(req),
      planId: http.uuid(req.params.planId),
      nome: http.texto(corpo.nome, 'nome', { obrigatorio: false, maximo: 200 }),
      descricao: http.texto(corpo.descricao, 'descricao', { obrigatorio: false, maximo: 1000 }),
    }));
  });

  router.put('/api/platform/plans/:planId/features', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    const corpo = http.exigirCampos(await http.lerJson(req), ['features']);
    http.responderJson(res, 200, await planos.substituirFeatures({
      ator: ator(req),
      planId: http.uuid(req.params.planId),
      features: listaDeFeatures(corpo.features),
    }));
  });

  router.post('/api/platform/plans/:planId/archive', async (req, res) => {
    exigirPapel(req, 'platform_owner');
    http.exigirCampos(await http.lerJson(req), []);
    http.responderJson(res, 200, await planos.arquivar({ ator: ator(req), planId: http.uuid(req.params.planId) }));
  });

  // ── Organizations ──────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/organizations', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const busca = req.query.get('q');
    if (busca !== null && busca.trim().length < 2) {
      throw http.erro400('q_invalido', 'a busca precisa de ao menos 2 caracteres');
    }
    const pagina = await readModels.organizations({
      status: http.umDe(req.query.get('status'), 'status', ['active', 'suspended'], { padrao: null }),
      busca: busca ? busca.trim() : null,
      limite,
      cursor: cursorDaQuery(req.query),
    });
    http.responderJson(res, 200, listar(pagina, (r) => ({
      id: r.id,
      nome: r.nome,
      status: r.status,
      criadoEm: r.criado_em,
      store: r.store_id ? { id: r.store_id, nome: r.store_nome } : null,
      plano: r.plano_chave ? { chave: r.plano_chave, nome: r.plano_nome } : null,
      ownersAtivos: r.owners_ativos,
      onboarding: r.onboarding_status ? { status: r.onboarding_status, currentStep: r.onboarding_step } : null,
    })));
  });

  router.post('/api/platform/organizations', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), [
      'nome', 'store', 'planoChave', 'ownerEmail', 'idempotencyKey', 'bootstrapInterno',
      'conviteValidadeHoras', 'passos',
    ]);
    if (corpo.store !== undefined && (corpo.store === null || typeof corpo.store !== 'object' || Array.isArray(corpo.store))) {
      throw http.erro400('store_invalido', 'store precisa ser um objeto { nome }');
    }
    http.exigirCampos(corpo.store || {}, ['nome']);

    const resultado = await organizations.criar({
      ator: ator(req),
      nome: http.texto(corpo.nome, 'nome', { maximo: 200 }),
      storeNome: http.texto(corpo.store && corpo.store.nome, 'store.nome', { maximo: 200 }),
      planoChave: http.texto(corpo.planoChave, 'planoChave', { maximo: 63 }),
      ownerEmail: http.email(corpo.ownerEmail, 'ownerEmail'),
      idempotencyKey: typeof corpo.idempotencyKey === 'string' ? corpo.idempotencyKey : '',
      bootstrapInterno: http.booleano(corpo.bootstrapInterno, 'bootstrapInterno', { padrao: false }),
      conviteValidadeHoras: http.inteiro(corpo.conviteValidadeHoras, 'conviteValidadeHoras', {
        padrao: VALIDADE_PADRAO_HORAS, minimo: 1, maximo: VALIDADE_MAXIMA_HORAS,
      }),
      passos: corpo.passos,
    });
    http.responderJson(res, resultado.criada ? 201 : 200, resultado,
      resultado.criada ? { Location: `/api/platform/organizations/${resultado.organization.id}` } : {});
  });

  router.get('/api/platform/organizations/:organizationId', async (req, res) => {
    http.responderJson(res, 200, await organizations.detalhe(alvo(req.params)));
  });

  router.post('/api/platform/organizations/:organizationId/suspend', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['motivo']);
    http.responderJson(res, 200, await organizations.mudarStatus({
      ator: ator(req),
      organizationId: alvo(req.params),
      destino: 'suspended',
      motivo: http.texto(corpo.motivo, 'motivo', { minimo: 4, maximo: 500 }),
    }));
  });

  router.post('/api/platform/organizations/:organizationId/reactivate', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['motivo']);
    http.responderJson(res, 200, await organizations.mudarStatus({
      ator: ator(req),
      organizationId: alvo(req.params),
      destino: 'active',
      motivo: http.texto(corpo.motivo, 'motivo', { obrigatorio: false, minimo: 4, maximo: 500 }),
    }));
  });

  router.get('/api/platform/organizations/:organizationId/subscription', async (req, res) => {
    const organizationId = alvo(req.params);
    const resolucao = await organizations.resolucaoDe(organizationId);
    http.responderJson(res, 200, {
      subscription: resolucao.assinatura
        ? { id: resolucao.assinatura.id, status: resolucao.assinatura.status, iniciadaEm: resolucao.assinatura.iniciada_em }
        : null,
      plano: resolucao.plano,
      historico: await organizations.historicoDeAssinaturas(organizationId),
    });
  });

  router.put('/api/platform/organizations/:organizationId/subscription', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['planoChave', 'motivo']);
    const { resolucao } = await organizations.trocarPlano({
      ator: ator(req),
      organizationId: alvo(req.params),
      planoChave: http.texto(corpo.planoChave, 'planoChave', { maximo: 63 }),
      motivo: http.texto(corpo.motivo, 'motivo', { obrigatorio: false, maximo: 500 }),
    });
    http.responderJson(res, 200, {
      subscription: resolucao.assinatura
        ? { id: resolucao.assinatura.id, status: resolucao.assinatura.status, iniciadaEm: resolucao.assinatura.iniciada_em }
        : null,
      plano: resolucao.plano,
      entitlements: { efetivos: resolucao.efetivos, origem: resolucao.origem },
    });
  });

  router.get('/api/platform/organizations/:organizationId/entitlements', async (req, res) => {
    const resolucao = await organizations.resolucaoDe(alvo(req.params));
    http.responderJson(res, 200, {
      efetivos: resolucao.efetivos,
      origem: resolucao.origem,
      overrides: resolucao.overrides,
      plano: resolucao.plano,
    });
  });

  router.put('/api/platform/organizations/:organizationId/entitlements/:feature', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['permitido', 'motivo']);
    const resolucao = await organizations.definirOverride({
      ator: ator(req),
      organizationId: alvo(req.params),
      feature: req.params.feature,
      permitido: http.booleano(corpo.permitido, 'permitido'),
      motivo: http.texto(corpo.motivo, 'motivo', { obrigatorio: false, maximo: 500 }),
    });
    http.responderJson(res, 200, {
      efetivos: resolucao.efetivos, origem: resolucao.origem, overrides: resolucao.overrides,
    });
  });

  router.delete('/api/platform/organizations/:organizationId/entitlements/:feature', async (req, res) => {
    const resolucao = await organizations.removerOverride({
      ator: ator(req),
      organizationId: alvo(req.params),
      feature: req.params.feature,
    });
    http.responderJson(res, 200, {
      efetivos: resolucao.efetivos, origem: resolucao.origem, overrides: resolucao.overrides,
    });
  });

  router.get('/api/platform/organizations/:organizationId/invites', async (req, res) => {
    const organizationId = alvo(req.params);
    const resumo = await readModels.organizationResumo(organizationId);
    if (!resumo) throw http.erro404();
    http.responderJson(res, 200, { itens: await organizations.listarConvites(organizationId) });
  });

  router.post('/api/platform/organizations/:organizationId/invites', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['email', 'papel', 'validadeHoras']);
    const convite = await organizations.emitirConvite({
      ator: ator(req),
      organizationId: alvo(req.params),
      email: http.email(corpo.email),
      papel: http.umDe(corpo.papel, 'papel', ['owner', 'member'], { padrao: 'owner' }),
      validadeHoras: http.inteiro(corpo.validadeHoras, 'validadeHoras', {
        padrao: VALIDADE_PADRAO_HORAS, minimo: 1, maximo: VALIDADE_MAXIMA_HORAS,
      }),
    });
    http.responderJson(res, 201, convite);
  });

  router.post('/api/platform/organizations/:organizationId/invites/:inviteId/reissue', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['validadeHoras']);
    http.responderJson(res, 200, await organizations.reemitirConvite({
      ator: ator(req),
      organizationId: alvo(req.params),
      inviteId: http.uuid(req.params.inviteId),
      validadeHoras: http.inteiro(corpo.validadeHoras, 'validadeHoras', {
        padrao: VALIDADE_PADRAO_HORAS, minimo: 1, maximo: VALIDADE_MAXIMA_HORAS,
      }),
    }));
  });

  router.post('/api/platform/organizations/:organizationId/invites/:inviteId/revoke', async (req, res) => {
    const corpo = http.exigirCampos(await http.lerJson(req), ['motivo']);
    http.responderJson(res, 200, await organizations.revogarConvite({
      ator: ator(req),
      organizationId: alvo(req.params),
      inviteId: http.uuid(req.params.inviteId),
      motivo: http.texto(corpo.motivo, 'motivo', { obrigatorio: false, maximo: 500 }),
    }));
  });

  router.get('/api/platform/organizations/:organizationId/members', async (req, res) => {
    const organizationId = alvo(req.params);
    const resumo = await readModels.organizationResumo(organizationId);
    if (!resumo) throw http.erro404();
    const membros = await readModels.membros(organizationId);
    http.responderJson(res, 200, { itens: membros.map(organizations.paraMembro) });
  });

  router.delete('/api/platform/organizations/:organizationId/members/:userId', async (req, res) => {
    await organizations.removerMembro({
      ator: ator(req),
      organizationId: alvo(req.params),
      userId: http.uuid(req.params.userId),
    });
    http.responderJson(res, 204, undefined);
  });

  router.get('/api/platform/organizations/:organizationId/onboarding', async (req, res) => {
    const organizationId = alvo(req.params);
    const detalhe = await organizations.detalhe(organizationId);
    if (!detalhe.onboarding) throw http.erro404();
    http.responderJson(res, 200, { organizationId, ...detalhe.onboarding });
  });

  router.get('/api/platform/organizations/:organizationId/integrations', async (req, res) => {
    const organizationId = alvo(req.params);
    const resumo = await readModels.organizationResumo(organizationId);
    if (!resumo) throw http.erro404();
    const limite = http.lerLimite(req.query);
    const pagina = await readModels.integracoes({ organizationId, limite, cursor: cursorDaQuery(req.query) });
    http.responderJson(res, 200, listar(pagina, organizations.paraIntegracao));
  });

  // ── Usuários ───────────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/users', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const busca = req.query.get('q');
    if (busca !== null && busca.trim().length < 2) {
      throw http.erro400('q_invalido', 'a busca precisa de ao menos 2 caracteres');
    }
    const pagina = await readModels.users({
      busca: busca ? busca.trim() : null,
      status: http.umDe(req.query.get('status'), 'status', ['active', 'disabled'], { padrao: null }),
      limite,
      cursor: cursorDaQuery(req.query),
    });
    http.responderJson(res, 200, listar(pagina, (u) => ({
      id: u.id,
      email: u.email,
      nome: u.nome,
      status: u.status,
      criadoEm: u.criado_em,
      ultimoLoginEm: u.ultimo_login_em,
      organizations: u.organizations,
    })));
  });

  // ── Onboardings ────────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/onboardings', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const pagina = await readModels.onboardings({
      status: http.umDe(req.query.get('status'), 'status',
        ['not_started', 'in_progress', 'blocked', 'complete'], { padrao: null }),
      limite,
      cursor: cursorDaQuery(req.query),
    });
    http.responderJson(res, 200, listar(pagina, (o) => ({
      organizationId: o.organization_id,
      organizationNome: o.organization_nome,
      status: o.status,
      currentStep: o.current_step,
      completedSteps: o.completed_steps,
      blockedStep: o.blocked_step,
      lastErrorCode: o.last_error_code,
      atualizadoEm: o.atualizado_em,
    })));
  });

  // ── Integrações (global) ───────────────────────────────────────────────────────────────────
  router.get('/api/platform/integrations', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const pagina = await readModels.integracoes({
      provider: req.query.get('provider'),
      status: http.umDe(req.query.get('status'), 'status', ['connected', 'disconnected', 'error'], { padrao: null }),
      limite,
      cursor: cursorDaQuery(req.query),
    });
    http.responderJson(res, 200, listar(pagina, organizations.paraIntegracao));
  });

  // ── Jobs e webhooks ────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/jobs', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const org = req.query.get('organizationId');
    const pagina = await readModels.jobs({
      organizationId: org ? http.uuid(org) : null,
      limite,
      cursor: cursorDaQuery(req.query),
    });
    http.responderJson(res, 200, listar(pagina, (j) => ({
      job: j.job,
      organizationId: j.organization_id,
      organizationNome: j.organization_nome,
      ocupado: j.ocupado,
      iniciadoEm: j.iniciado_em,
      ate: j.ate,
      proximaEm: j.proxima_em,
    })));
  });

  router.get('/api/platform/webhooks', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const org = req.query.get('organizationId');
    const verificado = req.query.get('verificado');
    const pagina = await readModels.webhooks({
      organizationId: org ? http.uuid(org) : null,
      verificado: verificado === null ? null : verificado === 'true',
      limite,
      cursor: cursorDaQuery(req.query),
    });
    // `headers` e `body` não existem nesta projeção — nem aqui, nem no read model.
    http.responderJson(res, 200, listar(pagina, (w) => ({
      id: String(w.id),
      recebidoEm: w.recebido_em,
      verificado: w.verificado,
      metodoAuth: w.metodo_auth,
      eventName: w.event_name,
      organizationId: w.organization_id,
      organizationNome: w.organization_nome,
    })));
  });

  // ── Auditoria ──────────────────────────────────────────────────────────────────────────────
  router.get('/api/platform/audit', async (req, res) => {
    const limite = http.lerLimite(req.query);
    const cursor = cursorDaQuery(req.query);
    const org = req.query.get('organizationId');
    const action = req.query.get('action');
    if (action !== null && !ACOES.includes(action)) {
      throw http.erro422('action_desconhecida', 'ação fora do vocabulário de auditoria');
    }
    const actor = req.query.get('actorAdminId');
    const { rows } = await pool.query(
      `SELECT a.id, a.criado_em, a.actor_admin_id, a.actor_email, a.action, a.entity_type, a.entity_id,
              a.organization_id, a.before, a.after,
              (SELECT nome FROM platform_organization_resumo(a.organization_id)) AS organization_nome
         FROM platform_audit_logs a
        WHERE ($1::uuid IS NULL OR a.organization_id = $1)
          AND ($2::text IS NULL OR a.action = $2)
          AND ($3::uuid IS NULL OR a.actor_admin_id = $3)
          AND ($4::timestamptz IS NULL OR (a.criado_em, a.id) < ($4, $5))
        ORDER BY a.criado_em DESC, a.id DESC
        LIMIT $6`,
      [org ? http.uuid(org) : null, action, actor ? http.uuid(actor) : null,
        cursor ? cursor.em : null, cursor ? cursor.id : null, limite + 1]
    );
    const pagina = paginarLocal(rows, limite, (r) => ({ em: r.criado_em, id: String(r.id) }));
    http.responderJson(res, 200, listar(pagina, (r) => ({
      id: String(r.id),
      criadoEm: r.criado_em,
      actor: { adminId: r.actor_admin_id, email: r.actor_email },
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      organizationId: r.organization_id,
      organizationNome: r.organization_nome,
      before: r.before,
      after: r.after,
    })));
  });

  // ── Despacho ───────────────────────────────────────────────────────────────────────────────

  // Origem de mutação (§21, §37 do ajuste de domínios). Vale inclusive para rota pública: o login
  // é uma mutação, e é justamente a que não pode ser disparada do host do painel nem da landing.
  function exigirOrigemLegitima(req) {
    if (METODOS_SEGUROS.has(req.method)) return;
    const veredito = origemPermitida(req.headers.origin, {
      canonica: config.urls.platformAdmin,
      producao: config.producao,
    });
    if (!veredito.ok) {
      throw new http.HttpError(403, 'origem_nao_permitida',
        'esta origem não pode alterar o control plane');
    }
  }

  async function autenticar(req, res, rota) {
    let auth;
    try {
      auth = await sessoes.buscar(tokenDoRequest(req, config.producao));
    } catch (err) {
      // Store fora do ar: fail-closed, nunca "deixa passar".
      console.error(`[AUTH] falha ao validar sessão: ${err.message}`);
      throw new http.HttpError(503, 'autenticacao_indisponivel', 'autenticação indisponível');
    }
    if (!auth) throw new http.HttpError(401, 'nao_autenticado', 'não autenticado');

    if (!METODOS_SEGUROS.has(req.method)) {
      if (!sessoes.csrfConfere(auth.sessaoId, req.headers[CSRF_HEADER])) {
        throw new http.HttpError(403, 'csrf', 'token CSRF ausente ou inválido');
      }
    }
    req.auth = Object.freeze(auth);
    void rota;
  }

  async function tratar(req, res) {
    const url = new URL(req.url, 'http://interno');
    req.query = url.searchParams;
    const casado = router.casar(req.method, url.pathname);

    if (!casado) {
      if (url.pathname.startsWith('/api/')) {
        if (router.existeOutroMetodo(url.pathname)) {
          return http.responderErro(res, new http.HttpError(405, 'metodo_nao_permitido', 'método não permitido'));
        }
        return http.responderErro(res, http.erro404());
      }
      return servirEstatico(req, res, url.pathname);
    }

    req.params = casado.params;
    exigirOrigemLegitima(req);
    if (!casado.rota.publico) await autenticar(req, res, casado.rota);
    return casado.rota.handler(req, res);
  }

  // ── Estático (o frontend do Oria Admin) ────────────────────────────────────────────────────
  // O build do frontend cai em `public/`. Sem ele, o app continua servindo /health e a API — o
  // Oria Admin não deixa de subir porque a UI ainda não foi construída.
  const raizEstatica = config.diretorioEstatico
    ? path.resolve(config.diretorioEstatico)
    : path.join(__dirname, '..', 'public');

  function servirEstatico(req, res, caminho) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return http.responderErro(res, new http.HttpError(405, 'metodo_nao_permitido', 'método não permitido'));
    }
    // `path.normalize` + prefixo conferido: nenhum `..` sai da raiz.
    const relativo = path.normalize(caminho).replace(/^(\.\.[/\\])+/, '');
    let arquivo = path.join(raizEstatica, relativo);
    if (!arquivo.startsWith(raizEstatica + path.sep) && arquivo !== raizEstatica) {
      return http.responderErro(res, http.erro404());
    }
    if (!fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
      // SPA: qualquer rota de UI cai no index.
      arquivo = path.join(raizEstatica, 'index.html');
    }
    if (!fs.existsSync(arquivo)) {
      return http.responderJson(res, 200, {
        status: 'ok',
        mensagem: 'Oria Admin no ar. A interface ainda não foi publicada em public/; a API está em /api/platform.',
      });
    }
    const conteudo = fs.readFileSync(arquivo);
    res.writeHead(200, {
      'Content-Type': TIPOS_ESTATICOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
      'Content-Length': conteudo.length,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': arquivo.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
    });
    return res.end(req.method === 'HEAD' ? undefined : conteudo);
  }

  return async function handler(req, res) {
    try {
      await tratar(req, res);
    } catch (err) {
      http.responderErro(res, err);
    }
  };
}

function paginarLocal(linhas, limite, cursorDe) {
  const tem = linhas.length > limite;
  const itens = tem ? linhas.slice(0, limite) : linhas;
  return {
    itens,
    proximoCursor: tem && itens.length ? http.codificarCursor(cursorDe(itens[itens.length - 1])) : null,
  };
}

function listaDeFeatures(valor) {
  if (!Array.isArray(valor)) throw http.erro400('features_invalido', 'features precisa ser uma lista');
  if (valor.some((f) => typeof f !== 'string')) throw http.erro400('features_invalido', 'features precisa conter textos');
  if (valor.length > FEATURES.length) throw http.erro400('features_invalido', 'features com itens demais');
  return valor;
}

module.exports = { criarApp };
