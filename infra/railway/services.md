# Railway — matriz de services do projeto Oria

Rodada 20, atualizado na rodada 21. **Documento. Nenhum service, banco ou volume foi criado.** Os
comandos abaixo foram derivados dos projetos importados (`package.json`, `Procfile`, `Dockerfile`,
`gunicorn.conf.py`), não inventados.

Projeto Railway: **Oria** (novo) · três services apontando para o **mesmo** repositório
`gatomazi/oria`, cada um com seu *Root Directory*.

> **Alvo fechado (rodada 21).** O projeto **Oria** é o alvo do rollout. O **projeto Railway antigo é
> stack legada e origem de rollback**: continua no ar durante a transição, e nenhum passo do rollout
> tem ele como destino. Ordem de criação em
> [`../../docs/operations/railway-bootstrap.md`](../../docs/operations/railway-bootstrap.md);
> estratégia de cutover no runbook, §20.

## Visão geral

| service | root directory | runtime | público? | banco | volume |
|---|---|---|---|---|---|
| `oria-panel` | `apps/panel` | Node ≥ 20.11 | **sim** (painel e webhooks da Ink) | Postgres do painel | **sim** (uploads/criativos/cache) |
| `oria-creatives` | `apps/creative-generator` | Python 3.12 | não (rede privada) | não | não |
| `oria-whatsapp` | `services/whatsapp` | Go 1.25 (Dockerfile) | **sim** (webhook da Meta) | Postgres próprio | não |

## `oria-panel`

| item | valor |
|---|---|
| Root Directory | `apps/panel` |
| Runtime | Node (`engines.node >= 20.11`), builder padrão do Railway |
| Build | `npm ci` roda o `postinstall`: `npm --prefix admin install && npm --prefix admin run build` (gera `admin/dist`) |
| Start | `npm start` → `node server.js` (escuta em `PORT`, padrão 8080) |
| Health endpoint | **não existe hoje.** O serviço não expõe `/health`. Usar `GET /` (página pública) como healthcheck, ou criar um endpoint próprio numa rodada futura — não inventar um caminho que não existe |
| Pre-deploy | runbook §8.2: grava o mapeamento, `migrate:up`, `auth:bootstrap-owner`, `tenancy:seed-entitlements`, `integrations:import-legacy --aplicar`, `integrations:reencrypt`, `integrations:import-whatsapp-sender`. A partir do OPS-14: `export DATABASE_URL="$MIGRATION_DATABASE_URL"` antes do bloco |
| Volume | **sim** — `RAILWAY_VOLUME_MOUNT_PATH` (ou `STORAGE_DIR`): uploads (`UPLOADS_DIR`, criativos do Creative Core), cache de imagens (`IMG_CACHE_DIR`) |
| Banco | Postgres do painel (`DATABASE_URL`), com RLS FORCE e migrations versionadas |
| Depende de | `oria-creatives` (privado, `CREATIVE_CORE_URL`) e `oria-whatsapp` (privado, `WHATSAPP_SERVICE_URL`) |
| Ingress público | necessário: painel administrativo e `POST /api/webhooks/ink/:token` |

## `oria-creatives`

| item | valor |
|---|---|
| Root Directory | `apps/creative-generator` |
| Runtime | Python 3.12 (`.python-version`), builder Railpack/Nixpacks com `requirements.txt` |
| Build | instalar `requirements.txt` (Pillow, openai, gunicorn) |
| Start | `gunicorn 'creative_core.service:create_app()'` (do `Procfile`; `gunicorn.conf.py` faz o bind em `[::]:$PORT`, padrão 8765) |
| Health endpoint | `GET /v1/health` (única rota sem token) |
| Pre-deploy | nenhum |
| Volume | não (serviço stateless) |
| Banco | não |
| Variáveis obrigatórias | `CREATIVE_CORE_SERVICE_TOKEN` (≥ 32; o mesmo do painel). Sem ela o serviço não sobe |
| Ingress público | **não.** Só rede privada; o painel chama por `CREATIVE_CORE_URL` |

## `oria-whatsapp`

| item | valor |
|---|---|
| Root Directory | `services/whatsapp` |
| Runtime | Go 1.25 via `Dockerfile` (multi-stage, binário estático, `EXPOSE 8080`) |
| Build | `docker build` (o Dockerfile já está no serviço; não precisa de configuração extra) |
| Start | `CMD ["./webhook"]` (escuta em `PORT`, padrão 8080) |
| Health endpoint | `GET /health` (sem credencial; responde `{"status":"ok"}`) |
| Pre-deploy | nenhum. As migrations do serviço rodam no boot, com advisory lock entre réplicas |
| Volume | não |
| Banco | Postgres **próprio** do serviço (`DATABASE_URL`), separado do painel |
| Depende de | painel (`PANEL_SENDER_RESOLVER_URL`, privado) e Meta (externo) |
| Ingress público | **necessário**: o webhook da Meta precisa alcançar o serviço. As rotas internas continuam exigindo `API_KEY` e assinatura |

## Rede

```text
navegador ──público──► oria-panel ──privado──► oria-creatives
                            │
                            └──privado──► oria-whatsapp ──público (entrada)──► Meta webhook
                                              │
                                              └──privado──► oria-panel (repasse assinado)
```

- **Público:** `oria-panel` (painel + webhook da Ink) e `oria-whatsapp` (webhook da Meta).
- **Privado:** `oria-creatives`. O navegador nunca fala com ele.
- As chamadas painel ↔ WhatsApp e painel → Gerador usam o domínio interno do Railway
  (`*.railway.internal`), com autenticação service-to-service (OPS-01/02 e o contrato 5b/5c).

## Bancos

Os boundaries atuais **não mudam** por causa do monorepo:

| banco | de quem | por quê |
|---|---|---|
| Postgres do painel | `oria-panel` | tenancy, RLS, migrations do painel |
| Postgres do WhatsApp | `oria-whatsapp` | fila, inbox, eventos e problemas do serviço Go, com migrations próprias |
| — | `oria-creatives` | stateless: não precisa de banco, e nenhum será criado |

## Volumes

| service | caminho | conteúdo | observações |
|---|---|---|---|
| `oria-panel` | `RAILWAY_VOLUME_MOUNT_PATH` (ex.: `/data`) | `uploads/` (criativos do Creative Core, artes, mídia), `img-cache/` | O OPS-22 opera **dentro** deste volume: o vínculo (`creatives/tenant/<org>` → `<legado>`) e depois a materialização. O backup do volume precisa **preservar links simbólicos** |
| `oria-creatives` | — | — | stateless |
| `oria-whatsapp` | — | — | estado só no Postgres |

## Dockerfile

Só o `oria-whatsapp` tem Dockerfile, porque o build Go multi-stage já existia e é o caminho testado.
Painel e Gerador usam o builder padrão do Railway: `package.json`/`Procfile` bastam.
