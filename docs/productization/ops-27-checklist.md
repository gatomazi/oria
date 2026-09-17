# OPS-27 — checklist para o usuário (sem expor segredo)

> ## ✅ RESOLVIDO em 17/09/2026 (rodada 21)
>
> O `META_APP_SECRET` foi recuperado no Meta Developers, no **mesmo App** a que pertence o
> `META_APP_ID` do serviço Go, e atualizado no ambiente real. O fluxo real de mensagens voltou a
> funcionar e a validação HMAC (`X-Hub-Signature-256`) **permaneceu obrigatória o tempo todo**.
> Evidência, sem valores: [`ops-evidence/OPS-27.json`](ops-evidence/OPS-27.json).
>
> **O checklist abaixo continua valendo como procedimento de referência** — para qualquer ambiente
> novo (o projeto Railway `Oria` do runbook §20 inclusive), para uma troca futura do App Secret ou
> para um novo incidente de assinatura. Cada ambiente precisa de evidência própria.

Rodada 19. Este checklist é o primeiro gate de qualquer rollout da productização
(`production-rollout-runbook.md` §5.1). Ele prova, no ambiente real, que o serviço Go valida webhooks
da Meta com o segredo certo, **sem** desligar a verificação de assinatura.

> **Regra de ouro:** nunca cole App Secret, token, API key ou URL com credencial no chat, em arquivo
> ou em print. Para o segredo, responda só **MATCH** ou **NO MATCH**.

## O que me responder

Copie, preencha e mande:

```text
1. META_APP_ID do Go termina em: ____ (4 últimos dígitos)
2. App do Meta Developers com esse ID: nome do app = ________ (é o App da plataforma? sim/não)
3. App Secret do Railway (Go) = App Secret do Meta Developers: MATCH / NO MATCH
4. Webhook real: callback verificado? sim/não · campo "messages" assinado? sim/não
5. Mensagem real enviada ao número em ___:___ → log do Go: recebido / 403 invalid signature / nada chegou
6. Botão "Test" do webhook no Meta Developers → log do Go: recebido / 403 / nada chegou
7. Boot do Go (log): sig_verify=true? sim/não · env=production? sim/não
8. WABA inscrita (subscribed_apps) inclui este App? sim/não · WABA ID termina em: ____
9. Número em uso termina em: ____ · token do Go é System User permanente / temporário / não sei
```

## Passo a passo

### 1–2. App ID

1. **Railway** → serviço do `whatsapp-webhook-go` → *Variables* → `META_APP_ID`. Anote só os 4 últimos dígitos.
2. **Meta Developers** (developers.facebook.com) → *My Apps* → abra o app cujo **App ID** termina com
   os mesmos 4 dígitos (*App settings › Basic*). Anote o nome do app.

### 3. App Secret — comparação sem expor

Na mesma tela *App settings › Basic*, clique em **Show** no *App Secret* (a Meta pede sua senha).
No Railway, revele `META_APP_SECRET`. **Compare os dois na sua tela**, caractere por caractere ou pelo
começo e fim. Responda só MATCH / NO MATCH. Feche as duas telas depois.

Se preferir comparar sem olhar o valor inteiro, calcule localmente uma impressão nos dois lados e
compare você mesmo (não me mande a impressão):

```sh
# cole o valor quando o prompt pedir; ele não aparece na tela nem fica no histórico
read -rs S && printf %s "$S" | shasum -a 256 | cut -c1-12; unset S
```

### 4. Webhook configurado

Meta Developers → app → *WhatsApp › Configuration* (ou *Webhooks*):
- *Callback URL* aponta para o serviço Go (rota do webhook) e aparece como verificado;
- o campo **messages** está assinado.

### 5–6. Evento real passando no HMAC

1. Abra os logs do Go no Railway.
2. Envie uma mensagem de WhatsApp de um celular qualquer para o número da operação e anote o horário.
3. No log, procure o evento nesse horário: **recebido/processado** = OK; **403 / invalid signature** = o
   segredo não bate (NO MATCH na prática); **nada** = callback/assinatura do campo errados.
4. Opcional: no Meta Developers, botão **Test** ao lado do campo `messages` — ele manda um webhook
   assinado com o App Secret do app.

**Não** desligue a verificação de assinatura, não troque o segredo "para testar" e não reinicie o
serviço com outra configuração. Se der 403, pare e me avise: isso é o incidente do OPS-27.

### 7. Boot

No log de inicialização do Go há uma linha `WhatsApp service :<porta> env=... sig_verify=...`.
Confirme `sig_verify=true` e `env=production`.

### 8–9. WABA, número e token

- *WhatsApp › API Setup* (ou Business Manager › Contas do WhatsApp): WABA ID e número em uso (só os 4 finais).
- Business Manager → *Usuários do sistema*: o token usado pelo Go é de um System User (permanente)?
- A inscrição do app na WABA (`subscribed_apps`) aparece em *WhatsApp › Configuration*; se não souber
  confirmar, responda "não sei" que eu preparo a consulta segura.

## Depois

Com tudo OK (3 = MATCH, 5 = recebido, 7 = sim), registro `docs/productization/ops-evidence/OPS-27.json`
(formato do runbook §2, sem valores) e o OPS-10 como absorvido. A bateria 5a do runbook §5.1 (chamadas
sem/com assinatura e API key) roda junto, com a sua autorização explícita para chamar o serviço de produção.

Qualquer NO MATCH, 403 ou "nada chegou" mantém o rollout **NO-GO**.

**Feito em 17/09/2026** para o ambiente atual: o `OPS-27.json` está registrado. Falta ainda o
`OPS-10.json` — **registrado em 17/09/2026** como `NOT_APPLICABLE` / SUPERSEDED (PD-023 encerrou a dúvida arquitetural; o OPS-27 comprovou a parte operacional).
