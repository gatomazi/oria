
    CREATE TABLE IF NOT EXISTS pedidos_ink (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      ink_order_id BIGINT NOT NULL,
      rsv_factory_id TEXT,
      payment_status TEXT,
      order_status TEXT,
      buyer_nome TEXT,
      buyer_telefone TEXT,
      buyer_documento TEXT,
      buyer_email TEXT,
      buyer_aceita_marketing BOOLEAN,
      total_value NUMERIC,
      criado_em TIMESTAMPTZ,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (loja, ink_order_id)
    );
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS buyer_aceita_marketing BOOLEAN;
    -- UF do cliente (filtro de segmento por estado, pra campanhas sazonais tipo "dia do RS/SC/PR")
    -- vem direto de shipping_address.state da Ink, sem heurística por cidade — a Ink já manda o
    -- estado explícito em todo pedido com endereço de entrega.
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS buyer_uf TEXT;
    -- Quantidade de itens do pedido: a Central de Pedidos lista a partir deste cache (ordenação e
    -- paginação sobre todo o histórico, que a API da Ink não oferece). Nula em linhas antigas até o
    -- próximo sync/backfill/webhook tocar o pedido.
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS items_count INTEGER;
    -- Resultado financeiro do pedido (ver financeiroPedidoInk). Nulo em linhas antigas até o
    -- próximo sync/backfill/webhook tocar o pedido com o payload completo (itens).
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS frete NUMERIC;
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS descontos NUMERIC;
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS lucro_bruto NUMERIC;
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS custo_producao NUMERIC;
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS lucro_operacional NUMERIC;
    ALTER TABLE pedidos_ink ADD COLUMN IF NOT EXISTS is_troca BOOLEAN;

    -- Itens de cada pedido com o resultado financeiro por item (ver financeiroItensPedidoInk), pra
    -- lucro por produto/modelo. Espelho do payload: regravado inteiro sempre que o pedido chega com
    -- itens (sync, webhook, backfill). Status/troca/data ficam só em pedidos_ink (JOIN).
    CREATE TABLE IF NOT EXISTS pedidos_ink_itens (
      loja TEXT NOT NULL,
      ink_order_id BIGINT NOT NULL,
      item_id BIGINT NOT NULL,
      produto_id BIGINT,
      produto_nome TEXT,
      sku TEXT,
      modelo TEXT,
      cor TEXT,
      tamanho TEXT,
      quantidade INTEGER NOT NULL,
      valor_venda NUMERIC NOT NULL,
      desconto_rateado NUMERIC NOT NULL,
      custo_producao NUMERIC NOT NULL,
      lucro_operacional NUMERIC NOT NULL,
      PRIMARY KEY (loja, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_ink_itens_pedido ON pedidos_ink_itens (loja, ink_order_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_ink_loja_criado ON pedidos_ink (loja, criado_em DESC);
    CREATE INDEX IF NOT EXISTS idx_pedidos_ink_telefone ON pedidos_ink (buyer_telefone);
    CREATE INDEX IF NOT EXISTS idx_pedidos_ink_documento ON pedidos_ink (buyer_documento);
    CREATE INDEX IF NOT EXISTS idx_pedidos_ink_email ON pedidos_ink (buyer_email);

    CREATE TABLE IF NOT EXISTS sync_estado (
      loja TEXT PRIMARY KEY,
      ultimo_sync_em TIMESTAMPTZ NOT NULL
    );

    -- Backfill histórico de pedidos: o sync incremental (syncPedidosLoja) só busca desde
    -- sync_estado.ultimo_sync_em (ou os últimos 30 dias na 1a ativação da loja) -- pedidos mais
    -- antigos que isso nunca entram no cache local, o que sub-conta clientes em segmentos de
    -- campanha (2026-09-10: 712 clientes vs 4000+ pedidos historicos reais). Este job e um
    -- complemento sob demanda, reexecutavel, que NUNCA mexe em sync_estado.
    CREATE TABLE IF NOT EXISTS pedidos_backfill_jobs (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      desde DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'processando',
      paginas_processadas INTEGER NOT NULL DEFAULT 0,
      paginas_total INTEGER,
      pedidos_processados INTEGER NOT NULL DEFAULT 0,
      erro TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_backfill_jobs_loja ON pedidos_backfill_jobs (loja, criado_em DESC);

    CREATE TABLE IF NOT EXISTS webhook_eventos (
      id BIGSERIAL PRIMARY KEY,
      recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      verificado BOOLEAN NOT NULL,
      loja TEXT,
      metodo_auth TEXT,
      event_name TEXT,
      ink_order_id BIGINT,
      headers JSONB,
      body JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_eventos_recebido_em ON webhook_eventos (recebido_em DESC);
    CREATE INDEX IF NOT EXISTS idx_webhook_eventos_event_name ON webhook_eventos (event_name);

    CREATE TABLE IF NOT EXISTS app_config (
      chave TEXT PRIMARY KEY,
      valor JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Rastreio de estoque por variação (tamanho/cor/modelo) — a Reserva Ink não tem endpoint de
    -- "estoque atual", só o valor de "available_quantity" que aparece de carona em qualquer
    -- webhook de pedido que toque naquele SKU. Isso é uma OBSERVAÇÃO, não uma sincronização: uma
    -- variação que não vende não ganha registro novo. Guarda toda observação (não só a última)
    -- pra permitir histórico/tendência no futuro sem precisar migrar de novo.
    CREATE TABLE IF NOT EXISTS estoque_observacoes (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      product_variant_id BIGINT NOT NULL,
      sku TEXT,
      produto_id BIGINT,
      produto_nome TEXT,
      tamanho TEXT,
      cor TEXT,
      modelo TEXT,
      quantidade_disponivel INTEGER,
      disponivel BOOLEAN,
      observado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_estoque_obs_variant ON estoque_observacoes (loja, product_variant_id, observado_em DESC);

    -- Controle de estoque via produto dedicado (conversa 2026-09-04): pra cada tipo de peça em
    -- branco (Camiseta Oversized, Hoodie Moletom etc.) existe 1 produto never-published na Ink
    -- chamado literalmente 'controle-estoque', e o tipo de produto dele é que diz qual peça é.
    -- As variantes desse produto (tamanho/cor/modelo + quantidade/disponibilidade) SAO o estoque
    -- real -- diferente de estoque_observacoes (que so vem de carona em pedido). Convive com o
    -- mecanismo antigo de proposito (decisao do usuario) -- fontes separadas, nunca misturadas.
    CREATE TABLE IF NOT EXISTS controle_estoque_observacoes (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      produto_id BIGINT NOT NULL,
      produto_tipo TEXT,
      variant_id BIGINT NOT NULL,
      sku TEXT,
      tamanho TEXT,
      cor TEXT,
      modelo TEXT,
      quantidade_disponivel INTEGER,
      disponivel BOOLEAN,
      observado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_controle_estoque_obs_variant ON controle_estoque_observacoes (loja, variant_id, observado_em DESC);

    -- Auditoria de ações sensíveis (reembolso, troca, etc. — spec §33). Também é a única fonte
    -- de listagem de reembolsos: a API da Ink não tem um GET global de reembolsos, só por
    -- pedido (GET /v1/stores/orders/{id}/refunds) — então "Reembolsos" nesta tela é sempre
    -- "reembolsos feitos por este painel", nunca uma cópia completa do que existe na Ink.
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      actor_user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      loja TEXT,
      before JSONB,
      after JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log (action, criado_em DESC);

    -- Mídia enviada por admin (amostra de template hoje; biblioteca de campanha depois, Fase 3+
    -- do plano de Campanhas) — arquivo real fica em UPLOADS_DIR (volume Railway), aqui só a
    -- referência. meta_upload_handle é o handle devolvido pelo resumable upload da Meta,
    -- usado 1x na criação do template; não confundir com meta_media_id (usado no ENVIO real
    -- da mensagem, um conceito diferente — ver PARTE 6/35 do spec de campanhas).
    -- loja fica opcional (nullable) de propósito: o WhatsApp/WABA deste projeto é 1 conta só,
    -- compartilhada entre as 3 lojas (não existe template "da loja X") — diferente das tabelas
    -- ligadas à Ink, que são sempre por loja. O campo existe pra Fase 3+ (biblioteca de mídia de
    -- campanha, aí sim por loja), não pra amostra de template.
    CREATE TABLE IF NOT EXISTS media_assets (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      storage_key TEXT NOT NULL,
      meta_upload_handle TEXT,
      meta_media_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_media_assets_loja ON media_assets (loja, created_at DESC);

    -- public_token (Fase 5): a mídia de ENVIO real de campanha precisa de uma URL pública (a Meta
    -- busca o arquivo direto, sem token de sessão admin) — nunca pelo id sequencial (enumerável),
    -- por isso um token opaco e aleatório por asset. Nullable + backfill em runtime (linha abaixo)
    -- pra não quebrar assets já existentes (amostra de template, que nunca precisou disso).
    ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS public_token TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_public_token ON media_assets (public_token) WHERE public_token IS NOT NULL;

    -- Campanhas/Remarketing (Fase 3 do plano) — segmento é uma DEFINIÇÃO de filtro salva
    -- (dinâmica), nunca uma lista fixa de IDs (spec, Parte 5). O snapshot de destinatários só
    -- existe em campaign_recipients, criado quando a campanha realmente é disparada (Fase 5).
    CREATE TABLE IF NOT EXISTS segments (
      id BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      match TEXT NOT NULL DEFAULT 'ALL',
      filtros JSONB NOT NULL DEFAULT '[]',
      exclusoes JSONB NOT NULL DEFAULT '{}',
      criado_por TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- loja aqui É obrigatória (diferente de media_assets) — campanha sempre mira uma loja, é
    -- audiência de cliente real por loja, não um recurso compartilhado como o WABA.
    CREATE TABLE IF NOT EXISTS campaigns (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      nome TEXT NOT NULL,
      descricao TEXT,
      template_nome TEXT,
      segmento_id BIGINT REFERENCES segments(id) ON DELETE SET NULL,
      audience_definition JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      agendada_para TIMESTAMPTZ,
      iniciada_em TIMESTAMPTZ,
      finalizada_em TIMESTAMPTZ,
      total_matched INTEGER,
      total_excluded INTEGER,
      total_recipients INTEGER,
      criado_por TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_campaigns_loja ON campaigns (loja, criado_em DESC);

    -- Snapshot dos destinatários no momento do disparo (Fase 5) — impede que a audiência mude
    -- durante o envio (spec, Parte 17). UNIQUE(campaign_id, customer_key) é a idempotência: um
    -- retry de job não pode gerar 2 envios pro mesmo cliente na mesma campanha.
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      customer_key TEXT NOT NULL,
      telefone TEXT,
      nome TEXT,
      resolved_variables JSONB,
      media_asset_id BIGINT REFERENCES media_assets(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      provider_message_id TEXT,
      queued_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      failure_code TEXT,
      failure_message TEXT,
      click_count INTEGER NOT NULL DEFAULT 0,
      first_clicked_at TIMESTAMPTZ,
      last_clicked_at TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (campaign_id, customer_key)
    );
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign ON campaign_recipients (campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_provider_msg ON campaign_recipients (provider_message_id);

    -- Envio em lotes: destinatário só é enviado depois de LIBERADO num lote (lote = número do
    -- lote, 1, 2, 3...); NULL = snapshot feito mas aguardando o admin liberar. O DEFAULT 1 só vale
    -- no momento em que a coluna nasce (IF NOT EXISTS vira no-op depois) — marca como "lote 1"
    -- tudo de campanhas que já estavam em envio antes disso existir, pra elas seguirem normal; o
    -- DROP DEFAULT logo em seguida garante que destinatário novo nasce NULL (não liberado).
    ALTER TABLE campaign_recipients ADD COLUMN IF NOT EXISTS lote INTEGER DEFAULT 1;
    ALTER TABLE campaign_recipients ALTER COLUMN lote DROP DEFAULT;
    CREATE INDEX IF NOT EXISTS idx_campaign_recipients_lote ON campaign_recipients (campaign_id, lote);
    -- Tamanho padrão de lote da campanha (NULL = tudo de uma vez) — usado no 1º lote ao iniciar
    -- (inclusive quando uma campanha agendada inicia sozinha) e como sugestão pros próximos.
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS tamanho_lote INTEGER;

    -- Cache local do catálogo ATIVO, alimentado pelo CSV do feed do Facebook que a própria Ink
    -- gera (ver sincronizarProdutosFeed). Só produto publicado entra aqui — este cache nunca
    -- substitui a API pra catálogo completo, só pra busca de produto ativo.
    -- categorias/tags ficam como TEXT cru do feed ("SUL,SUL - PR,Seu Lugar"), separados só na
    -- leitura: não há filtro por eles ainda e TEXT evita array-de-array no INSERT em lote.
    CREATE TABLE IF NOT EXISTS produtos_feed (
      loja TEXT NOT NULL,
      produto_id BIGINT NOT NULL,
      titulo TEXT,   -- "Camiseta - Curitiba | Origem PR" (tipo + nome, como o feed manda)
      nome TEXT,     -- só o nome do produto no painel ("Curitiba | Origem PR")
      tipo TEXT,     -- custom_label_0
      categorias TEXT,
      tags TEXT,
      preco NUMERIC,
      preco_promocional NUMERIC,
      disponibilidade TEXT,
      link TEXT,
      imagem_url TEXT,
      cores TEXT,
      tamanhos TEXT,
      sincronizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (loja, produto_id)
    );
    CREATE INDEX IF NOT EXISTS idx_produtos_feed_nome ON produtos_feed (loja, lower(nome));
    CREATE TABLE IF NOT EXISTS produtos_feed_sync (
      loja TEXT PRIMARY KEY,
      iniciado_em TIMESTAMPTZ,
      concluido_em TIMESTAMPTZ,
      total INTEGER,
      erro TEXT
    );

    -- Cache do catálogo COMPLETO da Ink (2026-09-11). Diferente de produtos_feed, que vem do CSV
    -- do Facebook e só enxerga produto publicado, esta tabela é uma varredura de
    -- GET /v1/stores/products página a página: entra produto desativado, oculto e não aprovado, e
    -- vêm os campos que o feed não tem (approval_status, visible_in_store, variantes,
    -- product_cluster_id, updated_at). É por isso que ela consegue responder QUALQUER filtro da
    -- tela de Produtos, enquanto o feed só respondia busca por nome/tipo de produto ativo.
    CREATE TABLE IF NOT EXISTS produtos_ink (
      loja TEXT NOT NULL,
      produto_id BIGINT NOT NULL,
      name TEXT,
      main_image_url TEXT,
      price NUMERIC,
      promotional_price NUMERIC,
      visible_in_store BOOLEAN,
      approval_status TEXT,
      status TEXT,
      product_type_id BIGINT,
      product_type_name TEXT,
      variants_count INTEGER,
      product_cluster_id BIGINT,
      updated_at TIMESTAMPTZ,
      sincronizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (loja, produto_id)
    );
    CREATE INDEX IF NOT EXISTS idx_produtos_ink_name ON produtos_ink (loja, lower(name));
    CREATE INDEX IF NOT EXISTS idx_produtos_ink_tipo ON produtos_ink (loja, product_type_id);
    CREATE INDEX IF NOT EXISTS idx_produtos_ink_visivel ON produtos_ink (loja, visible_in_store);
    CREATE INDEX IF NOT EXISTS idx_produtos_ink_aprovacao ON produtos_ink (loja, approval_status);
    -- Uma linha por loja: o estado do último crawl. processados/total_estimado existem pro
    -- card de Integrações mostrar progresso real durante os ~850 requests, em vez de só "rodando".
    CREATE TABLE IF NOT EXISTS produtos_ink_sync (
      loja TEXT PRIMARY KEY,
      iniciado_em TIMESTAMPTZ,
      concluido_em TIMESTAMPTZ,
      total INTEGER,
      processados INTEGER NOT NULL DEFAULT 0,
      total_estimado INTEGER,
      paginas INTEGER NOT NULL DEFAULT 0,
      truncado BOOLEAN NOT NULL DEFAULT false,
      erro TEXT
    );
    -- Controle da renovação automática, por loja: pausar não afeta o botão "Sincronizar agora".
    ALTER TABLE produtos_ink_sync ADD COLUMN IF NOT EXISTS auto_pausado BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE produtos_ink_sync ADD COLUMN IF NOT EXISTS intervalo_horas INTEGER NOT NULL DEFAULT 6;

    -- Associação em massa de categorias (docs/claude-categorias-lote-migracao-use-origens.md,
    -- Parte 3). filtro_produtos guarda o snapshot do filtro/seleção usado, só pra auditoria — o
    -- job em si roda sobre os items já materializados abaixo, nunca reconsulta o filtro depois de
    -- criado (evita que o job mude de alvo se o catálogo mudar durante o processamento).
    CREATE TABLE IF NOT EXISTS bulk_category_jobs (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      mode TEXT NOT NULL,
      category_ids JSONB NOT NULL,
      filtro_produtos JSONB,
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      succeeded INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      criado_por TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      finalizado_em TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_category_jobs_loja ON bulk_category_jobs (loja, criado_em DESC);
    -- Transferência de categoria (pedido do usuário, 2026-09-11): no modo 'add', permite remover
    -- categorias específicas ao mesmo tempo que adiciona outras, sem precisar de um 'replace'
    -- (que exigiria recalcular a lista inteira na mão). Só usado quando mode = 'add'.
    ALTER TABLE bulk_category_jobs ADD COLUMN IF NOT EXISTS category_ids_remover JSONB;

    CREATE TABLE IF NOT EXISTS bulk_category_job_items (
      id BIGSERIAL PRIMARY KEY,
      job_id BIGINT NOT NULL REFERENCES bulk_category_jobs(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      categories_before JSONB,
      categories_after JSONB,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_category_job_items_job ON bulk_category_job_items (job_id, status);

    -- "Migração Use Origens" (Partes 4-7 do doc): a execução de uma migração é, no fundo, uma
    -- associação em massa REPLACE — só que a lista de categorias varia POR PRODUTO (vem da regra
    -- que bateu), não é fixa pro job inteiro como na Fase 2. Por isso generaliza-se
    -- bulk_category_job_items com categoria_ids_alvo (nullable) em vez de criar uma segunda
    -- tabela de execução: quando presente, o executor usa esse valor no lugar de
    -- bulk_category_jobs.category_ids pra aquele item específico (nunca duplica a lógica de
    -- retry/concorrência/lock já existente).
    ALTER TABLE bulk_category_job_items ADD COLUMN IF NOT EXISTS categoria_ids_alvo JSONB;

    CREATE TABLE IF NOT EXISTS origens_migration_rules (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      nome TEXT NOT NULL,
      habilitada BOOLEAN NOT NULL DEFAULT true,
      prioridade INTEGER NOT NULL DEFAULT 0,
      dimensao TEXT,
      condicoes JSONB NOT NULL DEFAULT '[]',
      categoria_ids_saida JSONB NOT NULL DEFAULT '[]',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_origens_migration_rules_loja ON origens_migration_rules (loja, prioridade);

    -- Simulação é sempre obrigatória antes de executar (spec, Parte 5) e nunca recalculada na
    -- hora de executar — o snapshot (categorias_finais/override) é o que a execução usa de
    -- verdade, pra não haver diferença entre o que foi revisado e o que foi de fato aplicado.
    CREATE TABLE IF NOT EXISTS origens_migration_simulations (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      total_analisados INTEGER NOT NULL DEFAULT 0,
      total_prontos INTEGER NOT NULL DEFAULT 0,
      total_sem_regra INTEGER NOT NULL DEFAULT 0,
      total_conflito INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'simulada',
      job_id BIGINT REFERENCES bulk_category_jobs(id) ON DELETE SET NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      executada_em TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_origens_migration_simulations_loja ON origens_migration_simulations (loja, criado_em DESC);

    CREATE TABLE IF NOT EXISTS origens_migration_simulation_items (
      id BIGSERIAL PRIMARY KEY,
      simulation_id BIGINT NOT NULL REFERENCES origens_migration_simulations(id) ON DELETE CASCADE,
      product_id BIGINT NOT NULL,
      product_name TEXT,
      matched_rule_ids JSONB NOT NULL DEFAULT '[]',
      collection_detectada TEXT,
      uf_detectada TEXT,
      regiao_detectada TEXT,
      categorias_finais JSONB NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'sem_regra',
      conflito_motivo TEXT,
      override_categorias JSONB,
      override_ignorar BOOLEAN NOT NULL DEFAULT false,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_origens_migration_sim_items_sim ON origens_migration_simulation_items (simulation_id, status);

    -- Fallback de UF via cidade (doc: claude-preload-regras-use-origens-cidade-uf.md) — colunas
    -- extras só preenchidas quando o item foi resolvido pelo fallback (produto sem UF explícita
    -- no nome), nunca pelo caminho normal de match de regra.
    ALTER TABLE origens_migration_simulation_items ADD COLUMN IF NOT EXISTS cidade_detectada TEXT;
    ALTER TABLE origens_migration_simulation_items ADD COLUMN IF NOT EXISTS fonte_uf TEXT;
    ALTER TABLE origens_migration_simulation_items ADD COLUMN IF NOT EXISTS confianca TEXT;

    -- Fonte da classificação (doc: claude-migracao-final-categorias-snapshot-especiais.md, Grupo
    -- A vs Grupo B) — 'nome' (regra bateu por product_name), 'categoria_atual' (regra bateu por
    -- current_category — coleções especiais que só dá pra identificar pela categoria de origem,
    -- não pelo título), ou 'fallback_cidade' (nenhuma regra bateu, resolvido via cidade→UF). Só
    -- pra auditoria/relatório — não influencia a execução, que já usa só categorias_finais.
    ALTER TABLE origens_migration_simulation_items ADD COLUMN IF NOT EXISTS fonte_classificacao TEXT;

    -- Mapa Cidade → UF: só região Sul por enquanto (RS/SC/PR), usado como fallback quando o nome
    -- do produto não tem a UF explícita no final (ex: "Joinville | Coordenadas").
    CREATE TABLE IF NOT EXISTS origens_migration_city_uf_map (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      cidade_normalizada TEXT NOT NULL,
      cidade_display TEXT NOT NULL,
      uf TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (loja, cidade_normalizada)
    );

    -- Simulação passou a rodar em background, página por página da Ink, em vez de tudo síncrono
    -- na request (loja com muitos produtos travava sem feedback nenhum). Essas colunas dão
    -- progresso real pro polling do frontend; status ganha 'processando' (rodando) e 'falhou'
    -- (erro no meio, ex: falha de rede com a Ink) além de 'simulada' (pronta) que já existia.
    ALTER TABLE origens_migration_simulations ADD COLUMN IF NOT EXISTS paginas_processadas INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE origens_migration_simulations ADD COLUMN IF NOT EXISTS paginas_total INTEGER;
    ALTER TABLE origens_migration_simulations ADD COLUMN IF NOT EXISTS produtos_processados INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE origens_migration_simulations ADD COLUMN IF NOT EXISTS erro TEXT;

    -- Workaround real (pedido do usuário, 2026-09-09): a Ink rejeita (422) atualizar collections
    -- de um produto que pertence a um agrupamento de estampa (product_cluster). O executor
    -- desagrupa temporariamente, faz o PATCH de categoria, e tenta reagrupar em seguida — essas
    -- colunas guardam o agrupamento original (pra nunca perder o registro de onde reagrupar) e se
    -- a restauração já foi confirmada.
    ALTER TABLE bulk_category_job_items ADD COLUMN IF NOT EXISTS agrupamento_original JSONB;
    ALTER TABLE bulk_category_job_items ADD COLUMN IF NOT EXISTS agrupamento_restaurado BOOLEAN NOT NULL DEFAULT true;

    -- Fila de envio pelo WhatsApp Web (alternativa à API da Meta, ver
    -- docs/plano-whatsapp-web-envio.md). O servidor só enfileira com o texto já montado; quem
    -- envia de fato é o agente local (scripts/whatsapp-web-agente), via claim/resultado.
    -- id é UUID gerado no Node (não sequencial — trafega até o agente).
    -- dedupe_key = origem:referencia, onde referencia já carrega o nº do envio (1º lembrete,
    -- 2º lembrete...) — o índice parcial impede 2 itens vivos iguais, mas deixa reenviar depois
    -- de falha/cancelamento. 'desconhecido' conta como vivo: a mensagem pode ter saído, então só
    -- o admin decide reenviar (nunca um job recriando o mesmo item sozinho).
    CREATE TABLE IF NOT EXISTS whatsapp_web_outbox (
      id UUID PRIMARY KEY,
      origem TEXT NOT NULL,
      referencia TEXT NOT NULL,
      campaign_recipient_id BIGINT REFERENCES campaign_recipients(id) ON DELETE CASCADE,
      loja TEXT,
      evento TEXT,
      telefone TEXT NOT NULL,
      nome TEXT,
      template TEXT,
      texto TEXT NOT NULL,
      midia_ignorada BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      tentativas INTEGER NOT NULL DEFAULT 0,
      claimed_at TIMESTAMPTZ,
      lease_ate TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      failure_code TEXT,
      failure_message TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_wa_web_outbox_status ON whatsapp_web_outbox (status, criado_em);
    CREATE INDEX IF NOT EXISTS idx_wa_web_outbox_sent_at ON whatsapp_web_outbox (sent_at) WHERE status = 'sent';
    CREATE INDEX IF NOT EXISTS idx_wa_web_outbox_recipient ON whatsapp_web_outbox (campaign_recipient_id);
    -- Mensagens próprias do modo WhatsApp Web (não existe template aprovado nem cabeçalho/rodapé/
    -- botões no WhatsApp Web): só texto com a formatação nativa (*negrito*, _itálico_) e variáveis
    -- nomeadas direto no corpo ({{cliente.nome}}). A coluna tipo restringe as variáveis igual aos
    -- templates da Meta (comum | pedido | carrinho).
    CREATE TABLE IF NOT EXISTS whatsapp_web_mensagens (
      id UUID PRIMARY KEY,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,
      corpo TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_web_mensagens_nome ON whatsapp_web_mensagens (lower(nome));

    -- Campanha no modo WhatsApp Web: escolhe uma mensagem própria em vez de template da Meta. O
    -- corpo é congelado no início do disparo (mensagem_web_corpo) — editar a mensagem depois não
    -- muda silenciosamente uma campanha que já começou.
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS mensagem_web_id UUID;
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS mensagem_web_corpo TEXT;

    -- Variações: até 4 versões extras além do corpo (versão 1). Cada envio sorteia uma — mandar
    -- sempre o texto idêntico pra muitos contatos é um dos sinais de spam no WhatsApp. A campanha
    -- congela as variações junto com o corpo; a fila guarda qual versão saiu (1 = corpo).
    ALTER TABLE whatsapp_web_mensagens ADD COLUMN IF NOT EXISTS variacoes JSONB NOT NULL DEFAULT '[]';
    ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS mensagem_web_variacoes JSONB;
    ALTER TABLE whatsapp_web_outbox ADD COLUMN IF NOT EXISTS variacao SMALLINT;
    -- App desktop aperta Enter sem ler a tela: "sent" com envio_confirmado = false significa
    -- "enviado, mas sem confirmação visual". NULL em itens antigos / executor que confirma.
    ALTER TABLE whatsapp_web_outbox ADD COLUMN IF NOT EXISTS envio_confirmado BOOLEAN;
    -- Quem reservou o item: 'app' (app desktop) ou 'celular' (envio assistido pelo painel no
    -- celular, via wa.me). Cada item só é reservado por um dos dois, nunca repete.
    ALTER TABLE whatsapp_web_outbox ADD COLUMN IF NOT EXISTS executor TEXT;
    -- Status antes da reserva pelo celular — "não enviei" devolve pra ele (uma mensagem que
    -- aguardava aprovação não pode voltar liberada pro app enviar sozinho).
    ALTER TABLE whatsapp_web_outbox ADD COLUMN IF NOT EXISTS status_anterior TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_web_outbox_dedupe ON whatsapp_web_outbox (dedupe_key)
      WHERE status IN ('aguardando_aprovacao', 'pending', 'claimed', 'sent', 'desconhecido');

    -- UTM Tracker (docs/claude-utm-tracker-ga4.md) — Builder + campanhas salvas, independente do
    -- Google Analytics (integração de performance real é uma fase futura). url_completa é sempre
    -- recalculada no backend a partir das partes — nunca confia em URL pronta vinda do cliente.
    CREATE TABLE IF NOT EXISTS utm_campaigns (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      nome TEXT NOT NULL,
      url_destino TEXT NOT NULL,
      utm_source TEXT NOT NULL,
      utm_medium TEXT NOT NULL,
      utm_campaign TEXT NOT NULL,
      utm_content TEXT,
      utm_term TEXT,
      url_completa TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      arquivada_em TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_utm_campaigns_loja ON utm_campaigns (loja, arquivada_em, atualizado_em DESC);

    -- Combinações reutilizáveis de source+medium (ex.: "Instagram Story") — só isso é "preset"
    -- persistido; sugestões soltas de source/medium (instagram, facebook, paid_social...) são
    -- estáticas no frontend, não precisam de tabela nem de seed no boot.
    CREATE TABLE IF NOT EXISTS utm_presets (
      id BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      utm_source TEXT NOT NULL,
      utm_medium TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Conexão Google Analytics 4 por loja (Fase 2, docs/claude-utm-tracker-ga4.md §7-12) — OAuth
    -- 2.0, escopo só leitura. refresh/access token ficam SEMPRE criptografados (ver
    -- encriptarSegredo/descriptografarSegredo) — nunca texto plano, nunca no frontend. Uma
    -- conexão por loja (mesma forma que o token da Reserva Ink hoje, um por loja).
    CREATE TABLE IF NOT EXISTS google_analytics_connections (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL UNIQUE,
      property_id TEXT,
      property_name TEXT,
      google_account_email TEXT,
      refresh_token_encrypted TEXT,
      access_token_encrypted TEXT,
      token_expires_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'disconnected',
      connected_at TIMESTAMPTZ,
      last_sync_at TIMESTAMPTZ,
      last_error TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Cache da performance GA4 por loja+período (Fase 3, docs/claude-utm-tracker-ga4.md §16/§20-21)
    -- — nunca consulta a Data API a cada render; TTL de 20 min (dentro dos "15 a 30 min" sugeridos).
    -- 1 linha por (loja, período): o valor de "período" já inclui o range quando é personalizado
    -- (ex. "custom:2026-01-01:2026-01-31"), então trocar as datas é, na prática, outra chave.
    CREATE TABLE IF NOT EXISTS ga4_performance_cache (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      periodo TEXT NOT NULL,
      dados JSONB NOT NULL,
      buscado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (loja, periodo)
    );

    -- ── Meta Ads (docs/meta-ads-analytics-integracao-v2.md §22-29) ─────────────────────────
    -- Conexão com a Meta: UMA só, por decisão de produto (1 cliente = 1 loja; saímos da ideia de
    -- SaaS multi-tenant). O CHECK (id = 1) é o que garante isso no banco, não uma convenção no
    -- código — não existe caminho que crie uma segunda conexão por engano. Se um dia voltar a ser
    -- multi-tenant, troca-se o PK por (tenant_id) e as FKs abaixo acompanham.
    -- O access token fica SEMPRE criptografado, com contexto de chave próprio (CONTEXTO_CRIPTO_META),
    -- separado do contexto do Google — nunca em texto plano, nunca no frontend.
    CREATE TABLE IF NOT EXISTS meta_connections (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      access_token_encrypted TEXT,
      token_expires_at TIMESTAMPTZ,
      meta_user_id TEXT,
      meta_user_nome TEXT,
      escopos TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      connected_at TIMESTAMPTZ,
      last_successful_sync_at TIMESTAMPTZ,
      last_error_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- A conexão enxerga TODAS as contas de anúncio do usuário (hoje são 3); o painel trabalha uma
    -- por vez. O índice parcial é o que impede duas contas marcadas como selecionada ao mesmo tempo
    -- — o "só uma principal" vira invariante do banco, não disciplina de código.
    CREATE TABLE IF NOT EXISTS meta_ad_accounts (
      id BIGSERIAL PRIMARY KEY,
      meta_account_id TEXT NOT NULL UNIQUE,
      nome TEXT,
      currency TEXT,
      timezone_name TEXT,
      timezone_offset_hours_utc NUMERIC,
      account_status INTEGER,
      amount_spent NUMERIC,
      spend_cap NUMERIC,
      selecionada BOOLEAN NOT NULL DEFAULT false,
      last_synced_at TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_meta_ad_accounts_selecionada ON meta_ad_accounts (selecionada) WHERE selecionada;
    -- A qual loja o tráfego desta conta de anúncios leva. Existe porque o consolidado divide
    -- receita REAL da loja por gasto REAL da conta: comparar o gasto de uma conta contra a receita
    -- de lojas que ela não atende infla o MER. Fica no banco, escolhido na interface, em vez de
    -- num nome de cliente no código — numa instalação de uma loja só, resolve sozinho.
    ALTER TABLE meta_ad_accounts ADD COLUMN IF NOT EXISTS loja_atribuida TEXT;

    -- Hierarquia de mídia. Os IDs nativos da Meta são a chave de tudo (spec §7): nome de campanha
    -- muda, ID não. Por isso o UNIQUE é no ID da Meta, e o upsert do sync corrige nome/status de
    -- quem já existe em vez de duplicar. "raw_data" guarda o objeto cru pra não precisar
    -- re-sincronizar quando um campo novo passar a interessar.
    CREATE TABLE IF NOT EXISTS meta_campaigns (
      id BIGSERIAL PRIMARY KEY,
      meta_account_id TEXT NOT NULL,
      meta_campaign_id TEXT NOT NULL UNIQUE,
      nome TEXT,
      objective TEXT,
      status TEXT,
      effective_status TEXT,
      start_time TIMESTAMPTZ,
      stop_time TIMESTAMPTZ,
      created_time TIMESTAMPTZ,
      updated_time TIMESTAMPTZ,
      raw_data JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_meta_campaigns_conta ON meta_campaigns (meta_account_id);

    -- Orçamento em NUMERIC, nunca float (spec §30). A Meta manda daily_budget/lifetime_budget em
    -- CENTAVOS da moeda da conta e como string — a conversão acontece uma vez, no sync.
    CREATE TABLE IF NOT EXISTS meta_adsets (
      id BIGSERIAL PRIMARY KEY,
      meta_account_id TEXT NOT NULL,
      meta_campaign_id TEXT,
      meta_adset_id TEXT NOT NULL UNIQUE,
      nome TEXT,
      status TEXT,
      effective_status TEXT,
      optimization_goal TEXT,
      billing_event TEXT,
      bid_strategy TEXT,
      daily_budget NUMERIC,
      lifetime_budget NUMERIC,
      start_time TIMESTAMPTZ,
      end_time TIMESTAMPTZ,
      created_time TIMESTAMPTZ,
      updated_time TIMESTAMPTZ,
      raw_data JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_meta_adsets_campanha ON meta_adsets (meta_campaign_id);

    CREATE TABLE IF NOT EXISTS meta_ads (
      id BIGSERIAL PRIMARY KEY,
      meta_account_id TEXT NOT NULL,
      meta_campaign_id TEXT,
      meta_adset_id TEXT,
      meta_creative_id TEXT,
      meta_ad_id TEXT NOT NULL UNIQUE,
      nome TEXT,
      status TEXT,
      effective_status TEXT,
      created_time TIMESTAMPTZ,
      updated_time TIMESTAMPTZ,
      raw_data JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_meta_ads_adset ON meta_ads (meta_adset_id);
    CREATE INDEX IF NOT EXISTS idx_meta_ads_criativo ON meta_ads (meta_creative_id);

    -- Criativo com estrutura FLEXÍVEL de propósito (spec §13): Advantage+/Dynamic Creative tem
    -- vários assets, então modelar como "uma imagem + um texto" quebraria na primeira campanha
    -- dinâmica. Os campos nomeados são conveniência pra listar; asset_feed_spec/object_story_spec
    -- guardam a verdade completa. Só URL de imagem — nunca o binário (spec §28).
    CREATE TABLE IF NOT EXISTS meta_creatives (
      id BIGSERIAL PRIMARY KEY,
      meta_account_id TEXT NOT NULL,
      meta_creative_id TEXT NOT NULL UNIQUE,
      nome TEXT,
      title TEXT,
      body TEXT,
      thumbnail_url TEXT,
      image_url TEXT,
      object_story_id TEXT,
      asset_feed_spec JSONB,
      object_story_spec JSONB,
      raw_data JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- O coração da integração (spec §29). Uma linha = 1 entidade + 1 dia + 1 nível + 1 configuração
    -- de atribuição. "entidade_id" existe porque a chave única precisa de uma coluna NOT NULL: no
    -- Postgres duas linhas com NULL na mesma coluna são consideradas DIFERENTES, então um UNIQUE
    -- sobre (campaign_id, adset_id, ad_id) deixaria passar snapshot duplicado no nível account.
    -- Ela recebe o id da entidade daquele nível (conta, campanha, adset ou anúncio).
    -- "data" é a data no fuso da CONTA DE ANÚNCIOS, como a Meta devolve (spec §59).
    CREATE TABLE IF NOT EXISTS meta_insights_daily (
      id BIGSERIAL PRIMARY KEY,
      meta_account_id TEXT NOT NULL,
      level TEXT NOT NULL,
      entidade_id TEXT NOT NULL,
      data DATE NOT NULL,
      attribution_setting TEXT NOT NULL DEFAULT 'default',

      meta_campaign_id TEXT,
      meta_adset_id TEXT,
      meta_ad_id TEXT,

      impressions BIGINT NOT NULL DEFAULT 0,
      reach BIGINT NOT NULL DEFAULT 0,
      frequency NUMERIC,

      clicks BIGINT NOT NULL DEFAULT 0,
      unique_clicks BIGINT NOT NULL DEFAULT 0,
      inline_link_clicks BIGINT NOT NULL DEFAULT 0,
      outbound_clicks BIGINT NOT NULL DEFAULT 0,
      unique_outbound_clicks BIGINT NOT NULL DEFAULT 0,

      spend NUMERIC NOT NULL DEFAULT 0,
      ctr NUMERIC,
      cpc NUMERIC,
      cpm NUMERIC,

      landing_page_views BIGINT NOT NULL DEFAULT 0,
      view_content BIGINT NOT NULL DEFAULT 0,
      add_to_cart BIGINT NOT NULL DEFAULT 0,
      initiate_checkout BIGINT NOT NULL DEFAULT 0,

      purchases BIGINT NOT NULL DEFAULT 0,
      purchase_value NUMERIC NOT NULL DEFAULT 0,
      cost_per_purchase NUMERIC,

      -- NULL (e não 0) quando o anúncio não é de vídeo — a UI mostra "—" (spec §20).
      video_plays BIGINT,
      video_thruplays BIGINT,
      video_25 BIGINT,
      video_50 BIGINT,
      video_75 BIGINT,
      video_95 BIGINT,
      video_100 BIGINT,
      video_avg_watch_time NUMERIC,

      raw_actions JSONB,
      raw_action_values JSONB,

      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (meta_account_id, level, entidade_id, data, attribution_setting)
    );
    CREATE INDEX IF NOT EXISTS idx_meta_insights_conta_data ON meta_insights_daily (meta_account_id, data);
    CREATE INDEX IF NOT EXISTS idx_meta_insights_nivel_data ON meta_insights_daily (level, data);
    CREATE INDEX IF NOT EXISTS idx_meta_insights_campanha_data ON meta_insights_daily (meta_campaign_id, data) WHERE meta_campaign_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_meta_insights_adset_data ON meta_insights_daily (meta_adset_id, data) WHERE meta_adset_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_meta_insights_ad_data ON meta_insights_daily (meta_ad_id, data) WHERE meta_ad_id IS NOT NULL;

    -- Auditoria de cada sincronização (spec §36). Serve pra responder "por que o número mudou?" e
    -- pra a UI mostrar "última sincronização: há 18 min" sem adivinhar.
    CREATE TABLE IF NOT EXISTS meta_sync_logs (
      id BIGSERIAL PRIMARY KEY,
      meta_account_id TEXT,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      date_from DATE,
      date_to DATE,
      records_processed INTEGER NOT NULL DEFAULT 0,
      records_created INTEGER NOT NULL DEFAULT 0,
      records_updated INTEGER NOT NULL DEFAULT 0,
      api_calls INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_meta_sync_logs_recentes ON meta_sync_logs (started_at DESC);

    -- Despesas operacionais (spec §53X) — a peça que fecha o nível 4 do resultado. Enquanto não
    -- havia nenhuma, o Lucro Operacional era travessão porque era genuinamente desconhecido.
    -- Recorrência mensal NÃO gera linhas futuras: uma linha só, expandida na leitura (ver
    -- lib/financeiro/despesas.js). Assim editar o valor de uma mensalidade não exige caçar doze
    -- registros, e não existem despesas fantasma para meses que ainda não aconteceram.
    CREATE TABLE IF NOT EXISTS despesas_operacionais (
      id BIGSERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      categoria TEXT NOT NULL,
      descricao TEXT NOT NULL,
      valor NUMERIC NOT NULL CHECK (valor > 0),
      data DATE NOT NULL,
      recorrencia TEXT NOT NULL DEFAULT 'unica',
      fim DATE,
      notas TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_despesas_loja_data ON despesas_operacionais (loja, data);

    -- ── Google Ads ─────────────────────────────────────────────────────────────────────────
    -- Mesmo desenho das tabelas meta_*: uma conexão só (1 cliente = 1 loja), contas descobertas
    -- pela API, uma selecionada por vez, e insights diários com UNIQUE que torna o sync idempotente.
    --
    -- O token do Google já é guardado por google_analytics_connections, mas a conexão do Ads é
    -- SEPARADA de propósito: os escopos são diferentes (analytics.readonly × adwords) e o usuário
    -- pode autorizar um sem o outro. Amarrar as duas faria a queda de uma derrubar a outra.
    CREATE TABLE IF NOT EXISTS google_ads_connections (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      refresh_token_encrypted TEXT,
      access_token_encrypted TEXT,
      token_expires_at TIMESTAMPTZ,
      google_account_email TEXT,
      escopos TEXT,
      -- Conta de administrador (MCC), quando as contas são acessadas através dela. NULL é o caso
      -- comum desde que o Google deixou de exigir MCC.
      login_customer_id TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      connected_at TIMESTAMPTZ,
      last_successful_sync_at TIMESTAMPTZ,
      last_error_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error_message TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- customer_id sempre SEM hífen (formato que a API exige); a interface formata na exibição.
    CREATE TABLE IF NOT EXISTS google_ads_customers (
      id BIGSERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL UNIQUE,
      nome TEXT,
      currency TEXT,
      timezone_name TEXT,
      -- Conta de administrador não veicula anúncio: separar evita sincronizar uma conta que nunca
      -- terá métrica e depois exibir uma linha zerada como se fosse campanha sem resultado.
      manager BOOLEAN NOT NULL DEFAULT false,
      test_account BOOLEAN NOT NULL DEFAULT false,
      selecionada BOOLEAN NOT NULL DEFAULT false,
      -- Mesma razão de meta_ad_accounts.loja_atribuida: o consolidado divide receita REAL da loja
      -- por gasto REAL da conta, e comparar com a receita de lojas que a conta não atende infla o MER.
      loja_atribuida TEXT,
      last_synced_at TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Invariante no banco, não disciplina de código: nunca duas contas selecionadas.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_google_ads_customers_selecionada
      ON google_ads_customers (selecionada) WHERE selecionada;

    CREATE TABLE IF NOT EXISTS google_ads_campaigns (
      id BIGSERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      nome TEXT,
      status TEXT,
      advertising_channel_type TEXT,
      bidding_strategy_type TEXT,
      budget_amount NUMERIC,
      inicio DATE,
      fim DATE,
      raw_data JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (customer_id, campaign_id)
    );

    -- Insights diários. Guarda CONTADORES, não taxas: CTR, CPC, CPA e ROAS são recalculados na
    -- leitura a partir dos somatórios (lib/google-ads/metricas.js). Guardar taxa por dia convida a
    -- tirar média dela depois, e média de taxa não é a taxa do período.
    --
    -- "custo" já vem convertido de micros — a conversão acontece uma vez, na entrada.
    -- "conversoes" é NUMERIC, não BIGINT: atribuição fracionária faz uma venda valer 0,5, e
    -- arredondar para inteiro perderia ou inflaria vendas.
    CREATE TABLE IF NOT EXISTS google_ads_insights_daily (
      id BIGSERIAL PRIMARY KEY,
      customer_id TEXT NOT NULL,
      level TEXT NOT NULL,
      entidade_id TEXT NOT NULL,
      data DATE NOT NULL,
      campaign_id TEXT,

      impressoes BIGINT NOT NULL DEFAULT 0,
      cliques BIGINT NOT NULL DEFAULT 0,
      custo NUMERIC NOT NULL DEFAULT 0,

      conversoes NUMERIC NOT NULL DEFAULT 0,
      valor_conversoes NUMERIC NOT NULL DEFAULT 0,
      -- Qual contagem gerou os dois números acima ('conversions' ou 'all_conversions'). Sem isso,
      -- trocar a preferência reescreveria o passado sem deixar rastro de qual regra valia.
      contagem_conversao TEXT NOT NULL DEFAULT 'conversions',

      -- NULL (e não 0) quando a campanha não tem vídeo — "0 visualizações" sugere um vídeo que
      -- ninguém viu, que é diferente de não haver vídeo.
      video_views BIGINT,

      raw_data JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (customer_id, level, entidade_id, data, contagem_conversao)
    );
    CREATE INDEX IF NOT EXISTS idx_google_ads_insights_conta_data
      ON google_ads_insights_daily (customer_id, data);
    CREATE INDEX IF NOT EXISTS idx_google_ads_insights_campanha_data
      ON google_ads_insights_daily (campaign_id, data) WHERE campaign_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS google_ads_sync_logs (
      id BIGSERIAL PRIMARY KEY,
      customer_id TEXT,
      tipo TEXT NOT NULL,
      status TEXT NOT NULL,
      periodo_inicio DATE,
      periodo_fim DATE,
      linhas_gravadas INTEGER NOT NULL DEFAULT 0,
      api_calls INTEGER NOT NULL DEFAULT 0,
      duracao_ms INTEGER,
      erro_codigo TEXT,
      erro_mensagem TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_google_ads_sync_logs_data ON google_ads_sync_logs (criado_em DESC);

    -- Preços das APIs corrigidos pelo cliente (lib/custos/precos.js). Só guarda o que ele EDITOU:
    -- a tabela padrão vive no código, e mesclar na leitura evita que um preço padrão atualizado
    -- fique preso numa linha velha do banco. A moeda vem junto porque ele pode digitar em BRL o
    -- que o provedor publica em USD — e somar moedas diferentes daria um número sem significado.
    CREATE TABLE IF NOT EXISTS custos_api_precos (
      chave TEXT PRIMARY KEY,
      valor NUMERIC NOT NULL CHECK (valor >= 0),
      moeda TEXT NOT NULL DEFAULT 'USD',
      confianca TEXT NOT NULL DEFAULT 'confirmado',
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );