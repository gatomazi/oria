# Fase 5c — entrada multi-tenant, jobs com lease e webhook da Ink

Rodada 17, 16/09/2026. **Implementação local, nada publicado.** A 5c depende da 5b (`whatsapp-sender-contract.md`), e todo rollout segue bloqueado por **OPS-27**.

## 1. Arquitetura V1 (PD-023 CLOSED)

```text
Meta ──(webhook, HMAC do App da plataforma)──► whatsapp-webhook-go (1 processo, N Organizations)
                                                 │ por change: WABA (entry.id) + número (metadata)
                                                 ▼
                                    painel /api/internal/whatsapp/inbound-context
                                                 │ posse exclusiva (external_resource_claims)
                                                 ▼
                              {organization_id, integration_id, número, WABA, sender_ref, reply}
                                                 │
            efeitos no escopo da Organization: evento, retry, aviso, auto-resposta, repasse
                                                 │ token só na hora de enviar
                                                 ▼
                                    painel /api/internal/whatsapp/sender (5b)
```

- **Um Meta App da plataforma.**
  - `META_APP_SECRET` e `META_VERIFY_TOKEN` são de plataforma.
  - O App é inscrito na WABA de cada cliente (`POST /{WABA}/subscribed_apps`).
- **O HMAC autentica a origem Meta, nunca o tenant.**
  - WABA desconhecida → a change é descartada sem efeito.
  - Número desconhecido → idem.
  - WABA de uma Organization com número de outra → idem.
- **Painel indisponível ou banco do Go fora → 503**, sem efeito nenhum; a Meta reentrega.
- **200 = aceito de forma durável** (rodada 18). A change fica gravada na inbox do Go antes da resposta, e um worker com lease processa os efeitos (§3.1).

## 2. Contrato painel ↔ Go (novo)

Fixture versionada nos dois repositórios: `inbound-context-v1.json`.

| endpoint | pedido | resposta |
|---|---|---|
| `POST /api/internal/whatsapp/inbound-context` | `{waba_id, phone_number_id?}` | contexto |
| `POST /api/internal/whatsapp/ref-context` | `{ref}` | contexto |

**Contexto** = `organization_id`, `integration_id`, `phone_number_id`, `waba_id`, `sender_ref`, `reply{redirect_message, notify_number}`. **Nunca o token.**

**Autenticação:** `X-Api-Key` = `WHATSAPP_SENDER_RESOLVER_KEY`, a mesma chave de serviço do resolver da 5b. O Go deriva a URL dos endpoints de `PANEL_SENDER_RESOLVER_URL`.

**Recusas:**

| situação | resposta |
|---|---|
| `organization_id` no corpo, ou campo desconhecido | 400 |
| chave de serviço errada | 401 |
| plano sem WhatsApp | 403 |
| desconhecido | 404 |
| divergente | 409 |
| acima do limite por minuto | 429 |

Nenhuma resposta de erro lista tenants.

**O que o Go faz com cada status:**

- **403, 404 e 409:** descarta a change sem efeito e guarda a recusa em cache por 15 s (até a rodada 18, 1 min).
- **Demais:** responde 503 à Meta.
- **Contexto válido:** fica em cache por 30 s (até a rodada 18, 5 min). Desconexão e troca de número valem para a entrada em no máximo 30 s por réplica; os envios são conferidos na hora pelo `/sender`.

**Rotas internas do Go com dado de tenant** (eventos, fila, problemas, automáticos):

- exigem `X-Sender-Phone-Number-Id` + `X-Sender-Ref`;
- a referência é trocada por `ref-context`;
- sem contexto → 400, recusado → 403, painel fora → 503;
- não existe "listar tudo".

**Painel de eventos:** o painel manda só número + referência (sem token, sem WABA).

### 2.1 Repasse Go → painel (rodada 18)

Contrato versionado nos dois repositórios: `forward-auth-v1.json`, com vetor de teste.

| item | valor |
|---|---|
| rota | `POST /api/webhooks/whatsapp` (corpo = changes com dono, formato da Meta) |
| URL no Go | `WEBHOOK_FORWARD_URL`, **sem** query, credencial ou fragmento |
| segredo | `WEBHOOK_FORWARD_SECRET` (Go) = `WHATSAPP_WEBHOOK_SECRET` (painel), ≥ 32 caracteres, valor **novo** |
| headers | `X-Oria-Forward-Timestamp: <unix s>` e `X-Oria-Forward-Signature: v1=<hex HMAC-SHA256(segredo, ts + "." + corpo cru)>` |
| conferência | `lib/platform/whatsapp-forward.js`, em tempo constante, janela de ±300 s |

**Respostas do painel:**

| situação | resposta |
|---|---|
| assinado e dentro da janela | 200 |
| assinatura ausente ou errada, corpo alterado, fora da janela | 401 |
| `secret` na query, mesmo com assinatura válida | 401 (200 só com a tolerância de transição, abaixo) |
| `WHATSAPP_WEBHOOK_SECRET` ausente ou curto | 503 |

- **A query nunca autentica.** Transição da rodada 19 (§2.2): com `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1`, um `secret` na query é **ignorado** (não é lido nem comparado) quando a assinatura é válida; sem assinatura válida, 401 como sempre.
- **Log do painel:** mostra só o motivo, nunca segredo ou assinatura.
- **Boot do painel:** em produção, com `WHATSAPP_SERVICE_URL` e sem o segredo, só avisa.
- **Boot do Go:** em produção, URL inválida ou sem segredo aborta.

**Repetição:** o repasse é pelo menos uma vez (o Go tenta de novo até o 2xx). Um repasse repetido dentro da janela é aceito, e isso é seguro: o status de campanha só avança e `failed` regrava os mesmos valores.

### 2.2 Transição sem perda de status (rodada 19, §5)

Detalhes, provas e texto do runbook: `round19-trilha-e.md`.

| flag (padrão: desligada) | serviço | com `1` |
|---|---|---|
| `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET` | Go | aceita a URL legada com exatamente `?secret=<valor>` e manda a query **e** a assinatura, mesmo corpo |
| `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED` | painel | ignora o `secret` da query quando a assinatura é válida |

- Só `1` liga; ausente ou `0` desliga; qualquer outro valor derruba o boot (nos dois serviços).
- O valor da query (legado) e o segredo da assinatura (novo) são **diferentes**; o Go recusa os dois iguais.
- As duas flags saem no CLEANUP (`release:preflight --stage cleanup` bloqueia ligadas).
- Contrato: bloco `legacy_query_transition` em `forward-auth-v1.json` (formato de fio e versão inalterados).

## 3. O que mudou no serviço Go

| antes | depois |
|---|---|
| auto-resposta só depois de o painel usar o número (5b) | resolve pelo contexto do evento — funciona no primeiro evento após restart |
| `REPLY_REDIRECT_MESSAGE`, `REPLY_NOTIFY_NUMBER` no ambiente | configuração da Organization (tela + import); as variáveis são ignoradas com aviso |
| eventos, fila, retry, cooldown e problemas globais | por Organization (registro por tenant; chaves com `organization_id`) |
| `problem_orders` com PK `numero` e herança de PII entre lojas | PK `(organization_id, numero)`; herança só dentro da Organization |
| `/problems/sync` com escopo do corpo (`loja`) | escopo da referência; `loja` é filtro dentro da Organization |
| `/dashboard/events` somando tudo | só a Organization do contexto |
| dedupe por wamid | `processed_webhook_events (organization_id, event_key)`, persistente |
| idioma `en` trocado por `pt_BR` | só o ausente vira `pt_BR` (WG-25) |
| schema criado no boot com `IF NOT EXISTS` | `schema_migrations` versionada, com advisory lock |
| fila despachada da memória do processo | lease no banco (CTE + `FOR UPDATE SKIP LOCKED`); lease vencido vira erro visível |
| efeitos do webhook em goroutine depois do 200 (perdidos numa queda) | rodada 18: inbox durável gravada antes do 200 + worker com lease e passos registrados (§3.1) |
| repasse com `?secret=` na URL | rodada 18: assinatura em header (§2.1) |
| `/dashboard`, `/problems`, `/automaticos` servindo HTML sem dados | rodada 18: `410` em texto puro; HTML fora do binário |

**Tabelas do Go:**

- `events`, `queue_items` e `problem_orders` ganharam `organization_id NOT NULL`;
- `queue_items` também ganhou `integration_id`, `lease_owner` e `lease_until`;
- a tabela `processed_webhook_events` é nova;
- rodada 18: a tabela `webhook_inbox` é nova (migration 3, aditiva).

### 3.1 Aceite durável (rodada 18)

```text
HMAC → contexto por change → [transação: chaves de idempotência + linha na webhook_inbox] → 200
     → worker com lease (toda réplica, a cada 2 s e logo após o aceite) → efeitos, passo a passo
```

| efeito | garantia num reprocessamento |
|---|---|
| eventos do dashboard | exatamente uma vez (mesma transação do passo) |
| retry de status `failed` | exatamente uma vez (dedupe por wamid na Organization) |
| repasse ao painel | pelo menos uma vez (marcado depois do 2xx) |
| aviso ao dono e auto-resposta | no máximo uma vez: marcados antes do envio, porque a Meta não tem chave de idempotência. Se a queda for entre a marca e o envio, não há reenvio, e o log registra `interrompido` |

- **Falha passageira** (painel fora, resolver 5xx/429, repasse recusado): nova tentativa com backoff de até 5 min.
- **Depois de 8 tentativas:** a linha vira `failed`. Fica visível com `last_error` (sem segredo) e sai em 7 dias.
- **Linha concluída:** é apagada.
- **Prova:** teste com processos filhos reais — o serviço cai logo depois do 200, ou no meio dos efeitos; o restart faz tudo uma vez; reentrega e novo restart não repetem nada.
- **Detalhes:** no Go, `docs/produtizacao-5c-inbound.md`.

**Dados antigos:** só recebem dono com `LEGACY_ORGANIZATION_ID`. Sem essa variável, e com linhas antigas no banco, a migration falha e o boot em produção aborta.

## 4. Webhook da Ink (TD-005 CLOSED)

- **URL:** `/api/webhooks/ink/<token>`, uma por integração. O token tem 256 bits; no banco fica só o SHA-256, com posse exclusiva.
- **Verificação:** o token resolve a Organization; depois a assinatura é conferida com o segredo daquela integração.
  - URL desconhecida → 404.
  - Assinatura errada → 401.
  - Nada é gravado.
- **Rota legada:** `/api/webhooks/ink` e o teste de segredo por loja do ambiente saíram.
- **Tela:** o owner gera ou rotaciona a URL (mostrada uma vez) e cadastra o segredo que a Ink mostra.

## 5. Jobs (TD-006 CLOSED)

- Lease por (job, Organization) em `job_leases`, pedido antes de cada iteração.
- Uma rodada por intervalo no cluster.
- Lease indisponível não roda e aparece no log.
- Rodízio da ordem das Organizations.
- **Campanha:** a reivindicação de destinatários virou CTE. A forma anterior podia pegar mais que o lote.

## 6. Rollout (documentado, não executado)

**Pré-condições:**

- **OPS-27** VERIFIED;
- 5b em produção até a Release C (painel manda o remetente; o Go exige);
- OPS-29 aplicado, já incluindo `WHATSAPP_LEGACY_REPLY_*`.

1. **Backup** dos dois bancos.
2. **Painel R1:**
   - pre-deploy com `migrate:up` (migrations `1790000000000`, `1790000060000`, `1790000120000`);
   - deploy.
   - Os endpoints de contexto são aditivos; os jobs passam a pedir lease.
   - **Rodada 19:** o R1 sai em **dois** deploys para o repasse não perder status: **D0** = commit do R1 anterior ao endurecimento do repasse (`c706da1^`, ex.: `8c024d2`), com o `WHATSAPP_WEBHOOK_SECRET` legado inalterado (autentica pela query, como hoje); **D'** = HEAD, só depois do Go R2 (passo 4). Ordem completa em `round19-trilha-e.md`.
3. **Ink (OPS-34), logo depois do R1:**
   - gerar a URL na tela;
   - cadastrar o segredo;
   - trocar a URL no cadastro de webhook da Reserva Ink;
   - validar um evento real (tela de log de webhooks).

   Entre o deploy e a troca, eventos da Ink na URL antiga dão 404. Os pedidos são recuperados pelos jobs de reconciliação/sincronização; carrinhos abandonados desse intervalo não disparam.
4. **Go R2:**
   - `LEGACY_ORGANIZATION_ID=<organization interna>` no ambiente;
   - fila antiga esvaziada (OPS-30);
   - rodada 19: `WEBHOOK_FORWARD_SECRET` = valor **novo** (≥ 32, diferente do legado), `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1` e `WEBHOOK_FORWARD_URL` **inalterada** (ainda com `?secret=`): o painel D0 aceita pela query e a assinatura já viaja;
   - deploy. As migrations 2 e 3 rodam no boot, com advisory lock entre réplicas.
5. **Observar:**
   - mensagem real recebida → evento no painel da Organization certa + auto-resposta;
   - status `failed` → retry na fila certa;
   - `/dashboard/events` por Organization;
   - rodada 18: `webhook_inbox` esvaziando (`SELECT status, count(*) FROM webhook_inbox GROUP BY 1`), nenhum `failed`, e nenhum `repasse recusado` no log do painel.
   - rodada 19, em sequência, cada um com observação: **D'** (painel HEAD com `WHATSAPP_WEBHOOK_SECRET` = valor novo e `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1`) → Go sem `?secret=` e sem a flag → painel sem a tolerância (CLEANUP). Em nenhum passo um status válido é recusado.
6. **Meta (novos clientes):** inscrever o App da plataforma na WABA do cliente (OPS-31) antes de cadastrar o número na tela.
7. **Limpeza:**
   - remover `INK_WEBHOOK_SECRET_*`, `REPLY_REDIRECT_*`, `REPLY_NOTIFY_NUMBER` e `LEGACY_ORGANIZATION_ID`;
   - na Release D da 5b, `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` e `META_WABA_ID`.

## 7. Rollback

**Meta:** a URL de callback do App não muda (é o mesmo serviço Go), então qualquer versão do Go continua recebendo.

**Painel R1:**

- voltar a versão da app. As migrations 0014–0016 são aditivas; a versão anterior as ignora.
- **Ink:** a versão anterior escuta só em `/api/webhooks/ink` com `INK_WEBHOOK_SECRET_*`. Voltar a URL antiga no cadastro da Reserva Ink **e** manter as variáveis no ambiente até aqui (por isso a limpeza é o último passo).
- Down das migrations, se necessário: `migrate:down` 3, que é seguro (remove funções, a tabela de leases e as posses de WABA/token).

**Go R2:**

- a versão 5b **não** grava em `queue_items`, `events` nem `problem_orders` com `organization_id NOT NULL`.
- Para voltar o código, rode antes o SQL abaixo. Ele só é seguro enquanto o banco tiver uma única Organization (produção hoje):

```sql
ALTER TABLE events         ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE queue_items    ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE problem_orders ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE problem_orders DROP CONSTRAINT problem_orders_pkey;
ALTER TABLE problem_orders ADD PRIMARY KEY (numero);   -- falha se houver o mesmo número em duas Organizations
DELETE FROM schema_migrations WHERE version = 2;
```

- **Rodada 18, antes de voltar o código:**
  - esperar `SELECT count(*) FROM webhook_inbox WHERE status <> 'failed'` = 0. A versão anterior não lê a inbox;
  - a migration 3 pode ficar.
- **Rodada 19 (repasse):** a versão anterior do Go não assina, mas manda a query legada, que o painel **D0** aceita. Voltar o Go só com o painel em D0: se D' estiver no ar, voltar antes o painel para D0 (com o `WHATSAPP_WEBHOOK_SECRET` legado no mesmo deploy). Depois do passo "Go sem query", recolocar a query e a flag no Go antes de voltar o painel. Sequência completa em `round19-trilha-e.md`.

- As colunas e a tabela de idempotência podem ficar; a versão anterior não as lê. Nada de `DROP` prematuro.

**Ordem:** rollback do Go **antes** do painel R1 (D0). O Go 5c depende dos endpoints de contexto do painel; o painel 5c funciona com o Go 5b. Entre D' e D0 a ordem se inverte (o D0 também tem os endpoints de contexto): primeiro o painel D' → D0, depois o Go.

## 8. OPS novos

| id | ação | bloqueia |
|---|---|---|
| **OPS-27** | (5b) App Secret ↔ App ID do Go + webhook real assinado. Registrar também qual `META_APP_ID`, qual WABA inscrita e qual token estão em uso (ex-OPS-10) | **qualquer rollout** |
| **OPS-31** | App da plataforma inscrito em cada WABA de cliente (`subscribed_apps`); o callback do App aponta para o Go compartilhado | onboarding de cada Organization |
| **OPS-32** | `LEGACY_ORGANIZATION_ID` no Go durante a migration 2 (backup antes); remover depois | Go R2 |
| **OPS-33** | extrator de problemas de entrega (`extrator-pedidos-web`, outro repositório): passar a mandar `X-Sender-Phone-Number-Id` + `X-Sender-Ref` da Organization em `/problems/*` (valores de `npm run integrations:whatsapp-referencia -- --organization <uuid>`); sem eles, 400 | Go R2 |
| **OPS-34** | cutover do webhook da Ink (§6 passo 3) e remoção de `INK_WEBHOOK_SECRET_*` depois | Painel R1 |
| **OPS-09** (atualizado nas rodadas 18 e 19) | `WEBHOOK_FORWARD_SECRET` (Go) = `WHATSAPP_WEBHOOK_SECRET` (painel D'), valor novo com ≥ 32 caracteres e diferente do legado; transição com as flags de §2.2; ao fim, `WEBHOOK_FORWARD_URL` sem query e as duas flags removidas | Go R2 / Painel D' / CLEANUP |
| **OPS-35** | `META_GRAPH_BASE_URL` **não** definida em produção (só teste); `REPLY_*` removidas do Go depois de OPS-29 | Go R2 |

## 9. Riscos residuais

- **Painel HTML embutido no Go** (`/dashboard`, `/problems`, `/automaticos`): desativado na rodada 18 (`410`, sem dado).
  - A revisão manual da fila (`modoEnvio: manual`) depende de uma tela no painel que ainda não existe. Isso já era verdade desde a 5a, porque a chave saiu da URL.
- **Repasse ao painel:** resolvido na rodada 18 (§2.1).
  - A janela R1→R2 (status recusados) foi eliminada na rodada 19 pela transição aditiva (§2.2). Risco que fica: operação fora da ordem (ex.: D' antes do Go R2, ou voltar D' sem restaurar o segredo legado). A ordem e o rollback estão em `round19-trilha-e.md`, e o Go R2 refaz o repasse recusado com backoff por até 8 tentativas (cerca de 4 min no total), o que dá esse prazo para corrigir sem perder o evento (o Go 5b não tenta de novo).
- **Cache de contexto:** 30 s. Uma troca ou desconexão vale para a entrada em até 30 s por réplica. Os envios continuam conferidos na hora pelo `/sender`.
- **Efeitos do webhook:** aceite durável na rodada 18 (§3.1).
  - Aviso e auto-resposta são no máximo uma vez: uma queda entre a marca e o envio perde aquele envio, com log.
  - O repasse é pelo menos uma vez.
  - O retry de status `failed` ainda depende do pedido original em memória no Go. Se houver restart entre o envio e o status, não há item de retry.
- **Cota por tenant:** fora da V1.
