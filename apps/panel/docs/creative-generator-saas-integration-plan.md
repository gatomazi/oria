# Plano de integração — Gerador de Criativos no painel (Oria)

> Etapa 2. Specs: `docs/creative-generator/02-etapa-saas-3-motores-multipeça-integrado-v2.md` e o contrato
> `docs/creative-generator/GENERATOR_HANDOFF_CONTRACT.md`. Substitui `docs/implementacao_gerador_criativos_saas_painel_angulos_multipeca.md`.

## 1. Arquitetura atual do painel (o que existe e será reaproveitado)

| Área | Hoje | Uso no gerador |
|---|---|---|
| Backend | `server.js` monolítico (Express, ~14.9k linhas), rotas `/api/admin/*` com `requireAdmin` (cookie de sessão, 1 admin, sem roles) | módulo novo `routes/criativos.js`; em `server.js` só o mount |
| Banco | Postgres opcional (`DATABASE_URL`), DDL inline `CREATE TABLE IF NOT EXISTS` no boot; sem ferramenta de migration | DDL aditivo próprio em `lib/creative-core/schema.js`; **o gerador exige Postgres** (sem ele: 503) |
| Multi-tenant | não existe (comentário em `server.js`: "não é multi-tenant de verdade") | coluna `tenant_id` em todas as tabelas, valor definido pelo servidor (`CREATIVE_TENANT_ID`, padrão `default`), nunca pelo request |
| Features/planos | `entitlements` (JSON em `app_config`/`db/entitlements.json`, gitignored) | flags `creative_*` com default **desligado** no código; override por env `CREATIVE_FEATURE_FLAGS` |
| Criptografia | `encriptarSegredo/descriptografarSegredo` AES-256-GCM, chave por contexto via HKDF de `ADMIN_SESSION_SECRET` | BYOK com contexto próprio `openai-api-key-creative-v1` |
| Jobs | padrão de jobs em tabela + worker em processo (`bulk_category_jobs`, `setInterval`) | `creative_jobs` + `creative_generations` + worker em processo |
| Storage | `UPLOADS_DIR` (volume Railway) + `media_assets` | `UPLOADS_DIR/creatives/tenant/{tenant_id}/…` |
| Admin | React/TS/Vite, lazy routes em `admin/src/App.tsx`, navegação em `admin/src/shell/nav.ts`, design system `components/ds` | página `/admin/criativos` com abas |
| Testes | `node --test test/*.test.js` | `test/creative-core.test.js` |

## 2. Integração com o core

Decisão (handoff §17, revisada pelo usuário em 15/09): o core Python vive **neste repositório** em `services/creative-core/`
(fonte única da verdade) e roda como **serviço separado no Railway** (Root Directory = `services/creative-core`,
serviço `creative-lab` configurado pelo painel; build Railpack via `requirements.txt`/`.python-version`, runtime em `gunicorn.conf.py`). O Node conversa por HTTP via
`lib/creative-core/client.js`. O gerador interno (projeto estamparia-criativos) mantém um espelho byte a byte verificado
por script.

Pontos de integração:

| Endpoint do core | Chamado por | Quando |
|---|---|---|
| `GET /v1/health` | `GET /api/admin/criativos/status` | tela abre |
| `GET /v1/contracts` (catálogo) | `GET /api/admin/criativos/catalog` | formulário |
| `POST /v1/validate/{BrandKit,NicheKit,ContextProfile,Persona}` | salvar kit/perfil/persona | edição |
| `POST /v1/plans` | criação do job (valida o 1º item na hora) e worker (todos os itens) | síncrono curto |
| `POST /v1/generations` | worker | dentro do job, 1 por item |
| `POST /v1/copies` | `POST /api/admin/criativos/copies` | sob demanda |

Falha graciosa: sem `CREATIVE_CORE_URL`/token, com o serviço fora do ar ou lento, as rotas respondem 503 e o boot do
Node nunca depende do serviço.

## 3. Estratégias SaaS e productMode

Somente `CLEAN_ANGLES`, `REMARKETING`, `FUNNEL_VISUAL` (o core rejeita qualquer outra). Multipeça = `product_mode`
(`single_product` | `multi_product`) validado pelo core (limites: Limpos 2–6, Remarketing 2–5 com regra por intenção,
Funil 2–6).

## 4. Feature flags

`creative_generator` (módulo), `creative_clean_angles`, `creative_remarketing`, `creative_funnel_visual`,
`creative_multi_product`. Todas `false` por padrão. Checadas no backend em toda rota (exceto `status`/`catalog`, que
só mostram o estado); a UI apenas reflete.

## 5. BYOK

- `PUT /api/admin/criativos/settings/openai-key` grava cifrado (`creative_settings.openai_key_enc`) + últimos 4 dígitos.
- Nunca devolvida, nunca logada, nunca em `localStorage`, nunca em job/erro. Descifrada só no worker, na hora da chamada.
- `POST …/openai-key/test` valida a key com `GET https://api.openai.com/v1/models` (sem custo de geração).

## 6. Jobs

Estados do job: `queued → planning → generating → processing → completed | partial | failed | cancelled`.
Itens (`creative_generations`): `queued`, `planning`, `generating`, `processing`, `completed`, `failed`, `cancelled`.
Retry individual incrementa `generation_attempt` mantendo `creative_id`. Falha de um item não derruba o lote (`partial`).
Worker em processo, 1 item por vez, tolera reinício (itens presos em `planning/generating/processing` voltam para `queued`).

## 7. Storage

`UPLOADS_DIR/creatives/tenant/{tenant_id}/creatives/{creative_id}/image.png` e referências de produto em
`…/tenant/{tenant_id}/products/{product_id}/{uuid}.{ext}`. Nomes gerados pelo servidor (UUID), tipo validado por magic
bytes, tamanho máximo 10 MB. Servidos só por rota autenticada.

## 8. Migrations (DDL aditivo)

`creative_settings`, `creative_brand_profiles`, `creative_niche_profiles`, `creative_context_profiles`,
`creative_products`, `creative_personas`, `creative_jobs`, `creative_generations`, `creative_assets` — só
`CREATE TABLE/INDEX IF NOT EXISTS`, executado no mount do módulo, com erro logado sem derrubar o boot. Nenhum ALTER/DROP
em tabela existente.

## 9. Endpoints (`/api/admin/criativos`, todos com `requireAdmin`)

`GET status` · `GET catalog` · `GET/PUT/DELETE settings/openai-key` · `POST settings/openai-key/test` ·
`GET/POST/PUT brand-kits` · `GET/POST/PUT niche-kits` · `GET/POST/PUT context-profiles` · `GET/POST/DELETE products` ·
`GET/POST/DELETE personas` · `POST preview` · `GET/POST jobs` · `GET jobs/:id` · `POST jobs/:id/cancel` ·
`POST jobs/:id/items/:creativeId/retry` · `GET history` · `GET assets/:creativeId` · `POST copies`.

## 10. Páginas

`/admin/criativos` (grupo "Criativos" na navegação): abas Gerar · Lotes · Histórico · Produtos · Marca e nicho ·
Contextos · Personas · Configurações. Primeira decisão = motor; segunda = um produto / multipeça. Lapidação visual fica
para a Etapa 3.

## 11. Permissões

Um nível de admin (existente). Proteção real no backend: `requireAdmin` + flags + `tenant_id` do servidor.

## 12. Riscos

| Risco | Mitigação |
|---|---|
| Outro agente editando `server.js`/`App.tsx`/`nav.ts` na `master` | inserção mínima, commits com paths explícitos, sem reformatar |
| `express.static` serve a raiz do repo | bloquear `/services/` e `/routes/` antes do static |
| Deploy acidental (push de terceiros) | flags desligadas, DDL aditivo, 503 sem serviço |
| Serviço Python lento | geração só dentro de job; timeout 240 s |
| Geração real não testada | roteiro manual `docs/creative-generator/MANUAL_TEST_GUIDE.md` |

## 13. Testes

Node: `test/creative-core.test.js` (cliente, flags, BYOK, expansão do pedido, worker, rotas em servidor efêmero com
store em memória e core falso). Python: `services/creative-core/run_tests.py`. Admin: `tsc -b --noEmit` + `vite build`.
