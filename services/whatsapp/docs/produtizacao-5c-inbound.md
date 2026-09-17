# Fase 5c — entrada multi-tenant (serviço)

Status 16/09/2026: implementado localmente, sem deploy. A documentação completa (rollout, rollback, OPS) fica no painel, em `docs/produtizacao-saas/whatsapp-inbound-5c.md`.

## Topologia (PD-023 CLOSED)

- Um processo e um Meta App da plataforma atendem várias Organizations.
- `META_APP_SECRET` e `META_VERIFY_TOKEN` são de plataforma.
- O tenant de cada evento vem do painel: `inbound-context`, a partir da WABA (`entry.id`) e do número (`metadata.phone_number_id`).

## Entrada (`webhook.go`)

A ordem de um POST é:

1. HMAC;
2. parse;
3. uma resolução **por change**;
4. idempotência `(organization_id, evento)` **e** a change gravada em `webhook_inbox`, na mesma transação (rodada 18);
5. `200` — com banco, quer dizer "aceito de forma durável";
6. efeitos no escopo de cada change, pelo worker da inbox (ver "Aceite durável").

Casos de recusa:

- change desconhecida ou divergente → descartada sem efeito;
- painel ou banco fora → `503`, sem efeito.

Auto-resposta e aviso:

- usam o texto e o número configurados pela Organization;
- o token vem pela referência do contexto, então funcionam no primeiro evento depois de um restart.

## Rotas internas

| rotas | exigem |
|---|---|
| `/send/*`, `/media/*`, `/templates/*`, `/queue/add` | remetente (5b), cuja referência também define a Organization |
| `/dashboard/events`, `/queue/{list,send,delete,dedupe}`, `/problems/{list,add,sync}`, `/automaticos/list` | `X-Sender-Phone-Number-Id` + `X-Sender-Ref` (contexto) |

Sem contexto, a resposta é `400`. Nada lista "tudo".

## Estado por Organization

- **Em memória:** eventos, fila, retry (`(org, wamid)`), cooldown (`(org, telefone)`) e problemas.
- **No banco** (`schema_migrations`, versões 1–3; a 3 é a inbox da rodada 18): `organization_id` em `events`, `queue_items` e `problem_orders`. A PK de problemas passou a ser `(organization_id, numero)`.
- **Idempotência:** `processed_webhook_events`.
- **Linhas antigas:** só recebem dono com `LEGACY_ORGANIZATION_ID`.

## Fila com lease

- A reivindicação usa CTE + `FOR UPDATE SKIP LOCKED`.
- Um lease vencido vira erro e não é reenviado.
- Achado da rodada: `WHERE id IN (subconsulta com LIMIT ... SKIP LOCKED)` pegava mais que o lote.

## Invariantes

Cada invariante está coberto pelos testes abaixo; entre parênteses, os controles negativos manuais (ciclo passa → viola → falha → restaura → passa):

| invariante | teste | controles negativos |
|---|---|---|
| INV-15 | `replies_test.go` | 1 |
| INV-16 / INV-34 | idempotência e dedupe A/B | 1 |
| INV-18 | `db_queue_test.go` (duas réplicas, queda, lease em transação aberta) | 2 |
| INV-29 | teste instrumentado | 1 |
| INV-31 | sync com escopo do corpo | 1 |
| INV-32 | estático sobre `db.go` + restart | 2 |
| INV-33 | cooldown A/B | 1 |
| INV-37 | retry depois de restart | — |
| R18-22 repasse sem segredo na URL | `forward_test.go` | 2 |
| R18-23/24 aceite durável e queda depois do 200 | `inbox_test.go`, `inbox_crash_test.go` | 3 |
| R18-25 cache de contexto ≤ 30 s | `hardening_test.go` | 1 |
| R18-26 páginas embutidas sem dado | `hardening_test.go` | 1 |

## Rodada 18 — hardening residual

### Repasse ao painel (§22)

Contrato: `testdata/forward-auth-v1.json` (cópia idêntica no painel, com vetor de teste).

| antes | depois |
|---|---|
| segredo embutido na URL (`WEBHOOK_FORWARD_URL=...?secret=`) | URL sem credencial, query nem fragmento |
| painel sem segredo aceitava tudo | painel sem segredo recusa tudo (503) |
| comparação `!==` | HMAC-SHA256 em tempo constante |

Cada repasse leva:

```text
X-Oria-Forward-Timestamp: <unix seconds>
X-Oria-Forward-Signature: v1=<hex HMAC-SHA256(WEBHOOK_FORWARD_SECRET, timestamp + "." + corpo)>
```

- `WEBHOOK_FORWARD_SECRET` (≥ 32 caracteres) aqui = `WHATSAPP_WEBHOOK_SECRET` no painel.
- Janela de ±300 s no painel. `?secret=` é recusado lá mesmo com assinatura válida, salvo a tolerância de transição da rodada 19 (abaixo), que só vale com assinatura válida.
- **Produção:** URL com query/credencial, URL não-https ou URL sem segredo → o boot aborta, e a mensagem não repete a URL.
- **Fora de produção:** o repasse fica desligado, com aviso.
- Erro e log do repasse não têm URL nem segredo (`url.Error` é desembrulhado).

### Aceite durável (§23/§24)

A tabela `webhook_inbox` vem da migration 3, que é aditiva. Cada linha guarda:

- `organization_id`;
- o contexto resolvido (sem token: só a referência assinada, como a fila);
- a change crua;
- as chaves de evento novas;
- `steps`, `attempts` e o lease.

O worker roda em toda réplica, a cada 2 s e logo depois de cada aceite:

- pega as linhas com `FOR UPDATE SKIP LOCKED`;
- lease de 2 min, renovado a cada passo;
- um lease vencido (réplica caiu) volta a ser elegível.

| efeito | garantia num reprocessamento | por quê |
|---|---|---|
| eventos do dashboard | exatamente uma vez | gravados na mesma transação que marca o passo |
| retry de status `failed` | exatamente uma vez | a fila deduplica por `(Organization, wamid)` |
| repasse ao painel | **pelo menos uma vez** | marcado só depois do 2xx; o painel é idempotente para status (só avança) |
| aviso ao dono e auto-resposta | **no máximo uma vez** | marcados `started` antes do envio. A Meta não tem chave de idempotência: se a queda for entre a marca e o envio, não há reenvio, e o log registra `interrompido` (mesma política da fila) |

**Falhas:**

- **Passageiras:** resolver fora, 5xx/429 (`ErrSenderUnavailable`) e repasse recusado. A linha volta para `pending` com backoff exponencial (até 5 min).
- **Depois de 8 tentativas:** a linha vira `failed`. Ela fica visível com `last_error` (sem segredo nem conteúdo) e sai na retenção de 7 dias.
- **Linha concluída:** é apagada. A idempotência continua em `processed_webhook_events`.

**Sem banco (dev/test):** o fluxo continua em memória, sem durabilidade.

**Limites conhecidos:**

- O retry de status `failed` depende do pedido original, que só existe em memória (`retry.go`). Se o processo cair entre o envio original e o status, não há item de retry. Isso é anterior à rodada.
- O cooldown da auto-resposta é em memória.
- Não há cota por tenant no worker.

**Consulta operacional:**

```sql
SELECT organization_id, status, attempts, last_error, received_at
  FROM webhook_inbox WHERE status <> 'pending' OR attempts > 1;
```

### Cache de contexto (§25)

| resultado | TTL antes | TTL agora |
|---|---|---|
| contexto válido | 5 min | 30 s |
| recusa (403/404/409) | 1 min | 15 s |

**Limite real:** uma desconexão ou troca de número ainda vale para a **entrada** por até 30 s em cada réplica. Nesse intervalo:

- o evento é atribuído à Organization antiga;
- o repasse sai.

**Envios** não dependem do cache: o `/sender` recusa a integração trocada.

**Por que não invalidação explícita:**

- são várias réplicas, e o painel não tem canal até elas;
- o evento da Meta não traz versão da integração.

### Páginas embutidas (§26)

`/dashboard`, `/problems` e `/automaticos` respondem `410` em texto puro (com `API_KEY`; sem ela, `401`). Os HTML saíram do binário e continuam no histórico do git (antes de `b426acb`).

Os dados continuam só nas rotas com contexto. O teste confere que:

- as páginas não mostram dado de A nem de B;
- `/dashboard/events` de A não traz B.

### Controles negativos (rodada 18)

Todos com o ciclo "passa → viola → falha → restaura → passa", rodados com `go-nc-spec.py` e o banco de teste:

| violação | teste que reprova |
|---|---|
| repasse volta a levar `?secret=` | `TestGivenForwardConfigured_WhenForwarding_ThenSecretOnlyTravelsAsSignature` |
| URL com query aceita | `TestGivenForwardURLWithSecretInQuery_...` e o teste de boot em produção |
| 200 antes de persistir (versão anterior) | os 3 testes de queda |
| envio sem marca `started` | `TestGivenProcessDiesBetweenMarkingAndSendingTheReply_...` |
| cache de 5 min (versão anterior) | `TestGivenCachedInboundContext_...` |
| página volta a responder conteúdo | `TestGivenEventsOfAAndB_WhenOpeningTheEmbeddedPages_...` |
| réplica sem lease marca passo | `TestGivenInboxRowLeasedByOneReplica_...` |

### Rollout e rollback (Go)

A ordem completa, com o painel, está em `docs/produtizacao-saas/whatsapp-inbound-5c.md` §6/§7.

**Deploy e rollback:** substituídos pela transição aditiva da rodada 19 (seção seguinte). Não há
mais passo que aceite perder status de campanha.

## Rodada 19 — transição do repasse sem perda de status (§5)

**Problema.** O painel em produção (e o 5c R1 antes de `c706da1`) autentica o repasse só por
`req.query.secret === WHATSAPP_WEBHOOK_SECRET` e ignora headers. Este serviço, desde a rodada 18,
recusa URL com query (em produção, o boot aborta). Publicar o Go assinado com a URL limpa antes de o
painel conferir a assinatura = 401 em todo status = status perdido. Publicar o painel que exige
assinatura antes do Go = o mesmo 401 no sentido inverso.

**Mudança (aditiva, desligada por padrão).** `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET`:

| valor | efeito |
|---|---|
| ausente ou `0` | comportamento da rodada 18: URL com query recusada |
| `1` | aceita a URL legada com **exatamente** `?secret=<valor não vazio>` (nada mais: outro parâmetro, parâmetro repetido, credencial, fragmento ou http em produção continuam recusados) e cada repasse sai com a query **e** com `X-Oria-Forward-*`, mesmo corpo |
| outro (`true`, `yes`…) | erro de configuração: em produção o boot aborta |

- O valor da query **precisa ser diferente** de `WEBHOOK_FORWARD_SECRET` (senão o boot recusa): a
  chave da assinatura é um valor novo; o da query já esteve em URL.
- Boot com a flag: `[forward] AVISO env=<env>: WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1 — TRANSIÇÃO: ...`
  e a linha de boot mostra `forward_legacy_query=true`. Com a flag e a URL já limpa, o aviso pede
  para desligar a flag. Nenhuma mensagem repete a URL, a query ou o segredo.
- O painel correspondente (`WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1`) ignora a query quando a
  assinatura é válida; a query nunca autentica sozinha lá.
- Contrato: bloco `legacy_query_transition` em `testdata/forward-auth-v1.json` (formato de fio e
  versão inalterados; cópia idêntica no painel).

**Ordem de releases** (a do runbook do painel é a referência; `round19-trilha-e.md`):

| passo | serviço | configuração | quem autentica o repasse |
|---|---|---|---|
| D0 | painel 5c R1 **antes** de `c706da1` (ex.: `8c024d2`) | `WHATSAPP_WEBHOOK_SECRET` = valor legado (inalterado) | query (Go 5b ainda sem assinatura) |
| 1 (E) | **este serviço** (R2) | `WEBHOOK_FORWARD_SECRET` = valor NOVO (≥ 32, ≠ legado); `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1`; `WEBHOOK_FORWARD_URL` **inalterada** (com `?secret=`) | painel D0 pela query; assinatura já viaja |
| 2 (D') | painel HEAD | `WHATSAPP_WEBHOOK_SECRET` = valor NOVO; `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1` | assinatura (query ignorada) |
| 3 | **este serviço** (só ambiente) | tirar `?secret=` da URL; remover a flag (ou `0`) | assinatura |
| 4 | painel (só ambiente, CLEANUP) | remover a tolerância | assinatura (rodada 18 pura) |

**Rollback sem perda** — sempre na ordem inversa dos passos:

- **passo 1 → Go 5b:** o 5b manda a query; o painel D0 aceita. Antes, esperar a inbox esvaziar
  (`SELECT count(*) FROM webhook_inbox WHERE status <> 'failed'` = 0; a migration 3 pode ficar) e rodar o SQL do §7 do
  documento do painel. **Só enquanto o painel estiver em D0**: com o painel em D' no ar, voltar o
  painel a D0 primeiro (o Go 5c funciona com D0, que já tem os endpoints de contexto).
- **passo 3 → passo 2:** recolocar a URL com `?secret=<legado>` e a flag `1`. O painel D' aceita os
  dois formatos, então não há janela. É pré-requisito para voltar o painel de D' a D0.
- **Proibido:** Go sem a flag com a URL limpa enquanto o painel em produção for D0 (ou anterior); é
  exatamente o 401 que a transição evita (provado no teste de contrato do painel).

**Provas executáveis:**

| o quê | onde |
|---|---|
| flag: só `1`/`0`/ausente; URL legada só com a flag; só `secret` uma vez; https e segredo continuam exigidos; query ≠ segredo | `forward_transition_test.go` |
| com a flag, query **e** assinatura válidas no mesmo repasse, mesmo corpo; nenhum segredo em header, erro ou log | `TestGivenLegacyTransition_*` |
| produção com a flag sobe com aviso e sem segredo na saída; valor inválido aborta | testes de boot em `forward_transition_test.go` |
| contrato: nomes da transição iguais ao código | `TestGivenForwardContract_WhenReadingTheTransition_ThenNamesMatchTheCode` |
| binário real → painel ANTIGO real (`bfd00a6`) aplica o status; binário mutante (flag sem query) → 401 e status parado; Go sem flag → 401; painel novo com/sem tolerância | painel: `test/invariants/r19-contrato-repasse-transicao.test.js` |

Controles negativos verificados à mão nesta rodada (cópia da fonte, mesmos testes):

| violação | teste que reprova |
|---|---|
| com a flag, a URL perde a query (`u.RawQuery = ""`) | `TestGivenLegacyURLWithFlag_*`, `TestGivenLegacyTransition_WhenForwarding_*`, boot em produção com a flag |
| URL legada aceita sem a flag | `TestGivenLegacyURLWithoutFlag_WhenValidating_ThenRejectedAsBefore` |

## Rollback

A versão 5b não grava com `organization_id NOT NULL`. Antes de voltar o código, rode o SQL do §7 do documento do painel.
