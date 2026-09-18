# Hosts web do Oria — `oria.com.br`, `app.oria.com.br`, `admin.oria.com.br`

Decisão arquitetural da rodada de domínios
([comando](../commands/claude-ajuste-dominios-app-admin-hotpix-oria.md)). Este documento fixa a
convenção; a implementação no código vem depois da refatoração estrutural do `apps/panel`.

## 1. Convenção canônica

| host | plano | responsabilidade |
|---|---|---|
| `oria.com.br` | **Public Web** | landing, `/hotpix/{id}`, links públicos de mídia, páginas públicas futuras |
| `app.oria.com.br` | **Tenant Plane** | login do lojista, painel, onboarding, integrações, criativos, WhatsApp, financeiro |
| `admin.oria.com.br` | **Control Plane** | Oria Admin: organizations, planos, assinaturas, entitlements, platform admins, auditoria |

`oria.com.br/admin` e `oria.com.br/app` **não** são o painel do cliente. Os subdomínios são as URLs
canônicas — subdomínio separa **aplicação**, nunca tenant (§22: a Organization ativa continua vindo
da sessão server-side; o header `Host` não é autoridade de tenancy).

## 2. Topologia de deploy — uma decisão que não é óbvia

`oria.com.br` e `app.oria.com.br` apontam para o **mesmo** service Railway (`oria-panel`), que faz
roteamento por host. `admin.oria.com.br` aponta para o service separado `oria-admin`.

```text
oria.com.br ───────────┐
                       ├──► oria-panel  (Host decide: Public Web ou Tenant Plane)
app.oria.com.br ───────┘

admin.oria.com.br ────────► oria-admin  (apps/platform-admin)
```

**Por que não extrair a landing para um `oria-web` próprio.** Porque o HotPix não é estático: a
página lê o pedido no Postgres do painel (`server.js`, geração de `pedido.link_pagamento`) e os
links públicos de mídia servem arquivos do volume (`/midia/{token}/arquivo`). Um service separado
precisaria da mesma `DATABASE_URL` e do mesmo volume — duplicaria credencial e estado para servir
uma landing estática. Enquanto o conteúdo público depender do banco e do volume do painel, um
service só é a opção honesta. Se a landing virar um site de marketing independente, aí sim vale
extrair — e a fronteira já estará desenhada, porque o roteamento por host é explícito.

Consequência que precisa de teste: no host público, as rotas do Tenant Plane (SPA, `/api/admin/*`)
respondem **404**; no host do app, a landing não é servida em `/`. Os dois nunca se sobrepõem.

## 3. Sessões e cookies

`app.` e `admin.` **não compartilham sessão**. Nenhum cookie de autenticação recebe
`Domain=.oria.com.br`; todos são host-only.

| plano | cookie | atributos em produção |
|---|---|---|
| Tenant Plane | `__Host-oria_session` (ou equivalente tenant) | `Secure`, `HttpOnly`, `Path=/`, **sem** `Domain` |
| Control Plane | `__Host-oria_platform_session` (já implementado) | `Secure`, `HttpOnly`, `Path=/`, **sem** `Domain` |

O prefixo `__Host-` é o que trava isso no próprio browser: ele **recusa** o cookie se vier com
`Domain` ou sem `Secure`. O isolamento não depende de disciplina de código.

`SameSite` **não muda nesta rodada por decisão mecânica**: o valor atual foi validado contra os
callbacks OAuth reais (Meta e Google). Mudar exige provar os dois fluxos, não só rodar teste.

Efeito colateral desejado (§5): ao abrir `oria.com.br`, o browser não envia nenhum cookie de sessão
— host-only significa que a landing pública nunca vê credencial de app nem de admin.

## 4. Variáveis canônicas

| variável | valor | quem usa |
|---|---|---|
| `PUBLIC_SITE_URL` | `https://oria.com.br` | painel (links HotPix, mídia pública, canonical) |
| `APP_URL` | `https://app.oria.com.br` | painel (redirect pós-login, validação de origem, convites) |
| `PLATFORM_ADMIN_URL` | `https://admin.oria.com.br` | platform-admin (já implementado, com fail-fast em produção) |

Estado atual do código: o painel tem `SITE_BASE_URL` com **fallback `https://orgulhoregional.com.br`**
— herança do repositório reaproveitado. Isso é dívida a pagar nesta rodada: renomear para
`PUBLIC_SITE_URL`, **sem alias**, e trocar o fallback por fail-fast em produção. Um default silencioso
aponta link de pagamento para o domínio errado sem ninguém perceber.

Acesso sempre por helper central (espelhando `apps/platform-admin/lib/urls.js`), que valida: URL
bem-formada, `https` em produção, sem path inesperado, sem credencial embutida. Nada de
`process.env.APP_URL` concatenado à mão espalhado pelo código.

## 5. Origem, CORS e redirect

- **CORS:** nenhum. Tenant Plane e Control Plane são same-origin. `Access-Control-Allow-Origin: *`
  está proibido; se algum fluxo público realmente exigir cross-origin, é allowlist explícita de
  `PUBLIC_SITE_URL` em endpoints públicos nomeados.
- **CSRF/origin:** mutação do tenant só aceita origem `APP_URL`; mutação da plataforma só aceita
  `PLATFORM_ADMIN_URL`. `PUBLIC_SITE_URL` **não** é origem autorizada para nenhuma das duas — dividir
  o domínio-base não é credencial.
- **Redirect pós-login:** tenant → `APP_URL`, platform → `PLATFORM_ADMIN_URL`. `returnUrl` só aceita
  caminho local (começa com `/`, não com `//`), nunca host externo.
- **Logout:** cada plano encerra só a própria sessão. Nenhum app tenta apagar cookie do outro host —
  não conseguiria, e tentar mascararia bug.

## 6. OAuth

`GOOGLE_OAUTH_REDIRECT_URI` e `META_OAUTH_REDIRECT_URI` já são URLs absolutas em variável de
ambiente: o código não as monta. Os dois passam a apontar para `APP_URL`, e o valor precisa ser
recadastrado no console do Google e da Meta antes do cutover — **recadastro é pré-requisito de
domínio, não consequência dele**. A validação a acrescentar é barata: conferir no boot que a origem
das duas bate com `APP_URL`, para o painel não subir pedindo consentimento a um host que não é o seu.

## 7. Webhooks (não mudam de host por causa desta rodada)

| webhook | host | observação |
|---|---|---|
| Ink | ingress público do `oria-panel` | URL opaca `/api/webhooks/ink/:token` (OPS-34). Não tem ingress próprio |
| Meta/WhatsApp | ingress público do `oria-whatsapp` | host separado, já público; a Meta precisa alcançá-lo |

O repasse do Go para o painel continua indo ao domínio **público https** do painel — ver
[`infra/railway/services.md`](../../infra/railway/services.md), seção Rede.

## 8. `/admin` legado

Hoje `/admin` serve o SPA do painel. Depois do cutover, a URL canônica do tenant é
`https://app.oria.com.br/`. O `/admin` no host público **não vira** Control Plane em hipótese nenhuma:
mandaria o lojista para a tela administrativa da plataforma. Estratégia conforme §27, decidida pelo
estado real de links: sem links reais → remover; com links reais → redirect temporário para `APP_URL`.
No host do app, `/admin` pode redirecionar para `/`.

## 9. Custom domains no Railway

| service | domínio |
|---|---|
| `oria-panel` | `oria.com.br` **e** `app.oria.com.br` |
| `oria-admin` | `admin.oria.com.br` |
| `oria-creatives` | nenhum — só rede privada |
| `oria-whatsapp` | mantém o host público próprio do webhook |

DNS e emissão de certificado **não** são executados sem autorização explícita do usuário.

## 10. SEO

Landing: `canonical = https://oria.com.br`. Tenant Plane e Control Plane: `noindex`. HotPix: mantém a
política já definida na implementação existente — esta rodada não decide indexação de HotPix.
