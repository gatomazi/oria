# Configuração do Google Cloud — OAuth pra GA4

> Pré-requisito da Fase 2 de `docs/claude-utm-tracker-ga4.md` (integração Google Analytics 4).
> Tudo aqui é feito manualmente pelo dono do projeto na Google Cloud Console — não é algo que o
> Claude Code executa (exige conta Google, consentimento, credenciais).

## 1. Criar o projeto

[console.cloud.google.com](https://console.cloud.google.com) → seletor de projeto → **Novo projeto**.
Nome sugerido: `Orgulho Regional — Painel`. Sem organização/Workspace (conta pessoal).

## 2. Ativar as APIs

**APIs e serviços → Biblioteca** — ativar:
- Google Analytics Admin API
- Google Analytics Data API

## 3. Tela de consentimento OAuth

**APIs e serviços → Tela de consentimento OAuth**:
- Tipo de usuário: **Externo**
- Nome do app: `Orgulho Regional — Painel`
- E-mail de suporte / contato do desenvolvedor: e-mail do dono
- Escopo: `https://www.googleapis.com/auth/analytics.readonly` (só leitura)
- Usuários de teste: o(s) e-mail(s) Google com acesso às propriedades GA4 das lojas
- Publicação: fica em **Teste** — não precisa verificação do Google pra esse uso (app interno,
  poucos usuários de teste, escopo sensível mas não restrito). Política de privacidade/domínio só
  viram obrigatórios se um dia o app for publicado pro público.

## 4. Credencial OAuth

**APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
- Tipo de aplicativo: **Aplicativo da Web**
- Origens JavaScript autorizadas: nenhuma (fluxo é server-side, não client-side)
- URI de redirecionamento autorizado:
  ```
  https://orgulhoregional.com.br/api/admin/integrations/google-analytics/callback
  ```
  Opcional, pra testar local: `http://localhost:8091/api/admin/integrations/google-analytics/callback`

Copiar **Client ID** e **Client secret** gerados.

## 5. Variáveis de ambiente (Railway)

```
GOOGLE_CLIENT_ID=<client id>
GOOGLE_CLIENT_SECRET=<client secret>
GOOGLE_OAUTH_REDIRECT_URI=https://orgulhoregional.com.br/api/admin/integrations/google-analytics/callback
```

Nunca colar esses valores em chat/log — só direto no Railway.

## Depois de configurado

Avisar que os 3 env vars estão no Railway. A partir daí a Fase 2 (`docs/claude-utm-tracker-ga4.md`
§7-12) implementa: `GET/POST /api/admin/integrations/google-analytics/connect|callback|properties|
property|disconnect`, persistência do refresh token **criptografado** (nunca em texto plano — ao
contrário dos tokens da Reserva Ink hoje, que são env var em texto plano; pendência conhecida,
registrada na memória do projeto — o GA4 não deve repetir isso), e o card em Integrações.
