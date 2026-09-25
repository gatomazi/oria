# Oria — Reorganização da Navegação e Refino Visual do Painel

## Objetivo

Reorganizar a arquitetura visual e de navegação do painel para refletir o que o produto se tornou hoje: um hub conectado de comunicação, marketing, dados, criação, campanhas e operação — e não apenas um backoffice de pedidos e catálogo.

Esta etapa também deve elevar o impacto visual das páginas, sem abandonar o design system já consolidado nem criar um segundo sistema paralelo.

O foco é:

- arquitetura de navegação;
- percepção de produto;
- hierarquia visual;
- impacto visual com sobriedade;
- clareza operacional;
- consistência entre módulos;
- melhor aproveitamento de espaço;
- responsividade;
- acessibilidade;
- escalabilidade para novas features do SaaS.

Não alterar regras de negócio, APIs ou fluxos funcionais sem necessidade explícita.

---

# 1. Contexto atual

O painel já possui:

- React + TypeScript;
- dark theme;
- DM Sans como tipografia principal da interface;
- Fraunces restrita ao wordmark/identidade;
- design tokens canônicos;
- Radix para dialogs/dropdowns/tooltips;
- biblioteca própria em `admin/src/components/ds/`;
- tabelas densas;
- KPI Strip;
- badges semânticos;
- estados de loading, erro e vazio;
- drawers;
- tabs;
- code splitting por rota;
- regras visuais já documentadas em `DESIGN.md`;
- Playwright/MCP disponível para inspeção real do painel.

A base atual está boa e NÃO deve ser descartada.

Esta rodada é uma evolução do sistema existente.

---

# 2. Princípio de produto

A navegação deve refletir onde está o valor atual do produto.

O painel não deve parecer primeiro um sistema de pedidos e catálogo.

Ele deve comunicar esta sequência mental:

> Conectar → Comunicar → Analisar → Criar → Campanhar → Operar → Financeiro → Catálogo → Sistema

Essa hierarquia é importante.

As integrações, comunicação, dados, marketing e criativos são hoje áreas centrais do produto.

---

# 3. Nova arquitetura da sidebar

A navegação principal deverá seguir esta ordem:

```text
VISÃO GERAL

CONEXÕES
  Integrações

COMUNICAÇÃO
  WhatsApp
  Recuperação
  PIX
  Automações
  Templates

MARKETING & DADOS
  Meta Ads
  Google Ads
  Analytics GA4
  UTM Tracker

CRIATIVOS
  Gerar
  Lotes
  Histórico
  Produtos
  Marca e nicho
  Contextos
  Personas

CAMPANHAS
  Todas as campanhas
  Segmentos

OPERAÇÃO
  Pedidos
  Clientes
  Trocas e devoluções
  Estoque
  Simular frete

FINANCEIRO
  Financeiro
  Despesas
  Custos de API
  Reembolsos

CATÁLOGO
  Produtos
  Categorias
  Agrupamentos
  Promoções

SISTEMA
  Campos personalizados
  Webhooks e logs
  Configurações
```

## Regras de organização

### Visão geral

Deve continuar sendo acesso direto e não fazer parte de accordion.

### Conexões

`Integrações` é uma área estratégica do produto.

Ela conecta Reserva Ink, WhatsApp, GA4, Meta Ads, Google Ads, OpenAI e outras integrações presentes ou futuras.

Pode ser exibida como:

```text
Integrações
```

diretamente abaixo de Visão geral, sem exigir um segundo clique, enquanto houver apenas um item nessa categoria.

Estruturalmente, porém, mantenha o conceito de `CONEXÕES` preparado para receber futuros itens.

### Comunicação

Mover para este grupo:

- WhatsApp;
- Recuperação;
- PIX;
- Automações;
- Templates.

Recuperação e PIX devem ser tratados como parte da comunicação/conversão, pois usam dados de clientes, eventos e mensagens para recuperar receita.

### Marketing & Dados

Mover para este grupo:

- Meta Ads;
- Google Ads;
- Analytics GA4;
- UTM Tracker.

Não manter estes itens sob um grupo genérico de “Ferramentas”.

### Criativos

O Gerador de Criativos já é um módulo completo e deve deixar de ser um único item de menu.

As abas internas atuais devem ser promovidas para navegação da sidebar:

```text
CRIATIVOS
  Gerar
  Lotes
  Histórico

  Produtos
  Marca e nicho
  Contextos
  Personas
```

Há dois subgrupos conceituais:

**Execução**
- Gerar
- Lotes
- Histórico

**Configuração**
- Produtos
- Marca e nicho
- Contextos
- Personas

A separação pode ser feita apenas por spacing ou divisor discreto.

Não criar excesso de labels dentro da sidebar.

### Operação

Mover:

- Clientes para a sidebar;
- Simular frete para Operação.

A ordem deve ser:

```text
Pedidos
Clientes
Trocas e devoluções
Estoque
Simular frete
```

### Ferramentas

Eliminar completamente o grupo `Ferramentas`.

Os itens atuais devem ser absorvidos por grupos semanticamente corretos.

---

# 4. Comportamento da sidebar

## 4.1 Accordion vertical

Na sidebar expandida, os grupos principais devem funcionar como accordion.

Exemplo:

```text
▾ COMUNICAÇÃO
    WhatsApp
    Recuperação
    PIX
    Automações
    Templates

› MARKETING & DADOS
› CRIATIVOS
› CAMPANHAS
› OPERAÇÃO
› FINANCEIRO
› CATÁLOGO
› SISTEMA
```

### Regras

- o grupo correspondente à rota atual deve abrir automaticamente;
- o item ativo deve continuar claramente identificado;
- o usuário pode abrir ou fechar manualmente um grupo;
- persistir o estado no `localStorage`;
- animação curta e discreta;
- duração aproximada: 120–160ms;
- respeitar `prefers-reduced-motion`;
- evitar animação de altura lenta;
- usar chevron ou indicador simples de expansão;
- não usar glow;
- não usar cards como grupos;
- não usar caixas grandes ao redor de cada seção.

## 4.2 Política de grupos abertos

Preferência:

- somente um grupo principal aberto por vez;
- ao abrir outro, fechar o anterior;
- exceção: se houver motivo forte de UX identificado durante teste.

O objetivo é reduzir a altura ocupada e melhorar a leitura da arquitetura do produto.

## 4.3 Item ativo

O item ativo deverá ter:

- texto com contraste alto;
- ícone ou indicador em accent;
- fundo sutilmente diferente da sidebar;
- indicador vertical de aproximadamente 2px;
- sem borda completa;
- sem glow;
- sem verde preenchendo o item inteiro.

Exemplo conceitual:

```text
▌ Meta Ads
```

## 4.4 Sidebar recolhível

Implementar dois estados:

```text
Expandida: ~240px
Recolhida: ~60–68px
```

O estado deve persistir.

Não recolher automaticamente.

### No modo recolhido

Mostrar apenas ícones principais.

Ao hover/focus/click em um grupo, abrir flyout lateral com seus itens.

Exemplo:

```text
[ícone Criativos]
      ↓
┌─────────────────────┐
│ CRIATIVOS           │
│ Gerar               │
│ Lotes               │
│ Histórico           │
│ ------------------- │
│ Produtos            │
│ Marca e nicho       │
│ Contextos           │
│ Personas            │
└─────────────────────┘
```

O flyout deve ser:

- acessível por teclado;
- navegável com Tab;
- fechável por Esc;
- compatível com Radix, se já houver primitive adequada;
- com foco correto;
- sem perder a indicação da rota ativa.

---

# 5. Rotas do módulo Criativos

Hoje as áreas do Gerador estão concentradas em uma única rota com tabs.

Migrar para rotas reais quando isso for tecnicamente viável.

Preferência:

```text
/admin/criativos/gerar
/admin/criativos/lotes
/admin/criativos/historico
/admin/criativos/produtos
/admin/criativos/marca
/admin/criativos/contextos
/admin/criativos/personas
```

## Requisitos

- preservar URLs antigas com redirect quando necessário;
- não quebrar deep links;
- não duplicar navegação;
- remover as tabs horizontais redundantes do módulo após a sidebar assumir essa função;
- preservar estado e comportamento atual das telas;
- não alterar lógica do motor de criativos nesta etapa.

Se uma migração completa de rota aumentar muito o risco, pode haver uma fase intermediária com subrota controlada por query/state, mas documente claramente a dívida.

---

# 6. Refino visual — princípio geral

Queremos mais impacto visual, mas NÃO através de:

- mais cores arbitrárias;
- mais gradientes;
- glow;
- glassmorphism;
- cards em excesso;
- fontes decorativas;
- sombras fortes;
- layouts de landing page;
- grandes blocos vazios;
- ícones coloridos em toda parte;
- microinterações gratuitas.

O impacto deve vir de:

- hierarquia;
- contraste;
- composição;
- ritmo;
- espaçamento;
- proporção;
- tipografia;
- superfícies;
- densidade correta;
- estados;
- motion funcional;
- organização.

O painel deve continuar parecendo um produto SaaS operacional premium.

---

# 7. Tipografia

## Direção atual

Manter DM Sans como tipografia integral da interface.

Fraunces deve continuar restrita a:

- wordmark;
- assinatura visual;
- elementos estritamente ligados à identidade.

Não usar Fraunces em:

- títulos de página;
- tabelas;
- KPIs;
- filtros;
- tabs;
- formulários;
- sidebar;
- cards;
- dashboards.

## Pode trocar a fonte?

Não fazer troca global de fonte nesta fase.

A DM Sans já funciona bem para:

- interface densa;
- leitura;
- números;
- tabelas;
- componentes;
- SaaS.

Só propor outra fonte se houver uma justificativa visual e funcional forte, com comparação real no browser.

Se quiser explorar, faça primeiro uma comparação visual NÃO destrutiva entre:

- DM Sans atual;
- Geist;
- Inter;
- ou outra sans contemporânea compatível com UI densa.

Não implementar a troca sem aprovação.

---

# 8. Cor

## Direção atual

Preservar a lógica semântica atual:

- verde = ação / sucesso / operacional;
- cyan/azul = informação;
- âmbar = atenção / pendência;
- vermelho = erro / crítico;
- neutros charcoal = superfícies.

Não adicionar novas cores só para “dar vida”.

## Onde melhorar

Pode melhorar impacto através de:

- contraste entre `bg`, `surface-1`, `surface-2`, `surface-3`;
- bordas mais intencionais;
- superfícies mais claramente hierarquizadas;
- fundo da sidebar ligeiramente distinto da área de conteúdo;
- selected state mais forte;
- section dividers;
- hover/focus mais claros;
- gráficos com contraste melhor;
- accent usado com mais disciplina.

## Exploração permitida

Pode testar 2 ou 3 variações de surface system, mantendo a identidade dark.

Exemplo conceitual:

```text
bg
sidebar
surface-1
surface-2
surface-raised
border
border-strong
```

Não alterar a paleta final sem:

1. screenshot comparativo;
2. análise de contraste;
3. validação em páginas reais.

---

# 9. App Shell

Refinar:

- sidebar;
- topbar;
- breadcrumb;
- área de conteúdo;
- scroll behavior;
- separação visual entre navegação e conteúdo.

## Topbar

Manter minimalista.

Não reintroduzir:

- busca global falsa;
- ajuda decorativa;
- notificações sem função.

Pode ganhar:

- breadcrumb melhor;
- seletor de workspace/loja quando multi-store existir;
- menu de usuário;
- status contextual quando necessário.

---

# 10. PageHeader v2

Criar uma anatomia única de cabeçalho de página.

Exemplo:

```text
Operação / Pedidos

Pedidos                                  [Consultar na Ink]
Acompanhe pedidos, produção e entrega.

144 pedidos • Atualizado há 4 min
────────────────────────────────────────────
```

## Estrutura

- breadcrumb;
- título;
- descrição curta;
- ação primária;
- meta/contexto opcional;
- tabs abaixo quando houver.

## Regras

- evitar descrições longas;
- ação principal sempre no mesmo ponto;
- evitar múltiplos botões concorrendo;
- ações secundárias devem entrar em dropdown quando necessário;
- largura e spacing consistentes.

---

# 11. Tabs v2

Padronizar tabs horizontais remanescentes.

Estilo desejado:

```text
Visão geral   Campanhas   Conjuntos   Anúncios   Criativos   Resultado
──────────
```

## Estado ativo

- texto de alto contraste;
- underline/accent discreto;
- sem fundo preenchido;
- sem pill grande;
- sem excesso de border-radius.

## Responsivo

Em viewport menor:

- permitir scroll horizontal;
- mostrar sombra/fade sutil indicando conteúdo extra;
- não quebrar texto em múltiplas linhas.

---

# 12. Largura contextual das páginas

Criar variants de container.

## `content-narrow`

Aproximadamente:

```text
680–760px
```

Uso:

- Configurações;
- formulários simples;
- Simular frete;
- Reembolsos em estado inicial;
- editores pequenos.

## `content-default`

Aproximadamente:

```text
1100–1280px
```

Uso:

- dashboards;
- páginas de configuração maiores;
- hubs;
- cards/sections mistos.

## `content-wide`

Uso:

```text
100% do espaço útil
```

Para:

- Pedidos;
- Produtos;
- Clientes;
- Meta Ads;
- Google Ads;
- Analytics;
- tabelas operacionais;
- telas de grande densidade.

Não aplicar max-width global igual em todas as páginas.

---

# 13. Dashboard

NÃO redesenhar o Dashboard do zero.

O conteúdo atual é válido.

Melhorar a leitura por meio de seções.

Estrutura visual desejada:

```text
ATENÇÃO
[ alertas ]

HOJE
[ KPI strip ]

RESULTADO — PERÍODO
[ KPI strip ]

DESEMPENHO
[ faturamento/lucro ] [ status ]

PRODUTOS
[ lucro por produto ]

OPERAÇÃO
[ fluxo de pedidos ]

COMPORTAMENTO
[ dias ] [ horários ]

CANAIS
[ integrações ]

AÇÃO IMEDIATA
[ carrinhos quentes ] [ últimos pedidos ]
```

## Section labels

Usar labels discretos:

- 11–12px;
- medium/semibold;
- muted;
- uppercase opcional;
- tracking leve;
- sem card extra.

O objetivo é dividir contexto, não adicionar decoração.

---

# 14. Páginas de Marketing & Dados

Meta Ads, Google Ads, GA4 e UTM devem parecer parte de uma mesma família.

Padronizar:

- PageHeader;
- seletor de período;
- indicador de última sincronização;
- KPI Strip;
- chart headers;
- tabs;
- filtros;
- estados de cache/sync;
- informação sobre origem dos dados.

Deixar claro quando o dado é:

- cache local;
- atribuído pela plataforma;
- consolidado da loja;
- agregado;
- atualizado manualmente.

Impacto visual deve vir da leitura de dados, não de ornamentação.

---

# 15. Criativos

O módulo deve parecer uma área nativa e importante do produto.

Não deve parecer uma ferramenta “embutida depois”.

## Gerar

Dar maior presença visual ao fluxo principal de geração.

Priorizar:

- seleção do motor;
- produto;
- modo multipeça;
- contexto;
- preview;
- ação principal.

## Lotes / Histórico

Tabelas e cards devem seguir o DS padrão.

## Configuração

Produtos, Marca e nicho, Contextos e Personas devem compartilhar:

- mesma anatomia;
- mesmos headers;
- mesmo spacing;
- mesmos estados de edição;
- mesma hierarquia de ações.

---

# 16. Integrações

Integrações é estratégica.

Refinar a página para parecer um verdadeiro hub de conexões.

Considerar:

- status por integração;
- conectado / atenção / erro;
- última sincronização;
- ação principal;
- conta conectada;
- escopo;
- loja/workspace associado.

Evitar uma sequência infinita de cards iguais.

Pode usar agrupamentos por categoria:

```text
COMÉRCIO
Reserva Ink

COMUNICAÇÃO
WhatsApp

ANALYTICS
GA4

MÍDIA
Meta Ads
Google Ads

IA
OpenAI

SOCIAL
Instagram
```

Mas manter densidade e sobriedade.

Corrigir também inconsistências visuais já conhecidas, como controles que herdam alturas indevidas.

---

# 17. Operação

Preservar foco em velocidade.

Priorizar:

- tabela;
- busca;
- filtros;
- status;
- ações;
- drawer;
- atualização.

Evitar elementos decorativos.

## Drawers

Criar anatomia comum para:

- Pedidos;
- Produtos;
- Trocas;
- Categorias;
- Clientes, quando aplicável;
- Recuperação, quando aplicável.

Anatomia sugerida:

```text
Header
Identificação
Status

Tabs/sections

Conteúdo

Actions footer
```

---

# 18. Estados e motion

Manter comportamento já consolidado.

## Motion

Permitido em:

- accordion;
- drawer;
- dialog;
- menu;
- toast;
- tabs;
- collapse;
- flyout.

Duração aproximada:

```text
entrada: 140–180ms
saída: 100–140ms
```

Sempre respeitar `prefers-reduced-motion`.

Não animar:

- números sem motivo;
- charts a cada render;
- páginas inteiras;
- blocos decorativamente.

---

# 19. Responsividade

Testar pelo menos:

```text
1440px
1280px
1024px
768px
390px
```

Validar:

- sidebar;
- sidebar recolhida;
- flyouts;
- tabelas;
- filtros;
- tabs;
- page headers;
- dashboards;
- drawers;
- forms;
- Criativos.

No mobile:

- não tentar reproduzir sidebar desktop;
- usar drawer/nav apropriado;
- preservar os mesmos grupos sem gerar lista impossível de usar.

---

# 20. Acessibilidade

Preservar ou melhorar:

- axe-core sem violações relevantes;
- foco visível;
- navegação por teclado;
- `aria-expanded`;
- `aria-current`;
- roving focus quando necessário;
- contraste;
- hit area;
- reduced motion;
- tooltips acessíveis;
- flyouts acessíveis.

Accordion e sidebar recolhida devem funcionar integralmente por teclado.

---

# 21. Restrições técnicas

Não:

- reescrever o app shell do zero sem necessidade;
- criar segundo design system;
- duplicar tokens;
- duplicar componentes;
- trocar Radix apenas por preferência;
- alterar endpoints;
- alterar regras de negócio;
- quebrar URLs;
- remover features;
- introduzir dependências grandes sem necessidade;
- fazer uma refatoração de backend nesta tarefa.

Reutilizar:

- `admin/src/components/ds/`;
- tokens existentes;
- `shell/nav.ts`;
- `AppShell.tsx`;
- componentes de Tabs/Drawer/Tooltip;
- padrões existentes do `DESIGN.md`.

---

# 22. Processo de execução

## Fase 1 — Auditoria curta

Antes de alterar código:

1. abrir o painel real com Playwright;
2. capturar sidebar expandida atual;
3. visitar:
   - Dashboard;
   - Integrações;
   - Meta Ads;
   - Criativos;
   - Pedidos;
   - Produtos;
4. identificar inconsistências de navegação e shell;
5. documentar o plano de alteração.

Não iniciar pela troca de cores ou fonte.

---

## Fase 2 — Navegação

Implementar:

- nova ordem;
- novos grupos;
- remoção de Ferramentas;
- Clientes em Operação;
- Simular frete em Operação;
- Recuperação + PIX em Comunicação;
- Marketing & Dados;
- Criativos expandido;
- accordion;
- item ativo;
- persistência;
- sidebar recolhida;
- flyout.

Validar antes/depois com screenshots.

---

## Fase 3 — Criativos

Migrar navegação interna.

Remover tabs redundantes.

Preservar lógica.

Validar deep links.

---

## Fase 4 — PageHeader + Tabs + Containers

Implementar:

- `PageHeader v2`;
- tabs v2;
- container variants;
- section labels.

Aplicar primeiro em 3 páginas piloto:

1. Meta Ads;
2. Criativos;
3. Pedidos.

---

## Fase 5 — Refino visual sistêmico

Somente agora analisar:

- surface hierarchy;
- sidebar contrast;
- hover;
- selected state;
- borders;
- chart framing;
- section rhythm;
- spacing.

Não mudar tipografia ou paleta por impulso.

---

## Fase 6 — Dashboard

Aplicar section labels e melhorar ritmo visual.

Não alterar a lógica dos dados.

---

## Fase 7 — Integrações

Refinar hub de conexões.

Corrigir problemas visuais conhecidos.

---

## Fase 8 — Demais páginas

Propagar apenas padrões já aprovados.

---

# 23. Exploração visual

Antes de mudanças relevantes de cor ou tipografia, produzir comparações.

Pode criar 2 ou 3 propostas:

```text
A — atual refinado
B — contraste de surfaces mais forte
C — dark mais editorial/premium
```

Todas devem:

- usar a mesma estrutura;
- preservar semântica;
- usar dados reais ou mock coerente;
- ser comparadas em screenshots;
- evitar mudança funcional.

Apresentar prós e contras.

Não implementar B/C globalmente sem aprovação.

---

# 24. Critérios de sucesso

A tarefa estará bem-sucedida quando:

- a sidebar ocupar menos altura;
- o valor principal do produto ficar claro;
- Conexões, Comunicação, Marketing & Dados e Criativos tiverem prioridade perceptível;
- Criativos deixar de parecer “uma ferramenta dentro de uma tab”;
- nenhuma feature importante ficar escondida;
- Clientes estiver acessível;
- Ferramentas deixar de existir como gaveta genérica;
- a interface ficar visualmente mais forte sem ficar mais decorativa;
- as páginas tiverem hierarquia consistente;
- cada página usar largura adequada ao conteúdo;
- tabs, headers e sections tiverem padrão único;
- desktop e mobile continuarem funcionais;
- nenhuma rota ou fluxo existente quebrar;
- build e typecheck passarem;
- Playwright validar visualmente os principais fluxos.

---

# 25. Entregáveis

Ao final de cada fase, informar:

1. arquivos alterados;
2. decisões tomadas;
3. screenshots antes/depois;
4. rotas testadas;
5. comportamento desktop/mobile;
6. build;
7. typecheck;
8. problemas encontrados;
9. itens adiados;
10. próximos passos.

Atualizar:

- `DESIGN.md`;
- documentação de navegação;
- qualquer documentação de rotas afetada.

---

# 26. Instrução final

A prioridade desta rodada é:

> aumentar a percepção de qualidade e produto através de arquitetura, hierarquia e acabamento — não através de decoração.

O painel deve transmitir mais impacto visual quando aberto, mas continuar sendo uma ferramenta operacional densa, rápida e confiável.

Antes de qualquer mudança ampla em fonte, paleta ou linguagem visual, mostrar comparação real e pedir aprovação.

Comece pela Fase 1 e pare para revisão antes de aplicar mudanças visuais globais.
