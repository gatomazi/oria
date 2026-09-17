-- Fase 2 · identidade individual, sessões revogáveis e papéis mínimos (PD-004: owner/member).
--
-- `users` e `sessions` são GLOBAIS por desenho: a pessoa existe antes de escolher Organization, e
-- a mesma pessoa pode pertencer a mais de uma (User C). O vínculo com tenant é
-- `organization_members`, que é tenant-owned e continua sob RLS.

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  nome TEXT,
  -- scrypt$1$N$r$p$salt$hash (lib/auth/password.js). Nunca texto claro.
  password_hash TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_login_em TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_users_email ON users (email);

-- A chave é o SHA-256 do token do cookie: vazar a tabela não entrega sessão viva.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- 'senha' = login individual; 'legado' = ADMIN_PASSWORD atrás de ALLOW_LEGACY_ADMIN_PASSWORD.
  metodo TEXT NOT NULL CHECK (metodo IN ('senha', 'legado')),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL,
  ultimo_uso_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  revogada_em TIMESTAMPTZ,
  revogada_por UUID REFERENCES users (id) ON DELETE SET NULL,
  motivo_revogacao TEXT,
  CHECK (expira_em > criado_em)
);
CREATE INDEX idx_sessions_user_ativas ON sessions (user_id) WHERE revogada_em IS NULL;
CREATE INDEX idx_sessions_expira ON sessions (expira_em);

ALTER TABLE organization_members
  ADD CONSTRAINT fk_organization_members_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE organization_members
  ADD CONSTRAINT ck_organization_members_papel CHECK (papel IN ('owner', 'member'));
CREATE INDEX idx_organization_members_user ON organization_members (user_id);

-- Memberships de UMA pessoa, lidas antes de existir contexto de tenant (organization_members está
-- sob RLS forçada). O user_id vem da sessão validada no servidor, nunca do request. Devolve dado,
-- não decide nada: escolher a Organization ativa é da Fase 3.
CREATE FUNCTION auth_memberships(p_user_id UUID)
RETURNS TABLE (organization_id UUID, organization_nome TEXT, papel TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT m.organization_id, o.nome, m.papel
    FROM public.organization_members m
    JOIN public.organizations o ON o.id = m.organization_id
   WHERE m.user_id = p_user_id AND o.status = 'active'
   ORDER BY o.nome, m.organization_id
$fn$;
REVOKE ALL ON FUNCTION auth_memberships(UUID) FROM PUBLIC;
