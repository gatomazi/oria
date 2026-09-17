# creative-core

Core do Gerador de Criativos (planos, prompts, Brand/Niche Kits, Context Intelligence, Model Router) e o serviço HTTP
que o painel Node consome. **Fonte única da verdade** — o gerador interno (projeto estamparia-criativos) mantém um
espelho byte a byte verificado por `scripts/check_core_mirror.py` daquele projeto.

## Rodar local

```bash
cd services/creative-core
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

- Configurado pelo painel (Config as Code do Railway está deprecado; sem `railway.json`). Serviço `creative-lab`:
  Root Directory `services/creative-core`, builder Railpack (`requirements.txt` + `.python-version`),
  Start Command `gunicorn 'creative_core.service:create_app()'`, Watch Paths `/services/creative-core/**`,
  Healthcheck `/v1/health`. Bind, workers e timeouts ficam em `gunicorn.conf.py` (sem `$PORT` no comando).
- O serviço não sobe sem `CREATIVE_CORE_SERVICE_TOKEN` (≥ 32 caracteres): criar a variável antes do primeiro deploy.
- Variáveis: `CREATIVE_CORE_SERVICE_TOKEN` (≥ 32 caracteres, o mesmo configurado no Node), opcionais `OPENAI_IMAGE_MODEL`, `OPENAI_TEXT_MODEL`, `*_FALLBACKS`, `WEB_CONCURRENCY`.
- Não expor publicamente se possível (rede privada do Railway); o serviço exige o token em todas as rotas exceto `/v1/health`.

## Endpoints

`GET /v1/health` · `GET /v1/contracts` · `POST /v1/validate/<Contrato>` · `POST /v1/plans` · `POST /v1/generations` · `POST /v1/copies`.
Contrato completo: `docs/creative-generator/GENERATOR_HANDOFF_CONTRACT.md`.

## Dados regionais

`creative_core/data/{regioes,cidades}.json` é snapshot do gerador interno. Atualizar com
`python scripts/sync_data.py /caminho/estamparia-criativos` (ou `--check`).
