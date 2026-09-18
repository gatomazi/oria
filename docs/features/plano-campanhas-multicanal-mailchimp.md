# Plano de implementação — Campanhas multicanal + Mailchimp

> **Contexto:** evolução do módulo atual de Campanhas do Painel Admin, snapshot de 11/09/2026.
>
> **Objetivo principal:** transformar o motor atual de campanhas, hoje orientado ao WhatsApp, em um motor multicanal em que o mesmo segmento possa ser acionado por **WhatsApp**, **E-mail via Mailchimp** ou **ambos**, sem duplicar a lógica de segmentação e sem transformar o Mailchimp na fonte principal de clientes.
>
> **Regra de ouro:** **Segmento define QUEM. Campanha define POR ONDE. Provider define COMO enviar.**

---

## 1. Antes de implementar

Ler primeiro:

- `painel-estado-atual.md`
- implementação real de:
  - `admin/src/pages` relacionada a Campanhas/Segmentos;
  - `admin/src/api/campanhas.ts`;
  - `admin/src/api/segments.ts`;
  - rotas de campanhas e segmentos em `server.js`;
  - tabelas `segments`, `campaigns`, `campaign_recipients`;
  - `processarFilaDeCampanhas`;
  - endpoints atuais de `start`, `batches`, `pause` e `resume`;
  - integração atual de WhatsApp;
  - `/admin/integracoes`;
  - `/admin/clientes`.

**Não assumir nomes de colunas, tipos ou contratos que não forem confirmados no código.**

Este documento define a arquitetura desejada. A implementação deve preservar a compatibilidade com o que já funciona.

---

# 2. Estado atual relevante

O painel atualmente possui:

- React 18 + TypeScript + Vite em `admin/`;
- backend Express centralizado em `server.js`;
- Postgres opcional com fallback JSON;
- `/admin/clientes` como base de clientes derivada dos pedidos;
- `/admin/campanhas/segmentos` com audiências dinâmicas;
- `/admin/campanhas/nova` como builder de campanha;
- `/admin/campanhas` e `/admin/campanhas/:id`;
- fila real de campanhas;
- tabela `campaign_recipients`;
- processamento em background via `processarFilaDeCampanhas` a cada 30 segundos;
- envio de lotes liberado manualmente;
- integração WhatsApp já operacional;
- `/admin/integracoes` como central das integrações.

Os segmentos já suportam filtros como:

- dias sem comprar;
- número de pedidos;
- total gasto;
- ticket médio;
- UF;
- opt-in;
- carrinho abandonado;
- recebeu/não recebeu campanha;
- recebeu campanha nos últimos N dias.

A fila atual trabalha conceitualmente com estados como:

```text
pending -> queued -> sent
```

A nova implementação deve reaproveitar o máximo possível dessa base.

---

# 3. Escopo desta evolução

## 3.1 Deve existir

Uma campanha poderá usar:

```text
[ ] WhatsApp
[ ] E-mail
```

Com três possibilidades válidas:

```text
WhatsApp apenas
E-mail apenas
WhatsApp + E-mail
```

O mesmo segmento deverá poder ser reutilizado em qualquer uma das três opções.

---

## 3.2 Não fazer agora

Não implementar nesta fase:

- journeys complexas;
- automação "se não abriu e-mail, mandar WhatsApp";
- fallback automático entre canais;
- delays condicionais entre canais;
- SMS;
- Push;
- Twilio;
- Firebase;
- editor completo de automações tipo Customer Journey;
- sincronização completa de e-commerce com Mailchimp;
- Mailchimp Transactional;
- substituição da base de clientes do painel pelo Mailchimp;
- recriação da segmentação dentro do Mailchimp.

A arquitetura deve permitir essas evoluções futuramente, mas a V1 é:

```text
Segmento
   ↓
Campanha
   ↓
1 ou mais canais
   ↓
Entrega independente por canal
```

---

# 4. Princípios arquiteturais

## 4.1 Segmento não conhece canal

Um segmento deve continuar representando apenas:

> "Quais clientes pertencem a esta audiência?"

Exemplo:

```text
Clientes de SC
+
2 ou mais pedidos
+
60 dias sem comprar
```

Ele **não deve** armazenar algo como:

```text
channel = whatsapp
```

ou:

```text
provider = mailchimp
```

Isso criaria duplicação:

```text
Segmento clientes inativos WhatsApp
Segmento clientes inativos E-mail
```

Evitar completamente.

---

## 4.2 Campanha escolhe os canais

A campanha será responsável por dizer:

```text
Campanha: Recuperação clientes inativos
Segmento: Clientes 60d sem comprar

Canais:
- WhatsApp / Meta
- E-mail / Mailchimp
```

---

## 4.3 Provider é separado do canal

Conceitos diferentes:

```text
Canal:
- whatsapp
- email

Provider:
- meta
- mailchimp
```

Não acoplar o motor diretamente aos nomes dos fornecedores.

Modelo conceitual:

```ts
type CampaignChannelType =
  | 'whatsapp'
  | 'email';

type CampaignProviderType =
  | 'meta'
  | 'mailchimp';
```

No futuro, isso deve permitir:

```text
email -> outro provider
whatsapp -> outro provider
sms -> outro provider
```

sem reconstruir Campanhas.

---

## 4.4 Painel continua sendo a fonte de verdade

Não mover a lógica principal de CRM para o Mailchimp.

O fluxo deve continuar:

```text
Reserva Ink / pedidos
          ↓
Painel
          ↓
Base de clientes / segmentos
          ↓
Campanha
          ↓
Provider
```

E não:

```text
Reserva Ink
   ↓
Mailchimp
   ↓
Painel
```

O Mailchimp deve ser tratado como **canal/provider de e-mail e plataforma de entrega**, não como a origem canônica da segmentação.

---

# 5. Arquitetura-alvo

```text
                         ┌────────────────────┐
                         │       Ink          │
                         │ pedidos/carrinhos  │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │      Clientes      │
                         │ fonte do painel    │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │     Segmentos      │
                         │ filtros dinâmicos  │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │     Campaign       │
                         └─────────┬──────────┘
                                   │
                     ┌─────────────┴─────────────┐
                     │                           │
                     ▼                           ▼
            ┌────────────────┐          ┌────────────────┐
            │    WhatsApp    │          │     E-mail     │
            │ provider: Meta │          │ Mailchimp      │
            └───────┬────────┘          └───────┬────────┘
                    │                           │
                    ▼                           ▼
              API existente              Marketing API
```

---

# 6. Novo modelo de domínio

## 6.1 `campaigns`

Continua representando a campanha como unidade principal.

Exemplo:

```text
Campanha #381
"Clientes inativos - Setembro"
Segmento #27
```

Não criar uma campanha separada para cada canal.

---

## 6.2 `campaign_channels`

Adicionar uma entidade/tabela que represente os canais ativados naquela campanha.

Estrutura conceitual:

```text
campaign_channels
────────────────────────────────────
id
campaign_id
channel
provider
status
config_json
provider_campaign_id
created_at
updated_at
```

Possíveis valores:

```text
channel:
- whatsapp
- email

provider:
- meta
- mailchimp
```

Exemplo:

```text
campaign_id | channel   | provider
381         | whatsapp  | meta
381         | email     | mailchimp
```

### `config_json`

Usar para configuração específica de cada provider/canal, evitando dezenas de colunas nullable.

Exemplo WhatsApp:

```json
{
  "templateId": "123456",
  "templateName": "clientes_inativos",
  "language": "pt_BR",
  "mediaAssetId": 55,
  "variableMap": {
    "1": "cliente.nome"
  }
}
```

Exemplo Mailchimp:

```json
{
  "audienceId": "abc123",
  "subject": "Sentimos sua falta",
  "previewText": "Tem novidade por aqui",
  "fromName": "Use Origens",
  "replyTo": "contato@dominio.com",
  "templateId": 987
}
```

**Não armazenar API key em `config_json`.**

---

## 6.3 `campaign_recipients`

Deve continuar sendo o snapshot de:

> quem fazia parte da campanha no momento do start.

Conceito:

```text
campaign_recipients
────────────────────────────────────
id
campaign_id
customer_key / customer_id
snapshot_json
created_at
```

Um cliente deve aparecer **uma única vez por campanha**, mesmo quando recebe por dois canais.

Exemplo:

```text
campaign 381
cliente 128
```

e não:

```text
381 | 128 | whatsapp
381 | 128 | email
```

A distinção de canal pertence à nova camada `campaign_deliveries`.

---

## 6.4 `campaign_deliveries`

Criar a unidade real de entrega:

> cliente × canal.

Estrutura conceitual:

```text
campaign_deliveries
────────────────────────────────────
id
campaign_id
campaign_recipient_id
campaign_channel_id

channel
provider

status

provider_message_id
provider_member_id
provider_campaign_id

queued_at
sent_at
delivered_at
opened_at
clicked_at
failed_at

last_error
metadata_json

created_at
updated_at
```

### Estados

Criar um conjunto centralizado de estados.

Sugestão inicial:

```text
pending
ineligible
queued
processing
sent
delivered
opened
clicked
failed
skipped
cancelled
```

Nem todo provider terá todos os estados.

Por exemplo:

### WhatsApp

```text
pending
queued
sent
delivered
read
failed
```

### E-mail

```text
pending
queued
sent
delivered
opened
clicked
bounced
unsubscribed
failed
```

Não forçar equivalência perfeita.

Se o modelo atual usa status em `campaign_recipients`, migrar com cuidado.

---

# 7. Compatibilidade com campanhas existentes

Esta é uma evolução de produção. Não quebrar campanhas antigas.

Antes da migration:

1. inspecionar a definição real das tabelas;
2. inspecionar como o status atual de destinatário é usado;
3. localizar todas as queries em `server.js`;
4. localizar todo acesso de frontend a `campaign_recipients`.

Depois criar migration compatível.

## Estratégia sugerida

Para campanhas existentes:

```text
campaign_channels:
channel = whatsapp
provider = meta
```

Criar automaticamente um `campaign_channel` WhatsApp para campanhas antigas.

Se for seguro reconstruir `campaign_deliveries`:

```text
campaign_recipients existente
          ↓
campaign_deliveries whatsapp/meta
```

Mapear o status antigo para o novo.

Se não for seguro migrar histórico inteiro:

- manter leitura legada para campanhas antigas;
- nova estrutura passa a valer apenas para novas campanhas;
- adicionar versão/schema da campanha.

Preferência:

> migrar histórico se a estrutura real permitir fazer isso de forma determinística.

**Nunca apagar histórico de campanhas.**

---

# 8. Elegibilidade por canal

Esse é um dos pontos mais importantes.

O segmento pode retornar:

```text
1.842 clientes
```

Mas nem todos serão elegíveis em todos os canais.

Exemplo:

```text
Clientes no segmento             1.842

WhatsApp elegível                1.725
E-mail elegível                  1.602

WhatsApp + E-mail                1.491
Somente WhatsApp                   234
Somente E-mail                     111
Sem canal disponível                 6
```

A campanha deve mostrar isso antes do envio.

---

## 8.1 WhatsApp elegível

Reaproveitar as regras existentes.

No mínimo:

- telefone disponível;
- telefone normalizado/válido;
- opt-in conforme regra atual do sistema;
- não bloqueado/excluído;
- demais exclusões atuais da campanha.

Não mudar silenciosamente as regras existentes.

---

## 8.2 E-mail elegível

No mínimo:

- e-mail presente;
- e-mail sintaticamente válido;
- consentimento de marketing por e-mail válido;
- não opt-out;
- não `unsubscribed`;
- não `cleaned`/bounce permanente no Mailchimp;
- audience configurada para a loja/campanha.

### ATENÇÃO

**Ter e-mail no pedido não significa automaticamente ter opt-in de marketing por e-mail.**

Não marcar contatos importados de pedidos como `subscribed` automaticamente se o painel não possuir evidência de consentimento.

A implementação deve distinguir:

```text
subscribed
unsubscribed
pending
transactional
unknown
```

ou uma representação interna equivalente.

Nunca ressuscitar automaticamente um contato que o Mailchimp marque como `unsubscribed`.

---

# 9. Consentimento por canal

O filtro `opt-in` existente precisa ser auditado.

Descobrir:

> Hoje ele representa opt-in de WhatsApp especificamente ou um conceito genérico?

Se for WhatsApp, não reutilizar o mesmo campo para e-mail.

Criar conceito explícito:

```ts
type ConsentChannel = 'whatsapp' | 'email';

type ConsentStatus =
  | 'opted_in'
  | 'opted_out'
  | 'pending'
  | 'unknown';
```

Se for necessário persistir isso, criar tabela equivalente a:

```text
customer_channel_consents
────────────────────────────────────
id
customer_key
channel
status
source
source_reference
updated_at
created_at
```

Exemplos de `source`:

```text
checkout
manual
mailchimp
import
campaign
unknown
```

**Não inventar uma nova identidade canônica de cliente sem antes entender como `/admin/clientes` identifica e deduplica clientes hoje.**

---

# 10. Preview do segmento vs preview da campanha

Manter responsabilidades separadas.

## Segmento

Continua dizendo:

```text
Segmento "Clientes inativos SC"

Resultado:
1.842 clientes
```

Pode mostrar informações auxiliares de disponibilidade de contato, mas não deve configurar canal.

---

## Campanha

Ao selecionar o segmento e os canais:

```text
Segmento: Clientes inativos SC
Total: 1.842

Canais selecionados:
[x] WhatsApp
[x] E-mail
```

Executar um `eligibility preview`.

Resposta sugerida:

```json
{
  "segmentTotal": 1842,
  "channels": {
    "whatsapp": {
      "eligible": 1725,
      "ineligible": 117
    },
    "email": {
      "eligible": 1602,
      "ineligible": 240
    }
  },
  "overlap": {
    "both": 1491,
    "whatsappOnly": 234,
    "emailOnly": 111,
    "none": 6
  },
  "reasons": {
    "whatsapp": {
      "missing_phone": 31,
      "invalid_phone": 9,
      "no_opt_in": 77
    },
    "email": {
      "missing_email": 95,
      "invalid_email": 8,
      "no_opt_in": 121,
      "unsubscribed": 16
    }
  }
}
```

Não precisa seguir exatamente esse shape se já houver padrão melhor no projeto.

---

# 11. Builder de campanha

## Fluxo desejado

```text
1. Público
2. Canais
3. Conteúdo
4. Elegibilidade
5. Revisão
6. Iniciar campanha
```

---

## 11.1 Etapa Público

Reutilizar seleção de segmento atual.

Mostrar:

```text
Segmento selecionado
Estimativa atual
Filtros aplicados
```

---

## 11.2 Etapa Canais

Nova seção:

```text
CANAIS DE ENVIO

[x] WhatsApp
    Provider: Meta

[x] E-mail
    Provider: Mailchimp
```

Pelo menos um canal obrigatório.

---

## 11.3 Configuração WhatsApp

Preservar tudo que já existe:

- template;
- header;
- body;
- variáveis;
- mídia;
- localização da amostra;
- preview.

Não reconstruir essa parte sem necessidade.

---

## 11.4 Configuração E-mail / Mailchimp

V1 deve permitir selecionar/configurar:

```text
Audience
Assunto
Preview text
From name
Reply-to
Template Mailchimp
```

Se a API permitir ler templates da conta, carregar lista.

A V1 não precisa construir um editor visual de e-mail dentro do painel.

Preferência:

> Template criado/editado no Mailchimp; painel seleciona o template e define os campos necessários para a campanha.

Isso reduz muito o escopo.

Opcionalmente mostrar thumbnail/nome/data de alteração se a API retornar dados suficientes.

---

# 12. Integração Mailchimp

Usar **Mailchimp Marketing API**, não Mailchimp Transactional.

Documentação oficial:

- https://mailchimp.com/developer/marketing/docs/fundamentals/
- https://mailchimp.com/developer/marketing/api/
- https://mailchimp.com/developer/marketing/guides/quick-start/
- https://mailchimp.com/developer/marketing/guides/create-your-first-audience/
- https://mailchimp.com/developer/marketing/guides/organize-contacts-with-tags/

---

## 12.1 Endpoints estáveis a priorizar

Para contatos, usar os endpoints tradicionais de:

```text
/lists
/lists/{list_id}
/lists/{list_id}/members
/lists/{list_id}/members/{subscriber_hash}
/lists/{list_id}/segments
/lists/{list_id}/segments/{segment_id}
/lists/{list_id}/segments/{segment_id}/members
```

**Não basear a V1 nos novos endpoints `/audiences` BETA.**

---

## 12.2 Autenticação

Para este painel privado e uma conta controlada internamente:

```text
MAILCHIMP_API_KEY
MAILCHIMP_SERVER_PREFIX
```

ou equivalente.

A chave deve existir apenas no backend.

**Nunca enviar API key para o frontend.**

O Mailchimp informa que a API key dá acesso amplo à conta, portanto tratá-la como secret.

Se este produto futuramente for usado por clientes externos com contas Mailchimp próprias, migrar para OAuth 2.

Não implementar OAuth agora sem necessidade.

---

## 12.3 Server prefix / data center

Base:

```text
https://<dc>.api.mailchimp.com/3.0/
```

Exemplo:

```text
https://us19.api.mailchimp.com/3.0/
```

O `<dc>` pode ser:

- configurado explicitamente;
- ou derivado da chave quando possível.

Centralizar isso no client Mailchimp.

---

# 13. Criar client de Mailchimp isolado

Não espalhar `fetch("https://...mailchimp...")` dentro de handlers.

Criar módulo dedicado, exemplo:

```text
src/server/mailchimp/
ou
lib/mailchimp/
```

Ajustar ao padrão real do projeto.

Responsabilidades:

```ts
mailchimpClient.ping()

mailchimpClient.listAudiences()
mailchimpClient.getAudience()

mailchimpClient.upsertMember()
mailchimpClient.getMember()
mailchimpClient.updateMember()
mailchimpClient.addTags()

mailchimpClient.createStaticSegment()
mailchimpClient.addMembersToSegment()

mailchimpClient.listTemplates()

mailchimpClient.createCampaign()
mailchimpClient.setCampaignContent()
mailchimpClient.getSendChecklist()
mailchimpClient.sendCampaign()

mailchimpClient.getCampaignReport()
mailchimpClient.getEmailActivity()
```

Centralizar:

- autenticação;
- timeout;
- parse de erro;
- rate limiting/backoff;
- retries seguros;
- logging;
- identificação do request.

---

# 14. Subscriber hash

Para endpoints de membro, Mailchimp utiliza:

```text
MD5(lowercase(email))
```

Criar helper central:

```ts
function mailchimpSubscriberHash(email: string): string
```

Regras:

1. trim;
2. lowercase;
3. MD5;
4. nunca usar o e-mail cru em path quando o endpoint pede `subscriber_hash`.

---

# 15. Estratégia de sincronização de contatos

Não sincronizar a base inteira a cada campanha.

Usar duas camadas:

## Camada A — sync incremental

Quando um cliente relevante for criado/atualizado:

```text
cliente alterado
    ↓
marcar sync pendente
    ↓
sync Mailchimp
```

---

## Camada B — reconciliação

Job periódico:

```text
clientes com sync pendente/falha
    ↓
tentar novamente
```

Não depender exclusivamente de evento nem exclusivamente de cron.

---

# 16. Tabela de estado de sincronização Mailchimp

Não é obrigatório duplicar toda a base de clientes.

Criar algo semelhante a:

```text
mailchimp_contact_sync
────────────────────────────────────
id
customer_key
store_id
audience_id

email_normalized
subscriber_hash
mailchimp_member_id

local_consent_status
mailchimp_status

sync_status
last_synced_at
last_attempt_at
last_error

created_at
updated_at
```

Possíveis `sync_status`:

```text
pending
synced
failed
skipped
```

Se o mesmo e-mail puder existir nas três lojas, a chave deve considerar:

```text
audience_id + subscriber_hash
```

ou equivalente.

---

# 17. Três lojas: Sul, Centro e Norte

O painel é multi-loja.

A integração não deve assumir uma única Audience rígida.

Permitir mapeamento:

```text
Use Sul    -> Audience X
Use Centro -> Audience Y
Use Norte  -> Audience Z
```

Mas também permitir:

```text
Sul    ┐
Centro ├-> mesma Audience
Norte  ┘
```

Ou seja: configurar **store -> audience**.

Estrutura possível:

```text
mailchimp_store_config
────────────────────────────────────
store_id
audience_id
enabled
default_from_name
default_reply_to
created_at
updated_at
```

Se usar `app_config` for mais coerente com o projeto atual, pode usar, desde que o contrato fique tipado e claro.

---

# 18. Tags no Mailchimp

Tags podem ser usadas para organização, mas não devem substituir a segmentação interna do painel.

Exemplos úteis:

```text
store:sul
store:centro
store:norte

uf:sc
uf:rs
uf:pr

source:painel
```

Evitar criar dezenas de tags efêmeras sem necessidade.

---

# 19. Como enviar exatamente o snapshot da campanha por Mailchimp

O snapshot da campanha precisa ser respeitado.

Não criar a campanha de e-mail simplesmente apontando para toda a Audience.

Fluxo recomendado:

```text
Segmento interno
      ↓
snapshot campaign_recipients
      ↓
filtrar elegíveis de email
      ↓
sincronizar membros no Mailchimp
      ↓
criar Static Segment no Mailchimp
      ↓
adicionar exatamente os destinatários elegíveis
      ↓
criar Mailchimp Campaign apontando para esse segmento
      ↓
enviar
```

Nome sugerido do segmento temporário:

```text
painel-campaign-{campaignId}
```

ou:

```text
PAINEL | {campaignId} | {campaignName}
```

Guardar:

```text
mailchimp_segment_id
mailchimp_campaign_id
```

em `campaign_channels`/metadata.

---

## 19.1 Por que Static Segment

O Mailchimp suporta segmentos estáticos e inclusão de membros via API.

Isso permite que:

- o painel continue sendo responsável pela audiência;
- o Mailchimp receba exatamente o snapshot;
- alterações futuras no segmento interno não mudem a campanha já iniciada;
- o relatório do Mailchimp corresponda ao lote realmente enviado.

---

# 20. Sincronização antes do envio

Para cada destinatário de e-mail elegível:

```text
1. validar e-mail
2. calcular subscriber_hash
3. consultar estado local conhecido
4. sincronizar com Audience se necessário
5. garantir que não está unsubscribed/cleaned
6. adicionar ao Static Segment
7. criar campaign_delivery
```

Usar batch operations quando fizer sentido para volumes grandes.

A API do Mailchimp possui batch operations assíncronas.

---

# 21. Status do contato no Mailchimp

Respeitar sempre o status remoto.

Exemplos:

```text
subscribed
unsubscribed
cleaned
pending
transactional
```

Regras:

### `subscribed`

Pode receber marketing, desde que o consentimento interno também permita.

### `unsubscribed`

Não reativar automaticamente.

### `cleaned`

Não enviar.

### `pending`

Não tratar como marketing ativo.

### `transactional`

Não tratar automaticamente como assinante de marketing.

---

# 22. Webhooks do Mailchimp

Adicionar:

```text
POST /api/webhooks/mailchimp
```

ou rota equivalente compatível com o padrão existente.

O webhook deve atualizar informações úteis como:

- subscribe;
- unsubscribe;
- profile/update;
- cleaned;
- mudanças relevantes suportadas pelo webhook.

Persistir evento bruto/auditoria se fizer sentido no padrão já usado pelo painel.

Adicionar proteção contra:

- replay;
- payload inválido;
- eventos duplicados.

Se o Mailchimp não fornecer assinatura equivalente aos webhooks atuais, validar conforme mecanismo oficial e manter endpoint não adivinhável/configuração segura.

---

# 23. Relatórios de e-mail

O Mailchimp possui reports de campanha.

A integração deve preparar o painel para ler:

```text
sent
opens
unique opens
clicks
unique clicks
bounces
unsubscribes
```

e, quando possível:

```text
atividade individual por subscriber
```

Não precisa bloquear a V1 inteira caso relatório granular seja uma segunda etapa.

---

# 24. Motor de campanha multicanal

Hoje existe:

```text
processarFilaDeCampanhas
```

A intenção é evoluir sem perder a fila atual.

Criar abstração por provider.

Conceito:

```ts
interface CampaignProvider {
  prepare(...): Promise<void>;
  queue(...): Promise<void>;
  send(...): Promise<void>;
  syncStatus?(...): Promise<void>;
}
```

Exemplo:

```text
providers/
  whatsappMetaProvider
  mailchimpEmailProvider
```

Não é obrigatório usar exatamente essa interface.

O importante é evitar:

```js
if (campaign.mailchimp) {
   // 500 linhas
}

if (campaign.whatsapp) {
   // outras 500 linhas
}
```

dentro do job principal.

---

# 25. Diferença importante entre WhatsApp e Mailchimp

O WhatsApp atual envia recipient-by-recipient através da fila.

Mailchimp normalmente envia a campanha para um segmento/audience como operação de campanha.

Portanto, **não tentar forçar o Mailchimp a funcionar como se fosse WhatsApp**.

Modelo:

## WhatsApp

```text
delivery A -> API
delivery B -> API
delivery C -> API
```

## Mailchimp

```text
sync recipients
      ↓
static segment
      ↓
Mailchimp campaign
      ↓
send campaign
      ↓
sincronizar status/report
```

Ainda assim, manter `campaign_deliveries` individuais para permitir reporting interno por destinatário.

---

# 26. Lotes atuais

Preservar o mecanismo de liberação em lotes atual.

Hoje a campanha:

```text
start
 ↓
snapshot completo
 ↓
operador libera batch
 ↓
envio
 ↓
pausa quando batch termina
```

Para multicanal, definir o comportamento:

## V1 recomendada

O lote representa **clientes liberados**, não requests individuais de provider.

Exemplo:

```text
Batch #1: 500 recipients
```

Para esses 500:

```text
WhatsApp:
450 elegíveis

E-mail:
472 elegíveis
```

Ao liberar o batch:

```text
WhatsApp -> enfileira 450 deliveries
Mailchimp -> prepara o subset correspondente do canal
```

Se a implementação do Mailchimp exigir um único envio para o segmento inteiro, há duas opções:

### Opção preferida

Cada batch de e-mail vira uma campanha Mailchimp separada vinculada à campanha pai.

```text
Painel campaign #381
 ├─ MC campaign batch 1
 ├─ MC campaign batch 2
 └─ MC campaign batch 3
```

### Alternativa

E-mail ignora batch manual e envia todo o snapshot de uma vez.

**Não escolher silenciosamente.**

Primeiro verificar a intenção atual da funcionalidade de batches.

Preferência deste plano:

> manter semântica de batches também para e-mail, criando uma campanha Mailchimp por batch quando necessário.

Guardar relação:

```text
campaign_batch_id
provider_campaign_id
```

Se a estrutura atual de batches não possuir entidade persistida, avaliar criar uma.

---

# 27. Idempotência

Fundamental.

Nenhum cliente pode receber duas vezes o mesmo canal por corrida de job/restart.

Usar chave única semelhante a:

```text
campaign_id
+
campaign_recipient_id
+
campaign_channel_id
```

Criar unique constraint.

A mudança de status deve continuar monotônica quando aplicável:

```text
pending -> queued -> processing -> sent
```

Nunca voltar `sent -> queued`.

Para chamadas externas, armazenar IDs remotos assim que forem conhecidos.

---

# 28. Concorrência

O painel atual usa transação e `FOR UPDATE` na fila de campanhas.

Preservar essa garantia.

Para `campaign_deliveries`:

- selecionar itens de forma transacional;
- marcar `processing` antes da chamada externa;
- evitar dois workers enviando o mesmo item;
- tratar restart durante `processing`;
- implementar reconciliação de estados presos.

---

# 29. Falhas por canal

Uma falha de e-mail não deve necessariamente falhar o WhatsApp.

Exemplo:

```text
Cliente 128

WhatsApp: sent
E-mail: failed
```

O status da campanha deve ser agregado.

Não usar um único `campaign.status = failed` por erro isolado.

Criar resumo:

```text
WhatsApp
sent       1.230
failed        18

E-mail
sent       1.118
failed        11
```

---

# 30. Status agregado da campanha

Sugestão:

```text
draft
ready
running
paused
completed
completed_with_errors
cancelled
failed
```

`failed` deve ficar reservado para falha estrutural da campanha.

Falhas individuais entram em:

```text
completed_with_errors
```

ou permanecem visíveis no resumo.

---

# 31. API do painel — novos endpoints

Adaptar à convenção real.

Sugestão:

```text
GET  /api/admin/mailchimp/status
GET  /api/admin/mailchimp/audiences
GET  /api/admin/mailchimp/templates

GET  /api/admin/mailchimp/store-config
PUT  /api/admin/mailchimp/store-config

POST /api/admin/mailchimp/test
POST /api/admin/mailchimp/sync
```

Campanhas:

```text
POST /api/admin/campaigns/:id/eligibility-preview
```

ou incorporar ao endpoint de preview existente.

Detalhe:

```text
GET /api/admin/campaigns/:id/channels
GET /api/admin/campaigns/:id/deliveries
```

Relatórios:

```text
POST /api/admin/campaigns/:id/sync-provider-status
```

se necessário.

Não criar endpoint redundante se a API atual já tiver lugar natural.

---

# 32. Frontend API

Criar:

```text
admin/src/api/mailchimp.ts
```

E evoluir:

```text
admin/src/api/campanhas.ts
admin/src/api/segments.ts
```

Tipar:

```ts
CampaignChannel
CampaignProvider
CampaignDelivery
ChannelEligibility
MailchimpAudience
MailchimpTemplate
MailchimpStatus
MailchimpStoreConfig
```

Evitar `any`.

---

# 33. `/admin/integracoes`

Adicionar card:

```text
Mailchimp
E-mail marketing

Status: Conectado

Conta: ...
Data center: usXX
Audiences: 1/3 lojas configuradas

[Configurar]
[Testar conexão]
```

Nunca mostrar API key.

---

## 33.1 Tela/modal de configuração

Mostrar:

```text
Conexão
- status
- conta
- server prefix

Mapeamento por loja

Use Sul
Audience: [dropdown]

Use Centro
Audience: [dropdown]

Use Norte
Audience: [dropdown]
```

Defaults por loja:

```text
From name
Reply-to
```

Botão:

```text
Testar conexão
```

Usar `GET /ping`.

---

# 34. `/admin/campanhas/nova`

Redesenhar o fluxo sem destruir o builder atual.

Exemplo visual:

```text
┌─────────────────────────────────────────────┐
│ Nova campanha                               │
├─────────────────────────────────────────────┤

1 Público
  Segmento: Clientes inativos 60 dias
  1.842 clientes

2 Canais

  ☑ WhatsApp
    Meta
    Template: [ Volte 15 ▼ ]

  ☑ E-mail
    Mailchimp
    Audience: [ Use Origens ▼ ]
    Template: [ Setembro 2026 ▼ ]
    Assunto: [ Sentimos sua falta           ]
    Preview: [ Tem novidade por aqui        ]

3 Elegibilidade

  WhatsApp disponível     1.725
  E-mail disponível       1.602
  Ambos                    1.491
  Sem canal                    6

4 Revisão

  [Iniciar campanha]
```

---

# 35. `/admin/campanhas/:id`

Transformar o detalhe em visão multicanal.

Topo:

```text
Campanha
Clientes inativos - Setembro

Segmento: Clientes 60d
Status: Em andamento
```

Resumo:

```text
Recipients: 1.842
```

Tabs ou cards:

```text
[Visão geral] [WhatsApp] [E-mail] [Destinatários]
```

### WhatsApp

```text
Elegíveis
Enviados
Entregues
Lidos
Falhas
```

### E-mail

```text
Elegíveis
Enviados
Entregues
Abertos
Cliques
Bounces
Descadastros
Falhas
```

---

# 36. Tabela de destinatários

Cada linha deve representar cliente, com status por canal.

Exemplo:

| Cliente | WhatsApp | E-mail |
|---|---|---|
| João | Entregue | Aberto |
| Maria | Enviado | — |
| Carlos | — | Clicou |
| Ana | Falhou | Entregue |

Tooltip no `—`:

```text
Sem e-mail
Sem opt-in
E-mail inválido
```

ou equivalente.

---

# 37. Filtros da tabela

Adicionar:

```text
Canal:
- Todos
- WhatsApp
- E-mail

Status:
- Enviado
- Entregue
- Aberto
- Clicado
- Falha
- Inelegível
```

---

# 38. Mailchimp templates

V1:

- listar templates existentes;
- selecionar template;
- não criar editor completo;
- não tentar replicar o builder visual do Mailchimp.

A API tradicional de templates suporta principalmente templates Classic.

Antes de assumir compatibilidade de todos os templates da conta, testar com a conta real.

Se determinado tipo de template não for retornado/usável pela API:

- informar claramente na UI;
- permitir alternativa via campaign/template compatível;
- não mascarar a limitação.

---

# 39. Criar campanha no Mailchimp

Fluxo conceitual:

```text
1. preparar Audience
2. sincronizar contatos elegíveis
3. criar static segment
4. adicionar membros ao segmento
5. criar Campaign
6. configurar recipients
7. configurar settings
8. aplicar template/content
9. consultar send checklist
10. enviar
11. armazenar Mailchimp campaign id
```

Endpoints oficiais envolvidos incluem:

```text
POST /campaigns
PUT  /campaigns/{campaign_id}/content
GET  /campaigns/{campaign_id}/send-checklist
POST /campaigns/{campaign_id}/actions/send
```

Não enviar se o checklist indicar erro bloqueante.

---

# 40. Teste de e-mail

Adicionar ação no builder:

```text
Enviar teste
```

Usar endpoint oficial de test campaign quando possível.

O teste:

- não cria recipient normal;
- não altera contagem da campanha interna;
- deve registrar erro se falhar;
- deve exigir e-mail de teste válido.

---

# 41. Reports

Depois do envio:

```text
GET /reports/{campaign_id}
```

E, quando necessário:

```text
/reports/{campaign_id}/email-activity
/reports/{campaign_id}/sent-to
/reports/{campaign_id}/click-details
```

Criar sync periódico para campanhas Mailchimp ainda recentes.

Exemplo:

```text
processarSyncRelatoriosMailchimp
```

Não precisa consultar campanhas antigas indefinidamente.

---

# 42. Jobs

Hoje existem jobs no próprio `server.js`.

Adicionar apenas o necessário.

Sugestão:

```text
processarMailchimpSyncQueue       -> 1 min
sincronizarRelatoriosMailchimp    -> 5 min
```

Os intervalos são sugestivos.

Antes de adicionar novos `setInterval`, avaliar se podem ser integrados ao job atual de campanhas.

Evitar multiplicar timers sem necessidade.

---

# 43. Persistência obrigatória em Postgres

Tudo que representa:

- campanha;
- recipient;
- delivery;
- estado de sync;
- vínculo com campanha Mailchimp;
- vínculo com static segment;
- consentimento;
- status remoto importante;

deve sobreviver a restart/deploy.

Portanto deve ir para Postgres quando `DATABASE_URL` estiver disponível.

Se o projeto exige fallback JSON sem Postgres, implementar fallback equivalente ou documentar explicitamente a exceção.

**Não criar funcionalidade que funciona em Postgres e explode silenciosamente no fallback atual.**

---

# 44. Variáveis de ambiente

Adicionar documentação em `painel-estado-atual.md` e `.env.example`/equivalente.

Sugestão:

```text
MAILCHIMP_API_KEY=
MAILCHIMP_SERVER_PREFIX=
```

Opcional:

```text
MAILCHIMP_WEBHOOK_SECRET=
```

somente se realmente existir/for usado no mecanismo implementado.

Não hardcodar Audience IDs em env se o painel tiver configuração dinâmica por loja.

---

# 45. Segurança

Obrigatório:

- segredo somente backend;
- não retornar API key em endpoint;
- não logar API key;
- não logar Authorization;
- sanitizar erros do Mailchimp;
- limitar payloads;
- usar timeout;
- retries com backoff apenas em erros seguros;
- não repetir `send campaign` de forma cega;
- idempotência local antes do provider;
- registrar auditoria de ações administrativas críticas.

---

# 46. Rate limits e batch

Para grandes audiências:

- preferir batch operations onde apropriado;
- limitar concorrência;
- usar retry/backoff;
- tratar 429 e 5xx;
- não disparar milhares de requests simultâneos.

O Mailchimp possui endpoint de Batch Operations:

```text
POST /batches
GET  /batches/{batch_id}
```

Usar se trouxer benefício real.

---

# 47. Erros

Criar classificação interna:

```text
CONFIG_ERROR
AUTH_ERROR
INVALID_AUDIENCE
INVALID_TEMPLATE
INVALID_RECIPIENT
UNSUBSCRIBED
CLEANED
RATE_LIMIT
PROVIDER_ERROR
NETWORK_ERROR
SEND_CHECKLIST_ERROR
UNKNOWN
```

Na UI mostrar mensagens compreensíveis.

Não exibir resposta bruta inteira do provider ao usuário.

Manter detalhe técnico no log/auditoria.

---

# 48. Observabilidade

Logar com contexto:

```text
campaignId
campaignChannelId
campaignRecipientId
campaignDeliveryId
provider
providerCampaignId
storeId
```

Não incluir dados pessoais além do necessário.

---

# 49. Entitlements

Existe `state/entitlements.ts`.

Verificar se a integração de e-mail precisa ser controlada por plano.

Hoje existem flags como:

```text
whatsapp
instagram
catalog
...
```

Não adicionar comportamento arbitrário.

Se o produto precisar controlar por plano, criar algo explícito:

```text
emailMarketing
```

ou:

```text
mailchimp
```

e atualizar backend + frontend.

Caso ainda não exista decisão comercial, deixar a integração disponível sem inventar restrição.

---

# 50. Sidebar

Não criar um grande menu novo de "Mailchimp".

Mailchimp é provider.

Estrutura recomendada:

```text
Campanhas
├── Segmentos
├── Nova campanha
└── Campanhas

Sistema
└── Integrações
    └── Mailchimp
```

O usuário trabalha com **Campanhas**, não com "campanhas Mailchimp".

---

# 51. Migração de nomenclatura

Onde hoje a UI disser implicitamente:

```text
Campanhas WhatsApp
```

avaliar trocar para:

```text
Campanhas
```

Onde necessário, exibir:

```text
Canal: WhatsApp
```

Campanhas históricas continuam aparecendo normalmente.

---

# 52. Não duplicar Segmentos no Mailchimp

Regra explícita para implementação:

**Não recriar o builder de filtros do painel dentro do Mailchimp.**

O segmento interno é calculado pelo painel.

Mailchimp recebe apenas o snapshot final necessário para o envio.

Exemplo:

```text
Painel:
UF = SC
orders >= 2
lastPurchase >= 60d

Resultado:
1.842 clientes

Mailchimp:
static segment com os e-mails elegíveis desses clientes
```

---

# 53. Não transformar tags em regra de negócio

Não fazer:

```text
if mailchimp tag == cliente_sc
```

para decidir quem pertence ao segmento interno.

Tags remotas são auxiliares.

A regra de negócio permanece local.

---

# 54. Webhook e unsubscribe

Quando Mailchimp informar unsubscribe:

```text
Mailchimp webhook
      ↓
atualiza consentimento/sync local
      ↓
cliente passa a ser inelegível para email
```

Nunca reativar automaticamente em sync posterior.

Esse comportamento precisa de teste automatizado.

---

# 55. Deleção/remoção de integração

Se a chave Mailchimp for removida/desativada:

- campanhas históricas continuam visíveis;
- IDs remotos permanecem no histórico;
- novas campanhas de e-mail ficam indisponíveis;
- WhatsApp continua funcionando;
- segmentos continuam funcionando.

Não apagar histórico.

---

# 56. Feature flag

Como é uma mudança grande, considerar:

```text
MULTICHANNEL_CAMPAIGNS_ENABLED
```

ou feature flag equivalente no `app_config`.

Objetivo:

- desenvolver sem quebrar produção;
- habilitar depois dos migrations/testes.

Se não for necessário por fluxo de deploy atual, não criar só por criar.

---

# 57. Ordem de implementação

## Fase 0 — Auditoria

Antes de alterar código:

- mapear schema real de `campaigns`;
- mapear schema real de `campaign_recipients`;
- mapear endpoints;
- mapear builder atual;
- mapear fila;
- mapear batches;
- mapear opt-in;
- mapear identidade de cliente;
- mapear integração WhatsApp.

Produzir uma nota curta com divergências entre este plano e o código.

Depois implementar.

---

## Fase 1 — Domínio multicanal

Implementar:

- tipos de canal/provider;
- `campaign_channels`;
- `campaign_deliveries`;
- migrations;
- compatibilidade com campanhas antigas;
- agregação de status.

Ainda sem Mailchimp.

### Critério de aceite

Uma nova campanha WhatsApp deve continuar funcionando exatamente como antes, mas internamente através da nova estrutura.

---

## Fase 2 — UI multicanal

Implementar:

- seletor de canais;
- layout por canal;
- eligibility preview;
- detalhe multicanal;
- tabela de destinatários com colunas por canal.

Ainda pode deixar Email desabilitado com:

```text
Configure o Mailchimp em Integrações
```

### Critério de aceite

Fluxo WhatsApp não regride.

---

## Fase 3 — Mailchimp Integration

Implementar:

- client;
- env;
- `/admin/integracoes`;
- ping;
- audiences;
- store mapping;
- templates;
- sync de membro;
- static segments;
- tratamento de status de subscriber.

---

## Fase 4 — Envio de e-mail

Implementar:

- configuração de email na campanha;
- snapshot;
- eligibility;
- sync;
- static segment;
- Mailchimp Campaign;
- send checklist;
- send;
- IDs remotos;
- deliveries.

---

## Fase 5 — Ambos

Garantir:

```text
WhatsApp + E-mail
```

na mesma campanha.

Falha de um provider não cancela automaticamente o outro.

---

## Fase 6 — Reports

Implementar:

- status Mailchimp;
- opens;
- clicks;
- bounces;
- unsubscribes;
- cards;
- destinatários;
- sincronização periódica.

---

## Fase 7 — Webhooks e consentimento

Implementar:

- unsubscribe;
- cleaned;
- updates;
- reconciliação local;
- auditoria.

---

# 58. Testes obrigatórios

O painel atualmente não possui suíte automatizada completa, mas esta mudança mexe com envio real.

Adicionar testes focados pelo menos para o novo domínio/backend.

## Segmentos

- segmento continua independente de canal;
- filtros antigos não mudam resultado.

## Elegibilidade

- cliente com telefone + email -> ambos;
- somente telefone -> WhatsApp;
- somente email -> E-mail;
- nenhum -> inelegível;
- email unsubscribed -> não recebe e-mail;
- email cleaned -> não recebe e-mail;
- telefone sem opt-in -> não recebe WhatsApp;
- email sem consentimento -> não recebe marketing por e-mail.

## Deliveries

- uma delivery por recipient/channel;
- unique constraint impede duplicata;
- WhatsApp + email gera duas deliveries;
- status de um canal não sobrescreve outro.

## Compatibilidade

- campanha histórica abre;
- campanha histórica mantém métricas;
- nova campanha apenas WhatsApp envia;
- pause/resume continua funcionando;
- batch continua funcionando.

## Mailchimp

Mockar:

- ping;
- list audiences;
- list templates;
- upsert member;
- static segment;
- create campaign;
- checklist;
- send;
- reports;
- 401;
- 429;
- 5xx;
- timeout.

## Idempotência

Simular:

- job executado duas vezes;
- restart no meio do envio;
- provider respondeu sucesso, mas processo caiu antes de salvar;
- retry após erro transitório.

---

# 59. Checklist visual/manual

Validar em desktop:

```text
/admin/campanhas/segmentos
/admin/campanhas/nova
/admin/campanhas
/admin/campanhas/:id
/admin/integracoes
```

Verificar:

- loading;
- empty state;
- erro;
- provider desconectado;
- Mailchimp sem Audience;
- Mailchimp sem template;
- apenas WhatsApp;
- apenas E-mail;
- ambos;
- 0 elegíveis;
- audiência grande;
- campanha histórica.

Usar Design System existente.

Não criar componentes paralelos se `Card`, `Tabs`, `DataTable`, `Modal`, `Drawer`, `StatusBadge`, `Button`, `Field`, etc. já resolverem.

---

# 60. Critérios de aceite funcionais

A entrega só é considerada pronta quando:

### Segmentação

- [ ] segmento continua sendo reutilizável independentemente do canal;
- [ ] filtros existentes continuam funcionando;
- [ ] preview continua dinâmico.

### Campanha

- [ ] campanha aceita WhatsApp;
- [ ] campanha aceita E-mail;
- [ ] campanha aceita ambos;
- [ ] uma campanha continua sendo uma única entidade;
- [ ] cada canal possui configuração própria.

### Recipient

- [ ] recipient é snapshot único por campanha;
- [ ] recipient não é duplicado quando recebe nos dois canais.

### Delivery

- [ ] existe uma delivery por recipient × canal;
- [ ] status é independente;
- [ ] falha em e-mail não apaga sucesso do WhatsApp;
- [ ] falha em WhatsApp não apaga sucesso do e-mail.

### WhatsApp

- [ ] comportamento atual preservado;
- [ ] template/variáveis/mídia continuam funcionando;
- [ ] batches continuam funcionando;
- [ ] pause/resume continuam funcionando.

### Mailchimp

- [ ] conexão pode ser testada;
- [ ] audiences são carregadas;
- [ ] é possível mapear audience por loja;
- [ ] templates compatíveis aparecem;
- [ ] contato é sincronizado com segurança;
- [ ] unsubscribe é respeitado;
- [ ] static segment usa o snapshot correto;
- [ ] campanha é criada;
- [ ] checklist é validado;
- [ ] envio é disparado;
- [ ] provider campaign id é persistido.

### UI

- [ ] preview mostra elegibilidade por canal;
- [ ] detalhe mostra métricas separadas;
- [ ] destinatário mostra status por canal;
- [ ] mensagens de erro são claras.

### Segurança

- [ ] API key nunca chega ao browser;
- [ ] segredo não aparece em log;
- [ ] envio é idempotente;
- [ ] retries não duplicam mensagem.

---

# 61. Critérios de aceite técnicos

- [ ] `npm --prefix admin run typecheck` passa;
- [ ] `npm run build` passa;
- [ ] migrations são idempotentes;
- [ ] boot sem Mailchimp configurado continua funcionando;
- [ ] WhatsApp continua funcionando sem Mailchimp;
- [ ] fallback sem `DATABASE_URL` não quebra o boot;
- [ ] nenhuma rota existente é removida sem compatibilidade;
- [ ] nenhum dado histórico é apagado;
- [ ] não existem secrets hardcoded;
- [ ] tipos frontend/backend permanecem coerentes.

---

# 62. Atualização da documentação ao final

Atualizar `painel-estado-atual.md` para refletir:

- número novo de rotas, se mudar;
- novo provider Mailchimp;
- novos arquivos API;
- novas tabelas;
- novos jobs;
- novas variáveis de ambiente;
- funcionamento multicanal;
- reports disponíveis;
- itens que continuam pendentes.

Remover comentários antigos que fiquem incorretos após a mudança.

---

# 63. Decisões que NÃO devem ser tomadas automaticamente

Se o código real não responder, registrar claramente antes de decidir:

1. O `opt-in` atual é exclusivamente WhatsApp?
2. Existe identificador estável de cliente?
3. Como os batches estão persistidos?
4. E-mail marketing já possui consentimento capturado em algum ponto?
5. Cada loja terá sua própria Audience ou uma Audience compartilhada?
6. Quais templates Mailchimp da conta são compatíveis com Marketing API?
7. A campanha Mailchimp será uma por batch ou uma única campanha por snapshot?
8. O fallback JSON precisa suportar integralmente as novas tabelas?
9. A funcionalidade será entitlement separado?

Para a implementação inicial, usar as defaults deste documento quando tecnicamente seguras, mas **não inventar consentimento**.

---

# 64. Defaults recomendados para V1

Caso não haja decisão externa em contrário:

```text
Segmentos:
agnósticos de canal

Campanha:
1 entidade

Canais:
WhatsApp / Meta
E-mail / Mailchimp

Painel:
fonte de verdade

Mailchimp:
provider de envio

Audience:
configurável por loja

Destinatários:
snapshot no start

E-mail:
static segment por campanha/batch

Templates:
selecionados do Mailchimp

Editor visual:
não implementar

Consentimento:
obrigatório e separado por canal

Unsubscribe:
nunca reativar automaticamente

Reports:
sincronizados após envio

WhatsApp:
preservar fluxo atual
```

---

# 65. Futuro — não implementar agora

A arquitetura deve deixar espaço para:

```text
Campanha / Jornada
        ↓
E-mail
        ↓
espera 24h
        ↓
não abriu?
        ↓
WhatsApp
```

ou:

```text
WhatsApp
   ↓
falhou entrega?
   ↓
E-mail
```

e futuramente:

```text
SMS
Push
Instagram DM
outros providers
```

Mas nenhuma dessas automações condicionais faz parte desta entrega.

---

# 66. Resultado esperado

Ao final, o conceito do painel deve ser:

```text
SEGMENTO
Quem queremos atingir?

        ↓

CAMPANHA
O que queremos comunicar?

        ↓

CANAIS
Por onde queremos comunicar?

   ┌────────────┬────────────┐
   │            │            │
WhatsApp      E-mail      Futuro...
   │            │
 Meta       Mailchimp

        ↓

DELIVERIES
O que aconteceu com cada cliente em cada canal?
```

Essa separação é obrigatória.

**Não construir "campanha Mailchimp" como um módulo isolado e não manter "Campanhas" acoplado estruturalmente ao WhatsApp.**

A mudança deve transformar o módulo atual em um verdadeiro motor multicanal mantendo toda a base já pronta de segmentos, snapshots, batches e operação.

---

# Referências oficiais Mailchimp

Consultadas para este plano em 11/09/2026:

- Marketing API Fundamentals  
  https://mailchimp.com/developer/marketing/docs/fundamentals/

- Marketing API Reference  
  https://mailchimp.com/developer/marketing/api/

- Quick Start  
  https://mailchimp.com/developer/marketing/guides/quick-start/

- Create Your First Audience  
  https://mailchimp.com/developer/marketing/guides/create-your-first-audience/

- Organize Contacts with Tags  
  https://mailchimp.com/developer/marketing/guides/organize-contacts-with-tags/

- E-commerce API  
  https://mailchimp.com/developer/marketing/docs/e-commerce/

> Observação: a referência atual também expõe novos endpoints de `Audiences` marcados como **BETA**. A V1 deste plano deve usar os endpoints estáveis de `Lists/Audiences` (`/lists/...`) para contatos e segmentos, salvo motivo técnico devidamente documentado.
