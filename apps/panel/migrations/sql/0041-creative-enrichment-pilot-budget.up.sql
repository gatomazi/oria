-- Fase F.2.B · piloto controlado de Product Enrichment real — reserva atômica de concorrência e
-- orçamento, ANTES de qualquer chamada paga à OpenAI (§2 da direção).
--
-- Por que uma tabela GLOBAL, não tenant-owned: o teto do piloto (no máximo 3 requisições HTTP, no
-- máximo US$ 0,05) é do PILOTO INTEIRO, não por Organization — teria de somar entre todas as
-- Organizations de qualquer forma, o que RLS normal não permite fazer com segurança. Por isso esta
-- tabela é classificada como global/privada no manifesto de tenancy (mesma categoria de
-- `job_leases`/`external_resource_claims`): só as duas funções SECURITY DEFINER abaixo a tocam, a
-- role da aplicação não lê nem escreve nela diretamente, e nenhuma delas devolve dado de OUTRA
-- Organization além do resultado da própria reserva.
--
-- Mecanismo:
--   `creative_enrichment_pilot_reservar(...)` — chamada ANTES de qualquer requisição à OpenAI.
--   Serializa via `pg_advisory_xact_lock` (mesmo padrão já usado em 0019 para o bootstrap do platform
--   admin), libera reservas travadas por TTL (crash/timeout do NOSSO processo, nunca da OpenAI —
--   ver comentário na função), confere se já há uma tentativa em andamento para o MESMO produto
--   (nunca duas chamadas simultâneas para o mesmo produto), confere o orçamento agregado do piloto
--   INTEIRO (todas as tentativas já feitas, sucesso OU falha — "conte inclusive tentativas
--   malsucedidas"), e só então insere a reserva. Tudo dentro de UMA única instrução (transação
--   implícita, curta) — o lock nunca fica preso esperando a rede da OpenAI, que acontece DEPOIS
--   desta chamada retornar.
--
--   `creative_enrichment_pilot_finalizar(...)` — chamada depois do resultado real (sucesso ou
--   falha), grava o modelo servido e o custo REAL a partir do `usage` reportado.
--
-- Aditiva e reversível: duas tabelas/funções novas; nada existente muda.

CREATE TABLE creative_enrichment_pilot_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Guardado só para auditoria (qual Organization pediu) — NÃO usado para isolar leitura: o
  -- orçamento é do piloto inteiro, de propósito.
  organization_id UUID NOT NULL,
  product_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'succeeded', 'failed')),
  model TEXT,
  -- Reservado ANTES da chamada, no pior caso permitido (§3: "reserva prévia conservadora"); nunca
  -- diminuído depois — mesmo numa falha, o slot já foi gasto (item "conte inclusive tentativas
  -- malsucedidas").
  cost_usd_estimated_cents INTEGER NOT NULL CHECK (cost_usd_estimated_cents >= 0),
  -- Preenchido só depois, a partir do `usage` real reportado pela OpenAI — nunca antes de existir.
  cost_usd_real_cents INTEGER CHECK (cost_usd_real_cents IS NULL OR cost_usd_real_cents >= 0),
  error_code TEXT,
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- No máximo UMA tentativa "em andamento" por produto — é isto que fecha a janela de cobrança
-- concorrente: duas requisições simultâneas para o mesmo produto nunca conseguem inserir as duas.
CREATE UNIQUE INDEX uq_creative_enrichment_pilot_attempts_inflight
  ON creative_enrichment_pilot_attempts (organization_id, product_id) WHERE status = 'reserved';

CREATE FUNCTION creative_enrichment_pilot_reservar(
  p_organization_id UUID, p_product_id UUID, p_custo_estimado_centavos INTEGER,
  p_limite_chamadas INTEGER, p_limite_centavos INTEGER, p_ttl_segundos INTEGER
) RETURNS TABLE(ok BOOLEAN, motivo TEXT, attempt_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_id UUID;
  v_chamadas INTEGER;
  v_centavos INTEGER;
BEGIN
  IF p_custo_estimado_centavos < 0 OR p_limite_chamadas < 0 OR p_limite_centavos < 0 OR p_ttl_segundos < 0 THEN
    RAISE EXCEPTION 'creative_enrichment_pilot_reservar: parâmetros negativos não são válidos';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('oria:creative:enrichment-pilot-budget'));

  -- TTL/recuperação: uma reserva travada (nosso PROCESSO crashou ou nunca respondeu — não é uma
  -- resposta tardia da OpenAI, que já teria virado 'succeeded'/'failed' antes disso) libera o slot
  -- POR PRODUTO para uma tentativa nova. Isto NUNCA desconta do orçamento agregado abaixo — a
  -- reserva já foi contada no momento em que foi criada, e continua contando depois de expirada
  -- (linha "conte inclusive tentativas malsucedidas": um crash é, na pior hipótese, uma tentativa
  -- que pode ter chegado a sair pela rede).
  UPDATE creative_enrichment_pilot_attempts
    SET status = 'failed', error_code = 'reservation_expired', finished_at = now()
    WHERE status = 'reserved' AND reserved_at < now() - make_interval(secs => p_ttl_segundos);

  IF EXISTS (
    SELECT 1 FROM creative_enrichment_pilot_attempts
    WHERE organization_id = p_organization_id AND product_id = p_product_id AND status = 'reserved'
  ) THEN
    RETURN QUERY SELECT false, 'em_andamento'::text, NULL::uuid;
    RETURN;
  END IF;

  -- Orçamento do PILOTO INTEIRO — todas as Organizations, toda tentativa já feita (reservada,
  -- sucesso ou falha). Nunca um contador só desta Organization.
  SELECT count(*)::int, COALESCE(sum(cost_usd_estimated_cents), 0)::int
    INTO v_chamadas, v_centavos FROM creative_enrichment_pilot_attempts;

  IF v_chamadas >= p_limite_chamadas OR (v_centavos + p_custo_estimado_centavos) > p_limite_centavos THEN
    RETURN QUERY SELECT false, 'orcamento_excedido'::text, NULL::uuid;
    RETURN;
  END IF;

  INSERT INTO creative_enrichment_pilot_attempts (organization_id, product_id, cost_usd_estimated_cents)
    VALUES (p_organization_id, p_product_id, p_custo_estimado_centavos)
    RETURNING id INTO v_id;

  RETURN QUERY SELECT true, NULL::text, v_id;
END
$fn$;

CREATE FUNCTION creative_enrichment_pilot_finalizar(
  p_attempt_id UUID, p_status TEXT, p_model TEXT, p_custo_real_centavos INTEGER, p_error_code TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_linhas INTEGER;
BEGIN
  IF p_status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'creative_enrichment_pilot_finalizar: status inválido (%), só succeeded ou failed', p_status;
  END IF;
  UPDATE creative_enrichment_pilot_attempts
    SET status = p_status, model = p_model, cost_usd_real_cents = p_custo_real_centavos,
        error_code = p_error_code, finished_at = now()
    WHERE id = p_attempt_id AND status = 'reserved';
  GET DIAGNOSTICS v_linhas = ROW_COUNT;
  RETURN v_linhas > 0;
END
$fn$;

-- A role da aplicação não lê/escreve a tabela diretamente — só através das funções acima (mesmo
-- modelo de `job_leases`/`external_resource_claims`, ver tenancy-manifest.js).
REVOKE ALL ON creative_enrichment_pilot_attempts FROM PUBLIC;
GRANT EXECUTE ON FUNCTION creative_enrichment_pilot_reservar(UUID, UUID, INTEGER, INTEGER, INTEGER, INTEGER) TO PUBLIC;
GRANT EXECUTE ON FUNCTION creative_enrichment_pilot_finalizar(UUID, TEXT, TEXT, INTEGER, TEXT) TO PUBLIC;
