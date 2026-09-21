# creative-core (Oria · `apps/creative-generator`)

Core do Gerador de Criativos (planos, prompts, Brand/Niche Kits, Context Intelligence, Model Router) e o serviço HTTP
que o painel Node consome. **Fonte única da verdade** — o gerador interno (o app Streamlit, projeto separado, FORA
deste monorepo) mantém um espelho byte a byte do core e o verifica com um script próprio,
`scripts/check_core_mirror.py`, que vive naquele projeto e não neste. Nada aqui — runtime, build, testes ou CI — o
importa, chama ou depende dele; a menção é histórica. Enquanto aquele script não for atualizado, ele ainda procura o
core no caminho do repositório antigo, e isso é problema dele, não do Oria.

## Rodar local

```bash
cd apps/creative-generator
python3.12 -m venv .venv && . .venv/bin/activate
pip install --index-url https://pypi.org/simple -r requirements.txt
export CREATIVE_CORE_SERVICE_TOKEN="$(python -c 'import secrets;print(secrets.token_hex(32))')"
gunicorn 'creative_core.service:create_app()'   # lê gunicorn.conf.py: [::]:$PORT (padrão 8765)
# alternativa sem gunicorn (só desenvolvimento):
python -m creative_core.service --port 8765
```

## Testes

```bash
python run_tests.py
```

## Railway (serviço separado)

- Projeto Oria, serviço `oria-creatives` (matriz em `infra/railway/services.md`). O serviço legado `creative-lab` usava
  Root Directory `services/creative-core` no repositório antigo do painel. No Oria:
  Root Directory `apps/creative-generator`, builder Railpack (`requirements.txt` + `.python-version`),
  Start Command `gunicorn 'creative_core.service:create_app()'`, Watch Paths `/apps/creative-generator/**`,
  Healthcheck `/v1/health`. Bind, workers e timeouts ficam em `gunicorn.conf.py` (sem `$PORT` no comando).
- O serviço não sobe sem `CREATIVE_CORE_SERVICE_TOKEN` (≥ 32 caracteres): criar a variável antes do primeiro deploy.
- Variáveis: `CREATIVE_CORE_SERVICE_TOKEN` (≥ 32 caracteres, o mesmo configurado no Node), opcionais `OPENAI_IMAGE_MODEL`, `OPENAI_TEXT_MODEL`, `*_FALLBACKS`, `WEB_CONCURRENCY`.
- Flags de experimento (Fase A, todas desligadas por padrão): `CREATIVE_NORMALIZE_REFERENCES=1` (referência vira PNG real, EXIF aplicado, sem resize; `POST /v1/generations` aceita `normalize_references` para sobrescrever por requisição) `CREATIVE_PROMPT_VERSION=2` (prompt V2 dos ângulos com pessoa; `POST /v1/plans` aceita `prompt_version` no request) e `CREATIVE_PLAN_SCHEMA_VERSION=2` (CreativePlan v2 + compiler novo; o request aceita `plan_schema_version` e `gaze_mode`; `POST /v1/compile` recompila um plano v2 persistido, sem chamar o provedor).
- Pendência operacional: conferir no serviço `OPENAI_IMAGE_MODEL` e `OPENAI_IMAGE_MODEL_FALLBACKS`. Desde a Fase A o modelo que de fato respondeu fica em `metadata.trace.model_served`.
- Não expor publicamente se possível (rede privada do Railway); o serviço exige o token em todas as rotas exceto `/v1/health`.

## Endpoints

`GET /v1/health` · `GET /v1/contracts` · `POST /v1/validate/<Contrato>` · `POST /v1/plans` · `POST /v1/generations` · `POST /v1/copies`.
Contrato completo: [`apps/panel/docs/creative-generator/GENERATOR_HANDOFF_CONTRACT.md`](../panel/docs/creative-generator/GENERATOR_HANDOFF_CONTRACT.md).

## Dados regionais

`creative_core/data/{regioes,cidades}.json` é snapshot do gerador interno. Atualizar com
`python scripts/sync_data.py <checkout-do-gerador-interno>` (ou `--check`). O caminho é argumento: nada no monorepo
assume onde aquele projeto está.
