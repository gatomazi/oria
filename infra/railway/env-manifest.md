# Railway — manifesto de variáveis do projeto Oria

Rodada 20. **Só nomes.** Nenhum valor real aparece aqui, e nenhum segredo foi copiado dos projetos
antigos. Os nomes vieram do código importado (`process.env` no painel, `getEnv` no Go, `Procfile` e
`gunicorn.conf.py` no Gerador).

## Princípios

1. **Service-scoped por padrão.** Uma variável só é do projeto (shared) quando é realmente de
   plataforma e usada por mais de um service.
2. **Credencial de tenant nunca vira env.** Tokens de cliente (Ink, Meta, Google, GA4, OpenAI,
   WhatsApp) moram no cofre do painel (`integration_secrets`, cifrado com `ENCRYPTION_MASTER_KEY`).
   As variáveis `INK_TOKEN_*`, `WHATSAPP_LEGACY_*` e afins são **legado temporário** do cutover.
3. **Segredo compartilhado entre dois services** (ex.: painel ↔ Go) é configurado nos dois com o
   mesmo valor, e cada lado tem seu nome — não existe "shared secret" mágico.
4. **Nada de `.env` no repositório.** O único arquivo versionado é `services/whatsapp/.env.example`,
   com placeholders.

## PROJECT / SHARED

| variável | usada por | observação |
|---|---|---|
| `NODE_ENV` / `APP_ENV` | painel / Go | `production` em produção. O painel muda de comportamento (fail-fast) por causa dela |
| `META_APP_ID` | painel, Go | id público do App da plataforma |
| `META_APP_SECRET` | Go (verificação HMAC), painel (OAuth Meta) | **OPS-27**: precisa pertencer ao mesmo App |
| `META_API_VERSION` | painel, Go | versão da Graph API |

## PANEL ONLY

**Plataforma e banco:** `DATABASE_URL`, `MIGRATION_DATABASE_URL` (a partir do OPS-14),
`DB_ENFORCE_APP_ROLE`, `DATA_STORE_MODE`, `PORT`, `SITE_BASE_URL`,
`STORAGE_DIR`, `UPLOADS_DIR`, `IMG_CACHE_DIR`, `RAILWAY_VOLUME_MOUNT_PATH`.

**Segredos da plataforma:** `ENCRYPTION_MASTER_KEY`, `ENCRYPTION_KEY_VERSION`,
`ENCRYPTION_MASTER_KEY_PREV`, `ADMIN_SESSION_SECRET`.

**Integração com os outros services:**

| variável | para quem aponta |
|---|---|
| `CREATIVE_CORE_URL` | `oria-creatives` (domínio privado) |
| `CREATIVE_CORE_SERVICE_TOKEN` | mesmo valor do `oria-creatives` |
| `WHATSAPP_SERVICE_URL`, `WHATSAPP_API_KEY` | `oria-whatsapp` (domínio privado) |
| `WHATSAPP_SENDER_REF_SECRET` | só do painel (assina a referência; o Go não conhece) |
| `WHATSAPP_SENDER_RESOLVER_KEY` | = `PANEL_SENDER_RESOLVER_KEY` do Go |
| `WHATSAPP_WEBHOOK_SECRET` | = `WEBHOOK_FORWARD_SECRET` do Go (repasse assinado; ≥ 32, obrigatória em produção) |
| `WHATSAPP_CONTEXT_RATE_PER_MIN` | limite dos endpoints de contexto (opcional) |

**OAuth e APIs externas:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`,
`GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID`, `GOOGLE_ADS_API_VERSION`,
`GOOGLE_ADS_SYNC_INTERVALO_MIN`, `GOOGLE_ADS_BACKFILL_DIAS`, `META_OAUTH_REDIRECT_URI`,
`META_SYNC_INTERVALO_MIN`, `META_BACKFILL_DIAS`.

**Fase 7 (travada):** `SECOND_TENANT_ENABLED` (ausente/`0` em produção; o preflight bloqueia ligada),
`ONBOARDING_STEP_REQUIREMENTS`.

## CREATIVES ONLY

| variável | obrigatória | observação |
|---|---|---|
| `CREATIVE_CORE_SERVICE_TOKEN` | **sim** (≥ 32) | mesmo valor do painel; sem ela o serviço não sobe |
| `PORT` | não | Railway injeta |
| `WEB_CONCURRENCY` | não | workers do gunicorn |
| `OPENAI_IMAGE_MODEL`, `OPENAI_TEXT_MODEL`, `*_FALLBACKS` | não | ajustes de modelo |

A chave da OpenAI é **BYOK**: vem por request, do cofre do painel. Não existe `OPENAI_API_KEY` no service.

## WHATSAPP ONLY

| variável | obrigatória | observação |
|---|---|---|
| `DATABASE_URL` | sim | Postgres próprio do serviço |
| `API_KEY` | sim | autenticação service-to-service |
| `META_APP_SECRET`, `META_APP_ID` | sim | HMAC do webhook (OPS-27) |
| `META_VERIFY_TOKEN` | sim | verificação do webhook na Meta |
| `PANEL_SENDER_RESOLVER_URL`, `PANEL_SENDER_RESOLVER_KEY` | sim | resolver do remetente e contexto (5b/5c) |
| `WEBHOOK_FORWARD_URL`, `WEBHOOK_FORWARD_SECRET` | sim (quando há repasse) | URL **sem** query; segredo ≥ 32 |
| `PORT`, `META_API_VERSION` | não | padrões no código |
| `WEBHOOK_QUEUE_BATCH`, `WEBHOOK_QUEUE_LEASE` | não | ajuste da fila |

## PRE-DEPLOY ONLY (painel)

Só o *Pre-deploy Command* precisa: `TENANCY_MAPPING_JSON` (conteúdo do mapeamento) e
`TENANCY_MAPPING_FILE` (caminho gravado pelo próprio comando), `AUTH_BOOTSTRAP_OWNER_EMAIL`,
`AUTH_BOOTSTRAP_OWNER_NOME`, `AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH`,
`AUTH_BOOTSTRAP_ORGANIZATION_IDS`, `ENTITLEMENTS_SEED_ORGANIZATION_IDS`,
`ENTITLEMENTS_SEED_PROFILE`, `ENTITLEMENTS_SEED_FEATURES` (só na RELEASE B, igual ao perfil),
`WHATSAPP_LEGACY_PHONE_NUMBER_ID`, `WHATSAPP_LEGACY_WABA_ID`, `WHATSAPP_LEGACY_ACCESS_TOKEN`,
`WHATSAPP_LEGACY_REPLY_REDIRECT_NUMBER`, `WHATSAPP_LEGACY_REPLY_REDIRECT_MESSAGE`,
`WHATSAPP_LEGACY_NOTIFY_NUMBER`.

## LEGACY TEMPORARY (sai no CLEANUP do runbook)

| variável | service | sai em |
|---|---|---|
| `ALLOW_LEGACY_ADMIN_PASSWORD`, `ADMIN_PASSWORD`, `LEGACY_ADMIN_USER_EMAIL` | painel | OPS-19 (flag antes da RELEASE F) |
| `ALLOW_LEGACY_INTEGRATION_ENV`, `INK_TOKEN_*`, `INK_FEED_URL_*`, `GOOGLE_ADS_EM_USO` | painel | OPS-24 |
| `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY` | painel | OPS-25 (antes da rotação do `ADMIN_SESSION_SECRET`) |
| `INK_WEBHOOK_SECRET_*` | painel | OPS-34 |
| `CREATIVE_TENANT_ID`, `CREATIVE_LEGACY_READ_FROM`, `CREATIVE_LEGACY_READ_ORGANIZATION_ID` | painel | OPS-22 |
| `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED` | painel | OPS-09 parte 3 |
| `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET` | Go | OPS-09 parte 3 |
| `WHATSAPP_LEGACY_*` | painel | OPS-29 |
| `LEGACY_ORGANIZATION_ID` | Go | OPS-32 |
| `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_WABA_ID` | Go | 5b Release D |
| `REPLY_REDIRECT_*`, `REPLY_NOTIFY_NUMBER`, `REPLY_COOLDOWN_MINUTES` | Go | OPS-35 |

## Só em teste/desenvolvimento (nunca em produção)

`TEST_DATABASE_URL`, `INVARIANTS_DATABASE_URL`, `INVARIANTS_APP_DATABASE_URL`,
`WEBHOOK_TEST_DATABASE_URL`, `TEST_PG_CONTAINER`, `TEST_PG_IMAGE`, `TEST_PG_KEEP`, `TEST_APP_ROLE`,
`WHATSAPP_GO_DIR`, `CREATIVE_PYTHON`, `ORIA_LEGACY_PANEL_REPO`, `INTERNAL_TOOLS_ENABLED`,
`META_GRAPH_BASE_URL` (o preflight **bloqueia** esta no Go em produção — OPS-35).

## Conferência

`npm run release:preflight -- --from-env-file <export> [--service painel|go]` lê um export do Railway
e confere **nomes e requisitos** (nunca valores). É o que decide se um estágio do runbook pode seguir.
