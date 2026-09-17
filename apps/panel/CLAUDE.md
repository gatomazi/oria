# Projeto — Buscador de Cidades e Estampas

## Objetivo do produto
Este site é uma experiência de apoio para o usuário encontrar sua cidade, visualizar as estampas disponíveis e seguir para a loja principal.

Fluxo central:
BUSCA DA CIDADE -> CIDADE -> ESCOLHA DA ESTAMPA -> LOJA

O site NÃO deve virar um e-commerce completo. A função principal é descoberta/localização por cidade e encaminhamento para compra.

## Regras de produto
- Preservar a identidade visual atual: editorial, regional e premium.
- Preservar a paleta e a linguagem visual existente salvo instrução explícita em contrário.
- Não transformar a interface em SaaS, dashboard, glassmorphism ou design genérico.
- Não alterar textos, produtos, ordem das estampas, nomes de regiões ou regras de negócio sem necessidade técnica ou autorização.
- Mobile continua sendo prioridade, mas desktop deve ser uma experiência nativa e não uma versão mobile ampliada/centralizada.
- Toda mudança deve funcionar em 320px, 375px, 390px, 430px, 768px, 1024px, 1280px, 1440px e 1920px.
- Não remover funcionalidades existentes para simplificar implementação.
- Não adicionar dependências grandes se CSS/JS existente resolver de forma simples.

## Diretrizes de UX
- Busca é a ação principal da home.
- Resultados da busca devem ser claros, rápidos e totalmente clicáveis.
- Em página de cidade, o modelo selecionado deve ter estado visual inequívoco.
- CTA deve descrever a próxima ação real. Se o clique abre a loja, preferir "Ver na loja" ou equivalente contextual.
- Elementos sticky/floating nunca podem cobrir conteúdo.
- Nas páginas internas, reduzir a competição visual entre seletor regional, CTA e WhatsApp.
- No desktop, usar o espaço horizontal para melhorar hierarquia, não apenas aumentar tudo.

## Diretrizes responsivas
- Mobile <= 767px: fluxo vertical, compacto e touch-first.
- Tablet 768–1023px: container intermediário, mais respiro e imagens maiores.
- Desktop >= 1024px: container de conteúdo até aproximadamente 1200–1280px.
- Página de cidade no desktop: preferir composição em 2 colunas, visual/hero à esquerda e informações/modelos/CTA à direita.
- Referências adicionais: carrossel horizontal no mobile quando adequado; grid no desktop.
- Busca no desktop deve manter largura confortável, não ocupar a viewport inteira.

## Processo obrigatório antes de editar
1. Mapear stack, estrutura de arquivos, rotas, estilos globais e componentes relevantes.
2. Identificar a causa real do layout desktop estreito.
3. Registrar o plano de mudança e os arquivos afetados.
4. Implementar em etapas pequenas.
5. Rodar build/lint/testes disponíveis após cada etapa relevante.
6. Revisar visualmente os breakpoints e estados principais.

## Ordem recomendada de delegação
1. `ux-auditor`
2. `responsive-architect`
3. `frontend-implementer`
4. `visual-guardian`
5. `performance-a11y`
6. `qa-reviewer`

Se uma alteração falhar na revisão, retornar para `frontend-implementer` com os achados específicos e repetir a revisão.

## Critérios de aceite globais
- Nenhuma regressão funcional no fluxo de busca.
- Nenhuma imagem quebrada exibindo ALT cru no card.
- Nenhum CTA ou botão flutuante cobre conteúdo.
- Layout desktop usa espaço horizontal de forma intencional.
- Mobile mantém identidade e densidade próximas do design atual.
- Busca pode ser usada por teclado e toque.
- Estados hover/focus/active são visíveis quando aplicáveis.
- Imagens abaixo da dobra usam carregamento apropriado quando possível.
- Layout não apresenta overflow horizontal acidental.


# Frontend

Este projeto possui skills específicos em `.claude/skills/`.

Para trabalhos de interface:

1. Se houver screenshot ou mockup de referência, use `reference-ui-implementation`.
2. Para composição de dashboards, use `dashboard-ui-director`.
3. Preserve consistência através de `design-system-guardian`.
4. Valide responsividade com `responsive-accessibility`.
5. Após implementar, capture uma screenshot e use `visual-qa-reviewer`.
6. Corrija os principais desvios antes de concluir.

A direção visual do produto é dark premium:
- fundo charcoal / blue-black;
- superfícies escuras em níveis;
- verde como cor operacional principal;
- cyan para informação/transporte;
- âmbar para pendências;
- vermelho para estados críticos;
- violeta como acento secundário/premium;
- alta densidade de informação;
- tabelas operacionais;
- cards compactos;
- drawers para detalhes.

Mockups fornecidos devem ser tratados como especificação visual, não como inspiração solta.