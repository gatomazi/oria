# WhatsApp · onboarding por Embedded Signup (2026-09-20)

O Oria é uma plataforma nova e independente. O WhatsApp dele é configurado do zero, com **dois apps da
Meta** e nenhuma credencial do projeto legado da Use Sul.

```text
Meta App "Oria Ads"       → Meta Ads          (Facebook Login clássico, ads_read)
Meta App "Oria WhatsApp"  → WhatsApp Business Platform: Embedded Signup + webhooks
```

## 1. Arquitetura

```text
Tenant Panel (navegador)
  Integrações → WhatsApp → "Conectar com a Meta"
    1. GET  /api/admin/whatsapp/embedded-signup/config   → { appId, configId, apiVersion, state }
    2. FB.login({ config_id, response_type: 'code', extras: { setup: {} } })   [SDK da Meta]
    3. Meta → window.postMessage WA_EMBEDDED_SIGNUP { waba_id, phone_number_id, business_id }
       + callback do FB.login com o `code` (30 s)
    4. POST /api/admin/whatsapp/embedded-signup/complete { state, code, wabaId, phoneNumberId, businessId }

oria-panel (complete)
    consome o state (uso único; mesma pessoa + Organization + Store)
    troca o code pelo token do cliente          (META_APP_ID + META_APP_SECRET)
    debug_token → token do NOSSO app, WABA concedida ao token   ← prova; o corpo do navegador não vale
    GET {waba}/phone_numbers → o número pertence à WABA
    reivindica WABA e número (PD-016: uma Organization dona)
    POST {waba}/subscribed_apps ; POST {phone}/register (PIN de 6 dígitos gerado no servidor)
    grava config + token cifrado + PIN cifrado; libera o que reivindicou se algo falhar

Meta ──webhook──▶ oria-whatsapp (/webhook)
    verifica X-Hub-Signature-256 (META_APP_SECRET)          ← assinatura
    pergunta ao painel: POST /api/internal/whatsapp/inbound-context { waba_id, phone_number_id }
    painel: WABA + número → Organization (claims; divergente = 409; desconhecido = 404)
    devolve { organization_id, store_id, business_id, integration_id, waba_id, phone_number_id, sender_ref, reply }
    idempotência: chave (organization, message:<id> | status:<id>:<status>) no Go
```

Identidade canônica de uma conexão: `organization_id + store_id + business_id + waba_id + phone_number_id`.
Sem `loja_legada`. `store_id` vem do contexto da sessão, nunca do navegador (a porta global do painel recusa
`storeId`/`organizationId` no corpo). Recurso externo: `external_resource_claims` (`whatsapp/waba`,
`whatsapp/phone_number`).

## 2. Estado encontrado (auditoria)

| Peça | Antes desta rodada |
|---|---|
| `oria-whatsapp` (Go) | Multi-tenant desde a Fase 5c: um app da Meta da plataforma, tenant resolvido pelo painel por (WABA, número). HMAC do webhook obrigatório em produção; fila/inbox por Organization; idempotência por evento. Só processa o campo `messages`; os demais campos chegam, são roteados e ignorados. |
| Cadastro de número | Manual: o owner colava ID do número, WABA e token de usuário do sistema (`PUT /api/admin/whatsapp/remetente`). Token cifrado em `integration_secrets`; posse por claims. |
| Embedded Signup | **Não existia** (nenhum `FB.login`, `config_id` ou troca de `code`). |
| Identidade por Store | A integração é por Organization; `store_id`/`business_id` não eram gravados nem enviados ao Go. |
| Envs | `META_APP_ID`/`META_APP_SECRET` serviam ao Go **e** ao OAuth de Ads no painel — um app só. |
| Templates | Já por WABA/token do tenant (`/api/admin/whatsapp-templates`). Status vem da Meta na consulta; o Go não trata `message_template_status_update`. |

## 3. O que foi implementado

- `lib/whatsapp/embedded-signup.js`: troca do `code`, `debug_token`, lista de números, assinatura de webhooks,
  registro do número. Erros só com código; token nunca em URL/log/erro.
- Rotas `GET …/embedded-signup/config` e `POST …/embedded-signup/complete` (só owner). Nada gravado se a prova
  falhar; se algo falhar depois de reivindicar, os recursos novos são devolvidos.
- Migration `0028-oauth-state-whatsapp`: provider `whatsapp` no state (não reaproveita o de Ads).
- Contexto para o Go ganhou `store_id` e `business_id` (contrato v1, campos opcionais; nos dois repositórios).
- Envs de Ads renomeadas para `META_ADS_*` (o app de Ads deixa de ser o do WhatsApp).
- UI: "Conectar com a Meta" (SDK carregado só se a plataforma estiver habilitada); resumo da conexão (nome
  verificado, número, WABA, business, webhook, registro); cadastro manual fica em "avançado".
- Testes: `whatsapp-embedded-signup.test.js` (20), `whatsapp-es-mensagem.test.js` (10) e 7 negative controls
  `WAES-01…07` (WABA confiada ao navegador, token de outro app, state não amarrado, sem posse do recurso,
  claim órfão, contexto sem `store_id`, origem da mensagem frouxa).

## 4. Lacunas (não implementadas — dependem de decisão ou de configuração manual)

1. **Meta App "Oria WhatsApp"** não existe/configurado: ver §6. Sem `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` o botão fica "indisponível".
2. **Webhook `account_update`** e demais campos: o Go só age em `messages`. `account_update` é pré-requisito
   do Embedded Signup (a Meta o dispara ao concluir); hoje seria ack e descartado. `message_template_status_update`,
   `phone_number_quality_update` e `phone_number_name_update` também não têm efeito (tela consulta a Meta ao abrir).
3. **Validade do token do cliente:** o `expires_in` é gravado quando a Meta o devolve; não há renovação
   automática. Se a configuração do Embedded Signup usar token de 60 dias, a conexão vira "vencida" e exige
   reconectar. Preferir, no Meta for Developers, a variação sem expiração, se disponível para o app.
4. **Persistência de `store_id` no Go** (fila/inbox usam `loja` textual legada): o Go recebe o `store_id` no
   contexto, mas ainda não o grava nas tabelas dele.
5. **Desconexão remota:** desconectar remove tudo no Oria; não chama `DELETE subscribed_apps` na Meta.
6. **Uma conexão por Organization** (integração singleton). Duas Stores com números diferentes na mesma
   Organization exigem tornar a integração por Store — decisão de produto pendente.
7. **Defaults de versão:** o Go usa `v21.0` se `META_API_VERSION` faltar; definir `v25.0` explicitamente nos dois.

## 5. Billing — decisão separada da implementação

Não foi implementado nada de compartilhamento de linha de crédito, e o Oria **não** assume pagar mensagens dos
clientes. Opções, conforme a documentação atual da Meta (Embedded Signup / Tech Provider):

| | A · Tech Provider (cliente paga a Meta) | B · Solution Partner (linha de crédito do Oria) |
|---|---|---|
| Quem paga a Meta | O cliente, com cartão adicionado na conta do WhatsApp Business dele antes de enviar | O Oria, que compartilha a linha de crédito com o cliente no onboarding (Credit Allocation API) |
| Exigências | App com Advanced Access (`whatsapp_business_messaging`, `whatsapp_business_management`), business verificado | Ser Solution Partner: linha de crédito já existente, aceite dos termos da Credit Allocation API, relação com a Meta |
| Risco financeiro do Oria | Nenhum sobre mensagens | Assume o custo e a inadimplência; precisa reprecificar e faturar o cliente |
| Implementação no Oria | Já coberta (sem código de billing) | Chamadas de alocação e conciliação de uso — não iniciadas |

Recomendação para a V1: **A**. É o único modelo que não coloca o Oria como financiador, e o produto já diz ao
cliente que o pagamento das mensagens é direto à Meta. B fica como evolução comercial, a decidir com a Meta
(elegibilidade, faturamento e tributação no Brasil). Pontos a confirmar com a Meta: preço por mensagem/categoria
vigente e se o fluxo do Embedded Signup já coleta o meio de pagamento.

## 6. Meta for Developers — o que criar

**App "Oria WhatsApp"** (tipo Business), com o caso de uso WhatsApp, business portfolio conectado e verificado.

| Item | Valor |
|---|---|
| Produtos | WhatsApp; Facebook Login for Business |
| Embedded Signup | Versão 4 (a v2 sai em out/2026 — datas divergentes na documentação: 8 e 15/10). Criar a configuração no Login for Business com a variação **WhatsApp Embedded Signup**; copiar o **Configuration ID** → `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` |
| Permissões | `whatsapp_business_management`, `whatsapp_business_messaging` — **Advanced Access** via App Review (vídeos: enviar/receber mensagem e criar template) |
| Allowed Domains for the JavaScript SDK | `https://oria-panel-production.up.railway.app` |
| Valid OAuth Redirect URIs | `https://oria-panel-production.up.railway.app/` e `https://oria-panel-production.up.railway.app/admin/integracoes` |
| Webhook · Callback URL | `https://<domínio público do oria-whatsapp>/webhook` (copiar de Railway → oria-whatsapp → Networking) |
| Webhook · Verify token | o valor de `META_VERIFY_TOKEN` (inventado por nós; igual nos dois lados) |
| Webhook · campos | `messages` (hoje) + `account_update` (pré-requisito do Embedded Signup); `message_template_status_update`, `phone_number_quality_update` recomendados |
| Privacy Policy URL | obrigatória para modo Live/App Review; o painel **não serve** essa página hoje |
| Data Deletion | URL de instruções (ou callback); não existe callback no código |
| App Domains | host da página de privacidade (não exigido pelo código) |
| Modo | desenvolvimento até o App Review; em desenvolvimento só quem tem função no app conecta |

O **App "Oria Ads"** é outro app (Facebook Login clássico; produto Marketing API; permissão `ads_read`;
Valid OAuth Redirect URI `https://oria-panel-production.up.railway.app/api/admin/integrations/meta/callback`).

## 7. Railway — variáveis

| Variável | `oria-panel` | `oria-whatsapp` | Observação |
|---|---|---|---|
| `META_APP_ID` | sim | sim | App **Oria WhatsApp**; mesmo valor |
| `META_APP_SECRET` | sim | sim | App **Oria WhatsApp**; referência `${{oria-whatsapp.META_APP_SECRET}}` no painel |
| `WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` | sim | — | Configuration ID do Embedded Signup |
| `META_VERIFY_TOKEN` | — | sim | igual ao cadastrado no webhook da Meta |
| `META_API_VERSION` | sim | sim | `v25.0` |
| `META_ADS_APP_ID`, `META_ADS_APP_SECRET`, `META_ADS_OAUTH_REDIRECT_URI` | sim | — | App **Oria Ads** |
| `WHATSAPP_SENDER_RESOLVER_KEY` = `PANEL_SENDER_RESOLVER_KEY`, `WHATSAPP_WEBHOOK_SECRET` = `WEBHOOK_FORWARD_SECRET`, `WHATSAPP_API_KEY` = `API_KEY` | pares já existentes | | não mudam |

Nenhum valor destas variáveis é do projeto legado da Use Sul; se `META_APP_ID`/`META_APP_SECRET`/`META_VERIFY_TOKEN`
do `oria-whatsapp` hoje vêm dele, **substituir** pelos do novo app.

## 8. Segurança e isolamento

- App ID/Secret são da plataforma; o segredo nunca vai ao navegador (o teste confere a resposta do `config`).
- Token do cliente e PIN: cifrados (`integration_secrets`, contextos próprios), só últimos 4 na tela; sem token em
  log, erro, URL ou resposta (testes conferem o log do processo e o corpo das respostas).
- Tenant A não alcança WABA/número de B: WABA/número forjados são recusados pela prova da Meta; recurso de outra
  Organization é 409; `store_id` nunca vem do navegador; state não vale para outra pessoa/Store nem para outro provider.
- Origem da mensagem do Embedded Signup: comparação exata de host (`*.facebook.com`), não `endsWith('facebook.com')`.

## 9. Passos manuais que dependem do dono

1. Criar os dois apps no Meta for Developers (§6) e o Configuration ID.
2. Preencher as variáveis (§7) e reiniciar `oria-panel` e `oria-whatsapp`.
3. Cadastrar o webhook (URL pública do `oria-whatsapp` + verify token + campos).
4. Publicar página de privacidade e instruções de exclusão de dados; submeter o App Review.
5. Fazer o primeiro "Conectar com a Meta" (login e senha da Meta são do dono — o Oria não os digita).
6. Decidir o modelo de billing (§5).
