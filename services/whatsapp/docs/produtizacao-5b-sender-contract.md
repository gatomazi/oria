# Fase 5b — remetente explícito (serviço)

Status 16/09/2026: implementado localmente, sem deploy.

A documentação completa do contrato vive no painel (`orgulhoregional`), em `docs/produtizacao-saas/whatsapp-sender-contract.md`. Ela cobre:

- o contrato;
- o rollout;
- o rollback;
- os OPS.

Este arquivo resume o lado do serviço.

## Contrato

- **Autenticação:** `X-Api-Key` (`API_KEY`), sempre, antes de tudo.
- **Remetente:** vem em `X-Sender-Phone-Number-Id`, `X-Sender-Waba-Id`, `X-Sender-Access-Token` e `X-Sender-Ref` (`identity.go`).
- **Fixture versionada:** `testdata/sender-contract-v1.json`, idêntica à do painel, validada em `contract_test.go`.

Obrigatoriedade por rota:

| rotas | remetente |
|---|---|
| `/send/*`, `/media/{id}`, `/media/upload`, `/queue/add` | obrigatório (número, token, referência) |
| `/templates/*` | obrigatório **e com WABA** |
| `/health`, `/dashboard/events` | nenhum |

Validações:

- identidade ausente, parcial, malformada ou com header repetido → **400**, sem chamar a Meta;
- campos de remetente no corpo → **400**;
- o token é redigido em erros da Meta, em erros de transporte e na formatação (`%v`).

## Sem remetente de processo

- `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` e `META_WABA_ID` não são mais lidas. O teste estático do INV-27 fica em `invariants_test.go`.
- `/health` devolve só `{"status":"ok"}` (INV-35).

## Envios que nascem aqui

- **Fila e retry:** guardam o número e a referência (`sender_phone_number_id`, `sender_ref`) e o `source_wamid`. Nunca guardam o token.
  - No despacho, o token é pedido ao painel: `POST PANEL_SENDER_RESOLVER_URL` com `PANEL_SENDER_RESOLVER_KEY` (`resolver.go`).
  - Número divergente, painel fora do ar ou item sem referência fazem o item falhar.
- **Auto-resposta e aviso ao atendimento:** saem pelo número que recebeu a mensagem, com a última referência que o painel mandou para ele. Número desconhecido não responde.
  - Isto não é roteamento de entrada por Organization; esse fica para a Fase 5c.

## Commits

| checkpoint | commit | release |
|---|---|---|
| G1 | `40f4c35` aceita `X-Sender-*` (sem headers → ambiente) | A |
| G2 | `8c3fe50` fila/retry com referência + resolver | A |
| G3 | `55647c0` exige remetente; sem ambiente | C |
| G4 | `31b4bc9` `/health` só `status` | C |
| — | `7b82c2b` testes de isolamento A/B | — |
| — | `eed85e9` teste de contrato + `newMux` | — |

**Rollback:**

- A é independente.
- C (G3+G4) volta junto com o P3 do painel, para G2 + P2.

As variáveis `META_*` ficam no Railway até a Release D.

## Bloqueio de deploy

**OPS-27:** confirmar que `META_APP_SECRET` pertence ao `META_APP_ID` deste serviço e que um webhook real da Meta passa no HMAC. Sem isso **VERIFIED**, nada da 5b vai para produção.

## Testes de banco

Rodam só com `WEBHOOK_TEST_DATABASE_URL`, apontando para um Postgres descartável:

```bash
WEBHOOK_TEST_DATABASE_URL=postgres://... go test -race ./...
```
