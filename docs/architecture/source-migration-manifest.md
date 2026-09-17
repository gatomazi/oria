# Manifesto de proveniência — origem de cada componente do Oria

Rodada 20, 17/09/2026 (seção do histórico legado revista na rodada 21). O monorepo `oria` **não**
carregou a história Git dos repositórios antigos:
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
| App Streamlit do Gerador (`estamparia-criativos`, remoto `gatomazi/creative-lab`, `main` `d7437a1`) | repositório próprio, intocado | Decisão do usuário na rodada 20: `apps/creative-generator` recebe **só o core HTTP**. O Streamlit mantém um espelho byte a byte do `creative_core` e verifica com `scripts/check_core_mirror.py` — script **daquele** projeto, externo ao Oria: nada aqui (runtime, build, teste ou CI) o importa ou depende dele. Que ele ainda aponte para o caminho do repositório antigo é problema dele |
| História Git dos repositórios antigos | repositórios de origem | O produto começa a história aqui (§1 da rodada 20). Os contratos que rodam código de commits antigos usam snapshots podados, versionados no próprio monorepo — veja abaixo |
| Working trees não commitadas | repositórios de origem | Nada de working tree entrou (`git archive`, nunca `cp -R`) |

## Histórico legado como fixture versionada (rodada 21)

Quatro testes do painel rodam o código **real** de commits antigos (as releases do runbook). Isso não
mudou, e não deve mudar: ler o diff de um script não distingue "ele se comporta assim" de "eu li e
acho que se comporta assim". O que mudou foi de onde esse código vem.

Até a rodada 20, cada um desses testes fazia `git archive` no repositório legado do painel, em disco,
ao lado do monorepo (`ORIA_LEGACY_PANEL_REPO`). O preço era alto e silencioso: um clone limpo de
`gatomazi/oria` **não conseguia rodar a suíte**, e o CI tinha de excluir os quatro arquivos — uma
exclusão que sai verde, que é exatamente o modo de falha que a productização combate.

Na rodada 21 o `git archive` passou a ser feito **uma vez**, e o resultado — podado ao mínimo que
cada teste precisa — está versionado em `apps/panel/test/fixtures/legacy/`:

| tarball | commit | paths | tamanho | consumidores |
|---|---|---|---|---|
| `ed5a5b0-criativos.tar.gz` | `ed5a5b0` (produção de então) | `routes/criativos.js`, `lib/creative-core` | 20 KB | `ops22-creative-release-b` |
| `31a7cdb-release-b.tar.gz` | `31a7cdb` (RELEASE B) | `scripts`, `lib`, `migrations`, `package.json`, `routes/criativos.js` | 203 KB | `ops22-creative-release-b`, `r19-release-b-contrato`, `r19-runbook-dry-run` |
| `8c024d2-release-d0.tar.gz` | `8c024d2` (RELEASE D0 = `c706da1^`) | `scripts`, `lib`, `migrations`, `package.json`, `server.js` | 438 KB | `r19-runbook-dry-run`, `r19-contrato-repasse-transicao` |
| `bfd00a6-painel.tar.gz` | `bfd00a6` (painel que autentica o repasse pela query) | `server.js`, `lib`, `routes`, `migrations`, `scripts`, `package.json`, `test/fixtures/tenancy` | 413 KB | `r19-contrato-repasse-transicao` |

Total: ~1,1 MB. A poda é por necessidade demonstrada, não por estimativa — cada path saiu ou entrou
porque o teste consumidor passou ou reprovou com ele. Dois exemplos do que isso custa saber: o painel
`bfd00a6` sobe sem `data/`, `assets/` e `admin/dist` (o teste só fala HTTP/JSON com ele), mas **não**
sobe sem `test/fixtures/tenancy/cenario-a.json` — 669 bytes que a migration de mapeamento daquele
commit lê por `TENANCY_MAPPING_FILE`; e `server.js` entrou no snapshot de `8c024d2` porque o contrato
compara a rota do webhook de D0 com a do painel testado, e essa comparação é o que prova que a árvore
exercitada é mesmo a candidata a D0.

### Proveniência e regeração

`apps/panel/test/fixtures/legacy/manifest.json` registra, por tarball: commit curto, commit completo,
paths, consumidores, tamanho, `sha256` e data. O harness confere o `sha256` **a cada extração** — é o
que liga o código que roda ao commit que o manifesto declara.

```bash
# regerar a partir do repositório legado (só quem o tem em disco)
node apps/panel/scripts/fixtures/legacy-snapshots.mjs --repo <caminho do repositório legado>

# conferir: sha256 do disco contra o manifesto e, com --repo, contra a regeração
node apps/panel/scripts/fixtures/legacy-snapshots.mjs --check [--repo <caminho>]
```

A geração é **determinística**: `git archive --format=tar` é estável (ordem de árvore, mtime do
commit, uid/gid/modo fixos) e a compressão é feita com zlib nível 9 e mtime zerado — regerar em outra
máquina, em outro dia, produz o mesmo `sha256`. Por isso `--check` é uma verificação de verdade, e
não um carimbo.

A suíte **não** depende desse script: ela lê o tarball. `ORIA_LEGACY_PANEL_REPO` não é mais lida por
nenhum teste, e `exigirRepoLegado`/`RAIZ_LEGADO_PAINEL` saíram do harness. O CI roda `npm test`
inteiro, sem exclusões (ver `.github/workflows/ci.yml`).

### Guarda automática

`npm run repo:self-check` (raiz) varre o código executável e a configuração de teste versionados e
falha se reaparecer caminho absoluto de máquina local, caminho para um dos repositórios de origem ou
dependência via `ORIA_LEGACY_PANEL_REPO` — e confere que os tarballs batem com o manifesto. Roda no
job `contracts` do CI. Ele procura **caminhos**, não nomes: o domínio de produção
(`orgulhoregional.com.br`), o `appId` do app desktop e o nome do serviço Go em comentários não são
dependências e não são procurados.

## Repositórios de origem: estado

Nada foi apagado, arquivado, movido ou repontado. Em 17/09/2026:

| repositório | branch | HEAD | observação |
|---|---|---|---|
| `orgulhoregional` | `feature/produtizacao-saas` | `970290e` | `master` intocada em `ed5a5b0`; working tree com as mudanças da outra sessão, preservadas |
| `whatsapp-webhook-go` | `feature/produtizacao-saas` | `244bf45` | limpo |
| `estamparia-criativos` | `main` | `d7437a1` | limpo (fora `assets/logo/`, não rastreado) |

O arquivamento desses repositórios só será decidido depois do rollout e do dogfood.
