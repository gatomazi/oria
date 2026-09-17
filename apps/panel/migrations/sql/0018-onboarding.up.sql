-- Fase 7 (construção) · onboarding retomável, Organization + Store + owner atômicos, convite do
-- primeiro owner e chave de idempotência explícita.
--
-- Nada aqui cria Organization: a criação é do serviço lib/platform/onboarding.js, atrás de
-- SECOND_TENANT_ENABLED (desligado por padrão). As Organizations que já existem (Tenant #1) não
-- recebem estado de onboarding — não passaram por ele.
--
--   onboarding_sessions        estado do onboarding de UMA Organization (sob RLS forçada)
--   onboarding_steps           um passo técnico por linha (sob RLS forçada)
--   onboarding_invites         convite do primeiro owner: só o SHA-256 do token (global PRIVADA)
--   onboarding_idempotencia    (pessoa, chave) → Organization criada (global PRIVADA)
--
-- Estado de provider NÃO mora aqui: os passos de integração são derivados de integrations +
-- integration_secrets a cada leitura. last_error_code só aceita CÓDIGO (nunca mensagem do provider).

CREATE TABLE onboarding_sessions (
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'blocked', 'complete')),
  -- Retrato da configuração (required/optional/disabled por passo) no momento da criação. Mudar a
  -- configuração depois não reescreve onboarding em andamento.
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  criado_por UUID REFERENCES users (id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em TIMESTAMPTZ,
  CONSTRAINT pk_onboarding_sessions PRIMARY KEY (organization_id),
  CONSTRAINT ck_onboarding_sessions_concluido CHECK ((status = 'complete') = (concluido_em IS NOT NULL))
);

CREATE TABLE onboarding_steps (
  organization_id UUID NOT NULL,
  step_id TEXT NOT NULL CHECK (step_id IN (
    'org_store', 'owner', 'ink', 'meta', 'google', 'ga4', 'openai_byok', 'whatsapp', 'entitlements', 'readiness'
  )),
  requirement TEXT NOT NULL CHECK (requirement IN ('required', 'optional', 'disabled')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'blocked', 'complete', 'skipped')),
  -- Código estável (ex.: PROVIDER_AUTH_FAILED). A forma do CHECK recusa texto livre de provider.
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  tentativas INTEGER NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  completed_at TIMESTAMPTZ,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pk_onboarding_steps PRIMARY KEY (organization_id, step_id),
  CONSTRAINT fk_onboarding_steps_session FOREIGN KEY (organization_id)
    REFERENCES onboarding_sessions (organization_id) ON DELETE CASCADE,
  CONSTRAINT ck_onboarding_steps_completo CHECK ((status = 'complete') = (completed_at IS NOT NULL)),
  CONSTRAINT ck_onboarding_steps_bloqueio CHECK (status <> 'blocked' OR last_error_code IS NOT NULL),
  CONSTRAINT ck_onboarding_steps_desligado CHECK (requirement <> 'disabled' OR status = 'skipped')
);

-- Mesma forma canônica das policies da Fase 1 (INV-07 compara o texto).
ALTER TABLE onboarding_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON onboarding_sessions
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
ALTER TABLE onboarding_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_steps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON onboarding_steps
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Convite do primeiro owner. O token cru só existe na resposta de quem emitiu; aqui fica o SHA-256.
-- organization_id é preenchido no consumo, dentro da mesma transação que cria a Organization
-- (FK adiada: a Organization nasce depois do consumo, no mesmo COMMIT).
CREATE TABLE onboarding_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  usado_em TIMESTAMPTZ,
  organization_id UUID REFERENCES organizations (id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
  CHECK (expira_em > criado_em),
  -- Convite não usado não tem Organization (a volta a NULL só acontece se a Organization sumir).
  CHECK (usado_em IS NOT NULL OR organization_id IS NULL)
);

-- Chave de idempotência EXPLÍCITA por pessoa. Repetir a chave devolve a mesma Organization; outra
-- chave cria outra. Nunca "a pessoa já tem uma Organization, devolve essa".
CREATE TABLE onboarding_idempotencia (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  chave_hash TEXT NOT NULL CHECK (chave_hash ~ '^[0-9a-f]{64}$'),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  -- SHA-256 dos parâmetros da criação: a mesma chave com pedido diferente é conflito, não retorno.
  digest TEXT NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chave_hash)
);
CREATE INDEX idx_onboarding_idempotencia_org ON onboarding_idempotencia (organization_id);

-- Reserva (pessoa, chave) para a Organization do CONTEXTO. Devolve quem ficou com a chave: a do
-- contexto (reserva nova) ou a que já a tinha. Concorrência: o segundo INSERT espera o primeiro
-- COMMIT/ROLLBACK na PK — nunca duas Organizations para a mesma chave.
CREATE FUNCTION onboarding_reservar_organizacao(p_user UUID, p_chave_hash TEXT, p_digest TEXT)
RETURNS TABLE (organization_id UUID, digest TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE org UUID := public.integracao_org_do_contexto();
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'onboarding: reserva sem pessoa' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.onboarding_idempotencia (user_id, chave_hash, organization_id, digest)
  VALUES (p_user, p_chave_hash, org, p_digest)
  ON CONFLICT (user_id, chave_hash) DO NOTHING;
  RETURN QUERY
    SELECT i.organization_id, i.digest FROM public.onboarding_idempotencia i
     WHERE i.user_id = p_user AND i.chave_hash = p_chave_hash;
END
$fn$;

CREATE FUNCTION onboarding_emitir_convite(p_hash TEXT, p_email TEXT, p_expira TIMESTAMPTZ)
RETURNS TABLE (id UUID, expira_em TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  INSERT INTO public.onboarding_invites (token_hash, email, expira_em)
  VALUES (p_hash, p_email, p_expira)
  RETURNING onboarding_invites.id, onboarding_invites.expira_em
$fn$;

-- Consome o convite para a Organization do CONTEXTO. Uso único: a linha fica travada até o fim da
-- transação; um segundo consumo concorrente espera e vê 'usado'. ROLLBACK devolve o convite.
CREATE FUNCTION onboarding_consumir_convite(p_hash TEXT)
RETURNS TABLE (convite_id UUID, email TEXT, motivo TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  org UUID := public.integracao_org_do_contexto();
  c public.onboarding_invites%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.onboarding_invites i WHERE i.token_hash = p_hash FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'desconhecido'::text; RETURN;
  END IF;
  IF c.usado_em IS NOT NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'usado'::text; RETURN;
  END IF;
  IF c.expira_em <= now() THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'expirado'::text; RETURN;
  END IF;
  UPDATE public.onboarding_invites SET usado_em = now(), organization_id = org WHERE onboarding_invites.id = c.id;
  RETURN QUERY SELECT c.id, c.email, 'ok'::text;
END
$fn$;

REVOKE ALL ON FUNCTION onboarding_reservar_organizacao(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION onboarding_emitir_convite(TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION onboarding_consumir_convite(TEXT) FROM PUBLIC;
