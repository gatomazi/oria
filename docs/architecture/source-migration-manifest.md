# Manifesto de proveniência — origem de cada componente do Oria

Rodada 20, 17/09/2026. O monorepo `oria` **não** carregou a história Git dos repositórios antigos:
cada componente entrou como **snapshot exato de um commit**, extraído com `git archive`. Este
documento é a referência de rollback histórico: para ver a origem de qualquer arquivo importado,
volte ao repositório e ao commit da tabela.

## Componentes

| componente | repositório de origem | branch | commit | data da importação | destino | observações |
|---|---|---|---|---|---|---|
| Painel | `orgulhoregional` (local; remoto `gatomazi/orgulhoregional`) | `feature/produtizacao-saas` | `970290e` | 17/09/2026 | `apps/panel` | 751 arquivos (o total do commit menos `services/creative-core`). Working tree **não** entrou: as mudanças de outra sessão (UTM etc.) ficaram de fora por construção |
| Gerador de Criativos | `orgulhoregional` | `feature/produtizacao-saas` | `970290e:services/creative-core` | 17/09/2026 | `apps/creative-generator` | 69 arquivos. É o serviço HTTP (`creative-lab`) que o painel chama por `CREATIVE_CORE_URL`, e a fonte canônica do `creative_core` |
| Serviço de WhatsApp | `whatsapp-webhook-go` (local; remoto `gatomazi/whatsapp-webhook-go`) | `feature/produtizacao-saas` | `244bf45` | 17/09/2026 | `services/whatsapp` | 49 arquivos. O comando da rodada esperava `23528ae`; o HEAD real está 3 commits à frente (`789b7c9`, `023398c`, `244bf45` — rodada 19, assinatura do repasse), todos da productização concluída |

**Contagens conferidas na importação:** arquivos do `git archive` == arquivos adicionados ao Git em
cada commit (751, 69 e 49).

## O que ficou fora, de propósito

| item | onde está | motivo |
|---|---|---|
| App Streamlit do Gerador (`estamparia-criativos`, remoto `gatomazi/creative-lab`, `main` `d7437a1`) | repositório próprio, intocado | Decisão do usuário na rodada 20: `apps/creative-generator` recebe **só o core HTTP**. O Streamlit mantém um espelho byte a byte do `creative_core` e verifica com `scripts/check_core_mirror.py`, que ainda aponta para o caminho legado (`orgulhoregional/services/creative-core`) |
| História Git dos repositórios antigos | repositórios de origem | O produto começa a história aqui (§1 da rodada 20). Os contratos que precisam rodar código de commits antigos usam o repositório legado — veja abaixo |
| Working trees não commitadas | repositórios de origem | Nada de working tree entrou (`git archive`, nunca `cp -R`) |

## Dependência declarada do histórico legado

Quatro testes do painel rodam o código **real** de commits antigos (releases do runbook) e por isso
precisam do repositório legado do painel em disco:

| teste | commits |
|---|---|
| `r19-contrato-repasse-transicao` | `bfd00a6` (painel antigo, autentica o repasse pela query) |
| `ops22-creative-release-b` | `ed5a5b0` (produção) e `31a7cdb` (RELEASE B) |
| `r19-release-b-contrato` | `31a7cdb` |
| `r19-runbook-dry-run` | `31a7cdb` e `8c024d2` (D0) |

Resolução: `ORIA_LEGACY_PANEL_REPO` (padrão `../../../orgulhoregional`, isto é, o repositório ao lado
do monorepo). Sem ele, os testes **falham alto** — nunca se pulam em silêncio. A suíte do CI roda sem
esses arquivos enquanto o runner não tiver os repositórios antigos (ver `.github/workflows/ci.yml`).

## Repositórios de origem: estado

Nada foi apagado, arquivado, movido ou repontado. Em 17/09/2026:

| repositório | branch | HEAD | observação |
|---|---|---|---|
| `orgulhoregional` | `feature/produtizacao-saas` | `970290e` | `master` intocada em `ed5a5b0`; working tree com as mudanças da outra sessão, preservadas |
| `whatsapp-webhook-go` | `feature/produtizacao-saas` | `244bf45` | limpo |
| `estamparia-criativos` | `main` | `d7437a1` | limpo (fora `assets/logo/`, não rastreado) |

O arquivamento desses repositórios só será decidido depois do rollout e do dogfood.
