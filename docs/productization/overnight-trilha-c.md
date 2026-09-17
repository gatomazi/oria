# Rodada 18 · Trilha C — hardening residual crítico da 5c

**Repositórios:**

- painel: base `bfd00a6`;
- `whatsapp-webhook-go`: base `445ead9`.

**Limites:** trabalho local, em worktrees destacados. Sem push, sem deploy, sem Railway, sem banco de produção, sem segredo real. **OPS-27 continua NOT VERIFIED.**

**Estado:** READY (§22, §23, §24, §25 e §26 concluídos localmente, com testes e controles negativos). Os resultados e os commits estão no fim deste documento.

**Contratos atualizados:**

- `whatsapp-inbound-5c.md` (§2, §2.1, §3.1, §6–§9);
- no Go, `docs/produtizacao-5c-inbound.md` ("Rodada 18").

---

## §22 — segredo do repasse fora da query string

**Antes:**

- o Go repassava a `WEBHOOK_FORWARD_URL` com o segredo embutido (`?secret=`);
- o painel comparava `req.query.secret !== WHATSAPP_WEBHOOK_SECRET`;
- **sem o segredo configurado, o painel aceitava qualquer POST.**

**Agora:**

- **Contrato** `forward-auth-v1.json`, idêntico nos dois repositórios. Tem vetor de teste, e o teste do painel compara as duas cópias.
- **Assinatura do Go:**

  ```text
  X-Oria-Forward-Timestamp: <unix s>
  X-Oria-Forward-Signature: v1=<hex HMAC-SHA256(segredo, ts + "." + corpo)>
  ```

- **Conferência no painel** (`lib/platform/whatsapp-forward.js`):
  - em tempo constante (SHA-256 dos dois lados + `timingSafeEqual`);
  - janela de ±300 s;
  - sobre o corpo cru (`req.rawBody`).
- **Recusas do painel:**
  - `secret` na query → 401, **mesmo com assinatura válida**;
  - sem assinatura, assinatura errada, corpo alterado ou fora da janela → 401;
  - **sem `WHATSAPP_WEBHOOK_SECRET` (ou < 32 caracteres) → 503**: falha fechada em qualquer ambiente.
  - Em produção, com `WHATSAPP_SERVICE_URL`, o boot do painel só **avisa**. Não aborta, porque o repasse só alimenta status de campanha, e um novo fail-fast de boot exigiria coordenação de OPS.
- **Configuração no Go:**
  - `WEBHOOK_FORWARD_URL` sem query, credencial ou fragmento;
  - https em produção;
  - `WEBHOOK_FORWARD_SECRET` ≥ 32.
  - Em produção, violar qualquer um desses itens aborta o boot, e a mensagem não repete a URL. Fora de produção, o repasse desliga com aviso.
  - Sem segredo, `sendForward` não envia nada.
  - Erro de transporte: `url.Error` é desembrulhado, e nem a URL nem o segredo vão para erro ou log.

**Compatibilidade — decisão: recusar a query antiga, sem flag.** Não existe modo legado.

**Rollout:**

1. O painel R1 recebe um `WHATSAPP_WEBHOOK_SECRET` **novo**: o antigo, se existia, esteve em URL.
2. O Go R2 recebe o mesmo valor em `WEBHOOK_FORWARD_SECRET`, com a URL sem query.

**Custo conhecido:** entre R1 e R2, o Go antigo repassa sem assinatura e o painel recusa. Os status de campanha (`delivered`, `read`, `failed`) repassados nessa janela não são aplicados, e o Go antigo não tenta de novo. O R2 deve vir logo depois do R1, como a 5c já pede.

**Rollback:** o Go vem antes do painel (a versão anterior do Go não assina). O painel anterior aceita repasse sem segredo quando a variável não está definida. Não recolocar segredo em URL.

**Testes:**

| repositório | cobertura |
|---|---|
| painel | `trilha-c-whatsapp-forward.test.js` (unidade + contrato); `fase3-server-ab.test.js` (processo real: sem assinatura, `?secret=` sozinho e com assinatura certa, corpo trocado, timestamp velho → 401; status não muda; segredo fora do log; repasse assinado aplica o status de B); E2E 5c (Go real repassa assinado; inbox esvazia; nenhum `repasse recusado`; segredo e `secret=` fora dos logs) |
| Go | `forward_test.go`: vetor do contrato, URL com credencial recusada sem ecoar, https/segredo obrigatórios, repasse sem query e só com assinatura, sem segredo nada sai, erro/log sem segredo, boot em produção aborta com `?secret=` e sem segredo |

## §23/§24 — aceite durável e queda depois do 200

**Implementação (Go):**

- **Migration 3:** tabela `webhook_inbox`, aditiva.
- **Aceite:** chaves de idempotência + linhas da inbox numa só transação, e só depois o `200`. A resposta tem `Content-Length` e é enviada (flush) antes de qualquer efeito.
- **Worker:**
  - roda em toda réplica: a cada 2 s e logo depois do aceite;
  - `FOR UPDATE SKIP LOCKED`, lease de 2 min renovado a cada passo;
  - lease vencido volta a ser elegível;
  - réplica sem lease não marca passo (`errInboxLeaseLost`).
- **Passos registrados em `steps`:**

| efeito | garantia observável |
|---|---|
| eventos do dashboard | exatamente uma vez (mesma transação do passo) |
| retry de status `failed` | exatamente uma vez (dedupe por wamid na Organization) |
| repasse ao painel | **pelo menos uma vez**: marcado depois do 2xx; o painel é idempotente para status |
| aviso ao dono e auto-resposta | **no máximo uma vez**: marca `started` antes do envio. A Meta não aceita chave de idempotência, então uma queda entre a marca e o envio perde aquele envio (com log `interrompido`). É a mesma política da fila (lease vencido não reenvia) |

- **Falhas:**
  - passageiras (resolver fora, 5xx/429 → `ErrSenderUnavailable`; repasse recusado) voltam com backoff de até 5 min;
  - depois de 8 tentativas, `failed` com `last_error` sem segredo; retenção de 7 dias;
  - linha concluída é apagada.
- **Sem banco (dev/test):** o fluxo em memória segue como antes.

**Teste crash-after-accept** (processos filhos reais, como o teste de duas réplicas):

1. **Queda logo depois do 200:** antes do restart, 1 linha na inbox e nenhum efeito. O restart faz cada efeito exatamente uma vez — evento recebido + evento enviado, aviso, auto-resposta e repasse assinado. Um novo restart e a reentrega da Meta a um processo novo não repetem nada.
2. **Queda com o evento já gravado:** outra réplica assume depois do lease, sem duplicar nem perder.
3. **Queda entre a marca e o envio da auto-resposta:** a resposta não é reenviada, e o log registra; o aviso sai uma vez, e evento e repasse também uma vez.

Mais:

- banco sem esquema → 503, sem efeito;
- resolver fora na 1ª tentativa → nova tentativa sem duplicar evento;
- repasse recusado até esgotar → `failed`;
- lease entre réplicas.

**Limites que ficam:**

- o retry de `failed` ainda depende do pedido original em memória (`retry.go`, anterior à rodada);
- cooldown da auto-resposta em memória;
- sem cota por tenant no worker.

## §25 — cache de contexto

| resultado | TTL antes | TTL agora |
|---|---|---|
| contexto válido | 5 min | 30 s |
| recusa | 1 min | 15 s |

**Por que TTL curto:** é a opção mais simples e testável.

- Invalidação explícita não alcança várias réplicas.
- O evento da Meta não traz versão da integração para pôr na chave.

**Limite real:** até 30 s por réplica em que uma troca ou desconexão ainda vale para a entrada.

- Nesse intervalo, o evento é atribuído à Organization antiga e o repasse sai.
- Os envios são conferidos na hora pelo `/sender`.

**Teste:** relógio injetado — a 29 s o contexto ainda vale; a 31 s, não; um número conectado vale em 16 s.

## §26 — páginas HTML embutidas no Go

- `/dashboard`, `/problems` e `/automaticos` → `410` em texto puro, `no-store` (sem chave, `401`).
- Os três HTML saíram do binário e do `Dockerfile`.
- **Teste:** com eventos e problemas de A e B semeados, nenhuma página mostra dado (nem HTML ou `fetch(`). `/dashboard/events` sem contexto → 400; o de A não traz B.
- **Pendência que continua:** revisão manual da fila (`modoEnvio: manual`) sem tela no painel.

## Controles negativos

Todos com o ciclo "passa → viola → falha → restaura → passa".

**Painel** (`negative-controls.test.js`, classe nova no teste de cobertura):

| classe | violação (versão anterior) | teste |
|---|---|---|
| `whatsapp/repasse-segredo-na-query` | `?secret=` igual ao segredo autentica | `trilha-c-whatsapp-forward.test.js` |
| `whatsapp/repasse-sem-segredo` | sem segredo configurado, aceita | `trilha-c-whatsapp-forward.test.js` |
| `whatsapp/repasse-rota-legada` | a rota aceita `req.query.secret` | `fase3-server-ab.test.js` |

**Go** (manual, `go-nc-spec.py`, com banco de teste — 7/7):

| violação | teste que reprova |
|---|---|
| repasse com `?secret=` | forward |
| URL com query aceita | forward + boot |
| 200 antes de persistir | 3 testes de queda |
| envio sem marca `started` | queda entre marca e envio |
| cache de 5 min | cache |
| página volta a responder conteúdo | páginas |
| réplica sem lease marca passo | lease |

## Decisões e pendências para o usuário

1. **Janela R1→R2 do repasse:** status de campanha repassados pelo Go antigo são recusados.
   - Alternativa: flag temporária no painel aceitando repasse sem assinatura. **Não implementada**, por preferência de recusar.
   - Decidir se a janela é aceitável.
2. **OPS-09 (atualizado):**
   - gerar o valor novo do segredo nos dois serviços;
   - tirar `?secret=` da URL;
   - confirmar que a URL de produção é https.
   - O valor atual de `WEBHOOK_FORWARD_URL` em produção segue **NOT VERIFIED**.
3. **Fail-fast no boot do painel sem `WHATSAPP_WEBHOOK_SECRET`:** hoje é só aviso. Transformar em abort exige coordenação de OPS.
4. **Tela de revisão manual da fila no painel:** pendência anterior, não tratada.

## Arquivos compartilhados tocados (painel)

- `server.js`: rota `/api/webhooks/whatsapp`, bloco do `WHATSAPP_WEBHOOK_SECRET`;
- `test/invariants/negative-controls.test.js`: 3 violações e a lista de classes;
- `test/invariants/fase3-server-ab.test.js`: env `WHATSAPP_WEBHOOK_SECRET`, teste novo e repasse assinado;
- `test/invariants/fase5c-e2e-whatsapp.test.js`: envs do repasse, `webhook_inbox` na varredura de token, cenário novo.

Nenhuma migration do painel, nenhum script npm, nenhuma alteração em app-role nem no manifesto.

## Resultados

### Painel

**Commits** (worktree destacado, base `bfd00a6`):

- `0575787` fix(security): remove forwarding secret from query string
- commit de docs (este arquivo + `whatsapp-inbound-5c.md`)

**Validação:**

| verificação | resultado |
|---|---|
| `npm test` (`TEST_PG_CONTAINER=oria-test-pg-18c`, `WHATSAPP_GO_DIR` = worktree Go) | **720/720** pass, 0 fail, 0 skipped (baseline 710 + 10 novos) |
| `npm --prefix admin run build` | PASS |

### Go

**Commits** (worktree destacado, base `445ead9`):

- `40cf2e1` fix(security): remove forwarding secret from query string
- `c735c7e` fix(webhook): persist accepted events before acknowledgement
- `d47b2af` test(webhook): recover effects after accepted-event crash
- `b426acb` fix(webhook): shorten tenant cache and drop embedded pages
- `23528ae` docs(productization): document round 18 webhook hardening

**Validação:**

| verificação | resultado |
|---|---|
| `go test -race -count=1 ./...` (Postgres descartável) | **123 PASS**, 2 SKIP (os dois processos filhos: fila e inbox), 0 FAIL (baseline 105) |
| `go vet ./...` | PASS |
| `go build ./...` | PASS |
| cada commit | build + vet + testes verdes no conteúdo do índice, num diretório à parte |

**Flake observado:** numa das verificações (commit `b426acb`), 1 teste falhou uma vez. Em seguida:

- 2 + 5 verificações do mesmo conteúdo e 10 execuções completas da suíte deram 123/123;
- a falha não se reproduziu;
- o nome do teste não foi capturado (o script da época só contava), então **não é possível dizer se é teste novo ou antigo**. Fica registrado como risco.
- Candidatos por serem sensíveis a tempo sob carga (outras trilhas rodando):
  - duas réplicas "sem disputa real";
  - os testes com lease de 1 s.
