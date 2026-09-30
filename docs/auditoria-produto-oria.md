# Auditoria de Produto — Oria

> Rodada **read-only**. Nenhum código, banco, migration, deploy, infraestrutura ou integração foi alterado.
> Único artefato criado: este documento.
> **Base auditada:** `origin/main` @ `0f57570` (PR #47). A branch local `bugfix/dashboard-kpi-lucro-bruto` estava 21 commits atrás
> (sem o módulo Parcerias e Afiliados); por isso o código foi extraído com `git archive` para a scratchpad e testado lá,
> sem tocar no working tree. Produção lida em modo leitura (navegação com a sessão já autenticada; nenhum clique em ação
> mutante).
> **Data:** 2026-09-28.

---

## 1. Resumo executivo

O Oria é um produto **tecnicamente maduro no núcleo** (pedidos, financeiro, clientes/RFM, analytics, mídia paga, catálogo Ink) e
**imaturo na camada comercial**. O que está pronto é sólido: 1.7k+ testes de painel verdes, isolamento por Organization com RLS e
controles negativos, fail-closed em entitlement, CSRF, HMAC em webhooks. O que impede vender hoje:

1. **A promessa principal — recuperar receita por WhatsApp — não opera.** A Meta ainda não aprovou o app como Tech Provider; a página
   Integrações pede "reconectar" o WhatsApp enquanto a visão geral do canal diz "Conectado". Recuperação, Campanhas, Automações e
   Templates dependem disso. A landing pública promete exatamente esse fluxo.
2. **Risco operacional de armazenamento** (volume Postgres a 96% em 26/09; sync de catálogo de 658k variantes). Estado atual não
   verificado por esta rodada.
3. **Não existe caminho de auto-atendimento**: sem cadastro, sem onboarding guiado, sem preço, sem plano/add-on comercializável.
4. **Entitlements incompletos**: Meta Ads, Google Ads, GA4 e Afiliados não têm guard de plano no backend.
5. **Storefront não existe no repositório** (só aparece em texto de escopo negativo). Não há add-on no modelo de planos.

## 2. Veredito geral

```text
VEREDITO: NECESSITA CORREÇÕES BLOQUEANTES ANTES DA PRODUCTIZAÇÃO
          (núcleo apto para rodada de fechamento; bloqueio = P0-001 + P1-001..P1-006)
```

Núcleo operacional/analítico: **apto para vender hoje** (com ajustes P2). Camada de comunicação (WhatsApp): **não vendável**.
Home pública nova: **só depois** de P1-001, P1-002, P1-005 e P1-006 estarem decididos.

## 3. Arquitetura analisada

| Peça | O que é | Evidência |
|---|---|---|
| Monorepo | painel (Node/Express + React/Vite SPA), gerador de criativos (Python 3.12), serviço WhatsApp (Go 1.25), control plane (`apps/platform-admin`) | `README.md`, `package.json` |
| Painel backend | **um** `server.js` de 17.280 linhas, 258 rotas, Postgres com **RLS** e role `oria_app` (NOSUPERUSER/NOBYPASSRLS) | `apps/panel/server.js`, `lib/platform/app-role.js` |
| Painel frontend | React 18 + TS, ~40 páginas lazy, Radix, Recharts | `src/App.tsx`, `src/shell/nav.ts` |
| Auth | login individual, sessão `__Host-` cookie, CSRF por header `X-CSRF-Token`, limiter de login/convite, papéis `owner`/`member` | `lib/auth/*` |
| Tenancy | Organization ↔ Store 1:1 (`uq_stores_organization`), `ConnectorContext {organizationId, storeId, integrationId}` | `docs/architecture/*`, memória ORIA-TENANCY-STORE-01 |
| Autorização por plano | `plans` → `plan_features` → `organization_subscriptions` (1 ativa por org) → overrides; leitura via `entitlements_efetivos()` SECURITY DEFINER; ausência/erro nega | `lib/platform/entitlements.js`, `feature-routes.js`, migration 0019/0023 |
| Integrações | Ink (comércio), WhatsApp (Meta API + Embedded Signup, ou WhatsApp Web via agente), Meta Ads, Google Ads, GA4, OpenAI (BYOK), Instagram (em breve) | `server.js:9266-9326` |
| Segredos | cofre `integration_secrets` cifrado (`ENCRYPTION_MASTER_KEY`), `secret-guard` bloqueia segredo em resposta | `lib/secrets/*`, INV-13 |
| Jobs | `JOBS.agendar(...)` com leases por Organization (catálogo, follow-ups, campanhas, afiliados, criativos) | `lib/platform/jobs.js`, `leases.js` |
| Webhooks | Ink (`/api/webhooks/ink/:token`, token opaco → org), WhatsApp repasse do Go (HMAC), agente WhatsApp Web (token) | `server.js:16688,16861,13141` |
| Storage | volume Railway (uploads/mídia) + Postgres; guard de disco `[STORAGE_GUARD]` | `lib/platform/storage-guard.js` |
| Rotas públicas | landing `/oria`, `/politica-de-privacidade`, `/hotpix/:id`, `/api/pedidos/:id`, `/midia/:token/arquivo`, `/assets/pedidos/:id.png`, convite | `lib/arquivos-publicos.js`, `server.js:17104-17150` |
| Filas/DLQ | WhatsApp Go: fila + `retry.go` + idempotência; **sem DLQ formal** no painel (campanhas/outbox com estados) | `services/whatsapp/queue.go` |
| Observabilidade | logs `console.*` (19 `console.log` no server), `http-safety` (rede central de erro), `STORAGE_GUARD`; sem tracing | `lib/platform/http-safety.js` |
| Billing | **inexistente** (só acesso técnico; "não há preço, trial, cupom nem cadência" — `apps/platform-admin/lib/plans.js`) | idem |
| Hosts | `oria.com.br` (public) / `app.` (tenant) / `admin.` (control) — decisão em `docs/architecture/web-hosts.md`; em produção ainda `*.up.railway.app` | memória dogfooding |

Peças que precisam funcionar juntas para o Oria entregar valor: **Ink API** (pedidos/catálogo) + **Postgres com folga de disco** +
**sessão/tenant context** + (para comunicação) **WhatsApp/Meta aprovado** + (para mídia) OAuth Meta/Google válidos.

## 4. Mapa de áreas do produto

| Área (menu) | Itens | Estado da área |
|---|---|---|
| Visão geral | Dashboard | Pronta |
| Comunicação | Canal, Recuperação, PIX, Automações, Templates, Mensagens, Fila, Parcerias e Afiliados | **Bloqueada por WhatsApp** (exceto PIX) |
| Marketing e dados | Meta Ads, Google Ads, GA4, UTM, Desempenho de produtos, Jornada | Pronta com ajustes |
| Criativos | 7 seções do gerador | Ajuste |
| Campanhas | Todas, Segmentos | Segmentos pronto; Campanhas bloqueada |
| Operação | Pedidos, Clientes, Trocas, Simular frete | Pronta |
| Financeiro | Visão, Despesas, Custos de API, Reembolsos | Pronta com ajustes |
| Catálogo | Produtos, Categorias, Agrupamentos, Promoções | Ajuste |
| Loja (menu superior) | Configurações, Integrações, Campos | Ajuste |
| Fora do menu | Estoque, Playground, ferramenta interna Origens, Instagram, Histórico, Relatórios | **Não expor** |

## 5. Inventário completo de funcionalidades

Legenda: dados reais **S**/parcial/mock; F/B/P = frontend/backend/persistência (✔ completo, ◐ parcial). Plano = guard de backend.
Estados vazio/loading/erro foram avaliados por varredura estática (`EmptyState`/`Skeleton`/`ErrorState`/`catch` por diretório de
página) e confirmados em produção onde indicado.

| # | Área | Feature | Rota | Entrada | F/B/P | Ext. | Dados | Permissão | Plano (guard) | Vazio/Load/Erro | Testes | Status | Observações |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Visão geral | Dashboard | `/admin/dashboard` | menu topo | ✔✔✔ | Ink, Meta | S | member+owner | `financial` (parte) | ✔/✔/✔ | invariants (KPIs, período) | PRONTO | KPIs alinhados à Ink em `ac22435`; conta fecha (lucro bruto − mídia) |
| 2 | Operação | Pedidos (central + detalhe) | `/admin/pedidos-central` | menu | ✔✔✔ | Ink | S | idem | — | ✔ | sim | PRONTO | |
| 3 | Operação | Trocas e devoluções | `/admin/trocas`, `/trocas/nova` | menu | ✔✔✔ | Ink | S | idem | `exchanges` (compat) | ✔ | sim | AJUSTE | criação real contra Ink não observada |
| 4 | Operação | Clientes / RFM / exportar | `/admin/clientes` | menu | ✔✔✔ | Ink | S | idem | — | ✔ | forte (RFM, lista, detalhe) | PRONTO | |
| 5 | Operação | Simular frete | `/admin/simular-frete` | menu | ✔✔◐ | Ink | S | idem | — | ✔ | sem teste dedicado | AJUSTE | |
| 6 | Financeiro | Visão financeira | `/admin/financeiro` | menu | ✔✔✔ | Ink, Meta, Google | S | idem | `financial` | ✔ | sim | PRONTO | escala de receita×custo documentada em `lib/financeiro/consolidado.js` |
| 7 | Financeiro | Despesas | `/admin/financeiro/despesas` | menu | ✔✔✔ | — | S | idem | `financial` | ✔ | sim | PRONTO | |
| 8 | Financeiro | Custos de API | `/admin/financeiro/custos-api` | menu | ✔✔✔ | — | S | idem | `financial` | ✔ | sim | AJUSTE | conceito técnico exposto ao lojista sem explicação |
| 9 | Financeiro | Reembolsos | `/admin/reembolsos` | menu | ✔✔✔ | Ink | S | idem | `refunds` (compat) | ✔ | sim | AJUSTE | "sem validação com pedido real" (checkpoint 21/09) |
| 10 | Catálogo | Produtos (lista/novo/duplicar) | `/admin/produtos`, `/novo` | menu | ✔✔✔ | Ink | S | idem | `catalog` | ✔ | sim | AJUSTE | wizard de 5 passos; depende de sync com disco |
| 11 | Catálogo | Categorias + associar em lote | `/admin/categorias`, `/associar` | menu | ✔✔✔ | Ink | S | idem | `catalog` | ✔ | sim | AJUSTE | jobs em lote com retry/cancel |
| 12 | Catálogo | Agrupamentos | `/admin/agrupamentos` | menu | ✔✔✔ | Ink | S | idem | `catalog` | ✔ | sim | AJUSTE | |
| 13 | Catálogo | Promoções | `/admin/promocoes` | menu | ✔✔✔ | Ink | S | idem | `catalog` | ✔ | sim | AJUSTE | escrita só provada por testes |
| 14 | Comunicação | Canal WhatsApp (visão geral) | `/admin/whatsapp` | menu | ✔✔◐ | Meta | parcial | idem | `whatsapp` | ⚠ | sim | AJUSTE | mostra "Conectado" com Integrações pedindo reconexão (P1-001) |
| 15 | Comunicação | Recuperação carrinho/PIX | `/admin/recuperacao` | menu | ✔✔✔ | WhatsApp | S | idem | `whatsapp` | ✔ | sim | INCOMPLETO | envio bloqueado pelo canal |
| 16 | Comunicação | PIX + HotPix público | `/admin/pix`, `/hotpix/:id` | menu | ✔✔✔ | Ink | S | público por id 72 bits | — | ✔ | `hotpix.test` | AJUSTE | domínio do link (P1-005) |
| 17 | Comunicação | Automações por evento | `/admin/automacoes` | menu | ✔✔✔ | WhatsApp/Ink webhook | S | idem | `whatsapp` | ✔ | sim | INCOMPLETO | canal bloqueado; webhook Ink não ativo |
| 18 | Comunicação | Templates Meta (lista/novo/detalhe) | `/admin/templates*` | menu (só `meta_api`) | ✔✔✔ | Meta | "Indisponível" | idem | `whatsapp` | ✔ | sim | INCOMPLETO | aprovados = Indisponível em produção |
| 19 | Comunicação | Mensagens web + Fila de envio | `/admin/mensagens*`, `/whatsapp/fila` | menu (só `whatsapp_web`) | ✔✔✔ | agente local | n/v | idem | `whatsapp` | ✔ | sim | AJUSTE | **não validado** com agente real nesta rodada |
| 20 | Campanhas | Campanhas (lista/nova/detalhe/lotes) | `/admin/campanhas*` | menu | ✔✔✔ | WhatsApp | S | idem | `whatsapp` | ✔ (vazio ok em prod) | sim | INCOMPLETO | envio bloqueado; "Relatórios" não existe |
| 21 | Campanhas | Segmentos | `/admin/campanhas/segmentos` | menu | ✔✔✔ | — | S | idem | `whatsapp` (!) | ✔ | sim | PRONTO | guard exige `whatsapp` mesmo sendo análise de base |
| 22 | Comunicação | Parcerias e Afiliados (9 telas) | `/admin/parcerias*` | menu (flag) | ✔✔✔ | Ink promoções | S | owner p/ escrita | **nenhum** (flag global) | ✔ | forte (5 suítes + 2 invariants) | INCOMPLETO | criação de cupom na Ink nunca observada (P1-003) |
| 23 | Marketing | Meta Ads | `/admin/meta-ads` | menu | ✔✔✔ | Meta | S | idem | **sem guard** | ✔ | sim | PRONTO | 3.603 linhas importadas em prod |
| 24 | Marketing | Google Ads | `/admin/google-ads` | menu | ✔✔✔ | Google | S | idem | **sem guard** | ✔ | sim | AJUSTE | conectado; sem validação dinâmica nesta rodada |
| 25 | Marketing | GA4 | `/admin/analytics` | menu | ✔✔✔ | Google | S (520 sessões vistas) | idem | **sem guard** | ✔ | sim | PRONTO | cache visível ("atualizado há 2min") |
| 26 | Marketing | UTM Tracker | `/admin/utm` | menu | ✔✔✔ | GA4 | S | idem | — | ✔ | sim | PRONTO | |
| 27 | Marketing | Desempenho de produtos | `/admin/desempenho-produtos` | menu (feature) | ✔✔✔ | GA4+Ink | S | idem | `analytics_product_performance` | ✔ | forte | AJUSTE | depende do sync de catálogo (P0-001) |
| 28 | Marketing | Jornada de compra | `/admin/jornada-compra` | menu (feature) | ✔✔✔ | GA4+Meta+Ink | S | idem | `analytics_product_performance` | ✔ | sim | AJUSTE | idem |
| 29 | Criativos | Gerador (7 seções) | `/admin/criativos/:aba` | menu | ✔✔✔ | OpenAI/Python | S | idem | `creative_generator` | ✔ | forte (~20 suítes) | AJUSTE | provider `fake` no código; custo BYOK |
| 30 | Loja | Integrações | `/admin/integracoes` | menu Loja | ✔✔✔ | todas | S | owner p/ conectar | — | ✔ | forte | PRONTO | estados honestos ("Em breve", "Reconexão necessária") |
| 31 | Loja | Configurações | `/admin/configuracoes` | menu Loja | ✔✔✔ | — | S | idem | — | n/a | sim | AJUSTE | só nome do produto (63 linhas) |
| 32 | Loja | Campos personalizados | `/admin/campos` | menu Loja | ✔✔✔ | — | S | idem | — | ✔ | sim | AJUSTE | sem explicação de para quê |
| 33 | Acesso | Login / workspace / convite | `/admin/convite`… | link | ✔✔✔ | — | S | anônimo (convite) | — | ✔ | forte | PRONTO | |
| 34 | Operação | Estoque | `/admin/estoque` | **oculta** | ✔✔◐ | Ink | **falha em prod** | idem | `catalog` | ✗ erro | sim | NÃO EXPOR | prod: "Não foi possível carregar… não está disponível para a sua loja" + botão "Limpar e ressincronizar" |
| 35 | Interno | Playground do DS | `/admin/playground` | **link direto** | ✔ | — | mock | qualquer logado | — | n/a | — | NÃO EXPOR | acessível em produção (confirmado) |
| 36 | Interno | Origens migration | `/admin/internal/origens-migration` | link direto | ✔✔✔ | Ink | S | flag `INTERNAL_TOOLS_ENABLED` | — | ✔ | forte | NÃO EXPOR | bloqueio real no backend; página existe no bundle |
| 37 | Comunicação | Instagram | — | oculto / linha "Em breve" | ✗ | — | — | — | `instagram` = em_breve | — | — | NÃO EXPOR | honesto na UI |
| 38 | Comunicação | Histórico WhatsApp | — | `comingSoon` | ✗ | — | — | — | — | — | — | NÃO EXPOR | não construído |
| 39 | Campanhas | Relatórios de campanha | — | `comingSoon` | ✗ | — | — | — | — | — | — | NÃO EXPOR | falta tracking de entrega/clique |

Fora da contagem: **Oria Admin** (`apps/platform-admin`, control plane interno) e o **serviço WhatsApp Go** (infra).

## 6. Matriz de maturidade

| Área | Feature | Status | Prioridade | Dados reais | Fluxo E2E | UX | Testes | Pode vender? |
|---|---|---|---:|:-:|:-:|:-:|:-:|:-:|
| Visão geral | Dashboard | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Operação | Pedidos | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Operação | Clientes / RFM | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Operação | Trocas | AJUSTE | P2 | ✅ | ⚠️ | ✅ | ✅ | ⚠️ |
| Operação | Simular frete | AJUSTE | P3 | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| Financeiro | Visão financeira | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Financeiro | Despesas | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Financeiro | Custos de API | AJUSTE | P2 | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| Financeiro | Reembolsos | AJUSTE | P2 | ✅ | ⚠️ | ✅ | ✅ | ⚠️ |
| Catálogo | Produtos | AJUSTE | P0-cond. | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Catálogo | Categorias / Agrupamentos / Promoções | AJUSTE | P2 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Comunicação | Canal WhatsApp | AJUSTE | P1 | ⚠️ | ❌ | ⚠️ | ✅ | ❌ |
| Comunicação | Recuperação | INCOMPLETO | P1 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Comunicação | Automações | INCOMPLETO | P1 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Comunicação | Templates | INCOMPLETO | P1 | ❌ | ❌ | ✅ | ✅ | ❌ |
| Comunicação | Mensagens web / Fila | AJUSTE | P2 | n/v | n/v | ✅ | ✅ | ⚠️ |
| Comunicação | PIX + HotPix | AJUSTE | P1 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Comunicação | Parcerias e Afiliados | INCOMPLETO | P1 | ✅ | ⚠️ | ✅ | ✅ | ❌ |
| Campanhas | Campanhas | INCOMPLETO | P1 | ✅ | ❌ | ✅ | ✅ | ❌ |
| Campanhas | Segmentos | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Marketing | Meta Ads | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Marketing | Google Ads | AJUSTE | P2 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Marketing | GA4 / UTM | PRONTO | P1 (guard) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Marketing | Desempenho / Jornada | AJUSTE | P0-cond. | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Criativos | Gerador | AJUSTE | P2 | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| Loja | Integrações | PRONTO | - | ✅ | ✅ | ✅ | ✅ | ✅ |
| Loja | Configurações / Campos | AJUSTE | P2 | ✅ | ✅ | ⚠️ | ✅ | ⚠️ |
| Interno | Estoque, Playground, Origens, Instagram, Histórico, Relatórios | NÃO EXPOR | P2/P3 | — | — | — | — | ❌ |

## 7. Fluxos ponta a ponta analisados

Análise por leitura de código + testes + navegação de produção em modo leitura. Nenhum fluxo com efeito externo foi executado.

| Fluxo | Resultado |
|---|---|
| **Conectar Ink → sincronizar → ver pedidos → detalhe** | Funciona (Ink "Credencial cadastrada"). Falta: **recebimento automático (webhook) não ativado** em produção — o lojista só vê dado por polling/sync manual. |
| **Conectar Meta/Google/GA4 → dados no dashboard → desconectar** | Funciona; OAuth com `state` persistido; desconectar exige `owner` (D-1 do fechamento de 25/09 **já corrigido** em `main`). Sem guard de plano (P1-004). |
| **Conectar WhatsApp → templates → automação → envio** | **Quebrado no meio**: Integrações mostra "Reconexão necessária"; Canal mostra "Conectado"; Templates aprovados = "Indisponível". Bloqueio externo (Tech Provider). |
| **Criar campanha → segmento → enviar → acompanhar** | Criar/editar/lotes existem; envio depende do canal; "acompanhar" não existe (Relatórios hidden). Em produção, lista vazia com CTA (empty state adequado). |
| **Recuperar carrinho/PIX** | UI e backend completos; envio bloqueado. Painel mostra "Carrinhos recuperáveis 0 / Taxa 0%" sem dizer que o canal está fora. |
| **Criar PIX manual → HotPix → pagamento** | Funciona por testes; link usa `SITE_BASE_URL` (fallback legado, P1-005). Página pública expõe nome do cliente, valor e PIX por capability de 72 bits (decisão documentada). |
| **Parcerias: criar parceiro → cupom Ink → apurar → pagar** | Motor, cronograma financeiro, idempotência de pagamento e CSV cobertos por testes; **POST de promoção na Ink nunca observado com Ink real**. |
| **Primeiro acesso de tenant novo** | Convite → conta → **cai direto no dashboard vazio**; onboarding guiado **não implementado** (`divida-onboarding-primeiro-acesso.md`). |
| **Logout/login, deep link** | Rotas `/admin/*` servem a SPA; `ProtectedRoute` + `AppShell`; `/admin/eventos` e `/admin/carrinhos` redirecionam. |

## 8. Achados P0

### ORIA-P0-001 — Risco de indisponibilidade por volume cheio (sync de catálogo)

**Prioridade:** P0 (condicional à verificação do estado atual) · **Área:** Plataforma/Catálogo · **Status atual:** AJUSTE (Produtos/Desempenho)

**Problema.** O sync full reescreve ~3,68 M identities; em 26/09 o volume chegou a **96%** (194 MB livres), `pg_wal` 833 MB e o sync terminou `partial_failure` com `No space left on device`. Enquanto não houver folga, qualquer escrita de qualquer Organization pode falhar e uma falha de WAL derruba o Postgres.

**Evidência.** `docs/architecture/storage-audit-2026-09.md` (alerta operacional), `docs/operations/storage-migration-window-2026-09.md`, `lib/platform/storage-guard.js`, agendador `catalogo-canonico` (1 h).

**Impacto.** Perda de disponibilidade do produto inteiro; risco de corrupção/indisponibilidade do Postgres compartilhado entre tenants.

**Resultado esperado.** Volume com folga confirmada, modo `derived`/`per_product` aplicado conforme runbook, alerta `PG_VOLUME_CAPACITY_GB` ativo.

**Dependências.** Decisão do dono (aumentar volume). **Não validado nesta rodada** (sem acesso ao Railway).

**Atualização 2026-09-28 — status: `BLOQUEADO POR ACESSO À INFRA`.** Reanálise do código de `origin/main` (`902cc96`): o bootstrap já não reescreve identities sem mudança (`d173ff2`), `per_product`/`derived`/poda existem e o cooldown após falha é de 6 h; faltava um portão — o vigia só logava. Adicionado `storage_critical` ao início de todo full sync (>80 %), na branch `fix/oria-p0-storage`. Capacidade, WAL, modos ativos e último sync **de produção não foram observados** (leitura via Railway negada; não contornada). Checklist de coleta e critério de encerramento: [`docs/operations/p0-storage-closure-2026-09.md`](operations/p0-storage-closure-2026-09.md).

## 9. Achados P1

### ORIA-P1-001 — WhatsApp: canal não entrega valor e a UI se contradiz
**Prioridade:** P1 · **Área:** Comunicação · **Status:** INCOMPLETO (Recuperação, Automações, Templates, Campanhas)

**Problema.** `/admin/integracoes`: "O WhatsApp precisa ser reconectado" / "Reconexão necessária". `/admin/whatsapp` (mesma sessão): "Número **Conectado**", "Templates aprovados **Indisponível**". Aplicação Meta ainda não é Tech Provider aprovado (memória 2026-09-20; checkpoint 21/09: "BLOCKED externo").

**Evidência.** `WhatsappVisaoGeralPage.tsx` (usa `connected` do serviço Go) vs `integration-read-model.js` (estado `degraded/reconnect`); leitura em produção em 28/09.

**Impacto.** Feature central prometida (recuperação de receita) não funciona; usuário recebe duas verdades.

**Resultado esperado.** Uma fonte de estado único do canal; telas dependentes mostram banner "canal indisponível — reconecte" com link; Home não promete envio até aprovação Meta.

**Dependências.** Aprovação Meta (MEI, verificação de negócio, App Review).

### ORIA-P1-002 — Landing atual promete o que o produto não opera e tem identidade herdada
**Prioridade:** P1 · **Área:** Comercial · **Status:** AJUSTE

**Problema.** `oria.html` promete "envia uma mensagem por WhatsApp" para recuperação; `canonical`/`og:url`/`og:image` apontam para `orgulhoregional.com.br`; contato é e-mail pessoal; "operado pelo Orgulho Regional"; sem preço, sem cadastro, sem prova visual. A página foi escrita para verificação OAuth do Google, não para vender.

**Evidência.** `apps/panel/oria.html` (linhas 8–17, rodapé, seção "Quem opera").

**Impacto.** Promessa sem lastro; SEO/canonical no domínio errado; nada converte.

**Resultado esperado.** Ver seções 25–27.

### ORIA-P1-003 — Parcerias e Afiliados: sem plano e escrita real na Ink não validada
**Prioridade:** P1 · **Área:** Comunicação/Parcerias · **Status:** INCOMPLETO

**Problema.** Módulo liga/desliga por `AFILIADOS_MODULE_ENABLED` (env **global**, não entitlement por Organization) e já está visível em produção. "Ativar" pode criar promoção real na Ink; o POST nunca foi observado contra Ink real (só leitura GABRIEL10 e Ink falsa em teste).

**Evidência.** `server.js:17262-17283`, `lib/afiliados/routes.js`, `docs/afiliados/auditoria-integracao.md` §7–§8, `feature-routes.js` (sem regra para `/api/admin/afiliados`).

**Impacto.** Qualquer tenant com a flag global teria o módulo; ação externa com dinheiro/desconto real sem prova.

**Resultado esperado.** Feature `afiliados` no vocabulário + guard + validação com Ink real (cupom de teste, encerramento) antes de comunicar.

### ORIA-P1-004 — Backend sem guard de plano para Meta Ads, Google Ads e GA4
**Prioridade:** P1 · **Área:** Billing/Entitlements · **Status:** AJUSTE

**Problema.** `ESTADO_DAS_FEATURES` marca `meta_ads`, `google_ads`, `analytics_ga4` como `sem_guard`; nenhuma regex em `feature-routes.js` cobre `/api/admin/analytics/meta|google-ads`, `/api/admin/integrations/*`, GA4 performance. O plano "descreve" a feature mas não protege.

**Evidência.** `lib/platform/entitlements.js` (`ESTADO_DAS_FEATURES`), `lib/platform/feature-routes.js`.

**Impacto.** Impossível vender essas integrações como itens de plano; API permite o que o plano negaria.

**Resultado esperado.** Regras `ROTAS` para os três, promovendo-os a `implementada`; UI já respeita `useEntitlement`.

### ORIA-P1-005 — Link de pagamento HotPix com fallback para domínio legado
**Prioridade:** P1 · **Área:** PIX · **Status:** AJUSTE

**Problema.** `SITE_BASE_URL` cai em `https://orgulhoregional.com.br` se a env faltar; `docs/architecture/web-hosts.md` já classificou isso como dívida (fail-fast + `PUBLIC_SITE_URL`). Exemplo de variável no editor de template também usa o domínio antigo.

**Evidência.** `server.js:93`, `:14006`, `:14614`, `:15248`.

**Impacto.** Link de pagamento/mídia enviado ao cliente apontando para outro site, sem erro visível. **Valor atual da env em produção: não verificado.**

**Resultado esperado.** `PUBLIC_SITE_URL` obrigatório em produção; teste de boot.

### ORIA-P1-006 — Sem caminho de auto-atendimento (cadastro, onboarding, plano)
**Prioridade:** P1 · **Área:** Comercial/Onboarding · **Status:** INCOMPLETO

**Problema.** Não há tela de onboarding no frontend (`rg onboarding src` → 0); primeiro acesso cai no dashboard vazio; landing só tem "Entrar no painel"; Organization só nasce pelo Oria Admin; sem preço/checkout.

**Evidência.** `docs/productization/divida-onboarding-primeiro-acesso.md`, `apps/platform-admin`, `oria.html`.

**Impacto.** Cliente novo não consegue começar sozinho; a Home nova não terá para onde levar.

**Resultado esperado.** Decisão de modelo (venda assistida vs self-service); se assistida, Home com "falar com a gente" + onboarding guiado mínimo.

## 10. Achados P2

| ID | Título | Evidência | Impacto | Resultado esperado |
|---|---|---|---|---|
| ORIA-P2-001 | **Estoque** inacessível no menu mas vivo por URL, quebrado em produção e com ação destrutiva | `nav.ts` (comentário 2026-09-26); `/admin/estoque` em produção; `POST /controle-estoque/limpar` | usuário que chega por link vê erro + botão "Limpar e ressincronizar" | remover rota/página ou bloquear por flag; página honesta |
| ORIA-P2-002 | **Webhook Ink não ativado** em produção | Integrações: "Recebimento automático não ativado"; `PRODUCT.md` promete tempo real | automações/recuperação sem tempo real | ativar e validar; ajustar copy |
| ORIA-P2-003 | **Zero teste automatizado de frontend**; QA Playwright é manual, fora do CI | `package.json` (sem vitest/jsdom/playwright); `scripts/qa-*.mjs` | regressões de UI só na mão (histórico de defeitos D-1/D-2) | smoke E2E mínimo em CI |
| ORIA-P2-004 | **Papéis owner/member sem matriz**: `member` pode iniciar campanhas, editar despesas, etc. (44 mutações sem `requireOwner`) enquanto o produto diz "sem multiusuário" | `server.js` rotas `POST/PUT/DELETE` de campaigns, financeiro, automações; `lib/auth/router.js:393` | decisão de produto implícita | matriz papel × ação e alinhar `PRODUCT.md` |
| ORIA-P2-005 | **Sem headers de segurança** (CSP, X-Frame-Options/frame-ancestors, HSTS, nosniff, Referrer-Policy) | `rg` em `server.js`/`lib` → nenhum | clickjacking do painel autenticado | middleware de headers (ou proxy) |
| ORIA-P2-006 | **JSON de 100 MB global**, inclusive nas rotas anônimas (webhooks); **sem rate limit geral** (só login/convite/catálogo) | `server.js:850`; `lib/auth/rate-limit.js` | DoS barato em endpoints públicos | limite pequeno por padrão e grande só nas rotas de arte; rate limit nos webhooks |
| ORIA-P2-007 | **Documentação obsoleta engana quem trabalha no repo** — `apps/panel/CLAUDE.md` descreve "Buscador de Cidades e Estampas" e proíbe "transformar em SaaS/dashboard"; `PRODUCT.md` fala de `admin/`, senha única, 3 lojas; README diz "DOGFOOD NOT STARTED / ROLLOUT BLOCKED" com produção no ar | arquivos citados | rodadas guiadas por agente herdam regras erradas | reescrever/arquivar |
| ORIA-P2-008 | **Legado do dono hardcoded**: `LOJAS = {sul, centro, norte}` (8 usos) e 104 referências a `loja_legada`/`lojaLegadaDoContexto` em `server.js` | `server.js:92` | acopla o produto ao setup da Use Origens; risco em mensagens/variáveis | remover após dívidas de `store_id` |
| ORIA-P2-009 | **Dependências de integração não explicadas** nas telas (Recuperação/Campanhas/Automações mostram 0/vazio sem dizer que o WhatsApp está fora; Canal sem CTA) | `WhatsappVisaoGeralPage.tsx`, prod | usuário acha que não há carrinhos | banner de dependência com link para Integrações |
| ORIA-P2-010 | **Arquitetura de informação**: "Parcerias e Afiliados" dentro de Comunicação; "Marketing e dados" mistura mídia paga, analytics e catálogo analítico; "Custos de API" em Financeiro; "Campanhas" separado de "Comunicação"; nomes de rota legados (`/admin/pedidos` = PIX) | `nav.ts` | descoberta ruim; nomes ambíguos | reagrupar (ver §25) |

## 11. Achados P3

| ID | Título | Evidência |
|---|---|---|
| ORIA-P3-001 | Playground do design system acessível a qualquer usuário logado em produção | `/admin/playground` (confirmado) |
| ORIA-P3-002 | `server.js` monolítico (17.280 linhas), 19 `console.log`, mistura de domínios | `server.js` |
| ORIA-P3-003 | Rotas/APIs órfãs: `GET /api/admin/dashboard/customers`, `GET /api/admin/pedidos/uf-diagnostico` sem consumidor no front | varredura `server.js` × `src/` |
| ORIA-P3-004 | `exigirOwner` degrada para `next()` se `TENANT` for falsy (servidor sem Postgres) | `server.js:763` |
| ORIA-P3-005 | Vocabulário comercial ainda carrega chaves de compat (`catalog`, `exchanges`, `refunds`) e flag de transição `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED` | `entitlements.js`, `server.js:16871` |

## 12. Integrações

| Integração | Classificação | Evidência / observações |
|---|---|---|
| **Reserva Ink** (API) | **CONECTA E ENTREGA VALOR** | credencial no cofre, retry (`lib/ink/retry.js`), idempotency keys em escritas, backfill; produção conectada |
| **Ink webhook** | CONECTA, MAS FLUXO É INCOMPLETO | token opaco por org, HMAC; **não ativado** em produção |
| **Meta Ads** | CONECTA E ENTREGA VALOR | OAuth "Oria Ads", conta selecionada, 3.603 insights; **sem guard de plano** |
| **Google Ads** | CONECTA E ENTREGA VALOR (não revalidado hoje) | conectado em Integrações; sem developer token exigido (doc env-manifest) |
| **GA4** | CONECTA E ENTREGA VALOR | 520 sessões vistas em produção; cache com idade visível |
| **WhatsApp Meta API / Embedded Signup** | CONECTA, MAS FLUXO É INCOMPLETO / **NÃO VALIDADO COM PROVIDER REAL** para envio | Meta app não é Tech Provider; reconexão necessária; billing = cliente paga à Meta, linha de crédito não implementada |
| **WhatsApp Web (agente local)** | IMPLEMENTAÇÃO PARCIAL — **não validado contra provider real** nesta rodada | heartbeat/claim/resultado; depende de app desktop |
| **OpenAI (BYOK)** | CONECTA E ENTREGA VALOR (leitura de estado) | "Chave cadastrada"; geração real não executada aqui (custo) |
| **Instagram** | MOCK / PLACEHOLDER (declarado "Em breve") | linha honesta em Integrações |
| **Cupom Ink (Afiliados)** | NÃO VALIDADO COM PROVIDER REAL (escrita) | ver P1-003 |

Refresh/expiração de token, reconexão e desconexão têm estado explícito (`degraded`, `platform_unavailable`, `not_configured`, …) no read model; dados órfãos pós-desconexão são cobertos por testes de integração.

## 13. Dados e métricas

- **Fonte de verdade:** Ink para pedidos/receita/custo; Meta/Google para mídia; GA4 para tráfego. Conta do Dashboard fecha (lucro bruto R$ 548,50 − mídia R$ 412,28 = R$ 136,22).
- **Boa prática presente:** ausência é "—"/"Indisponível", nunca zero fabricado (`KpiCard`, `JornadaCompra`, `productAnalytics.ts`); períodos explícitos (`periodo-explicito-mais-telas`); comentário de escala receita×custo em `consolidado.js`.
- **Risco de interpretação:** Dashboard mostra "Recuperação 0% / carrinhos recuperáveis 0" sem informar que o canal de envio está fora (P2-009); mídia do dia inteira contra pedidos parciais do dia; GA4 em cache (mostra idade).
- **Timezone:** dias resolvidos por fuso da loja (afiliados) e `America/Sao_Paulo`; 38 ocorrências no backend — sem padronização central verificada.
- **Não validado:** reconciliação numérica contra a Ink para o mesmo período nesta rodada.

## 14. Billing / Entitlements

- **Existe:** `plans`, `plan_features`, 1 `organization_subscriptions` ativa (índice único), `organization_entitlement_overrides`, suspensão nega tudo, `entitlements_estado` distingue causas. Fail-closed provado por testes e controle negativo `ENT-01`.
- **Não existe:** preço, trial, cadência, limites de uso, add-on, upgrade/downgrade/cancelamento com grace, cobrança.
- **Inconsistências:** `sem_guard` (Meta/Google/GA4), Afiliados por env global, `whatsapp` protegendo Segmentos, `catalog` como entitlement de coisa que é capability Ink, `advancedAutomations` = `nao_implementada` mas presente no vocabulário e no espelho do front.
- **Front × back:** o espelho do front é fail-closed e só esconde; back é autoridade.

## 15. Permissões e isolamento por workspace

- **Modelo respeitado:** 1 Organization = 1 Store; nenhum código multiloja novo.
- **Evidências positivas:** RLS em tabelas de tenant + role sem BYPASSRLS (suíte `app-role`); `tenancy-isolation`, `INV-09/12/20/22/28` com controle negativo passa→viola→falha→restaura; token de webhook Ink resolve org por hash SECURITY DEFINER; Creative Core tenant = Organization do contexto; cache `tiposPorLojaCache` chaveado por `store_id`; identidade nunca vem de header/body (`lib/auth/router.js`).
- **Pontos de atenção:** papéis sem matriz (P2-004); rotas públicas por capability (hotpix, mídia) — desenho documentado; `exigirOwner` degrada sem Postgres (P3-004). **Nenhum vazamento entre workspaces encontrado por inspeção.**

## 16. Onboarding e empty states

- Por página (heurística estática, ~40 páginas): a maioria tem empty/loading/erro; lacunas: `pedido-novo` (sem empty/loading), `trocas-nova` (sem loading), `pix-ferramenta` (delegado), `convite`.
- Produção: Campanhas mostra vazio com CTA (adequado); Estoque mostra erro com botões destrutivos (inadequado); Canal WhatsApp mostra zeros sem CTA.
- **Não há onboarding do primeiro acesso** (P1-006) nem ajuda contextual (header notifications/help eram decorativos segundo `PRODUCT.md`).

## 17. Mobile

**Não validado dinamicamente.** O Chrome desta máquina não reduz a janela abaixo de ~563 px, então 360/375/390 px não puderam ser testados; nesse piso não houve overflow horizontal no Dashboard (`scrollWidth 552 ≤ 563`). Há scripts Playwright manuais (`scripts/qa-shell-navegacao.mjs`, `scripts/clientes/smoke-viewport.mjs`) e sidebar recolhível; não rodados aqui (exigem servidor local com mocks).

## 18. Segurança

Sem pentest; por inspeção.

| Tema | Resultado |
|---|---|
| Autenticação/sessão | cookie `__Host-`, limiter de login/convite, revogação, CSRF por header em POST/PUT/PATCH/DELETE ✔ |
| Segredos | cofre cifrado, `secret-guard` de resposta (INV-13), sem segredo no repo ✔ |
| Webhooks | Ink: token opaco + HMAC; WhatsApp: HMAC do repasse; agente web: token ✔ (JSON de 100 MB pré-auth — P2-006) |
| Tenant isolation | RLS + testes ✔ |
| SSRF/upload | fetches usam URLs derivadas de config/providers; upload de mídia valida MIME por allowlist (`HEADER_MIME_PERMITIDO`); não encontrei fetch de URL do usuário sem allowlist |
| Rotas públicas | `/api/pedidos/:id` retorna nome do cliente + valor + PIX (capability 72 bits, `randomBytes`) — aceito por decisão de produto |
| Headers | **ausentes** (P2-005) |
| Rate limit | só login/convite/catálogo (P2-006) |
| Logs | 19 `console.log`; mensagens de erro sem payload; não auditado log a log |
| **Risco grave (P0/P1 de segurança)** | **nenhum encontrado** |

## 19. Testes e qualidade

| Comando (em `origin/main`) | Resultado |
|---|---|
| `tsc -p tsconfig.app.json --noEmit` | 0 erros |
| `vite build` (saída fora do repo) | OK, 2.4–4.3 s, maior chunk 387 kB (Recharts) |
| `npm test` (painel: suíte + invariants + controles negativos, Postgres efêmero, 129 min) | **2.416 testes: 2.388 ✔ / 28 ✖ na corrida única.** As 28 foram reexecutadas: 25 itens em 16 arquivos → **201/201 ✔**; `clientes-calibracao-script` ✔ no repo real; controles negativos `STORE-06`, `INK-01`, `OP-04` → **✔ (5/5)**. Causa provável das falhas: o diretório de trabalho temporário ficou indisponível no meio da corrida (arquivos falhando em ~2 ms) e sobrecarga da máquina. **Resultado efetivo: 0 falhas reais**, mas **não em uma única corrida limpa** |
| `node scripts/whatsapp.mjs test` (`go vet` + build + `go test -race ./...`) | **ok** (`whatsapp-webhook 36.6s`) |
| `node scripts/creatives.mjs test` (Python) | **21/21 suítes OK** |
| `npm test` em `apps/platform-admin` | **147/147 ✔** |

Observações: a corrida única do painel teve 28 ✖, todas reexecutadas com sucesso (linha acima). Não houve uma corrida contínua 100% verde; a evidência é corrida + reexecução por arquivo.

## 20. Código legado / mocks / placeholders

- Varredura `TODO|FIXME|HACK` em `src lib server.js routes`: **0 ocorrências reais** (as 40 linhas casadas eram a palavra "TODOS").
- `comingSoon` ×3 (Histórico, Relatórios, Instagram) — não aparecem na sidebar (decisão D2) ✔.
- Provider `fake` do gerador (`src/api/criativos.ts`) — mecanismo de rollout; sem fallback silencioso para dado estático encontrado.
- Botão desabilitado permanente: só "Abrir URL" do UTM quando não há URL (correto).
- Legado: `LOJAS`, `loja_legada` (P2-008), `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED`, `pendente-serverjs-connector-guard.diff` em `docs/features/`.
- Rotas legadas com redirect: `/admin/carrinhos`, `/admin/eventos`, `/admin/segmentos`.

## 21. Features prontas para comercialização (PRONTO — 11)

Dashboard · Pedidos · Clientes/RFM · Visão financeira · Despesas · Segmentos · Meta Ads · GA4 Analytics · UTM Tracker · Integrações · Login/convite.

## 22. Features que precisam de ajuste (AJUSTE — 17)

Trocas · Simular frete · Custos de API · Reembolsos · Produtos · Categorias · Agrupamentos · Promoções · Canal WhatsApp · PIX/HotPix · Mensagens web/Fila · Google Ads · Desempenho de produtos · Jornada de compra · Gerador de criativos · Configurações · Campos personalizados.

## 23. Features incompletas (INCOMPLETO — 5)

Recuperação · Automações · Templates Meta · Campanhas · Parcerias e Afiliados.

## 24. Features que não devem ser expostas (NÃO EXPOR — 6)

Estoque · Playground · Ferramenta interna Origens · Instagram · Histórico WhatsApp · Relatórios de campanha.

## 25. Recursos seguros para comunicar na nova Home

### Pode comunicar agora
- Painel único de operação da loja Reserva Ink: **pedidos**, **clientes com segmentação RFM**, **financeiro** com custo de produção, despesas e mídia.
- **Analytics**: GA4 (funil, canais), **UTM Tracker**, **Meta Ads** (gasto, CPA, ROAS por criativo).
- Integrações autorizadas pelo próprio lojista, somente leitura (fatos já presentes na landing).

### Pode comunicar após pequenos ajustes
- Catálogo (produtos, categorias, agrupamentos, promoções) — depois de P0-001.
- Google Ads, Desempenho de produtos e Jornada de compra — depois de P0-001 e P1-004.
- Gerador de criativos com IA (BYOK) — explicar custo e limites.
- PIX/HotPix — depois de P1-005.
- Trocas e reembolsos — depois de validar com pedido real.

### Não comunicar ainda
- **Recuperação de carrinho/PIX por WhatsApp**, **Campanhas**, **Automações**, **Templates**: bloqueados pelo canal (P1-001). *A landing atual já comunica recuperação por WhatsApp — remover ou condicionar.*
- **Parcerias e Afiliados** (P1-003), **Instagram**, **Histórico**, **Relatórios de campanha**, **Estoque**.
- Qualquer menção a "tempo real" enquanto o webhook Ink estiver desligado.

Recomendação de arquitetura de informação da Home (sem redesenhar): plataforma organizada em **Operação · Analytics · Marketing · Clientes · Comunicação · Creative · Automation**, com "Comunicação/Automação" marcadas como *em breve* até P1-001.

## 26. Avaliação da Home atual (`/oria`, `oria.html`, 355 linhas)

| Item | Achado |
|---|---|
| Proposta de valor | "Oria reúne a operação da sua loja em um só painel" — genérica, sem citar Reserva Ink |
| Público | lojista genérico; não diz que é **Ink-native** (posicionamento de `PRODUCT.md`) |
| Explica | 4 cartões (pedidos, financeiro, recuperação, anúncios) + bloco longo sobre dados do Google |
| Não explica | preço, plano, como começar, diferenciais, GA4/UTM/RFM/Creative/Automação, Storefront |
| Ausentes | clientes/RFM, criativos IA, UTM, campanhas, prova visual (nenhuma imagem do produto) |
| Linguagem | metade do texto é conformidade OAuth (`analytics.readonly`, Uso Limitado) — serve à verificação, não ao lojista |
| Promessas sem lastro | recuperação de carrinho por WhatsApp (P1-001) |
| CTAs | só "Entrar no painel" e "Política de Privacidade"; nenhum de cadastro/contato comercial |
| Pricing/onboarding | inexistentes |
| Responsivo | CSS com `clamp` e 1 breakpoint (600 px); renderiza bem a 563 px em produção (screenshot) |
| SEO técnico | `title`, `description`, `og:*`, `robots` presentes; **canonical/og apontam para `orgulhoregional.com.br/oria`**; sem `sitemap`, sem dados estruturados, `og:image` em domínio externo; contato pessoal |
| Restrição | a página foi desenhada para passar a verificação do Google — preservar o bloco de dados do Google e a política de privacidade na reconstrução |

## 27. Storefront como produto separado

- **Estado no repositório:** inexistente. `Storefront` só aparece em texto de escopo negativo (`journey-analytics-service.js`, `JornadaCompraPage.tsx`: "nunca instrumentação própria do StoreFront") e em docs de análise.
- **O que o modelo já oferece:** plano + features fechadas + assinatura única ativa por Organization + overrides por feature; control plane separado (`admin.*`); host público separado (`oria.com.br`).
- **O que falta para "produto adicional":** conceito de **add-on/produto contratável** (o modelo tem 1 assinatura ativa por org e `platform_feature` é enum de banco + registry em 3 camadas); status próprio (ativo/não contratado/suspenso); limites; billing.
- **Encaixe sem quebrar 1 org = 1 loja:** tabela `organization_products (organization_id, product_key, status, …)` (ou assinatura por produto) ao lado — e **não** dentro — de `plan_features`; `product_key='storefront'`; leitura via função SECURITY DEFINER análoga a `entitlements_efetivos`. O workspace continua com uma Store; o Storefront é uma superfície da mesma Store, contratada à parte.
- **Regras de produto para a Home:** Storefront em bloco próprio ("Produtos adicionais"), fora da lista de features da plataforma; **sem prometer nada até existir** (não há código, nem contrato de dados). Não colocar item no menu do Oria sem entitlement de produto.

## 28. Backlog recomendado

Ver §8–§11 (22 achados: **P0 1 · P1 6 · P2 10 · P3 5**). Itens P2/P3 seguem o mesmo formato resumido em tabela; cada linha tem evidência e resultado esperado.

## 29. Ordem sugerida de execução

1. **P0-001** confirmar folga de volume e aplicar o runbook de armazenamento.
2. **P1-001** estado único do WhatsApp + banners de dependência (P2-009); seguir a aprovação Meta em paralelo.
3. **P1-004** guards `meta_ads`/`google_ads`/`analytics_ga4` e decidir `afiliados` (P1-003).
4. **P1-005** `PUBLIC_SITE_URL` obrigatório; verificar env de produção.
5. **P1-003** validar cupom Ink real (cupom de teste) antes de comunicar Afiliados.
6. **P2-001/P3-001** esconder de vez Estoque e Playground.
7. **P2-004** matriz de papéis; **P2-005/006** headers, limite de corpo, rate limit.
8. **P2-007** limpar documentação enganosa.
9. **P1-006/P1-002** decisão de modelo comercial → só então reconstruir a Home.
10. **P2-003** smoke E2E em CI; **P2-008/P3-002** dívida técnica.

## 30. Critérios para considerar o Oria "fechado" nesta rodada

- P0 zerado e verificado em produção; P1 zerados ou explicitamente aceitos por escrito.
- Cada item da Home tem status PRONTO (ou está marcado "em breve").
- WhatsApp: estado consistente e, se ainda bloqueado, nenhuma promessa pública.
- Guards de plano cobrem toda feature vendida; teste do registry compara feature × rota.
- Documentação de agente/produto reflete o produto real.
- Smoke de UI automatizado cobre login → dashboard → integrações.

## 31. Limitações da auditoria

- **Somente leitura em produção**; nenhuma ação mutante, nenhum envio, nenhuma conexão OAuth nova.
- **Mobile 360/375/390 px não validado** (piso de janela do Chrome ~563 px).
- Tour de produção **parcial**: Dashboard, Integrações, WhatsApp, Campanhas, GA4, Parcerias (cabeçalho), Estoque, Playground e landing foram lidos; o restante foi avaliado por código e testes (o renderer do Chrome travou ao carregar muitas telas em lote).
- **Não validados contra provider real:** envio WhatsApp, Templates, agente WhatsApp Web, criação/encerramento de cupom Ink, geração OpenAI, refunds/exchanges reais.
- Estado atual do volume Postgres, valor de `SITE_BASE_URL`/`PUBLIC_SITE_URL` e flags de produção **não verificados** (sem acesso ao Railway).
- Estados vazio/loading/erro por **varredura estática**, não por percurso manual de cada tela.
- Falhas da corrida única do painel: reexecutadas por arquivo (201/201) e os 3 controles negativos (5/5); sem corrida contínua limpa..
- Sem auditoria WCAG (só varredura de padrões); sem pentest.
- Três containers Docker de outras sessões (`oria-test-pg`, `oria-afil-pg`, `oria-restore-test`) foram deixados intactos; usei nomes próprios (`oria-audit-pg*`).
- Um `pkill -f "node --test"` inicial (para trocar a base auditada) pode ter interrompido testes de outra sessão que rodassem nesse instante.

---

*Nenhuma alteração de código, banco, infraestrutura ou produção foi realizada nesta rodada.*
