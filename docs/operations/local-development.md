# Desenvolvimento local

Como subir e testar os três componentes do Oria na sua máquina. Sem Docker Compose: cada serviço já
sobe com um comando, e o que precisa de banco usa Postgres **efêmero** no Docker, criado e derrubado
pelos próprios scripts. Um compose só acrescentaria manutenção.

## Pré-requisitos

| ferramenta | versão | para quê |
|---|---|---|
| Node | ≥ 20.11 | painel e scripts da raiz |
| Docker | qualquer recente | Postgres efêmero dos testes |
| Go | 1.25 | serviço de WhatsApp |
| Python | 3.12 | Gerador de Criativos |

Nenhum repositório vizinho é necessário. Os quatro testes de contrato que rodam o código real de
commits antigos leem snapshots versionados em `apps/panel/test/fixtures/legacy/` — regerá-los exige o
repositório legado, mas rodar a suíte não (ver `docs/architecture/source-migration-manifest.md`).
`npm run repo:self-check`, na raiz, falha se essa dependência voltar.

## Instalação

```bash
npm run panel:install     # npm ci em apps/panel; o postinstall builda o admin

python3.12 -m venv apps/creative-generator/.venv
apps/creative-generator/.venv/bin/pip install -r apps/creative-generator/requirements.txt
# se o PyPI estiver indisponível, aponte um interpretador que já tenha as dependências:
#   export CREATIVE_PYTHON=/caminho/para/python
```

O Go baixa os módulos no primeiro `go build`.

## Rodar cada serviço

### Painel (`apps/panel`)

```bash
cd apps/panel
node scripts/test-db.mjs start     # sobe Postgres efêmero e aplica as migrations; imprime a URL
DATABASE_URL=<url impressa> ENCRYPTION_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
  ADMIN_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  npm start                        # http://localhost:8080
node scripts/test-db.mjs stop
```

Sem Postgres, dá para subir em modo de desenvolvimento declarado (`DATA_STORE_MODE=ephemeral-json`):
o estado vai para JSON e não sobrevive a um restart — nunca use isso fora da sua máquina.

### Gerador de Criativos (`apps/creative-generator`)

```bash
cd apps/creative-generator
export CREATIVE_CORE_SERVICE_TOKEN=$(python3 -c 'import secrets;print(secrets.token_hex(32))')
.venv/bin/gunicorn 'creative_core.service:create_app()'      # [::]:8765
# ou, sem gunicorn: .venv/bin/python -m creative_core.service --port 8765
```

Para o painel falar com ele: `CREATIVE_CORE_URL=http://127.0.0.1:8765` e o **mesmo**
`CREATIVE_CORE_SERVICE_TOKEN`.

### Serviço de WhatsApp (`services/whatsapp`)

```bash
cd services/whatsapp
cp .env.example .env        # placeholders; preencha com valores de teste, nunca de produção
go run .                    # :8080
```

Para o painel falar com ele: `WHATSAPP_SERVICE_URL=http://127.0.0.1:8080` e `WHATSAPP_API_KEY` igual
ao `API_KEY` do serviço.

## Testes

```bash
npm test                     # tudo: contratos, painel (+build), gerador e Go
npm run panel:test
npm run panel:test:app-role  # a suíte com a aplicação conectando como oria_app
npm run creatives:test
npm run whatsapp:test
npm run contracts:check      # fonte canônica == cópias nos dois serviços
```

Detalhes que costumam morder:

- **Um container por execução.** `TEST_PG_CONTAINER=<nome>` separa execuções paralelas; o script para
  e remove o container ao terminar, então duas execuções com o mesmo nome se atropelam.
- **Testes sensíveis a tempo.** Leases de 1 s e boot em até 20 s falham sob carga alta (várias suítes
  juntas). Rode isolado antes de concluir que é regressão.
- **Contratos com o histórico legado.** Os quatro testes citados acima exigem o repositório antigo.
- **Gerador sem Pillow** falha alto: instale as dependências ou aponte `CREATIVE_PYTHON`.

## Gate e preflight

```bash
npm run productization:gate                  # roda a suíte, o Go e o Gerador; exit 2 = rollout bloqueado
npm run productization:gate -- --report-only # relatório (sai 0 mesmo bloqueado)
npm run release:preflight -- --from-env-file <export do Railway> --stage release-n --no-db
```

O gate espera as três suítes verdes. Se o Python do Gerador não estiver disponível, o componente sai
como NOT VERIFIED e o bloco CODE não passa — proposital.
