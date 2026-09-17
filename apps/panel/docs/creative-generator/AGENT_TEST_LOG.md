# AGENT_TEST_LOG — Oria / Orgulho Regional (Etapa 2)

Ambiente: macOS, Node v26.7.0, Python 3.12.3 (venv do projeto estamparia-criativos, com Pillow/openai; **gunicorn não instalado**), sem Postgres instalado (usado um Postgres 18.4 privado em diretório temporário, porta 54411, só TCP).

## T-201 — Baseline antes de qualquer alteração
| Comando | Resultado |
|---|---|
| `npm test` | 64 testes: 63 pass, 1 skipped, 0 fail |
| `npx tsc -b --noEmit` (admin) | exit 0 |
| `npx vite build --outDir <tmp>` (admin, fora de `admin/dist`) | exit 0 |

## T-202 — Serviço Python (`services/creative-core`)
- `python run_tests.py` → build OK, **6/6 suítes, 95 testes** (14+16+4+28+19+14).
- 1ª execução: 2 falhas corrigidas — drift do `contracts.d.ts` (core_version mudou para 1.1.0 → schemas regenerados) e teste usando `ROOT` removido (erro do teste).
- `scripts/sync_data.py <gerador> --check` → "data in sync".
- gunicorn: **não testado** (não instalado no ambiente). O `create_app()` foi exercitado com wsgiref no E2E (T-206).

## T-203 — Módulo Node (`test/creative-core.test.js`)
- `node --test test/creative-core.test.js` → **25/25** (1ª execução).

## T-204 — Boot do `server.js` isolado (STORAGE_DIR/UPLOADS_DIR temporários, sem DATABASE_URL)
- Sobe ("Orgulho Regional na porta 18099"); `/api/admin/criativos/status` sem login 401; `/services/creative-core/README.md` 404; `/routes/criativos.js` 404; `/admin/dashboard` 200; `/api/admin/entitlements` sem login 401.

## T-205 — pgStore contra Postgres real (`test/creative-core-pg.test.js`)
- `CREATIVE_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54411/criativos_e2e node --test test/creative-core-pg.test.js` → **1/1** (schema 2× idempotente, versões de perfil, fila, retry, requeue, next_attempt_at, cancelamento, histórico, isolamento de tenant). Sem a env: skipped.

## T-206 — E2E local sem custo: Node + Postgres + serviço Python real + OpenAI falso
Processos: `server.js` (DATABASE_URL do Postgres privado, flags via env), `python -m creative_core.service` (OPENAI_BASE_URL apontando para um servidor falso local), fake OpenAI respondendo `/v1/images/edits` com PNG 1024×1536.

| Passo | Resultado |
|---|---|
| login admin | 200 |
| status | engines 3, postgres true, core reachable, key false |
| catálogo | 13 ângulos, REMARKETING.max 5 |
| PUT key | 200, resposta só `last4`, key não aparece |
| Brand Kit inválido | 422 "dados inválidos: evil: unknown field; tone: expected array" |
| Brand Kit v1 → v2 | 201 / 200 v2 |
| prévia Cabide com nicho genérico | 422 UNSUPPORTED_ANGLE |
| prévia com contexto draft | 422 CONTEXT_RESOLUTION_FAILED |
| prévia remarketing product_view multipeça | 422 UNSUPPORTED_PRODUCT_MODE |
| lote CLEAN single (Feed+Story) | completed 2/2, asset PNG 1080×1350 |
| lote REMARKETING multi (4, coleção) | completed 1/1, layout flatlay_hero_stack, headline "Não achou o seu ainda?" |
| lote FUNNEL MOFU multi (3) | completed 1/1 |
| histórico | 4 registros com engine, product_mode, brand_kit_version 2, prompt_version 1, tenant_id |
| key/prompt em histórico, lotes, prévias | não encontrados |
| key no banco | `openai_key_enc` sem `sk-`; `plan` sem a key |
| fake OpenAI | 4 chamadas de imagem, header Authorization terminando com os 4 últimos da key cadastrada (BYOK chegou decifrado ao core) |
| logs Node/serviço | 0 ocorrências da key |
| `/history` sem cookie | 401 |
| `/services/...communication.json` | 404 |

Processos e Postgres encerrados ao final.

## T-207 — Final
| Comando | Resultado |
|---|---|
| `npm test` | 109 testes: 107 pass, 2 skipped, 0 fail. Por arquivo: creative-core 25/25; creative-core-pg 1 skipped; meta 36/36; meta-criativos 19/19; ink-financeiro 8/8; meta-schema 1 skipped (os 64 do baseline inalterados); financeiro-consolidado 19/19 (arquivo novo **do outro agente**, não rastreado no momento) |
| `npx tsc -b --noEmit` (admin) | exit 0, 0 linhas |
| `npx vite build --outDir <tmp>` | exit 0 (chunk `CriativosPage` 35.9 kB) |
| `.claude/skills/impeccable/scripts/impeccable detect` (arquivos novos do admin + css) | exit 0, sem saída |
| `services/creative-core/run_tests.py` | 6/6 suítes |

## Não executado
- Geração real na OpenAI (proibida nesta etapa — ver `MANUAL_TEST_GUIDE.md`).
- gunicorn / build Nixpacks / deploy Railway.
- Capturas de tela em 320/390/768/1440 px e axe-core (checklist de tela nova): **não feitas** — ficam para a Etapa 3.
