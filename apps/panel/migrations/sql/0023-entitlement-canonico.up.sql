-- Entitlement canônico · o Tenant Plane passa a ler a fonte do Control Plane.
--
-- ── O bug que isto conserta ──────────────────────────────────────────────────────────────────
-- O Oria Admin concede plano gravando `organization_subscriptions` + `plan_features`. O painel
-- resolvia entitlement lendo `app_config` com a chave `entitlements` — outra tabela, escrita só por
-- script de linha de comando. Uma Organization criada pela interface nascia com o plano concedido e
-- com o painel enxergando NADA: `carregadorDaOrganizacao` devolvia null, `planoEfetivo` marcava
-- tudo como false, e toda rota com guard respondia 403.
--
-- Foi exatamente o que aconteceu com o Tenant #1: assinatura `internal` ativa, 10 features no plano,
-- zero linhas em `app_config`, e a tela inteira em "Não incluído no plano". Duas fontes de verdade
-- que nunca conversaram.
--
-- ── Por que uma função, e não GRANT nas tabelas ──────────────────────────────────────────────
-- `plans`, `plan_features`, `organization_subscriptions` e `organization_entitlement_overrides` são
-- GLOBAIS PRIVADAS (ver o manifesto de tenancy): a role da aplicação não recebe GRANT nelas, de
-- propósito — são o vocabulário comercial da plataforma, não dado do tenant. Dar SELECT ali
-- exporia o catálogo de planos inteiro a qualquer query do painel.
--
-- A saída é a mesma que o repositório já usa para leitura que atravessa fronteira (`auth_memberships`,
-- os read models do control plane): função SECURITY DEFINER, projeção estreita, REVOKE de PUBLIC e
-- GRANT explícito para a role da aplicação. O painel pergunta "o que ESTA Organization pode",
-- nunca "quais planos existem".
--
-- ── A regra, idêntica à do Control Plane ─────────────────────────────────────────────────────
--
--     acesso_efetivo(org, feature) =
--           organization.status = 'active'
--       AND existe assinatura com status = 'active'
--       AND (  override explícito → override.permitido
--            ∨ plan_features      → habilitada
--            ∨ false )
--
--     precedência:  override da Organization  >  plano  >  false
--
-- Organization suspensa nega tudo, inclusive o que o override concede. Ausência nega.

-- Estado da Organization para o resolver: uma linha, sempre. É o que distingue "suspensa" de
-- "sem assinatura" de "plano vazio" — três causas diferentes que a UI precisa saber separar para
-- não dizer "não incluído no plano" quando o caso é outro.
CREATE FUNCTION entitlements_estado(p_org UUID)
RETURNS TABLE (organizacao_ativa BOOLEAN, assinatura_ativa BOOLEAN, plano_chave TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT
    COALESCE((SELECT o.status = 'active' FROM public.organizations o WHERE o.id = p_org), false),
    EXISTS (SELECT 1 FROM public.organization_subscriptions s
             WHERE s.organization_id = p_org AND s.status = 'active'),
    (SELECT p.chave FROM public.organization_subscriptions s
        JOIN public.plans p ON p.id = s.plan_id
       WHERE s.organization_id = p_org AND s.status = 'active'
       LIMIT 1);
$fn$;

-- Features efetivas da Organization. Devolve SÓ o que está concedido, com a origem da decisão —
-- ausência é negação, e quem lê não precisa saber que planos existem.
CREATE FUNCTION entitlements_efetivos(p_org UUID)
RETURNS TABLE (feature TEXT, origem TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  WITH estado AS (
    SELECT organizacao_ativa, assinatura_ativa FROM public.entitlements_estado(p_org)
  ),
  plano AS (
    SELECT f.feature::text AS feature, f.habilitada
      FROM public.organization_subscriptions s
      JOIN public.plan_features f ON f.plan_id = s.plan_id
     WHERE s.organization_id = p_org AND s.status = 'active'
  ),
  override AS (
    SELECT o.feature::text AS feature, o.permitido
      FROM public.organization_entitlement_overrides o
     WHERE o.organization_id = p_org
  ),
  -- União das duas origens: o override pode conceder feature que o plano não tem.
  candidatas AS (
    SELECT feature FROM plano
    UNION
    SELECT feature FROM override
  )
  SELECT c.feature,
         CASE WHEN o.feature IS NOT NULL THEN 'override' ELSE 'plano' END
    FROM candidatas c
    LEFT JOIN override o ON o.feature = c.feature
    LEFT JOIN plano   p ON p.feature = c.feature
   CROSS JOIN estado e
   WHERE e.organizacao_ativa
     AND e.assinatura_ativa
     AND COALESCE(o.permitido, p.habilitada, false);
$fn$;

-- Nem uma nem outra é pública. O GRANT para a role da aplicação sai do OPS-14
-- (lib/platform/app-role.js → FUNCOES_DA_APLICACAO), como todas as outras.
REVOKE ALL ON FUNCTION entitlements_estado(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION entitlements_efetivos(UUID) FROM PUBLIC;
