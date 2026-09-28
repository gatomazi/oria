-- Parcerias, Afiliados e Collabs · módulo de afiliados PRÓPRIO do Oria (docs/afiliados/arquitetura.md).
--
-- O Oria é o livro-razão das comissões da loja. A INK entra só como fonte de pedidos/catálogo e
-- como provedora de PROMOÇÕES COMUNS (cupom) — nunca do programa de afiliados nativo dela.
--
-- Todas as tabelas nascem NATIVAS (organization_id/store_id obrigatórios desde a criação, FK composta
-- com stores), entram em TABELAS_PLATAFORMA e ficam sob RLS forçada, no mesmo desenho de
-- commerce_products (0031). ORIA-TENANCY-STORE-01: 1 Organization = 1 Store; `store_id` é dado
-- operacional, não preparação para multiloja. Não existe vínculo entre lojas, afiliado compartilhado
-- entre lojas nem agregação entre lojas.
--
-- Valores monetários: BIGINT em centavos de BRL. Percentuais: INTEGER em basis points (1 bps = 0,01%).
-- Datas: TIMESTAMPTZ (UTC no banco); as regras de calendário usam o timezone da loja na aplicação.
--
-- Históricos append-only (versões de contrato, versões de regra de nível, histórico de nível, auditoria):
-- UPDATE/DELETE direto é recusado por trigger AFTER (a RLS WITH CHECK, que roda antes, continua sendo a primeira barreira). DELETE em cascata a partir de `organizations` continua
-- permitido (pg_trigger_depth() > 1), senão nenhuma Organization de teste poderia ser removida.

-- ── Funções de defesa ────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION partnership_bloquear_mutacao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Depth 1 = a operação veio direto de uma query. Depth > 1 = veio de outro trigger (FK ON DELETE CASCADE).
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'tabela % é append-only (% recusado)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- ── Configuração por Organization (1:1) ─────────────────────────────────────────────────────────
CREATE TABLE partnership_settings (
  organization_id UUID PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo' CHECK (btrim(timezone) <> ''),
  -- Avisos in-app de vencimento (dias antes do vencimento).
  alert_days INTEGER[] NOT NULL DEFAULT ARRAY[7, 3, 1],
  -- Alerta de margem: contribuição mínima por item, em bps da receita elegível. Nunca bloqueia pedido.
  min_contribution_bps INTEGER NOT NULL DEFAULT 1000 CHECK (min_contribution_bps BETWEEN 0 AND 10000),
  -- Carteira de benefícios: fração da contribuição pós-parceria positiva e verificada que vira crédito.
  benefit_budget_bps INTEGER NOT NULL DEFAULT 2500 CHECK (benefit_budget_bps BETWEEN 0 AND 10000),
  -- Progressão geral: contar pedidos distintos (padrão) ou unidades.
  progression_counts_by TEXT NOT NULL DEFAULT 'orders' CHECK (progression_counts_by IN ('orders', 'units')),
  downgrade_grace_days INTEGER NOT NULL DEFAULT 30 CHECK (downgrade_grace_days >= 0),
  -- Marca-d'água da reconciliação incremental (pedidos alterados desde então são reavaliados).
  last_reconciled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partnership_settings_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id)
);

-- ── Parceiros ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE partnership_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,

  public_name TEXT NOT NULL CHECK (btrim(public_name) <> '' AND length(public_name) <= 120),
  contact_name TEXT CHECK (contact_name IS NULL OR length(contact_name) <= 160),
  contact_email TEXT CHECK (contact_email IS NULL OR length(contact_email) <= 254),
  contact_phone TEXT CHECK (contact_phone IS NULL OR length(contact_phone) <= 40),
  -- [{ "network": "instagram", "handle": "@x", "url": "https://..." }] — só o necessário, sem dado bancário.
  profiles JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(profiles) = 'array'),
  origin TEXT CHECK (origin IS NULL OR length(origin) <= 120),
  community_region TEXT CHECK (community_region IS NULL OR length(community_region) <= 120),
  internal_notes TEXT CHECK (internal_notes IS NULL OR length(internal_notes) <= 4000),

  -- Candidatura e vínculo comercial são eixos separados.
  application_status TEXT NOT NULL DEFAULT 'candidate' CHECK (application_status IN ('candidate', 'approved', 'rejected')),
  relationship_status TEXT NOT NULL DEFAULT 'draft' CHECK (relationship_status IN ('draft', 'active', 'paused', 'ended')),
  terms_version TEXT,
  terms_accepted_at TIMESTAMPTZ,
  -- O parceiro também tem afiliado NATIVO na INK: a API não expõe isso, então é declaração do lojista.
  -- Enquanto true, atribuições dele vão para revisão (bloqueio de remuneração duplicada).
  legacy_ink_affiliate BOOLEAN NOT NULL DEFAULT false,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_partnership_partners_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT uq_partnership_partners_id_org UNIQUE (id, organization_id)
);
CREATE INDEX idx_partnership_partners_org ON partnership_partners (organization_id, relationship_status);

-- ── Contratos (cabeçalho) e versões econômicas (append-only) ────────────────────────────────────
CREATE TABLE partnership_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  modality TEXT NOT NULL CHECK (modality IN ('coupon', 'collab', 'hybrid')),
  title TEXT NOT NULL CHECK (btrim(title) <> '' AND length(title) <= 160),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partnership_contracts_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partnership_contracts_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT uq_partnership_contracts_id_org UNIQUE (id, organization_id)
);
CREATE INDEX idx_partnership_contracts_partner ON partnership_contracts (organization_id, partner_id);

CREATE TABLE partnership_contract_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  contract_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Toda mudança de estado ou de condição é uma NOVA versão. A vigente numa data T é a de maior
  -- (effective_from, version) com effective_from <= T; só `active` remunera.
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'ended')),
  effective_from TIMESTAMPTZ NOT NULL,

  -- Base remuneratória. Nunca misturar bases sem rótulo.
  commission_basis TEXT NOT NULL CHECK (commission_basis IN ('net_item_revenue_percent', 'verified_margin_percent', 'fixed_per_unit')),
  commission_bps INTEGER CHECK (commission_bps IS NULL OR commission_bps BETWEEN 0 AND 10000),
  fixed_per_unit_cents BIGINT CHECK (fixed_per_unit_cents IS NULL OR fixed_per_unit_cents >= 0),
  -- Cachê por conteúdo: categoria SEPARADA de comissão por venda (não entra no motor de itens).
  fixed_campaign_fee_cents BIGINT CHECK (fixed_campaign_fee_cents IS NULL OR fixed_campaign_fee_cents >= 0),

  conflict_policy TEXT NOT NULL DEFAULT 'collab_precedence' CHECK (conflict_policy IN ('collab_precedence', 'coupon_precedence', 'split_explicit')),
  -- split_explicit: fatia do item paga pelo cupom vs pela collab; a soma tem de fechar 10000.
  split_coupon_bps INTEGER CHECK (split_coupon_bps IS NULL OR split_coupon_bps BETWEEN 0 AND 10000),
  split_collab_bps INTEGER CHECK (split_collab_bps IS NULL OR split_collab_bps BETWEEN 0 AND 10000),
  dual_commission_confirmed_by UUID,

  -- Política de liberação e pagamento (padrão do piloto: entrega + 7 dias, dia 10 do mês seguinte, mínimo R$ 50).
  release_policy TEXT NOT NULL DEFAULT 'delivery_plus_hold' CHECK (release_policy IN ('delivery_plus_hold', 'payment_plus_days')),
  release_hold_days INTEGER NOT NULL DEFAULT 7 CHECK (release_hold_days BETWEEN 0 AND 365),
  payout_day INTEGER NOT NULL DEFAULT 10 CHECK (payout_day BETWEEN 1 AND 28),
  payout_month_offset INTEGER NOT NULL DEFAULT 1 CHECK (payout_month_offset BETWEEN 0 AND 12),
  min_payout_cents BIGINT NOT NULL DEFAULT 5000 CHECK (min_payout_cents >= 0),
  accumulate_below_min BOOLEAN NOT NULL DEFAULT true,
  weekend_shift BOOLEAN NOT NULL DEFAULT true,

  -- Coleta futura de produtos no cluster: padrão seguro é exigir aprovação.
  new_collab_member_policy TEXT NOT NULL DEFAULT 'require_approval' CHECK (new_collab_member_policy IN ('require_approval', 'auto_include')),
  -- Progressão geral: contar pedidos ou unidades para este contrato (rótulo explícito).
  progression_counts_by TEXT CHECK (progression_counts_by IS NULL OR progression_counts_by IN ('orders', 'units')),

  level_key TEXT,
  level_cap_override_reason TEXT,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  approved_by UUID NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_partnership_contract_versions_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partnership_contract_versions_contract FOREIGN KEY (contract_id, organization_id) REFERENCES partnership_contracts (id, organization_id),
  CONSTRAINT uq_partnership_contract_versions_id_org UNIQUE (id, organization_id),
  CONSTRAINT uq_partnership_contract_versions_versao UNIQUE (organization_id, contract_id, version),
  CONSTRAINT ck_partnership_contract_versions_base CHECK (
    (commission_basis IN ('net_item_revenue_percent', 'verified_margin_percent') AND commission_bps IS NOT NULL)
    OR (commission_basis = 'fixed_per_unit' AND fixed_per_unit_cents IS NOT NULL)
  ),
  CONSTRAINT ck_partnership_contract_versions_split CHECK (
    conflict_policy <> 'split_explicit'
    OR (split_coupon_bps IS NOT NULL AND split_collab_bps IS NOT NULL AND split_coupon_bps + split_collab_bps = 10000
        AND dual_commission_confirmed_by IS NOT NULL)
  )
);
CREATE INDEX idx_partnership_contract_versions_vigencia ON partnership_contract_versions (organization_id, contract_id, effective_from DESC, version DESC);
CREATE TRIGGER trg_partnership_contract_versions_append_only AFTER UPDATE OR DELETE ON partnership_contract_versions
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

-- ── Cupons ──────────────────────────────────────────────────────────────────────────────────────
-- Cupom = promoção COMUM da INK. O código comissiona só se estiver aqui, ativo e dentro da vigência.
CREATE TABLE partner_coupon_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  contract_id UUID NOT NULL,

  code_display TEXT NOT NULL CHECK (btrim(code_display) <> '' AND length(code_display) <= 64),
  -- trim + UPPER: mesma normalização usada para casar com `pedidos_ink.promotion_code`.
  code_normalized TEXT NOT NULL CHECK (code_normalized = upper(btrim(code_normalized)) AND code_normalized <> ''),

  discount_kind TEXT CHECK (discount_kind IS NULL OR discount_kind IN ('percentage', 'value')),
  discount_bps INTEGER CHECK (discount_bps IS NULL OR discount_bps BETWEEN 1 AND 10000),
  discount_cents BIGINT CHECK (discount_cents IS NULL OR discount_cents > 0),

  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'pending_validation', 'active', 'paused', 'ended')),

  -- manual = cadastrado à mão a partir de um cupom criado no painel da INK (fallback integral).
  sync_mode TEXT NOT NULL DEFAULT 'manual' CHECK (sync_mode IN ('manual', 'ink_managed')),
  sync_status TEXT NOT NULL DEFAULT 'manual_unverified' CHECK (sync_status IN ('manual_unverified', 'not_created', 'pending', 'confirmed', 'divergent', 'error')),
  ink_promotion_id BIGINT,
  last_synced_at TIMESTAMPTZ,
  sync_error TEXT CHECK (sync_error IS NULL OR length(sync_error) <= 500),

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fk_partner_coupon_links_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_coupon_links_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT fk_partner_coupon_links_contract FOREIGN KEY (contract_id, organization_id) REFERENCES partnership_contracts (id, organization_id),
  CONSTRAINT uq_partner_coupon_links_id_org UNIQUE (id, organization_id),
  CONSTRAINT ck_partner_coupon_links_vigencia CHECK (valid_until IS NULL OR valid_until > valid_from)
);
CREATE INDEX idx_partner_coupon_links_codigo ON partner_coupon_links (organization_id, code_normalized);
CREATE INDEX idx_partner_coupon_links_partner ON partner_coupon_links (organization_id, partner_id);

-- Sem btree_gist (extensão que o Postgres gerenciado nem sempre libera): a sobreposição de vigência
-- do MESMO código na loja é recusada por trigger, sob advisory lock por (organization, código).
CREATE FUNCTION partner_coupon_links_sem_sobreposicao() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ended' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text || ':' || NEW.code_normalized, 0));
  IF EXISTS (
    SELECT 1 FROM partner_coupon_links o
     WHERE o.organization_id = NEW.organization_id
       AND o.code_normalized = NEW.code_normalized
       AND o.id <> NEW.id
       AND o.status <> 'ended'
       AND tstzrange(o.valid_from, o.valid_until) && tstzrange(NEW.valid_from, NEW.valid_until)
  ) THEN
    RAISE EXCEPTION 'cupom % já tem vigência sobreposta nesta loja', NEW.code_normalized USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_partner_coupon_links_sobreposicao AFTER INSERT OR UPDATE ON partner_coupon_links
  FOR EACH ROW EXECUTE FUNCTION partner_coupon_links_sem_sobreposicao();

-- ── Collabs ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE partner_collabs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (btrim(name) <> '' AND length(name) <= 160),
  image_url TEXT CHECK (image_url IS NULL OR (length(image_url) <= 500 AND image_url ~ '^https://')),
  collection_url TEXT CHECK (collection_url IS NULL OR (length(collection_url) <= 500 AND collection_url ~ '^https://')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended')),
  -- Política de novos produtos descobertos por cluster. O contrato pode sobrescrever; este é o padrão da collab.
  new_member_policy TEXT NOT NULL DEFAULT 'require_approval' CHECK (new_member_policy IN ('require_approval', 'auto_include')),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 4000),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_collabs_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT uq_partner_collabs_id_org UNIQUE (id, organization_id),
  CONSTRAINT ck_partner_collabs_vigencia CHECK (ends_at IS NULL OR ends_at > starts_at)
);

-- Participação de cada criador: fatia da BASE do item sobre a qual o contrato dele incide.
CREATE TABLE partner_collab_creators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  collab_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  contract_id UUID NOT NULL,
  share_bps INTEGER NOT NULL CHECK (share_bps BETWEEN 1 AND 10000),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_collab_creators_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_collab_creators_collab FOREIGN KEY (collab_id, organization_id) REFERENCES partner_collabs (id, organization_id),
  CONSTRAINT fk_partner_collab_creators_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT fk_partner_collab_creators_contract FOREIGN KEY (contract_id, organization_id) REFERENCES partnership_contracts (id, organization_id),
  CONSTRAINT ck_partner_collab_creators_vigencia CHECK (valid_to IS NULL OR valid_to > valid_from)
);
CREATE INDEX idx_partner_collab_creators_collab ON partner_collab_creators (organization_id, collab_id);
CREATE UNIQUE INDEX uq_partner_collab_creators_vigente ON partner_collab_creators (organization_id, collab_id, partner_id) WHERE valid_to IS NULL;

CREATE FUNCTION partner_collab_creators_soma_participacao() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE soma INTEGER;
BEGIN
  IF NEW.valid_to IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text || ':collab:' || NEW.collab_id::text, 0));
  SELECT COALESCE(SUM(share_bps), 0) INTO soma FROM partner_collab_creators
   WHERE organization_id = NEW.organization_id AND collab_id = NEW.collab_id AND valid_to IS NULL AND id <> NEW.id;
  IF soma + NEW.share_bps > 10000 THEN
    RAISE EXCEPTION 'participações da collab somam % bps (máximo 10000)', soma + NEW.share_bps USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_partner_collab_creators_soma AFTER INSERT OR UPDATE ON partner_collab_creators
  FOR EACH ROW EXECUTE FUNCTION partner_collab_creators_soma_participacao();

-- Produtos participantes. A apuração usa ESTE snapshot de ids (nunca título, imagem, slug ou cluster).
CREATE TABLE partner_collab_product_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  collab_id UUID NOT NULL,
  ink_product_id BIGINT NOT NULL,
  ink_variant_id BIGINT,
  ink_cluster_id BIGINT,
  product_name TEXT CHECK (product_name IS NULL OR length(product_name) <= 200),
  status TEXT NOT NULL CHECK (status IN ('pending_approval', 'active', 'removed')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'cluster_discovery')),
  -- Vigência da associação: começa na aprovação/ativação (nunca retroativa) e termina na remoção.
  valid_from TIMESTAMPTZ,
  valid_to TIMESTAMPTZ,
  created_by UUID,
  approved_by UUID,
  removed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_collab_memberships_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_collab_memberships_collab FOREIGN KEY (collab_id, organization_id) REFERENCES partner_collabs (id, organization_id),
  CONSTRAINT ck_partner_collab_memberships_estado CHECK (
    (status = 'pending_approval' AND valid_from IS NULL AND valid_to IS NULL)
    OR (status = 'active' AND valid_from IS NOT NULL AND valid_to IS NULL)
    OR (status = 'removed' AND valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_to >= valid_from)
  )
);
CREATE INDEX idx_partner_collab_memberships_produto ON partner_collab_product_memberships (organization_id, ink_product_id, valid_from);
CREATE INDEX idx_partner_collab_memberships_collab ON partner_collab_product_memberships (organization_id, collab_id);
-- Um produto pertence a UMA collab ativa por vez: dois vínculos simultâneos não têm regra válida.
CREATE UNIQUE INDEX uq_partner_collab_memberships_ativo ON partner_collab_product_memberships (organization_id, ink_product_id) WHERE status = 'active';
CREATE UNIQUE INDEX uq_partner_collab_memberships_pendente ON partner_collab_product_memberships (organization_id, collab_id, ink_product_id) WHERE status = 'pending_approval';

-- ── Itens com atribuição em revisão manual (produto/variante ausente, ambíguo, dado incompleto) ──
CREATE TABLE partnership_review_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  ink_order_id BIGINT NOT NULL,
  ink_item_id BIGINT,
  reason TEXT NOT NULL CHECK (reason ~ '^[a-z][a-z0-9_]{2,60}$'),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partnership_review_items_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id)
);
CREATE UNIQUE INDEX uq_partnership_review_items_origem ON partnership_review_items (organization_id, ink_order_id, COALESCE(ink_item_id, 0), reason);
CREATE INDEX idx_partnership_review_items_abertos ON partnership_review_items (organization_id, status);

-- ── Atribuições (por item) ──────────────────────────────────────────────────────────────────────
CREATE TABLE partnership_attributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  ink_order_id BIGINT NOT NULL,
  ink_item_id BIGINT NOT NULL,
  partner_id UUID NOT NULL,
  contract_id UUID NOT NULL,
  contract_version_id UUID NOT NULL,
  basis TEXT NOT NULL CHECK (basis IN ('collab', 'coupon')),
  collab_id UUID,
  coupon_link_id UUID,
  creator_share_bps INTEGER NOT NULL DEFAULT 10000 CHECK (creator_share_bps BETWEEN 1 AND 10000),
  -- Como a atribuição foi decidida (evidência). Não guarda dado do comprador.
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  -- Snapshot do cálculo no momento da venda: bases, descontos alocados, custo, margem, regra, nível.
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  -- Estado corrente do pedido/quantidades (atualizado a cada reprocessamento); o `snapshot` acima é o ORIGINAL.
  current_state JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(current_state) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('calculated', 'manual_review', 'blocked', 'void')),
  review_reason TEXT,
  manual_override BOOLEAN NOT NULL DEFAULT false,
  sale_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partnership_attributions_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partnership_attributions_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT fk_partnership_attributions_contract FOREIGN KEY (contract_id, organization_id) REFERENCES partnership_contracts (id, organization_id),
  CONSTRAINT fk_partnership_attributions_version FOREIGN KEY (contract_version_id, organization_id) REFERENCES partnership_contract_versions (id, organization_id),
  CONSTRAINT fk_partnership_attributions_collab FOREIGN KEY (collab_id, organization_id) REFERENCES partner_collabs (id, organization_id),
  CONSTRAINT fk_partnership_attributions_coupon FOREIGN KEY (coupon_link_id, organization_id) REFERENCES partner_coupon_links (id, organization_id),
  CONSTRAINT uq_partnership_attributions_id_org UNIQUE (id, organization_id),
  CONSTRAINT uq_partnership_attributions_chave UNIQUE (organization_id, idempotency_key),
  CONSTRAINT ck_partnership_attributions_origem CHECK (
    (basis = 'collab' AND collab_id IS NOT NULL) OR (basis = 'coupon' AND coupon_link_id IS NOT NULL)
  )
);
CREATE INDEX idx_partnership_attributions_pedido ON partnership_attributions (organization_id, ink_order_id);
CREATE INDEX idx_partnership_attributions_partner ON partnership_attributions (organization_id, partner_id, sale_at DESC);

-- ── Ledger de comissões (assinado, em centavos, nunca apagado) ──────────────────────────────────
CREATE TABLE partner_commission_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  attribution_id UUID,
  contract_version_id UUID,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('accrual', 'adjustment', 'manual_adjustment')),
  -- Cachê por conteúdo é categoria SEPARADA de comissão por venda: mesma trilha de pagamento, somas separadas.
  category TEXT NOT NULL DEFAULT 'commission' CHECK (category IN ('commission', 'content_fee')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  -- Ciclo de vida ANTES do pagamento. O estado financeiro (agendado / parcialmente pago / pago / vencido)
  -- é derivado das alocações de pagamento e de due_at — nunca gravado aqui.
  status TEXT NOT NULL CHECK (status IN ('provisional', 'held', 'released', 'manual_review', 'reversed')),
  hold_reason TEXT,
  -- Quatro datas distintas (+ recorded_at = created_at):
  sale_at TIMESTAMPTZ NOT NULL,
  release_at TIMESTAMPTZ,
  estimated_payment_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  -- true quando o vencimento foi alterado À MÃO (com motivo e auditoria): a recalculação por política não o sobrescreve.
  due_at_overridden BOOLEAN NOT NULL DEFAULT false,
  -- Mês da venda (competência gerencial) no timezone da loja, primeiro dia do mês.
  competence DATE NOT NULL,
  -- Chave canônica de origem: mesma origem + mesmo estado = mesmo lançamento (idempotência).
  origin_key TEXT NOT NULL CHECK (btrim(origin_key) <> ''),
  note TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_commission_ledger_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_commission_ledger_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT fk_partner_commission_ledger_attribution FOREIGN KEY (attribution_id, organization_id) REFERENCES partnership_attributions (id, organization_id),
  CONSTRAINT fk_partner_commission_ledger_version FOREIGN KEY (contract_version_id, organization_id) REFERENCES partnership_contract_versions (id, organization_id),
  CONSTRAINT uq_partner_commission_ledger_id_org UNIQUE (id, organization_id),
  CONSTRAINT uq_partner_commission_ledger_origem UNIQUE (organization_id, partner_id, origin_key)
);
CREATE INDEX idx_partner_commission_ledger_partner ON partner_commission_ledger (organization_id, partner_id, status);
CREATE INDEX idx_partner_commission_ledger_due ON partner_commission_ledger (organization_id, due_at) WHERE status = 'released';
CREATE INDEX idx_partner_commission_ledger_attr ON partner_commission_ledger (organization_id, attribution_id);

-- O valor de um lançamento nunca muda: correção é OUTRO lançamento (compensação).
CREATE FUNCTION partner_commission_ledger_valor_imutavel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.partner_id <> OLD.partner_id OR NEW.origin_key <> OLD.origin_key
     OR NEW.sale_at <> OLD.sale_at OR NEW.entry_type <> OLD.entry_type THEN
    RAISE EXCEPTION 'lançamento do ledger é imutável no valor, parceiro, origem e data da venda' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_partner_commission_ledger_imutavel AFTER UPDATE ON partner_commission_ledger
  FOR EACH ROW EXECUTE FUNCTION partner_commission_ledger_valor_imutavel();
CREATE TRIGGER trg_partner_commission_ledger_sem_delete AFTER DELETE ON partner_commission_ledger
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

-- ── Fechamento (lote) e pagamentos ──────────────────────────────────────────────────────────────
CREATE TABLE partner_payout_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  competence_label TEXT NOT NULL CHECK (btrim(competence_label) <> '' AND length(competence_label) <= 40),
  cutoff_at TIMESTAMPTZ NOT NULL,
  proposed_cents BIGINT NOT NULL CHECK (proposed_cents > 0),
  estimated_payment_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  -- Só o que o lojista decide é gravado; parcialmente pago / pago / vencido são DERIVADOS dos pagamentos.
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'voided')),
  approved_by UUID,
  approved_at TIMESTAMPTZ,
  void_reason TEXT,
  voided_by UUID,
  voided_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_payout_batches_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_payout_batches_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT uq_partner_payout_batches_id_org UNIQUE (id, organization_id),
  CONSTRAINT ck_partner_payout_batches_void CHECK (status <> 'voided' OR (void_reason IS NOT NULL AND voided_at IS NOT NULL))
);
CREATE INDEX idx_partner_payout_batches_partner ON partner_payout_batches (organization_id, partner_id, status);

CREATE TABLE partner_payout_batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  batch_id UUID NOT NULL,
  ledger_id UUID NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  CONSTRAINT fk_partner_payout_batch_items_batch FOREIGN KEY (batch_id, organization_id) REFERENCES partner_payout_batches (id, organization_id),
  CONSTRAINT fk_partner_payout_batch_items_ledger FOREIGN KEY (ledger_id, organization_id) REFERENCES partner_commission_ledger (id, organization_id),
  CONSTRAINT uq_partner_payout_batch_items UNIQUE (organization_id, batch_id, ledger_id)
);

CREATE TABLE partner_payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  batch_id UUID,
  kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment', 'reversal')),
  reverses_payment_id UUID,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'BRL' CHECK (currency = 'BRL'),
  -- paid_at = quando o lojista EFETIVAMENTE transferiu. recorded_at = quando lançou aqui.
  paid_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT NOT NULL CHECK (method IN ('pix', 'transfer', 'other')),
  external_reference TEXT CHECK (external_reference IS NULL OR length(external_reference) <= 120),
  -- Referência ao comprovante (texto/ID). Upload de anexo protegido não faz parte desta versão.
  attachment_ref TEXT CHECK (attachment_ref IS NULL OR length(attachment_ref) <= 300),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  reversal_reason TEXT,
  recorded_by UUID NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (btrim(idempotency_key) <> ''),
  CONSTRAINT fk_partner_payment_records_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_payment_records_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT fk_partner_payment_records_batch FOREIGN KEY (batch_id, organization_id) REFERENCES partner_payout_batches (id, organization_id),
  CONSTRAINT uq_partner_payment_records_id_org UNIQUE (id, organization_id),
  CONSTRAINT uq_partner_payment_records_chave UNIQUE (organization_id, idempotency_key),
  CONSTRAINT ck_partner_payment_records_estorno CHECK (
    (kind = 'payment' AND reverses_payment_id IS NULL AND reversal_reason IS NULL)
    OR (kind = 'reversal' AND reverses_payment_id IS NOT NULL AND reversal_reason IS NOT NULL AND btrim(reversal_reason) <> '')
  )
);
ALTER TABLE partner_payment_records ADD CONSTRAINT fk_partner_payment_records_reverses
  FOREIGN KEY (reverses_payment_id, organization_id) REFERENCES partner_payment_records (id, organization_id);
CREATE INDEX idx_partner_payment_records_partner ON partner_payment_records (organization_id, partner_id, paid_at DESC);
CREATE INDEX idx_partner_payment_records_paid_at ON partner_payment_records (organization_id, paid_at);
-- A mesma transferência (referência externa) não é lançada duas vezes para o mesmo parceiro.
CREATE UNIQUE INDEX uq_partner_payment_records_referencia ON partner_payment_records (organization_id, partner_id, external_reference)
  WHERE external_reference IS NOT NULL AND kind = 'payment';
-- Um pagamento é estornado uma vez só.
CREATE UNIQUE INDEX uq_partner_payment_records_estorno_unico ON partner_payment_records (organization_id, reverses_payment_id)
  WHERE reverses_payment_id IS NOT NULL;
CREATE TRIGGER trg_partner_payment_records_append_only AFTER UPDATE OR DELETE ON partner_payment_records
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

-- Alocação SINALIZADA do pagamento sobre lançamentos: crédito (+) paga comissão; débito (−) compensa ajuste.
-- Estorno de pagamento = alocações de sinal contrário. Invariante por lançamento (garantida aqui, com lock):
--   crédito: 0 <= Σ alocações <= amount        débito: amount <= Σ alocações <= 0
CREATE TABLE partner_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  payment_id UUID NOT NULL,
  ledger_id UUID NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  CONSTRAINT fk_partner_payment_allocations_payment FOREIGN KEY (payment_id, organization_id) REFERENCES partner_payment_records (id, organization_id),
  CONSTRAINT fk_partner_payment_allocations_ledger FOREIGN KEY (ledger_id, organization_id) REFERENCES partner_commission_ledger (id, organization_id),
  CONSTRAINT uq_partner_payment_allocations UNIQUE (organization_id, payment_id, ledger_id)
);
CREATE INDEX idx_partner_payment_allocations_ledger ON partner_payment_allocations (organization_id, ledger_id);

CREATE FUNCTION partner_payment_allocations_invariante() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  valor BIGINT;
  soma BIGINT;
  parceiro_pgto UUID;
  parceiro_lanc UUID;
BEGIN
  -- Trava o lançamento: dois pagamentos concorrentes sobre o mesmo lançamento se serializam aqui.
  SELECT amount_cents, partner_id INTO valor, parceiro_lanc FROM partner_commission_ledger
   WHERE id = NEW.ledger_id AND organization_id = NEW.organization_id FOR UPDATE;
  SELECT partner_id INTO parceiro_pgto FROM partner_payment_records WHERE id = NEW.payment_id AND organization_id = NEW.organization_id;
  IF parceiro_pgto IS DISTINCT FROM parceiro_lanc THEN
    RAISE EXCEPTION 'pagamento e lançamento são de parceiros diferentes' USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(SUM(amount_cents), 0) INTO soma FROM partner_payment_allocations
   WHERE ledger_id = NEW.ledger_id AND organization_id = NEW.organization_id;
  IF valor > 0 AND (soma < 0 OR soma > valor) THEN
    RAISE EXCEPTION 'alocação excede o saldo do lançamento (soma %, valor %)', soma, valor USING ERRCODE = 'check_violation';
  END IF;
  IF valor < 0 AND (soma > 0 OR soma < valor) THEN
    RAISE EXCEPTION 'compensação excede o saldo do lançamento (soma %, valor %)', soma, valor USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_partner_payment_allocations_invariante AFTER INSERT ON partner_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION partner_payment_allocations_invariante();
CREATE TRIGGER trg_partner_payment_allocations_append_only AFTER UPDATE OR DELETE ON partner_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

-- ── Níveis ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE partnership_level_rule_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  effective_from TIMESTAMPTZ NOT NULL,
  rules JSONB NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  approved_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partnership_level_rule_sets_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT uq_partnership_level_rule_sets_versao UNIQUE (organization_id, version)
);
CREATE TRIGGER trg_partnership_level_rule_sets_append_only AFTER UPDATE OR DELETE ON partnership_level_rule_sets
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

CREATE TABLE partner_level_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  level_key TEXT NOT NULL CHECK (btrim(level_key) <> ''),
  effective_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('initial', 'proposal_approved', 'manual_override', 'downgrade')),
  observed JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(observed) = 'object'),
  rule_set_version INTEGER,
  reason TEXT,
  approved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_level_history_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_level_history_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT ck_partner_level_history_override CHECK (source <> 'manual_override' OR (reason IS NOT NULL AND btrim(reason) <> '' AND approved_by IS NOT NULL))
);
CREATE INDEX idx_partner_level_history_partner ON partner_level_history (organization_id, partner_id, effective_at DESC);
CREATE TRIGGER trg_partner_level_history_append_only AFTER UPDATE OR DELETE ON partner_level_history
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

CREATE TABLE partner_level_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  from_level TEXT NOT NULL,
  to_level TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('upgrade', 'downgrade')),
  observed JSONB NOT NULL CHECK (jsonb_typeof(observed) = 'object'),
  rule_set_version INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  decided_by UUID,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_level_proposals_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_level_proposals_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id)
);
CREATE UNIQUE INDEX uq_partner_level_proposals_pendente ON partner_level_proposals (organization_id, partner_id) WHERE status = 'pending';

-- ── Carteira de benefícios (separada das comissões) ─────────────────────────────────────────────
CREATE TABLE partner_benefit_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  partner_id UUID NOT NULL,
  attribution_id UUID,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('budget_credit', 'consumption', 'reversal', 'exceptional_grant')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents <> 0),
  production_cost_cents BIGINT CHECK (production_cost_cents IS NULL OR production_cost_cents >= 0),
  shipping_cost_cents BIGINT CHECK (shipping_cost_cents IS NULL OR shipping_cost_cents >= 0),
  description TEXT CHECK (description IS NULL OR length(description) <= 300),
  -- criador_convidado: permuta antecipada com entregáveis combinados (não vira nível nem dinheiro a pagar).
  guest_creator BOOLEAN NOT NULL DEFAULT false,
  deliverables TEXT CHECK (deliverables IS NULL OR length(deliverables) <= 1000),
  origin_key TEXT NOT NULL CHECK (btrim(origin_key) <> ''),
  approved_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partner_benefit_ledger_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id),
  CONSTRAINT fk_partner_benefit_ledger_partner FOREIGN KEY (partner_id, organization_id) REFERENCES partnership_partners (id, organization_id),
  CONSTRAINT fk_partner_benefit_ledger_attribution FOREIGN KEY (attribution_id, organization_id) REFERENCES partnership_attributions (id, organization_id),
  CONSTRAINT uq_partner_benefit_ledger_origem UNIQUE (organization_id, partner_id, origin_key),
  CONSTRAINT ck_partner_benefit_ledger_sinal CHECK (
    (entry_type IN ('budget_credit', 'reversal', 'exceptional_grant') AND amount_cents <> 0)
    OR (entry_type = 'consumption' AND amount_cents < 0)
  ),
  CONSTRAINT ck_partner_benefit_ledger_excecao CHECK (entry_type <> 'exceptional_grant' OR (approved_by IS NOT NULL AND description IS NOT NULL))
);
CREATE INDEX idx_partner_benefit_ledger_partner ON partner_benefit_ledger (organization_id, partner_id);
CREATE TRIGGER trg_partner_benefit_ledger_append_only AFTER UPDATE OR DELETE ON partner_benefit_ledger
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

-- ── Auditoria ───────────────────────────────────────────────────────────────────────────────────
CREATE TABLE partnership_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  store_id UUID NOT NULL,
  entity_type TEXT NOT NULL CHECK (btrim(entity_type) <> ''),
  entity_id TEXT NOT NULL CHECK (btrim(entity_id) <> ''),
  action TEXT NOT NULL CHECK (btrim(action) <> ''),
  before_state JSONB,
  after_state JSONB,
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 1000),
  actor_user_id UUID,
  correlation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fk_partnership_audit_events_store FOREIGN KEY (store_id, organization_id) REFERENCES stores (id, organization_id)
);
CREATE INDEX idx_partnership_audit_events_entidade ON partnership_audit_events (organization_id, entity_type, entity_id, created_at DESC);
CREATE INDEX idx_partnership_audit_events_recentes ON partnership_audit_events (organization_id, created_at DESC);
CREATE TRIGGER trg_partnership_audit_events_append_only AFTER UPDATE OR DELETE ON partnership_audit_events
  FOR EACH ROW EXECUTE FUNCTION partnership_bloquear_mutacao();

-- ── RLS: isolamento por Organization (mesma policy de commerce_products) ────────────────────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'partnership_settings', 'partnership_partners', 'partnership_contracts', 'partnership_contract_versions',
    'partner_coupon_links', 'partner_collabs', 'partner_collab_creators', 'partner_collab_product_memberships',
    'partnership_review_items', 'partnership_attributions', 'partner_commission_ledger',
    'partner_payout_batches', 'partner_payout_batch_items', 'partner_payment_records', 'partner_payment_allocations',
    'partnership_level_rule_sets', 'partner_level_history', 'partner_level_proposals', 'partner_benefit_ledger',
    'partnership_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenancy_isolamento ON %I USING (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), '''')::uuid) '
      || 'WITH CHECK (organization_id = NULLIF(current_setting(''app.current_organization_id'', true), '''')::uuid)', t);
  END LOOP;
END;
$$;
