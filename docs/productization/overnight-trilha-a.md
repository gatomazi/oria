# Trilha A — Fase 5a do `whatsapp-webhook-go`

**Repositório:** `/Users/gtomazi/projects/whatsapp-webhook-go`
**Base:** `bf91ff1` — *feat: accept Meta app id from the panel on media upload*
**HEAD ao fim:** `6eb6274`
**Escopo:** correções independentes de multi-tenancy (auditoria
`whatsapp-webhook-go-audit.md`, §7 item 12), mais a preparação de `metaPost` para a 5b.
**Sem push, sem deploy, sem Railway, sem banco de produção.** Nada da 5b/5c foi iniciado.
**Estado:** working tree limpo, 16 commits locais, `go build`/`go vet`/`go test` (e `-race`) verdes.

---

## 1. Como o código distingue produção de dev/test

Novo arquivo `env.go`. A decisão é de uma linha e está isolada para poder ser testada sem mexer no
ambiente do processo:

```
APP_ENV -> RAILWAY_ENVIRONMENT_NAME -> "development"
produção = o nome resolvido é "production" ou "prod" (case-insensitive)
```

- `APP_ENV` vem primeiro para que outra hospedagem (ou um teste) declare o ambiente sem depender de
  uma variável específica do Railway.
- O padrão é **development de propósito**: em `go test` e `go run` nenhuma das duas existe e o
  serviço tem de continuar subindo sem os segredos.
- **O que é condicional a produção é só a EXIGÊNCIA de que os valores existam no boot.** Os
  controles em si são fail-closed nos dois ambientes: sem `API_KEY` ninguém autentica (401), sem
  `META_APP_SECRET` nenhum webhook é aceito (403). Um deploy que esqueça a variável **morre no
  boot** em vez de subir aparentemente saudável e sem proteção.
- O ambiente resolvido entra no log de boot (`env=production`), para que uma detecção errada seja
  visível na primeira linha do log e não silenciosa.

`requiredProductionEnv` = `META_APP_SECRET`, `API_KEY`, `DATABASE_URL`. Valor só com espaços conta
como ausente (`API_KEY= ` no painel é erro de digitação, não chave).

---

## 2. O que mudou, por arquivo

| Arquivo | Mudança |
|---|---|
| `env.go` (novo, 82 linhas) | Detecção de ambiente (`environmentName`, `isProductionEnv`, `isProduction`), lista `requiredProductionEnv`, `missingProductionEnv` (trata branco como ausente) e `requireProductionEnv`, que aborta o boot via o `mustEnv` já existente no repositório. |
| `main.go` | `requireProductionEnv()` no boot, antes de `initDB`. `auth()` deixa de ser fail-open: sem `API_KEY` configurada **ninguém** é autorizado. Novos `apiKeyFromRequest` (só header: `X-Api-Key`, senão `Authorization: Bearer`) e `validAPIKey` (comparação em tempo constante com `crypto/subtle`). Log de boot passa a mostrar `env=`. |
| `dashboard.go` | `dashAuth` não lê mais `?key=` da URL e não libera mais quando `API_KEY` está vazia; usa o mesmo `validAPIKey`. Mensagem de erro passou a instruir o header. Comentário registra a consequência conhecida (item 6). |
| `webhook.go` | Verificação HMAC **nunca é opcional**: extraída para `validWebhookSignature`, que devolve `false` quando `cfg.AppSecret == ""`. Sem segredo ou com assinatura inválida → 403 e `processWebhook` **não é disparado**. `hub.verify_token` passou a ser comparado em tempo constante e verify token vazio não valida ninguém. |
| `db.go` | `dbDegraded`: em produção, `DATABASE_URL` ausente, falha de conexão, de ping ou de migrate **abortam o boot**; fora de produção, mantém o modo memória (é o que permite `go run`/`go test` sem Postgres). |
| `sender.go` | `metaPost` recebe `metaIdentity{PhoneNumberID, AccessToken}` (item 8, detalhado abaixo). `sendText` idem. Os 9 pontos de envio passam `defaultIdentity()`. |
| `queue.go` | `dispatchItem` passa `defaultIdentity()`; comentário registrando a análise de `SourceWamid` (item 7). |
| `.env.example` | `APP_ENV`, `META_APP_SECRET` (que nem constava) e `DATABASE_URL` documentadas, com o que acontece na ausência de cada uma. |
| `env_test.go`, `boot_test.go`, `auth_test.go`, `webhook_test.go`, `sender_test.go` (novos) | 37 testes novos (43 no total, contra 6 antes). |

Diff total: **13 arquivos, +967 / −56**.

---

## 3. Build, vet e testes

| Comando | Resultado |
|---|---|
| `go build ./...` | limpo |
| `go vet ./...` | limpo |
| `go test ./... -count=1` | **ok** — 43 testes (eram 6) |
| `go test ./... -race -count=1` | **ok** |

Observação: `gofmt -l` aponta `db.go`, `problems.go`, `queue.go`, `store.go`, `types.go`. Conferi
contra `bf91ff1`: **é exatamente o mesmo conjunto de antes**, nenhum introduzido nesta trilha. Não
reformatei para não poluir o diff de revisão — fica como item de limpeza separado.

Uma corrida de `-race` inicial acusou um race real entre o `processWebhook` (goroutine) lendo o
`cfg` global e o teste restaurando esse global. É sintoma do desenho atual (config global lida
dentro de goroutine, contrariando a regra de não compartilhar estado global mutável a partir de
handler/goroutine). Resolvi **no teste**, com um happens-before de verdade (o repasse aponta para um
servidor de teste que sinaliza o fim do processamento) e registrei a causa estrutural como pendência
— corrigi-la no código é passar config por parâmetro, que é trabalho da 5b.

---

## 4. Ciclo de prova dos negative controls

Cada controle foi quebrado de propósito, o teste correspondente confirmado **falhando**, e o
arquivo restaurado (`cp` de backup; nenhum `git checkout --`/`reset`). Depois de cada restauração,
suíte verde de novo.

| # | Quebra deliberada | Teste que falhou | Mensagem observada |
|---|---|---|---|
| 1 | `requiredProductionEnv` vazia (tira `META_APP_SECRET`) | `...WithoutAppSecret_WhenValidatingBootEnv...`, `...WithBlankAppSecret...` | `missing = [], want META_APP_SECRET` |
| 2 | `missingProductionEnv` sem `TrimSpace` | `...WithBlankAppSecret_WhenValidatingBootEnv...` | `missing = [], want META_APP_SECRET para valor em branco` |
| 3 | `validWebhookSignature` devolve `true` sem app secret (o fail-open original) | `...NoAppSecret_WhenWebhookPosted...`, `...WrongSignature...` | `status = 200, want 403` e `webhook recusado não pode gerar evento no dashboard` |
| 4 | `validAPIKey` libera quando `cfg.APIKey == ""` (o fail-open original) | `...NoAPIKeyConfigured_WhenCallingProtectedEndpoint...` e a versão do dashboard | `status = 200, want 401` |
| 5 | `dashAuth` volta a aceitar `?key=` | `...DashboardKeyInQueryString_WhenOpeningDashboard...` | `status = 200, want 401` |
| 6 | `API_KEY` fora de `requiredProductionEnv` | `...ProductionWithoutAPIKey_WhenValidatingBootEnv...` | `missing = [], want API_KEY` |
| 7 | `dbDegraded` volta a só logar (modo memória em produção) | `...WithoutDatabase_WhenInitializingDB...`, `...UnreachableDatabase...` | `processo continuou rodando — perda silenciosa de dados em produção não é aceitável` |
| 8 | `requireProductionEnv` vira no-op | `...ProductionWithoutSecrets_WhenBooting_ThenProcessAborts` | `processo continuou rodando — boot em produção sem segredos obrigatórios tem de abortar` |
| 9 | `metaIdentity.resolve()` ignora o número do chamador | `...ExplicitIdentity_WhenBuildingMessagesURL...`, `...IdentityWithoutToken...` | `url = .../111-do-ambiente/messages, want o número do chamador` |

**Duas decisões de método que fazem esses testes valerem alguma coisa:**

1. **O fail-fast é provado matando processo, não inspecionando lista.** `log.Fatalf` não é
   observável de dentro do teste, então `boot_test.go` re-executa o próprio binário de teste num
   subprocesso com o ambiente desejado e confere saída + código de retorno.
2. **O filho nunca usa `t.Fatalf`.** Teste que falha também sai com código ≠ 0 e seria
   indistinguível de um `log.Fatalf` — o teste "passaria" por motivo errado. O filho que espera
   abortar simplesmente retorna (saída 0, e aí o pai acusa a falta do controle), e o pai exige as
   duas coisas: **saída ≠ 0 E a mensagem do fatal esperada** no output.
3. **Rejeição é provada por ausência de efeito, não só por status.** Os testes de webhook usam um
   payload de mensagem real (que geraria evento no dashboard) e verificam, com janela de espera para
   a goroutine, que **nenhum evento foi criado**. Os de auth usam um handler protegido que registra
   se chegou a rodar.

---

## 5. Decisão sobre `SourceWamid` (item 7): **backlog, não bug operacional hoje**

Li o caminho real de retry antes de decidir.

- Um item de retry só nasce quando `buscarParaRetry(s.ID)` acha o wamid em `retryStore`
  (`webhook.go:205`).
- `retryStore` é **memória, FIFO de 500**, populado só por `registrarParaRetry` num envio
  bem-sucedido **deste processo** (`retry.go:15-36`).
- A dedup de `AddRetry` varre `q.items` procurando `SourceWamid == wamid` (`queue.go:130-138`).

Daí: **todo item capaz de duplicar foi criado neste processo e ainda tem `SourceWamid` preenchido
em memória.** Item carregado do banco no boot veio de um processo anterior, e os wamids daquele
processo não estão mais em `retryStore` — então nem chegam a ser candidatos. Não existe hoje
sequência de eventos que produza retry duplicado por causa da não persistência: o `retryStore` é tão
volátil quanto o campo, e é ele que porteia todo o caminho. A perda de correlação após restart já
está declarada e aceita no próprio comentário de `retry.go:11-13` ("se o serviço reiniciar entre o
envio e a falha, a mensagem só não vira retryable automaticamente") — é degradação de conveniência,
não de correção.

**Não corrigi, e não inflei a prioridade.** O que fiz foi registrar a análise em comentário no
próprio campo (`queue.go`), com o gatilho que a torna obsoleta: **isso passa a importar quando o
escopo do envio precisar sobreviver ao restart.** Retry é envio que nasce dentro do serviço, sem
requisição do painel de onde tirar a identidade (é o INV-W11 da auditoria); nesse momento
`retryStore` e `SourceWamid` passam a precisar de persistência **juntos**, e aí é trabalho de 5b/5c,
não uma coluna solta agora.

---

## 6. Estado de `metaPost` (item 8): preparado, cutover **não** iniciado

```go
type metaIdentity struct {
    PhoneNumberID string
    AccessToken   string
}

func metaPost(id metaIdentity, payload any) (json.RawMessage, error)
func sendText(id metaIdentity, to, body string) error
```

- **Número e credencial andam juntos no mesmo tipo**, de propósito: o defeito estrutural registrado
  na auditoria sobre o `appId` (identidade vinda da requisição + credencial fixa do ambiente) não se
  repete aqui por construção.
- **Os 9 call sites passam `defaultIdentity()`** — o par de variáveis de ambiente. O painel ainda
  não envia remetente, então **o contrato não mudou e o fallback continua valendo**.
- `resolve()` completa com o ambiente qualquer campo vazio: identidade pela metade nunca vira URL
  pela metade.
- `messagesURL()` foi separado de `metaPost` só para poder ser verificado sem rede — é o que permite
  o teste provar o escopo da saída sem tocar na Graph API.
- **O cutover da 5b não foi iniciado:** nenhum handler aceita remetente no corpo, nenhum struct de
  request ganhou campo, `/health` continua devolvendo `phone_number_id` (o contrato que o painel lê
  hoje) e nada foi removido.

Fora do funil de `metaPost` continuam lendo `cfg.AccessToken` direto: `handleGetMedia`
(`sender.go`), o upload resumable (`media_upload.go`) e os três handlers de template
(`templates_management.go`). São endpoints da Graph API diferentes de `/messages` e ficam para a
mesma janela da 5b.

---

## 7. Commits (todos locais, nenhum push)

Ordem cronológica. Cada um deixa `go build`, `go vet` e `go test` verdes — todos são checkpoints
válidos.

| Hash | Commit |
|---|---|
| `c7dc5aa` | fix(security): require meta app secret in production |
| `79a390a` | test(security): cover production boot env requirement |
| `86bbd0d` | fix(security): never skip webhook signature check |
| `7e8ad44` | test(security): cover webhook signature fail-closed |
| `846c397` | fix(security): require api key in production |
| `b4657a1` | fix(security): close api key auth fail-open |
| `2f2b4d3` | fix(security): drop dashboard key from query string |
| `fde05b1` | test(security): add negative controls for api key auth |
| `1d253cc` | fix(security): require database url in production |
| `7bd0f27` | refactor(security): extract production boot check |
| `4bf4af4` | test(security): make accepted webhook test race-free |
| `f12ec38` | test(security): prove boot aborts without production secrets |
| `741a372` | refactor(sender): give metaPost a sender identity |
| `8a90f39` | test(sender): cover meta identity resolution |
| `ba5922d` | fix(security): compare webhook verify token in constant time |
| `6eb6274` | docs(queue): record why source wamid need not persist |

Nota operacional: há um hook de `pre-commit` instalado na máquina que aborta todo commit por falta
de `.pre-commit-config.yaml` neste repositório. Usei `PRE_COMMIT_ALLOW_NO_CONFIG=1` por comando,
como o próprio hook sugere — **nenhuma configuração de git, hook ou repositório foi alterada**.

---

## 8. Pendências (o que esta fase deixou em aberto)

**Consequência conhecida e deliberada da remoção do `?key=`:** as três páginas HTML embutidas montam
links e fetches com `?key=...` (`dashboard.html:204-212`, `problems.html:122-129`,
`automaticos.html:103-111`), e navegação de browser não manda header. **O dashboard deixa de ser
alcançável abrindo a URL no navegador** — só por cliente que saiba definir `X-Api-Key`. É o
trade-off correto (a alternativa é a credencial real do serviço circulando em access log de CDN,
histórico e `Referer`), mas é uma mudança de comportamento visível para quem usa o painel. **Está
registrada em comentário no `dashAuth`.** Não toquei no HTML: o conserto certo é um login que troque
a chave por sessão (cookie `HttpOnly`/`SameSite`), que é feature nova, não 5a.

Demais pendências, sem prioridade inflada:

1. **`/health` ainda expõe `phone_number_id` sem autenticação** (F-04). É o contrato que o painel lê
   hoje; remover exige a mesma janela do painel — 5b por definição.
2. **Config global lida dentro de goroutine** (`processWebhook` → `cfg.ForwardURL`, `notifyOwner`,
   `maybeAutoReply`). Causa do race que apareceu no `-race`. O conserto é passar config por
   parâmetro, que é o mesmo movimento da 5b.
3. **Token da Meta em query string** no start do upload resumable (`media_upload.go:101-102`) —
   F-20, único desvio do padrão de header. Correção barata, mas mexe no caminho de upload, que não
   tem teste de integração.
4. **`http.Post` do repasse sem timeout**, em goroutine solta (`webhook.go`) — F-18/NOT VERIFIED 12.
5. **Sem idempotência por id de evento no webhook** (F-08): `msg.ID` e os `Timestamp` continuam
   desserializados e não usados. Replay de payload assinado segue possível.
6. **`gofmt`** pendente em 5 arquivos, todos já assim antes desta trilha.
7. **NOT VERIFIED que continuam NOT VERIFIED:** os valores de produção de `META_APP_SECRET`,
   `API_KEY`, `DATABASE_URL` e `WEBHOOK_FORWARD_URL`. **Atenção operacional:** se algum dos três
   primeiros estiver faltando em produção hoje, **este código passa a derrubar o deploy no boot** —
   que é exatamente a intenção, mas quem for deployar precisa conferir as variáveis do Railway
   **antes** do primeiro deploy desta versão. Não toquei no Railway.

---

## 9. Primeiro passo seguinte, sem novas confirmações

**Conferir no painel do Railway se `META_APP_SECRET`, `API_KEY` e `DATABASE_URL` estão definidas no
ambiente de produção** — leitura apenas, sem alterar nada. É a única ação que não precisa de decisão
nova, destrava quatro itens `NOT VERIFIED` da auditoria de uma vez, e é **pré-requisito do próximo
deploy**: com a 5a no ar, uma dessas variáveis faltando deixa de ser degradação silenciosa e passa a
ser boot abortado.

Se as três estiverem lá, o passo seguinte que também não depende de confirmação é o item 3 da lista
acima (mover o `access_token` do upload da query string para header), que é local, testável e
independente de tenancy.

O que **não** dá para começar sem decisão: qualquer coisa que toque o contrato de `/health` ou o
recebimento de identidade por requisição — é 5b, e depende da decisão de topologia de deploy (um
processo por Organization vs. processo compartilhado) que a auditoria registrou como em aberto.

---
---

# Rodada 18 — Trilha A: Fase 6 readiness / Tenant #1 (painel)

**Base:** `bfd00a6` (worktree destacado). **Sem push, sem deploy, sem Railway, sem banco de produção.**
**Resultado:** `PHASE 6 CODE/ROLLBACK READINESS = READY` · **Fase 6 CLOSED = NÃO.**
**Validação no HEAD da trilha:** `npm test` (container `oria-test-pg-18a`, com `WHATSAPP_GO_DIR`) → **734/734 PASS**, 0 skipped (baseline 710 + 24 novos) · `npm --prefix admin run build` → PASS.

A Fase 6 só fecha com rollout em produção, a operação interna rodando como Organization normal e
≥ 2 semanas de dogfooding (plano, critério de saída 1). Nada disso aconteceu nem podia acontecer
nesta rodada. OPS-27 continua NOT VERIFIED e continua bloqueando qualquer rollout.
**PD-019 continua aberta:** o tooling roda A e B com o mesmo código, e o cenário é sempre um
argumento declarado.

## 1. O que foi construído

| arquivo | papel |
|---|---|
| `scripts/tenant1/cli.mjs` | entrada única: `preflight`, `plan`, `apply`, `verify`, `rollback` |
| `scripts/tenant1/config.mjs` | arquivo do Tenant #1, argumentos, conferência de cenário, guarda de banco local, sessão READ ONLY, saída mascarada |
| `scripts/tenant1/checks.mjs` | itens do preflight/verify, impressão digital do dado de tenant |
| `scripts/tenant1/acoes.mjs` | plan, apply (orquestra os scripts existentes), rollback |
| `scripts/tenant1/sem-bypass.cjs` | varredura "sem caminho especial" do código de produto |
| `test/fixtures/tenant1/cenario-{a,b}.json` | exemplos declarados (apontam para `test/fixtures/tenancy/cenario-{a,b}.json`) |
| `test/helpers/tenant1-ensaio.js` | base descartável "como produção" (6 migrations → dado nas 3 lojas → credenciais nas colunas antigas → demais migrations com o mapeamento) |
| `test/invariants/fase6-tenant1-rehearsal.test.js` | ensaio A e B, idempotência, falhas, controles negativos de dado |
| `test/invariants/fase6-tenant1-rollback.test.js` | rollback local A (banco novo) e B (base legada) |
| `test/invariants/fase6-tenant1-static.test.js` | critério de saída 2 (sem `if internalTenant`…), com controle negativo |
| `test/invariants/fase6-tenant1-config.test.js` | arquivo, argumentos, guarda local, READ ONLY, saída sem segredo |
| `package.json` | `tenant1:preflight|plan|apply|verify|rollback` |
| `test/invariants/negative-controls.test.js` | + classe `fase6/bypass-interno` |

Nenhuma migration nova, nenhum arquivo de produto (`server.js`, `lib/`, `admin/src`) alterado,
manifesto e contrato de role intocados.

### Reaproveitado, não reimplementado

O `apply` chama, nesta ordem: `aplicarMapeamento` → `bootstrapOwner` (um por owner declarado) →
`seedEntitlements` (uma por Organization) → `importarLegado` (**sem** `limparColunas`) → `recifrar`
→ `importarRemetenteWhatsapp` (se declarado) → `moverCriativos` → emissão da URL opaca da Ink (mesma
regra da rota da tela: libera a posse antiga, reivindica o SHA-256, grava a config) → `registrarAuditoria`
(`tenant1.apply`, sujeito = primeiro owner declarado da Organization). O preflight e o verify chamam
`importarLegado` e `importarRemetenteWhatsapp` em simulação, `inspecionarTenancy` (gates INV-04..07 e
1:1), `tenancy_problemas_de_ownership()`, `tenancy_itens_sem_mapeamento()` e os resolvedores SECURITY
DEFINER (`whatsapp_organization_do_remetente`, `ink_organization_do_webhook`).

## 2. Arquivo do Tenant #1 (explícito, versão 1)

> **Rodada 19:** o bloco `whatsapp` mudou para `{waba:{id,organizationId}, phoneNumber:{id,organizationId}}`
> (a forma `{organizationId}` é recusada) e cada Organization declara `entitlementsProfile`; o arquivo
> ganhou `rollout`. Formato atual em `round19-trilha-h.md`.

```json
{
  "versao": 1,
  "cenario": "A",
  "mapeamentoTenancy": "../tenancy/cenario-a.json",
  "creativeTenantLegado": "default",
  "organizations": [{ "id": "<uuid>", "entitlements": ["financial"] }],
  "owners": [{ "email": "pessoa@dominio", "passwordHashEnv": "NOME_DA_VARIAVEL", "organizations": ["<uuid>"] }],
  "whatsapp": null,
  "inkWebhook": { "organizations": ["<uuid>"] }
}
```

- `--scenario` tem que bater com `cenario`, e a forma do mapeamento tem que ser a do cenário:
  A = 3 Organizations, cada loja legada na sua; B = 1 Organization, `loja:sul|centro|norte` todas
  declaradas para ela e a Store com `lojaLegada`. "Parece B" não existe.
- Campo desconhecido, feature fora do vocabulário, id fora do mapeamento, Organization sem owner,
  Organization sem Store, regra duplicada: FAIL antes de abrir conexão.
- `whatsapp` e `inkWebhook` são obrigatórios como chave; `null` declara "fora desta execução" (a
  obrigatoriedade de WhatsApp/Ink segue com o usuário).
- O hash da senha do owner nunca está no arquivo: `passwordHashEnv` é o **nome** da variável.
- Os valores de entitlements dos fixtures são dados de teste, não proposta de plano.

## 3. Comandos

```
DATABASE_URL=<role de migration> ENCRYPTION_MASTER_KEY=... [ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1 ADMIN_SESSION_SECRET=...] \
<hash do owner em NOME_DA_VARIAVEL> [INK_*_<LOJA>] [WHATSAPP_LEGACY_*] \
  npm run tenant1:preflight -- --scenario A --mapping arquivo.json --uploads <UPLOADS_DIR> [--app-role oria_app]
  npm run tenant1:plan      -- (idem)
  npm run tenant1:apply     -- (idem) [--saida-segredos <dir>]
  npm run tenant1:verify    -- (idem)
  npm run tenant1:rollback  -- --scenario A --mapping arquivo.json [--snapshot arquivo] [--aplicar]
```

- Sem `--scenario` ou sem `--mapping`: **FAIL** em todos os comandos.
- `preflight`, `plan`, `verify`: a sessão abre com `default_transaction_read_only=on` (o servidor
  recusa qualquer escrita, inclusive dos imports em simulação). Testado com erro `25006`.
- `apply`, `rollback`: recusam host não local, `NODE_ENV=production` e qualquer `RAILWAY_*`.
- Saída: `PASS|FAIL|PEND|INFO <item> — detalhe`, e `RESULTADO <comando>: PASS|FAIL`; exit 0 só com
  PASS. PEND = o apply resolve (no verify, PEND vira FAIL). INFO não muda o resultado.
- Nenhum segredo no stdout: toda linha passa por uma máscara com os valores sensíveis do ambiente
  (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*_HASH`, `*MASTER_KEY*`, senha da `DATABASE_URL`). Se algum
  aparecer, é trocado e a execução termina em FAIL (`saida.segredo`). A URL opaca da Ink vai só
  para `--saida-segredos/<org>.url`, arquivo novo (`wx`), modo 0600.
- O verify exige que a role do operador veja todas as Organizations (SUPERUSER ou BYPASSRLS). Sem
  isso, FAIL `db.role-operador` — a RLS FORCE filtraria as leituras e o verify passaria em silêncio.

### Itens

`db.conexao` · `db.role-operador` · `db.migrations` (todas as de `migrations/`, nenhuma a mais) ·
`tenancy.organization[..]` · `tenancy.store[..]` (1:1, loja declarada) · `tenancy.organizations-extras` ·
`tenancy.stores-extras` · `tenancy.mapeamento` (idêntico ao arquivo; conflito ou regra a mais = FAIL) ·
`tenancy.gates` · `tenancy.orfaos` · `tenancy.dono-da-loja` (linha de loja X fora da dona de X = FAIL) ·
`auth.owner[..]` (exatamente as Organizations declaradas) · `auth.organization-com-owner[..]` ·
`entitlements[..]` · `integrations.unicidade` · `integrations.escopo-legado` · `integrations.legado` ·
`secrets.chave` · `secrets.versao` · `creatives.arquivos` · `creatives.tenant` · `whatsapp.posse`
(toda posse de WABA/número tem integração e o resolvedor de entrada devolve a mesma Organization) ·
`whatsapp.remetente[..]` · `ink.webhook-posse` · `ink.webhook[..]` (URL resolve para a Organization e
há segredo) · `jobs.leases` · `jobs.fila-whatsapp-web` · `legado.flags` · `role.app` (sem SUPERUSER/
BYPASSRLS/INHERIT, não dona, sem globais privadas, com DML e EXECUTE) · `finance.atribuicao` (conta de
mídia selecionada com posse e loja atribuída da própria Organization) · `audit.sujeito` ·
`audit[..]` (verify) · `bypass.codigo` · `bypass.banco`. INFO: `tenancy.t04`,
`tenancy.loja-fora-da-store`, `legado.colunas`, `entitlements[..].extras`, `finance.loja-da-store`.

## 4. Ensaio (dois bancos descartáveis independentes)

| | cenário A | cenário B |
|---|---|---|
| base | 6 migrations + dado nas 55 tabelas das 3 lojas + credenciais nas colunas antigas + migrations restantes com o mapeamento A | idem com o mapeamento B |
| preflight | PASS (owners, entitlements, 6+ credenciais, criativos, WhatsApp, URLs como PEND) | PASS |
| plan | PASS, "ações destrutivas: nenhuma"; impressão digital igual antes/depois | idem |
| apply | PASS; 3 owners, cada um só na sua Organization (3 cadeias); entitlements só os declarados (Norte declarou nenhuma: nada ligado); meta/OpenAI no dono declarado (Sul), não "no único"; URL opaca de cada Organization resolve para ela | PASS; 1 Organization/1 Store; `loja:centro/norte → B`; todo o histórico das 3 lojas em B; só a credencial Ink/GA4 da loja da Store (Sul) importada |
| verify | PASS | PASS (+ INFO `tenancy.loja-fora-da-store`) |
| re-execução | PASS, "nada mudou", sem auditoria nova, sem URL nova, impressão igual | idem |
| leitura pela app | sob a role da aplicação, cada Organization lê a credencial da própria loja; Centro não lê a Meta de Sul | B lê Ink/GA4 da Sul e a Meta da instalação |

Falhas cobertas (todas FAIL, nenhuma escrita): sem cenário ou sem arquivo (os 5 comandos), cenário
trocado, B declarado com mapeamento de A, A com duas lojas na mesma Organization, mapeamento
ambíguo (loja duplicada), Organization sem Store no arquivo, Organization sem Store no banco
(apply aborta pelo preflight, impressão igual), banco de B com o arquivo de A, chave `whatsapp`
ausente, Organization sem owner, hash do owner ausente (CLI real, exit 1, sem segredo no stdout),
host remoto, ambiente Railway.

## 5. Controles negativos

- **Código:** `fase6/bypass-interno` em `negative-controls.test.js` (ciclo de 5 passos: injeta
  `ehOperacaoInterna = org.nome === 'Use Origens'` numa cópia do `server.js`; o teste estático reprova
  e volta a passar). Além disso, cada um dos 6 padrões reprova exemplos próprios e 9 linhas legítimas
  (rótulos `LOJAS`/`adminStores`, a ferramenta interna R-01 atrás de `INTERNAL_TOOLS_ENABLED`,
  comentários) passam. O orquestrador não contém `LIMIT 1` nem `rows[0]`.
- **Dado (verify precisa reprovar):** owner removido de uma Organization; posse do número movida
  para outra Organization; linha de uma loja reassociada a outra Organization; entitlement declarado
  desligado. Nos quatro, o verify dá FAIL no item certo e o apply (roll-forward) ou a restauração
  volta ao PASS.
- **Rollback:** login de emergência que não cobre todas as Organizations; ausência das variáveis da
  Ink; `ADMIN_SESSION_SECRET` trocado (colunas ilegíveis); remetente legado removido; colunas antigas
  limpas (release N+1); linha trocada de Organization e linha removida acusadas pela impressão digital.

## 6. Rollback Fase 6

**Princípio:** o cutover do Tenant #1 não cria schema e não apaga nada. O rollback é de
**configuração** e de **caminho de leitura**. Não há `DROP`, `DELETE`, `migrate:down`, troca de dono,
remoção de Organization/Store/membership/integração/posse, nem "juntar tudo numa Organization".

### Antes do cutover (gate)

1. Backup do banco do painel e do Go, com restauração testada (OPS-04).
2. No ambiente do painel, com as variáveis de rollback presentes (`LEGACY_ADMIN_USER_EMAIL`,
   `ADMIN_PASSWORD`, `INK_TOKEN_<LOJA>`, `INK_FEED_URL_<LOJA>`, `INK_WEBHOOK_SECRET_<LOJA>`,
   `ADMIN_SESSION_SECRET`, `WHATSAPP_LEGACY_*` se o WhatsApp faz parte):
   `npm run tenant1:rollback -- --scenario X --mapping arquivo.json --snapshot antes.json`
   (simulação). **Todos os itens precisam ser PASS**; sem isso, não há caminho de volta e o cutover
   não começa.
   - No cenário A, `LEGACY_ADMIN_USER_EMAIL` precisa ser owner das **três** Organizations (declare essa
     pessoa em `owners`); um owner de uma cadeia só cobre uma loja (testado: FAIL).
3. `tenant1:preflight` e `tenant1:plan` PASS; `tenant1:apply`; `tenant1:verify` PASS.

### Nível 1 — mesma release, só configuração (minutos)

4. Login de emergência: `ALLOW_LEGACY_ADMIN_PASSWORD=1` + `ADMIN_PASSWORD` +
   `LEGACY_ADMIN_USER_EMAIL=<owner declarado>`. Entra como aquela pessoa, sessão marcada `legado`,
   auditoria com sujeito real (testado com o router real sob a role da aplicação).
5. Ink pelo ambiente: `ALLOW_LEGACY_INTEGRATION_ENV=1`. Só vale para a loja da Store da Organization
   do contexto e só quando o segredo da integração falta; o segredo importado continua preferido
   (testado: Centro lê o próprio token do ambiente; Norte não lê o de Centro; Sul segue na integração).
6. Registrar a decisão: `npm run tenant1:rollback -- --scenario X --mapping arquivo.json --aplicar`.
   Única escrita: `audit_log` `tenant1.rollback` por Organization; `rollback.dados` compara a impressão
   digital antes/depois (nenhuma linha removida ou trocada de Organization).
7. `tenant1:verify` continua PASS (o rollback não quebra o isolamento).

### Nível 2 — release anterior (se o nível 1 não resolver)

8. Ordem de `whatsapp-inbound-5c.md` §7 e `whatsapp-sender-contract.md` §8: **Go antes do painel**.
9. Painel: voltar a versão. As migrations são aditivas e ficam; `migrate:down` **não** faz parte deste
   rollback.
10. Ink: a release anterior à 5c escuta `/api/webhooks/ink` com `INK_WEBHOOK_SECRET_<LOJA>`; voltar a URL
    no cadastro da Reserva Ink junto com a release (`rollback.ink-webhook` confere as variáveis).
11. Credenciais: a release anterior à Fase 4 lê as colunas antigas com `ADMIN_SESSION_SECRET`
    (`rollback.colunas-legadas` decifra cada uma com essa chave antes do cutover).

### Roll-forward

12. Desligar as flags do nível 1, `tenant1:apply` (não muda nada, não audita) e `tenant1:verify` PASS.

### Quando a janela fecha (esperado, não é erro)

Depois de `integrations:import-legacy --limpar-colunas-legadas` (release N+1), da Release D do
WhatsApp e da remoção de `INK_*`, os itens `rollback.*` passam a FAIL — testado. Esses passos só depois
de ≥ 2 semanas de dogfooding e de decisão explícita.

### Proibido no rollback

Reassociar dados entre Organizations; apagar ou suspender Organization/Store; alterar
`tenancy_mapeamentos`; liberar posses de WABA/número/URL de outra Organization; `migrate:down`;
limpar colunas; qualquer passo contra produção sem o runbook de rollout (trilha D).

## 7. Achados e decisões que ficam com o usuário

1. **Cenário B — histórico invisível.** Centro e Norte convergem para a Organization (dono correto,
   testado), mas a aplicação filtra pela loja da Store (`lojaDoContexto()`), que é uma só (ex.: `sul`).
   Linhas com `loja = centro|norte` ficam na Organization certa e **não aparecem** nas telas/DRE. O
   verify mostra isso como INFO `tenancy.loja-fora-da-store`. Aceitar, re-rotular (`loja → sul`, mesma
   Organization) ou manter A é decisão de execução de PD-019 — não foi tomada aqui.
2. **Cenário B — credenciais.** Só as variáveis da loja da Store (Sul) são importadas (1:1);
   `INK_*_CENTRO/NORTE` e o GA4 de Centro/Norte não viram credencial de B. Coerente com a
   consolidação Centro/Norte → Sul, mas precisa ser sabido antes do cutover.
3. **Cenário A — login de emergência.** Representa UMA pessoa; para servir às três Organizations ela
   precisa ser owner das três (declarada no arquivo). Perder a visão conjunta (PD-022) continua valendo
   para a operação normal.
4. **Estado da instalação.** `meta:*`, `google_ads:*`, `instalacao:*`, `sem_loja:*` e
   `creative_tenant:default` vão para quem o mapeamento declara (fixture A: Sul). T-04 segue aberto
   (INFO `tenancy.t04`).
5. **URL da Ink.** O apply só emite com `--saida-segredos`; o caminho normal continua sendo a tela
   (OPS-34). A rota da tela e o apply repetem a mesma regra (hash + posse + config); não extraí para
   `lib/` para não tocar `server.js` nesta rodada.
6. **Role do operador.** O verify precisa de SUPERUSER ou BYPASSRLS; conferir qual role de migration
   existe em produção antes do rollout.

## 8. Riscos

- A varredura de bypass é textual (padrões + controles); um ramo escrito de forma muito diferente
  passaria. Mitigação: os invariants de isolamento continuam sendo a prova principal.
- O ensaio usa dado sintético nas 55 tabelas; volumes e formatos reais só aparecem no rollout.
- O nível 2 do rollback depende de variáveis que hoje existem no Railway e não foram conferidas (sem
  acesso nesta rodada).
