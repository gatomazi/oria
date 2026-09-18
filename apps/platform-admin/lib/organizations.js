'use strict';

// Organizations, Store 1:1, assinatura, entitlements, suspensão, convites e membros.
//
// ── A regra que governa este arquivo ─────────────────────────────────────────────────────────
// Toda escrita em tabela tenant-owned (`organizations`, `stores`, `organization_members`,
// `onboarding_*`) roda dentro de `comOrganization(pool, organizationId, …)`, com o
// `organizationId` vindo do **:organizationId da ROTA**. Não existe caminho em que um valor do
// corpo vire alvo — a camada HTTP rejeita `organization_id` no corpo antes de chegar aqui, e as
// funções abaixo só recebem o alvo como parâmetro posicional.
//
// Tabela de PLATAFORMA (assinatura, override, convite, auditoria) roda na mesma transação, sem
// contexto: ela não é de ninguém. É isso que permite "criação atômica" atravessando os dois
// mundos com uma transação só.

const crypto = require('crypto');
const { comOrganization } = require('./db');
const audit = require('./audit');
const { HttpError, erro400, erro404, erro409, erro422 } = require('./http');
const { resolverAcessoEfetivo, exigirFeaturesConhecidas, FeatureDesconhecidaError } = require('./entitlements');

// Vocabulário de onboarding — CÓPIA DECLARADA de apps/panel/lib/platform/onboarding.js. O CHECK da
// tabela `onboarding_steps` é a terceira cópia e a que de fato impede gravação inválida.
const PASSOS = Object.freeze([
  'org_store', 'owner', 'ink', 'meta', 'google', 'ga4', 'openai_byok', 'whatsapp', 'entitlements', 'readiness',
]);
const REQUISITOS = Object.freeze(['required', 'optional', 'disabled']);
const PASSOS_ESTRUTURAIS = Object.freeze(['org_store', 'owner', 'readiness']);

const CHAVE_IDEMPOTENCIA_RE = /^[A-Za-z0-9_.:-]{16,200}$/;
const VALIDADE_MAXIMA_HORAS = 7 * 24;
const VALIDADE_PADRAO_HORAS = 72;

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

// Erro de controle: desfaz a transação quando a chave de idempotência já pertence a outra criação.
class ChaveJaReservada extends Error {
  constructor() {
    super('chave de idempotência já reservada');
    this.name = 'ChaveJaReservada';
  }
}

function validarPassos(passos) {
  if (!passos || typeof passos !== 'object' || Array.isArray(passos)) {
    throw erro409('onboarding_config_required',
      'configuração dos passos de onboarding ausente (ONBOARDING_STEP_REQUIREMENTS) — não existe plano padrão');
  }
  const chaves = Object.keys(passos);
  const desconhecidos = chaves.filter((k) => !PASSOS.includes(k));
  const faltando = PASSOS.filter((k) => !chaves.includes(k));
  if (desconhecidos.length || faltando.length) {
    throw erro422('onboarding_config_invalida', 'configuração de passos inválida',
      { faltando, desconhecidos });
  }
  for (const k of PASSOS) {
    if (!REQUISITOS.includes(passos[k])) {
      throw erro422('onboarding_config_invalida', `passo ${k}: requisito inválido`);
    }
    if (PASSOS_ESTRUTURAIS.includes(k) && passos[k] !== 'required') {
      throw erro422('onboarding_config_invalida', `passo ${k} é estrutural e precisa ser required`);
    }
  }
  return Object.freeze(Object.fromEntries(PASSOS.map((k) => [k, passos[k]])));
}

function criarServicoDeOrganizations({ pool, config, planos, readModels, agora = () => new Date() }) {
  const passosPadrao = config.passosOnboarding ? JSON.parse(config.passosOnboarding) : null;

  // ── Entitlements efetivos ──────────────────────────────────────────────────────────────────
  // Lê o estado da Organization pelo read model (não precisa de contexto) e o resto das tabelas de
  // plataforma direto. O resolver é puro e está em lib/entitlements.js.
  async function resolucaoDe(organizationId, cliente = pool) {
    const resumo = await (cliente === pool
      ? readModels.organizationResumo(organizationId)
      : cliente.query('SELECT * FROM platform_organization_resumo($1)', [organizationId]).then((r) => r.rows[0] || null));
    if (!resumo) throw erro404();

    const { rows: assinatura } = await cliente.query(
      `SELECT s.id, s.status, s.iniciada_em, p.id AS plan_id, p.chave, p.nome, p.status AS plano_status
         FROM organization_subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.organization_id = $1 AND s.status = 'active'`,
      [organizationId]
    );
    const ativa = assinatura[0] || null;

    const { rows: featuresDoPlano } = ativa
      ? await cliente.query(
        'SELECT feature::text AS feature, habilitada FROM plan_features WHERE plan_id = $1',
        [ativa.plan_id]
      )
      : { rows: [] };

    const { rows: overrides } = await cliente.query(
      `SELECT feature::text AS feature, permitido, motivo, criado_em, atualizado_em
         FROM organization_entitlement_overrides WHERE organization_id = $1 ORDER BY feature`,
      [organizationId]
    );

    const resolucao = resolverAcessoEfetivo({
      organizationStatus: resumo.status,
      assinaturaAtiva: !!ativa,
      featuresDoPlano: Object.fromEntries(featuresDoPlano.map((f) => [f.feature, f.habilitada])),
      overrides: Object.fromEntries(overrides.map((o) => [o.feature, o.permitido])),
    });

    return {
      resumo,
      assinatura: ativa,
      plano: ativa ? { id: ativa.plan_id, chave: ativa.chave, nome: ativa.nome, status: ativa.plano_status,
        features: featuresDoPlano.filter((f) => f.habilitada).map((f) => f.feature).sort() } : null,
      overrides: overrides.map((o) => ({
        feature: o.feature, permitido: o.permitido, motivo: o.motivo, criadoEm: o.criado_em, atualizadoEm: o.atualizado_em,
      })),
      efetivos: resolucao.efetivos,
      origem: resolucao.origem,
    };
  }

  // ── Criação (§12) ──────────────────────────────────────────────────────────────────────────
  // UMA transação: gate, Organization, Store 1:1, assinatura, estado de onboarding, convite do
  // owner e auditoria. Qualquer falha desfaz tudo — inclusive o convite.
  async function criar({ ator, nome, storeNome, planoChave, ownerEmail, idempotencyKey, bootstrapInterno,
    conviteValidadeHoras, passos }) {
    if (!CHAVE_IDEMPOTENCIA_RE.test(String(idempotencyKey || ''))) {
      throw erro400('idempotency_key_invalida',
        'chave de idempotência explícita obrigatória (16-200 caracteres de [A-Za-z0-9_.:-])');
    }
    const requisitos = validarPassos(passos === undefined || passos === null ? passosPadrao : passos);

    const plano = await planos.buscarPorChave(planoChave);
    if (!plano) throw erro422('plano_desconhecido', 'plano inexistente', { planoChave });
    if (plano.status !== 'active') throw erro422('plano_arquivado', 'plano arquivado não aceita novas assinaturas');

    const validadeHoras = conviteValidadeHoras ?? VALIDADE_PADRAO_HORAS;
    const organizationId = crypto.randomUUID();
    const storeId = crypto.randomUUID();
    const digest = sha256(JSON.stringify({ n: nome, s: storeNome, p: planoChave, o: ownerEmail, r: requisitos }));

    let reservaDeOutro = null;
    const resultado = await comOrganization(pool, organizationId, async (c) => {
      // Gate (§13). Serializa por advisory lock de transação: dois pedidos simultâneos não veem
      // ambos "zero Organizations". Não olha nome — o que autoriza é a AUSÊNCIA de Organization.
      const { rows: [{ platform_bootstrap_reservar: quantas }] } = await c.query('SELECT platform_bootstrap_reservar()');
      if (!config.criacaoExternaHabilitada) {
        if (!bootstrapInterno) {
          throw new HttpError(403, 'second_tenant_disabled',
            'criação de Organization desabilitada (SECOND_TENANT_ENABLED). Para o Tenant #1, use bootstrapInterno.');
        }
        if (quantas > 0) {
          throw erro409('bootstrap_interno_indisponivel',
            'o bootstrap interno só existe enquanto não há nenhuma Organization; para criar tenant externo, ligue SECOND_TENANT_ENABLED');
        }
      }

      // Idempotência ANTES de criar: a reserva grava (admin, chave) → esta Organization. A FK é
      // DEFERRABLE, então a linha pode apontar para a Organization que ainda vai nascer no mesmo
      // COMMIT. Dois pedidos simultâneos com a mesma chave serializam na PK: o segundo espera e vê
      // a reserva do primeiro. Nada de "este admin já criou uma, devolve essa".
      await c.query(
        `INSERT INTO platform_organization_creations (admin_id, chave_hash, organization_id, digest)
         VALUES ($1, $2, $3, $4) ON CONFLICT (admin_id, chave_hash) DO NOTHING`,
        [ator.adminId, sha256(idempotencyKey), organizationId, digest]
      );
      const { rows: [reserva] } = await c.query(
        'SELECT organization_id, digest FROM platform_organization_creations WHERE admin_id = $1 AND chave_hash = $2',
        [ator.adminId, sha256(idempotencyKey)]
      );
      if (reserva.organization_id !== organizationId) {
        // A chave é de outra criação. Desfaz esta transação inteira e responde fora dela.
        reservaDeOutro = reserva;
        throw new ChaveJaReservada();
      }

      await c.query('INSERT INTO organizations (id, nome) VALUES ($1, $2)', [organizationId, nome]);
      await c.query(
        'INSERT INTO stores (id, organization_id, nome, loja_legada) VALUES ($1, $2, $3, NULL)',
        [storeId, organizationId, storeNome]
      );

      const { rows: [assinatura] } = await c.query(
        `INSERT INTO organization_subscriptions (organization_id, plan_id) VALUES ($1, $2)
         RETURNING id, status, iniciada_em`,
        [organizationId, plano.id]
      );

      await c.query(
        `INSERT INTO onboarding_sessions (organization_id, status, config, criado_por)
         VALUES ($1, 'in_progress', $2::jsonb, NULL)`,
        [organizationId, JSON.stringify(requisitos)]
      );
      for (const passo of PASSOS) {
        const requisito = requisitos[passo];
        // `org_store` já está feito (acabou de ser criado). `owner` NÃO: ainda é só um convite.
        const feito = passo === 'org_store';
        const status = requisito === 'disabled' ? 'skipped' : feito ? 'complete' : 'pending';
        await c.query(
          `INSERT INTO onboarding_steps (organization_id, step_id, requirement, status, completed_at)
           VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'complete' THEN now() END)`,
          [organizationId, passo, requisito, status]
        );
      }

      const convite = await emitirConviteNaTransacao(c, {
        ator, organizationId, email: ownerEmail, papel: 'owner', validadeHoras, action: 'invite.issued',
      });

      await audit.registrar(c, {
        ator,
        action: 'organization.created',
        entityType: 'organization',
        entityId: organizationId,
        organizationId,
        after: {
          nome,
          storeId,
          storeNome,
          planoChave,
          subscriptionId: assinatura.id,
          conviteId: convite.id,
          ownerEmail,
          bootstrapInterno: !!bootstrapInterno && !config.criacaoExternaHabilitada,
          idempotencyKey,
          digest,
        },
      });

      const resolucao = await resolucaoDe(organizationId, c);
      return { criada: true, ...(await montarResultado(organizationId, resolucao, convite, c)) };
    }).catch((err) => {
      if (!(err instanceof ChaveJaReservada)) throw err;
      return null;
    });

    if (resultado) return resultado;

    // Mesma chave: mesmo pedido devolve o que já foi criado; pedido diferente é conflito.
    if (reservaDeOutro.digest !== digest) {
      throw erro409('idempotency_key_reutilizada', 'chave de idempotência já usada com outro pedido');
    }
    const jaCriada = await resolucaoDe(reservaDeOutro.organization_id);
    return { criada: false, ...(await montarResultado(reservaDeOutro.organization_id, jaCriada, null)) };
  }

  async function montarResultado(organizationId, resolucao, convite, cliente = pool) {
    const passosDoBanco = await (cliente === pool
      ? readModels.passos(organizationId)
      : cliente.query('SELECT * FROM platform_listar_passos($1)', [organizationId]).then((r) => r.rows));
    return {
      organization: {
        id: resolucao.resumo.id,
        nome: resolucao.resumo.nome,
        status: resolucao.resumo.status,
        criadoEm: resolucao.resumo.criado_em,
      },
      store: resolucao.resumo.store_id
        ? { id: resolucao.resumo.store_id, nome: resolucao.resumo.store_nome, ativa: resolucao.resumo.store_ativa }
        : null,
      subscription: resolucao.assinatura
        ? { id: resolucao.assinatura.id, status: resolucao.assinatura.status, plano: { chave: resolucao.plano.chave, nome: resolucao.plano.nome } }
        : null,
      entitlements: resolucao.efetivos,
      invite: convite,
      onboarding: formatarOnboarding(passosDoBanco),
    };
  }

  function formatarOnboarding(passosDoBanco) {
    const ordenados = PASSOS.map((id) => passosDoBanco.find((p) => p.step_id === id)).filter(Boolean);
    const proximo = ordenados.find((p) => p.requirement === 'required' && p.status !== 'complete');
    const bloqueado = ordenados.find((p) => p.status === 'blocked');
    return {
      proximoPasso: proximo ? proximo.step_id : null,
      passoBloqueado: bloqueado ? bloqueado.step_id : null,
      lastErrorCode: bloqueado ? bloqueado.last_error_code : null,
      passos: ordenados.map((p) => ({
        id: p.step_id,
        requirement: p.requirement,
        status: p.status,
        lastErrorCode: p.last_error_code,
        tentativas: p.tentativas,
        completedAt: p.completed_at,
      })),
    };
  }

  // ── Detalhe (§18) ──────────────────────────────────────────────────────────────────────────
  async function detalhe(organizationId) {
    const resolucao = await resolucaoDe(organizationId);
    const [membros, passosDoBanco, sessaoOnboarding, integracoes, convites, suspensao] = await Promise.all([
      readModels.membros(organizationId),
      readModels.passos(organizationId),
      readModels.onboardingResumo(organizationId),
      readModels.integracoes({ organizationId, limite: 100 }),
      listarConvites(organizationId),
      ultimaSuspensao(organizationId),
    ]);
    const onboarding = sessaoOnboarding
      ? {
        status: sessaoOnboarding.status,
        atualizadoEm: sessaoOnboarding.atualizado_em,
        concluidoEm: sessaoOnboarding.concluido_em,
        ...formatarOnboarding(passosDoBanco),
      }
      : null;

    return {
      id: resolucao.resumo.id,
      nome: resolucao.resumo.nome,
      status: resolucao.resumo.status,
      criadoEm: resolucao.resumo.criado_em,
      store: resolucao.resumo.store_id
        ? {
          id: resolucao.resumo.store_id,
          nome: resolucao.resumo.store_nome,
          ativa: resolucao.resumo.store_ativa,
          lojaLegada: resolucao.resumo.loja_legada,
        }
        : null,
      owners: membros.filter((m) => m.papel === 'owner').map(paraMembro),
      membros: membros.map(paraMembro),
      plano: resolucao.plano,
      subscription: resolucao.assinatura
        ? { id: resolucao.assinatura.id, status: resolucao.assinatura.status, iniciadaEm: resolucao.assinatura.iniciada_em }
        : null,
      entitlements: { efetivos: resolucao.efetivos, origem: resolucao.origem },
      overrides: resolucao.overrides,
      onboarding,
      integracoes: integracoes.itens.map(paraIntegracao),
      convites,
      suspensao,
    };
  }

  const paraMembro = (m) => ({
    userId: m.user_id, email: m.email, nome: m.nome, papel: m.papel, status: m.status, desde: m.criado_em,
  });

  // Honestidade sobre o que existe: `integrations` NÃO tem coluna de "último teste" nem de
  // "último sucesso". Inventar um valor a partir de `atualizado_em` seria dado fabricado (§17 do
  // comando). Então `atualizadoEm` é o que é, e os dois campos ficam null até haver fonte real.
  const paraIntegracao = (i) => ({
    organizationId: i.organization_id,
    organizationNome: i.organization_nome,
    provider: i.provider,
    status: i.status,
    displayName: i.display_name,
    segredosValidos: i.segredos_validos,
    segredosVencidos: i.segredos_vencidos,
    atualizadoEm: i.atualizado_em,
    lastTestEm: null,
    lastSuccessEm: null,
    lastErrorCode: i.last_error_code,
  });

  async function ultimaSuspensao(organizationId) {
    const { rows } = await pool.query(
      `SELECT criado_em, actor_email, after FROM platform_audit_logs
        WHERE organization_id = $1 AND action = 'organization.suspended'
        ORDER BY id DESC LIMIT 1`,
      [organizationId]
    );
    if (!rows.length) return null;
    return { suspensaEm: rows[0].criado_em, motivo: rows[0].after.motivo || null, por: rows[0].actor_email };
  }

  // ── Suspensão / reativação (§14) ───────────────────────────────────────────────────────────
  // Efeito real: `auth_memberships()` do painel já filtra `o.status = 'active'` (o tenant perde
  // login/seleção de workspace), `platform_organizations_ativas()` deixa de devolver a Organization
  // para os jobs, e o resolver de entitlements nega TUDO. Os dados ficam.
  async function mudarStatus({ ator, organizationId, destino, motivo }) {
    return comOrganization(pool, organizationId, async (c) => {
      const { rows } = await c.query('SELECT id, nome, status FROM organizations WHERE id = $1 FOR UPDATE', [organizationId]);
      const org = rows[0];
      if (!org) throw erro404();
      if (org.status === destino) {
        return { id: org.id, nome: org.nome, status: org.status, mudou: false };
      }
      const { rows: [nova] } = await c.query(
        'UPDATE organizations SET status = $2, atualizado_em = now() WHERE id = $1 RETURNING id, nome, status, atualizado_em',
        [organizationId, destino]
      );
      await audit.registrar(c, {
        ator,
        action: destino === 'suspended' ? 'organization.suspended' : 'organization.reactivated',
        entityType: 'organization',
        entityId: organizationId,
        organizationId,
        before: { status: org.status },
        after: { status: nova.status, motivo: motivo || null },
      });
      return { id: nova.id, nome: nova.nome, status: nova.status, mudou: true, em: nova.atualizado_em };
    });
  }

  // ── Assinatura ─────────────────────────────────────────────────────────────────────────────
  async function historicoDeAssinaturas(organizationId) {
    const { rows } = await pool.query(
      `SELECT s.id, s.status, s.iniciada_em, s.cancelada_em, s.motivo_cancelamento, p.chave, p.nome
         FROM organization_subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.organization_id = $1 ORDER BY s.iniciada_em DESC, s.id DESC`,
      [organizationId]
    );
    return rows.map((r) => ({
      id: r.id, status: r.status, iniciadaEm: r.iniciada_em, canceladaEm: r.cancelada_em,
      motivoCancelamento: r.motivo_cancelamento, plano: { chave: r.chave, nome: r.nome },
    }));
  }

  // Cancela a ativa e cria a nova na MESMA transação. O índice parcial garante que nunca há duas.
  async function trocarPlano({ ator, organizationId, planoChave, motivo }) {
    const resumo = await readModels.organizationResumo(organizationId);
    if (!resumo) throw erro404();
    const plano = await planos.buscarPorChave(planoChave);
    if (!plano) throw erro422('plano_desconhecido', 'plano inexistente', { planoChave });
    if (plano.status !== 'active') throw erro422('plano_arquivado', 'plano arquivado não aceita novas assinaturas');

    return comOrganization(pool, organizationId, async (c) => {
      const { rows: atuais } = await c.query(
        `SELECT s.id, s.plan_id, p.chave FROM organization_subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.organization_id = $1 AND s.status = 'active' FOR UPDATE OF s`,
        [organizationId]
      );
      const atual = atuais[0] || null;
      if (atual && atual.plan_id === plano.id) {
        return { mudou: false, resolucao: await resolucaoDe(organizationId, c) };
      }
      if (atual) {
        await c.query(
          `UPDATE organization_subscriptions SET status = 'canceled', cancelada_em = now(), motivo_cancelamento = $2
            WHERE id = $1`,
          [atual.id, motivo || 'troca de plano']
        );
      }
      const { rows: [nova] } = await c.query(
        'INSERT INTO organization_subscriptions (organization_id, plan_id) VALUES ($1, $2) RETURNING id, status, iniciada_em',
        [organizationId, plano.id]
      );
      await audit.registrar(c, {
        ator,
        action: atual ? 'subscription.changed' : 'subscription.created',
        entityType: 'organization_subscription',
        entityId: nova.id,
        organizationId,
        before: atual ? { planoChave: atual.chave, subscriptionId: atual.id } : null,
        after: { planoChave, subscriptionId: nova.id, motivo: motivo || null },
      });
      return { mudou: true, resolucao: await resolucaoDe(organizationId, c) };
    });
  }

  // ── Overrides ──────────────────────────────────────────────────────────────────────────────
  async function definirOverride({ ator, organizationId, feature, permitido, motivo }) {
    try {
      exigirFeaturesConhecidas([feature]);
    } catch (err) {
      if (err instanceof FeatureDesconhecidaError) {
        throw erro422('feature_desconhecida', 'feature fora do vocabulário', { features: err.features });
      }
      throw err;
    }
    const resumo = await readModels.organizationResumo(organizationId);
    if (!resumo) throw erro404();

    return comOrganization(pool, organizationId, async (c) => {
      const { rows: antes } = await c.query(
        'SELECT permitido, motivo FROM organization_entitlement_overrides WHERE organization_id = $1 AND feature = $2',
        [organizationId, feature]
      );
      await c.query(
        `INSERT INTO organization_entitlement_overrides (organization_id, feature, permitido, motivo, criado_por)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, feature)
         DO UPDATE SET permitido = EXCLUDED.permitido, motivo = EXCLUDED.motivo, atualizado_em = now()`,
        [organizationId, feature, permitido, motivo || null, ator.adminId]
      );
      await audit.registrar(c, {
        ator,
        action: 'entitlement.override_set',
        entityType: 'entitlement_override',
        entityId: `${organizationId}:${feature}`,
        organizationId,
        before: antes[0] ? { feature, permitido: antes[0].permitido } : null,
        after: { feature, permitido, motivo: motivo || null },
      });
      return resolucaoDe(organizationId, c);
    });
  }

  // Remover o override faz a feature VOLTAR A HERDAR DO PLANO — não vira `false` por acidente.
  async function removerOverride({ ator, organizationId, feature }) {
    try {
      exigirFeaturesConhecidas([feature]);
    } catch (err) {
      if (err instanceof FeatureDesconhecidaError) {
        throw erro422('feature_desconhecida', 'feature fora do vocabulário', { features: err.features });
      }
      throw err;
    }
    const resumo = await readModels.organizationResumo(organizationId);
    if (!resumo) throw erro404();

    return comOrganization(pool, organizationId, async (c) => {
      const { rows } = await c.query(
        'DELETE FROM organization_entitlement_overrides WHERE organization_id = $1 AND feature = $2 RETURNING permitido',
        [organizationId, feature]
      );
      if (!rows.length) throw erro404();
      await audit.registrar(c, {
        ator,
        action: 'entitlement.override_removed',
        entityType: 'entitlement_override',
        entityId: `${organizationId}:${feature}`,
        organizationId,
        before: { feature, permitido: rows[0].permitido },
        after: { feature, herda: 'plano' },
      });
      return resolucaoDe(organizationId, c);
    });
  }

  // ── Convites (§15) ─────────────────────────────────────────────────────────────────────────
  // Token opaco de 256 bits. No banco só o SHA-256 — o token cru só existe na resposta de quem
  // emitiu. Expira, é de uso único, e revogar não pode deixar a Organization sem caminho de owner.
  async function emitirConviteNaTransacao(c, { ator, organizationId, email, papel, validadeHoras, action, anterior = null }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expira = new Date(agora().getTime() + validadeHoras * 60 * 60 * 1000);
    const { rows } = await c.query(
      `INSERT INTO organization_owner_invites (organization_id, token_hash, email, papel, criado_por, expira_em)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, papel, criado_em, expira_em`,
      [organizationId, sha256(token), email, papel, ator.adminId, expira]
    ).catch((err) => {
      if (err.code === '23505') {
        throw erro409('convite_pendente_existe', 'já existe um convite pendente para este e-mail nesta Organization');
      }
      throw err;
    });
    const convite = rows[0];
    await audit.registrar(c, {
      ator,
      action,
      entityType: 'organization_owner_invite',
      entityId: convite.id,
      organizationId,
      before: anterior ? { conviteId: anterior } : null,
      // O token NÃO vai para a auditoria. O guarda de lib/audit.js recusaria a chave `token`.
      after: { email, papel, expiraEm: convite.expira_em },
    });
    return {
      id: convite.id,
      email: convite.email,
      papel: convite.papel,
      criadoEm: convite.criado_em,
      expiraEm: convite.expira_em,
      token,
    };
  }

  function estadoDoConvite(linha, momento) {
    if (linha.usado_em) return 'usado';
    if (linha.revogado_em) return 'revogado';
    if (new Date(linha.expira_em) <= momento) return 'expirado';
    return 'pendente';
  }

  async function listarConvites(organizationId) {
    const { rows } = await pool.query(
      `SELECT id, email, papel, criado_em, expira_em, usado_em, revogado_em
         FROM organization_owner_invites WHERE organization_id = $1 ORDER BY criado_em DESC`,
      [organizationId]
    );
    const momento = agora();
    // Nunca devolve `token` nem `token_hash`.
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      papel: r.papel,
      estado: estadoDoConvite(r, momento),
      criadoEm: r.criado_em,
      expiraEm: r.expira_em,
      usadoEm: r.usado_em,
      revogadoEm: r.revogado_em,
    }));
  }

  async function emitirConvite({ ator, organizationId, email, papel, validadeHoras }) {
    const resumo = await readModels.organizationResumo(organizationId);
    if (!resumo) throw erro404();
    return comOrganization(pool, organizationId, (c) => emitirConviteNaTransacao(c, {
      ator, organizationId, email, papel, validadeHoras, action: 'invite.issued',
    }));
  }

  // Reemitir = revogar o anterior e emitir outro, na mesma transação. Nunca "estende a validade".
  async function reemitirConvite({ ator, organizationId, inviteId, validadeHoras }) {
    return comOrganization(pool, organizationId, async (c) => {
      const antigo = await carregarConvite(c, organizationId, inviteId);
      const estado = estadoDoConvite(antigo, agora());
      if (estado === 'usado') throw erro409('convite_ja_usado', 'este convite já foi usado');
      if (estado === 'revogado') throw erro409('convite_ja_revogado', 'este convite já foi revogado');
      await c.query(
        `UPDATE organization_owner_invites SET revogado_em = now(), revogado_por = $2, motivo_revogacao = 'reemissao'
          WHERE id = $1`,
        [inviteId, ator.adminId]
      );
      return emitirConviteNaTransacao(c, {
        ator,
        organizationId,
        email: antigo.email,
        papel: antigo.papel,
        validadeHoras: validadeHoras ?? VALIDADE_PADRAO_HORAS,
        action: 'invite.reissued',
        anterior: inviteId,
      });
    });
  }

  // Revogar não pode deixar a Organization SEM CAMINHO para um owner: se não há owner ativo e este
  // é o último convite de owner pendente, recusa.
  async function revogarConvite({ ator, organizationId, inviteId, motivo }) {
    return comOrganization(pool, organizationId, async (c) => {
      const convite = await carregarConvite(c, organizationId, inviteId);
      const estado = estadoDoConvite(convite, agora());
      if (estado === 'usado') throw erro409('convite_ja_usado', 'este convite já foi usado');
      if (estado === 'revogado') {
        return { id: convite.id, email: convite.email, papel: convite.papel, estado: 'revogado' };
      }

      if (convite.papel === 'owner') {
        const { rows: [{ n: owners }] } = await c.query('SELECT platform_owners_ativos($1) AS n', [organizationId]);
        const { rows: [{ n: pendentes }] } = await c.query(
          `SELECT count(*)::int AS n FROM organization_owner_invites
            WHERE organization_id = $1 AND papel = 'owner' AND usado_em IS NULL AND revogado_em IS NULL
              AND expira_em > now() AND id <> $2`,
          [organizationId, inviteId]
        );
        if (owners === 0 && pendentes === 0) {
          throw erro409('ultimo_owner',
            'esta Organization ficaria sem owner ativo e sem convite de owner pendente; emita outro convite antes de revogar');
        }
      }

      await c.query(
        'UPDATE organization_owner_invites SET revogado_em = now(), revogado_por = $2, motivo_revogacao = $3 WHERE id = $1',
        [inviteId, ator.adminId, motivo || null]
      );
      await audit.registrar(c, {
        ator,
        action: 'invite.revoked',
        entityType: 'organization_owner_invite',
        entityId: inviteId,
        organizationId,
        before: { email: convite.email, papel: convite.papel, estado },
        after: { estado: 'revogado', motivo: motivo || null },
      });
      return { id: convite.id, email: convite.email, papel: convite.papel, estado: 'revogado' };
    });
  }

  async function carregarConvite(c, organizationId, inviteId) {
    const { rows } = await c.query(
      `SELECT id, organization_id, email, papel, criado_em, expira_em, usado_em, revogado_em
         FROM organization_owner_invites WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [inviteId, organizationId]
    );
    // Convite de outra Organization e convite inexistente dão a MESMA resposta.
    if (!rows.length) throw erro404();
    return rows[0];
  }

  // ── Membros ────────────────────────────────────────────────────────────────────────────────
  // O último owner ATIVO não pode ser removido. Contado dentro da transação.
  async function removerMembro({ ator, organizationId, userId }) {
    return comOrganization(pool, organizationId, async (c) => {
      const { rows } = await c.query(
        `SELECT m.user_id, m.papel, u.email, u.status
           FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
        [organizationId, userId]
      );
      const membro = rows[0];
      if (!membro) throw erro404();

      if (membro.papel === 'owner' && membro.status === 'active') {
        const { rows: [{ n }] } = await c.query('SELECT platform_owners_ativos($1) AS n', [organizationId]);
        if (n <= 1) {
          throw erro409('ultimo_owner', 'o último owner ativo de uma Organization não pode ser removido');
        }
      }

      await c.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [organizationId, userId]);
      await audit.registrar(c, {
        ator,
        action: 'member.removed',
        entityType: 'organization_member',
        entityId: userId,
        organizationId,
        before: { papel: membro.papel, email: membro.email },
      });
      return { userId, papel: membro.papel };
    });
  }

  return {
    PASSOS,
    resolucaoDe,
    criar,
    detalhe,
    mudarStatus,
    historicoDeAssinaturas,
    trocarPlano,
    definirOverride,
    removerOverride,
    listarConvites,
    emitirConvite,
    reemitirConvite,
    revogarConvite,
    removerMembro,
    formatarOnboarding,
    paraIntegracao,
    paraMembro,
  };
}

module.exports = {
  PASSOS,
  REQUISITOS,
  PASSOS_ESTRUTURAIS,
  CHAVE_IDEMPOTENCIA_RE,
  VALIDADE_PADRAO_HORAS,
  VALIDADE_MAXIMA_HORAS,
  validarPassos,
  criarServicoDeOrganizations,
};
