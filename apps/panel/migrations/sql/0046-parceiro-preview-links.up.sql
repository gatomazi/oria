-- Parcerias · link público de leitura para o PRÓPRIO parceiro ver as vendas, a comissão e o saldo dele.
--
-- NÃO é um portal do afiliado (isso continua fora de escopo: sem login, sem senha, sem conta, sem e-mail).
-- É uma CAPABILITY URL — mesma família de `publico_organization_do_pedido`/`_da_midia`/`_do_agente` (0012):
-- um segredo opaco de 256 bits que, sozinho, resolve a Organization; quem tem o link, vê; ninguém mais.
--
-- O token cru NUNCA é persistido — só o SHA-256 dele (`key_hash`), no mesmo desenho de
-- `organization_owner_invites.token_hash` (0019/0020). Revogar/gerar de novo NUNCA reescreve a linha
-- antiga: fecha ela (`status='revoked'`) e insere uma nova — o histórico de quem teve acesso a quê
-- fica preservado, no mesmo espírito de `partner_coupon_links` (retomar cria vínculo novo).
--
-- RLS igual a toda tabela do módulo. A ÚNICA leitura pré-autenticação (resolver a Organization a
-- partir só do hash) passa pela função SECURITY DEFINER no fim deste arquivo — nunca por uma query
-- direta nesta tabela sem contexto (tenant-runtime.js recusaria: TENANT_CONTEXT_REQUIRED).

CREATE TABLE partner_preview_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,

  key_hash TEXT NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'), -- sha256 hex do token opaco de 256 bits
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),

  last_accessed_at TIMESTAMPTZ,
  access_count BIGINT NOT NULL DEFAULT 0 CHECK (access_count >= 0),

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,

  CONSTRAINT fk_partner_preview_links_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_preview_links_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT uq_partner_preview_links_key_hash UNIQUE (key_hash),
  CONSTRAINT ck_partner_preview_links_revoked CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
-- Um lookup só por parceiro ativo (a tela do owner mostra o link vigente sem varrer o histórico).
CREATE UNIQUE INDEX uq_partner_preview_links_ativo ON partner_preview_links (organization_id, partner_id) WHERE status = 'active';

ALTER TABLE partner_preview_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_preview_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenancy_isolamento ON partner_preview_links
  USING (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);

-- Resolve a Organization a partir só do hash — mesma forma de `publico_organization_do_pedido` (0012):
-- `status='active'` já embutido na condição, então um link revogado (ou um hash que nunca existiu)
-- devolve NULL nos dois casos, sem diferenciar — a mesma lição de "convite" (0019/0020): quem tenta
-- não distingue "nunca existiu" de "foi revogado". `count(*) = 1` é redundante com a UNIQUE, mas
-- segue a mesma forma defensiva das três funções irmãs.
CREATE FUNCTION publico_organization_do_preview_afiliado(p_hash TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN count(*) = 1 THEN min(organization_id::text)::uuid END
    FROM public.partner_preview_links
   WHERE key_hash = p_hash AND status = 'active'
$fn$;

REVOKE ALL ON FUNCTION publico_organization_do_preview_afiliado(TEXT) FROM PUBLIC;
