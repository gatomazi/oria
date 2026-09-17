# PROMPT CLAUDE — WhatsApp: Campanhas/Remarketing + Amostra de Mídia nos Templates

## Objetivo

Implementar no painel existente dois blocos relacionados ao WhatsApp:

1. **Novo módulo de Campanhas / Remarketing**
   - diferente das automações atuais de Carrinho Abandonado e PIX Pendente;
   - permitir selecionar clientes por filtros;
   - escolher um template aprovado;
   - revisar, testar, enviar agora ou agendar;
   - processar os envios em fila;
   - acompanhar status, métricas e histórico.

2. **Evolução da criação/edição de Templates**
   - adicionar **Amostra de mídia** no fluxo de criação do template;
   - suportar:
     - Nenhum
     - Imagem
     - Vídeo
     - Documento
     - Localização
   - implementar upload real de arquivo, preview, persistência, integração com o formato esperado pela Meta e utilização posterior em campanhas.

---

# REGRA PRINCIPAL

**Não criar um projeto paralelo e não reescrever o painel.**

Trabalhe sobre a arquitetura, componentes, design system, autenticação, contexto de loja, banco, serviços, jobs, filas e integração Meta que já existem.

Antes de alterar qualquer coisa:

1. inspecione o repositório;
2. localize a implementação atual de WhatsApp;
3. localize:
   - templates;
   - integração Meta;
   - contas/WABA;
   - credenciais;
   - lojas/tenants;
   - clientes;
   - pedidos;
   - carrinho abandonado;
   - PIX pendente;
   - scheduler;
   - filas/jobs, caso existam;
   - webhooks;
   - storage/upload, caso exista;
   - design system;
4. reaproveite padrões existentes;
5. não duplique serviços que já resolvem o mesmo problema.

A implementação deve ser **real e funcional**, não apenas mock visual.

---

# PARTE 1 — NAVEGAÇÃO

Dentro de `WhatsApp`, organizar o menu aproximadamente assim, adaptando às rotas e nomenclaturas já existentes:

```text
WhatsApp
├── Dashboard
├── Conversas
├── Automações
│   ├── Carrinho abandonado
│   ├── PIX pendente
│   ├── Produção concluída
│   ├── Despachado
│   ├── Em trânsito
│   └── Em entrega
│
├── Campanhas
│   ├── Todas as campanhas
│   ├── Nova campanha
│   ├── Segmentos
│   └── Relatórios
│
├── Templates
├── Contatos
└── Configurações
```

Não é necessário criar submenus se a navegação atual não usa esse padrão. O importante é que **Campanhas** seja uma área própria e não seja misturada com automações transacionais.

---

# PARTE 2 — DIFERENÇA ENTRE AUTOMAÇÃO E CAMPANHA

## Automações existentes

Continuam orientadas a eventos:

```text
evento
→ regra
→ template
→ envio
```

Exemplos:

- PIX pendente;
- carrinho abandonado;
- pedido produzido;
- pedido despachado;
- pedido em trânsito;
- pedido em entrega.

## Campanhas / Remarketing

Devem funcionar assim:

```text
audiência
→ filtros
→ template
→ conteúdo/mídia
→ revisão
→ agendamento/envio
→ fila
→ Meta
→ webhooks
→ relatório
```

Campanhas são disparos proativos, principalmente de Marketing.

---

# PARTE 3 — TELA "TODAS AS CAMPANHAS"

Criar uma página de listagem visualmente consistente com o restante do painel.

## Cabeçalho

```text
Campanhas

Crie campanhas segmentadas para reativar clientes,
divulgar ofertas e trabalhar sua base via WhatsApp.

[ + Nova campanha ]
```

## Cards/resumo

Exibir, quando houver dados reais:

- Campanhas enviadas no período
- Mensagens enviadas
- Taxa de entrega
- Taxa de leitura
- Cliques rastreados
- Receita atribuída, caso o projeto já possua dados suficientes para atribuição

Não inventar métricas.

## Tabela

Colunas sugeridas:

- Campanha
- Loja
- Template
- Público
- Destinatários
- Status
- Agendada para
- Enviadas
- Entregues
- Lidas
- Criada em
- Ações

Status de campanha:

```text
draft
scheduled
preparing
sending
paused
completed
cancelled
failed
```

Adaptar para enums/padrões existentes.

## Ações

Conforme o status:

- Ver detalhes
- Duplicar
- Editar rascunho
- Cancelar agendamento
- Pausar
- Retomar
- Cancelar
- Ver relatório

Nunca permitir editar silenciosamente uma campanha que já começou a ser enviada.

---

# PARTE 4 — NOVA CAMPANHA

Criar fluxo em etapas.

Sugestão:

```text
1. Campanha
2. Audiência
3. Template
4. Conteúdo
5. Revisão
```

Pode ser wizard ou página única em seções, desde que a UX fique clara.

---

# ETAPA 1 — CAMPANHA

Campos:

```text
Nome da campanha
Loja
Descrição interna opcional
```

Exemplo:

```text
Nome:
Reativação clientes 90 dias

Loja:
Use Origens
```

Tudo precisa respeitar o contexto multi-loja/multi-tenant já existente.

---

# ETAPA 2 — AUDIÊNCIA / REMARKETING

Criar um construtor de filtros.

## Interface

```text
Quem deve receber?

[ Todas as condições ▼ ]

Última compra   [ há mais de ]   [ 90 ] dias
Número pedidos  [ maior/igual ]  [ 2 ]
Total gasto     [ maior que ]     [ R$ 200 ]

[ + Adicionar filtro ]

---------------------------------

3.824 clientes encontrados
```

Permitir:

```text
TODAS as condições
```

ou:

```text
QUALQUER condição
```

Internamente isso equivale a grupos `AND` / `OR`.

---

# FILTROS DE AUDIÊNCIA

Antes de implementar, verificar quais campos já existem no banco e quais podem ser calculados com segurança.

Suportar inicialmente os filtros possíveis com os dados reais existentes e estruturar para expansão.

Filtros desejados:

### Cliente

- Nome
- Telefone
- Estado
- Cidade
- Tags
- Origem
- Data de cadastro

### Compras

- Data da primeira compra
- Data da última compra
- Dias desde a última compra
- Quantidade de pedidos
- Total gasto
- Ticket médio
- Comprou produto X
- Não comprou produto X
- Comprou categoria/coleção X
- Não comprou categoria/coleção X
- Utilizou cupom X
- Não utilizou cupom X

### Comportamento

- Tem carrinho abandonado
- Não tem carrinho abandonado
- Teve carrinho e depois comprou
- Não comprou após carrinho
- Já recebeu campanha X
- Nunca recebeu campanha X
- Recebeu campanha nos últimos X dias
- Leu campanha X, se esse dado estiver disponível
- Clicou campanha X, quando o clique for rastreado pelo nosso sistema

### Consentimento

- Opt-in de marketing
- Opt-out
- Bloqueado/suprimido
- Número inválido

---

# EXCLUSÕES OBRIGATÓRIAS

Além dos filtros de inclusão, criar seção:

```text
Exclusões

[x] Sem opt-in de marketing
[x] Opt-out
[x] Números inválidos/bloqueados
[ ] Comprou nos últimos X dias
[ ] Recebeu campanha nas últimas X horas/dias
[ ] Já recebeu esta campanha
```

**Nunca enviar Marketing para contatos que estejam marcados como opt-out/suprimidos.**

Se o projeto ainda não possui um modelo de consentimento, criar uma camada mínima e coerente para isso antes de liberar disparos de Marketing.

---

# CONTAGEM DA AUDIÊNCIA

A contagem precisa ser calculada no backend.

Não carregar todos os clientes no navegador para filtrar.

Criar endpoint/serviço equivalente a:

```text
POST /campaigns/audience/preview
```

Entrada conceitual:

```json
{
  "storeId": "...",
  "match": "ALL",
  "filters": [],
  "exclusions": []
}
```

Saída conceitual:

```json
{
  "matched": 4283,
  "excluded": 419,
  "eligible": 3864,
  "breakdown": {
    "optOut": 238,
    "recentCampaign": 104,
    "invalidPhone": 77
  }
}
```

Aplicar debounce no frontend para evitar consultas em excesso.

---

# PARTE 5 — SEGMENTOS SALVOS

Criar `Campanhas > Segmentos`.

Um segmento é uma definição salva de filtros.

Exemplos:

```text
Clientes inativos 90 dias
Última compra > 90 dias

VIP
Pedidos >= 3
OU
Total gasto >= R$ 500

Primeira compra
Pedidos = 1

Clientes SC
Estado = SC

Comprou Legado
Categoria = Legado
```

## Regra

O segmento deve ser **dinâmico**.

Não salvar apenas uma lista fixa de IDs como definição principal.

Salvar:

- nome;
- store/tenant;
- lógica ALL/ANY;
- filtros;
- exclusões;
- criado por;
- datas.

Ao iniciar efetivamente uma campanha, aí sim criar um **snapshot dos destinatários**.

Isso impede que a audiência mude durante o envio.

---

# PARTE 6 — TEMPLATES: AMOSTRA DE MÍDIA

Esta é uma alteração obrigatória na tela atual de criação/edição de template.

Adicionar uma seção visual inspirada no padrão da Meta:

```text
Amostra de mídia • Opcional

[ Imagem ▼ ]

┌──────────────────────────────────────────────┐
│                                              │
│        Arraste e solte para carregar         │
│   Ou escolha arquivos no seu dispositivo    │
│                                              │
└──────────────────────────────────────────────┘
```

## Dropdown

Opções:

```text
○ Nenhum
○ Imagem
○ Vídeo
○ Documento
○ Localização
```

Pode utilizar radio items dentro de dropdown/popover, seguindo o design system atual.

---

# COMPORTAMENTO DA AMOSTRA DE MÍDIA

## 1. Nenhum

Não exibir uploader de mídia.

Se a implementação atual possuir cabeçalho de texto, manter essa possibilidade conforme as regras já suportadas pelo WhatsApp/Meta.

---

## 2. Imagem

Exibir dropzone:

```text
Arraste e solte para carregar
Ou escolha arquivos no seu dispositivo
```

Aceitar apenas formatos suportados pela integração Meta atual.

No mínimo, validar MIME e extensão de forma consistente.

Estados:

```text
idle
dragging
uploading
uploaded
error
```

Após upload:

```text
┌───────────┐
│ preview   │
└───────────┘

semana-cliente.jpg
820 KB

[ Trocar ] [ Remover ]
```

Mostrar preview real.

---

## 3. Vídeo

Mesmo fluxo, porém com player/thumbnail apropriado.

Mostrar:

- nome;
- tamanho;
- duração, se o projeto já possui forma simples de obtê-la;
- trocar;
- remover.

Não carregar o vídeo inteiro em memória desnecessariamente.

---

## 4. Documento

Exibir:

- ícone;
- nome;
- extensão;
- tamanho;
- trocar;
- remover.

Não tentar renderizar PDFs/documents complexos dentro da UI se isso não for necessário.

---

## 5. Localização

Não utilizar uploader de arquivo.

Exibir campos adequados ao contrato atualmente aceito pela integração:

```text
Nome/local
Endereço
Latitude
Longitude
```

Se latitude/longitude puderem ser obtidas automaticamente pelo sistema existente, ótimo; caso contrário, não adicionar dependência externa desnecessária agora.

Antes de montar o payload Meta, conferir o contrato real suportado pela versão da API já usada no projeto.

---

# MUITO IMPORTANTE — "AMOSTRA" NÃO É A MESMA COISA QUE "MÍDIA DO ENVIO"

Separar conceitualmente:

## A. Sample media / amostra do template

É utilizada durante a criação/submissão do template à Meta.

## B. Mídia real da mensagem

É a mídia enviada ao cliente quando a campanha ou automação usa aquele template.

Não tratar esses dois conceitos como uma única coisa no banco.

O template pode possuir uma amostra usada para aprovação, enquanto uma campanha posterior pode fornecer outra imagem compatível com o mesmo tipo de header.

---

# PARTE 7 — INTEGRAÇÃO META DA AMOSTRA

A integração oficial de templates com header de mídia utiliza um componente de `HEADER` com um `format` apropriado.

Conceitualmente:

```json
{
  "type": "HEADER",
  "format": "IMAGE",
  "example": {
    "header_handle": [
      "<HANDLE_GERADO_PELA_META>"
    ]
  }
}
```

Para documento, a lógica é equivalente com `DOCUMENT`.

Para vídeo, usar o formato aceito pela versão atual da API utilizada no projeto.

Para localização, utilizar exclusivamente os campos oficialmente aceitos pela API atual.

## Regra de implementação

**Não passar simplesmente a URL pública da nossa imagem no `header_handle`.**

A amostra de imagem/vídeo/documento deve seguir o fluxo de upload aceito pela Meta para obtenção do handle da mídia, e esse handle deve ser utilizado na criação do template.

O Claude deve:

1. localizar a versão Graph API usada no projeto;
2. verificar se já existe serviço de upload Meta;
3. reaproveitá-lo se existir;
4. se não existir, criar serviço isolado para o fluxo de upload;
5. nunca colocar token Meta no frontend.

---

# FLUXO DE UPLOAD DE AMOSTRA

Fluxo conceitual:

```text
Browser
   ↓
nosso backend
   ↓
validação
   ↓
storage local/cloud, se necessário
   ↓
Meta upload/resumable upload
   ↓
header handle
   ↓
salvar referência
   ↓
criar template
```

O detalhe do endpoint/contrato da Meta deve respeitar a versão Graph API atualmente configurada no projeto.

Não copiar endpoint/versionamento antigo de exemplos encontrados na internet.

---

# PARTE 8 — MODELO DE DADOS PARA MÍDIA

Se ainda não existir uma entidade de mídia reutilizável, criar algo equivalente a:

```text
media_assets
```

Campos conceituais:

```text
id
store_id
kind                // image | video | document
filename
original_filename
mime_type
size_bytes
storage_provider
storage_key
public_url/null
meta_upload_handle/null
meta_media_id/null
status
created_by
created_at
updated_at
```

Não salvar arquivos grandes em Base64 no banco.

Não expor chaves internas de storage no frontend.

Garantir isolamento por loja/tenant.

---

# RELAÇÃO COM TEMPLATE

Adicionar ao modelo de template apenas o que for necessário:

```text
header_type
sample_media_asset_id
sample_location_json
```

ou adaptar ao schema atual.

Não criar campos duplicados se o template já possui representação de `components`.

Preferir manter `components` como fonte de verdade quando isso fizer sentido com a arquitetura existente.

---

# PARTE 9 — CRIAÇÃO/EDIÇÃO DO TEMPLATE

O fluxo final de template deve suportar:

```text
Informações básicas
→ Categoria
→ Idioma
→ Cabeçalho
→ Amostra de mídia
→ Corpo
→ Exemplos de variáveis
→ Rodapé
→ Botões
→ Preview
→ Revisão
→ Enviar para Meta
```

## Categoria

Manter categorias suportadas pelo projeto/Meta.

Para campanhas promocionais, normalmente será `MARKETING`.

Não alterar templates existentes indevidamente.

---

# HEADER

O header deve respeitar as limitações reais do formato Meta.

Não enviar simultaneamente combinações inválidas de `TEXT`, `IMAGE`, `VIDEO`, `DOCUMENT` ou `LOCATION`.

A interface deve mostrar/ocultar opções de acordo com o tipo escolhido.

Se a tela atual permite "texto de cabeçalho", ao selecionar uma mídia, ajustar a UI para não gerar payload inválido.

---

# BODY E VARIÁVEIS

Manter editor atual, mas melhorar a área de exemplos.

Exemplo:

```text
Olá {{1}}, preparamos uma condição especial para você.

Use o cupom {{2}} e aproveite.
```

Exemplos:

```text
{{1}} = Gabriel
{{2}} = VOLTE15
```

As amostras utilizadas na aprovação não devem ser confundidas com os dados dinâmicos reais no envio.

---

# PREVIEW DO TEMPLATE

A tela de template deve ter preview realista.

Se `Imagem`:

```text
┌───────────────────────────────┐
│         IMAGEM                │
│                               │
├───────────────────────────────┤
│ Olá Gabriel!                  │
│                               │
│ Preparamos uma condição...    │
├───────────────────────────────┤
│ ↗ COMPRAR AGORA               │
└───────────────────────────────┘
```

Se vídeo, documento ou localização, adaptar o header visualmente.

O preview é apenas uma aproximação visual e não deve tentar replicar internamente toda a UI nativa do WhatsApp.

---

# PARTE 10 — TEMPLATE NA NOVA CAMPANHA

Na etapa `Template`, listar apenas templates compatíveis e utilizáveis.

Exibir:

```text
Nome
Categoria
Idioma
Tipo de header
Status Meta
Última sincronização
```

Templates não aprovados:

```text
PENDING
REJECTED
PAUSED
DISABLED
```

não devem ser selecionáveis para envio, salvo se o sistema atual possuir regra explicitamente diferente.

---

# PARTE 11 — MÍDIA REAL DA CAMPANHA

Se o template selecionado possuir header de mídia:

## Imagem

Mostrar:

```text
Mídia do cabeçalho

○ Usar arquivo da biblioteca
○ Fazer novo upload

[ Selecionar mídia ]
```

O arquivo escolhido aqui será a mídia efetivamente usada na mensagem enviada.

Não assumir automaticamente que a amostra usada na aprovação é a mídia da campanha.

Pode haver opção:

```text
[ Usar a mesma mídia da amostra ]
```

se ela ainda estiver disponível e for compatível.

---

# PARTE 12 — BIBLIOTECA DE MÍDIA

Se a entidade `media_assets` for criada, permitir seleção simples de arquivos existentes.

Não é necessário criar um DAM complexo.

MVP:

```text
Mídias recentes

[ imagem ] Semana Cliente
[ imagem ] Frete Grátis
[ imagem ] Lançamento
[ documento ] Catálogo.pdf
```

Funções:

- upload;
- selecionar;
- visualizar;
- remover somente se não estiver em uso ou conforme regra segura;
- filtrar por tipo.

Tudo scoped por loja.

---

# PARTE 13 — VARIÁVEIS DA CAMPANHA

Depois de escolher o template:

```text
{{1}}
[ Primeiro nome ▼ ]

{{2}}
[ Valor fixo ▼ ]
[ VOLTE15 ]
```

Fontes desejadas:

```text
Primeiro nome
Nome completo
Cidade
Estado
Último produto comprado
Última categoria comprada
Data da última compra
Quantidade de pedidos
Total gasto
Ticket médio
Valor fixo
Cupom
Data limite
```

Somente oferecer campos que possam ser resolvidos com segurança pelo backend.

Se algum destinatário não tiver valor obrigatório:

- usar fallback configurado;
- ou excluir o destinatário;
- nunca mandar literalmente `{{1}}`.

---

# PARTE 14 — BOTÕES

Manter suporte a botões previstos no sistema atual.

Para campanhas, principalmente:

- URL / visitar site;
- quick reply;
- telefone, se já suportado.

Permitir URL dinâmica somente quando o template aprovado aceitar esse formato.

Não alterar a estrutura de um template aprovado no momento do envio.

---

# PARTE 15 — ENVIO DE TESTE

Adicionar botão:

```text
[ Enviar teste ]
```

Antes do envio, permitir:

```text
Número de teste
Dados de exemplo
Mídia
```

Enviar usando exatamente o mesmo serviço que será usado pela campanha, apenas para um destinatário de teste.

Registrar resultado.

Não criar uma implementação separada e divergente.

---

# PARTE 16 — REVISÃO DA CAMPANHA

Tela obrigatória.

Exemplo:

```text
Revisão da campanha

Reativação clientes 90 dias

Loja
Use Origens

Audiência
4.283 encontrados
419 excluídos
3.864 elegíveis

Template
reativacao_cliente_15off

Categoria
Marketing

Header
Imagem

Mídia
semana-cliente.jpg

Envio
Hoje às 19:00

--------------------------------

Exclusões

238 sem opt-in
104 receberam campanha recentemente
77 números inválidos
```

Botões:

```text
[ Voltar ]
[ Salvar rascunho ]
[ Enviar teste ]
[ Agendar campanha ]
```

ou:

```text
[ Enviar agora ]
```

---

# PARTE 17 — SNAPSHOT DOS DESTINATÁRIOS

Ao confirmar uma campanha:

1. reexecutar os filtros no backend;
2. aplicar exclusões;
3. criar snapshot dos contatos;
4. resolver variáveis;
5. persistir `campaign_recipients`;
6. iniciar/agendar processamento.

Não montar a campanha diretamente a partir da lista que estava no frontend.

---

# PARTE 18 — MODELO DE DADOS DE CAMPANHA

Adaptar ao ORM atual.

Estrutura conceitual:

```text
campaigns
```

Campos:

```text
id
store_id
name
description
template_id
segment_id/null
audience_definition_json
status
scheduled_at/null
started_at/null
finished_at/null
total_matched
total_excluded
total_recipients
created_by
created_at
updated_at
```

---

# CAMPAIGN RECIPIENTS

```text
campaign_recipients
```

Campos conceituais:

```text
id
campaign_id
customer_id
phone_e164

resolved_variables_json
media_asset_id/null

status
provider_message_id/null

queued_at/null
sent_at/null
delivered_at/null
read_at/null
failed_at/null

failure_code/null
failure_message/null

click_count
first_clicked_at/null
last_clicked_at/null

created_at
updated_at
```

Status possíveis:

```text
pending
queued
sending
sent
delivered
read
failed
skipped
opted_out
```

Não substituir `delivered` por `read`. São estados distintos.

---

# PARTE 19 — FILA / WORKERS

**Não fazer um loop síncrono gigante dentro da request HTTP.**

Errado:

```ts
for (const customer of customers) {
  await sendWhatsApp(customer)
}
```

Fluxo esperado:

```text
campaign
   ↓
recipient snapshot
   ↓
queue
   ↓
workers
   ↓
WhatsApp/Meta
   ↓
webhooks
```

Reaproveitar infraestrutura de jobs já existente.

Se o projeto usa scheduler para PIX/carrinho, entender essa implementação antes de criar outra.

---

# REQUISITOS DA FILA

- processamento em lotes;
- retry controlado;
- backoff;
- idempotência;
- prevenção de envio duplicado;
- respeito aos limites do provider;
- logs;
- pause/resume se a arquitetura permitir;
- cancelamento seguro de itens ainda não enviados.

Não deixar a quantidade de mensagens ou taxa hard-coded na UI.

---

# PARTE 20 — IDEMPOTÊNCIA

Cada destinatário da campanha precisa possuir chave única lógica.

Exemplo:

```text
campaign_id + customer_id + phone
```

ou equivalente.

O retry de um job não pode gerar dois envios iguais acidentalmente.

---

# PARTE 21 — WEBHOOKS

Reaproveitar o webhook WhatsApp atual.

Associar eventos recebidos ao `provider_message_id`.

Atualizar:

```text
sent
delivered
read
failed
```

quando suportado pelos eventos recebidos.

Guardar:

- timestamp;
- erro;
- código do provider;
- payload mínimo necessário para auditoria.

Não armazenar dados sensíveis desnecessariamente.

---

# PARTE 22 — CLIQUES

Não presumir que todo clique de botão chegará como webhook de mensagem.

Para URL de campanha, quando possível e compatível com o template, criar URL rastreável do nosso domínio.

Fluxo:

```text
WhatsApp
→ link rastreado
→ registrar click
→ redirect 302
→ URL final
```

Exemplo conceitual:

```text
https://painel.exemplo/r/c/<token>
```

O token não deve expor diretamente:

```text
customer_id
campaign_id
telefone
```

Utilizar identificador opaco, assinado ou aleatório.

Registrar:

```text
campaign
recipient
clicked_at
destination
```

Depois redirecionar.

---

# PARTE 23 — CONVERSÃO / RECEITA

Somente implementar receita atribuída se for possível ligar pedido e campanha com dados confiáveis.

Possibilidades:

- UTM;
- token de clique;
- cupom exclusivo;
- sessão;
- identificador de campanha no pedido.

Não inventar receita com base apenas em leitura da mensagem.

Se ainda não houver atribuição confiável, mostrar a métrica como indisponível.

---

# PARTE 24 — DETALHE/RELATÓRIO DA CAMPANHA

Criar uma página visual de relatório.

Cards:

```text
Destinatários
Enviadas
Entregues
Lidas
Falhas
Cliques
Pedidos
Receita
```

Somente mostrar métricas disponíveis.

## Funil

```text
3.824 destinatários
        ↓
3.761 enviados
        ↓
3.612 entregues
        ↓
2.947 lidos
        ↓
438 cliques
        ↓
73 pedidos
```

## Tabela de destinatários

Colunas:

- Cliente
- Telefone mascarado
- Status
- Enviado em
- Entregue em
- Lido em
- Cliques
- Erro
- Ações

Filtros:

- Todos
- Enviados
- Entregues
- Lidos
- Falhas
- Clicados

Paginação server-side.

---

# PARTE 25 — OPORTUNIDADES DE REMARKETING

Na home de Campanhas, adicionar uma seção opcional, usando consultas reais.

Exemplos:

```text
1.824 clientes
Não compram há mais de 90 dias
[ Criar campanha ]

426 clientes
3 ou mais pedidos
[ Criar campanha ]

783 clientes
Compraram apenas uma vez
[ Criar campanha ]

1.293 clientes
Gastaram mais de R$ 300
[ Criar campanha ]
```

Se uma consulta for cara, não executá-la repetidamente sem cache/otimização.

Esses cards devem abrir `Nova campanha` com filtros pré-preenchidos.

---

# PARTE 26 — UX / DESIGN

Não criar uma tela visualmente isolada do restante do painel.

Reutilizar:

- PageHeader;
- Card;
- Button;
- Input;
- Select;
- Popover;
- Dialog;
- Drawer;
- Badge;
- Table;
- Skeleton;
- EmptyState;
- Toast;
- Tabs;
- DatePicker;
- componentes de gráfico existentes;
- tokens do design system.

Manter o dark theme e o padrão premium já estabelecido.

---

# DROPDOWN DE AMOSTRA DE MÍDIA

Referência visual desejada:

```text
Amostra de mídia • Opcional

┌─────────────────────┐
│ 🖼 Imagem        ▼   │
└─────────────────────┘

┌─────────────────────┐
│ ○ Nenhum            │
│ ● 🖼 Imagem          │
│ ○ ▶ Vídeo           │
│ ○ ▣ Documento       │
│ ○ ⌖ Localização     │
└─────────────────────┘
```

A seleção deve atualizar imediatamente o conteúdo abaixo.

---

# DROPZONE

Visual:

```text
┌───────────────────────────────────────────────────────┐
│                                                       │
│              Arraste e solte para carregar            │
│        Ou escolha arquivos no seu dispositivo         │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Requisitos:

- borda tracejada;
- hover;
- drag active;
- erro visual;
- teclado acessível;
- clique para abrir file picker;
- progresso de upload;
- cancelar se possível;
- trocar;
- remover;
- impedir múltiplos arquivos quando o campo aceita apenas um;
- não disparar upload duplicado por double click.

---

# PARTE 27 — ESTADOS DE ERRO

Tratar explicitamente:

```text
Arquivo não suportado
Arquivo excede limite
Upload interrompido
Falha no storage
Falha no upload Meta
Handle Meta não obtido
Template rejeitado
Template pendente
Credenciais ausentes
Conta WhatsApp desconectada
Número inválido
Destinatário sem opt-in
Variável obrigatória vazia
Mídia incompatível com template
Campanha sem destinatários
Campanha já iniciada
```

Mensagens de erro precisam ser legíveis.

Não exibir stack trace no frontend.

---

# PARTE 28 — SEGURANÇA

Obrigatório:

- todas as consultas por `store_id`/tenant;
- nenhum token Meta no frontend;
- autorização em todas as rotas;
- validar MIME no backend;
- não confiar apenas na extensão;
- sanitizar nomes;
- limitar tamanho de upload;
- impedir path traversal;
- URLs assinadas quando necessário;
- rate limit em endpoints críticos;
- logs sem tokens ou conteúdo sensível;
- não permitir que uma loja acesse assets/templates/campanhas de outra.

---

# PARTE 29 — PERFORMANCE

Não carregar:

```text
todos os clientes
todos os pedidos
todos os recipients
```

no frontend.

Usar:

- paginação;
- filtros server-side;
- agregações SQL;
- índices;
- batches;
- debounce;
- background jobs.

Criar/revisar índices para consultas comuns, por exemplo:

```text
store_id
customer_id
phone
last_order_at
created_at
campaign_id
status
provider_message_id
scheduled_at
```

Somente adicionar índices que façam sentido para o banco atual.

---

# PARTE 30 — MIGRAÇÕES

Qualquer alteração de banco deve possuir migration real.

Não alterar schema manualmente sem migration.

Se houver Prisma/Drizzle/Sequelize/TypeORM/etc., seguir o padrão atual.

Não resetar banco.

Não apagar dados existentes.

---

# PARTE 31 — COMPATIBILIDADE COM TEMPLATES EXISTENTES

Templates já existentes precisam continuar funcionando.

Ao introduzir `sample_media`:

- tratar registros antigos como `NONE`;
- não exigir mídia retroativamente;
- não alterar payload de templates de texto;
- não quebrar sincronização;
- não duplicar templates remotos.

---

# PARTE 32 — SINCRONIZAÇÃO META

A tela de Templates deve continuar exibindo status remoto.

Quando possível:

```text
APPROVED
PENDING
REJECTED
PAUSED
DISABLED
```

Ao criar um template com amostra:

1. validar;
2. fazer upload;
3. obter handle;
4. montar componentes;
5. enviar à Meta;
6. persistir ID/status remoto;
7. mostrar resultado;
8. sincronizar posteriormente.

Não marcar localmente como `APPROVED` sem confirmação da Meta.

---

# PARTE 33 — PREVIEW + PAYLOAD

Criar funções separadas:

```text
buildTemplatePreview()
buildTemplatePayload()
buildCampaignSendPayload()
```

ou equivalentes.

Não montar payload Meta diretamente dentro do componente React.

Frontend coleta configuração.

Backend valida e monta payload final.

---

# PARTE 34 — EXEMPLO DE TEMPLATE COM IMAGE HEADER

Estrutura conceitual, adaptar à versão atual da API:

```json
{
  "name": "reativacao_cliente",
  "language": "pt_BR",
  "category": "MARKETING",
  "components": [
    {
      "type": "HEADER",
      "format": "IMAGE",
      "example": {
        "header_handle": [
          "<HANDLE>"
        ]
      }
    },
    {
      "type": "BODY",
      "text": "Olá {{1}}! Temos uma condição especial para você.",
      "example": {
        "body_text": [
          ["Gabriel"]
        ]
      }
    }
  ]
}
```

Isso é uma referência estrutural.

**Não copiar versionamento antigo da Graph API.**

Usar a versão configurada no projeto.

---

# PARTE 35 — ENVIO REAL COM MEDIA HEADER

Ao enviar o template para o destinatário, o payload é diferente da criação do template.

O envio deve fornecer o parâmetro de header exigido pelo tipo aprovado.

Estrutura conceitual:

```json
{
  "messaging_product": "whatsapp",
  "to": "<PHONE>",
  "type": "template",
  "template": {
    "name": "reativacao_cliente",
    "language": {
      "code": "pt_BR"
    },
    "components": [
      {
        "type": "header",
        "parameters": [
          {
            "type": "image",
            "image": {
              "id": "<MEDIA_ID>"
            }
          }
        ]
      }
    ]
  }
}
```

Confirmar na implementação atual se o projeto usa:

- media ID;
- link;
- outro mecanismo oficialmente aceito.

Não confundir `header_handle` de criação/aprovação com o identificador usado no envio.

---

# PARTE 36 — UPLOAD DE MÍDIA PARA ENVIO

Criar serviço reutilizável, algo como:

```text
WhatsAppMediaService
```

Responsabilidades:

```text
validateAsset()
uploadSampleForTemplate()
uploadMediaForMessage()
resolveMediaReference()
deleteTemporaryAsset()
```

Não colocar essa lógica dentro de controllers gigantes.

---

# PARTE 37 — STATUS E PROGRESSO DE CAMPANHA

Na tela de detalhe:

```text
Enviando 1.842 / 3.864

████████████░░░░ 47%
```

Atualizar por polling moderado, websocket ou mecanismo existente.

Não fazer polling agressivo.

---

# PARTE 38 — AGENDAMENTO

Permitir:

```text
○ Enviar agora
● Agendar
```

Campos:

```text
Data
Hora
Timezone
```

Usar o timezone já configurado para loja/sistema.

No banco, preferir timestamps normalizados conforme padrão atual.

Exibir ao usuário em timezone local.

---

# PARTE 39 — CANCELAMENTO

Campanha agendada:

```text
Cancelamento = imediato
```

Campanha em envio:

- parar novos jobs;
- não tentar desfazer mensagens já enviadas;
- manter histórico;
- status final coerente.

---

# PARTE 40 — DUPLICAR CAMPANHA

Ao duplicar:

copiar:

- nome com sufixo;
- filtros;
- exclusões;
- template;
- mapeamento de variáveis;
- mídia, se ainda disponível.

Não copiar:

- recipients;
- métricas;
- provider message IDs;
- timestamps de envio;
- status.

Nova campanha fica `draft`.

---

# PARTE 41 — TESTES

Criar testes para lógica crítica.

No mínimo:

## Audiência

- ALL
- ANY
- exclusões
- opt-out
- sem telefone
- telefone inválido
- snapshot

## Template

- nenhum
- imagem
- vídeo
- documento
- localização
- mídia inválida
- falha Meta
- payload sem mídia
- payload com amostra

## Campanha

- criar draft
- agendar
- iniciar
- retry
- idempotência
- cancelar
- recipient failed
- webhook delivered/read
- tenant isolation

Não precisa testar pixel por pixel de UI.

---

# PARTE 42 — MIGRAÇÃO SEGURA E FEATURE FLAGS

Se a mudança for grande, pode introduzir feature flag interna.

Não remover as telas atuais antes de validar as novas.

Garantir build funcionando durante a implementação.

---

# PARTE 43 — ORDEM DE IMPLEMENTAÇÃO

Executar nesta sequência:

## Fase 1 — Auditoria

- mapear arquitetura;
- listar arquivos afetados;
- localizar integrações existentes;
- definir reutilização.

## Fase 2 — Amostra de mídia em Templates

- UI;
- uploader;
- storage;
- upload Meta;
- payload;
- persistência;
- preview;
- compatibilidade com templates antigos.

## Fase 3 — Entidades de campanha/segmento

- migrations;
- models;
- services;
- validações.

## Fase 4 — Construtor de audiência

- backend query;
- preview count;
- UI;
- exclusões;
- segmentos.

## Fase 5 — Wizard da campanha

- campanha;
- audiência;
- template;
- mídia;
- variáveis;
- revisão;
- teste;
- agendamento.

## Fase 6 — Queue

- snapshot;
- jobs;
- worker;
- Meta;
- retry;
- idempotência.

## Fase 7 — Webhooks e relatório

- status;
- tabela;
- gráficos;
- falhas;
- clicks.

## Fase 8 — Polimento

- loading;
- empty states;
- errors;
- responsive;
- dark theme;
- acessibilidade;
- testes;
- build.

---

# PARTE 44 — CRITÉRIOS DE ACEITE

A tarefa só está concluída quando:

- [ ] Existe uma área `Campanhas` funcional.
- [ ] É possível criar uma campanha em rascunho.
- [ ] É possível filtrar clientes.
- [ ] A contagem da audiência vem do backend.
- [ ] Exclusões são aplicadas.
- [ ] Opt-out é respeitado.
- [ ] É possível salvar segmentos.
- [ ] É possível selecionar template aprovado.
- [ ] É possível mapear variáveis.
- [ ] Templates podem ter amostra de mídia.
- [ ] A amostra suporta Nenhum, Imagem, Vídeo, Documento e Localização conforme compatibilidade da API.
- [ ] Existe upload real.
- [ ] Arquivos não são salvos em Base64 no banco.
- [ ] A amostra de mídia é enviada corretamente na criação do template.
- [ ] Template antigo continua funcionando.
- [ ] Existe preview da mensagem.
- [ ] Existe envio de teste.
- [ ] Existe tela de revisão.
- [ ] É possível enviar agora.
- [ ] É possível agendar.
- [ ] O envio ocorre por fila/background job.
- [ ] Existe proteção contra duplicidade.
- [ ] Os webhooks atualizam status.
- [ ] Existe detalhe/relatório da campanha.
- [ ] É possível inspecionar falhas.
- [ ] O módulo respeita tenant/store.
- [ ] Nenhum segredo Meta vai para o frontend.
- [ ] O design está consistente com o painel.
- [ ] Build passa.
- [ ] Lint passa.
- [ ] Testes relevantes passam.

---

# PARTE 45 — NÃO FAZER

Não:

- criar dados fake no banco;
- hard-codear loja;
- hard-codear WABA/phone number;
- hard-codear versão Graph;
- colocar token no frontend;
- salvar mídia grande em Base64;
- filtrar milhares de clientes no browser;
- enviar campanha em loop síncrono na request;
- confundir amostra de aprovação com mídia real do envio;
- marcar template como aprovado manualmente;
- ignorar opt-out;
- misturar campanha de marketing com automação transacional;
- quebrar templates existentes;
- duplicar serviços já existentes;
- reescrever o design system;
- criar telas desconectadas do produto.

---

# PARTE 46 — ENTREGA DO CLAUDE

Ao finalizar, responder com:

```text
1. Resumo do que foi implementado
2. Arquivos criados
3. Arquivos alterados
4. Migrations criadas
5. Novas rotas/endpoints
6. Novos serviços/jobs
7. Como funciona o upload de mídia
8. Como funciona a criação do template com amostra
9. Como funciona o envio da campanha
10. Como funciona a fila
11. Como testar manualmente
12. Variáveis de ambiente novas
13. Pontos que dependem de credenciais Meta reais
14. Limitações conhecidas
15. Resultado de build/lint/tests
```

Se houver alguma limitação real da API atual ou da conta Meta conectada, documentar explicitamente. Não simular sucesso.

---

# RESULTADO ESPERADO

Ao final teremos duas evoluções importantes no painel:

```text
TEMPLATES
→ criar template
→ escolher amostra de mídia
→ upload real
→ preview
→ enviar para aprovação Meta

CAMPANHAS
→ criar campanha
→ definir audiência
→ escolher template
→ selecionar mídia real
→ mapear variáveis
→ revisar
→ testar
→ enviar/agendar
→ processar em fila
→ acompanhar entregas/leitura/falhas/cliques
```

A experiência precisa parecer parte nativa do painel existente e estar pronta para crescer como módulo de CRM/retention, sem transformar as automações atuais de PIX e carrinho abandonado em campanhas genéricas.
