-- ── Aceite do convite de owner (Tenant Plane) ────────────────────────────────────────────────
--
-- A 0019 deixou `platform_consumir_convite(hash, user)` pronta: ela grava `usado_em`/`usado_por` e
-- devolve (convite_id, organization_id, email, papel, motivo). O que faltava para o painel poder
-- ligar essa função a uma rota é o passo ANTERIOR: quem aceita um convite ainda **não tem conta**,
-- e `platform_consumir_convite` exige o UUID do usuário (a tabela tem
-- `CHECK ((usado_em IS NOT NULL) = (usado_por IS NOT NULL))` — `p_user` não pode ser NULL).
--
-- Ou seja: para criar a pessoa é preciso saber o e-mail do convite, e para saber o e-mail do
-- convite seria preciso consumi-lo. `organization_owner_invites` é global privada
-- (tenancy-manifest.js: TABELAS_GLOBAIS_PRIVADAS) — a role da aplicação não a lê, e não deve ler.
--
-- A saída é uma leitura que NÃO consome, com a mesma projeção e o mesmo vocabulário de `motivo`:
--
--     platform_convite_pendente(hash)  → trava a linha (FOR UPDATE), não escreve
--       … a rota cria/resolve o usuário …
--     platform_consumir_convite(hash, user)  → grava usado_em/usado_por
--
-- As duas rodam na MESMA transação. O `FOR UPDATE` da primeira é o que torna o par atômico: um
-- segundo aceite concorrente espera o COMMIT/ROLLBACK do primeiro e então lê a linha já marcada,
-- devolvendo `usado`. Um ROLLBACK em qualquer ponto devolve o convite intacto.
--
-- `motivo` continua sendo o vocabulário fechado da 0019: ok | desconhecido | usado | revogado |
-- expirado. A rota do painel traduz TODOS os quatro casos de falha para a MESMA resposta ao
-- convidado (o motivo real fica no log do servidor, sem o token).
--
-- Reversível: a 0020 só ACRESCENTA uma função de leitura. `DROP FUNCTION` desfaz sem tocar em dado.

CREATE FUNCTION platform_convite_pendente(p_hash TEXT)
RETURNS TABLE (convite_id UUID, organization_id UUID, email TEXT, papel TEXT, motivo TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE c public.organization_owner_invites%ROWTYPE;
BEGIN
  -- Mesma trava de `platform_consumir_convite`: a leitura já serializa os aceites concorrentes.
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
  RETURN QUERY SELECT c.id, c.organization_id, c.email, c.papel, 'ok'::text;
END
$fn$;

-- Como toda função da 0019: fora de PUBLIC. Quem a executa é a role da aplicação do painel, que
-- recebe o `GRANT EXECUTE` pelo SQL do OPS-14 (lib/platform/app-role.js · FUNCOES_DA_APLICACAO) —
-- o mesmo caminho de `auth_memberships`, `onboarding_consumir_convite` e das demais SECURITY
-- DEFINER que o painel chama. O GRANT não mora numa migration porque a role é objeto do CLUSTER:
-- o nome dela é escolhido no provisionamento (nos testes é sorteado por arquivo) e ela pode nem
-- existir quando a migration roda — um `GRANT … TO oria_app` aqui quebraria todo banco novo.
REVOKE ALL ON FUNCTION platform_convite_pendente(TEXT) FROM PUBLIC;
