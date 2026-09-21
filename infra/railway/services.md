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

## Comandos finais por service (rodada 22)

O primeiro deploy falhou com **"No start command detected"** porque foi construído a partir da **raiz**
do monorepo. A raiz é orquestradora: o `package.json` dela só chama subprocessos e **não tem** `start`
— e não vai ter. Cada service constrói a partir do seu **Root Directory**.

| service | Root Directory | Build Command | Start Command | Pre-deploy | Healthcheck |
|---|---|---|---|---|---|
| `oria-panel` | `apps/panel` | `npm ci && npm run build` | `npm start` | bloco do runbook §8.2 | `GET /` (não há `/health`) |
| `oria-creatives` | `apps/creative-generator` | `pip install -r requirements.txt` | `gunicorn 'creative_core.service:create_app()'` | — | `GET /v1/health` |
| `oria-whatsapp` | `services/whatsapp` | *(Dockerfile do próprio serviço)* | *(Dockerfile: `CMD ["./webhook"]`)* | — | `GET /health` |

Por que cada um é assim:

- **`oria-panel`** — `package.json` com `start` (`node server.js`), `build` (`tsc -b && vite build`) e
  `engines.node >= 20.11` (OPS-15; declarado na rodada 22, antes o Railpack escolheria a versão).
  Há **um** `package-lock.json`, na raiz do service: o frontend deixou de ser um segundo app em
  `apps/panel/admin/` (com manifesto e lockfile próprios) e subiu para a raiz do deployable, com o
  build saindo em `dist/`. Por isso o `postinstall` que buildava o admin também sumiu — o Build
  Command chama `npm run build` explicitamente, que é o que gera o `dist/`.
  **Atenção ao `npm ci`:** o build precisa das `devDependencies` (`vite`, `typescript`,
  `@vitejs/plugin-react`). Se o builder rodar com `NODE_ENV=production` (ou `--omit=dev`), o
  `npm run build` quebra com "vite: not found" — nesse caso, instalar com `npm ci --include=dev`.
- **`oria-creatives`** — a pasta tem `requirements.txt` (Pillow, openai, gunicorn), `pyproject.toml`
  e `.python-version` (3.12). **O Build Command precisa ser explícito:** o `pyproject` declara só
  `Pillow` como dependência de runtime (openai e gunicorn são o extra `service`, porque o core é uma
  biblioteca pura), então um build que instale pelo `pyproject` subiria **sem gunicorn** e o start
  quebraria. Instalar pelo `requirements.txt` resolve, e é o mesmo comando do serviço legado.
  O start vem do `Procfile` (`web: gunicorn 'creative_core.service:create_app()'`); o bind e os
  workers ficam em `gunicorn.conf.py`, sem `$PORT` no comando.
- **`oria-whatsapp`** — tem `Dockerfile` multi-stage com `go.mod`/`go.sum` na mesma pasta. Railway
  constrói pelo Dockerfile; não há Build/Start para configurar.

Nenhum runtime foi unificado e nenhum componente virou "aplicação da raiz".

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
| Build | `npm ci && npm run build` → `tsc -b && vite build`, que gera `dist/` (o SPA). Não há mais `postinstall`: o build é explícito |
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
| Variáveis opcionais | `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_MODEL_FALLBACKS`, `OPENAI_TEXT_MODEL`, `WEB_CONCURRENCY`; `CREATIVE_NORMALIZE_REFERENCES` (`1`/`true`/`on`: reencoda cada referência como PNG real, com orientação EXIF e sem resize; padrão desligado; uma requisição pode sobrescrever) e `CREATIVE_PROMPT_VERSION` (`1` padrão; `2` liga o prompt V2 dos ângulos com pessoa) |
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
| Depende de | painel (`PANEL_SENDER_RESOLVER_URL`, domínio público https — ver **Rede**) e Meta (externo) |
| Ingress público | **necessário**: o webhook da Meta precisa alcançar o serviço. As rotas internas continuam exigindo `API_KEY` e assinatura |

## `oria-admin` — **ainda não criado**

Control Plane (`apps/platform-admin`). O service **não existe** no projeto Railway; esta seção é a
especificação para criá-lo.

| item | valor |
|---|---|
| Root Directory | `apps/platform-admin` |
| Runtime | Node (mesmo builder do painel) |
| Build | `npm ci` — não há etapa de build: a UI é servida estaticamente de `public/` |
| Start | `npm start` → `node server.js` (escuta em `PORT`, padrão 8080) |
| Health endpoint | `GET /health` — público, responde `{"status":"ok"}` mesmo sem nenhum admin cadastrado |
| Pre-deploy | **nenhum.** As migrations do control plane são do painel (`1790000400000_platform-admin`) e rodam no pre-deploy do `oria-panel`. O boot do Admin apenas **verifica** que elas foram aplicadas e morre com mensagem explícita se não foram |
| Volume | não |
| Banco | o **mesmo** Postgres do painel (`DATABASE_URL`) — não é um banco novo |
| Ingress público | sim, `admin.oria.com.br` |

Variáveis obrigatórias (nomes; valores nunca aqui): `DATABASE_URL`,
`PLATFORM_ADMIN_SESSION_SECRET` (≥ 32, **novo**, não reaproveitar o `ADMIN_SESSION_SECRET` do
painel), `PLATFORM_ADMIN_URL`.

`PLATFORM_ADMIN_EMAIL` e `PLATFORM_ADMIN_PASSWORD` **não são variáveis do service**: são entrada de
um comando pontual de bootstrap. Deixá-las gravadas no Railway é guardar a senha do dono da
plataforma em texto no painel de infraestrutura. Ver
[`../../docs/operations/platform-admin-bootstrap.md`](../../docs/operations/platform-admin-bootstrap.md).

**O que o CLI não faz.** `railway add --service --repo` cria o service, mas **não** define o Root
Directory — e sem ele o build sai da raiz do monorepo e falha com "No start command detected",
exatamente como no primeiro deploy do painel. O Root Directory é ajuste de dashboard; depois dele o
resto (variáveis, domínio) pode ir pelo CLI.

## Rede

```text
navegador ──público──► oria-panel ──privado──► oria-creatives
                            │
                            └──privado──► oria-whatsapp ◄──público (entrada)── Meta webhook
                                              │
                                              └──público https──► oria-panel (repasse assinado)
```

- **Público:** `oria-panel` (painel + webhook da Ink) e `oria-whatsapp` (webhook da Meta).
- **Privado:** `oria-creatives`. O navegador nunca fala com ele.
- As chamadas painel → WhatsApp e painel → Gerador usam o domínio interno do Railway
  (`http://*.railway.internal`), com autenticação service-to-service (OPS-01/02 e o contrato 5b/5c).
- O caminho de volta **WhatsApp → painel** é a exceção: a rede privada do Railway não tem TLS e o
  serviço Go em produção (`RAILWAY_ENVIRONMENT_NAME=production`) só aceita destino https. Por isso
  `PANEL_SENDER_RESOLVER_URL` e `WEBHOOK_FORWARD_URL` apontam para o domínio **público** do painel.
  A garantia segue sendo `API_KEY` mais a assinatura do forward, não o isolamento de rede.

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
