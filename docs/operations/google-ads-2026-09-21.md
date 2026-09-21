# Google Ads — fim do developer token (2026-09-21)

## O que mudou no Google
Em **09/09/2026** o Google descontinuou os developer tokens da Google Ads API. Desde então:

- o **nível de acesso** da API (Test/Basic/Standard) é do **projeto do Google Cloud que é dono das credenciais OAuth**
  usadas nas chamadas, não de um token;
- o cabeçalho `developer-token` continua aceito, mas é **opcional e ignorado** pelos servidores (o Google avisou que
  será rejeitado em uma versão maior futura da API);
- o cadastro de acesso passa a ser feito no Google Cloud Console, sem exigir conta gerente.

Fontes: documentação "Developer token" da Google Ads API e o Google Ads Developer Blog (2026).

## Decisão no Oria
Nosso gate anterior — `GOOGLE_ADS_DEVELOPER_TOKEN` ausente ⇒ "Indisponível na plataforma" — estava obsoleto e
bloqueava a integração por um requisito que não existe mais. Agora:

- **Readiness da plataforma = OAuth do Google configurado** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `GOOGLE_OAUTH_REDIRECT_URI`). `GOOGLE_ADS_DEVELOPER_TOKEN` nunca é requisito.
- O painel **não envia mais** `developer-token`. O cliente (`lib/google-ads/client.js`) ainda aceita o parâmetro
  opcional por compatibilidade, e a máscara de log dele continua ativa.
- A resposta ao tenant nunca cita nome de variável de ambiente ("a conexão com o Google ainda não está habilitada na
  plataforma").
- Se faltar outra coisa real (acesso da API ao projeto do Cloud, API não habilitada), o blocker aparece como a resposta
  factual do Google, classificada — não como "plataforma indisponível" genérica.

## Auditoria dos consumidores
| Onde | Antes | Agora |
|---|---|---|
| `server.js` `googleAdsOAuthConfigurado()` | `OAuth && DEVELOPER_TOKEN` | `OAuth` |
| `server.js` `googleAdsClient()` | repassava `GOOGLE_ADS_DEVELOPER_TOKEN` | não repassa |
| `lib/google-ads/client.js` | envia o cabeçalho só se recebido | igual (opcional) |
| read model / status / jobs | dependiam do gate acima | derivam do OAuth |
| `infra/railway/env-manifest.md` | listava a variável | removida; nota da mudança |
| testes | exigiam o gate | provam o contrário; negative control `INTEG-06` invertido |

## OAuth e projeto do Google Cloud
- O Google Ads usa o **mesmo cliente OAuth** do GA4 (`GOOGLE_CLIENT_ID`). O número do projeto está no prefixo do
  client id (`933759624535-…`). **Confirmar no Cloud Console** que esse projeto é o do Oria e que a **Google Ads API está
  habilitada** e com nível de acesso concedido — é ele que agora determina o que a integração pode fazer.
- Escopo pedido: `adwords` (o Google não oferece escopo só de leitura; o Oria só lê).
- `login-customer-id` continua independente do developer token: só é enviado quando a conexão opera por conta
  gerente/MCC (`google_ads_connections.login_customer_id`, ou `GOOGLE_ADS_LOGIN_CUSTOMER_ID` como padrão).
- Fluxo: `oauth/start` → Google → callback compartilhado com o GA4 (state de uso único) → contas acessíveis →
  seleção do Customer (`store_id`) → sync → Dashboard/Financeiro.
