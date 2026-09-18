-- Control Plane (Oria Admin · apps/platform-admin) · tabelas de PLATAFORMA.
--
-- Contrato completo: docs/architecture/control-plane.md.
--
-- Tudo aqui é GLOBAL e PRIVADO: não tem organization_id como eixo de isolamento (as que têm, têm
-- como REFERÊNCIA), não entra sob RLS, e a role da aplicação do PAINEL não recebe GRANT nenhum
-- (TABELAS_GLOBAIS_PRIVADAS em lib/platform/tenancy-manifest.js). Quem lê e escreve é o control
-- plane, com a sua própria conexão.
--
--   platform_admins                      identidade do operador da plataforma (≠ users)
--   platform_admin_sessions              sessão opaca, só o SHA-256 do token
--   plans / plan_features                vocabulário TÉCNICO de acesso (não é catálogo comercial)
--   organization_subscriptions           no máximo UMA ativa por Organization (índice parcial)
--   organization_entitlement_overrides   override explícito por Organization+feature
--   organization_owner_invites           convite do owner de uma Organization QUE JÁ EXISTE
--   platform_audit_logs                  rastro das ações do control plane
--
-- Nada aqui cria Organization, nem Store, nem dado de exemplo. A criação é do serviço, atrás do
-- gate da seção 8 do contrato.
--
-- ── Sobre as funções SECURITY DEFINER ────────────────────────────────────────────────────────
-- `organizations`, `stores`, `organization_members`, `onboarding_*`, `integrations`,
-- `webhook_eventos` e `job_leases` estão sob RLS FORÇADA (ou são globais privadas). O control
-- plane precisa de listagem que atravessa Organizations — e listagem global NÃO pode ser query
-- crua em tabela de tenant (§6 do comando). A saída é a mesma que o painel já usa em
-- `auth_memberships`: READ MODEL explícito, SECURITY DEFINER, projeção estreita, REVOKE de PUBLIC.
--
-- O que essas funções deliberadamente NÃO devolvem:
--   integrations.config / integration_secrets.*   nunca (segredo e configuração de provider)
--   webhook_eventos.headers / .body               nunca (payload cru, com PII)
--   job_leases.dono                               vira o booleano `ocupado` (é id de worker/host)
--   users.password_hash                           nunca
--
-- Operação sobre DADO de tenant continua passando por comOrganization + RLS, com a Organization
-- explícita na rota. Estas funções são só o índice.

-- ── Vocabulário fechado de features ──────────────────────────────────────────────────────────
-- Cópia declarada do registry canônico `lib/platform/entitlements.js` → FEATURES. O teste
-- `entitlements-registry` compara os dois: divergir reprova. Feature desconhecida não é "false
-- silencioso" — é erro de gravação.
CREATE DOMAIN platform_feature AS TEXT
  CHECK (VALUE IN (
    'whatsapp',
    'instagram',
    'advancedAutomations',
    'catalog',
    'exchanges',
    'refunds',
    'financial',
    'creative_generator',
    'creative_clean_angles',
    'creative_remarketing',
    'creative_funnel_visual',
    'creative_multi_product'
  ));

-- ── Identidade do operador da plataforma ─────────────────────────────────────────────────────
CREATE TABLE platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  nome TEXT,
  -- scrypt$1$N$r$p$salt$hash — mesmo formato de lib/auth/password.js. Nunca texto claro.
  password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  papel TEXT NOT NULL DEFAULT 'platform_operator'
    CHECK (papel IN ('platform_owner', 'platform_operator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_login_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_platform_admins_email ON platform_admins (email);
CREATE INDEX idx_platform_admins_owners_ativos ON platform_admins (papel)
  WHERE papel = 'platform_owner' AND status = 'active';

-- A chave é o SHA-256 do token do cookie: vazar a tabela não entrega sessão viva.
CREATE TABLE platform_admin_sessions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  admin_id UUID NOT NULL REFERENCES platform_admins (id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  ultimo_uso_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogada_em TIMESTAMPTZ,
  revogada_por UUID REFERENCES platform_admins (id) ON DELETE SET NULL,
  motivo_revogacao TEXT,
  CHECK (expira_em > criado_em)
);
CREATE INDEX idx_platform_admin_sessions_ativas ON platform_admin_sessions (admin_id)
  WHERE revogada_em IS NULL;
CREATE INDEX idx_platform_admin_sessions_expira ON platform_admin_sessions (expira_em);

-- ── Planos e features ────────────────────────────────────────────────────────────────────────
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chave TEXT NOT NULL UNIQUE CHECK (chave ~ '^[a-z][a-z0-9_]{1,62}$'),
  nome TEXT NOT NULL CHECK (btrim(nome) <> ''),
  descricao TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE plan_features (
  plan_id UUID NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  feature platform_feature NOT NULL,
  habilitada BOOLEAN NOT NULL DEFAULT true,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, feature)
);

-- ── Assinatura ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE organization_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans (id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  iniciada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelada_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  CONSTRAINT ck_subscription_cancelada CHECK ((status = 'canceled') = (cancelada_em IS NOT NULL))
);
-- "duas assinaturas ativas" é IMPOSSÍVEL de gravar, não "não fazemos isso".
CREATE UNIQUE INDEX uq_organization_subscription_ativa
  ON organization_subscriptions (organization_id) WHERE status = 'active';
CREATE INDEX idx_organization_subscriptions_org ON organization_subscriptions (organization_id, iniciada_em DESC);
CREATE INDEX idx_organization_subscriptions_plan ON organization_subscriptions (plan_id);

-- ── Override por Organization ────────────────────────────────────────────────────────────────
-- permitido = true concede mesmo sem o plano; permitido = false NEGA mesmo com o plano.
CREATE TABLE organization_entitlement_overrides (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  feature platform_feature NOT NULL,
  permitido BOOLEAN NOT NULL,
  motivo TEXT,
  criado_por UUID REFERENCES platform_admins (id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, feature)
);

-- ── Convite do owner de uma Organization QUE JÁ EXISTE ───────────────────────────────────────
-- Diferente de `onboarding_invites` (Fase 7): lá o convite CRIA a Organization (self-service);
-- aqui a Organization nasceu no control plane e o convite só liga uma pessoa a ela.
CREATE TABLE organization_owner_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  papel TEXT NOT NULL DEFAULT 'owner' CHECK (papel IN ('owner', 'member')),
  criado_por UUID REFERENCES platform_admins (id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ,
  usado_por UUID REFERENCES users (id) ON DELETE SET NULL,
  revogado_em TIMESTAMPTZ,
  revogado_por UUID REFERENCES platform_admins (id) ON DELETE SET NULL,
  motivo_revogacao TEXT,
  CHECK (expira_em > criado_em),
  -- Um convite não pode ter sido usado E revogado.
  CHECK (NOT (usado_em IS NOT NULL AND revogado_em IS NOT NULL)),
  CHECK ((usado_em IS NOT NULL) = (usado_por IS NOT NULL))
);
-- No máximo um convite PENDENTE por (Organization, e-mail).
CREATE UNIQUE INDEX uq_owner_invite_pendente
  ON organization_owner_invites (organization_id, email)
  WHERE usado_em IS NULL AND revogado_em IS NULL;
CREATE INDEX idx_owner_invites_org ON organization_owner_invites (organization_id, criado_em DESC);

-- ── Auditoria do control plane ───────────────────────────────────────────────────────────────
-- É LOG: a ordem monotônica é o ponto, então a chave é identidade sequencial (não é id de recurso
-- exposto em URL de mutação). `actor_email` é retrato: o rastro sobrevive ao admin ser removido.
CREATE TABLE platform_audit_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_admin_id UUID REFERENCES platform_admins (id) ON DELETE SET NULL,
  actor_email TEXT NOT NULL CHECK (btrim(actor_email) <> ''),
  action TEXT NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  entity_type TEXT NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{1,63}$'),
  entity_id TEXT,
  organization_id UUID REFERENCES organizations (id) ON DELETE SET NULL,
  before JSONB NOT NULL DEFAULT 'null'::jsonb,
  after JSONB NOT NULL DEFAULT 'null'::jsonb
);
CREATE INDEX idx_platform_audit_recente ON platform_audit_logs (criado_em DESC, id DESC);
CREATE INDEX idx_platform_audit_org ON platform_audit_logs (organization_id, criado_em DESC);
CREATE INDEX idx_platform_audit_action ON platform_audit_logs (action, criado_em DESC);

-- ── Invariante: sempre existe um platform_owner ativo ────────────────────────────────────────
-- Conferido DENTRO da transação da mutação, não por leitura otimista antes dela.
CREATE FUNCTION platform_admin_owners_ativos() RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT count(*)::int FROM public.platform_admins
   WHERE papel = 'platform_owner' AND status = 'active'
$fn$;

-- Trigger de rede: UPDATE/DELETE que zere os owners ativos é recusado no banco, mesmo que a
-- checagem da aplicação seja esquecida um dia. O primeiro owner (0 → 1) continua podendo nascer.
CREATE FUNCTION platform_admin_proteger_ultimo_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE era_owner_ativo BOOLEAN;
BEGIN
  era_owner_ativo := OLD.papel = 'platform_owner' AND OLD.status = 'active';
  IF NOT era_owner_ativo THEN RETURN COALESCE(NEW, OLD); END IF;
  IF TG_OP = 'UPDATE' AND NEW.papel = 'platform_owner' AND NEW.status = 'active' THEN
    RETURN NEW;
  END IF;
  IF public.platform_admin_owners_ativos() <= 1 THEN
    RAISE EXCEPTION 'platform: o último platform_owner ativo não pode ser removido nem rebaixado'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$fn$;

CREATE TRIGGER trg_platform_admin_ultimo_owner
  BEFORE UPDATE OR DELETE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION platform_admin_proteger_ultimo_owner();

-- ── Gate de bootstrap interno (Tenant #1) ────────────────────────────────────────────────────
-- Serializa a decisão: dois pedidos simultâneos não podem ambos ver "zero Organizations". O lock
-- é de TRANSAÇÃO — solta no COMMIT/ROLLBACK. O segundo pedido espera, vê 1 e é recusado.
--
-- Não olha nome de Organization. Nunca. O que autoriza é a AUSÊNCIA de qualquer Organization.
CREATE FUNCTION platform_bootstrap_reservar() RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE n INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('oria:platform:bootstrap-tenant-1'));
  SELECT count(*)::int INTO n FROM public.organizations;
  RETURN n;
END
$fn$;

-- ── Read models globais ──────────────────────────────────────────────────────────────────────
-- Paginação por cursor (criado_em, id): estável sob inserção concorrente, ao contrário de OFFSET.

CREATE FUNCTION platform_listar_organizations(
  p_status TEXT, p_busca TEXT, p_limite INTEGER, p_cursor_em TIMESTAMPTZ, p_cursor_id UUID
) RETURNS TABLE (
  id UUID, nome TEXT, status TEXT, criado_em TIMESTAMPTZ,
  store_id UUID, store_nome TEXT, owners_ativos INTEGER,
  plano_chave TEXT, plano_nome TEXT, onboarding_status TEXT, onboarding_step TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT o.id, o.nome, o.status, o.criado_em,
         s.id, s.nome,
         (SELECT count(*)::int FROM public.organization_members m
            JOIN public.users u ON u.id = m.user_id
           WHERE m.organization_id = o.id AND m.papel = 'owner' AND u.status = 'active'),
         p.chave, p.nome,
         os.status,
         (SELECT st.step_id FROM public.onboarding_steps st
           WHERE st.organization_id = o.id AND st.requirement = 'required' AND st.status <> 'complete'
           ORDER BY st.step_id LIMIT 1)
    FROM public.organizations o
    LEFT JOIN public.stores s ON s.organization_id = o.id AND s.ativa
    LEFT JOIN public.organization_subscriptions sub
           ON sub.organization_id = o.id AND sub.status = 'active'
    LEFT JOIN public.plans p ON p.id = sub.plan_id
    LEFT JOIN public.onboarding_sessions os ON os.organization_id = o.id
   WHERE (p_status IS NULL OR o.status = p_status)
     AND (p_busca IS NULL OR o.nome ILIKE '%' || p_busca || '%')
     AND (p_cursor_em IS NULL OR (o.criado_em, o.id) < (p_cursor_em, p_cursor_id))
   ORDER BY o.criado_em DESC, o.id DESC
   LIMIT p_limite
$fn$;

-- Existência + estado, sem trazer dado de tenant. É o que as rotas usam para decidir 404 antes de
-- abrir contexto de Organization.
CREATE FUNCTION platform_organization_resumo(p_org UUID)
RETURNS TABLE (id UUID, nome TEXT, status TEXT, criado_em TIMESTAMPTZ, store_id UUID, store_nome TEXT, store_ativa BOOLEAN, loja_legada TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT o.id, o.nome, o.status, o.criado_em, s.id, s.nome, s.ativa, s.loja_legada
    FROM public.organizations o
    LEFT JOIN public.stores s ON s.organization_id = o.id
   WHERE o.id = p_org
$fn$;

-- Organizations que os jobs/schedulers podem processar. Suspensa some daqui — é assim que a
-- suspensão vira efeito e não rótulo.
CREATE FUNCTION platform_organizations_ativas()
RETURNS TABLE (id UUID, nome TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT o.id, o.nome FROM public.organizations o WHERE o.status = 'active' ORDER BY o.criado_em, o.id
$fn$;

CREATE FUNCTION platform_listar_membros(p_org UUID)
RETURNS TABLE (user_id UUID, email TEXT, nome TEXT, papel TEXT, status TEXT, criado_em TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.id, u.email, u.nome, m.papel, u.status, m.criado_em
    FROM public.organization_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.organization_id = p_org
   ORDER BY (m.papel = 'owner') DESC, u.email
$fn$;

-- Owners ATIVOS de uma Organization, contados dentro da transação da mutação. É o que impede
-- "Organization sem owner".
CREATE FUNCTION platform_owners_ativos(p_org UUID) RETURNS INTEGER
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT count(*)::int FROM public.organization_members m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.organization_id = p_org AND m.papel = 'owner' AND u.status = 'active'
$fn$;

CREATE FUNCTION platform_listar_users(p_busca TEXT, p_status TEXT, p_limite INTEGER, p_cursor_em TIMESTAMPTZ, p_cursor_id UUID)
RETURNS TABLE (
  id UUID, email TEXT, nome TEXT, status TEXT, criado_em TIMESTAMPTZ, ultimo_login_em TIMESTAMPTZ,
  organizations JSONB
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT u.id, u.email, u.nome, u.status, u.criado_em, u.ultimo_login_em,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object('id', o.id, 'nome', o.nome, 'papel', m.papel, 'status', o.status)
                            ORDER BY o.nome)
             FROM public.organization_members m
             JOIN public.organizations o ON o.id = m.organization_id
            WHERE m.user_id = u.id
         ), '[]'::jsonb)
    FROM public.users u
   WHERE (p_busca IS NULL OR u.email ILIKE '%' || p_busca || '%' OR COALESCE(u.nome, '') ILIKE '%' || p_busca || '%')
     AND (p_status IS NULL OR u.status = p_status)
     AND (p_cursor_em IS NULL OR (u.criado_em, u.id) < (p_cursor_em, p_cursor_id))
   ORDER BY u.criado_em DESC, u.id DESC
   LIMIT p_limite
$fn$;

CREATE FUNCTION platform_listar_onboardings(p_status TEXT, p_limite INTEGER, p_cursor_em TIMESTAMPTZ, p_cursor_id UUID)
RETURNS TABLE (
  organization_id UUID, organization_nome TEXT, status TEXT,
  current_step TEXT, completed_steps TEXT[], blocked_step TEXT, last_error_code TEXT,
  atualizado_em TIMESTAMPTZ
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT os.organization_id, o.nome, os.status,
         (SELECT st.step_id FROM public.onboarding_steps st
           WHERE st.organization_id = os.organization_id AND st.requirement = 'required' AND st.status <> 'complete'
           ORDER BY st.step_id LIMIT 1),
         COALESCE((SELECT array_agg(st.step_id ORDER BY st.step_id) FROM public.onboarding_steps st
                    WHERE st.organization_id = os.organization_id AND st.status = 'complete'), '{}'),
         (SELECT st.step_id FROM public.onboarding_steps st
           WHERE st.organization_id = os.organization_id AND st.status = 'blocked'
           ORDER BY st.step_id LIMIT 1),
         (SELECT st.last_error_code FROM public.onboarding_steps st
           WHERE st.organization_id = os.organization_id AND st.status = 'blocked' AND st.last_error_code IS NOT NULL
           ORDER BY st.step_id LIMIT 1),
         os.atualizado_em
    FROM public.onboarding_sessions os
    JOIN public.organizations o ON o.id = os.organization_id
   WHERE (p_status IS NULL OR os.status = p_status)
     AND (p_cursor_em IS NULL OR (os.atualizado_em, os.organization_id) < (p_cursor_em, p_cursor_id))
   ORDER BY os.atualizado_em DESC, os.organization_id DESC
   LIMIT p_limite
$fn$;

CREATE FUNCTION platform_listar_passos(p_org UUID)
RETURNS TABLE (step_id TEXT, requirement TEXT, status TEXT, last_error_code TEXT, tentativas INTEGER,
               completed_at TIMESTAMPTZ, atualizado_em TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT st.step_id, st.requirement, st.status, st.last_error_code, st.tentativas, st.completed_at, st.atualizado_em
    FROM public.onboarding_steps st WHERE st.organization_id = p_org ORDER BY st.step_id
$fn$;

-- Integrações: SÓ o estado. `config` e `integration_secrets` não passam por aqui — o display_name
-- é derivado (provider + escopo), e o código de erro é o vocabulário fechado PROVIDER_*.
CREATE FUNCTION platform_listar_integracoes(
  p_org UUID, p_provider TEXT, p_status TEXT, p_limite INTEGER, p_cursor_em TIMESTAMPTZ, p_cursor_id BIGINT
) RETURNS TABLE (
  id BIGINT, organization_id UUID, organization_nome TEXT, provider TEXT, status TEXT,
  display_name TEXT, escopo TEXT, criado_em TIMESTAMPTZ, atualizado_em TIMESTAMPTZ,
  segredos_validos INTEGER, segredos_vencidos INTEGER, last_error_code TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT i.id, i.organization_id, o.nome, i.provider, i.status,
         i.provider || CASE WHEN i.escopo IS NULL THEN '' ELSE ' · ' || i.escopo END,
         i.escopo, i.criado_em, i.atualizado_em,
         (SELECT count(*)::int FROM public.integration_secrets s
           WHERE s.integration_id = i.id AND (s.expires_at IS NULL OR s.expires_at > now())),
         (SELECT count(*)::int FROM public.integration_secrets s
           WHERE s.integration_id = i.id AND s.expires_at IS NOT NULL AND s.expires_at <= now()),
         (SELECT st.last_error_code FROM public.onboarding_steps st
           WHERE st.organization_id = i.organization_id
             AND st.status = 'blocked' AND st.last_error_code IS NOT NULL
             AND st.step_id = CASE i.provider WHEN 'google_ads' THEN 'google' WHEN 'openai' THEN 'openai_byok' ELSE i.provider END
           LIMIT 1)
    FROM public.integrations i
    LEFT JOIN public.organizations o ON o.id = i.organization_id
   WHERE (p_org IS NULL OR i.organization_id = p_org)
     AND (p_provider IS NULL OR i.provider = p_provider)
     AND (p_status IS NULL OR i.status = p_status)
     AND (p_cursor_em IS NULL OR (i.atualizado_em, i.id) < (p_cursor_em, p_cursor_id))
   ORDER BY i.atualizado_em DESC, i.id DESC
   LIMIT p_limite
$fn$;

-- Jobs: `dono` NÃO sai (é identificador de worker/host). Vira o booleano `ocupado`.
CREATE FUNCTION platform_listar_jobs(p_org UUID, p_limite INTEGER, p_cursor_job TEXT, p_cursor_org UUID)
RETURNS TABLE (job TEXT, organization_id UUID, organization_nome TEXT, ocupado BOOLEAN,
               iniciado_em TIMESTAMPTZ, ate TIMESTAMPTZ, proxima_em TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT l.job, l.organization_id, o.nome, (l.ate > now()), l.iniciado_em, l.ate, l.proxima_em
    FROM public.job_leases l
    LEFT JOIN public.organizations o ON o.id = l.organization_id
   WHERE (p_org IS NULL OR l.organization_id = p_org)
     AND (p_cursor_job IS NULL OR (l.job, l.organization_id) > (p_cursor_job, p_cursor_org))
   ORDER BY l.job, l.organization_id
   LIMIT p_limite
$fn$;

-- Webhooks: `headers` e `body` NÃO saem. São payload cru, com PII.
CREATE FUNCTION platform_listar_webhooks(
  p_org UUID, p_verificado BOOLEAN, p_limite INTEGER, p_cursor_em TIMESTAMPTZ, p_cursor_id BIGINT
) RETURNS TABLE (
  id BIGINT, recebido_em TIMESTAMPTZ, verificado BOOLEAN, metodo_auth TEXT, event_name TEXT,
  organization_id UUID, organization_nome TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT w.id, w.recebido_em, w.verificado, w.metodo_auth, w.event_name, w.organization_id, o.nome
    FROM public.webhook_eventos w
    LEFT JOIN public.organizations o ON o.id = w.organization_id
   WHERE (p_org IS NULL OR w.organization_id = p_org)
     AND (p_verificado IS NULL OR w.verificado = p_verificado)
     AND (p_cursor_em IS NULL OR (w.recebido_em, w.id) < (p_cursor_em, p_cursor_id))
   ORDER BY w.recebido_em DESC, w.id DESC
   LIMIT p_limite
$fn$;

-- Contagens da visão geral. Fato, não estimativa.
CREATE FUNCTION platform_overview()
RETURNS TABLE (
  organizations_total INTEGER, organizations_ativas INTEGER, organizations_suspensas INTEGER,
  onboardings_em_andamento INTEGER, onboardings_bloqueados INTEGER, onboardings_concluidos INTEGER,
  integracoes_conectadas INTEGER, integracoes_erro INTEGER, integracoes_desconectadas INTEGER
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT
    (SELECT count(*)::int FROM public.organizations),
    (SELECT count(*)::int FROM public.organizations WHERE status = 'active'),
    (SELECT count(*)::int FROM public.organizations WHERE status = 'suspended'),
    (SELECT count(*)::int FROM public.onboarding_sessions WHERE status = 'in_progress'),
    (SELECT count(*)::int FROM public.onboarding_sessions WHERE status = 'blocked'),
    (SELECT count(*)::int FROM public.onboarding_sessions WHERE status = 'complete'),
    (SELECT count(*)::int FROM public.integrations WHERE status = 'connected'),
    (SELECT count(*)::int FROM public.integrations WHERE status = 'error'),
    (SELECT count(*)::int FROM public.integrations WHERE status NOT IN ('connected', 'error'))
$fn$;

-- Consome um convite de owner: liga a pessoa à Organization que JÁ existe. Uso único, sob FOR
-- UPDATE — um segundo consumo concorrente espera e vê 'usado'. ROLLBACK devolve o convite.
CREATE FUNCTION platform_consumir_convite(p_hash TEXT, p_user UUID)
RETURNS TABLE (convite_id UUID, organization_id UUID, email TEXT, papel TEXT, motivo TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE c public.organization_owner_invites%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.organization_owner_invites i WHERE i.token_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, 'desconhecido'::text; RETURN;
  END IF;
  IF c.usado_em IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, 'usado'::text; RETURN;
  END IF;
  IF c.revogado_em IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, 'revogado'::text; RETURN;
  END IF;
  IF c.expira_em <= now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, NULL::text, NULL::text, 'expirado'::text; RETURN;
  END IF;
  UPDATE public.organization_owner_invites
     SET usado_em = now(), usado_por = p_user
   WHERE organization_owner_invites.id = c.id;
  RETURN QUERY SELECT c.id, c.organization_id, c.email, c.papel, 'ok'::text;
END
$fn$;

-- Nenhuma delas é pública. Quando o control plane ganhar role própria (passo posterior, com o
-- precedente do OPS-14), o GRANT EXECUTE nessas funções é a única mudança necessária.
REVOKE ALL ON FUNCTION platform_admin_owners_ativos() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_bootstrap_reservar() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_organizations(TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_organization_resumo(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_organizations_ativas() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_membros(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_owners_ativos(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_users(TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_onboardings(TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_passos(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_integracoes(UUID, TEXT, TEXT, INTEGER, TIMESTAMPTZ, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_jobs(UUID, INTEGER, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_listar_webhooks(UUID, BOOLEAN, INTEGER, TIMESTAMPTZ, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_overview() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_consumir_convite(TEXT, UUID) FROM PUBLIC;

-- ── Plano técnico `internal` (Tenant #1) ─────────────────────────────────────────────────────
-- É APENAS DADO. Não bypassa nada, não implica allow-all: as features são explícitas, e as duas
-- ausentes (instagram, advancedAutomations) são negadas como qualquer outra ausência.
-- A lista espelha config/entitlements/tenant1-entitlements.json; um teste compara as duas.
INSERT INTO plans (chave, nome, descricao, status)
VALUES ('internal', 'Internal',
        'Plano técnico da operação interna (Tenant #1). Não é plano comercial: pricing e billing seguem em aberto (PD-005/PD-009).',
        'active');

INSERT INTO plan_features (plan_id, feature, habilitada)
SELECT p.id, f, true FROM plans p, unnest(ARRAY[
  'catalog',
  'creative_clean_angles',
  'creative_funnel_visual',
  'creative_generator',
  'creative_multi_product',
  'creative_remarketing',
  'exchanges',
  'financial',
  'refunds',
  'whatsapp'
]::platform_feature[]) AS f
WHERE p.chave = 'internal';
