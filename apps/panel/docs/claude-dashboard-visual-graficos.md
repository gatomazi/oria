# Claude Code — Construir o novo Dashboard visual no painel real

## Contexto

O painel já está em **React + TypeScript** e funcional.

Agora quero implementar **de verdade** o novo layout da página `/admin/dashboard`, baseado no mockup dark premium aprovado.

Este trabalho é **somente sobre o Dashboard**.

Não refatore o restante do sistema nesta tarefa.

---

# Objetivo

Transformar a página atual de Visão Geral em um dashboard operacional real, com:

- KPIs;
- gráficos;
- distribuição de status;
- fluxo de pedidos;
- recuperação via WhatsApp;
- carrinhos quentes;
- integrações;
- pedidos recentes;
- filtros por período.

O resultado precisa parecer um **dashboard SaaS premium**, não apenas uma lista de cards.

---

# Regra principal

## Não fabricar dado

Antes de criar qualquer gráfico ou KPI:

1. identifique de onde o dado real vem;
2. confirme que existe no frontend, backend ou banco;
3. use apenas dados reais.

Se um dado do mockup não existir:

- não invente;
- não use mock;
- não hardcode;
- ou remova o widget;
- ou mostre um estado "Sem dados";
- ou substitua por uma métrica real equivalente.

---

# Skills obrigatórios

Use:

1. `reference-ui-implementation`
2. `dashboard-ui-director`
3. `design-system-guardian`
4. `responsive-accessibility`
5. `visual-qa-reviewer`

Se `frontend-design` estiver disponível, use também.

---

# Passo 1 — Auditar os dados atuais

Antes de alterar JSX/CSS, descubra quais dados já existem para:

## Pedidos

- total por período;
- total por dia;
- valor total por dia;
- status;
- data de criação;
- valor;
- cliente;
- loja.

## Carrinhos

- recuperáveis;
- data/hora;
- valor;
- cliente;
- itens;
- status;
- tentativas;
- conversão quando existir.

## WhatsApp

- mensagens enviadas;
- respostas recebidas;
- falhas;
- mensagens em fila;
- data/hora dos envios;
- relação com carrinho/pedido/automação quando existir.

## Integrações

- Reserva Ink;
- WhatsApp;
- Instagram;
- status/conexão.

## Problemas / atenção

Identifique o que hoje compõe:

- pedido com problema;
- falha de pagamento;
- erro de produção;
- entrega atrasada;
- ou qualquer outro alerta real já existente.

---

# Passo 2 — Definir modelo de dados do Dashboard

Crie uma camada própria para o dashboard.

Não espalhe agregações dentro do JSX.

Sugestão conceitual:

```ts
type DashboardPeriod = {
  from: string
  to: string
}

type DashboardKpis = {
  orders: number
  revenue: number | null
  recoverableCarts: number
  recoveryRate: number | null
  attention: number
}

type OrdersRevenuePoint = {
  date: string
  orders: number
  revenue: number
}

type OrderStatusPoint = {
  status: string
  label: string
  count: number
}

type OrderFlowPoint = {
  status: string
  label: string
  count: number
}

type WeekdayPoint = {
  weekday: string
  orders: number
}

type HourPoint = {
  hour: string
  orders: number
}

type RecoveryPoint = {
  date: string
  messages: number
  responses?: number
  conversions?: number
}
```

Adapte aos tipos reais do projeto.

---

# Passo 3 — Escolher onde agregar

Primeiro descubra se o frontend já recebe dados suficientes para montar as séries.

## Se for barato agregar no cliente

Pode usar:

```text
useMemo
selectors
helpers
```

## Se exigir muitas páginas da API ou centenas/milhares de pedidos

Criar um endpoint específico de leitura:

```text
GET /api/admin/dashboard
```

ou equivalente ao padrão atual do projeto.

Esse endpoint pode retornar o resumo já agregado.

### Importante

Isso só é permitido se necessário para desempenho.

Não alterar regra de negócio.

Esse endpoint é somente uma **view agregada de leitura**.

---

# Passo 4 — Período

Adicionar controle no canto superior direito:

```text
Hoje
7 dias
30 dias
90 dias
```

ou seletor equivalente.

Padrão:

```text
30 dias
```

O período deve atualizar os widgets históricos.

Não precisa alterar widgets que são snapshot atual quando semanticamente não fizer sentido.

---

# Estrutura visual desejada

Usar grid responsivo.

## Linha 1

```text
PageHeader
Filtro de período
```

Título:

```text
Visão geral
```

Descrição:

```text
Resumo da operação da sua loja em tempo real.
```

---

# Linha 2 — Alerta operacional

Se houver carrinhos recuperáveis ou alertas relevantes:

```text
[ 39 carrinhos recuperáveis ]
```

Com:

- ícone;
- texto;
- descrição curta;
- CTA "Ver carrinhos".

Não exibir banner vazio.

Se não houver alertas, pode ocultar o bloco.

---

# Linha 3 — KPI Strip

Criar cards compactos.

Prioridade:

```text
Pedidos
Receita
Carrinhos recuperáveis
Taxa de recuperação
Atenção
```

Se algum dado não existir, remova esse KPI ou substitua por dado real equivalente.

Cada KPI pode ter:

- ícone;
- valor;
- comparação com período anterior, se disponível;
- sparkline se houver série real.

### Não inventar comparação

Só mostrar:

```text
+12%
vs período anterior
```

se os dados permitirem calcular.

---

# Linha 4 — Principal área analítica

Grid sugerido:

```text
7 colunas  → Pedidos e receita
2.5 colunas → Status dos pedidos
2.5 colunas → Recuperação WhatsApp
```

Em telas menores, quebrar naturalmente.

---

# Gráfico 1 — Pedidos e receita

Usar **Recharts** se já estiver instalado ou se for a melhor opção.

Sugestão:

```text
ComposedChart
Bar = pedidos
Line = receita
```

Eixos:

```text
esquerda → pedidos
direita → receita
```

Tooltip:

```text
Data
Pedidos
Receita
```

Não mostrar legendas redundantes.

---

# Gráfico 2 — Status dos pedidos

Usar donut/pie.

Exemplo:

```text
Pago
Produção
Despachado
Em trânsito
Entregue
```

Somente status reais.

No centro:

```text
total de pedidos
```

Ao lado:

```text
label
count
%
```

Usar cores semânticas consistentes com o restante do produto.

---

# Gráfico 3 — Recuperação WhatsApp

Mostrar somente métricas que existirem.

Pode conter:

```text
mensagens enviadas
respostas
conversões
```

Gráfico:

```text
mensagens por dia
```

Se conversão não existir de forma confiável:

não mostrar taxa de conversão.

Não inventar "entregue", "lido" ou similares se Meta não fornecer.

---

# Linha 5 — Fluxo de pedidos

Transformar o fluxo atual em componente visual.

Exemplo:

```text
Pago
→
Produção
→
Despachado
→
Em trânsito
→
Em entrega
→
Entregue
```

Cada etapa:

- ícone;
- label;
- quantidade;
- percentual opcional.

Não usar cards soltos gigantes.

---

# Linha 6 — Comportamento

Dois gráficos compactos + integrações.

## Pedidos por dia da semana

Bar chart:

```text
Seg Ter Qua Qui Sex Sáb Dom
```

Baseado no período escolhido.

## Melhores horários

Bar chart:

```text
0h 3h 6h 9h 12h 15h 18h 21h
```

ou agregação mais apropriada aos dados reais.

Se não houver volume suficiente, não fabricar.

## Canais e integrações

Mostrar:

```text
Reserva Ink
WhatsApp
Instagram
```

Estados:

```text
Conectado
Não conectado
Falha
Em breve
```

---

# Linha 7 — Operação rápida

## Carrinhos quentes

Lista compacta:

```text
Cliente
Itens
Tempo
Valor
Status
Enviar WhatsApp
```

No máximo 3–5 itens.

Adicionar:

```text
Ver todos os carrinhos
```

---

## Últimos pedidos

Tabela compacta.

Exemplo:

```text
Cliente
Valor
Status
Criado em
```

No máximo 5–8 linhas.

CTA:

```text
Ver todos os pedidos
```

---

# Componentes sugeridos

Criar/reutilizar:

```text
DashboardPage
DashboardPeriodSelect
AttentionBanner
KpiCard
MiniSparkline
OrdersRevenueChart
OrderStatusDonut
RecoveryChart
OrderFlow
WeekdayChart
HourlyChart
IntegrationHealth
HotCartsList
RecentOrdersTable
```

Não criar componente genérico inútil apenas para aumentar abstração.

---

# Recharts

Se Recharts ainda não estiver instalado e não houver outra lib de charts adotada:

```bash
npm install recharts
```

Não instalar duas bibliotecas de gráfico.

Se já existir outra lib adequada no projeto, use a existente.

---

# Skeletons

O dashboard precisa ter loading real.

Criar skeleton para:

```text
KPIs
gráficos
listas
```

Evitar tela piscando vazia.

---

# Empty state

Se não houver dado para um gráfico:

não mostrar gráfico vazio enganoso.

Exemplo:

```text
Ainda não há dados suficientes neste período.
```

---

# Erro

Se uma parte do dashboard falhar:

não derrubar a tela inteira.

Se possível, usar erro por widget.

Exemplo:

```text
Não foi possível carregar este indicador.
Tentar novamente
```

---

# Performance

Evitar:

- várias requisições duplicadas;
- recalcular agregações em cada render;
- buscar todos os pedidos da história da loja.

Usar:

```text
TanStack Query
memoização
backend aggregation
```

quando fizer sentido.

---

# Responsividade

Validar:

```text
1920
1440
1280
1024
```

Em 1440 o dashboard deve mostrar bastante informação sem parecer espremido.

Em 1024:

- KPIs podem quebrar em 2 linhas;
- gráficos podem empilhar;
- sidebar pode colapsar conforme comportamento atual.

---

# Design

Usar o design system dark atual.

Não mudar a identidade geral do painel.

Manter:

```text
fundo blue-black
surfaces escuras
bordas discretas
verde operacional
cyan informativo
âmbar atenção
vermelho crítico
violeta terciário
```

Evitar:

- glow exagerado;
- gráficos muito saturados;
- gradientes sem função;
- texto pequeno demais;
- excesso de legenda.

---

# Comparação visual

A screenshot/mockup aprovada deve servir como **target de composição**, não como fonte de dados.

Ou seja:

copiar:

- estrutura;
- hierarquia;
- densidade;
- proporções;
- linguagem visual.

Não copiar:

- números;
- métricas inexistentes;
- status não disponíveis.

---

# QA obrigatório

Ao terminar:

1. rodar aplicação;
2. abrir `/admin/dashboard`;
3. capturar screenshot;
4. aplicar `visual-qa-reviewer`;
5. comparar com o mockup;
6. listar os 5 maiores gaps;
7. corrigir;
8. capturar screenshot final.

---

# Critério de conclusão

O dashboard só está pronto quando:

- parece um dashboard, não uma página de cards;
- possui visualização temporal real;
- possui gráficos com dados reais;
- mostra status operacional;
- possui filtros por período;
- aproveita bem o viewport;
- mantém boa leitura;
- não inventa informação;
- não quebra as integrações atuais.

---

# Entrega final

Me entregue:

1. origem de dados de cada widget;
2. componentes criados/refatorados;
3. novas dependências instaladas;
4. eventual endpoint agregado criado;
5. screenshot final;
6. métricas que não foram implementadas por falta de dado;
7. confirmação de que nenhum número foi mockado/hardcoded.
