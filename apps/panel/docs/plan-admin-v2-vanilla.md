# Plano — Painel Admin V2 (Reserva Ink) [CONCLUÍDO]

> **Status: executado e commitado** (branch `enhancement/painel-v2-dark-redesign`). Arquivado como histórico — a decisão "sem framework/sem build step" registrada abaixo foi reconsiderada depois; ver [`plan.md`](./plan.md) para o plano de migração React/TS em avaliação.

> Baseado em `painel-ink-v2-especificacao-claude.md`. Escopo: **admin interno** (`/admin/*`, `server.js` + `src/admin/*` + `src/<pagina>.js/.css`). Não toca no site público (`index.html`, `src/loja.*`), que é regido pelas regras do `CLAUDE.md` raiz e não faz parte desta spec.

## Context

O admin hoje é um app Express server-rendered sem build step: cada tela é um trio `<pagina>.html` (shell HTML mínimo) + `src/<pagina>.js` (controller vanilla JS, helper `el()`) + `src/<pagina>.css`. Shell compartilhado em `src/admin/` (`admin-shell.js/css`, `admin-state.js`, `admin-stores.js`, `admin-utils.js`). Autenticação por sessão/cookie (`requireAdmin` em `server.js`), persistência em Postgres (mesmo padrão usado em `pedidos_ink`, `campos-customizados`, `automacao-eventos`, fila de WhatsApp).

Achados da auditoria (confirmam os problemas listados na spec §5):
- Badges de status são reimplementados por página com nomes e paletas diferentes (`ad-carrinho__badge--quente`, `ad-estoque__badge--critico`, `pd-status--ok`) em vez de um componente único.
- Tokens de cor/tipografia (`:root`) estão duplicados em `loja.css`, `pedido-admin.css`, `pedido.css` em vez de centralizados.
- Não existe "Central de Pedidos": `/admin/pedidos` hoje é só a fila de **PIX pendente**, não uma listagem geral de pedidos.
- Multi-loja já existe e é usado de verdade: `AdminStores`/`AdminState` + `<select>` de escopo no header, alimentando as 3 lojas reais (Sul/Centro/Norte). A spec assume "uma conta = uma loja"; **decisão do usuário**: manter as 3 lojas operáveis por um switch, mas já desenhar o produto pensando em SaaS single-store (ver §Arquitetura — modo multi-loja).
- WhatsApp já é relativamente maduro (Automações, Templates, Eventos, fila de retry no `whatsapp-webhook-go`) — a Fase 7 é mais reorganização/UI do que feature nova.
- API real da Reserva Ink (`documentacao-api-ink.yaml`) foi conferida endpoint a endpoint — ver §Limites reais da API Ink, que restringe o que dá para prometer nas Fases 3–8.

## Objective

Modernizar o admin para parecer um produto SaaS premium (design system consistente, navegação por trabalho do lojista, tabelas/drawers no lugar de cards grandes), preservando 100% das integrações e fluxos existentes (WhatsApp, PIX, carrinhos, estoque), sem framework novo, sem build step novo, e com uma camada de entitlements que já prepara o terreno para planos WhatsApp/Instagram/Completo — sem implementar multi-tenant de verdade ainda.

Entregar em PRs pequenos e sequenciais (nunca tudo de uma vez), com uma página piloto validada visualmente antes de replicar o padrão.

---

## Arquitetura — decisões que atravessam todas as fases

### Modo multi-loja (toggle)

Não removemos o seletor de loja. Criamos um flag de conta, `multiStoreMode: boolean`, persistido junto da config existente (mesma tabela/padrão de `automacao-eventos`/`campos-customizados`), com endpoint `GET/PATCH /api/admin/settings/product` (novo).

- `multiStoreMode = true` (default hoje, preserva uso atual): sidebar/topbar mostram o seletor de loja (`AdminStores`), como já existe.
- `multiStoreMode = false` (visão "SaaS de 1 loja"): seletor some, `AdminState.getStore()` fixa na única loja configurada. Toda a UI nova (sidebar, topbar, dashboard, PageHeader) já é escrita **condicional a esse flag** desde a Fase 2, não como retrofit depois.
- Nenhuma tela de negócio (pedidos, carrinhos, templates etc.) deve saber sobre esse flag diretamente — ela sempre lê `AdminState.getStore()`. Só o shell (`admin-shell.js`) e a tela de Configurações mudam de comportamento.

### Entitlements

Novo módulo `src/admin/entitlements.js` (vanilla JS, sem framework):

```js
window.AdminEntitlements = {
  get: function () { /* cache local de GET /api/admin/entitlements */ },
  has: function (key) { /* boolean */ },
};
```

Backend: tabela `account_entitlements` (colunas booleanas: `whatsapp`, `instagram`, `advanced_automations`, `catalog`, `exchanges`, `refunds`, `financial`), com todas `true` por default (conta única hoje = dono já tem tudo). Endpoint `GET /api/admin/entitlements` e validação server-side em cada rota sensível (`requireEntitlement('whatsapp')` como middleware, análogo ao `requireAdmin` existente). UI: item de menu bloqueado usa o padrão §4 da spec (cadeado + CTA), nunca `display:none`.

Isso é infraestrutura barata (uma tabela + um middleware) que evita reescrever tudo quando o plano Instagram existir de verdade — não é multi-tenant, é feature flag por conta.

### Design system sem framework

Sem React/Tailwind (não existe build step e a spec manda "adaptar ao stack existente"). Traduzimos os componentes da spec para:

- `src/admin/design-system/tokens.css` — variáveis únicas (cor, tipografia, radius, spacing, sombra), substituindo os `:root` duplicados.
- `src/admin/design-system/components.css` — `.ds-btn`, `.ds-btn--secondary/ghost/danger`, `.ds-input`, `.ds-badge`, `.ds-card`, `.ds-table`, `.ds-drawer`, `.ds-modal`, `.ds-toast`, `.ds-skeleton`, `.ds-empty`.
- `src/admin/design-system/components.js` — funções construtoras (`DS.button(opts)`, `DS.statusBadge(status, label)`, `DS.pageHeader(opts)`, `DS.dataTable(opts)`, `DS.drawer(opts)`, `DS.emptyState(opts)`) usando o mesmo `el()` de `admin-utils.js`. Sem classe/estado React — cada função retorna um `HTMLElement` e expõe métodos (`.update(data)`, `.destroy()`) quando precisa de interatividade.
- `src/admin/design-system/status-map.js` — um único `ORDER_STATUS_MAP`, `EXCHANGE_STATUS_MAP` etc. (espelha spec §81), substituindo toda tradução de status espalhada.

Páginas continuam sendo HTML+JS+CSS por página; só passam a montar suas telas com os blocos do design system em vez de reinventar markup/CSS.

### Limites reais da API Ink (conferidos em `documentacao-api-ink.yaml`)

| Recurso | Métodos disponíveis | Implica |
|---|---|---|
| Pedidos (`orders`) | GET list, GET detalhe, PATCH | Edição de item pré-produção via PATCH; não há endpoint de cancelamento separado |
| Trocas (`exchanges`) | GET list, GET detalhe, POST criar | **Sem PATCH/aprovação via API** — aprovação/recusa é decidida do lado Ink; nosso admin cria e acompanha, não aprova |
| Reembolsos (`orders/{id}/refunds`) | GET, POST | Sem cancelar/editar reembolso depois de criado |
| Produtos (`products`) | GET, POST, PATCH, POST `/copy` | **Sem DELETE** — nunca oferecer "excluir produto" |
| Categorias (`collections`) | GET, POST, PATCH, DELETE, PUT `custom_showcase` | CRUD completo, único módulo de catálogo com delete real |
| Agrupamentos (`product_clusters`) | GET, POST, DELETE só de produto-no-cluster | Sem editar/excluir o agrupamento inteiro, só criar e remover produto individual |
| Promoções (`promotions/standard|progressive|unit_free`) | GET, POST por tipo, PATCH por tipo, DELETE genérico por id | Confirma os 3 tipos da spec |
| Tipos de produto (`product_types`) | GET só | Dado de referência, não editável |
| Frete (`shipping_simulation`) | GET só | Sempre estimativa, nunca cotação real de envio |
| Financeiro (`balance`, `balance_extract`, `prepayments`, `withdraws`) | GET só | Módulo Financeiro é **somente leitura** — nada de "solicitar saque" pelo painel |
| Clientes/Leads/Carrinhos (`customers`, `leads`, `abandoned_carts`) | GET só | Como já é hoje |

Essas restrições viram texto literal nas telas correspondentes (empty states, tooltips de ação indisponível) em vez de aparecerem só depois, como bug.

---

## Fase 1 — Design Foundation

**Objetivo:** tokens + shell + componentes base, sem mudar nenhuma tela de negócio ainda.

| Arquivo | Ação | Descrição |
|---|---|---|
| `src/admin/design-system/tokens.css` | criar | Cores, tipografia (Inter — já é livre de licença e cobre pt-BR bem, carregada via `fonts.css` local ou self-host, nunca CDN de terceiro não auditado), radius, spacing, sombra. Unifica os `:root` hoje duplicados em `pedido.css`/`pedido-admin.css`. |
| `src/admin/design-system/components.css` | criar | `.ds-btn` (4 variantes), `.ds-input`, `.ds-field`, `.ds-badge`, `.ds-card`, `.ds-table`, `.ds-drawer`, `.ds-modal`, `.ds-toast` (substitui `.ad-toast*` existente por skin nova, mesma API), `.ds-skeleton`, `.ds-empty`. |
| `src/admin/design-system/components.js` | criar | `DS.button`, `DS.field`, `DS.statusBadge`, `DS.pageHeader`, `DS.dataTable`, `DS.drawer`, `DS.modal`, `DS.emptyState`, `DS.skeletonRows`. Todas funções puras que devolvem `HTMLElement`. |
| `src/admin/design-system/status-map.js` | criar | Mapas de status → `{label, tone}` para pedido, troca, reembolso, template Meta, automação. |
| `src/admin/admin-shell.js` | editar | Sidebar reorganizada por trabalho do lojista (§11 da spec, ver Fase 2), topbar nova (busca/sino/avatar), aplica `multiStoreMode`. |
| `src/admin/admin-shell.css` | editar | Migra para tokens novos; mantém seletores `.ad-*` existentes como alias fino sobre `.ds-*` para não quebrar páginas ainda não migradas. |
| `src/admin/admin-utils.js` | editar | Sem quebrar API pública (`el`, `api`, `copiar`, `formatValor`, `formatData`, `tempoDesde`, `waLink`); toast passa a delegar pro `.ds-toast`. |
| `src/admin/entitlements.js` | criar | Client da Fase "Arquitetura — Entitlements" acima. |

**Technical details:** todo HTML de admin (`*.html` na raiz) ganha `<link>` para `tokens.css` + `components.css` antes do CSS da página, e `<script>` para `components.js` + `entitlements.js` antes do controller da página — mesmo padrão de `<script>` sequencial já usado hoje, sem bundler.

**Test impact:** nenhuma rota de API muda. Regressão visual manual em todas as páginas existentes (o CSS global muda tokens compartilhados). Rodar smoke test de login + navegação por todas as entradas do menu atual.

**Verification:** abrir cada página admin hoje existente em 1280/1440/1920px e conferir que nada quebrou (cores, contraste, sidebar). Nenhuma mudança funcional nesta fase — só visual.

---

## Fase 2 — Navegação e Dashboard

**Objetivo:** sidebar nova, remoção condicional de multi-loja da UX (via `multiStoreMode`), dashboard novo.

| Arquivo | Ação | Descrição |
|---|---|---|
| `src/admin/admin-shell.js` | editar | Novo `NAV_GROUPS` seguindo §11 da spec, mapeado nos itens que **já existem hoje** (ver tabela de migração abaixo); itens de fases futuras entram com `comingSoon: true` (o padrão já existe no código, `renderNavItem`). |
| `server.js` | editar | Novo endpoint `GET/PATCH /api/admin/settings/product` (multiStoreMode); `GET /api/admin/entitlements`. |
| `dashboard.html`, `src/dashboard.js`, `src/dashboard.css` | reescrever | KPIs (`DS.dataTable`? não — `KpiCard` novo em `components.js`), "Precisa da sua atenção", pipeline operacional compacto, saúde das integrações. Reaproveita os endpoints já existentes (`/api/admin/dashboard/*`) — não cria dado novo nesta fase. |

**Mapeamento de navegação (spec §108, aplicado ao que existe hoje):**

```
Visão Geral         → Visão geral (mantém)
Pedidos PIX         → Recuperação > PIX pendentes   (Fase 6)
Carrinhos           → Recuperação > Carrinhos        (Fase 6)
Clientes            → Operação > Clientes            (permanece oculto do menu até o dado
                       de histórico de compra existir de verdade — ver pendência já
                       registrada; reativar é fora de escopo desta spec)
Estoque             → revisar: incorporar em Catálogo > Produtos quando a Fase 8 existir;
                       até lá permanece em Operação como está
Automações          → WhatsApp > Automações
Templates           → WhatsApp > Templates
Campos personalizados → Sistema > Variáveis (renomear)
Eventos             → Sistema > Webhooks e logs (renomear)
Integrações         → Sistema > Integrações
```

Itens novos sem página ainda (Pedidos central, Trocas, Produtos, Categorias, Agrupamentos, Promoções, Instagram, Financeiro) entram no menu como `comingSoon` nesta fase e ganham página nas fases correspondentes.

**Test impact:** todo link antigo (`/admin/pedidos`, `/admin/carrinhos` etc.) continua respondendo nas mesmas URLs — só muda onde aparecem no menu. Nenhum endpoint de API removido.

**Verification:** navegar por todos os itens do menu novo, confirmar que os `comingSoon` não navegam, e que os links reais levam às páginas certas.

---

## Fase 3 — Central de Pedidos

**Objetivo:** primeira página nova de verdade (a spec recomenda como piloto). Substitui a ausência de uma listagem geral de pedidos.

| Arquivo | Ação | Descrição |
|---|---|---|
| `server.js` | editar | Novo `GET /api/admin/pedidos/central?loja=&status=&pagamento=&periodo=&busca=` usando `orders` (GET list) da API Ink, com paginação real (a API Ink pagina — usar os parâmetros dela, não paginar em memória). |
| `pedidos-central.html` (novo) + `src/pedidos-central.js` + `.css` | criar | `DS.pageHeader` + filtros + `DS.dataTable` (colunas da spec §25) + `DS.drawer` (tabs Resumo/Itens/Entrega/Comunicação/Trocas/Reembolsos/Timeline — timeline populada a partir de `webhook_log` + fila de WhatsApp já existentes, que já são persistidos). |
| `src/admin/admin-shell.js` | editar | Ativa item "Pedidos" (novo) no lugar do `comingSoon`. |

**Technical details — ações contextuais (spec §27):** calculadas no client a partir dos campos que a API Ink já devolve no pedido (ex.: se o pedido aceita edição de item, se tem `tracking_url`, se pagamento está pendente). Não inventar campo que a API não expõe — se a Ink não disser explicitamente que o pedido é editável, a ação fica oculta, não "desabilitada com adivinhação".

**Test impact:** rota nova, não mexe em `/admin/pedidos` (PIX) existente. Cobrir o novo endpoint com o mesmo padrão de erro/paginação dos outros endpoints Ink já implementados em `server.js`.

**Verification:** validar visualmente esta página nos breakpoints 1280–1920px antes de prosseguir — é o padrão de tabela/drawer que todas as fases seguintes replicam (instrução §121 da spec).

---

## Fase 4 — Trocas

**Objetivo:** módulo novo. Lembrar do limite real: **sem aprovação via API** — o admin cria e acompanha, não decide.

| Arquivo | Ação | Descrição |
|---|---|---|
| `server.js` | editar | `GET /api/admin/trocas` (lista via `exchanges` GET), `GET /api/admin/trocas/:id`, `POST /api/admin/trocas` (cria via `exchanges` POST). |
| `trocas.html` + `src/trocas.js` + `.css` | criar | Lista (`DS.dataTable`, filtros por status) + wizard de criação (§30: Pedido → Motivo → Itens → Nova opção → Evidências → Revisão), motivos = enum real devolvido pela API (`exchange_reason`), não inventado. |
| Upload de evidências | avaliar | A API Ink não expõe endpoint de upload de imagem para troca na doc revisada — **checar isso antes de prometer upload na UI**; se não existir, a etapa 5 vira campo de texto only até confirmar. |

**Test impact:** nova entidade, sem tocar em pedidos/refunds existentes.

**Verification:** criar uma troca de teste ponta a ponta contra o ambiente de sandbox da Ink (se existir) antes de liberar em produção.

---

## Fase 5 — Reembolsos

| Arquivo | Ação | Descrição |
|---|---|---|
| `server.js` | editar | `GET /api/admin/reembolsos` (agregando `orders/{id}/refunds` — a API não tem list global, então precisa iterar/cachear, ver §Dados locais), `POST /api/admin/pedidos/:id/reembolsos`. |
| `reembolsos.html` + `src/reembolsos.js` + `.css` | criar | Tela `Financeiro > Reembolsos` (tabela) + `DS.modal` de reembolso (spec §32) acoplado também ao drawer do pedido (aba Reembolsos da Fase 3). |
| Auditoria | implementar | Toda chamada de reembolso grava em `audit_log` (tabela nova, Postgres) — reembolso está na lista de ações sensíveis da spec §33. Confirmação extra (checkbox "confirmo") obrigatória para reembolso total. |

**Test impact:** ação financeira real e irreversível — cobrir com teste manual em pedido de valor baixo antes de generalizar; nunca automatizar reembolso em massa nesta fase.

**Verification:** revisão de auditoria: cada reembolso de teste aparece em `audit_log` com `actorUserId`, `before/after`.

---

## Fase 6 — Recuperação (unifica Carrinhos + PIX)

| Arquivo | Ação | Descrição |
|---|---|---|
| `recuperacao.html` (novo) + `src/recuperacao.js` + `.css` | criar | Tabs Carrinhos / PIX pendentes sobre o mesmo shell; reaproveita os endpoints já existentes (`/api/admin/dashboard/abandoned-carts`, `/api/admin/pedidos/ink/pendentes`) — **não reescreve a lógica de automação/cadência**, só a apresentação. |
| `carrinhos.html`, `src/carrinhos.js/css` | remover das rotas de menu | Conteúdo migra pra dentro de `recuperacao.js` como módulo (`renderCarrinhosTab`); arquivo antigo pode ficar redirecionando por compatibilidade se houver link salvo. |
| `pedido.html` (PIX) | manter | Continua sendo a tela de detalhe de 1 PIX específico, referenciada pela nova tabela via `DS.drawer`. |

**Test impact:** cadência de reenvio, anti-spam e stop conditions do carrinho/PIX **não mudam** — só a UI que lista e aciona. Regressão principal a testar: os botões "Enviar agora"/"Cancelar sequência" continuam chamando os mesmos endpoints de hoje.

**Verification:** conferir que enviar/cancelar via UI nova dispara exatamente a mesma chamada de API que a UI antiga (comparar payload).

---

## Fase 7 — WhatsApp V2

**Objetivo:** reorganização de UI sobre um backend já maduro (`whatsapp-webhook-go` + `src/automacoes.js`, `templates*.js`, `template-editor.js`). Poucas mudanças de contrato.

| Arquivo | Ação | Descrição |
|---|---|---|
| `whatsapp-visao-geral.html` (novo) | criar | KPIs (enviado/entregue/lido/falha vindos de `evStore`/eventos já existentes no `whatsapp-webhook-go`), card de número conectado + qualidade (**não há endpoint de "quality rating" na Meta Cloud API pelo webhook atual** — checar se o Business Management API já está integrado antes de prometer esse card; se não, mostrar apenas "conectado/desconectado" por ora). |
| `templates.html/js/css`, `templates-novo.js`, `templates-detalhe.js`, `template-editor.js` | editar | Migrar para `DS.dataTable`/`DS.drawer`/tokens novos; preview de template (spec §46/§104) já existe parcialmente em `template-editor.js` — reaproveitar, não recriar. Renomear "Campos personalizados" → "Variáveis" (rota `Sistema > Variáveis`, spec §48), mantendo `/api/admin/campos-customizados` como está (renome é só de rótulo). |
| `automacoes.js` | editar | Migrar formulário para o padrão simplificado §51 (já é essencialmente isso hoje) usando componentes novos; **builder visual em blocos (§50) fica para depois** — a spec já autoriza isso ("não precisa ser canvas complexo inicialmente"). |
| `eventos.html/js/css` | renomear | "Eventos" → "Webhooks e logs", tabs Eventos recebidos/Execuções/Falhas; payload some do padrão de lista e vai para dentro do drawer ("Detalhes técnicos" recolhível, spec §114). |

**Test impact:** nenhuma automação/cadência muda de comportamento; risco principal é regressão visual/UX numa área que já lida com dinheiro real (mensagens pagas). Testar envio manual de template de teste após a migração de `templates-detalhe.js`.

**Verification:** enviar 1 template de teste real via UI nova e confirmar entrega no WhatsApp antes de considerar a fase concluída.

---

## Fase 8 — Catálogo (Produtos, Categorias, Agrupamentos, Promoções)

Maior fase nova — quatro sub-entregas, cada uma seu próprio PR:

### 8.1 Produtos
`server.js`: `GET/POST/PATCH /api/admin/produtos`, `POST /api/admin/produtos/:id/copiar` (via `products` GET/POST/PATCH/copy). **Sem excluir produto** (API não suporta) — nunca incluir botão de exclusão. `produtos.html/js/css` novo: lista (§34.1) + detalhe em tabs (§35) + wizard de criação (§36) com polling de mockup assíncrono (a doc da Ink deve expor um campo de status de curadoria/mockup — mapear o campo real antes de implementar o polling, não assumir formato). Operações em massa (§37) como `BulkOperation` local (tabela Postgres nova), processando item a item contra a API (sem endpoint de bulk nativo da Ink).

### 8.2 Categorias
`server.js`: `GET/POST/PATCH/DELETE /api/admin/categorias` (via `collections`, CRUD completo — único módulo de catálogo com delete real). `categorias.html/js/css`: lista + detalhe (Informações/Produtos/Ordenação) + drag-and-drop de ordenação (§40) — usar `custom_showcase` (PUT) que já existe na API para persistir ordem.

### 8.3 Agrupamentos
`server.js`: `GET/POST /api/admin/agrupamentos`, `DELETE /api/admin/agrupamentos/:id/produtos/:produtoId`. **Sem editar/excluir o agrupamento inteiro** — refletir isso na UI (ação "Excluir agrupamento" não existe, só "remover produto"). Seguir o padrão de fila resiliente do §39 da spec (idempotência, rate limit, retry) reaproveitando a mesma infra de fila já usada pelo WhatsApp (`msgQueue`/`AddRetry` como referência de padrão, não o mesmo código).

### 8.4 Promoções
`server.js`: `GET /api/admin/promocoes`, `POST/PATCH` por subtipo (`standard`/`progressive`/`unit_free`), `DELETE /api/admin/promocoes/:id`. `promocoes.html/js/css`: tabs Ativas/Agendadas/Encerradas + form por tipo.

**Test impact:** todo módulo é novo, sem risco de regressão em fluxos existentes — risco está em criar/editar produto real na loja em produção. Testar sempre primeiro contra 1 produto de teste (duplicado, não o original) antes de generalizar.

**Verification:** por sub-entrega, criar 1 registro de teste ponta a ponta e confirmar reflexo real na Ink (produto aparece na vitrine, categoria lista o produto, etc.) antes de fechar o PR daquela sub-entrega.

---

## Fase 9 — Instagram

Módulo inteiramente novo, **sem nenhum código/integração existente hoje** — maior incerteza do plano inteiro.

Pré-requisito antes de codar: confirmar que existe (ou vai existir) uma conexão com a Instagram/Meta Graph API equivalente ao que hoje existe para WhatsApp (`whatsapp-webhook-go`). Esta fase não deve começar sem isso decidido — **checkpoint explícito com o usuário antes de abrir o primeiro PR desta fase**, diferente das fases anteriores que só reorganizam ou estendem integrações já vivas.

Estrutura prevista, condicionada a esse checkpoint:
- Novo serviço (`instagram-webhook-go` ou módulo dentro do `whatsapp-webhook-go`, decisão a tomar no checkpoint) implementando `ChannelAdapter` (spec §56) ao lado de um `WhatsAppAdapter` extraído do código atual.
- `instagram-visao-geral.html/js/css`, `instagram-automacoes.js`, `instagram-comentarios.js`, `instagram-historico.js` seguindo os mesmos componentes do design system.
- Entitlement `instagram` (já existe na tabela da Fase 1) passa a ser respeitado de verdade — hoje é `true` para todos porque não há plano pago ainda.

---

## Fase 10 — Financeiro e Ferramentas

| Arquivo | Ação | Descrição |
|---|---|---|
| `server.js` | editar | `GET /api/admin/financeiro/resumo` (balance + balance_extract), `GET /api/admin/financeiro/movimentacoes`, `GET /api/admin/financeiro/antecipacoes`, `GET /api/admin/financeiro/saques` — **tudo somente leitura**, nunca prometer ação de saque pela UI (API não suporta). |
| `financeiro.html/js/css` | criar | Resumo (§65) + Movimentações (tabela). |
| `simular-frete.html/js/css` | criar | Tela pequena (§62), usa `shipping_simulation` GET; botão "Enviar pelo WhatsApp" só aparece se `entitlements.whatsapp`. |
| `pix-ferramenta.html/js/css` | avaliar | Boa parte já existe espalhado em `pedido-novo.js`/`pedido-vincular.js`/`pedido-admin.js` — esta sub-entrega é mais consolidação de UI do que feature nova; não duplicar lógica de geração de PIX já existente em `server.js`. |

---

## Estoque — decisão adiada

A spec (§109) pede reavaliar "Estoque": se o dado não é estoque real, não vender como tal. Isso depende de entender a fonte de dado de `src/estoque.js`/`/api/admin/estoque` (que hoje é uma inferência de disponibilidade agrupada por Tamanho+Cor+Modelo, corrigida recentemente — ver histórico de commits). **Decisão de rótulo ("Disponibilidade observada" vs manter "Estoque") fica para quando a Fase 8.1 (Produtos) existir**, pois a spec já recomenda incorporar isso ao Catálogo em vez de manter página solta.

---

## Naming / rebrand (spec §116)

Fora de escopo de implementação agora — a spec só pede não deixar a marca das lojas atuais (Use Sul/Centro/Norte) virar a marca do software. Nesta V2, o shell usa "Painel" ou nome neutro configurável (mesmo texto do brand na sidebar hoje, `ad-sidebar__brand`, passa a vir de config em vez de hardcoded `"Orgulho Regional"`) — isso já é feito na Fase 1 como parte de tirar hardcode de loja do shell, sem decisão de naming definitiva pendente.

---

## Ordem de execução (PRs)

1. Design Foundation (Fase 1) — sem risco funcional, só visual.
2. Navegação + Dashboard (Fase 2).
3. Central de Pedidos — página piloto (Fase 3) — valida o padrão antes de replicar.
4. Trocas (Fase 4).
5. Reembolsos (Fase 5).
6. Recuperação — Carrinhos + PIX (Fase 6).
7. WhatsApp V2 (Fase 7).
8. Catálogo — 4 sub-PRs (Fase 8.1 a 8.4).
9. **Checkpoint com usuário** → Instagram (Fase 9).
10. Financeiro e Ferramentas (Fase 10).

Cada fase é seu próprio PR, revisado e validado visualmente (breakpoints 1280–1920px, foco desktop) antes de abrir a próxima.

## Global Test Impact

- Nenhum endpoint de API existente é removido ou tem contrato quebrado — extensões são sempre endpoints novos ou campos novos.
- `go vet`/testes do `whatsapp-webhook-go` não são afetados até a Fase 9 (Instagram), quando um `ChannelAdapter` for extraído — nesse ponto, cobrir com teste de que o comportamento do WhatsApp não mudou (mesmo padrão Given-When-Then já usado no repo Go).
- Toda ação financeira/sensível nova (reembolso, troca, exclusão) precisa de teste manual ponta a ponta contra a API real antes de liberar — não há sandbox confirmado da Ink neste plano.

## Global Verification

- Fase 1–2: regressão visual manual em todas as telas existentes.
- Fase 3 em diante: cada fase só é considerada concluída quando a ação real correspondente (criar pedido, criar troca, reembolsar, criar produto, etc.) foi executada uma vez contra a API real da Ink e confirmada.
- Critérios de aceite visual (spec §117), SaaS (§118) e operacional (§119) usados como checklist de fechamento de cada fase, não só do projeto inteiro.
