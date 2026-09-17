'use strict';

// Rotas de identidade da Fase 2: login individual, sessão, logout, revogação e gestão mínima de
// membros (owner/member). Nenhuma rota aqui aceita Organization, Store, loja ou papel vindos do
// cliente para decidir QUEM é o usuário ou O QUE ele pode. O `:organizationId` das rotas de membros
// identifica o RECURSO a gerir, e é conferido contra os memberships do usuário no banco (TD-001,
// ponto 7) — não vira contexto de tenant (Fase 3).

const crypto = require('crypto');
const express = require('express');

const senhas = require('./password');
const {
  resolverOrganizacaoAtiva, selecionarOrganizacao, resolverStore, TenantContextHttpError,
} = require('../platform/tenant-pipeline');
const { cookieDeSessao, cookieApagado, tokenDoRequest } = require('./middleware');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSAO_ID_RE = /^[0-9a-f]{64}$/;
const PAPEIS = new Set(['owner', 'member']);
const CAMPOS_LOGIN = new Set(['email', 'password']);

const normalizarEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const emailValido = (v) => /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(v);

function iguaisEmTempoConstante(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb) && String(a).length === String(b).length;
}

function createAuthRouter(deps) {
  const {
    pool, sessoes, requireAuth, carregarSessao, limiter, producao,
    legado = { habilitado: false }, auditar, comOrganization,
  } = deps;
  const router = express.Router();

  async function memberships(userId) {
    const { rows } = await pool.query('SELECT * FROM auth_memberships($1)', [userId]);
    return rows.map((r) => ({ organizationId: r.organization_id, nome: r.organization_nome, papel: r.papel }));
  }

  async function papelEm(userId, organizationId) {
    const m = (await memberships(userId)).find((x) => x.organizationId === organizationId);
    return m ? m.papel : null;
  }

  // Ação global sobre outra pessoa (revogar todas as sessões, desativar) só é permitida se o ator
  // for owner de TODAS as Organizations dela — senão, o owner de A afetaria o acesso da pessoa a B.
  async function podeGerirPessoa(atorId, alvoId) {
    if (atorId === alvoId) return { ok: false, motivo: 'use as rotas da própria conta' };
    const doAlvo = await memberships(alvoId);
    if (!doAlvo.length) return { ok: false, motivo: 'fora das suas organizations' };
    const doAtor = new Map((await memberships(atorId)).map((m) => [m.organizationId, m.papel]));
    const fora = doAlvo.filter((m) => doAtor.get(m.organizationId) !== 'owner');
    if (fora.length) return { ok: false, motivo: 'a pessoa pertence a organizations que você não administra' };
    return { ok: true, organizations: doAlvo.map((m) => m.organizationId) };
  }

  async function exigirOwner(req, res) {
    const { organizationId } = req.params;
    if (!UUID_RE.test(organizationId)) {
      res.status(404).json({ error: 'organization não encontrada' });
      return null;
    }
    const papel = await papelEm(req.auth.userId, organizationId);
    if (papel !== 'owner') {
      // 404 para quem não é membro: não confirma que a organization existe.
      res.status(papel ? 403 : 404).json({ error: papel ? 'apenas owner' : 'organization não encontrada' });
      return null;
    }
    return organizationId;
  }

  async function responderSessao(res, auth) {
    let ativa = null;
    let codigo = null;
    let lista;
    try {
      const r = await resolverOrganizacaoAtiva(pool, auth);
      ativa = { id: r.membership.organizationId, nome: r.membership.nome, papel: r.membership.papel, loja: null };
      lista = r.memberships;
      // Só para exibição (nome/cor da loja no painel). Nenhuma rota lê isso do navegador.
      try {
        ativa.loja = (await resolverStore(pool, ativa.id)).loja;
      } catch (err) {
        if (!(err instanceof TenantContextHttpError)) throw err;
        codigo = err.codigo;
      }
    } catch (err) {
      if (!(err instanceof TenantContextHttpError)) throw err;
      codigo = err.codigo;
      lista = await memberships(auth.userId);
    }
    res.json({
      authenticated: true,
      user: { id: auth.userId, email: auth.email, nome: auth.nome },
      csrfToken: auth.csrfToken,
      metodo: auth.metodo,
      memberships: lista,
      // Decidida no servidor: gravada na sessão por seleção explícita, ou pelo único membership
      // desta pessoa. Nunca derivada do request.
      organizacaoAtiva: ativa,
      codigoOrganizacao: codigo,
    });
  }

  const rota = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[AUTH] ${req.method} ${req.path}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: 'erro interno' });
  });

  // ── Login ────────────────────────────────────────────────────────────────────────────────
  router.post('/login', rota(async (req, res) => {
    const corpo = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const extras = Object.keys(corpo).filter((k) => !CAMPOS_LOGIN.has(k));
    if (extras.length) {
      // Whitelist: login recebe credencial, nunca tenant, loja ou papel.
      return res.status(400).json({ error: `campos não aceitos: ${extras.join(', ')}` });
    }
    const { password } = corpo;
    if (typeof password !== 'string' || !password || password.length > 200) {
      return res.status(400).json({ error: 'credenciais inválidas' });
    }
    const email = normalizarEmail(corpo.email);
    const legadoPedido = !email;
    const conta = legadoPedido ? '__legado__' : email;
    if (!legadoPedido && !emailValido(email)) return res.status(400).json({ error: 'credenciais inválidas' });
    if (limiter.bloqueado(conta)) {
      return res.status(429).json({ error: 'muitas tentativas, tente novamente mais tarde' });
    }

    let usuario = null;
    let metodo = 'senha';
    if (legadoPedido) {
      // Compatibilidade de emergência por UMA release, só com flag explícita e usuário declarado.
      if (!legado.habilitado || !legado.senha || !legado.email) {
        limiter.registrarFalha(conta);
        return res.status(401).json({ error: 'e-mail ou senha incorretos' });
      }
      if (!iguaisEmTempoConstante(password, legado.senha)) {
        limiter.registrarFalha(conta);
        return res.status(401).json({ error: 'e-mail ou senha incorretos' });
      }
      const { rows } = await pool.query(
        `SELECT id, email, nome FROM users WHERE email = $1 AND status = 'active'`, [legado.email]
      );
      if (!rows.length) {
        console.error('[AUTH] login legado habilitado, mas LEGACY_ADMIN_USER_EMAIL não é um usuário ativo');
        return res.status(503).json({ error: 'login legado indisponível' });
      }
      usuario = rows[0];
      metodo = 'legado';
    } else {
      const { rows } = await pool.query(
        'SELECT id, email, nome, password_hash, status FROM users WHERE email = $1', [email]
      );
      const u = rows[0];
      const hash = u ? u.password_hash : await senhas.hashDeReferencia();
      const confere = await senhas.verificarSenha(password, hash);
      if (!u || !confere || u.status !== 'active') {
        limiter.registrarFalha(conta);
        return res.status(401).json({ error: 'e-mail ou senha incorretos' });
      }
      usuario = u;
      if (senhas.precisaRehash(u.password_hash)) {
        await pool.query('UPDATE users SET password_hash = $1, atualizado_em = now() WHERE id = $2',
          [await senhas.gerarHash(password), u.id]);
      }
    }
    limiter.registrarSucesso(conta);

    // Session fixation: qualquer sessão trazida para o login morre aqui; a nova é sempre gerada
    // no servidor.
    const anterior = tokenDoRequest(req, producao);
    if (anterior) await sessoes.revogarPorToken(anterior, { motivo: 'substituida_no_login' });

    const nova = await sessoes.criar({ userId: usuario.id, metodo });
    await pool.query('UPDATE users SET ultimo_login_em = now() WHERE id = $1', [usuario.id]);
    res.setHeader('Set-Cookie', cookieDeSessao({ producao, token: nova.token, expiraEm: nova.expiraEm }));
    res.json({
      ok: true,
      user: { id: usuario.id, email: usuario.email, nome: usuario.nome },
      csrfToken: nova.csrfToken,
      metodo,
    });
  }));

  router.post('/logout', requireAuth, rota(async (req, res) => {
    await sessoes.revogar(req.auth.sessaoId, { por: req.auth.userId, motivo: 'logout' });
    res.setHeader('Set-Cookie', cookieApagado({ producao }));
    res.json({ ok: true });
  }));

  router.get('/session', rota(async (req, res) => {
    let auth = null;
    try {
      auth = await carregarSessao(req);
    } catch (err) {
      console.error(`[AUTH] sessão indisponível: ${err.message}`);
      return res.status(503).json({ error: 'autenticação indisponível' });
    }
    if (!auth) return res.json({ authenticated: false });
    await responderSessao(res, auth);
  }));

  // Troca de workspace: o ÚNICO lugar em que o navegador pode mencionar uma Organization. É uma
  // proposta; o servidor confere o membership desta pessoa e só então grava na sessão. As rotas de
  // negócio usam somente o valor gravado (INV-02).
  router.post('/session/organization', requireAuth, rota(async (req, res) => {
    const corpo = req.body && typeof req.body === 'object' ? req.body : {};
    const extras = Object.keys(corpo).filter((k) => k !== 'organizationId');
    if (extras.length || !UUID_RE.test(String(corpo.organizationId || ''))) {
      return res.status(400).json({ error: 'informe apenas organizationId' });
    }
    try {
      const m = await selecionarOrganizacao(pool, req.auth, corpo.organizationId);
      res.json({ ok: true, organizacaoAtiva: { id: m.organizationId, nome: m.nome, papel: m.papel } });
    } catch (err) {
      if (err instanceof TenantContextHttpError) return res.status(err.status).json({ error: err.message, codigo: err.codigo });
      throw err;
    }
  }));

  // ── Sessões da própria conta ─────────────────────────────────────────────────────────────
  router.get('/me/sessions', requireAuth, rota(async (req, res) => {
    const lista = await sessoes.listarDoUsuario(req.auth.userId);
    res.json({
      sessoes: lista.map((s) => ({
        id: s.id, metodo: s.metodo, criadoEm: s.criado_em, expiraEm: s.expira_em,
        ultimoUsoEm: s.ultimo_uso_em, atual: s.id === req.auth.sessaoId,
      })),
    });
  }));

  router.post('/me/sessions/:sessaoId/revoke', requireAuth, rota(async (req, res) => {
    const { sessaoId } = req.params;
    if (!SESSAO_ID_RE.test(sessaoId)) return res.status(404).json({ error: 'sessão não encontrada' });
    const minhas = await sessoes.listarDoUsuario(req.auth.userId);
    // Sessão de outra pessoa é indistinguível de sessão inexistente.
    if (!minhas.some((s) => s.id === sessaoId)) return res.status(404).json({ error: 'sessão não encontrada' });
    await sessoes.revogar(sessaoId, { por: req.auth.userId, motivo: 'revogada_pelo_usuario' });
    res.json({ ok: true });
  }));

  router.post('/me/sessions/revoke-others', requireAuth, rota(async (req, res) => {
    const n = await sessoes.revogarDoUsuario(req.auth.userId, {
      por: req.auth.userId, motivo: 'revogada_pelo_usuario', exceto: req.auth.sessaoId,
    });
    res.json({ ok: true, revogadas: n });
  }));

  // ── Ações de owner sobre outra pessoa ────────────────────────────────────────────────────
  async function acaoSobrePessoa(req, res, { acao, executar }) {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return res.status(404).json({ error: 'usuário não encontrado' });
    const pode = await podeGerirPessoa(req.auth.userId, userId);
    if (!pode.ok) return res.status(403).json({ error: pode.motivo });
    const resultado = await executar(userId);
    for (const organizationId of pode.organizations) {
      await auditar({
        actorUserId: req.auth.userId, action: acao, entityType: 'user', entityId: userId,
        organizationId, after: resultado,
      });
    }
    res.json({ ok: true, ...resultado });
  }

  router.post('/users/:userId/revoke-sessions', requireAuth, rota((req, res) => acaoSobrePessoa(req, res, {
    acao: 'auth.sessions.revoke',
    executar: async (alvo) => ({
      revogadas: await sessoes.revogarDoUsuario(alvo, { por: req.auth.userId, motivo: 'revogada_por_owner' }),
    }),
  })));

  router.post('/users/:userId/disable', requireAuth, rota((req, res) => acaoSobrePessoa(req, res, {
    acao: 'auth.user.disable',
    executar: async (alvo) => {
      await pool.query(`UPDATE users SET status = 'disabled', atualizado_em = now() WHERE id = $1`, [alvo]);
      const revogadas = await sessoes.revogarDoUsuario(alvo, { por: req.auth.userId, motivo: 'usuario_desativado' });
      return { status: 'disabled', revogadas };
    },
  })));

  // ── Membros de uma Organization (owner) ─────────────────────────────────────────────────
  router.get('/organizations/:organizationId/members', requireAuth, rota(async (req, res) => {
    const organizationId = await exigirOwner(req, res);
    if (!organizationId) return;
    const membros = await comOrganization(pool, organizationId, (c) => c.query(
      `SELECT m.user_id, m.papel, m.criado_em FROM organization_members m ORDER BY m.criado_em`
    ));
    const ids = membros.rows.map((m) => m.user_id);
    const { rows: pessoas } = await pool.query(
      'SELECT id, email, nome, status FROM users WHERE id = ANY($1::uuid[])', [ids]
    );
    const porId = new Map(pessoas.map((p) => [p.id, p]));
    res.json({
      membros: membros.rows.map((m) => ({
        userId: m.user_id, papel: m.papel, desde: m.criado_em,
        email: porId.get(m.user_id)?.email, nome: porId.get(m.user_id)?.nome, status: porId.get(m.user_id)?.status,
      })),
    });
  }));

  router.post('/organizations/:organizationId/members', requireAuth, rota(async (req, res) => {
    const organizationId = await exigirOwner(req, res);
    if (!organizationId) return;
    const { email: emailBruto, papel = 'member', senha, nome } = req.body || {};
    const email = normalizarEmail(emailBruto);
    if (!emailValido(email)) return res.status(400).json({ error: 'e-mail inválido' });
    if (!PAPEIS.has(papel)) return res.status(400).json({ error: 'papel inválido (owner ou member)' });

    let { rows: [pessoa] } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (!pessoa) {
      try {
        senhas.validarSenhaNova(senha);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
      ({ rows: [pessoa] } = await pool.query(
        'INSERT INTO users (email, nome, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [email, typeof nome === 'string' ? nome.trim().slice(0, 200) || null : null, await senhas.gerarHash(senha)]
      ));
    }
    // Pessoa já existente: a senha dela nunca é tocada por um owner.
    const inserido = await comOrganization(pool, organizationId, (c) => c.query(
      `INSERT INTO organization_members (organization_id, user_id, papel) VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO NOTHING RETURNING user_id`,
      [organizationId, pessoa.id, papel]
    ));
    if (!inserido.rowCount) return res.status(409).json({ error: 'já é membro' });
    await auditar({
      actorUserId: req.auth.userId, action: 'org.member.add', entityType: 'user', entityId: pessoa.id,
      organizationId, after: { papel },
    });
    res.status(201).json({ ok: true, userId: pessoa.id, papel });
  }));

  async function ownersRestantes(c, organizationId, excetoUserId) {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM organization_members
        WHERE organization_id = $1 AND papel = 'owner' AND user_id <> $2`,
      [organizationId, excetoUserId]
    );
    return rows[0].n;
  }

  router.patch('/organizations/:organizationId/members/:userId', requireAuth, rota(async (req, res) => {
    const organizationId = await exigirOwner(req, res);
    if (!organizationId) return;
    const { userId } = req.params;
    const { papel } = req.body || {};
    if (!UUID_RE.test(userId)) return res.status(404).json({ error: 'membro não encontrado' });
    if (!PAPEIS.has(papel)) return res.status(400).json({ error: 'papel inválido (owner ou member)' });
    const r = await comOrganization(pool, organizationId, async (c) => {
      if (papel !== 'owner' && await ownersRestantes(c, organizationId, userId) === 0) return { conflito: true };
      return c.query(
        'UPDATE organization_members SET papel = $1 WHERE organization_id = $2 AND user_id = $3 RETURNING papel',
        [papel, organizationId, userId]
      );
    });
    if (r.conflito) return res.status(409).json({ error: 'a organization precisa de ao menos um owner' });
    if (!r.rowCount) return res.status(404).json({ error: 'membro não encontrado' });
    await auditar({
      actorUserId: req.auth.userId, action: 'org.member.role', entityType: 'user', entityId: userId,
      organizationId, after: { papel },
    });
    res.json({ ok: true, papel });
  }));

  router.delete('/organizations/:organizationId/members/:userId', requireAuth, rota(async (req, res) => {
    const organizationId = await exigirOwner(req, res);
    if (!organizationId) return;
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return res.status(404).json({ error: 'membro não encontrado' });
    const r = await comOrganization(pool, organizationId, async (c) => {
      if (await ownersRestantes(c, organizationId, userId) === 0) return { conflito: true };
      return c.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [organizationId, userId]);
    });
    if (r.conflito) return res.status(409).json({ error: 'a organization precisa de ao menos um owner' });
    if (!r.rowCount) return res.status(404).json({ error: 'membro não encontrado' });
    await auditar({
      actorUserId: req.auth.userId, action: 'org.member.remove', entityType: 'user', entityId: userId, organizationId,
    });
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createAuthRouter };
