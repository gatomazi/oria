# Entitlement canônico — uma fonte de verdade entre os dois planos

Como o Tenant Plane descobre o que uma Organization pode usar.

## A regra

```text
organization_subscriptions (ativa)
  → plan_features
  → organization_entitlement_overrides
      → entitlements efetivos

precedência:  override  >  plano  >  false
```

Organization suspensa nega tudo, **inclusive o que o override concede**. Sem assinatura ativa, nada
é concedido. Ausência nega. Erro nega.

É a mesma regra do Control Plane, agora lida da mesma fonte pelos dois lados.

## O bug que motivou a mudança

O Oria Admin concede plano gravando `organization_subscriptions` + `plan_features`. O painel
resolvia entitlement lendo `app_config` com a chave `entitlements` — outra tabela, escrita **apenas
por script de linha de comando** (`tenancy:seed-entitlements`, do rollout do Tenant #1).

Uma Organization criada pela interface do Admin, portanto, nascia assim:

```text
Control Plane:  internal · active · 10 features
Tenant Panel:   app_config vazio → nenhuma feature → 403 em tudo
```

Foi o que aconteceu com a Use Origens. A tela dizia "Não incluído no plano" para features que o
plano concedia, e `HTTP 403` aparecia como estado normal de produto. Pedidos funcionava só porque
aquela rota não tem guard de entitlement — não era sinal de saúde, era ausência de verificação.

Duas fontes de verdade que nunca conversaram. A correção não foi remover o guard (ele estava
certo: o painel realmente não via feature nenhuma), foi **acabar com a segunda fonte**.

## Como o painel lê, sem ganhar acesso ao catálogo de planos

`plans`, `plan_features`, `organization_subscriptions` e `organization_entitlement_overrides` são
**globais privadas**: a role da aplicação não recebe `GRANT` nelas, de propósito — são o vocabulário
comercial da plataforma, não dado do tenant. Dar `SELECT` exporia o catálogo de planos inteiro a
qualquer query do painel.

A leitura passa por duas funções `SECURITY DEFINER`, criadas na migration `0023` e concedidas à role
da aplicação pelo OPS-14:

| função | devolve | para quê |
|---|---|---|
| `entitlements_efetivos(org)` | só as features concedidas, com a origem | o guard de rota e o plano efetivo da UI |
| `entitlements_estado(org)` | `organizacao_ativa`, `assinatura_ativa`, `plano_chave` | distinguir as causas de negação |

O painel pergunta "o que **esta** Organization pode", nunca "quais planos existem". A Organization
vem do contexto autenticado — jamais do request.

É o mesmo padrão que o repositório já usa para leitura que atravessa fronteira (`auth_memberships`,
os read models do control plane).

## Por que `entitlements_estado` existe

"Suspensa", "sem assinatura ativa" e "o plano não inclui esta feature" são três causas diferentes.
Dizer "não incluído no plano" para as três é mentira em dois casos, e manda o operador procurar no
lugar errado. A UI precisa saber separá-las.

## `app_config.entitlements` — situação

**Não é mais fonte de verdade.** Há teste provando que uma linha lá, sozinha, não concede nada.

| uso | classificação | situação |
|---|---|---|
| resolver do painel | runtime | **substituído** |
| passo `entitlements` do onboarding (leitura) | runtime | **substituído** — confere a fonte canônica |
| `semearEntitlements` do onboarding (escrita) | compatibilidade | continua gravando, não decide nada |
| `scripts/tenancy/seed-entitlements.mjs` | seed/migração | ferramenta de migração e desenvolvimento |
| `scripts/release/preflight.mjs`, `scripts/tenant1/*` | seed/migração | caminho do rollout legado |

**Nenhum cliente novo depende de `app_config.entitlements`.** A tabela e a chave continuam
existindo — apagar é decisão separada, e o histórico do rollout legado ainda as referencia.

`tenancy:seed-entitlements` **não faz parte do onboarding normal**. Uma Organization criada pelo
Admin recebe acesso sem nenhum script manual.

## O que está travado por teste

- Organization criada pelo Admin, com `app_config` **vazio**, tem acesso correto — é o cenário exato
  do bug.
- Override `false` bloqueia feature do plano; override `true` concede fora do plano.
- Sem assinatura ativa: tudo negado. Organization suspensa: tudo negado, inclusive o override.
- O plano de uma Organization não vaza para outra.
- Sem contexto, o resolver recusa em vez de adivinhar.
- Linha em `app_config` não concede nada.
- Funciona sob `oria_app` (`NOSUPERUSER`, `NOBYPASSRLS`), e a role continua **sem** acesso direto a
  `plan_features`.

Controle negativo `entitlement/app-config-como-fonte`: se o resolver voltar a ler `app_config`, a
suíte reprova.

## Consequência para o conjunto de features

O resolver é **agnóstico ao vocabulário**: lê o que o plano contém. Se a composição do plano
`internal` mudar — por exemplo, pela frente que reclassifica catálogo, trocas e reembolsos como
capacidades do connector —, o resolver acompanha sem alteração.
