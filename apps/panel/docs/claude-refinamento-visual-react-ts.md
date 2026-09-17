# Prompt para Claude — Refinamento Visual Final do Painel React + TypeScript

## Contexto atual

O projeto já foi **migrado para React + TypeScript** e a estrutura funcional principal está pronta.

Neste momento:

- os fluxos principais estão funcionando;
- a integração com a Reserva Ink já está operacional;
- o WhatsApp já está integrado;
- templates, automações, PIX, carrinhos, pedidos e demais fluxos existentes já funcionam;
- os bugs encontrados durante o uso estão sendo corrigidos pontualmente;
- **não quero uma nova reestruturação funcional agora**;
- o foco desta etapa é **elevar significativamente o nível visual, UX e consistência do frontend**.

Ainda existem apenas dois pontos funcionais não concluídos:

1. **Histórico**
2. **Integração com Instagram**

A integração com Instagram **não deve ser implementada nesta tarefa**.

O Histórico pode ser preparado visualmente, mas sua definição funcional está descrita mais abaixo.

---

# Objetivo desta tarefa

Quero que você faça uma **passada completa de refinamento visual no painel inteiro**, agora aproveitando corretamente React + TypeScript, componentes reutilizáveis e bibliotecas maduras.

O objetivo não é simplesmente aplicar dark mode.

O objetivo é transformar o painel em um produto com aparência de:

> **SaaS premium, operacional, moderno e especializado em lojas integradas à Reserva Ink.**

O painel deve parecer um produto comercial maduro.

---

# Regra principal

## NÃO reconstruir o produto

Não refaça:

- regras de negócio;
- integrações existentes;
- contratos de API;
- jobs;
- webhooks;
- fluxos funcionais;
- estados internos que já funcionam;
- backend sem necessidade real.

Preserve o que funciona.

O trabalho agora é:

```text
funcionalidade atual
        ↓
melhor arquitetura visual
        ↓
melhores componentes
        ↓
melhor UX
        ↓
mais consistência
        ↓
mais polimento
```

---

# Skills obrigatórios

Use os skills disponíveis em `.claude/skills/`.

Prioridade:

1. `reference-ui-implementation`
2. `dashboard-ui-director`
3. `design-system-guardian`
4. `responsive-accessibility`
5. `visual-qa-reviewer`

Se o skill oficial `frontend-design` estiver disponível, use também como apoio.

---

# Stack atual

O frontend agora utiliza:

```text
React
TypeScript
```

Aproveite essa migração.

Antes de construir um componente complexo manualmente, avalie se vale utilizar uma biblioteca consolidada.

Preferências:

```text
shadcn/ui + Radix UI
Lucide React
TanStack Table
React Hook Form
Zod
TanStack Query
Recharts
Sonner
dnd-kit
Motion
class-variance-authority
clsx
tailwind-merge
```

## Importante

Não instalar dependências apenas porque existem.

Use biblioteca quando ela trouxer ganho claro de:

- UX;
- acessibilidade;
- manutenção;
- consistência;
- comportamento;
- produtividade.

Bibliotecas fornecem **primitives e comportamento**.

Elas **não devem definir a identidade visual do produto**.

Não quero um painel com aparência default do shadcn.

---

# Direção visual aprovada

A direção aprovada é **dark premium**.

## Base

Usar:

- charcoal;
- blue-black;
- grafite profundo;
- superfícies em diferentes níveis;
- contraste forte;
- cor apenas onde existe intenção.

Referência conceitual:

```text
Background principal
#070D13 / #081019

Sidebar
mais escura que o conteúdo

Surface 1
#0D1721

Surface 2
#111D28

Surface 3
#162430
```

Não utilizar esses valores cegamente.

Ajuste conforme os componentes existentes e os mockups.

---

# Cores semânticas

Usar cores como linguagem operacional.

## Verde

Para:

- sucesso;
- conectado;
- pago;
- entregue;
- ativo;
- ação operacional principal.

## Cyan / azul

Para:

- informação;
- transporte;
- status intermediário;
- dados;
- gráficos;
- tracking.

## Âmbar

Para:

- pendência;
- atenção;
- recuperação;
- PIX pendente;
- ação aguardando usuário.

## Vermelho

Somente para:

- erro;
- falha;
- crítico;
- ação destrutiva;
- reembolso quando semanticamente aplicável.

## Violeta

Pode ser utilizado como:

- acento terciário;
- funcionalidades premium;
- recursos avançados.

Não transformar o painel em uma interface neon multicolorida.

---

# Evitar

Não quero:

- fundo excessivamente claro;
- bege;
- grandes áreas brancas;
- cards enormes com uma informação;
- todos os cards iguais;
- radius exagerado;
- sombra pesada;
- glow em tudo;
- gradients aleatórios;
- glassmorphism excessivo;
- bordas extremamente evidentes;
- excesso de divisórias;
- excesso de cores simultâneas;
- visual de dashboard genérico gerado por IA;
- visual de template pronto;
- layout estilo ERP antigo.

---

# Densidade visual

Este é um painel operacional.

Ele deve aproveitar bem a tela.

Preferir:

```text
controle: 36–42px
row de tabela: 48–56px
cards: compactos
padding interno: 16–24px
gap entre grandes seções: 24–32px
```

Evitar:

```text
input de 60px
cards com 200px de altura sem necessidade
áreas vazias gigantes
textos muito grandes
```

---

# Tipografia

Usar uma sans moderna.

Se já houver uma definida, mantenha se fizer sentido.

Boas referências:

```text
Geist
Inter
Manrope
```

Hierarquia aproximada:

```text
Page title: 24–28px
Section title: 17–20px
Card title: 14–16px
Body: 13–14px
Table: 13–14px
Metadata: 11–12px
```

Não usar serif.

Não exagerar em uppercase.

---

# Primeiro passo: auditoria visual do projeto atual

Antes de alterar o layout:

1. rode a aplicação;
2. abra todas as páginas disponíveis;
3. capture screenshots das páginas principais;
4. identifique padrões visuais inconsistentes;
5. identifique componentes duplicados;
6. identifique CSS local que deveria estar no design system;
7. identifique componentes que ainda carregam decisões visuais do HTML antigo.

Não assuma que o código migrado para React já possui boa arquitetura visual.

A migração técnica não significa que o design system esteja finalizado.

---

# O que revisar globalmente

Analise:

## Shell

- sidebar;
- topbar;
- largura máxima;
- padding;
- background;
- responsividade.

## Tipografia

- títulos;
- subtítulos;
- labels;
- metadata;
- tabelas;
- hierarquia.

## Componentes

- buttons;
- icon buttons;
- inputs;
- selects;
- textareas;
- dropdowns;
- badges;
- cards;
- tabs;
- tables;
- pagination;
- modais;
- drawers;
- tooltips;
- toasts.

## Estados

- loading;
- skeleton;
- empty;
- error;
- success;
- disabled.

## UX

- ações primárias;
- ações secundárias;
- ações destrutivas;
- filtros;
- busca;
- menus;
- detalhes.

---

# Design system

Centralize os tokens.

Evite valores repetidos espalhados pelas páginas.

Exemplo conceitual:

```css
--app-background
--sidebar-background

--surface-1
--surface-2
--surface-3
--surface-hover

--border
--border-strong

--text-primary
--text-secondary
--text-muted

--success
--info
--warning
--danger
--premium

--radius-sm
--radius-md
--radius-lg

--shadow-sm
--shadow-md
```

---

# Hierarquia das superfícies

O dark mode deve possuir profundidade.

Não usar o mesmo tom escuro em tudo.

Exemplo:

```text
App background
    ↓
Surface principal
    ↓
Card
    ↓
Hover / selected
    ↓
Popover / modal / drawer
```

A profundidade deve ser percebida mais por:

- tom;
- borda;
- contraste;
- spacing;

e menos por sombras pesadas.

---

# Sidebar

A sidebar deve parecer parte importante da identidade do produto.

Revisar:

- largura;
- ícones;
- spacing;
- seção ativa;
- grupos;
- hover;
- submenu;
- estado bloqueado por plano;
- footer;
- conta.

Estrutura desejada:

```text
Visão Geral

OPERAÇÃO
Pedidos
Trocas e Devoluções
Recuperação
Clientes

CATÁLOGO
Produtos
Categorias
Agrupamentos
Promoções

WHATSAPP
Visão Geral
Automações
Templates
Histórico

INSTAGRAM
Visão Geral
Automações
Comentários
Histórico

FINANCEIRO
Resumo
Movimentações
Reembolsos

FERRAMENTAS
Simular Frete
PIX

SISTEMA
Integrações
Webhooks e Logs
Variáveis
Configurações
```

Os módulos de WhatsApp e Instagram devem permanecer separados.

O produto pode possuir planos:

```text
WhatsApp
Instagram
WhatsApp + Instagram
```

---

# Topbar

Revisar:

- busca;
- breadcrumb;
- notificações;
- avatar;
- menu da conta;
- integração/health quando aplicável.

Não ocupar altura desnecessária.

---

# PageHeader

Criar/ajustar componente compartilhado.

Exemplo:

```tsx
<PageHeader
  title="Pedidos"
  description="Acompanhe pedidos, produção, entrega e pós-venda."
  actions={...}
/>
```

O PageHeader precisa ser consistente em todo o sistema.

---

# Cards

Não usar cards como solução padrão para tudo.

Usar para:

- KPI;
- agrupamento semântico;
- alertas;
- resumo;
- ferramenta;
- dados visuais.

Evitar:

```text
card dentro de card
dentro de card
dentro de card
```

---

# KPI Cards

Devem ser compactos.

Exemplo:

```text
Pedidos
128

↑ 12%
vs período anterior
```

Não ocupar uma grande seção da tela.

---

# Tabelas

As tabelas são essenciais neste produto.

Quando necessário, usar TanStack Table.

Padronizar:

- header;
- row height;
- hover;
- seleção;
- status;
- ações;
- loading;
- empty;
- pagination.

A tabela deve ser legível rapidamente.

Evitar excesso de colunas.

Informações secundárias podem ir para drawer.

---

# Drawers

Use drawer para contexto.

Exemplos:

```text
Pedido
Cliente
Carrinho
PIX
Template
Automação
Produto
Webhook
Log
```

Desktop:

```text
520–680px
```

Não navegar para página inteira quando a ação é apenas consultar detalhes rápidos.

---

# Buttons

Padronizar:

```text
primary
secondary
ghost
danger
```

Não usar botão preenchido para toda ação.

A hierarquia deve ficar clara.

---

# Forms

Como agora estamos em React:

usar quando fizer sentido:

```text
React Hook Form
Zod
```

Melhorar:

- labels;
- helper;
- validation;
- spacing;
- agrupamento.

Não manter formulários visualmente herdados do HTML antigo apenas por compatibilidade.

---

# Toasts

Preferência:

```text
Sonner
```

Padronizar mensagens de:

- sucesso;
- falha;
- warning.

Evitar alert().

---

# Ícones

Usar um único sistema.

Preferência:

```text
Lucide React
```

Padronizar:

```text
16px
18px
20px
```

dependendo do contexto.

Não misturar famílias de ícones.

---

# Charts

Se houver gráfico:

preferência:

```text
Recharts
```

Gráfico deve responder uma pergunta.

Não adicionar gráfico apenas como decoração.

---

# Página Visão Geral

Esta deve funcionar como cockpit operacional.

Estrutura preferida:

```text
PageHeader

KPI strip

Precisa da sua atenção

Fluxo operacional

Receita / recuperação

Saúde das integrações

Atividade recente
```

Não voltar para cards gigantes.

---

# Pedidos

Prioridade visual alta.

Deve ser uma página eficiente.

Preferir:

```text
PageHeader

Search + filters

DataTable

Order drawer
```

Ações contextuais.

---

# Trocas e Devoluções

Melhorar:

- status;
- filtros;
- tabela;
- visual do wizard;
- evidências;
- review.

Não criar visual diferente do restante do produto.

---

# Recuperação

Tabs:

```text
Carrinhos
PIX pendentes
```

KPIs compactos.

Tabela.

Drawer para detalhes.

Usar âmbar como cor semântica predominante da recuperação.

---

# Clientes

Tabela limpa.

Drawer com:

```text
Resumo
Pedidos
Comunicação
Carrinhos
Trocas
```

Não transformar em CRM complexo.

---

# Produtos

Pode utilizar:

- table;
- thumbnail;
- status;
- variants;
- categories.

Bulk action bar quando houver seleção.

---

# Categorias

Melhorar:

- tabela;
- contagem;
- visibilidade;
- status;
- ordenação;
- associação de produtos.

---

# Agrupamentos

Usar visual fácil de compreender:

```text
Estampa / cluster
Produto principal
Produtos associados
```

---

# Promoções

Visual deve diferenciar:

```text
ativa
agendada
expirada
```

Sem exagerar nas cores.

---

# WhatsApp

Manter módulo visualmente próprio, mas dentro do mesmo design system.

Pode utilizar verde como acento local.

Não transformar toda a página em verde.

---

# WhatsApp — Visão Geral

Mostrar:

```text
status da conexão
mensagens
entregues
lidas
falhas
templates
automações
```

---

# WhatsApp — Automações

Melhorar o visual dos fluxos.

Preferir cards de etapas em stack vertical.

Exemplo:

```text
Trigger
↓
Delay
↓
Condition
↓
WhatsApp Action
↓
Stop condition
```

Não implementar React Flow nesta etapa apenas por estética.

---

# WhatsApp — Templates

A página deve ter:

- boa tabela;
- status Meta;
- filtros;
- ações.

Template Builder deve possuir:

```text
Editor | Preview
```

---

# Histórico — definição recomendada

Hoje esta funcionalidade ainda não está concluída.

Minha recomendação é:

## WhatsApp > Histórico

Ser o **histórico real de execuções e envios de comunicação**.

Não é um log técnico de webhook.

Deve responder:

> “O que foi enviado, para quem, por quê e qual foi o resultado?”

Tabela:

```text
Data/Hora
Cliente
Telefone
Template
Origem
Automação
Status
```

Origem:

```text
Manual
Automação
Pedido
PIX
Carrinho
```

Status:

```text
Agendado
Enviado
Entregue
Lido
Falhou
Cancelado
```

Ao clicar:

abrir drawer.

Drawer:

```text
Cliente
Telefone

Template utilizado

Mensagem renderizada

Origem
Automação

Evento que disparou

Status

Timeline:
Agendado
Enviado
Entregue
Lido

Detalhes técnicos
```

`Detalhes técnicos` deve ficar recolhido.

Ali sim mostrar:

```text
message_id
payload
response
error
HTTP status
timestamps
```

Portanto:

```text
Webhooks e Logs
```

continua sendo infraestrutura.

```text
Histórico
```

é operação/comunicação.

---

# Instagram

Ainda não implementar nesta tarefa.

A arquitetura visual pode permanecer preparada.

Não misturar histórico do Instagram com WhatsApp.

Quando Instagram for implementado:

```text
Instagram > Histórico
```

deverá seguir o mesmo conceito:

```text
comentário
resposta
DM
automação
status
origem
```

mas em módulo separado.

---

# Financeiro

Refinar:

- saldo;
- movimentações;
- reembolsos.

Não virar ERP.

---

# Simular Frete

Página pequena.

Não ocupar viewport inteira com formulário.

Mostrar resultado de forma compacta.

---

# PIX

A ferramenta PIX precisa possuir boa hierarquia visual.

Elementos:

```text
QR Code
Valor
Expiração
Copia e cola
Ações
Status
```

---

# Integrações

Cards de integração devem mostrar claramente três conceitos separados:

```text
Disponível no plano?
Conectado?
Saudável?
```

Exemplo:

```text
WhatsApp
Incluído no plano
Conectado
Saudável

Instagram
Não incluído no plano
```

ou:

```text
Instagram
Incluído
Não conectado
```

---

# Webhooks e Logs

Esta é uma área técnica.

Usar:

```text
Eventos recebidos
Execuções
Falhas
```

Tabelas densas.

Payload no drawer.

Não exibir JSON enorme diretamente na tela.

---

# Variáveis

Melhorar UX da tela.

Separar:

```text
Sistema
Personalizadas
```

Busca.

Tabela.

Preview.

---

# Configurações

Evitar uma página com dezenas de cards desconectados.

Agrupar por tabs ou seções:

```text
Geral
Conta
Plano
Integrações
Segurança
```

---

# Microinterações

Agora que estamos em React, adicionar apenas quando agregarem qualidade.

Exemplo:

```text
hover sutil
transition de drawer
collapse
tab indicator
status transition
loading
```

Motion pode ser usado pontualmente.

Evitar animação constante.

---

# Responsividade

Revisar pelo menos:

```text
1920
1440
1280
1024
768
```

Principal foco:

desktop.

Mas não permitir quebra grave nos demais.

---

# Bugs encontrados durante a revisão

Se durante o refinamento visual você encontrar:

- erro de layout;
- componente quebrado;
- estado visual impossível;
- erro React simples;
- problema de responsividade;
- botão visualmente inacessível;
- overflow;
- warning relacionado ao frontend;

pode corrigir.

Se encontrar problema que exija alterar regra de negócio ou backend:

documente primeiro.

Não deixe a tarefa de visual virar uma refatoração funcional ampla.

---

# Workflow por página

Para cada página:

## 1

Abrir implementação atual.

## 2

Capturar screenshot.

## 3

Comparar com mockup/direção aprovada.

## 4

Listar maiores problemas.

## 5

Identificar quais pertencem ao design system.

## 6

Corrigir componentes compartilhados primeiro.

## 7

Corrigir página.

## 8

Capturar nova screenshot.

## 9

Executar:

```text
visual-qa-reviewer
```

## 10

Corrigir os 5 maiores gaps.

## 11

Capturar screenshot final.

---

# Visual QA

Não avalie o resultado apenas olhando o código.

Avalie a interface renderizada.

Critérios:

```text
hierarquia
composição
spacing
densidade
alinhamento
tipografia
contraste
cor
componentes
estados
responsividade
identidade
```

---

# Critério final

Ao terminar, o painel deve parecer:

> **um produto desenhado intencionalmente como SaaS premium dark.**

Não deve parecer:

> **o antigo painel HTML migrado para React e pintado de preto.**

A migração para React + TypeScript deve ser perceptível também na qualidade da experiência:

- componentes melhores;
- comportamento melhor;
- design system melhor;
- consistência melhor;
- estados melhores;
- interações melhores;
- visual melhor.

---

# Escopo atual

## Fazer agora

```text
Auditoria visual
Design system
Componentes globais
Sidebar
Topbar
Dashboard
Todas as páginas já funcionais
Responsividade
Visual QA
Polimento
```

## Pode preparar visualmente

```text
WhatsApp > Histórico
```

com base na definição deste documento.

## Não fazer agora

```text
Integração Instagram
Nova arquitetura backend
Novos fluxos de negócio
Novas features não solicitadas
```

---

# Entrega esperada

Ao final da tarefa me entregue:

## 1. Auditoria inicial

Principais problemas encontrados.

## 2. Design system

Tokens e componentes alterados.

## 3. Componentes compartilhados

Lista dos componentes refatorados.

## 4. Páginas

Lista das páginas revisadas.

## 5. Antes e depois

Screenshots comparativas das principais páginas.

## 6. Visual QA

Principais problemas encontrados e corrigidos após a primeira implementação.

## 7. Bugs

Bugs de frontend encontrados durante o trabalho e corrigidos.

## 8. Pendências

O que ainda ficou pendente.

Instagram deve constar explicitamente como:

```text
fora do escopo desta etapa
```

---

# Prioridade de execução

Seguir esta ordem:

```text
1. Design system
2. App shell
3. Sidebar
4. Topbar
5. Visão Geral
6. Pedidos
7. Recuperação
8. Clientes
9. Produtos
10. Categorias
11. Agrupamentos
12. Promoções
13. WhatsApp
14. Trocas
15. Financeiro
16. Ferramentas
17. Integrações
18. Logs
19. Variáveis
20. Configurações
21. Histórico
22. Revisão final completa
```

A prioridade é **qualidade visual e consistência**, não velocidade de alterar o maior número de arquivos.
