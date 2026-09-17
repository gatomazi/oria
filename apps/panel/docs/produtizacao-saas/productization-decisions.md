# Oria — Decisões de productização

> Companion factual: [`productization-audit.md`](./productization-audit.md).
> Plano executável: [`productization-plan.md`](./productization-plan.md).
> Estado da auditoria: [`productization-progress.md`](./productization-progress.md).
>
> **Regra deste documento:** decisões. Fatos observados no código ficam no audit.
> Recomendação nunca é fato; inferência nunca é decisão.
>
> Baseline de código: commit `8a7ea3d`, 15/09/2026.
> **Rodada 2 — revisão do usuário aplicada.** Ver [Registro de mudanças](#registro-de-mudanças-da-rodada-2).

## Como ler

- `PD-xxx` — decisão de **produto**. `TD-xxx` — decisão **técnica**.
- **Status:**
  - `CLOSED (V1)` — decidido pelo usuário para a V1. Não reabrir sem instrução.
  - `PARCIAL` — a parte estrutural foi decidida; resta um recorte explícito, listado na própria decisão.
  - `OPEN` — aguardando decisão.
- **Impacto:** CRITICAL / HIGH / MEDIUM / LOW.

✅ **Marcação de confiança.** A mensagem da rodada 2 chegou com trechos truncados; dois pontos foram
completados por inferência e depois **confirmados pelo usuário**. **Nenhuma inferência permanece em
aberto** — nada neste documento está marcado como pendente de ratificação. O rastro completo, com a
correção de amplitude no item 4 ("recurso", não "gasto"), está em
[Pontos que dependeram de inferência](#pontos-que-dependeram-de-inferência--todos-resolvidos).

---

## Índice

| ID | Título | Status | Impacto |
|---|---|---|---|
| PD-001 | Escopo de providers de e-commerce na V1 | OPEN | CRITICAL |
| PD-002 | Cardinalidade Organization ↔ Store | **CLOSED (V1)** | CRITICAL |
| PD-003 | Store pode ter múltiplos números de WhatsApp | OPEN (simplificada) | MEDIUM |
| PD-004 | Múltiplos usuários por Organization | **PARCIAL** | HIGH |
| PD-005 | Módulos do plano inicial | OPEN | HIGH |
| PD-006 | Tokens manuais vs OAuth por integração | OPEN | HIGH |
| PD-007 | Existe trial | OPEN | MEDIUM |
| PD-008 | Existe plano gratuito | OPEN | MEDIUM |
| PD-009 | Unidade de cobrança | **PARCIAL** | HIGH |
| PD-010 | Retenção de dados após cancelamento | OPEN | HIGH |
| PD-011 | Produto utilizável sem WhatsApp | OPEN | MEDIUM |
| PD-012 | Produto utilizável sem conexão Ink | OPEN | HIGH |
| PD-013 | Mailchimp no MVP | OPEN | LOW |
| PD-014 | Instagram no MVP | OPEN | LOW |
| PD-015 | Financeiro Ink no produto inicial | OPEN | MEDIUM |
| PD-016 | Ownership de Marketing & Dados | **CLOSED (V1)** | CRITICAL |
| PD-017 | Identidade e deduplicação de clientes | **PARCIAL** | CRITICAL |
| PD-018 | Ownership dos dados de Criativos | **CLOSED (V1)** | HIGH |
| PD-019 | Como a operação interna vira tenant | **CLOSED (V1)** | CRITICAL |
| PD-020 | Política de custos de API e repasse | OPEN | MEDIUM |
| **PD-021** | **Recurso não atribuído ou ambíguo na DRE (fail-closed de atribuição)** | **CLOSED (V1)** | HIGH |
| **PD-022** | **Visão consolidada das 3 lojas — eliminada antes da migração** | **CLOSED (V1)** | HIGH |
| **PD-023** | **Topologia de deploy do `whatsapp-webhook-go`** — processo compartilhado, um Meta App da plataforma | **CLOSED (V1)** | CRITICAL |
| TD-001 | Estratégia de tenancy no banco — shared schema + `organization_id` + RLS forçada | **CLOSED (V1)** | CRITICAL |
| TD-002 | Transporte do tenant context | **CLOSED (V1)** | CRITICAL |
| TD-003 | Postgres obrigatório em produção SaaS | **CLOSED (V1)** | CRITICAL |
| TD-004 | Armazenamento e rotação de secrets | **CLOSED (V1)** | CRITICAL |
| TD-005 | Roteamento de webhooks por tenant — URL opaca por integração | **CLOSED (V1)** | CRITICAL |
| TD-006 | Locking e escala dos jobs — lease persistente + SKIP LOCKED | **CLOSED (V1)** | HIGH |
| TD-007 | Object storage vs volume local | OPEN | HIGH |
| TD-008 | Fronteira de confiança Node ↔ creative-core | OPEN | CRITICAL |
| TD-009 | Modularização do `server.js` | OPEN | MEDIUM |
| TD-010 | Ferramenta de migrations — `node-pg-migrate` | **CLOSED (V1)** | HIGH |
| TD-011 | IDs públicos e enumeração | OPEN | MEDIUM |
| TD-012 | Estratégia de entitlements fail-closed | **CLOSED (V1)** | CRITICAL |

**Contagem:** **14 `CLOSED (V1)`** · 3 `PARCIAL` · **18 `OPEN`**.
**Rodada 17 (16/09) fechou PD-023, TD-005 e TD-006** — o conteúdo da Fase 5c.
**Rodada 18 (17/09) não mudou nenhum status**; registrou decisões técnicas locais e novas pendências
do usuário (ver "Rodada 18" no fim).
**Rodada 19 (17/09) fechou as pendências da rodada 18** (ver "Rodada 19" no fim). Nenhum ID mudou de
status; o recorte de execução da PD-019 foi fechado no cenário B.
Rodada 7 fechou **TD-003, TD-004 e TD-010** — o conteúdo da Fase 0.
**Rodada 10 (16/09) fechou TD-001** — o pré-requisito da primeira migration de tenancy.
Rodada 3 criou PD-022; rodada 4 a fechou. **Rodada 6 abriu PD-023** (topologia do serviço Go) — a
única decisão em aberto com poder de mudar o tamanho de uma fase.

---

# Escopo removido da V1

Decisões de remoção tomadas pelo usuário. Não são PDs — são escopo fechado.

## R-01 — Ferramenta "Migração Use Origens" sai do produto

`/admin/internal/origens-migration` cumpriu seu objetivo e **não existe no Oria**.

**Não portar para o produto futuro:**

| Peça | Local hoje |
|---|---|
| Rota React | `admin/src/App.tsx:100` |
| Página | `admin/src/pages/internal/OrigensMigrationPage.tsx` |
| Item de menu | `admin/src/shell/nav.ts` (grupo "Ferramentas internas") |
| Cliente de API | `admin/src/api/origensMigration.ts`, `admin/src/api/internalTools.ts` |
| Endpoints | as 35 rotas `/api/admin/internal/origens-migration/*` |
| Guard/flag | `requireInternalTools` + `INTERNAL_TOOLS_ENABLED` (`server.js:1585-1589`), se não sobrar outro consumidor |
| Endpoint de status | `/api/admin/internal-tools/status` (`server.js:4826-4828`), idem |
| Testes específicos | os que cobrirem essa feature |

**Tabelas:** `origens_migration_rules`, `origens_migration_simulations`,
`origens_migration_simulation_items`, `origens_migration_city_uf_map` viram **LEGACY / TO_REMOVE**.

> **Nenhum `DROP` nesta etapa.** A remoção acontece por migration versionada, depois que a infra de
> migrations existir (TD-010). Até lá as tabelas ficam no banco, sem rota que as alcance.

**Efeito na auditoria:** a ferramenta deixa de ser item de roadmap e deixa de aparecer como feature
ou item de menu do produto futuro. A superfície administrativa a productizar cai de 278 para
**~243 rotas**; as tabelas a tenantizar caem de 53 para **49**.

**Nota:** a decisão remove a *feature*. A separação conceitual entre **tenant app** e **platform
admin** (addendum §19) continua válida e necessária — ela simplesmente deixa de ter esta ferramenta
como caso de uso.

## R-02 — `multiStoreMode` não migra para o Oria V1

**LEGACY / TO_REMOVE.** É cosmética hoje (controla só a exibição do seletor de loja) e **não é
fronteira de segurança** — nenhuma rota de negócio lê a flag (`server.js:13333-13365`).

Com a cardinalidade 1:1 da V1, a flag deixa de ter sentido: não há o que selecionar.

**Não implementar na V1:** seletor multi-store · visão consolidada entre Stores · DRE multi-store ·
campanhas cross-store · catálogo compartilhado · rateio de mídia entre Stores · `multiStoreMode`.

---

# Decisões de produto

## PD-001 — Escopo de providers de e-commerce na V1

**Status:** OPEN · **Impacto:** CRITICAL

**Pergunta:** o MVP será exclusivo para lojas Reserva Ink, ou a arquitetura suporta múltiplos
providers desde a V1?

**Contexto factual:** a Reserva Ink não é uma integração — é uma premissa do código. Pedidos,
catálogo, estoque, financeiro, trocas, reembolsos e promoções chamam a API da Ink diretamente,
sem camada de abstração.

**Opção A — Exclusivo Ink na V1** · Prós: escopo muito menor, onboarding de um token, time-to-market curto. Contras: mercado limitado às lojas Ink; um provider adicional depois exige refatorar operação/catálogo/financeiro.

**Opção B — Abstração multi-commerce desde a V1** · Prós: não trava o produto num fornecedor. Contras: custo alto antes do primeiro cliente pagante; risco de abstrair sobre um único exemplo real.

**Recomendação:** Opção A **com disciplina de fronteira** — chamadas à Ink confinadas a
`providers/ink/`, resto do produto falando vocabulário neutro. Compra a Opção B depois sem pagá-la agora.

**Decisão:** [aguardando]

---

## PD-002 — Cardinalidade Organization ↔ Store

**Status:** ✅ **CLOSED (V1)** · **Impacto:** CRITICAL

**Decisão do usuário:** **1 assinatura = 1 Organization/Workspace = 1 Store ativa.**
**Não haverá multi-store na V1.**

Mesmo dono com duas lojas = **dois workspaces/organizations/assinaturas independentes**.

```text
User
├── Organization A
│   └── Store A
└── Organization B
    └── Store B
```

`Organization` e `Store` **continuam entidades separadas**, por clareza de domínio e para não
bloquear evolução futura — mas a V1 impõe cardinalidade **1:1**.

**Consequência explícita:** o limite **não** deve ser desenhado como "feature multi-store futura".
A arquitetura permite evoluir depois, mas **nenhuma complexidade de multi-store entra no MVP sem
necessidade**. Nada de rateio, consolidação, seletor ou escopo duplo "por via das dúvidas".

**O que isso resolve da versão anterior desta decisão:** a tabela "por domínio, é Organization ou
Store?" que estava aberta **deixa de ser uma pergunta de produto**. Com 1:1, os dois níveis contêm
o mesmo conjunto de dados. A escolha passa a ser de modelagem, não de produto:

| Domínio | Nível |
|---|---|
| Pedidos, catálogo, estoque, trocas, reembolsos | Store (vêm da conexão Ink) |
| Clientes | Organization — ver PD-017 |
| Campanhas, segmentos, templates, automações | Organization |
| Contas de mídia (Meta/Google Ads/GA4) | Organization — ver PD-016 |
| Criativos | Organization — ver PD-018 (CLOSED) |
| Despesas, custos de API, DRE | Organization |
| Usuários, billing, plano | Organization |

**Divergência registrada:** esta decisão **substitui** a direção do addendum v2 §4 ("a arquitetura
deve suportar múltiplas Stores por Organization" / "pricing pode limitar `max_stores`"). A
capacidade estrutural é preservada (as entidades continuam separadas), mas a V1 **não** implementa
nem prepara UX/consolidação multi-store. O addendum continua valendo em tudo o mais.

---

## PD-003 — Store pode ter múltiplos números de WhatsApp

**Status:** OPEN (simplificada por PD-002) · **Impacto:** MEDIUM

**Simplificação:** com 1 Store por Organization, a pergunta "um número pode servir várias Stores?"
**desaparece**. Resta apenas: uma Store pode ter mais de um número?

**Recomendação:** V1 com **1 canal por Organization/Store**, modelado como linha em `integrations`
(não como coluna em `stores`), para que N números sejam possíveis depois sem migração destrutiva.

**Decisão:** [aguardando]

---

## PD-004 — Múltiplos usuários por Organization

**Status:** 🟡 **PARCIAL** · **Impacto:** HIGH

**FECHADO:** a direção é **usuários individuais**. Não haverá senha compartilhada no Oria.

**Continua OPEN:** o conjunto final de **roles/capabilities**. Fica para depois.

**Contexto factual:** hoje há uma senha compartilhada e a sessão não carrega identidade alguma
(`server.js:1541-1545`). Sem identidade não há audit atribuível nem offboarding.

**Recomendação para o recorte aberto:** dois papéis na V1 (`owner`, `member`) mais
`organization_members`. Identidade individual é pré-requisito de audit log e de LGPD; a matriz rica
de permissões pode esperar sem bloquear nada.

**Decisão (roles):** [aguardando]

---

## PD-005 — Módulos do plano inicial

**Status:** OPEN · **Impacto:** HIGH

**Pergunta:** quais módulos entram no plano inicial e quais são add-on/plano superior?

**Contexto factual:** o frontend já declara as flags `whatsapp`, `instagram`, `catalog`,
`exchanges`, `refunds`, `financial`, `advancedAutomations` — com default permissivo e **sem nenhuma
aplicação no backend** (TD-012). Hoje a lista de módulos é vocabulário, não controle.

**Módulos a classificar:** Operação · Catálogo · WhatsApp · Campanhas · Financeiro/DRE · Meta Ads ·
Google Ads · GA4 · UTM · Criativos · Trocas · Reembolsos · Campos personalizados.

**Recomendação:** decidir junto com o restante de PD-009. Módulos com custo variável por uso
(Criativos/OpenAI, WhatsApp) devem ser entitlement **com quota**, não booleano.

**Decisão:** [aguardando]

---

## PD-006 — Tokens manuais vs OAuth por integração

**Status:** OPEN · **Impacto:** HIGH

| Provider | Hoje | Decisão necessária |
|---|---|---|
| Reserva Ink | token por env var, por loja | manual — verificar se a Ink oferece OAuth |
| Meta Ads | OAuth ✔ | manter |
| Google (GA4 + Google Ads) | OAuth ✔ | manter |
| WhatsApp (Meta) | serviço externo + env | OPEN — Embedded Signup ou manual |
| OpenAI (BYOK) | manual, cifrado ✔ | manter |

**Recomendação:** OAuth onde o provider oferece; manual só como fallback explícito. Toda credencial
manual precisa de **teste de conexão** antes de ser aceita.

**Decisão:** [aguardando]

---

## PD-007 — Existe trial

**Status:** OPEN · **Impacto:** MEDIUM

Haverá período de teste? Com ou sem cartão? Quantos dias? O que acontece com os dados ao expirar?

**Recomendação:** decidir junto com PD-010. Trial sem política de retenção definida vira dívida de LGPD.

**Decisão:** [aguardando]

---

## PD-008 — Existe plano gratuito

**Status:** OPEN · **Impacto:** MEDIUM

**Contexto factual:** o produto consome cota de terceiros por tenant (Ink, Meta, Google, OpenAI).
Um tier gratuito consome cota real e cria noisy neighbour sem receita associada.

**Recomendação:** **não** ter plano gratuito permanente na V1; usar trial limitado (PD-007). Se
houver, exigir BYOK para tudo que custa dinheiro.

**Decisão:** [aguardando]

---

## PD-009 — Unidade de cobrança

**Status:** 🟡 **PARCIAL** · **Impacto:** HIGH

**FECHADO — unidade estrutural de cobrança:**

- a unidade base de assinatura é **Organization/Store**;
- **1 assinatura cobre exatamente 1 Store**;
- múltiplas lojas do mesmo dono = **múltiplas assinaturas/workspaces**.

**Continua OPEN:** quotas · usuários adicionais · mensagens · gerações · add-ons · pricing.

**Consequência:** o metering deixa de precisar de rateio entre Stores — cada workspace tem um único
escopo de consumo. Isso simplifica bastante o desenho de quotas quando elas forem decididas.
Metering por Organization **não existe hoje** para nenhum recurso.

**Decisão (recorte aberto):** [aguardando]

---

## PD-010 — Retenção de dados após cancelamento

**Status:** OPEN · **Impacto:** HIGH

**Contexto factual:** o sistema armazena PII de **clientes finais do tenant** (nome, telefone,
e-mail, documento, endereço). O tenant é controlador; o Oria seria operador. Não existe endpoint de
exclusão nem de exportação. `webhook_eventos` guarda payload cru **sem nenhuma rotina de limpeza**.

**A decidir:** (a) janela de retenção pós-cancelamento; (b) endpoint de exportação; (c) rotina de
exclusão que cubra **também** payloads de webhook, logs e arquivos em storage — não só as linhas de
negócio.

**Decisão:** [aguardando]

---

## PD-011 — Produto utilizável sem WhatsApp

**Status:** OPEN · **Impacto:** MEDIUM

**Recomendação:** sim — Operação + Catálogo + Financeiro + Marketing já entregam valor. O onboarding
deve tratar WhatsApp como etapa opcional.

**Decisão:** [aguardando]

---

## PD-012 — Produto utilizável sem conexão Ink

**Status:** OPEN · **Impacto:** HIGH

**Contexto factual:** praticamente todo o painel pressupõe a Ink. Sem token, a maior parte das telas
não tem dado.

**Recomendação:** V1 exige conexão Ink (coerente com PD-001 Opção A). Criativos é o único módulo com
chance de operar sozinho, se um dia for vendido isolado.

**Decisão:** [aguardando]

---

## PD-013 — Mailchimp no MVP

**Status:** OPEN · **Impacto:** LOW

**Contexto factual:** aparece no documento original como exemplo conceitual e **não tem
implementação**. O addendum §23 determina que providers hipotéticos não geram trabalho de MVP.

**Recomendação:** **não**. Fora do MVP.

**Decisão:** [aguardando]

---

## PD-014 — Instagram no MVP

**Status:** OPEN · **Impacto:** LOW

**Contexto factual:** card "Em breve" em Integrações e grupo `comingSoon` na navegação. Sem implementação.

**Recomendação:** **não**. Manter fora do MVP e remover a promessa visual (ou marcá-la como roadmap)
antes de haver cliente externo.

**Decisão:** [aguardando]

---

## PD-015 — Financeiro Ink no produto inicial

**Status:** OPEN · **Impacto:** MEDIUM

**Contexto factual:** somente leitura; depende do token da loja com escopo financeiro; expõe saldo.

**Recomendação:** incluir, mas como **entitlement separado** e atrás de papel (PD-004) — nem todo
membro deve ver saldo.

**Decisão:** [aguardando]

---

## PD-016 — Ownership de Marketing & Dados

**Status:** ✅ **CLOSED (V1)** · **Impacto:** CRITICAL

**FECHADO — direção V1:**

- a **conexão OAuth pertence à Organization**;
- **ad accounts, Google Ads customers e GA4 properties pertencem ao mesmo tenant/workspace**;
- **não existe rateio entre Stores**;
- **não existe conta de mídia compartilhada entre Stores** na V1;
- **todas as métricas da DRE se referem à única Store daquele workspace**;
- pode haver **múltiplas ad accounts** conectadas dentro do mesmo tenant no futuro — mas todas
  pertencem ao mesmo tenant.

**O que isso elimina:** as perguntas "uma conta pode ser dividida entre Stores?", "com qual chave de
rateio?", "uma property pode mapear várias Stores?" e "como o MER escolhe a Store atribuída?".
Com 1:1, **não há escolha a fazer** — há um só destino possível.

**Também elimina um risco real do código atual:** `lojaAtribuidaPadrao()` (`server.js:11873-11876`)
auto-atribui quando existe **uma só loja**. Isso era perigoso justamente porque o tenant SaaS típico
teria uma loja. Com ownership no nível da Organization, a atribuição deixa de ser inferida —
passa a ser estrutural.

**FECHADO — regra fail-closed de atribuição (confirmada pelo usuário):**

> **Se um recurso estiver não atribuído ou ambíguo, não deve entrar silenciosamente na DRE.**

A regra vale para **qualquer recurso** de Marketing & Dados cuja atribuição a um tenant seja
indeterminada ou ambígua — **ad account, customer do Google Ads, GA4 property, conexão OAuth, e
também gasto/custo**. Nenhum deles entra na DRE por omissão ou por default silencioso.

Isto **não é apenas uma regra contábil**: é uma regra **fail-closed de atribuição**. Diante de
ambiguidade, o comportamento correto é **excluir e sinalizar**, nunca incluir silenciosamente.

O detalhamento e a verificação contra o código atual estão em
**[PD-021](#pd-021--recurso-não-atribuído-ou-ambíguo-na-dre)**.

**Nada permanece aberto nesta decisão.**

**Implementação (Fase 4, rodada 15):**

- **Credenciais.**
  - Meta, Google Ads, GA4 e OpenAI ficam em `integrations` + `integration_secrets`, com uma integração por (Organization, provider).
  - A leitura acontece só com a Organization do contexto, por `lib/platform/integrations.js`.
  - As tabelas de conexão guardam só status e metadados.
- **Posse de recurso externo.**
  - O registro global `external_resource_claims` só é acessado pelas funções `SECURITY DEFINER` `integracao_reivindicar_recurso` e `integracao_liberar_recursos`, sempre com a Organization do contexto.
  - Selecionar conta de anúncios, customer do Google Ads ou propriedade GA4 reivindica a posse do recurso.
  - Se o recurso já pertence a outra Organization, a resposta é `409 EXTERNAL_RESOURCE_OWNED_ELSEWHERE`. Não existe transferência silenciosa.
  - Desconectar libera só os recursos da própria Organization.
- **DRE.**
  - `lib/financeiro/midia.js` é a fonte única do gasto, usada tanto pelo dashboard financeiro quanto pelo consolidado.
  - Recurso sem loja atribuída, ou atribuído a outra loja, fica fora do total e aparece sinalizado.
- **OAuth.** O state fica persistido (`oauth_states`), amarrado à pessoa, à sessão e à Organization. O callback revalida sessão e membership.

---

## PD-017 — Identidade e deduplicação de clientes

**Status:** 🟡 **PARCIAL** · **Impacto:** CRITICAL

**FECHADO:**

1. **Regra inegociável — Customer nunca cruza Organization.** Mesmo telefone em Organization A e em
   Organization B = **clientes independentes**. Isso é isolamento de tenant, não produto.
2. **Sai da V1** a questão de dedup entre Stores da mesma Organization — com 1:1 ela não existe.
3. **Dentro de uma Organization, não usar telefone como primary key.**

**Direção de modelagem fechada:**

```text
customers
  id                 -- identificador interno, opaco

customer_identifiers
  customer_id
  type               -- phone | email | document | provider_customer_id
  normalized_value
```

Telefone em E.164 pode ser **identificador forte**, mas **não é a identidade física definitiva** do
registro. **Consentimento/opt-in continua modelado explicitamente, nunca inferido da identidade.**

**Contexto factual:** hoje não existe tabela `customers` — tudo deriva de `pedidos_ink`
(`server.js:8380, 8402`), por union-find sobre documento/telefone/e-mail **agrupado por loja
primeiro** (`server.js:8441-8447`). Ou seja: o mesmo telefone em duas lojas já são 2 clientes hoje.

**Continua OPEN (recorte menor):**

- resolução de conflito quando dois identificadores apontam para registros diferentes (qual vence:
  documento? o mais recente? intervenção manual?);
- se o `provider_customer_id` da Ink é autoritativo quando presente;
- granularidade do consentimento (por canal? por finalidade?) — a granularidade *por Store* deixou
  de ser questão.

**Decisão (recorte aberto):** [aguardando]

---

## PD-018 — Ownership dos dados de Criativos

**Status:** ✅ **CLOSED (V1)** · **Impacto:** HIGH

**Decisão do usuário:** Brand Kit, Niche Kit, Contextos, Personas, Produtos, Jobs, Gerações e Assets
pertencem à **Organization**.

Como há só uma Store por Organization na V1, **não é preciso `store_id` no Creative Core** nesta fase.

**O `tenant_id` das tabelas `creative_*` já está conceitualmente no nível certo.** O problema a
corrigir é **apenas a ORIGEM do tenant**:

```text
hoje  → CREATIVE_TENANT_ID, constante global de processo (routes/criativos.js:9,92)
alvo  → tenant_id derivado do contexto autenticado da Organization
```

**Nota factual que sustenta a decisão:** as 9 tabelas `creative_*` já têm `tenant_id` e **todas** as
queries em `lib/creative-core/pgStore.js` filtram por ele — nenhum lookup só-por-id foi encontrado.
O módulo é o mais próximo do padrão-alvo no repositório; o trabalho restante é de uma linha
conceitual, não de schema.

---

## PD-019 — Como a operação interna vira tenant

**Status:** ✅ **CLOSED (V1)** *(recorte de execução da migração segue OPEN, ver fim da seção)* · **Impacto:** CRITICAL

**FECHADO:** a operação interna segue **exatamente a mesma regra comercial** — 1 Organization =
1 Store. **Sem bypass especial.**

**A recomendação anterior desta auditoria (uma Organization "Use Origens" com Sul/Centro/Norte como
três Stores) NÃO vale mais.** Ela contradizia PD-002.

**Dois cenários documentados**, conforme o estado da migração Centro/Norte → Sul no momento do corte:

**Cenário A — as três lojas ainda independentes:**

```text
User interno
├── Organization Use Sul    └── Store Use Sul
├── Organization Use Centro └── Store Use Centro
└── Organization Use Norte  └── Store Use Norte
```

Três organizations, três assinaturas, isoladas entre si como quaisquer clientes externos.

**Cenário B — operação já consolidada numa única loja Use Origens:**

```text
User interno
└── Organization Use Origens └── Store Use Origens
```

Uma única Organization com uma única Store.

> **Confirmado pelo usuário** (rodada 2): *"Se até a migração a operação estiver consolidada numa
> única loja Use Origens, haverá apenas uma Organization/Store."* Ambos os cenários são direção
> fechada — qual deles vale depende apenas do estado da consolidação Centro/Norte → Sul no momento
> do corte. Não é interpretação pendente.

**Continua OPEN:** (1) migração in-place vs reimportação; (2) quando os tokens de `INK_TOKEN_*`
migram para `integrations` e com qual janela; (3) período de dupla escrita/leitura ou corte único.

**Recomendação para o recorte aberto:** migração in-place, Organization criada antes do backfill,
corte único por domínio (não big-bang), tokens de env migrando **por último** — depois que a leitura
já passar pela nova camada.

**Decisão (recorte aberto):** **cenário B como alvo de rollout** (rodada 19, ver nota abaixo).

> **Rodada 11 — fato novo sobre o recorte aberto.** A escolha entre A e B deixou de ser só da
> migração da Fase 6: **o próximo deploy do painel precisa dela.** As migrations da Fase 1 exigem um
> arquivo de mapeamento explícito (`TENANCY_MAPPING_FILE`, OPS-16) sempre que a base tiver dado, e
> esse arquivo é exatamente a escolha A (três Organizations) ou B (uma). O código aceita os dois —
> ambos testados — e recusa qualquer atribuição por dedução. Recomendação do recorte inalterada.

> **Rodada 18 — tooling pronto para os dois cenários, escolha continua com o usuário.**
> `tenant1:*` exige `--scenario A|B` e recusa inferência. Consequências a pesar na escolha:
> no cenário B o histórico de Centro/Norte converge para a Organization mas não aparece nas telas nem
> na DRE (filtro pela loja da Store) e só a credencial Ink/GA4 da loja da Store é importada; no
> cenário A o login de emergência precisa ser owner das três Organizations.

> **Rodada 19 — recorte de execução FECHADO pelo usuário: rollout alvo = cenário B.**
> Organization "Use Origens" com Store "Use Origens"; Sul/Centro/Norte só como origem/mapping legado;
> o número WhatsApp atual (WABA + phone_number_id) pertence à Use Origens, declarado no arquivo de
> rollout. Não criar três Organizations no rollout. O rollout só começa quando a consolidação
> operacional/comercial para Use Origens estiver pronta para o corte; se a realidade mudar antes do
> deploy, nova confirmação do usuário. O tooling e os testes do cenário A continuam, como ensaio.
> Itens (1)–(3) do recorte: migração in-place; tokens de env importados no pre-deploy da RELEASE B com
> a janela da release N (OPS-24); corte por domínio conforme `production-rollout-runbook.md`.

---

## PD-020 — Política de custos de API e repasse

**Status:** OPEN · **Impacto:** MEDIUM

**Pergunta:** quem paga OpenAI e as mensagens de WhatsApp — o tenant (BYOK/conta própria) ou a
plataforma (repassado no plano)?

**Contexto factual:** OpenAI já é BYOK, **sem fallback para chave de plataforma** — cada tenant paga
com a própria chave. WhatsApp passa por um serviço com credencial única de instalação.

**Recomendação:** BYOK obrigatório para OpenAI na V1 (isola custo e cota, evita noisy neighbour) e
WhatsApp com credencial do próprio tenant. Custo da plataforma só quando houver metering e quota
confiáveis.

**Decisão:** [aguardando]

---

## PD-021 — Recurso não atribuído ou ambíguo na DRE

**Status:** ✅ **CLOSED (V1)** · **Impacto:** HIGH

**Decisão do usuário (rodada 2):**

> **Se um recurso estiver não atribuído ou ambíguo, não deve entrar silenciosamente na DRE.**

**Amplitude — é sobre RECURSO, não só sobre gasto.** A regra cobre qualquer recurso de
Marketing & Dados cuja atribuição a um tenant seja indeterminada ou ambígua:

| Recurso | Coberto |
|---|---|
| Meta ad account | sim |
| Google Ads customer | sim |
| GA4 property | sim |
| Conexão OAuth | sim |
| Gasto / custo de mídia | sim |

**Natureza da regra:** é **fail-closed de atribuição**, não apenas contabilidade. Diante de
ambiguidade, o comportamento correto é **excluir e sinalizar**, nunca incluir silenciosamente.
É o mesmo princípio de TD-012 (entitlements fail-closed) aplicado à atribuição.

### Verificação contra o código atual — a regra **é violada hoje**

Auditado em `server.js` e `lib/financeiro/consolidado.js` após o fechamento desta decisão.
Detalhe completo em `productization-audit.md` → achado **F-01**.

**Conforme à regra (✔):**

- Provedor **não conectado** é **excluído** do total e entra em `faltando`
  (`lib/financeiro/consolidado.js:37-51`), que alimenta `avaliarQualidade` e vira aviso na tela.
  Esse caso já é "excluir e sinalizar".
- Sem `loja_atribuida` resolvível, o endpoint **recusa** com 409 `META_LOJA_NAO_DEFINIDA`
  (`server.js:12256-12262`) em vez de adivinhar.
- Despesa não cadastrada vai como `null`, e o Lucro Operacional fica desconhecido em vez de fingir
  custo zero (`server.js:12277-12280`).
- GA4 é consultado **com** a loja (`atribuicaoGA4(loja, …)`).

**Viola a regra (✘):**

1. **`fontesDeMidia(from, to)` não recebe loja nenhuma** (`server.js:11921`). Ela soma o gasto da
   conta Meta **globalmente selecionada** e o custo do customer do Google Ads **globalmente
   selecionado**, sem confrontar `loja_atribuida` com a loja cuja receita está sendo usada. O
   resultado entra direto em `montarResultado` junto de `financeiroDaLoja(loja, …)`.
2. **A atribuição do Google Ads nunca é consultada no caminho da DRE.** `contaGoogleAdsSelecionada()`
   (`server.js:10454`) devolve o customer selecionado e seu custo é somado incondicionalmente
   (`server.js:11936-11947`) — um customer atribuído a outra loja contribui gasto para esta DRE,
   em silêncio. É o caso mais claro de violação.
3. **`?loja=` sobrescreve a atribuição salva** (`server.js:12256`), e o comentário do código declara
   isso como recurso intencional ("override por query pra a tela poder comparar cenários"). O
   resultado é receita de uma loja contra gasto de outra, sem marcação de que os escopos divergem.
4. **`lojaAtribuidaPadrao()` auto-atribui quando existe exatamente uma loja**
   (`server.js:11873-11876`). O comentário assume que com uma loja "a resposta é óbvia" — mas
   **uma loja é exatamente o caso do tenant SaaS** (PD-002). O que hoje é inofensivo torna-se, na
   V1, um default silencioso em 100% dos tenants.

**Comportamento-alvo:** a apuração de mídia deve receber o escopo do tenant e **descartar, marcando
como não atribuído**, qualquer recurso cuja atribuição não bata com esse escopo — exibindo a
pendência em vez de absorvê-la no total. O mecanismo de `faltando`/`avaliarQualidade` já existe e é
o lugar natural para isso.

**Prioridade atribuída:** **P1 hoje** (número financeiro errado, sem vazamento entre tenants) e
**P0 a partir do segundo tenant** (gasto de outro tenant dentro de um relatório financeiro).
Risco **HIGH**. Registrado como achado F-01, não como decisão pendente.

> **Rodada 3:** a auditoria dedicada de ownership confirmou que F-01 **não é isolado** — é um padrão
> com 12 instâncias (F-01..F-12) em `productization-audit.md`. A regra desta decisão passou a ser o
> critério de aceitação de toda a Fase 4, e foi decomposta em invariants verificáveis
> (INV-11 e INV-24 em particular).

---

## PD-022 — A operação interna perde a visão consolidada das 3 lojas

**Status:** ✅ **CLOSED (V1)** — **opção (a): eliminar antes da migração** · **Impacto:** HIGH

**Premissa fixada pelo usuário (rodada 4):** a tenant app é **estritamente Organization-scoped**.
**Nenhuma rota da tenant app pode agregar Organizations.**

### Decisão

A operação consolidada atual das três lojas **é eliminada antes da migração**. Ela não é portada
para a tenant app nem recriada como recurso de platform admin.

### Por que (a) e não (b)

1. **A visão consolidada não é uma capacidade de produto — é um acidente de história.** Um dono, três
   lojas regionais, um painel. Nenhum cliente externo compraria isso; nenhum roadmap a prometeu.
2. **(b) recriaria exatamente o bypass que o addendum §3 proíbe.** Um platform admin existe para
   **dar suporte a tenants** (saúde, billing, triagem de incidente) — não para **operar o negócio de
   um tenant** através de várias Organizations. Colocar relatório de negócio da Use Origens dentro do
   platform admin transformaria a ferramenta de suporte do Oria na BI da nossa própria empresa. Isso
   é, literalmente, "operação interna dependente de bypass especial".
3. **O caminho de leitura cross-org é o que a auditoria inteira existe para eliminar.** Construí-lo
   agora, antes de haver um único tenant a suportar, é criar a dívida no mesmo movimento em que se
   promete removê-la.
4. **(a) custa zero e devolve trabalho.** É remoção. Elimina as rotas de F-02, que são a maior
   superfície de vazamento da auditoria, em vez de realocá-las para outro contexto onde continuariam
   sendo uma leitura cross-tenant.
5. **Se a visão conjunta for mesmo necessária, a resposta certa é consolidar as lojas, não agregar
   Organizations.** Sob PD-002, "quero ver as três juntas" significa "as três são um negócio só" —
   o que é uma decisão comercial (PD-019 cenário B), já em andamento via migração Centro/Norte → Sul.

### O que isso implica

| Item | Efeito |
|---|---|
| `GET /api/admin/dashboard/customers` (`server.js:8380`) | **remover ou tornar Organization-scoped** antes da migração |
| `GET /api/admin/dashboard/abandoned-carts` (`server.js:2006`) | idem |
| Os seis endpoints com `req.query.loja \|\| 'all'` (`2031, 2132, 2540, 2819, 2937, 3191`) | o modo `'all'` deixa de existir |
| `fetchAcrossInkStores` (`server.js:1505`) | **deletar o helper** — sem ele, a classe de defeito não pode voltar |
| `GROUP BY loja` sem filtro (`3867`, `3953`) e `MIN(ultimo_sync_em)` (`2617`) | passam a ser escopados |

**Reforço de PD-019:** esta decisão torna o **cenário B (consolidação prévia em Use Origens)**
nitidamente preferível ao cenário A. No cenário A, a operação interna perde de fato a visão conjunta
— e essa perda é aceita conscientemente, não contornada.

**O que permanece no roadmap:** platform admin continua necessário e previsto, para suporte, saúde
de integração e billing. O que esta decisão proíbe é usá-lo como veículo de relatório de negócio
entre Organizations.

---

### Histórico

**Origem:** consequência não óbvia descoberta na rodada 3, ao mapear F-02.

**FATO.** Hoje o painel agrega deliberadamente as três lojas em vários pontos:
`GET /api/admin/dashboard/customers` (`server.js:8380`) e `/dashboard/abandoned-carts` (`2006`)
somam todas as lojas **incondicionalmente**, e seis outros endpoints tratam `loja` ausente como
`'all'` (`2031, 2132, 2540, 2819, 2937, 3191`). Isso **não é um bug hoje** — é funcionalidade: um
dono, três regiões, uma visão só.

**O conflito.** PD-002 fechou 1 Organization = 1 Store, e PD-019 cenário A prevê **três
Organizations** se as lojas seguirem independentes. Nesse cenário, a visão consolidada que a
operação usa hoje **deixa de ser possível** — agregar entre Organizations é exatamente o que o
isolamento proíbe.

**Pergunta:** o que acontece com essa visão?

**Opção A — Consolidar antes de migrar (cenário B de PD-019)**
- Prós: o problema desaparece; uma Organization, uma Store, uma visão. Coerente com a migração
  Centro/Norte → Sul já em andamento.
- Contras: amarra o cronograma da productização ao da consolidação comercial.

**Opção B — Aceitar a perda**
- Prós: nenhum trabalho extra; isolamento puro.
- Contras: regressão real de produto para a operação interna, que é o Tenant #1 e o dogfooding.

**Opção C — Visão multi-org de plataforma**
- Prós: preserva a visão sem furar o isolamento de tenant — seria um recurso de **platform admin**,
  não da tenant app.
- Contras: cria superfície de platform admin antes da hora; é exatamente o tipo de exceção que vira
  bypass se mal desenhada.

**Recomendação registrada na rodada 3:** decidir junto com PD-019.

**Decisão (rodada 4):** **Opção A — eliminar antes da migração.** A Opção C (platform admin) foi
**recusada** pelas razões acima. Ver o bloco de decisão no topo desta seção.

---

## PD-023 — Topologia de deploy do `whatsapp-webhook-go`

**Status:** **CLOSED (V1) — Variante B, rodada 17 (16/09/2026)** · **Impacto:** CRITICAL

### Decisão (V1)

**Um processo compartilhado** do `whatsapp-webhook-go` atende várias Organizations, com **um Meta App
da plataforma Oria**. Cada Organization tem a própria WABA, o próprio `phone_number_id` e o próprio
token; o App da plataforma é inscrito na WABA do cliente.

Fica **fora** da arquitetura V1:

- um container por Organization;
- um App da Meta por Organization;
- um banco do Go por Organization.

**Evidência (documentação oficial da WhatsApp Business Platform, registrada no comando da rodada 17):**

- o Embedded Signup é o fluxo de onboarding de clientes para Solution Partners e Tech Providers;
- `POST /{Assigned-WABA-ID}/subscribed_apps` inscreve o App na WABA atribuída;
- o payload do webhook traz `entry[].id` (WABA) e `value.metadata.phone_number_id`.

O modelo compartilhado, portanto, tem identificadores nativos suficientes para rotear cada evento.

**Consequências implementadas na Fase 5c:**

- `META_APP_SECRET` (e `META_VERIFY_TOKEN`) são segredos **de plataforma**. O HMAC é conferido com eles **antes** de qualquer roteamento. Uma assinatura válida autentica a origem Meta e **não escolhe tenant**.
- Depois do HMAC, cada change de cada entry passa por `WABA + phone_number_id → Organization`, resolvido no painel (`/api/internal/whatsapp/inbound-context`), contra a posse exclusiva registrada em `external_resource_claims`.
- Suportar vários Meta Apps ao mesmo tempo exige nova decisão arquitetural.
- OPS-10 deixa de bloquear esta decisão. A verificação do setup **real** (qual `META_APP_ID`, qual WABA inscrita, qual token) passa a ser parte de OPS-27 e do onboarding.

O texto abaixo é o histórico da decisão, preservado como estava.

### Correção de uma afirmação anterior

Na rodada 4 eu afirmei que **não restava incógnita arquitetural capaz de mudar as fases do plano**.
**Essa afirmação estava errada**, e a auditoria do serviço Go a desmentiu.

Não vou defendê-la. O defeito de raciocínio foi tratar "o que não auditei" como equivalente a "o que
não contém surpresa": eu havia classificado o `whatsapp-webhook-go` como *lacuna de cobertura* e, ao
mesmo tempo, concluído que nada capaz de mudar fases restava — duas coisas que não podem ser
verdadeiras ao mesmo tempo. Um repositório não auditado é, por definição, um lugar onde uma incógnita
arquitetural pode estar. E estava.

### A pergunta

O serviço roda como **um processo por Organization** (um container por tenant) ou como **um processo
compartilhado** por todos os tenants?

**Não há manifesto de deploy no repositório.** A auditoria procurou `*.yml`, `*.yaml`, `*.toml`,
`Procfile` e `*.json` na raiz e um nível abaixo, sem resultado; o `Dockerfile` não revela
orquestração.

### Por que muda tudo

**Opção A — um processo (container) por Organization**
- O código **já está na forma certa**: variável de ambiente por container **é** identidade por
  instalação. A maior parte dos achados de categoria 4 e 5 **deixa de ser defeito e vira arquitetura**.
- Custo no repositório: **~XS** — resta remover o contrato de `/health` e escopar a autenticação.
- Custo fora do repositório: um container, um Postgres (ou schema) e um app da Meta **por assinante**;
  provisionamento, custo unitário e operação crescem linearmente com a base.
- Risco: o custo por tenant pode inviabilizar planos de entrada.

**Opção B — um processo compartilhado**
- Praticamente **todos os 26 achados passam a valer**; o caminho de entrada precisa ser **reescrito**;
  os seis stores globais precisam ser re-chaveados.
- Custo no repositório: **L**.
- Custo fora do repositório: baixo — um serviço, uma operação.

**A diferença de esforço no repositório é de uma ordem de grandeza (XS ↔ L).**

### O que a evidência sustenta

Apenas isto, e é pouco: *o código como está escrito é compatível com a Opção A e incompatível com a
Opção B.* Isso **não** significa que a Opção A foi escolhida — significa que ninguém precisou
escolher, porque só existe um tenant.

### Recomendação

**Opção B (processo compartilhado)**, com uma ressalva honesta sobre a força desta recomendação.

Razões:
1. **Coerência com o resto da plataforma.** O painel e o `creative-lab` já são processos
   compartilhados que vão receber `organization_id`. Fazer o WhatsApp ser o único componente com
   topologia por tenant cria duas arquiteturas de tenancy no mesmo produto, e duas formas de errar.
2. **O custo unitário da Opção A é recorrente e cresce com as vendas**; o custo da Opção B é um
   investimento único de engenharia. Para um SaaS que ainda não tem o primeiro cliente, converter
   custo variável em custo fixo de engenharia é a troca certa.
3. **A Opção A não elimina o trabalho — realoca-o para provisionamento.** Criar container, banco e
   app da Meta por assinante é automação de infraestrutura que hoje também não existe.

**Ressalva:** se houver restrição da Meta que torne inviável um app/WABA servindo múltiplos números
de clientes distintos, a Opção A deixa de ser escolha e passa a ser imposição. Isso depende de
OPS-10 e do item 10 dos NOT VERIFIED do anexo (quantos apps/WABAs a conta comercial possui), e
**precisa ser verificado antes de fechar esta decisão**.

### Pré-requisito de fase

**Sim — da Fase 5c.** Não bloqueia as Fases 0-4, nem a 5a, nem a 5b.

O plano foi escrito com a **Fase 5c em duas variantes lado a lado**
([`productization-plan.md`](./productization-plan.md) → Fase 5c), porque o restante do
sequenciamento não muda com a resposta. O gate desta decisão é **OPS-10** (natureza do token e
quantos apps/WABAs a conta comercial possui) — se houver restrição da Meta que impeça um app/WABA de
servir números de clientes distintos, a Variante A deixa de ser escolha e vira imposição.

**Impacto documentado no plano:**

```text
Variante A (1 processo por Organization)
  → esforço XS no código Go
  → cria custo recorrente de provisionamento/infra por Organization
  → duas arquiteturas de tenancy na plataforma

Variante B (processo compartilhado)  ← recomendação
  → esforço L na entrada/webhook
  → mantém uma única arquitetura de tenancy
```

**Decisão:** [aguardando] — **não foi fechada pelo plano.**

---

# Decisões técnicas

## TD-001 — Estratégia de tenancy no banco

**Status:** ✅ **CLOSED (V1)** — rodada 10, 16/09/2026 · **Impacto:** CRITICAL · **Fase 1**

**Pergunta:** discriminador em schema compartilhado, schema por tenant, ou banco por tenant?

**Simplificação trazida por PD-002:** com 1:1, o discriminador primário é **`organization_id`**.
`store_id` continua existindo (as entidades são separadas), mas **não** é um segundo eixo de
isolamento a validar em toda query — ele é derivável da Organization. Isso reduz muito a superfície
de erro: uma query que esqueça `store_id` não vaza entre tenants; uma que esqueça `organization_id`, sim.

**Opção A — `organization_id` em schema compartilhado** · Prós: operação simples, um pool, migrations únicas; é quase o que o código já é (criativos já usa `tenant_id`). Contras: isolamento depende de disciplina de query.

**Opção B — Schema por tenant** · Prós: isolamento mais forte. Contras: migrations × N; complexidade desproporcional ao estágio.

**Opção C — Banco por tenant** · Prós: isolamento máximo. Contras: inviável agora.

**Recomendação:** Opção A **com defesa em profundidade** — discriminador obrigatório + Row Level
Security do Postgres como rede de segurança + testes de isolamento automatizados. A RLS transforma
"esquecemos um WHERE" de vazamento em erro.

**Nota sobre a matriz de teste:** com PD-002 fechada, o cenário de teste muda de
`Org A/Store A1 · Org A/Store A2 · Org B/Store B1` para **`Org A/Store A · Org B/Store B`** mais um
caso explícito de **tentativa de acesso cruzado**. Mais simples, e ainda obrigatório.

> **Rodada 7 — confirmado, não fechado.** TD-001 é a **próxima decisão a fechar, antes da primeira
> migration de tenancy** (Fase 1). A recomendação segue sendo:
>
> ```text
> schema compartilhado
> + organization_id obrigatório
> + RLS como defesa em profundidade
> + testes automáticos de isolamento
> ```
>
> **Não alterar sem nova evidência.** Nada nas decisões da rodada 7 (TD-003, TD-004, TD-010) muda
> essa recomendação: as três são infraestrutura da Fase 0 e são agnósticas quanto à estratégia de
> tenancy escolhida na Fase 1.

**Decisão (rodada 10) — Opção A, com defesa em profundidade:**

```text
TD-001 — CLOSED (V1)

- shared schema;
- Organization é a fronteira de tenant;
- organization_id obrigatório (NOT NULL) nas entidades tenant-owned;
- Store continua entidade de domínio, 1:1 com Organization na V1 (PD-002);
- RLS no Postgres como defense-in-depth, habilitada E forçada;
- ownership checks no application layer continuam obrigatórios;
- RLS não substitui filtros/checks de aplicação;
- testes automatizados de isolamento são obrigatórios;
- recurso sem ownership resolvido falha fechado.
```

Nenhuma evidência nova contra a direção. A execução da Fase 0 somou três a favor: migration única
aplica o baseline em ~350 ms (com schema por tenant seria N vezes, com falha parcial); o
pre-deploy é um comando, não um laço sobre tenants; e o harness já foi construído sobre um
discriminador por linha.

### Os pontos que costumam ficar implícitos — fixados

| # | Regra | Como é garantida |
|---|---|---|
| 1 | A aplicação **não** usa role com `BYPASSRLS` nem superusuário | boot da Fase 1 verifica `pg_roles` da própria conexão e falha (gate `todo` já escrito) |
| 2 | Dona da tabela não torna a RLS inefetiva | a role da aplicação **não é dona** de tabela tenant-owned; donas são da role de migration |
| 3 | `FORCE ROW LEVEL SECURITY` | **obrigatório** em toda tabela tenant-owned, não "quando necessário": sem ele a dona escapa da policy — provado no contrato |
| 4 | Migrations/admin jobs que precisem escapar da RLS usam caminho separado e auditável | role própria de migration (`MIGRATION_DATABASE_URL`, só no pre-deploy), nunca carregada pelo processo do app. Job administrativo cross-Organization **não existe na V1**; qualquer exceção futura exige decisão nova, role própria e registro em audit log |
| 5 | `organization_id` nunca vem confiado do frontend | TD-002; INV-02 + negative control |
| 6 | Contexto da Organization vem da sessão autenticada | `resolveOrganization(req, sessao)` → `comOrganization(pool, orgId, fn)` |
| 7 | IDs recebidos em URL/body continuam exigindo ownership check | `assertOwnership` (INV-20) **e** RLS — as duas camadas, sempre |
| 8 | Não existe "single candidate means owned" | INV-09 com uma única Organization + negative control |
| 9 | Recurso unassigned não aparece em nenhum tenant | policy compara com `=`: `NULL` nunca casa. Provado no contrato com uma e duas Organizations |
| 10 | Nenhum modo `all` / cross-Organization na V1 | PD-022; `comOrganization` rejeita qualquer valor que não seja UUID (`all`, `*`, vazio) |

### Mecanismo de contexto RLS — escolhido

**Transação + `set_config('app.current_organization_id', $1, true)`.** O terceiro argumento
(`is_local = true`) é exatamente `SET LOCAL`: o valor morre no `COMMIT`/`ROLLBACK`. Escolhido
sobre `SET LOCAL` literal porque aceita parâmetro de bind; o valor ainda passa por validação de
UUID antes. Implementado como contrato em `lib/platform/tenant-db.js` (`comOrganization`), **não
ligado a nenhuma rota**.

```text
pool.connect()
BEGIN
SELECT set_config('app.current_organization_id', $orgId, true)
… queries do request …
COMMIT            (ROLLBACK em erro; conexão descartada se nem o ROLLBACK passar)
release()
```

Policy padrão da Fase 1, para toda tabela tenant-owned:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;
CREATE POLICY <t>_tenant ON <t>
  USING      (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.current_organization_id', true), '')::uuid);
```

- **Sem contexto → zero linhas** (leitura) e **erro** (escrita). `current_setting(..., true)` devolve
  `NULL`; o `NULLIF` cobre a sessão onde o valor já existiu e virou `''`.
- **Sem vazamento no pool**: nada é gravado na sessão. Rejeitado: `SET` sem `LOCAL`, variável de
  processo, `AsyncLocalStorage` como única fonte (INV-10).
- **Query fora de `comOrganization`** (auto-commit direto no pool) não tem contexto → fail-closed.
  É o comportamento desejado, e é o que obriga a Fase 1 a migrar os acessos de verdade.
- `WITH CHECK` impede gravar linha em nome de outra Organization **e** mover uma linha própria para
  outra.

### Testes-gate (`test/invariants/td001-rls-contract.test.js`)

| Gate | Estado |
|---|---|
| Org A não lê B · Org B não lê A (`SELECT` sem `WHERE`) | ✅ **contract test preparado — PASS** (mecanismo) |
| Org A não altera/apaga B · não grava em nome de B · não move linha para B | ✅ PASS (mecanismo) |
| ID válido de B com contexto A → negado | ✅ PASS (mecanismo) |
| Query sem filtro protegida pela RLS | ✅ PASS (mecanismo) |
| Recurso sem `organization_id` invisível para todo tenant | ✅ PASS (mecanismo) |
| Role da aplicação sem superusuário/`BYPASSRLS`, não dona; tabela com RLS+FORCE | ✅ PASS (mecanismo) |
| Sem `FORCE`, a dona escapa — por que é obrigatório | ✅ PASS (demonstração) |
| Contexto não vaza entre requests na **mesma** conexão (`max: 1`) · erro desfaz contexto | ✅ PASS + **negative control** (`is_local=false` reprova 4 casos) |
| Ausência de contexto falha fechada · `all`/`*`/vazio/injeção rejeitados | ✅ PASS |
| Toda tabela tenant-owned com `organization_id NOT NULL` | ⏳ `todo` — **implementation pending Phase 1** (hoje: RED em **55** tabelas — 53 sem a coluna, incluindo as 9 `creative_*` com `tenant_id TEXT`; `integrations`/`integration_secrets` com a coluna nullable) |
| Toda tabela tenant-owned com RLS habilitada **e** forçada | ⏳ `todo` — **implementation pending Phase 1** (RED em 55 tabelas) |
| Boot recusa role de aplicação superusuária / `BYPASSRLS` / dona | ⏳ `todo` — **implementation pending Phase 1** (RED: `verificarRoleDaAplicacao` não existe; o teste da Fase 1 deve subir o processo com role inválida e exigir exit ≠ 0, como `boot-exit-code.test.js`) |

"Mecanismo" = banco descartável, roles criadas no teste, tabelas `harness_*`. **Nenhuma tabela de
negócio recebeu RLS nem `organization_id`.** A Fase 1 fecha quando os três `todo` perdem a marca e
continuam verdes, e quando os contratos do mecanismo passam a rodar contra as tabelas reais.

### Pré-requisitos operacionais que esta decisão cria (Fase 1, não agora)

- **OPS-14** — role `oria_app` (`NOSUPERUSER NOBYPASSRLS`, não dona) com a `DATABASE_URL` do app;
  a role atual do Railway (`postgres`, superusuário) passa a ser só de migration
  (`MIGRATION_DATABASE_URL` no *Pre-deploy Command*). **Superusuário ignora RLS mesmo com FORCE.**
- `integrations.organization_id` e `integration_secrets.organization_id` (nullable, sem FK desde a
  Fase 0) entram no mesmo `adicionar → backfill → NOT NULL` das demais.

**Verificado por:** `INV-07` (RLS ativa sob a role da aplicação) e os gates acima.

> **Rodada 11 — fatos da implementação (não alteram a decisão).**
> 1. Os três gates `todo` saíram da marca: INV-04 e INV-07 PASS contra o schema real; a role
>    `oria_app` passa em `verificarRoleDaAplicacao`, e o superusuário é recusado. A exigência no boot
>    é `DB_ENFORCE_APP_ROLE=1`, ligada no passo OPS-14.
> 2. **Ponto 4 refinado:** `FORCE` vale também para a dona. A role de migration precisa ser
>    superusuária ou ter `BYPASSRLS` para backfills futuros sob RLS; nunca é a role do app.
> 3. **Ponto 2 refinado:** a verificação trata como "dona" também quem **herda** a dona
>    (`pg_has_role … USAGE`), e a role do app é `NOINHERIT`.
> 4. O trigger transitório de preenchimento e as funções de cobertura são `SECURITY DEFINER` com
>    `search_path` fixo; a role do app não tem acesso a `tenancy_mapeamentos`.

---

## TD-002 — Transporte do tenant context

**Status:** ✅ **CLOSED (V1)** · **Impacto:** CRITICAL

**Decisão do usuário — pipeline alvo:**

```text
authenticateUser
      ↓
resolveOrganization          ← da sessão, NUNCA do browser
      ↓
verifyMembership
      ↓
resolveOrganizationStore     ← a única Store ativa do workspace
      ↓
checkEntitlement
      ↓
handler
```

**Regras fechadas:**

- **A Organization nunca vem do browser.**
- **A Store também não deve precisar vir do browser na maioria dos casos**, porque há só uma Store
  ativa no workspace.
- Se alguma rota tecnicamente receber `store_id`, **ainda assim valida que pertence à Organization
  autenticada**.
- Fluxo alvo resumido: *authenticated user → organization → única store da organization → dados.*

**Consequência prática sobre o código atual:** as ~125 rotas hoje classificadas MEDIUM (que recebem
`loja` e validam só contra o enum) **não precisam ganhar checagem de posse** — precisam **parar de
receber `loja`**. O risco não é mitigado nelas; é eliminado ao remover o parâmetro. Isso é uma
mudança de estratégia relevante frente à rodada 1 desta auditoria.

Continuam exigindo verificação de posse as 10 rotas CRITICAL e as ~38 HIGH, que selecionam
credencial ou recurso por identificador.

**Implementação (Fase 3, rodada 14):**

- `sessions.active_organization_id` guarda a Organization ativa. Só o servidor grava esse valor.
- `lib/platform/tenant-pipeline.js` roda a cadeia inteira. A sequência é:
  1. `requireAuth`;
  2. `resolverOrganizacaoAtiva`;
  3. o membership é relido do banco a cada request;
  4. `resolverStore`;
  5. contexto (`comContexto`);
  6. `featureDaRota` e `requireEntitlement`;
  7. handler.
- Tenant selector no request é recusado com `400 TENANT_SELECTOR_NOT_ALLOWED`. Vale para query ou corpo (`loja`, `store_id`, `organization_id`, `tenant_id`...) e para os headers `X-Organization-Id` / `X-Store-Id` / `X-Tenant-Id` / `X-Loja`.
- As 37 rotas `/:loja` perderam o segmento.
- **Seleção automática com um único membership.** Quando a pessoa autenticada tem exatamente um membership explícito, o servidor grava esse na sessão. Isto **não** é o anti-padrão "único candidato" (INV-09):
  - o universo é o conjunto de Organizations autorizadas para aquela pessoa, lido de `organization_members`, e não o de Organizations existentes no banco;
  - com zero memberships a resposta é `403 NO_ORGANIZATION_MEMBERSHIP`, e nenhuma Organization é escolhida;
  - com dois ou mais, a resposta é `409 ORGANIZATION_CONTEXT_REQUIRED` até a pessoa escolher.
- **Exceção única ao "a Organization nunca vem do browser": `POST /api/admin/session/organization`.**
  - O corpo aceita só `{organizationId}`.
  - É uma *proposta*. O servidor confere o membership da pessoa antes de gravar.
  - Organization sem membership responde `404 ORGANIZATION_NOT_FOUND`, igual a uma inexistente.
  - Nenhuma rota de negócio lê esse valor do request; todas leem o que foi gravado na sessão.
- **Membership revogado.** A request responde `403 ORGANIZATION_ACCESS_REVOKED` e a sessão perde a Organization ativa. Nada troca de Organization em silêncio: a mesma resposta nunca traz dados de outra Organization.
- **Store.** Zero Stores ativas dá `409 STORE_NOT_FOUND`. Mais de uma dá `500 STORE_INTEGRITY_ERROR`, e o banco já impede isso por `uq_stores_organization`.
- **Caminhos sem sessão** usam resolvedores estreitos `SECURITY DEFINER`. Cada um devolve uma Organization ou nada, e ambiguidade devolve nada:
  - `tenancy_organizations_para_jobs` — jobs;
  - `tenancy_organization_da_loja` — webhook da Ink;
  - `tenancy_organization_do_wamid` — status do WhatsApp;
  - `publico_organization_do_pedido` e `publico_organization_da_midia` — links públicos;
  - `publico_organization_do_agente` — agente WhatsApp Web.
- **Callbacks OAuth** levam a Organization no state: no GA4 e na Meta, num mapa em memória de uso único; no Google Ads, num state assinado com HMAC e validade de 10 minutos.

---

## TD-003 — Postgres obrigatório em produção SaaS

**Status:** ✅ **CLOSED (V1)** · **Impacto:** CRITICAL · **Fase 0**

**Decisão do usuário (rodada 7):**

> **Produção SaaS exige Postgres.**
>
> Em `production`:
> - `DATABASE_URL` ausente → **boot falha**;
> - conexão/migration/bootstrap crítico falhou → **boot falha**;
> - **nenhum fallback JSON/memory silencioso** para estado de negócio.
>
> Fallback JSON/memory:
> - permitido **somente em dev/test explicitamente**;
> - **nunca inferido** apenas porque `DATABASE_URL` está ausente.

**Contexto factual que a decisão corrige:** hoje `bootstrapPostgres()` é encadeado com
`.catch((err) => console.error(...))` (`server.js:1177-1181`) e `app.listen` roda independentemente
(`server.js:16349`). Sem `DATABASE_URL`, `pgPool` é `null` e **cada rota decide sozinha** entre cair
para JSON (`lerConfigPostgres`, `server.js:1187-1204`) ou devolver 503. A mudança é
**intencionalmente fail-fast**.

**Ponto de atenção para a implementação:** a inferência a eliminar é o `DATABASE_URL ? ... : null`
em `server.js:113`. O modo de fallback precisa passar a ser **declarado** (por exemplo
`NODE_ENV !== 'production'` mais uma flag explícita), nunca deduzido da ausência da variável —
é exatamente o padrão "infere o único candidato" que a regra fail-closed do plano proíbe.

**Verificado por:** o boot falha sem `DATABASE_URL` em produção e degrada em dev.

---

## TD-004 — Armazenamento e rotação de secrets

**Status:** ✅ **CLOSED (V1)** · **Impacto:** CRITICAL · **Fase 0**

**Decisão do usuário (rodada 7):**

> A chave de criptografia de integrations/secrets é **independente do segredo de sessão**.
>
> Requisitos:
> - `ENCRYPTION_MASTER_KEY` própria;
> - `key_version` persistida junto do ciphertext;
> - AES-256-GCM pode permanecer;
> - rotação incremental, **sem downtime**;
> - leitura aceita chave atual + versões ainda ativas;
> - escrita **sempre** usa a versão corrente;
> - segredo **nunca** volta ao frontend;
> - logs/API mostram somente metadata: `last4` / status / validade;
> - `ADMIN_SESSION_SECRET` **deixa de participar** da derivação de segredos persistidos.

### Escolha de schema: **Opção A — tabela `integration_secrets` dedicada**

```text
integrations           (organization_id, provider, status, config não-sensível, …)
   └─ 1:N ─> integration_secrets
             (integration_id, organization_id, tipo, ciphertext,
              key_version, last4, expires_at, rotated_at)
```

**Por que A, e por que isto não é "arquitetura paralela só para segurança":**

1. **É o mesmo modelo, não um modelo ao lado.** `integration_secrets` é uma tabela-filha normal de
   `integrations`, com a mesma cadeia de ownership (`organization_id` em ambas) e sob a mesma RLS.
   Não introduz serviço, fluxo nem vocabulário novo.
2. **A cardinalidade real é 1:N, não 1:1.** A auditoria mostra provedores com vários segredos de
   **ciclos de vida diferentes**: Meta tem access token + refresh token; Ink tem token + webhook
   secret; Google tem refresh token. Com colunas na `integrations`, `key_version`, `expires_at` e
   `rotated_at` seriam compartilhados por segredos que rotacionam em momentos distintos — o que
   quebra o requisito de **rotação incremental** desta mesma decisão.
3. **O ciphertext sai do caminho de leitura comum.** O modo de falha recorrente nesta base é
   segredo escapando para resposta ou log. Com A, um `SELECT` na `integrations` — inclusive um
   `SELECT *` descuidado — **fisicamente não** devolve ciphertext. É defesa que sobrevive a uma
   query mal escrita, o mesmo raciocínio de INV-07 (RLS).

A Opção B seria mais simples se houvesse um segredo por integração. Não há.

### Migração dos ciphertexts existentes

Na sequência do plano (adicionar → backfill → validar → trocar leitores → remover):

```text
legacy key derivada de ADMIN_SESSION_SECRET
  → leitura temporária compatível (key_version = 0 = legacy)
  → reencrypt com ENCRYPTION_MASTER_KEY na nova key_version
  → validação (todo segredo lê e volta a funcionar contra o provedor)
  → remoção do fallback legacy em migration/release POSTERIOR
```

O fallback de leitura legacy é **datado**: sai na release seguinte à validação, não "quando não
precisar mais". Enquanto ele existir, `ADMIN_SESSION_SECRET` continua sendo material sensível e
**não pode ser rotacionado** — essa janela precisa ser curta e explícita no runbook.

**Verificado por:** `INV-14` — rotacionar `ADMIN_SESSION_SECRET` e assertar que todos os segredos
continuam legíveis.

---

## TD-005 — Roteamento de webhooks por tenant

**Status:** OPEN · **Impacto:** CRITICAL

**Contexto factual:** o webhook da Ink descobre a loja **testando o segredo de cada loja em
sequência** (`identifyInkWebhookStore`, `server.js:1280-1291`).

**Opções:** (a) URL com identificador opaco por conexão; (b) endpoint único + lookup por
identificador do payload; (c) endpoint único + tentativa contra cada segredo (o de hoje).

**Recomendação:** (a). URL única e não adivinhável por conexão resolve o tenant **antes** de
qualquer processamento e torna a verificação de assinatura uma checagem de um único segredo — não
uma busca. A (c) não escala (O(n) HMACs por evento) e faz o tenant de destino depender de qual
segredo casou primeiro.

Exigir também: idempotency key por evento, proteção de replay e persistência do evento bruto com ownership.

**Decisão:** **(a) — CLOSED (V1), rodada 17.** Implementação:

- `POST /api/webhooks/ink/:token`: o token de 256 bits resolve a Organization pelo SHA-256 (`ink_organization_do_webhook`, posse exclusiva em `external_resource_claims`) **antes** da assinatura.
- A assinatura é conferida contra o `webhook_secret` **daquela** integração (`lib/platform/webhook-routing.js`).
- Respostas:
  - URL desconhecida → 404;
  - assinatura que não confere → 401;
  - em nenhum dos dois casos nada é gravado.
- A rota única `/api/webhooks/ink`, `identifyInkWebhookStore` e `INK_WEBHOOK_LEGADO` saíram. `INK_WEBHOOK_SECRET_*` só é lido pelo import (OPS-23), nunca no request path.
- O owner gera e rotaciona a URL na tela; o caminho aparece uma vez. O segredo do webhook é cadastrado na mesma tela.
- Idempotência por evento da Ink **não** foi acrescentada nesta rodada: o processamento de pedido já é reconciliação idempotente (relê o pedido na Ink). O replay de carrinho abandonado continua coberto pelo anti-spam da cadência. Fica registrado como risco residual.

**Estado depois da Fase 4 (rodada 15):**

- A **entrada** do webhook continua no desenho (c): `INK_WEBHOOK_LEGADO`, segredos do env por loja legada.
- É dívida explícita e isolada até a Fase 5c. Ela identifica só a loja e nunca autentica chamada à Ink.
- O token da API e o feed já são da Organization (`integration_secrets`).
- O `webhook_secret` também é importado para `integration_secrets` (`npm run integrations:import-legacy`), pronto para o cutover.
- `INK_WEBHOOK_SECRET_*` precisa continuar no ambiente até a 5c.

---

## TD-006 — Locking e escala dos jobs

**Status:** OPEN · **Impacto:** HIGH

**Contexto factual:** 13 de ~16 jobs têm guarda só em memória. O modelo atual é correto **apenas com
uma única instância**. Os 4 jobs de follow-up operam sobre JSON e duplicariam mensagens reais de
WhatsApp a clientes finais numa segunda réplica.

**Recomendação:** leasing persistente no Postgres (`FOR UPDATE SKIP LOCKED` ou advisory locks) antes
de qualquer cliente externo — não por elegância, mas porque deploy, escala ou blue-green já
produzem uma segunda réplica. Acrescentar orçamento por tenant contra noisy neighbour.

**Decisão:** **CLOSED (V1), rodada 17.**

- **Painel:** toda iteração de job por Organization pede lease persistente (`job_leases` + `job_lease_adquirir`/`job_lease_concluir`, SECURITY DEFINER; tabela global privada).
  - Só uma réplica roda cada (job, Organization).
  - A próxima janela é início + intervalo, ou seja, uma rodada por intervalo no cluster.
  - O lease vence sozinho depois de max(30 min, 2 × intervalo).
  - Lease indisponível não roda o job e aparece no log.
- **Itens:** reivindicação por CTE + `FOR UPDATE SKIP LOCKED`, em destinatários de campanha e na fila do Go.
  - A forma `WHERE id IN (subconsulta com LIMIT)` pegava mais que o lote (achado desta rodada) e foi trocada.
  - Item preso por queda vira falha visível, sem reenvio às cegas.
- **Go:** a fila é despachada com lease no banco do serviço (`lease_owner`, `lease_until`). O id do item vem do banco.
- **Prova:** processos reais disputando o mesmo Postgres (painel: 2–3 réplicas do scheduler; Go: 2 réplicas + queda com lease vencido).
- **Justiça:** a ordem das Organizations gira a cada rodada, e cada job processa lotes limitados. **Cota por tenant continua fora da V1.**

---

## TD-007 — Object storage vs volume local

**Status:** OPEN · **Impacto:** HIGH

**Recomendação:** object storage com chave prefixada por tenant e URLs assinadas de vida curta.
Volume local não sobrevive a múltiplas instâncias e torna backup/retenção (PD-010) manual.

**Decisão:** [aguardando]

---

## TD-008 — Fronteira de confiança Node ↔ creative-core

**Status:** OPEN · **Impacto:** CRITICAL

**Contexto factual:** autenticação por bearer token de serviço (`CREATIVE_CORE_SERVICE_TOKEN`,
`hmac.compare_digest`) ✔; **nenhum tenant context atravessa** a fronteira; nenhum correlation id é
propagado; a chave BYOK viaja no corpo JSON; o serviço faz bind em `[::]:$PORT`.

**Regra que vale independentemente da decisão:** nenhum serviço interno pode aceitar tenant context
sem validação numa borda confiável, e o serviço Python não pode ser alcançável por terceiros.

**Recomendação:** autenticação serviço-a-serviço explícita (já existe), tenant context derivado no
Node e jamais vindo do browser, correlation id propagado, e o serviço Python sem exposição pública
de rede.

**Decisão:** [aguardando]

---

## TD-009 — Modularização do `server.js`

**Status:** OPEN · **Impacto:** MEDIUM

**Recomendação:** fatiar **durante** a introdução de tenancy, por domínio e sob demanda — cada
domínio migra para módulo no momento em que recebe o middleware. Um refactor de movimentação puro,
antes e em massa, gera diff gigante sem ganho de segurança e esconde o que realmente mudou.

**Decisão:** [aguardando]

---

## TD-010 — Ferramenta de migrations

**Status:** ✅ **CLOSED (V1)** — **`node-pg-migrate`** · **Impacto:** HIGH · **Fase 0**

### Inspeção que precedeu a escolha

| O que | Estado observado |
|---|---|
| `package.json` | 5 dependências: `express`, **`pg` ^8.23**, `qrcode`, `serve`, `sharp`. Sem ORM. `postinstall` roda o build do admin |
| Sistema de módulos | **CommonJS** no app (`require`, `server.js:5`); os scripts avulsos são `.mjs` |
| Cliente Postgres | `pg` (node-postgres), `new Pool(...)` em `server.js:113`, condicionado a `DATABASE_URL` |
| Bootstrap atual | `bootstrapPostgres()` com `CREATE TABLE IF NOT EXISTS` **mais três backfills encadeados** (`server.js:1138, 1153, 1168`), todo o encadeamento sob um `.catch` que só loga (`server.js:1177-1181`) |
| Deploy | Railway, **sem manifesto no repo** (sem `Procfile`, `railway.json`, `nixpacks.toml`, `Dockerfile`). Processo único `node server.js` |
| Node | **sem `engines` nem `.nvmrc`** — versão não fixada |
| Testes | `node --test test/*.test.js`; 6 pulados por falta de `*_TEST_DATABASE_URL` |

**O achado que mais pesa na decisão:** o repositório **já faz migração e backfill no boot**, de
forma ad-hoc, não versionada, não transacional e com falha silenciosa. Os três `backfill*` não são
código de inicialização — são migrations disfarçadas, que rodam em **toda** subida do processo e
rodariam em **toda réplica** simultaneamente. Adotar a ferramenta não é acrescentar uma camada: é
dar dono a um trabalho que já existe e hoje não tem.

### Escolha: `node-pg-migrate`

| Critério obrigatório | Como é atendido |
|---|---|
| migrations ordenadas e versionadas | arquivos com timestamp, ordem lexicográfica |
| tabela de histórico no banco | `pgmigrations` |
| execução repetida idempotente | pula o que já está aplicado |
| falha interrompe a etapa | exit code ≠ 0 aborta o pre-deploy |
| up obrigatória | sim |
| down só quando seguro | `down` é opcional; migration irreversível é declarada como tal |
| SQL explícito permitido | `pgm.sql()` com SQL cru; JS quando o backfill exigir lógica |
| backfill em etapas | migrations JS com lotes |
| `CREATE INDEX CONCURRENTLY` | `pgm.noTransaction()` — **é o critério que elimina a maioria das alternativas** |
| não depende de ORM novo | roda sobre o `pg` que já existe |
| local e CI | CLI |

**Por que encaixa melhor neste repo:** usa o driver que já está aqui, é CJS como o app, aceita SQL
puro, e resolve `CONCURRENTLY` sem gambiarra — algo que a Fase 1 vai precisar ao indexar tabelas
grandes já em produção.

**Alternativas e por que não:**

- **Knex / Sequelize / Prisma** — trazem query builder ou ORM para resolver migration. Viola o
  critério explícito.
- **dbmate** — tecnicamente ótimo (SQL puro, `transaction:false`), mas é um binário Go. Introduzir
  um toolchain não-npm num build Nixpacks **sem manifesto de deploy no repositório** é custo
  operacional real e um lugar a mais para quebrar.
- **Runner próprio (~100 linhas)** — viável e sem dependência. Recusado por uma razão de risco, não
  de esforço: seria escrever e depurar infraestrutura de migration exatamente no momento em que
  mais precisamos que ela seja entediante e confiável. O plano já identifica o harness da Fase 0
  como risco máximo de execução; somar a isso um motor de migrations caseiro concentra risco no
  mesmo ponto.
- **Umzug** — genérico demais; exigiria adaptador de storage e mais fiação para o mesmo resultado.

### Dependência

`node-pg-migrate`, adicionada como **dependência normal**, não `devDependency`.

Razão: o comando de migration roda **no container publicado** (pre-deploy), e o build do Railway
pode podar `devDependencies`. Com `postinstall` já executando o build do admin, o comportamento de
instalação neste repo não é trivial — não vale apostar em poda.

**Nada foi instalado nesta rodada.**

### Comandos previstos

```text
npm run migrate:up            aplica pendentes
npm run migrate:down          reverte a última (só onde down existir)
npm run migrate:create -- <nome>
npm run migrate:dry           --dry-run, para inspecionar antes de aplicar
```

### Onde ficam os arquivos

```text
migrations/            ← NOVO: migrations de schema, versionadas
scripts/migracao-*.mjs ← JÁ EXISTE: migração de dados da Use Origens, one-off
```

> **Risco de confusão a evitar desde já:** `migrations/` (schema, versionado, parte do deploy) e
> `scripts/migracao-*` (migração pontual de catálogo da Use Origens) são coisas distintas com nomes
> quase iguais. Vale um `migrations/README.md` de uma linha dizendo qual é qual.

### Como CI e deploy rodam migrations

**Nunca no boot da aplicação.**

- **Deploy (Railway):** *Pre-deploy Command* = `npm run migrate:up`. Roda **uma vez por deploy**,
  antes de a nova versão receber tráfego; falha aborta o deploy. Como não há manifesto de deploy no
  repositório, isso é configuração de painel — entra no runbook como **OPS-11**.
- **CI:** subir um Postgres efêmero, aplicar **todas** as migrations do zero e então rodar a suíte.
  Efeito colateral valioso: passa a existir um banco real no CI, o que **destrava os 6 testes hoje
  pulados**, incluindo o único teste de isolamento por tenant do repositório.

### Como evitar duas instâncias migrando ao mesmo tempo

Três camadas, em ordem de importância:

1. **Estrutural — migration fora do boot.** Enquanto o schema nascer em `bootstrapPostgres()`, toda
   réplica tenta migrar a cada subida. Mover para pre-deploy reduz a **uma** execução por deploy,
   num container efetivamente único. Isto sozinho resolve o caso do Railway.
2. **Advisory lock no Postgres.** `node-pg-migrate` adquire lock por padrão (existe `--no-lock` para
   desligar — **não usar**). Protege o caso de alguém rodar `migrate:up` da máquina local durante um
   deploy. *Confirmar o comportamento na instalação; não pôde ser verificado a partir deste
   repositório.*
3. **Consequência obrigatória:** a Fase 0 precisa **remover o DDL e os três backfills do boot**
   (`server.js:118, 1138, 1153, 1168, 1177-1181`) e convertê-los em migrations versionadas. Sem
   isso, as camadas 1 e 2 não valem nada — as réplicas continuariam correndo entre si por outro
   caminho.

### Dependência registrada

O `DROP` das tabelas `origens_migration_*` (R-01) continua condicionado a esta decisão, e agora tem
mecanismo: vira uma migration própria, em release posterior.

---

## TD-011 — IDs públicos e enumeração

**Status:** OPEN · **Impacto:** MEDIUM

**Contexto factual:** o id público de pedido já usa `crypto.randomBytes` (~72 bits) ✔. Outras
entidades usam ids sequenciais.

**Recomendação:** ids opacos (ULID/UUID) para recursos de tenant em URL — mas isso é defesa
secundária. A defesa primária é a checagem de ownership; nunca substituir uma pela outra.

**Decisão:** [aguardando]

---

## TD-012 — Estratégia de entitlements fail-closed

**Status:** OPEN · **Impacto:** CRITICAL

**Contexto factual:** o default do frontend é permissivo e, quando o fetch falha, todas as flags
voltam a `true` (`admin/src/state/entitlements.ts:14-22, 36-39`). No backend **não existe nenhuma
aplicação de entitlement** — o próprio código registra que o middleware ficou para depois
(`server.js:13369-13372`).

**Recomendação:** middleware `checkEntitlement` no backend, negando por padrão quando o plano não
puder ser resolvido; frontend mantém as flags só como UX. Entitlement de quota (mensagens, gerações)
verificado **no momento do consumo**, não só na abertura da tela.

**Decisão (rodada 14 — CLOSED V1):**

- **O backend é a autoridade.**
  - Toda rota de negócio passa por `requireAdmin`, que chama `featureDaRota(caminho)` (`lib/platform/feature-routes.js`) e em seguida `requireEntitlement`.
  - O frontend só esconde o que o servidor já nega.
- **Fail-closed.**
  - Plano ausente, erro ao carregar, JSON que não é objeto, feature ausente, feature fora do vocabulário e qualquer valor diferente do booleano `true` resultam em **DENY** (`403 feature_nao_disponivel`).
  - `ENTITLEMENTS_DEFAULT` / `ENTITLEMENTS_FILE` foram removidos do backend.
  - Os `DEFAULTS` com `true` saíram do frontend: o espelho nasce todo `false`.
- **Escopo por Organization.**
  - O plano é a linha `app_config (organization_id, 'entitlements')` da Organization do contexto.
  - Além da RLS, a leitura tem predicado explícito; fora de contexto é erro, e o erro nega.
- **Vocabulário fechado (V1).**
  - `whatsapp`, `instagram`, `advancedAutomations`, `catalog`, `exchanges`, `refunds`, `financial`, `creative_generator`, `creative_clean_angles`, `creative_remarketing`, `creative_funnel_visual`, `creative_multi_product`.
  - Não é catálogo comercial: PD-005 e PD-009 continuam abertos.
- **Seed explícito, nunca default `true`.**
  - `npm run tenancy:seed-entitlements` (OPS-21) recebe `ENTITLEMENTS_SEED_ORGANIZATION_IDS` e `ENTITLEMENTS_SEED_FEATURES`.
  - Só liga o que foi listado e não desliga nada.
  - Feature fora do vocabulário é erro, e Organization inexistente também.
  - A Organization interna recebe o seed pelo operador: nada é deduzido.
- **Quota no consumo:** continua na Fase 5 (TD-006 / PD-009).

**Verificado por:**

- `test/invariants/inv-23-entitlement.test.js`, com dois negative controls: fonte no chão e ausência.
- `test/invariants/fase3-tenant-context.test.js`, sob `oria_app`.
- `test/invariants/fase3-server-ab.test.js`: processo real, A tem `financial` e B não.

---

# Direções fechadas (não revalidar sem instrução)

| Direção | Origem |
|---|---|
| O nome comercial do SaaS é **Oria** | addendum v2 §2 |
| A operação interna vira tenant sem bypass | addendum v2 §3 + PD-019 |
| **1 assinatura = 1 Organization = 1 Store ativa (V1)** | **usuário, rodada 2 — PD-002** |
| **`Organization` e `Store` continuam entidades separadas** | **usuário, rodada 2 — PD-002** |
| **Sem multi-store, rateio, consolidação ou seletor na V1** | **usuário, rodada 2 — R-02** |
| **`multiStoreMode` é LEGACY / TO_REMOVE** | **usuário, rodada 2 — R-02** |
| **Migração Use Origens sai do produto; tabelas viram LEGACY / TO_REMOVE, sem DROP agora** | **usuário, rodada 2 — R-01** |
| **Tenant context resolvido pela sessão; Organization nunca vem do browser** | **usuário, rodada 2 — TD-002** |
| **Customer nunca cruza Organization** | **usuário, rodada 2 — PD-017** |
| **Criativos pertencem à Organization; corrigir só a origem do `tenant_id`** | **usuário, rodada 2 — PD-018** |
| **Conexão OAuth de mídia pertence à Organization; sem rateio entre Stores** | **usuário, rodada 2 — PD-016** |
| **Recurso não atribuído ou ambíguo não entra silenciosamente na DRE (fail-closed de atribuição)** | **usuário, rodada 2 — PD-016 / PD-021** |
| **A tenant app é estritamente Organization-scoped; nenhuma rota dela agrega Organizations** | **usuário, rodada 4 — PD-022** |
| **A visão consolidada das 3 lojas é eliminada, não realocada para platform admin** | **usuário, rodada 4 — PD-022** |
| **O `creative-lab` é acessível só pela rede privada do Railway; `/v1/health` sem auth é aceitável neste desenho** | **usuário, rodada 5 — D-1 (evidência de infraestrutura)** |
| **Controles de infraestrutura não viram invariant de CI — vão para o checklist operacional (OPS-xx)** | **usuário, rodada 5** |
| **Operação interna: 3 Organizations se as lojas seguirem independentes; 1 se já consolidada em Use Origens** | **usuário, rodada 2 — PD-019** |
| **Unidade de cobrança = Organization/Store; 1 assinatura = 1 Store** | **usuário, rodada 2 — PD-009** |
| **Usuários individuais (roles a definir)** | **usuário, rodada 2 — PD-004** |
| **Tenancy = shared schema + `organization_id` NOT NULL + RLS habilitada e forçada; app sem `BYPASSRLS`; contexto por `set_config(..., true)` em transação** | **usuário, rodada 10 — TD-001** |
| Frontend/localStorage nunca é fronteira de segurança | addendum v2 §5 |
| Productização vem antes da próxima rodada de refino visual | addendum v2 §22 |
| Providers hipotéticos não geram trabalho de MVP | addendum v2 §23 |

---

# Pontos que dependeram de inferência — todos resolvidos

A mensagem da rodada 2 chegou com trechos truncados. Os dois pontos de confiança baixa/média foram
**confirmados pelo usuário** numa mensagem seguinte. **Nenhuma inferência permanece em aberto.**

| # | Trecho original | Leitura adotada | Situação final |
|---|---|---|---|
| 1 | *"como nmin futura"* (feature de migração) | "não deve aparecer como feature/item de menu no produto futuro" | inferência de alta confiança, aplicada (R-01) |
| 2 | *"→ perten"* (criativos) | "pertencem à **Organization**" | inferência de alta confiança, aplicada (PD-018) |
| 3 | *"PD-008 plano gg de PD-009"* | "PD-008, mais o restante de PD-009 (quotas, pricing, add-ons)" | inferência de alta confiança, aplicada |
| 4 | fecho da frase sobre múltiplas ad accounts | *"Se um recurso estiver não atribuído ou ambíguo, não deve entrar silenciosamente na DRE."* | ✅ **confirmado pelo usuário — e MAIS AMPLO que a inferência**: vale para **recurso**, não só para gasto. PD-021 fechado com a redação real |
| 5 | *"Se até a mOrigens…"* | *"Se até a migração a operação estiver consolidada numa única loja Use Origens, haverá apenas uma Organization/Store."* | ✅ **confirmado pelo usuário**. PD-019 fechado; dois cenários mantidos como direção |

**Correção relevante no item 4:** a inferência desta auditoria dizia "gasto"; a redação real do
usuário diz **"recurso"**. A diferença não é cosmética — ela estende a regra a ad accounts,
customers do Google Ads, GA4 properties e conexões OAuth, e transforma o item numa **regra
fail-closed de atribuição**, não numa regra contábil. Foi essa amplitude que revelou o achado F-01.

---

# Registro de mudanças da rodada 2

| ID | Antes | Depois |
|---|---|---|
| PD-002 | OPEN | **CLOSED (V1)** — 1:1, sem multi-store |
| PD-018 | OPEN | **CLOSED (V1)** — Organization; corrigir só a origem do `tenant_id` |
| TD-002 | OPEN | **CLOSED (V1)** — pipeline com `resolveOrganizationStore` |
| PD-004 | OPEN | **PARCIAL** — usuários individuais fechados; roles OPEN |
| PD-009 | OPEN | **PARCIAL** — unidade estrutural fechada; quotas/pricing OPEN |
| PD-016 | OPEN | **CLOSED (V1)** — ownership na Organization + regra fail-closed de atribuição |
| PD-017 | OPEN | **PARCIAL** — cross-org proibido, modelo definido; conflitos OPEN |
| PD-019 | OPEN | **CLOSED (V1)** — sem multi-store; dois cenários fechados; execução OPEN |
| PD-003 | OPEN | OPEN, **simplificada** (some a pergunta cross-store) |
| TD-001 | OPEN | OPEN, **simplificada** (eixo primário `organization_id`; matriz de teste menor) |
| PD-021 | — | **NOVA** → **CLOSED (V1)** — regra fail-closed de atribuição; gerou o achado F-01 |
| R-01 | — | **NOVA** — remoção da Migração Use Origens |
| R-02 | — | **NOVA** — remoção de `multiStoreMode` e do multi-store da V1 |

Inalteradas e ainda OPEN: PD-001, PD-005, PD-006, PD-007, PD-008, PD-010, PD-011, PD-012, PD-013,
PD-014, PD-015, PD-020, TD-003, TD-004, TD-005, TD-006, TD-007, TD-008, TD-009, TD-010, TD-011, TD-012.
(TD-012 foi fechado depois, na rodada 14.)

**Achado gerado nesta rodada:** **F-01** — a regra de PD-021 é violada hoje pelo consolidado
financeiro (mídia apurada sem escopo de loja; atribuição do Google Ads nunca consultada; `?loja=`
sobrescreve; `lojaAtribuidaPadrao()` auto-atribui com uma loja). Registrado em
`productization-audit.md`.

---

# Rodada 18 — decisões técnicas locais e pendências (17/09/2026)

Nenhum PD/TD mudou de status. Decisões de implementação tomadas nas trilhas (reversíveis, testadas):

| tema | decisão | onde |
|---|---|---|
| Repasse Go → painel | HMAC-SHA256 em header (`X-Oria-Forward-Timestamp`/`-Signature`, janela ±300 s); `?secret=` recusado sem modo legado; segredo novo ≥ 32 (OPS-09) | `whatsapp-inbound-5c.md` §2.1, contrato `forward-auth-v1` |
| Aceite do webhook Meta | 200 só depois de gravar idempotência + `webhook_inbox` na mesma transação; worker com lease; eventos/retry exatamente uma vez, repasse pelo menos uma vez, aviso/auto-resposta no máximo uma vez | `whatsapp-inbound-5c.md` §3.1 |
| Cache de contexto do Go | 30 s (válido) / 15 s (recusa), no lugar de 5 min / 1 min | idem |
| Páginas HTML embutidas no Go | removidas (410) | idem |
| Onboarding | requisito por passo só por configuração; sem config, criação recusada; `SECOND_TENANT_ENABLED` no serviço | `overnight-trilha-b.md` |
| Tenant #1 | cenário e mapeamento sempre explícitos; apply/rollback só local; verify somente leitura | `overnight-trilha-a.md` |
| Gate | OPS só VERIFIED com evidência em arquivo; exit 0/1/2 | `production-rollout-runbook.md` §1-2 |

**Pendências que ficaram com o usuário:**

1. PD-019 — cenário A ou B, e qual Organization fica com o número WhatsApp atual.
2. Janela RELEASE D → E: status de campanha repassados pelo Go 5b são recusados pelo painel novo até o
   Go R2 subir (aceitar ou encurtar).
3. Boot do painel sem `WHATSAPP_WEBHOOK_SECRET`: hoje avisa (e o repasse responde 503); tornar abort?
4. Release do painel antes do OPS-27? (o runbook assume que não).
5. RELEASE B e C juntas? (perde a janela de observação aditiva da 5b).
6. Janela de 404 de criativos se o OPS-22 só puder rodar depois do deploy.
7. Features do seed de entitlements; ordem de troca do `ADMIN_SESSION_SECRET` se hoje tiver < 32.
8. Onboarding: PD-005/006/007/008/009/011/012, provedor de e-mail do convite, rotas/UI.

> **Rodada 19:** as pendências acima foram fechadas — ver a seção seguinte.

---

# Rodada 19 — decisões do usuário aplicadas (17/09/2026)

| # | pendência (rodada 18) | decisão | implementação |
|---|---|---|---|
| 1 | PD-019 A/B e dono do número | **Cenário B**; número → Use Origens, declarado | `config/tenant1/*.template.json`, `--rollout`, `whatsapp.declaracao`; preflight bloqueia mapeamento ≠ B (`round19-trilha-h.md`) |
| 2 | Janela D → E do repasse | **Nenhuma perda aceita.** Go novo assina e mantém a query sob flag; painel exige assinatura e tolera a query sob flag; depois as flags saem | D0 = `8c024d2`, E, D', Go sem query, CLEANUP; contrato executável com o painel antigo real (`round19-trilha-e.md`) |
| 3 | Boot sem `WHATSAPP_WEBHOOK_SECRET` | **Abort em produção** (≥ 32), sem modo que dispense | `exigirSegredoDeRepasseNoBoot` (`round19-trilha-f.md`) |
| 4 | Release antes do OPS-27 | **Não.** Nenhuma release da productização, nem só migrations | runbook §3/§5.1 |
| 5 | B e C juntas | **Separadas.** B = checkpoint observável; C só após smoke + ciclo real | runbook §8.4/§9 |
| 6 | Janela de 404 dos criativos | **Zero janela.** Vínculo `tenant/<org>` → legado antes da B; materialização com leitura dupla depois da D' | `mover-criativos --vincular/--verificar/--desvincular`, `CREATIVE_LEGACY_READ_*` (`round19-trilha-g.md`) |
| 7a | Features do seed | **Features implementadas e usadas** pela operação: catalog, creative_clean_angles, creative_funnel_visual, creative_generator, creative_multi_product, creative_remarketing, exchanges, financial, refunds, whatsapp. OFF: instagram, advancedAutomations. Não fecha PD-005/PD-009 | perfil `config/entitlements/tenant1-entitlements.json`; seed valida contra o registry |
| 7b | Ordem do `ADMIN_SESSION_SECRET` | **Manter → importar/re-cifrar → provar 0 legado → desligar `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY` → smoke → só então rotacionar** | runbook §15.3; novo **OPS-36**, referência do dogfood |
| 8 | Onboarding | continua travado (sem mudança) | — |
| — | OPS-14 | `oria_app` só com a release estável; `MIGRATION_DATABASE_URL` separada, usada só no pre-deploy a partir da F | runbook §14 |
| — | Gate | exit 0 só com OVERALL READY; `--code-only` removido; `--report-only` informativo | `round19-trilha-f.md` |
| — | Dogfood | factual: dias pelo relógio desde `dogfood_started_at`, depois de OPS-14 e OPS-36 VERIFIED | idem + consolidação |
| — | QW-01 | continua OPEN; sem `trust proxy` sem evidência da topologia | — |

**Descoberta da consolidação:** a RELEASE B publica o commit antigo `31a7cdb`, cujo pre-deploy roda os
scripts daquele commit. Por isso o seed da B usa a lista igual ao perfil, o mapeamento chega por
variável, o par do WhatsApp é conferido pelo HEAD antes e depois, e os criativos usam o vínculo em vez
de código novo na B.

