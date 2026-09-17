# Claude Code — Refinamento Visual Completo do Painel React + TypeScript

## Contexto

O painel já foi migrado para **React + TypeScript** e está funcional.

Neste momento, o objetivo **não é reconstruir funcionalidades nem refazer arquitetura de negócio**. O foco desta tarefa é fazer uma revisão e um refinamento visual completo, transformando o frontend atual em um produto SaaS dark premium, consistente, denso, moderno e comercialmente apresentável.

A aplicação atual possui **aproximadamente 29 páginas/rotas**, além de estados internos como modais, drawers, wizards e tabs.

As screenshots fornecidas representam o **estado atual/baseline** do painel.

Elas **não são o target visual final**.

A direção visual aprovada é a dos mockups dark premium já definidos anteriormente.

---

# Estado funcional atual

Considere como premissa:

- frontend migrado para React + TypeScript;
- integração Reserva Ink funcional;
- WhatsApp funcional;
- pedidos funcionando;
- trocas/devoluções funcionando;
- recuperação funcionando;
- estoque funcionando;
- catálogo funcionando;
- produtos funcionando;
- categorias funcionando;
- agrupamentos funcionando;
- promoções funcionando;
- automações funcionando;
- templates funcionando;
- financeiro funcionando;
- reembolsos funcionando conforme limitações atuais;
- simulador de frete funcionando;
- PIX funcionando;
- variáveis/campos funcionando;
- webhooks/logs funcionando;
- integrações funcionando;
- configurações funcionando.

Bugs encontrados durante o refinamento podem ser corrigidos, desde que sejam locais e não alterem regras de negócio.

Ainda pendentes funcionalmente:

- **Histórico do WhatsApp**
- **Integração com Instagram**

A integração com Instagram fica **fora do escopo desta tarefa**.

O Histórico pode receber estrutura visual preparada, conforme especificação deste documento.

---

# Regra central

## Preservar funcionalidade. Refatorar experiência.

Não preserve HTML/CSS legado só porque já existe.

Preserve:

- regras de negócio;
- chamadas de API;
- contratos;
- fluxos;
- permissões;
- validações;
- webhooks;
- jobs;
- dados;
- comportamento funcional.

Pode refatorar:

- layout;
- componentes;
- estrutura visual;
- design tokens;
- tabelas;
- filtros;
- modais;
- drawers;
- formulários;
- hierarquia;
- microinterações;
- responsividade;
- estados visuais.

---

# Skills obrigatórios

Use os skills disponíveis em `.claude/skills/`.

Ordem preferencial:

1. `reference-ui-implementation`
2. `dashboard-ui-director`
3. `design-system-guardian`
4. `responsive-accessibility`
5. `visual-qa-reviewer`

Se o skill oficial `frontend-design` estiver disponível, use-o também.

---

# Não faça outro planejamento longo

Já existe planejamento suficiente.

Antes de alterar código faça apenas:

1. inventário real das rotas;
2. inventário dos componentes compartilhados;
3. inventário dos estilos/tokens existentes;
4. identificação das dependências frontend já instaladas;
5. uma lista curta dos componentes globais que precisam ser corrigidos primeiro.

Depois disso, **comece a implementação**.

---

# PASSO 0 — Descobrir as 29 páginas reais pelo código

Não confie apenas na lista deste documento.

Leia o roteamento da aplicação e gere uma tabela interna:

```text
rota
componente
grupo de navegação
tipo de página
usa tabela?
usa form?
usa modal?
usa drawer?
estado atual
```

Valide quantas rotas existem realmente.

Foram fornecidas screenshots de aproximadamente 25 estados/páginas, mas o código possui cerca de 29.

As rotas restantes devem ser identificadas automaticamente pelo projeto.

## Rotas já observadas nas screenshots

```text
/admin/dashboard
/admin/pedidos-central
/admin/trocas
/admin/recuperacao
/admin/estoque
/admin/produtos
/admin/produtos/novo
/admin/categorias
/admin/agrupamentos
/admin/promocoes
/admin/whatsapp
/admin/automacoes
/admin/templates
/admin/templates/detalhe
/admin/financeiro
/admin/reembolsos
/admin/simular-frete
/admin/pix
/admin/pedidos/vincular
/admin/campos
/admin/eventos
/admin/integracoes
/admin/configuracoes
```

Existem também estados internos importantes:

```text
modal de nova categoria
modal de nova promoção
wizard de novo produto
detalhe de template
tabs do financeiro
tabs da recuperação
tabs/estados de estoque
```

Descubra pelo código as demais rotas/estados.

---

# Diagnóstico visual do baseline atual

As screenshots mostram uma base funcional coerente, porém ainda com aparência de:

> admin interno funcional com dark theme

e não ainda:

> produto SaaS premium especializado em operação de lojas.

Os principais problemas globais são:

---

## 1. Hierarquia insuficiente entre superfícies

Atualmente:

- fundo;
- cards;
- tabelas;
- inputs;
- headers;
- blocos internos;

ficam muito próximos em tom.

Resultado:

- pouca profundidade;
- pouca separação hierárquica;
- sensação de bloco escuro contínuo.

Corrigir com uma escala de superfícies real.

---

## 2. Verde ativo excessivamente dominante

O item ativo da sidebar hoje recebe um bloco verde muito forte.

Isso cria competição visual com:

- CTA;
- status;
- alertas;
- conteúdo principal.

Novo comportamento:

```text
background ativo = verde muito escuro / tonalidade de surface
texto = verde
ícone = verde
indicador lateral = verde
borda = sutil
```

Evitar preencher toda a largura com verde saturado.

---

## 3. Tabelas ainda parecem "database views"

Hoje várias páginas funcionam como grandes tabelas escuras.

Isso afeta:

- Pedidos
- Trocas
- Estoque
- Produtos
- Categorias
- Agrupamentos
- Promoções
- Templates
- Financeiro
- Webhooks e logs

As tabelas precisam ganhar:

- melhor header;
- melhor densidade;
- hover;
- estados;
- alinhamento numérico;
- ações contextuais;
- filtros;
- leitura rápida;
- row click quando existir detalhe;
- menu `...` para ações secundárias/destrutivas;
- loading;
- empty;
- error.

---

## 4. Ações destrutivas aparecem demais

Exemplo visível:

```text
Excluir
Excluir
Excluir
Excluir
```

em cada linha de:

- Promoções
- Templates

Isso gera ruído e coloca destruição no mesmo nível de ações normais.

Mover normalmente para:

```text
...
  Editar
  Duplicar
  Ver detalhes
  ─────────
  Excluir
```

Vermelho deve aparecer somente após intenção explícita.

---

## 5. Grandes áreas vazias

Exemplos claros:

- WhatsApp visão geral;
- Reembolsos;
- Simular frete;
- PIX;
- Integrações;
- Configurações.

Não é necessário inventar novas features.

Use melhor o viewport com:

- contexto;
- estado;
- histórico recente já disponível;
- resumo;
- instrução curta;
- painel lateral;
- ações relacionadas;
- empty state intencional.

---

## 6. Componentes ainda muito genéricos

Exemplos:

- modais;
- inputs;
- selects;
- radio groups;
- tabelas;
- cards;
- botões;
- tabs.

A migração para React + TS deve resultar em componentes melhores e mais consistentes.

---

## 7. Linguagem técnica vazando para interface

Exemplos observados:

```text
in_progress
waiting_for_approval
completed
payment.approved
shipping.delivery_in_progress
```

Sempre que o valor for destinado ao usuário final do painel, apresentar label humana.

Exemplo:

```text
in_progress → Em andamento
waiting_for_approval → Aguardando análise
completed → Concluída
payment.approved → Pagamento aprovado
```

O valor técnico pode continuar existindo internamente.

Em Webhooks e Logs, valores técnicos são aceitáveis.

---

# Direção visual final

## Produto

O painel deve parecer:

> um SaaS operacional premium para lojas integradas à Reserva Ink.

Referências conceituais:

- Linear
- Vercel
- Stripe Dashboard
- modern fintech/admin SaaS
- dark operational interfaces

Não copiar nenhum produto.

Usar somente como referência de:

- acabamento;
- densidade;
- hierarquia;
- consistência.

---

# Paleta

Base aproximada:

```css
--bg-app: #070D13;
--bg-sidebar: #050B10;

--surface-1: #0D1721;
--surface-2: #111D28;
--surface-3: #162430;

--surface-hover: rgba(255,255,255,.035);
--surface-selected: rgba(53,208,127,.08);

--border: rgba(255,255,255,.07);
--border-strong: rgba(255,255,255,.12);

--text-primary: #F5F7FA;
--text-secondary: #AAB4C0;
--text-muted: #6F7B88;

--success: #35D07F;
--info: #35B9E9;
--warning: #F1A51A;
--danger: #F05252;
--premium: #8B5CF6;
```

Ajustar visualmente.

Não transformar isso em neon.

---

# Cor semântica

## Verde

- sucesso;
- conectado;
- pago;
- entregue;
- ativo;
- CTA principal.

## Cyan / azul

- informação;
- transporte;
- tracking;
- status intermediário.

## Âmbar

- aguardando;
- pendente;
- PIX;
- recuperação;
- atenção.

## Vermelho

- falha;
- crítico;
- cancelado;
- destrutivo.

## Violeta

- premium;
- recursos avançados;
- acento terciário.

---

# Tipografia

Preferência:

```text
Geist
Inter
Manrope
```

Se o projeto já tiver uma boa sans, pode manter.

Escala aproximada:

```text
Page title       24–28
Section title    17–20
Card title       14–16
Body             13–14
Table            13–14
Metadata         11–12
```

Evitar títulos enormes.

---

# Densidade

Este é software operacional.

Preferir:

```text
control height: 36–42px
table row: 48–56px
card padding: 16–20px
section gap: 24–32px
page gutter: 24–32px
```

---

# Arquitetura dos componentes

Antes de corrigir páginas individualmente, consolidar:

```text
AppShell
Sidebar
Topbar
PageHeader
SectionHeader

Button
IconButton
Input
Select
Textarea
SearchInput
DateInput

Tabs
Badge
StatusBadge
Tooltip
DropdownMenu
Popover

Card
KpiCard
AlertCard
EmptyState
ErrorState
Skeleton

FilterBar
DataTable
Pagination
BulkActionBar

Modal
Drawer
Sheet
ConfirmDialog

Timeline
Stepper
Metric
```

---

# Bibliotecas

O projeto é React + TypeScript.

Use libs maduras quando houver ganho real.

Preferências:

```text
shadcn/ui + Radix
Lucide React
TanStack Table
React Hook Form
Zod
TanStack Query
Recharts
Sonner
dnd-kit
Motion
CVA
clsx
tailwind-merge
```

Não instalar tudo automaticamente.

Não duplicar biblioteca para mesma função.

---

# FASE 1 — Foundation visual

Fazer primeiro:

```text
tokens
typography
surface system
borders
radius
shadows
semantic colors
spacing
controls
focus states
hover states
disabled states
loading states
```

Depois:

```text
AppShell
Sidebar
Topbar
PageHeader
```

## Sidebar

Manter organização atual, mas melhorar:

- active state;
- grupos;
- tipografia;
- espaçamento;
- ícones;
- badges “Em breve”;
- footer;
- scroll;
- collapse se já existir ou for simples de adicionar.

Não remover funcionalidade multi-loja existente nesta etapa.

---

# FASE 2 — Componentes operacionais

Refatorar:

```text
Button
Input
Select
Tabs
StatusBadge
Card
KpiCard
FilterBar
DataTable
Pagination
Modal
Drawer
EmptyState
Skeleton
Toast
```

Só depois migrar as páginas.

---

# FASE 3 — Páginas operacionais prioritárias

## 3.1 Visão Geral

Baseline atual:

- bloco “Precisa da sua atenção”;
- 4 KPIs;
- fluxo de pedidos;
- carrinhos quentes;
- integrações.

Melhorar para cockpit operacional.

Estrutura desejada:

```text
PageHeader

KPI strip

Precisa da sua atenção
Fluxo de pedidos
Receita/recuperação

Carrinhos quentes
Canais e integrações
Atividade recente
```

Evitar grandes cards vazios.

KPIs compactos.

Adicionar sparkline somente se os dados já existirem ou forem fáceis de derivar.

Não fabricar métrica.

---

## 3.2 Pedidos

Baseline bom funcionalmente.

Melhorar:

- filtros;
- tabela;
- labels de status;
- row hover;
- ações;
- detail drawer;
- paginação.

Evitar navegar para página nova para consulta rápida se drawer resolver.

---

## 3.3 Pedidos / Vincular PIX

Rota observada:

```text
/admin/pedidos/vincular
```

Problemas atuais:

- dois blocos muito largos;
- formulário ocupa largura excessiva;
- tabela pequena dentro de card gigante.

Melhorar:

```text
lado esquerdo:
PIX pendentes

lado direito:
vincular manualmente
```

ou outra composição responsiva equivalente.

Priorizar lista recente.

---

## 3.4 Trocas e devoluções

Melhorar:

- labels humanos;
- status;
- filtros;
- CTA;
- linha clicável;
- drawer;
- wizard de nova troca.

Não mostrar valores técnicos como label principal.

---

## 3.5 Recuperação

É uma das melhores bases atuais.

Manter conceito:

```text
KPIs
tabs
filtros
tabela
```

Melhorar:

- hierarquia;
- badges;
- ações;
- tentativas;
- preview contextual;
- drawer.

Âmbar pode ser o acento local sem dominar o produto.

---

## 3.6 Estoque

Diferenciar visualmente:

```text
disponível
baixo
zero
negativo
```

Não depender somente de cor.

Reduzir texto técnico introdutório.

Mover explicações extensas para:

```text
tooltip
info popover
helper
```

---

# FASE 4 — Catálogo

## 4.1 Produtos

Manter thumbnails.

Melhorar:

- status;
- visibilidade;
- variantes;
- atualização;
- row actions;
- bulk actions quando aplicável.

Se `controle-estoque` for produto interno/técnico, tratar visualmente como tal.

---

## 4.2 Novo produto

Essa página precisa de refinamento maior.

Baseline:

- stepper existe;
- etapa “Tipo” é uma longa lista de radio buttons;
- muito espaço vazio.

Transformar tipos em seleção visual compacta.

Exemplo:

```text
[ camiseta ]
[ oversized ]
[ infantil ]
[ body ]
[ moletom ]
```

com:

- ícone/thumbnail quando disponível;
- descrição curta;
- selected state.

Preservar wizard e regras atuais.

---

## 4.3 Categorias

Baseline está muito próximo de database view.

Melhorar:

- status de visibilidade;
- ações por linha;
- ordenação;
- contagem;
- modal.

Modal “Nova categoria”:

- manter simples;
- melhorar spacing;
- switch/checkbox;
- CTA;
- helper.

---

## 4.4 Agrupamentos

É uma das páginas que mais precisa de ganho semântico.

Hoje exibe basicamente IDs.

Se os dados disponíveis permitirem, mostrar:

```text
thumbnail
nome/produto de vitrine
produto principal
quantidade associada
status
```

Nunca inventar dado que API não forneça.

Quando só houver ID, apresentar ID como metadata, não necessariamente elemento principal.

---

## 4.5 Promoções

Problema crítico:

```text
Excluir
```

visível em toda linha.

Mover destrutivo para menu contextual.

Melhorar:

- tipo;
- desconto;
- período;
- status;
- utilização.

Modal de nova promoção:

usar campos condicionais.

Exemplo:

ao escolher:

```text
Desconto simples
```

mostrar somente campos relevantes.

---

# FASE 5 — WhatsApp

## 5.1 Visão Geral

Baseline atual possui muitos vazios.

Usar dados já disponíveis para estruturar:

```text
status da conexão

mensagens enviadas
respostas
falhas
fila

templates aprovados
automações ativas

atividade recente
falhas recentes
```

Não fabricar entrega/leitura se Meta não fornece atualmente.

A observação técnica atualmente exibida na página não deve dominar o layout.

Mover para:

```text
info tooltip
help card
documentação contextual
```

---

## 5.2 Automações

Hoje a tela parece documentação técnica.

Transformar em software operacional.

Manter regra atual:

```text
evento
template
manual/automático
janela
```

Representar melhor a sequência:

```text
Trigger
↓
Condition/Delay
↓
Action
```

Não implementar React Flow apenas por estética.

Stack vertical é suficiente.

---

## 5.3 Templates

Remover “Excluir” vermelho de cada linha.

Usar:

```text
...
Ver
Duplicar
Vínculo
Excluir
```

Melhorar:

- status Meta;
- categoria;
- idioma;
- automação associada.

---

## 5.4 Detalhe do Template

Hoje existem blocos funcionais:

```text
conteúdo
teste
duplicar
excluir
vínculo com evento
```

Separar visualmente:

```text
Resumo
Preview
Teste
Automação
Ações
```

Preview deve se aproximar visualmente do WhatsApp.

Não editar texto aprovado diretamente se regra atual não permite.

---

## 5.5 Histórico

Ainda não implementado.

Preparar arquitetura visual.

Objetivo:

> O que foi enviado, para quem, por quê e qual foi o resultado?

Tabela:

```text
Data
Cliente
Telefone
Template
Origem
Automação
Status
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

Somente usar status realmente disponíveis.

Drawer:

```text
Cliente
Telefone
Template
Mensagem renderizada
Origem
Automação
Evento
Timeline
Detalhes técnicos
```

Detalhes técnicos recolhidos.

Histórico ≠ Webhooks e Logs.

---

# FASE 6 — Financeiro e Ferramentas

## 6.1 Financeiro

Manter simples.

Não virar ERP.

Melhorar:

```text
saldo disponível
saldo pendente
movimentações
antecipações
saques
```

Melhor hierarquia nos valores.

Tabela mais refinada.

---

## 6.2 Reembolsos

Baseline atual é praticamente empty state.

Melhorar empty state.

Composição:

```text
PageHeader
Busca de pedido
Contexto/explicação curta
Empty state / resultado
```

Quando buscar pedido, mostrar detalhe em painel/drawer.

---

## 6.3 Simular Frete

Evitar card ocupando quase toda largura para:

```text
CEP
Calcular
```

Composição preferida:

```text
form compacto
resultado ao lado/abaixo
```

Quando não houver resultado, não criar bloco gigante.

---

## 6.4 PIX

Hoje funciona como menu de quatro cards.

Melhorar hierarquia:

principal:

```text
Pedidos PIX
```

secundário:

```text
Cadastrar manualmente
Vincular pedido
Recuperação
```

Cards não precisam ter o mesmo peso.

---

# FASE 7 — Sistema

## 7.1 Variáveis / Campos personalizados

Rota observada:

```text
/admin/campos
```

Página atualmente muito longa e form-heavy.

Melhorar:

```text
header
novo campo
lista de campos
drawer/modal de edição
preview de variáveis
```

Evitar deixar todos os campos existentes editáveis ao mesmo tempo se não for necessário.

Se funcionalidade atual depende disso, preservar, mas melhorar agrupamento.

---

## 7.2 Webhooks e logs

Esta é área técnica.

Valores técnicos podem permanecer.

Melhorar:

```text
filters
table
status
drawer
payload
verification
```

Payload e resposta devem abrir no drawer.

Não despejar JSON na tabela.

---

## 7.3 Integrações

Hoje:

```text
Reserva Ink
WhatsApp
```

e futuramente Instagram.

Cada integração deve comunicar:

```text
Disponível?
Conectada?
Saudável?
Última atividade?
```

Sem confundir estes conceitos.

Cards melhores.

---

## 7.4 Configurações

Baseline possui um grande card com poucas opções.

Organizar para crescer.

Estrutura:

```text
Geral
Conta
Plano
Integrações
Segurança
```

Pode usar tabs.

Não adicionar campos fictícios.

---

# Instagram

Fora do escopo funcional desta tarefa.

Apenas garantir que:

- sidebar suporta módulo;
- design system suporta acento do Instagram;
- cards de integração conseguem exibir Instagram;
- estados locked / não conectado / em breve são consistentes.

Não implementar API do Instagram agora.

---

# Multi-loja

O frontend atual possui seletor de loja e configuração multi-loja.

Nesta tarefa:

- não remover;
- não alterar regra;
- apenas melhorar visual e consistência.

Se futuramente o produto SaaS passar a operar uma loja por conta, isso será outra decisão de produto.

---

# Busca global

Existe visualmente no topbar.

Não transformar em recurso complexo se a busca ainda não possui backend completo.

Se já funciona:

melhorar UX.

Se não funciona:

preservar estado atual e não expandir escopo.

---

# Modais e drawers

As screenshots mostram modais atuais para:

- categoria;
- promoção;
- outros fluxos.

Padronizar todos.

Modal:

```text
header
description opcional
body
footer
```

Drawer:

```text
header fixo
body scroll
footer quando necessário
```

---

# Estado ativo na sidebar

Substituir o verde saturado atual.

Novo conceito:

```text
background: green/8%
text: success
icon: success
left indicator: success
border: subtle
```

CTA principal continua podendo usar verde sólido.

---

# Botões

Variantes:

```text
primary
secondary
ghost
danger
```

### Primary

Para uma única ação principal por contexto.

### Danger

Não usar repetidamente em tabelas.

---

# Status

Criar registry central.

Exemplo:

```ts
const statusMap = {
  paid: {
    label: "Pago",
    tone: "success",
  },
  pending: {
    label: "Pendente",
    tone: "warning",
  },
}
```

Evitar status colors locais por página.

---

# Responsividade

Principal foco:

```text
1440+
1280
1024
```

Também validar:

```text
768
```

Mobile pode ser adaptado sem exigir experiência completa de desktop.

---

# Visual QA obrigatório

Depois de cada fase:

1. rodar app;
2. capturar screenshots;
3. aplicar `visual-qa-reviewer`;
4. listar 5 maiores problemas;
5. corrigir;
6. capturar novamente.

Não considerar pronto sem revisão renderizada.

---

# Ordem de execução

## Sprint visual 1 — Foundation

```text
Design tokens
Typography
AppShell
Sidebar
Topbar
PageHeader
Buttons
Inputs
Badges
Cards
Tabs
Modal
Drawer
```

## Sprint visual 2 — Data-heavy

```text
DataTable
FilterBar
Pagination
Pedidos
Trocas
Recuperação
Estoque
```

## Sprint visual 3 — Catálogo

```text
Produtos
Novo produto
Categorias
Agrupamentos
Promoções
```

## Sprint visual 4 — WhatsApp

```text
Visão geral
Automações
Templates
Detalhe template
Histórico visual
```

## Sprint visual 5 — Financeiro / Ferramentas

```text
Financeiro
Reembolsos
Frete
PIX
Vincular PIX
```

## Sprint visual 6 — Sistema

```text
Variáveis
Webhooks/logs
Integrações
Configurações
demais rotas encontradas no inventário
```

## Sprint visual 7 — QA geral

```text
29 rotas
modais
drawers
tabs
empty
loading
error
responsive
```

---

# Não fazer

Não:

```text
reescrever backend
trocar APIs
mudar contratos
refazer jobs
refazer integração Ink
implementar Instagram
inventar métricas
inventar estados
inventar dados
adicionar React Flow sem necessidade
instalar UI kit inteiro sem avaliar
substituir tudo por shadcn default
```

---

# Pode corrigir durante o processo

Se encontrar:

```text
overflow
erro de layout
warning React
key inválida
estado visual quebrado
loading inexistente
focus ausente
modal sem scroll
responsividade quebrada
label técnico apresentado ao usuário
```

pode corrigir.

Problema de regra de negócio:

documentar antes de alterar.

---

# Critério final

Antes:

> painel interno funcional.

Depois:

> SaaS dark premium, consistente, denso, claro e comercialmente apresentável.

O ganho precisa ser visível em:

```text
composição
hierarquia
densidade
tipografia
cor
tabelas
status
forms
modais
drawers
feedback
responsividade
microinterações
consistência
```

---

# Entrega final

Ao concluir:

## 1. Inventário

Quantidade final de rotas encontradas.

## 2. Componentes

Lista dos componentes globais criados/refatorados.

## 3. Design system

Tokens principais.

## 4. Rotas revisadas

Lista completa.

## 5. Screenshots

Antes/depois das principais telas.

## 6. Visual QA

Problemas encontrados após implementação e correções aplicadas.

## 7. Bugs

Bugs frontend corrigidos incidentalmente.

## 8. Pendências

Separar em:

```text
Visual
Funcional
Instagram
Histórico
```

## 9. Confirmação

Confirmar explicitamente que:

```text
nenhuma integração existente foi removida
nenhuma regra de negócio foi propositalmente alterada
Instagram permaneceu fora do escopo
```

---

# Instrução final

Não busque apenas deixar as páginas “mais bonitas”.

O objetivo é fazer com que as aproximadamente **29 páginas e seus estados internos pareçam ter sido desenhados como um único produto**, por um único design system, com a mesma linguagem, a mesma qualidade e a mesma intenção.

Quando um problema visual aparecer em várias páginas, **corrija o componente global**, não aplique patches locais repetidos.
