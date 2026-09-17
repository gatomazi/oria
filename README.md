# Oria

Monorepo do produto **Oria**: painel multi-tenant, gerador de criativos e serviço de WhatsApp.

O produto nasceu dentro de repositórios operacionais (o painel da Use Origens e o serviço Go do
WhatsApp). Desde 17/09/2026 ele vive aqui, importado como **snapshot** de cada HEAD aprovado — a
história antiga continua nos repositórios de origem, registrada em
[`docs/architecture/source-migration-manifest.md`](docs/architecture/source-migration-manifest.md).

## Componentes

| pasta | o que é | runtime | deployable |
|---|---|---|---|
| [`apps/panel`](apps/panel) | painel: tenancy com RLS, auth, integrações, financeiro, campanhas, criativos | Node ≥ 20.11 + Postgres | `oria-panel` |
| [`apps/creative-generator`](apps/creative-generator) | Creative Core: planos, prompts, kits e o serviço HTTP que o painel consome | Python 3.12 | `oria-creatives` |
| [`services/whatsapp`](services/whatsapp) | webhook e envio de WhatsApp, multi-tenant, com fila e idempotência | Go 1.25 + Postgres próprio | `oria-whatsapp` |
| [`contracts/whatsapp`](contracts/whatsapp) | contratos cross-service (fonte canônica das fixtures) | JSON | — |
| [`docs/`](docs) | productization, arquitetura e operação | — | — |
| [`infra/railway`](infra/railway) | matriz de services e manifesto de variáveis | — | — |

Cada serviço builda e roda sozinho. Não há workspace npm, nem dependência de runtime entre Go,
Node e Python.

## Desenvolvimento local

Guia completo: [`docs/operations/local-development.md`](docs/operations/local-development.md).

```bash
npm run panel:install          # dependências do painel (builda o admin)
npm test                       # contratos + painel + gerador + Go (tudo)
npm run contracts:check        # só os contratos cross-service
```

Testes por componente:

```bash
npm run panel:test             # suíte + invariants + E2E com o binário Go
npm run panel:test:app-role    # a mesma suíte com a aplicação conectando como oria_app
npm run creatives:test         # run_tests.py do Creative Core
npm run whatsapp:test          # go vet + build + test -race (sobe um Postgres descartável)
```

Os testes de banco sobem Postgres efêmero no Docker e o derrubam no fim. Nenhum teste se pula em
silêncio: falta de Docker ou de Python **falha**. A suíte é autocontida — não precisa de repositório
vizinho: os contratos que rodam o código real de commits antigos leem snapshots versionados em
`apps/panel/test/fixtures/legacy/` (proveniência e regeração em
`docs/architecture/source-migration-manifest.md`).

```bash
npm run repo:self-check        # nenhum caminho de máquina local nem dependência de repo vizinho
```

## Railway

Projeto **Oria**, três services no mesmo repositório, cada um com seu Root Directory:

| service | root | público | banco | volume |
|---|---|---|---|---|
| `oria-panel` | `apps/panel` | sim | Postgres do painel | sim |
| `oria-creatives` | `apps/creative-generator` | não (rede privada) | não | não |
| `oria-whatsapp` | `services/whatsapp` | sim (webhook da Meta) | Postgres próprio | não |

Detalhes em [`infra/railway/services.md`](infra/railway/services.md) e
[`infra/railway/env-manifest.md`](infra/railway/env-manifest.md); a ordem de criação está em
[`docs/operations/railway-bootstrap.md`](docs/operations/railway-bootstrap.md).
**Nada disso foi criado ainda.**

O projeto **Oria** é o alvo do rollout; o projeto Railway antigo fica como **stack legada e origem de
rollback**. A estratégia de cutover (legado no ar → Oria isolado → validação → cutovers coordenados →
dogfood → janela de rollback) está no runbook, §20.

## Productização

```text
Fases 0 a 5c ....... CLOSED (local)
Fase 6 ............. CODE READY · NÃO CLOSED
Fase 7 ............. construída, travada por SECOND_TENANT_ENABLED
OPS-27 ............. VERIFIED (17/09/2026)
OPS GATES .......... 35 de 36 NOT VERIFIED
ROLLOUT ............ BLOCKED (infra Railway nova não criada · OPS pendentes · dogfood)
DOGFOOD ............ NOT STARTED
```

O gate é executável e decide sozinho:

```bash
npm run productization:gate                  # exit 0 só com OVERALL READY; 2 = rollout bloqueado
npm run productization:gate -- --report-only # relatório, não é gate
npm run release:preflight -- --from-env-file <export> --stage release-n
```

Leitura na ordem: [`docs/productization/productization-progress.md`](docs/productization/productization-progress.md)
(estado e bloqueios atuais), [`production-rollout-runbook.md`](docs/productization/production-rollout-runbook.md)
(o que fazer no rollout, incluindo o alvo de infraestrutura em §20) e
[`ops-27-checklist.md`](docs/productization/ops-27-checklist.md) (procedimento do OPS-27, já resolvido,
mantido como referência para ambientes novos).

## Segurança

- Segredos **não** vivem no repositório: o cofre é o `integration_secrets` do painel, cifrado com
  `ENCRYPTION_MASTER_KEY`. O único `.env` versionado é `services/whatsapp/.env.example`, com placeholders.
- Credencial de tenant nunca vira variável de ambiente (a exceção é o legado temporário do cutover,
  listado no manifesto de variáveis).
- O painel isola tenants por RLS FORCE, e a suíte roda também sob a role da aplicação (`oria_app`).
- Mudanças de fronteira (tenancy, segredos, webhooks, jobs) exigem controle negativo: um teste que
  reprova quando a proteção é removida.
