# Dívida de produto — primeiro acesso do owner

**Registrada em 18/09/2026, no dia do primeiro acesso real de um tenant (Use Origens).**
**Não implementada.** Este documento existe para a decisão não se perder, não para ser executado agora.

## O que aconteceu

O owner aceitou o convite e caiu direto no dashboard, de uma organization com **zero** de tudo: sem
credencial da Ink, sem WhatsApp, sem Meta, sem GA4, sem OpenAI. O dashboard de uma operação vazia
não tem o que mostrar, e a primeira tela que o owner abriu por conta própria — Integrações —
respondeu **502** (corrigido; ver `apps/panel/test/invariants/fase4-server-integrations.test.js`,
"tenant novo").

O 502 era defeito e foi consertado. O que **não** é defeito, e sim ausência de produto: ninguém diz
ao owner o que fazer primeiro. Ele é largado num painel completo e precisa adivinhar a ordem.

## O desenho pedido (a implementar em rodada própria)

Em vez de cair direto no dashboard, o primeiro acesso passa por um onboarding guiado:

1. boas-vindas
2. dados da loja
3. conectar produção / Reserva Ink
4. WhatsApp
5. Meta / GA4 / Google Ads
6. OpenAI / Criativos
7. checklist de prontidão
8. entrar no dashboard

## O que já existe e deve ser reaproveitado

O control plane **já modela isso no banco**: `onboarding_sessions` e `onboarding_steps`, com os
passos `org_store`, `owner`, `ink`, `meta`, `google`, `ga4`, `openai_byok`, `whatsapp`,
`entitlements`, `readiness` e o requisito de cada um (`required` / `optional` / `disabled`), definido
na criação da organization. Hoje esse estado é **só leitura** no Oria Admin: ninguém o consome do
lado do lojista, e nada o avança.

Ou seja: a fonte da verdade do onboarding existe e é por organization. O que falta é a **superfície
do Tenant Plane** que lê esses passos, conduz o owner por eles e os marca como concluídos — e a
regra de quando o painel redireciona para o guia em vez do dashboard.

## Perguntas que a rodada precisa responder (não respondidas aqui)

- O guia é bloqueante ou pulável? (O `requirement` por passo sugere que "obrigatório" e "opcional"
  já são conceitos do modelo — mas quem pode pular, e o que acontece se pular.)
- Quem marca um passo como concluído: o próprio ato de configurar, ou uma confirmação explícita?
- O que o `readiness` exige para a organization ser considerada pronta.
- O que o owner vê se voltar ao guia depois de concluído.

## Relação com o que já está no ar

Nada disto bloqueia a operação atual: o owner consegue configurar tudo pelas telas existentes, na
ordem que quiser. A dívida é de **condução**, não de capacidade.
