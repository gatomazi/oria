'use strict';

// TD-004, Opção A — tabela `integration_secrets` dedicada, 1:N a partir de `integrations`.
//
// Por que 1:N e não colunas na `integrations`: a auditoria mostra provedores com vários segredos de
// ciclos de vida DIFERENTES (Meta tem access + refresh token; Ink tem token + webhook secret;
// Google tem refresh token). Com colunas, `key_version`, `expires_at` e `rotated_at` seriam
// compartilhados por segredos que rotacionam em momentos distintos — o que quebra o requisito de
// rotação incremental da própria TD-004.
//
// Por que o ciphertext mora numa tabela à parte: o modo de falha recorrente nesta base é segredo
// escapando para resposta ou log. Com esta forma, um `SELECT *` descuidado em `integrations`
// FISICAMENTE não devolve ciphertext. É o mesmo raciocínio da RLS (INV-07): defesa que sobrevive a
// uma query mal escrita.
//
// ── Sobre `organization_id` ───────────────────────────────────────────────────────────────────
// A coluna existe aqui, mas é NULLABLE e SEM foreign key: a tabela `organizations` só nasce na
// Fase 1. Esta migration NÃO adiciona `organization_id` a nenhuma tabela de negócio existente —
// `integrations` e `integration_secrets` são tabelas novas, vazias, criadas nesta fase só para
// receber a re-cifra de TD-004. A FK, o `NOT NULL` e a RLS entram na Fase 1, junto com as outras
// 49 tabelas, na sequência `adicionar → backfill → NOT NULL`.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS integrations (
      id BIGSERIAL PRIMARY KEY,
      -- Fase 1 torna NOT NULL e cria a FK para organizations.
      organization_id UUID,
      provider TEXT NOT NULL,
      -- Escopo de domínio da conexão enquanto a tenancy não existe (ex.: 'sul'/'centro'/'norte').
      -- A Fase 1 passa o eixo de isolamento para organization_id; esta coluna vira dado de domínio.
      escopo TEXT,
      status TEXT NOT NULL DEFAULT 'disconnected',
      -- Somente configuração NÃO sensível. Nada de token, refresh token ou app secret aqui.
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- UNIQUE inclui organization_id desde já: a Fase 1 exige que TODO índice único de tabela
    -- tenant-scoped o inclua (INV-05). Criar o índice certo agora evita reconstruí-lo depois.
    -- NULLS NOT DISTINCT para que o período pré-Fase-1 (organization_id NULL) ainda tenha
    -- unicidade real por (provider, escopo).
    CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_org_provider_escopo
      ON integrations (organization_id, provider, escopo) NULLS NOT DISTINCT;

    CREATE TABLE IF NOT EXISTS integration_secrets (
      id BIGSERIAL PRIMARY KEY,
      integration_id BIGINT NOT NULL REFERENCES integrations (id) ON DELETE CASCADE,
      -- Denormalizado de propósito: a RLS da Fase 1 precisa do discriminador NA PRÓPRIA linha,
      -- senão a policy vira um JOIN e deixa de ser rede de segurança contra query mal escrita.
      organization_id UUID,
      -- 'access_token' | 'refresh_token' | 'webhook_secret' | 'api_key' | ...
      tipo TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      -- Versão da chave que cifrou ESTA linha. 0 = chave legacy derivada de ADMIN_SESSION_SECRET.
      -- Leitura aceita versões ativas; escrita usa sempre a corrente (TD-004).
      key_version INTEGER NOT NULL,
      -- Metadata que PODE ir para API e log. O segredo em si, nunca.
      last4 TEXT,
      expires_at TIMESTAMPTZ,
      rotated_at TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_secrets_integracao_tipo
      ON integration_secrets (integration_id, tipo);

    -- Encontrar tudo que ainda está numa key_version velha é a consulta central da rotação
    -- incremental. Sem este índice ela é um seq scan na tabela mais sensível do banco.
    CREATE INDEX IF NOT EXISTS idx_integration_secrets_key_version
      ON integration_secrets (key_version);
  `);
};

// Reversível de verdade: as duas tabelas nascem vazias nesta fase. A re-cifra dos segredos que
// hoje vivem em meta_connections / google_ads_connections / ga_connections é uma migration
// POSTERIOR (Fase 4), justamente para que este passo continue revertível.
exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS integration_secrets;
    DROP TABLE IF EXISTS integrations;
  `);
};
