# Contrato de remetente painel → whatsapp-webhook-go (Fase 5b)

Rodada 16 · 16/09/2026 · contrato **v1** · fixture versionada nos dois repositórios:

- painel: `test/fixtures/whatsapp/sender-contract-v1.json`
- serviço Go: `testdata/sender-contract-v1.json`

As duas cópias são idênticas, e o teste do painel falha se divergirem.

## 1. O que mudou

| antes | depois |
|---|---|
| O serviço Go tinha **um** número e **um** token (`META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_WABA_ID`). | O serviço não tem número nem token. Cada chamada traz o remetente da Organization. |
| O painel perguntava ao `/health` do Go qual era o número. | O painel resolve o número pela integração `whatsapp` da Organization. O `/health` só responde `{"status":"ok"}`. |
| Fila e retry do Go saíam pelo número do ambiente. | Fila e retry guardam uma referência assinada e pedem o token ao painel na hora de enviar. |

## 2. Onde mora o remetente (painel)

```text
sessão → Organization → integrations(provider='whatsapp')
                         ├─ config.phone_number_id
                         ├─ config.waba_id
                         └─ integration_secrets(tipo='access_token')   (cifrado)
```

- **`lib/platform/whatsapp-sender.js`** — `comRemetente(usar)`:
  - lê token e config **na mesma leitura, da mesma linha**;
  - confere a posse do número (`external_resource_claims`, PD-016);
  - monta um objeto congelado cujo token não é enumerável.
- **Cadastro:** `GET/PUT/DELETE /api/admin/whatsapp/remetente`.
  - Só owner grava ou remove.
  - Trocar de número exige o token do número novo.
  - O número de outra Organization é recusado (409).
- **Tela:** Integrações › Número do WhatsApp.
- **Import do valor atual do Go:** `npm run integrations:import-whatsapp-sender -- --organization <uuid> [--aplicar]` (OPS-29).

## 3. Chamada painel → Go

| item | valor |
|---|---|
| autenticação do serviço | `X-Api-Key: <WHATSAPP_API_KEY>` — **independente** do remetente |
| remetente | `X-Sender-Phone-Number-Id` · `X-Sender-Waba-Id` · `X-Sender-Access-Token` · `X-Sender-Ref` |
| corpo | JSON, os schemas de sempre (`to`, `template`, `components`…) |
| campos **proibidos** no corpo | `access_token`, `organization_id`, `phone_number_id`, `sender`, `sender_ref`, `waba_id` → **400** |
| query string | nunca carrega segredo |

Formatos:

| campo | formato |
|---|---|
| número e WABA | `^[0-9]{5,32}$` |
| token | `^[A-Za-z0-9._\|~+/=-]+$`, com 16 a 4096 caracteres |
| referência | `^v1\.<payload base64url>\.<hmac 43>$` |

Header repetido é recusado.

| rota do Go | remetente |
|---|---|
| `POST /send/{text,template,media,buttons,list,reaction,read}`, `GET /media/{id}`, `POST /media/upload`, `POST /queue/add` | obrigatório (número, token, referência) |
| `GET /templates/list`, `POST /templates/create`, `DELETE /templates/delete` | obrigatório **com WABA** |
| `GET /health`, `GET /dashboard/events` | nenhum |

Erros:

| situação | resposta |
|---|---|
| sem `X-Api-Key` ou chave errada | **401**, antes de olhar o remetente |
| remetente ausente, parcial ou malformado | **400**, sem chamar a Meta |
| falha da Meta | **502** com o token redigido (`***`) |

**Dedupe da fila:** a chave inclui o número remetente. O mesmo template para o mesmo cliente, saindo de outra Organization, não é duplicata.

No painel, Organization sem número cadastrado **não chama o Go**: recebe 409 `WHATSAPP_SENDER_NOT_CONFIGURED`.

## 4. Referência assinada e resolução (fila, retry, respostas automáticas)

A referência é `v1.<payload>.<assinatura>`:

- **payload** = `{v:1, o:<organization>, i:<integração>, p:<número>}`;
- **assinatura** = HMAC-SHA256 com `WHATSAPP_SENDER_REF_SECRET`, segredo que só o painel conhece.

**O que o Go persiste** em `queue_items`: `sender_phone_number_id`, `sender_ref` e `source_wamid` (WG-29). **Nunca o token.**

Na hora de despachar, o Go chama o painel:

```text
POST {PANEL_SENDER_RESOLVER_URL}          (= https://<painel>/api/internal/whatsapp/sender)
X-Api-Key: {PANEL_SENDER_RESOLVER_KEY}    (= WHATSAPP_SENDER_RESOLVER_KEY do painel)
{"ref": "<X-Sender-Ref>"}

200 {"phone_number_id","waba_id","access_token"}   Cache-Control: no-store
```

O painel responde com erro, e o item falha, nos casos abaixo:

| status | quando |
|---|---|
| 401 | chave errada |
| 400 | referência sem assinatura válida |
| 403 | plano sem WhatsApp |
| 409 | integração trocou de número, desconectou ou está incompleta |

Duas conferências extras:

- **no Go:** o número resolvido precisa ser igual ao gravado no item;
- **no painel:** a resposta sai por `res.end`, a única exceção documentada ao secret-guard.

**Respostas automáticas** (auto-resposta e aviso ao atendimento):

- saem pelo **número que recebeu** a mensagem, usando a última referência que o painel mandou para aquele número desde o boot;
- número desconhecido não responde;
- isto **não** é roteamento de entrada por Organization — esse fica para a Fase 5c.

> **Fase 5c (rodada 17):** substituído. A resposta automática agora resolve a Organization pelo contexto do evento (`inbound-context`), funciona já no primeiro evento depois de um restart e usa a mensagem/aviso configurados na Organization. Ver `whatsapp-inbound-5c.md`.

**Revogação:** rotacionar `WHATSAPP_SENDER_REF_SECRET` invalida todas as referências guardadas. Os itens pendentes da fila passam a falhar e precisam ser enfileirados de novo.

## 5. Variáveis

| onde | variável | papel |
|---|---|---|
| painel | `WHATSAPP_SENDER_REF_SECRET` (≥ 32) | assina referências; obrigatório em produção com `WHATSAPP_SERVICE_URL` |
| painel | `WHATSAPP_SENDER_RESOLVER_KEY` (≥ 32) | chave que o Go apresenta no resolver; idem |
| Go | `PANEL_SENDER_RESOLVER_URL` (https em produção) | URL do resolver; obrigatório em produção |
| Go | `PANEL_SENDER_RESOLVER_KEY` | = `WHATSAPP_SENDER_RESOLVER_KEY`; obrigatório em produção |
| Go | `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_WABA_ID` | **não são mais lidas** no caminho de envio. `META_PHONE_NUMBER_ID` ainda aparece no `/health` só no checkpoint G3 e sai na G4. Removidas do Railway na Release D. |

## 6. Rollout (documentado; nada foi publicado)

Ver §7 (mapa de commits) e o plano, Fase 5b.

**Release A — Go aditivo** (commits G1+G2)

1. Deploy do Go que aceita `X-Sender-*` e grava a referência na fila. Sem headers, ainda usa o ambiente.
2. Pré-requisitos: **OPS-27 VERIFIED**; `PANEL_SENDER_RESOLVER_*` configurados (a fila só usa a referência quando ela vem).

**Release B — painel aditivo** (commits P1+P2)

3. Configurar `WHATSAPP_SENDER_REF_SECRET` e `WHATSAPP_SENDER_RESOLVER_KEY`.
4. Rodar OPS-29 (import do remetente atual para a Organization interna).
5. Deploy. Organizations com número mandam headers; as sem número ainda vão sem headers, e o Go A usa o ambiente.
6. **Observar** um ciclo real completo:
   - automação;
   - campanha;
   - fila manual pelo dashboard (resolver);
   - retry de `failed`;
   - auto-resposta.

   Todos com remetente explícito, e o resolver respondendo 200.

**Release C — cutover** (commits G3, G4, P3 e os de teste/doc, **juntos**)

7. Esvaziar a fila de itens antigos, sem referência: eles falham depois do cutover.
8. Deploy do Go G4. Ele exige o remetente, não tem fallback e o `/health` fica sem número.
9. Deploy do painel P3. Ele falha fechado sem número e não lê o `/health`.

**Release D — limpeza**

10. Remover `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` e `META_WABA_ID` do Railway do Go. Enquanto a Release C puder voltar, elas ficam.

## 7. Mapa de commits → checkpoints

| checkpoint | repo | commit | conteúdo |
|---|---|---|---|
| G1 | Go | `40f4c35` | aceita `X-Sender-*` (sem headers → ambiente) |
| G2 | Go | `8c3fe50` | fila/retry com referência; resolver do painel |
| P1 | painel | `386457d` | integração `whatsapp`, resolver interno, tela, import |
| P2 | painel | `31a7cdb` | envia `X-Sender-*` (sem número → sem headers) |
| G3 | Go | `55647c0` | exige remetente; sem ambiente; respostas automáticas pelo número que recebeu |
| P3 | painel | `3adad08` | falha fechado; não lê `/health` |
| G4 | Go | `31b4bc9` | `/health` só com `status` |
| — | Go | `7b82c2b` · `eed85e9` · `1d9b821` | testes de isolamento A/B, teste de contrato (`newMux`), docs |

## 8. Rollback

**Passos aditivos** (A, B): rollback independente. Voltar o Go para antes de G1 com o painel P2 no ar quebra, porque o Go antigo ignora os headers e envia pelo ambiente. É aceitável só se o ambiente ainda tem o número. Por isso as variáveis antigas ficam até a Release D.

**Cutover** (C): rollback **conjunto e na ordem inversa**:

1. painel P3 → P2;
2. Go G4/G3 → G2.

Nunca voltar só o painel para antes de P2 com o Go em G3: o Go exigiria headers que o painel não manda, e todo envio daria 400. Nunca voltar só o Go para antes de G2 com itens novos na fila: as colunas extras são ignoradas e o item sai pelo ambiente.

A migração das colunas da fila é aditiva (`ADD COLUMN IF NOT EXISTS`) e não precisa de down.

## 9. OPS

| id | ação | bloqueia |
|---|---|---|
| **OPS-27** | validar que `META_APP_SECRET` do Go pertence **exatamente** ao `META_APP_ID` do Go e que um webhook real da Meta passa no HMAC (200/received). Repetir a bateria 5a: sem assinatura → 403; assinatura inválida → 403; sem `API_KEY` → 401; `API_KEY` errada → 401; correta → 200; `?key=<válida>` → 401. | **qualquer deploy da 5b** |
| **OPS-28** | gerar e configurar `WHATSAPP_SENDER_REF_SECRET`, `WHATSAPP_SENDER_RESOLVER_KEY` (painel) e `PANEL_SENDER_RESOLVER_URL`, `PANEL_SENDER_RESOLVER_KEY` (Go); a URL do resolver precisa ser alcançável pelo Go (https) | Release A/B |
| **OPS-29** | `npm run integrations:import-whatsapp-sender -- --organization <uuid da Organization interna> --aplicar`, com `WHATSAPP_LEGACY_*` iguais aos `META_*` do Go | Release B |
| **OPS-30** | esvaziar a fila do Go (itens sem referência) antes do cutover; repetir OPS-26 com `whatsapp` | Release C |
