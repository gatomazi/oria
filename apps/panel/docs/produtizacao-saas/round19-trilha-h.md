# Rodada 19 — Trilha H: cenário B como alvo de rollout, WhatsApp explícito, seed do Tenant #1

**Base:** `883e157` (worktree destacado). **Sem push, sem deploy, sem Railway, sem banco de produção.**
**Escopo:** §1 (PD-019 → cenário B como alvo de rollout), §2 (número WhatsApp atual → Organization
Use Origens, declarado) e §9 (seed explícito de features do Tenant #1) do comando da rodada 19.
**Fora do escopo, e continua igual:** OPS-27 NOT VERIFIED, Fase 6 NOT CLOSED, PD-005/PD-009 abertos.

## 1. PD-019: cenário B é o alvo de rollout

Decisão do usuário (rodada 19): o rollout mira **Organization "Use Origens" com Store "Use Origens"**.
Sul, Centro e Norte existem só como origem/mapping legado. Não se criam três Organizations no rollout.
O cenário A continua suportado e testado, mas só como **ensaio**.

O que mudou no tooling:

| onde | comportamento |
|---|---|
| `scripts/tenant1/config.mjs` | `CENARIO_ALVO_ROLLOUT = 'B'`. Novo campo obrigatório `rollout` (booleano) no arquivo do Tenant #1. `rollout: true` exige `--rollout` na linha de comando, cenário B, bloco `whatsapp` declarado e `entitlementsProfile` em cada Organization. `--rollout` com um arquivo `rollout: false` reprova. |
| `tenant1:*` (CLI) | a primeira linha termina em `· ALVO DE ROLLOUT` ou `· ensaio`. Item `rollout.alvo`: PASS no alvo, INFO no ensaio. |
| `tenant1:plan` | linha `alvo de rollout: sim (…)` ou `alvo de rollout: NÃO — ensaio (…)`. |
| `release:preflight` | nova seção `ROLLOUT`: um `TENANCY_MAPPING_FILE` válido mas fora do cenário B (ex.: 3 Organizations) dá **BLOCK** em `PD-019`. Só a contagem sai, nunca o conteúdo. Mudar o alvo pede nova confirmação do usuário. |
| fixtures `test/fixtures/tenant1/cenario-{a,b}.json` | ganharam `"rollout": false`: continuam sendo ensaio. |

### Formato do arquivo de rollout B

Os arquivos versionados são **templates**. Eles não têm id real nem segredo, e sem preencher não
passam na validação (testado).

- `config/tenant1/rollout-scenario-b.template.json`: arquivo do Tenant #1.
- `config/tenant1/tenancy-scenario-b.template.json`: mapeamento de tenancy do cenário B, igual ao
  ensaiado. Preenchido com os ids do ensaio, fica idêntico a `test/fixtures/tenancy/cenario-b.json`
  (testado).
- `config/entitlements/tenant1-entitlements.json`: perfil de features. É **dado final**, não template.

```json
{
  "versao": 1,
  "cenario": "B",
  "rollout": true,
  "mapeamentoTenancy": "tenancy-scenario-b.json",
  "creativeTenantLegado": "<CREATIVE_TENANT_ID_ATUAL>",
  "organizations": [
    { "id": "<ORGANIZATION_ID_USE_ORIGENS>", "entitlementsProfile": "../entitlements/tenant1-entitlements.json" }
  ],
  "owners": [
    { "email": "<EMAIL_DO_OWNER_USE_ORIGENS>", "passwordHashEnv": "TENANT1_OWNER_PASSWORD_HASH",
      "organizations": ["<ORGANIZATION_ID_USE_ORIGENS>"] }
  ],
  "whatsapp": {
    "waba":        { "id": "<WABA_ID_ATUAL>",         "organizationId": "<ORGANIZATION_ID_USE_ORIGENS>" },
    "phoneNumber": { "id": "<PHONE_NUMBER_ID_ATUAL>", "organizationId": "<ORGANIZATION_ID_USE_ORIGENS>" }
  },
  "inkWebhook": { "organizations": ["<ORGANIZATION_ID_USE_ORIGENS>"] }
}
```

| placeholder | de onde vem |
|---|---|
| `<ORGANIZATION_ID_USE_ORIGENS>` | UUID novo (minúsculo), gerado pelo operador uma vez e usado nos dois arquivos |
| `<STORE_ID_USE_ORIGENS>` | UUID novo da Store (só no mapeamento) |
| `<CREATIVE_TENANT_ID_ATUAL>` | valor atual de `CREATIVE_TENANT_ID` do painel (hoje o código usa `default` quando a variável não existe) |
| `<EMAIL_DO_OWNER_USE_ORIGENS>` | e-mail real do owner |
| `<WABA_ID_ATUAL>` / `<PHONE_NUMBER_ID_ATUAL>` | `META_WABA_ID` / `META_PHONE_NUMBER_ID` do Go, conferidos em OPS-27 (não são segredo) |

- O arquivo guarda `TENANT1_OWNER_PASSWORD_HASH` como **nome** de variável. O hash vem de
  `npm run auth:hash-password` e fica só no ambiente.
- O operador copia os templates para `config/tenant1/rollout-scenario-b.json` e
  `config/tenant1/tenancy-scenario-b.json`, no mesmo diretório. Assim os caminhos relativos
  (`tenancy-scenario-b.json` e `../entitlements/…`) continuam valendo, e o mesmo arquivo de mapeamento
  serve de `TENANCY_MAPPING_FILE` (OPS-16).
- **[DECISÃO do usuário, não tomada aqui]** Se as cópias preenchidas entram no repositório. OPS-16 fala
  em "arquivo publicado". Os ids não são segredo, mas são de produção.
- No template, a Store assume a loja legada `sul`, destino da consolidação Centro/Norte → Sul, que é a
  mesma forma ensaiada. Conferir antes do corte. O INFO `tenancy.loja-fora-da-store` (histórico de
  Centro/Norte fora das telas) continua valendo (overnight-trilha-a §7.1).
- `inkWebhook` vem declarado porque o runbook faz o cutover da Ink. `null` continua aceito se a Ink
  ficar fora da execução; a obrigatoriedade da Ink não foi decidida aqui.

## 2. WhatsApp atual → Organization Use Origens (explícito)

- **Arquivo.** `whatsapp` agora declara cada recurso com o próprio dono:
  `{ waba: {id, organizationId}, phoneNumber: {id, organizationId} }`.
  - WABA e número com Organizations diferentes reprovam antes de abrir conexão.
  - A forma antiga `{ organizationId }` deixou de valer (`campos não aceitos`), porque deixava o par ser
    lido do ambiente sem declaração.
- **Item `whatsapp.declaracao`** (preflight, plan, apply e verify). É uma função pura,
  `conferirDeclaracaoWhatsapp`, em `scripts/tenant1/checks.mjs`.
  - `whatsapp: null` com `WHATSAPP_LEGACY_*` no ambiente, ou com posse de WABA/número no banco → FAIL.
    Vale também com um único número e uma única Organization.
  - Declarado, mas o ambiente traz outro par → FAIL.
  - Posse do par declarado em outra Organization → FAIL.
- **`whatsapp.remetente[org]`.** A completude agora confere o **par declarado**: integração da
  Organization declarada + as duas posses em `external_resource_claims`.
- **`import-whatsapp-sender`.** Novo parâmetro `esperado` (`{wabaId, phoneNumberId}`), usado pelo
  tenant1. Com ele, o import recusa um ambiente diferente do declarado. O CLI isolado não mudou.

Testes (`test/invariants/r19-tenant1-whatsapp-explicito.test.js`):

- **(a)** Banco B com um único número no ambiente e arquivo `whatsapp: null` → preflight, plan e apply
  dão FAIL, sem escrita. Depois do cutover, posse no banco + `null` → verify FAIL.
- **(b)** WABA de Sul e número de Centro → os 4 comandos dão FAIL antes do banco.
- **(c)** Fixture B convergente → PASS. `external_resource_claims` fica com
  `phone_number` e `waba` na mesma Organization.
- **(+)** Número declarado ≠ ambiente → FAIL, e o import também recusa.

## 3. Seed explícito do Tenant #1 (§9)

### Derivação (código em `883e157`)

Fontes consultadas:

- **Registry:** `lib/platform/entitlements.js` (`FEATURES`).
- **Rotas protegidas:** `lib/platform/feature-routes.js`, aplicado em todo `requireAdmin` de
  `server.js`.
- **Checagens diretas:**
  - `server.js` (`checkEntitlement(…, 'whatsapp')` no resolver do remetente e no contexto de entrada
    do Go);
  - `routes/criativos.js` (`checkEngineAccess`, com as flags de `lib/creative-core/flags.js`).
- **Telas:** `admin/src/shell/nav.ts` (itens `comingSoon`) e `admin/src/pages/*`.
- **Uso pela operação:** `docs/painel-estado-atual.md` (módulos em uso) e a tela Custos de API, que
  mede o gasto real da operação com WhatsApp e geração de criativos.

| feature | implementada? | rota(s)/checagem que a exige | tela | usada pela operação? | Tenant #1 |
|---|---|---|---|---|---|
| `whatsapp` | sim | `/api/admin/{whatsapp,whatsapp-web,whatsapp-templates,campaigns,segments,automacao-eventos,automation-settings,recuperacao}`, `dashboard/recuperacao-resumo`; resolver interno do remetente e contexto de entrada (Go) | WhatsApp, Automações, Campanhas, Recuperação | sim (número atual, automações, campanhas) | **ON** |
| `catalog` | sim | `/api/admin/{produtos,produto-tipos,categorias,category-assignments,category-jobs,agrupamentos,promocoes,estoque,controle-estoque}` | Catálogo, Estoque | sim | **ON** |
| `exchanges` | sim | `/api/admin/trocas` | Trocas e devoluções | sim | **ON** |
| `refunds` | sim | `…/reembolsos` | Reembolsos, drawer de pedidos | sim | **ON** |
| `financial` | sim | `/api/admin/{financeiro,dashboard/financeiro,dashboard/lucro-produtos,analytics/consolidado}` | Financeiro, Despesas, Custos de API, DRE | sim | **ON** |
| `creative_generator` | sim | `/api/admin/criativos` | Gerador de criativos | sim (consumo medido em Custos de API) | **ON** |
| `creative_clean_angles` | sim | motor `CLEAN_ANGLES` (`checkEngineAccess`) | aba Gerar | sim, dentro do gerador | **ON** |
| `creative_remarketing` | sim | motor `REMARKETING` | aba Gerar | sim, dentro do gerador | **ON** |
| `creative_funnel_visual` | sim | motor `FUNNEL_VISUAL` | aba Gerar | sim, dentro do gerador | **ON** |
| `creative_multi_product` | sim | `product_mode = multi_product` | aba Gerar (Multipeça) | sim, dentro do gerador | **ON** |
| `instagram` | **não** (`em_breve`) | nenhuma | item `comingSoon` em nav.ts; card "placeholder" em Integrações | não | **OFF** |
| `advancedAutomations` | **não** (`nao_implementada`) | nenhuma | nenhuma (só no espelho `entitlements.ts`) | não | **OFF** |

**Lista final ON (10):** `catalog`, `creative_clean_angles`, `creative_funnel_visual`,
`creative_generator`, `creative_multi_product`, `creative_remarketing`, `exchanges`, `financial`,
`refunds`, `whatsapp`.

Observações:

- **Sub-flags do gerador.** Viraram ON porque estão implementadas e são as opções da tela que a
  operação usa. O código não mostra qual motor a operação aciona mais; se algum não for usado, basta
  tirá-lo do perfil (dado, sem código).
- **`whatsapp` é obrigatório para o fluxo atual.** Sem ele, o resolver do remetente devolve
  `FEATURE_DISABLED` e as automações e campanhas pelo Go param.
- **Rotas sem feature** (Pedidos, Visão geral, Clientes, PIX, Simular frete, UTM, GA4, Meta Ads,
  Google Ads, Integrações, Configurações) não dependem de entitlement. Nenhum módulo em uso fica
  bloqueado por falta de feature no vocabulário.
- **Não é plano comercial.** PD-005 e PD-009 continuam abertos.

### Registry canônico

`lib/platform/entitlements.js` ganhou `ESTADO_DAS_FEATURES` (`implementada` | `em_breve` |
`nao_implementada`) e `FEATURES_IMPLEMENTADAS`. O vocabulário e o runtime não mudaram. O teste
`r19-entitlement-seed` confere a tabela contra o código:

- toda feature de `feature-routes.js` e toda flag do Creative Core está `implementada`;
- toda `implementada` tem rota ou motor que a confira;
- o item `comingSoon` de nav.ts que é feature (`instagram`) está `em_breve`;
- a única feature sem rota, motor ou tela é `advancedAutomations`.

### Perfil e script

- **Perfil:** `config/entitlements/tenant1-entitlements.json`, versão 1, com
  `{versao, perfil, descricao, features: [...]}`. `features` é **lista**; objeto com `true`/`false`
  é recusado.
- **`npm run tenancy:seed-entitlements`** aceita duas formas:
  - `ENTITLEMENTS_SEED_ORGANIZATION_IDS` + **`ENTITLEMENTS_SEED_PROFILE`** (contrato do rollout);
  - a forma antiga, `ENTITLEMENTS_SEED_FEATURES`, que continua aceita para ensaio e testes
    (fase3-*).
- **Validação comum às duas formas.** O script recusa:
  - feature fora do vocabulário;
  - feature não implementada (`instagram`, `advancedAutomations`);
  - curinga (`*`, `all`, `todas`, `tudo`, `default`);
  - chave `all`/`default*` no perfil;
  - lista vazia e feature repetida;
  - perfil e lista juntos **com listas diferentes** (iguais valem desde a revisão do §8);
  - id repetido ou Organization inexistente.
  Toda recusa ocorre sem escrita.
- **Idempotente.** A segunda execução não grava (nem o `atualizado_em` muda) e informa `nada mudou`.
  Nada é desligado.
- **Saída:** só nomes e estado, no formato
  `perfil X · ON: …` / `<org>: ligadas agora: …|nada mudou` /
  `não ligadas por este seed: instagram (em_breve), advancedAutomations (nao_implementada)`.
  Erro de banco sai só com o código.
- **tenant1:** `organizations[].entitlementsProfile` (exclusivo com `entitlements`). O `apply` chama o
  seed com `ENTITLEMENTS_SEED_PROFILE` = o mesmo arquivo. A lista inline passa pela mesma validação.
- **`release:preflight`:**
  - `ENTITLEMENTS_SEED_PROFILE` é obrigatória em `release-n`;
  - a seção `ENTITLEMENTS` valida o perfil e lista o ON; perfil inválido ou ausente → BLOCK;
  - `ENTITLEMENTS_SEED_FEATURES`: na primeira versão bloqueava sempre. **Revisado no §8.2:** na RELEASE B
    é obrigatória e precisa ser igual ao perfil.

## 4. Controles negativos adicionados

Todos seguem o ciclo de 5 passos contra uma cópia; o repositório não é tocado.

| controle | arquivo de teste | violação |
|---|---|---|
| seed aceita feature desconhecida | `r19-entitlement-seed` | lista de desconhecidas zerada |
| seed aceita feature não implementada | `r19-entitlement-seed` | checagem de implementação zerada |
| perfil aceita `all`/`default` | `r19-entitlement-seed` | chaves `all*`/`default*` ignoradas |
| inferência do único número | `r19-tenant1-whatsapp-explicito` | `whatsapp: null` + ambiente passa quando há 1 Organization |
| WABA e número cruzados | `r19-tenant1-whatsapp-explicito` | checagem de convergência desligada |

Também há controles de dado, com banco real:

- banco B com número no ambiente e arquivo `null` → FAIL;
- par divergente → FAIL;
- posse no banco + `null` → FAIL;
- template cru → inválido;
- `--rollout` ausente ou sobrando → FAIL;
- cenário A com `rollout: true` → FAIL;
- `release:preflight` com mapeamento A → BLOCK.

## 5. Texto para o runbook (primeira versão)

> **Substituído em parte pelo §8.** A RELEASE B publica `31a7cdb`, não o HEAD. Para 4.5, 6.1 e 6.4,
> vale o §8.

Substitui as bifurcações A/B de 4.1, 4.5 (OPS-16, OPS-21 e OPS-29), 6.1 e 6.4.

### 4.1 Decisões (substituir o item PD-019 e o item "[CONSOLIDADO R18 — trilha A] Arquivo do Tenant #1")

- [x] **PD-019 — FECHADO (rodada 19): cenário B.** Organization "Use Origens" com Store
  "Use Origens". Sul/Centro/Norte só como mapping legado. O número WhatsApp atual (WABA +
  phone_number_id) pertence à Organization Use Origens. Qualquer mudança nisso exige nova
  confirmação do usuário antes do deploy; o `release:preflight` bloqueia mapeamento fora do cenário B.
- [ ] Preencher os arquivos de rollout:
  1. `cp config/tenant1/rollout-scenario-b.template.json config/tenant1/rollout-scenario-b.json`
  2. `cp config/tenant1/tenancy-scenario-b.template.json config/tenant1/tenancy-scenario-b.json`
  3. Substituir todos os `<…>` (tabela em `round19-trilha-h.md` §1). Nenhum `<` pode sobrar:
     `grep -n '<[A-Z_]*>' config/tenant1/rollout-scenario-b.json config/tenant1/tenancy-scenario-b.json`
     não pode imprimir nada.
  4. `WABA_ID` e `PHONE_NUMBER_ID` são os mesmos `META_*` do Go conferidos em OPS-27.
- [ ] **Ensaio obrigatório** (backup de produção restaurado num Postgres **local**, OPS-04):
  ```bash
  ARQ=config/tenant1/rollout-scenario-b.json
  npm run tenant1:preflight -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout
  npm run tenant1:plan      -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout
  npm run tenant1:apply     -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout --saida-segredos <dir 0700>
  npm run tenant1:verify    -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout
  ```
  Esperado:
  - primeira linha `· ALVO DE ROLLOUT`;
  - `PASS rollout.alvo`;
  - `PASS whatsapp.declaracao`;
  - `entitlements (perfil tenant1-operacao-interna)`;
  - `RESULTADO …: PASS`;
  - no verify, só PASS/INFO. O INFO `tenancy.loja-fora-da-store` é esperado.

  Ambiente mínimo:
  - `TENANT1_OWNER_PASSWORD_HASH` (hash scrypt);
  - `WHATSAPP_LEGACY_PHONE_NUMBER_ID`/`_WABA_ID` **iguais** ao arquivo, e `_ACCESS_TOKEN`;
  - `ENCRYPTION_MASTER_KEY`;
  - `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1` + `ADMIN_SESSION_SECRET`;
  - `INK_*_SUL`.

### 4.5 Ambiente do painel (substituir OPS-16, OPS-21 e completar OPS-29)

- [ ] **OPS-16:** `TENANCY_MAPPING_FILE=config/tenant1/tenancy-scenario-b.json` (o mesmo arquivo do
  ensaio). `release:preflight` → `MAPPING OK` e `ROLLOUT PD-019 OK (cenário B)`.
- [ ] **OPS-18:** `AUTH_BOOTSTRAP_ORGANIZATION_IDS=<ORGANIZATION_ID_USE_ORIGENS>`.
  `AUTH_BOOTSTRAP_OWNER_EMAIL` deve ser o mesmo e-mail do arquivo.
- [ ] **OPS-21:**
  - `ENTITLEMENTS_SEED_ORGANIZATION_IDS=<ORGANIZATION_ID_USE_ORIGENS>`
  - `ENTITLEMENTS_SEED_PROFILE=config/entitlements/tenant1-entitlements.json`
  - **Não** definir `ENTITLEMENTS_SEED_FEATURES`: o preflight bloqueia.
  - `release:preflight` → `ENTITLEMENTS tenant1-entitlements.json OK`, com ON =
    catalog, creative_clean_angles, creative_funnel_visual, creative_generator,
    creative_multi_product, creative_remarketing, exchanges, financial, refunds, whatsapp.
- [ ] **OPS-29:** `WHATSAPP_LEGACY_PHONE_NUMBER_ID` e `WHATSAPP_LEGACY_WABA_ID` iguais a
  `whatsapp.phoneNumber.id` e `whatsapp.waba.id` do arquivo de rollout. O `tenant1:verify` confere e
  dá FAIL se divergirem.

### 6.1 PRE-DEPLOY (substituir a linha do import do WhatsApp e o item "[DECISÃO] A Organization de --organization")

```bash
npm run migrate:up \
  && npm run auth:bootstrap-owner \
  && npm run tenancy:seed-entitlements \
  && npm run integrations:import-legacy -- --aplicar \
  && npm run integrations:reencrypt \
  && npm run integrations:import-whatsapp-sender -- --organization <ORGANIZATION_ID_USE_ORIGENS> --aplicar
```

- `--organization` é o `whatsapp.waba.organizationId` do arquivo de rollout, que é igual ao
  `phoneNumber.organizationId`. **Não é decisão em aberto:** PD-019/§2 fecharam.
- Antes do deploy, em produção e só com comandos de leitura:
  `npm run tenant1:preflight -- --scenario B --mapping config/tenant1/rollout-scenario-b.json --uploads $UPLOADS_DIR --rollout`
  e o mesmo com `tenant1:plan`.
  - Esperado: sem FAIL.
  - PEND são os passos do pre-deploy.
  - `whatsapp.declaracao` = PASS. Se der FAIL aqui, **não** fazer o deploy.

### 6.4 VERIFY B (substituir os itens de entitlements e "[CONSOLIDADO R18 — trilha A] tenant1:verify")

- [ ] Entitlements:
  - as telas de Catálogo, Estoque, Trocas, Reembolsos, Financeiro, WhatsApp/Automações/Campanhas/
    Recuperação e Gerador de criativos abrem;
  - Instagram continua oculto;
  - `GET /api/admin/entitlements` mostra `instagram: false` e `advancedAutomations: false`.
- [ ] `npm run tenancy:seed-entitlements` (de novo, com o mesmo ambiente) → `<org>: nada mudou`.
  [EVIDÊNCIA]
- [ ] `npm run tenant1:verify -- --scenario B --mapping config/tenant1/rollout-scenario-b.json --uploads $UPLOADS_DIR --rollout`,
  com a role de migration → só PASS/INFO.
  - Conferir `PASS whatsapp.declaracao` e `PASS whatsapp.remetente[<org>]`.
  - As duas posses (`waba`, `phone_number`) ficam na Organization Use Origens.
  - [EVIDÊNCIA]

## 6. Arquivos

- **Novos:**
  - `config/entitlements/tenant1-entitlements.json`
  - `config/tenant1/rollout-scenario-b.template.json`
  - `config/tenant1/tenancy-scenario-b.template.json`
  - `test/invariants/r19-entitlement-seed.test.js`
  - `test/invariants/r19-tenant1-whatsapp-explicito.test.js`
  - `test/invariants/r19-tenant1-rollout-b.test.js`
  - `test/invariants/r19-release-b-contrato.test.js` (revisão)
  - este documento
- **Alterados:**
  - `lib/platform/entitlements.js` (só exports de metadado)
  - `scripts/tenancy/seed-entitlements.mjs`
  - `scripts/tenant1/{config,checks,acoes,cli}.mjs`
  - `scripts/integrations/import-whatsapp-sender.mjs`
  - `scripts/release/preflight.mjs`
  - `test/fixtures/tenant1/cenario-{a,b}.json`
  - `test/invariants/{fase6-tenant1-config,fase6-tenant1-rollback,release-preflight}.test.js`
  - `test/helpers/tenant1-ensaio.js` (revisão: `montarBase(..., { migrations })`)
- **Não tocados:** `server.js`, `package.json`, migrations, manifesto, `app-role.js`, `admin/src`.

## 7. Riscos e pendências para o usuário

1. **Cópias preenchidas no repositório?** Decidir se entram no repositório (OPS-16 "publicado") ou se
   ficam só no ambiente de deploy.
2. **Sub-flags do Creative Core ON.** Confirmar que a operação usa os três motores e o multipeça. Tirar
   algum do perfil é uma mudança só de dado.
3. **`lojaLegada: sul` no template.** É a forma ensaiada da consolidação. O histórico de Centro/Norte
   continua fora das telas até a re-rotulagem da migração (decisão já registrada na trilha A).
4. **`onboarding.semearEntitlements`** (Fase 7, para Organization externa) valida só o vocabulário,
   não o estado de implementação. Não foi alterado nesta trilha porque o onboarding externo está atrás
   do SECOND TENANT GATE.

## 8. Revisão: RELEASE B = `31a7cdb`

O runbook publica commits antigos:

| release | commit |
|---|---|
| B | `31a7cdb` |
| C | `3adad08` |
| D0 | `8c024d2` |
| D' | HEAD |

O *Pre-deploy Command* roda os scripts **do commit publicado**. `tenant1:*` e `release:preflight`
rodam do HEAD, na máquina do operador, e só leem.

### 8.1 O que a B executa (conferido no git, `test/invariants/r19-release-b-contrato.test.js`)

| item | em `31a7cdb` | consequência |
|---|---|---|
| migrations | 17 (última `1789900000000_integrations`). As 17 são idênticas às do HEAD, que só acrescenta 4. | `tenant1:verify` do HEAD reprova `db.migrations` contra o schema da B sem `--estagio release-b`. |
| `tenancy:seed-entitlements` | só `ENTITLEMENTS_SEED_ORGANIZATION_IDS` + `ENTITLEMENTS_SEED_FEATURES`. Valida só o vocabulário: aceita `instagram` (testado com o código real). | A lista antiga é **obrigatória** na B e precisa ser exatamente o perfil. O verify do HEAD pega sobra. |
| `integrations:import-whatsapp-sender` | `--organization` + `WHATSAPP_LEGACY_*`. Sem par declarado e **sem posse da WABA** (só a do número). | O par é conferido no HEAD antes (`antes-da-b`) e depois (`release-b`). A posse da WABA nasce do backfill da migration `1790000000000_whatsapp-inbound`, na D0. |
| `auth:bootstrap-owner`, `integrations:import-legacy`, `integrations:reencrypt`, `tenancy:mover-criativos` | mesmas interfaces | nada muda |
| `tenant1:*`, `release:preflight` | não existem | rodam do HEAD |

Nada do desenho depende de código que só exista no HEAD **dentro do pre-deploy da B**. O perfil, o par
declarado e a checagem de implementação são conferidos pelo HEAD, só com leitura, antes e depois
da B.

### 8.2 Reconciliação implementada

- **`tenant1:preflight|plan --estagio antes-da-b` (HEAD, sem banco).**
  - Confere que o ambiente que a B vai ler é o do arquivo de rollout:
    - `TENANCY_MAPPING_FILE` com o mesmo conteúdo;
    - `CREATIVE_TENANT_ID` = `creativeTenantLegado`;
    - `AUTH_BOOTSTRAP_*` = o owner declarado (hash scrypt presente);
    - `ENTITLEMENTS_SEED_FEATURES` = **exatamente** o perfil (sem sobra, falta, repetição ou curinga),
      e `ENTITLEMENTS_SEED_ORGANIZATION_IDS` = as Organizations;
    - `WHATSAPP_LEGACY_*` presentes e iguais ao par declarado.
  - Imprime os valores esperados (ids e nomes, nenhum segredo) e o comando do import com o
    `--organization` certo.
- **`tenant1:verify --estagio release-b` (HEAD, READ ONLY, schema da B).**
  - Espera as migrations até `RELEASE_B.ultimaMigration`.
  - Confere:
    - Organization, Store e mapeamento;
    - owner;
    - plano == perfil;
    - integração da Organization declarada com o **par declarado**, token e posse do número;
    - nenhuma outra Organization com a mesma WABA ou número configurado (na B não existe posse da WABA);
    - integrações legadas, re-cifra e criativos.
  - Viram INFO, e são conferidos no verify do HEAD:
    - `tenancy.gates` (o manifesto do HEAD tem tabelas posteriores);
    - `role.app` (OPS-14, RELEASE F);
    - `jobs.leases`;
    - `ink.webhook` (RELEASE D);
    - `whatsapp.posse-waba` (D0).
  - `--estagio antes-da-b` só vale para preflight/plan; `release-b`, só para verify.
- **`entitlements[..].extras`.** Com `rollout: true`, feature ligada no banco e fora do perfil agora é
  **FAIL** (antes era INFO). No ensaio continua INFO.
- **`audit[org]`.** Com `rollout: true`, a falta do registro `tenant1.apply` é **INFO**, porque em
  produção os scripts rodam um a um e o apply não roda. No ensaio continua FAIL.
- **`release:preflight`, lista antiga × perfil:**
  - Estágio `release-n` (RELEASE B):
    - `ENTITLEMENTS_SEED_FEATURES` é obrigatória e só é OK se for igual ao perfil válido;
    - ausente ou divergente → BLOCK, e o texto traz `valor esperado (igual ao perfil): …`.
  - `after-ops14`: igual → WARN (remover depois); divergente → BLOCK.
  - `cleanup`: presente → BLOCK.
  - Lista sem `ENTITLEMENTS_SEED_PROFILE` → BLOCK.
- **Seed do HEAD (D').** Perfil e lista antiga **iguais** → usa o perfil, sem erro, e é no-op
  idempotente (`nada mudou`, carimbo intacto, testado). Divergentes → erro, sem escrita.
- **Import do WhatsApp do HEAD (D').** Novos `--waba-id` e `--phone-number-id` (juntos) → recusa um
  ambiente diferente do par declarado. Um sem o outro sai com código 2.

### 8.3 Teste de contrato com o código real da B

`r19-release-b-contrato.test.js` extrai `scripts/`, `lib/` e `package.json` de `31a7cdb` via
`git archive` e roda contra um banco com as 17 migrations e o dado legado das três lojas:

1. **Antes da B.** `antes-da-b` sem `DATABASE_URL`: FAIL e valores esperados impressos. Com os valores:
   PASS. Controles (cada um → FAIL no item certo):
   - lista com `instagram` a mais;
   - número trocado;
   - mapeamento de outro arquivo;
   - `CREATIVE_TENANT_ID` diferente;
   - `AUTH_BOOTSTRAP_ORGANIZATION_IDS` de outra Organization.
2. **Pre-deploy da B**, com os scripts de `31a7cdb`: bootstrap → seed → import-legacy → reencrypt →
   import-whatsapp-sender `--organization` → mover-criativos. Todos saem com exit 0.
3. **`verify --estagio release-b`.** Só PASS/INFO. Sem o estágio, `db.migrations` dá FAIL.
4. **Controles de dado:**
   - o seed **da B** liga `instagram` → `entitlements[..].extras` FAIL;
   - WABA trocada na integração → `whatsapp.remetente` FAIL;
   - outra Organization com a mesma WABA configurada → `whatsapp.posse` FAIL.
   Cada um volta a PASS quando restaurado.
5. **D'.**
   - Migrations restantes aplicadas. O seed do HEAD com perfil + lista igual não muda nada; com lista
     divergente, recusa.
   - Posses `phone_number` e `waba` na mesma Organization (backfill).
   - Import do HEAD: par divergente → exit 1; só `--waba-id` → exit 2; par certo → exit 0.
   - `verify` do HEAD com `--rollout`: PASS, com `audit[..]` INFO.

Controle negativo novo, em `release-preflight.test.js` (5 passos): uma cópia do preflight que deixa
de comparar a lista com o perfil aceita lista divergente, e a asserção reprova.

### 8.4 Texto para o runbook (substitui o §5 em 4.5, 6.1 e 6.4; acrescenta D')

**4.1, depois de preencher os arquivos (§5, 4.1):**

```bash
ARQ=config/tenant1/rollout-scenario-b.json
# Sem banco: o schema de produção ainda é o anterior à B. Rodar com o export do ambiente do pre-deploy da B.
npm run tenant1:preflight -- --scenario B --mapping $ARQ --rollout --estagio antes-da-b
```

- Esperado: `RESULTADO preflight: PASS`.
- O bloco `VALORES para o pre-deploy da RELEASE B (31a7cdb)` é a fonte dos valores de 4.5.
- O ensaio local (backup restaurado) continua valendo com o `tenant1:apply` do HEAD. Para ensaiar a B
  como ela é, use o roteiro de `r19-release-b-contrato.test.js`: scripts de `31a7cdb` +
  `verify --estagio release-b`.

**4.5 Ambiente do painel (ambiente do pre-deploy da RELEASE B):**

- [ ] **OPS-16:** `TENANCY_MAPPING_FILE` = o mapeamento do arquivo de rollout (mesmo conteúdo).
  `CREATIVE_TENANT_ID` = `creativeTenantLegado` (ou ausente, se for `default`).
- [ ] **OPS-18:** `AUTH_BOOTSTRAP_OWNER_EMAIL` e `AUTH_BOOTSTRAP_ORGANIZATION_IDS` copiados do bloco
  VALORES. `AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH` = o hash de `TENANT1_OWNER_PASSWORD_HASH`.
- [ ] **OPS-21:**
  - `ENTITLEMENTS_SEED_ORGANIZATION_IDS=<ORGANIZATION_ID_USE_ORIGENS>`.
  - **`ENTITLEMENTS_SEED_FEATURES` = exatamente a linha do bloco VALORES.** Hoje:
    `catalog,creative_clean_angles,creative_funnel_visual,creative_generator,creative_multi_product,creative_remarketing,exchanges,financial,refunds,whatsapp`.
    O seed da B só lê esta variável.
  - `ENTITLEMENTS_SEED_PROFILE=config/entitlements/tenant1-entitlements.json`. É a fonte da verdade:
    a B ignora, e o HEAD usa na D'.
  - `release:preflight --stage release-n` → `ENTITLEMENTS tenant1-entitlements.json OK` e
    `ENTITLEMENTS_SEED_FEATURES OK (igual ao perfil)`. Qualquer divergência dá BLOCK e mostra o valor
    esperado.
- [ ] **OPS-29:** `WHATSAPP_LEGACY_PHONE_NUMBER_ID`/`_WABA_ID` = `whatsapp.phoneNumber.id`/`waba.id` do
  arquivo (o import da B não confere), mais `WHATSAPP_LEGACY_ACCESS_TOKEN`.
- [ ] `npm run tenant1:preflight -- … --rollout --estagio antes-da-b` com esse export → PASS.

**6.1 PRE-DEPLOY da RELEASE B (`31a7cdb`), sem mudança de comando:**

```bash
npm run migrate:up \
  && npm run auth:bootstrap-owner \
  && npm run tenancy:seed-entitlements \
  && npm run integrations:import-legacy -- --aplicar \
  && npm run integrations:reencrypt \
  && npm run integrations:import-whatsapp-sender -- --organization <ORGANIZATION_ID_USE_ORIGENS> --aplicar
```

- `--organization` = a linha impressa pelo `antes-da-b`, que é o `whatsapp.*.organizationId` do
  arquivo.
- **Não** passar `--waba-id`/`--phone-number-id` aqui: a B não conhece essas opções e as ignora. O par
  é garantido pelo `antes-da-b` (antes) e pelo `release-b` (depois).
- Os passos 6.2 (mover criativos) e 6.3 não mudam.

**6.4 VERIFY B:**

- [ ] `npm run tenant1:verify -- --scenario B --mapping config/tenant1/rollout-scenario-b.json --uploads $UPLOADS_DIR --rollout --estagio release-b`,
  com a role de migration → só PASS/INFO.
  - PASS obrigatórios:
    - `db.migrations` (17);
    - `entitlements[<org>]`, e **nenhum** `entitlements[<org>].extras`;
    - `whatsapp.declaracao`;
    - `whatsapp.remetente[<org>]`;
    - `whatsapp.posse`.
  - INFO esperados: `whatsapp.posse-waba`, `tenancy.gates`, `role.app`, `jobs.leases`, `ink.webhook`,
    `audit[<org>]`, `tenancy.loja-fora-da-store`.
  - [EVIDÊNCIA]
- [ ] Entitlements nas telas, como no §5 (Instagram oculto; `GET /api/admin/entitlements` com
  `instagram: false` e `advancedAutomations: false`).

**D' (HEAD):**

- [ ] Pre-deploy com o seed do HEAD. `ENTITLEMENTS_SEED_PROFILE` presente. A lista antiga pode
  continuar se for igual (o seed usa o perfil); o esperado é `<org>: nada mudou`.
  `release:preflight --stage after-ops14` avisa (WARN) para remover a lista; `cleanup` bloqueia.
- [ ] Se o import do WhatsApp rodar de novo no pre-deploy da D', usar
  `--organization <org> --waba-id <WABA_ID> --phone-number-id <PHONE_NUMBER_ID>`.
- [ ] VERIFY D': `npm run tenant1:verify -- --scenario B --mapping config/tenant1/rollout-scenario-b.json --uploads $UPLOADS_DIR --rollout [--app-role oria_app]`,
  **sem** `--estagio` → só PASS/INFO.
  - A posse `waba` (backfill da D0) fica na mesma Organization do número.
  - `ink.webhook[<org>]` é PASS depois da emissão da URL na tela (RELEASE D). Antes disso é FAIL/PEND:
    rodar depois da emissão.
  - `role.app` é PASS só depois do OPS-14.

### 8.5 Riscos da revisão

- **Mapeamento comparado byte a byte.** O `antes-da-b` exige que `TENANCY_MAPPING_FILE` tenha
  exatamente o mesmo conteúdo do mapeamento do arquivo de rollout: usar o mesmo arquivo.
- **O verify `release-b` não confere as gates de RLS.** Elas ficam para o verify do HEAD (D'). O boot da
  B e as migrations já as exigem.
- **O teste depende do commit `31a7cdb` no histórico** (`git archive`). Um clone raso quebra o teste,
  e quebra alto, de propósito: não há skip.
- **Relação entre estágios.** O mapeamento `release-n` = B / `after-ops14` = depois da D' segue a
  proposta do lead. Se a D' rodar ainda em `release-n`, a lista igual continua OK (o seed do HEAD
  aceita as duas iguais).

## 9. Dry-run do runbook (§15 do comando)

`test/invariants/r19-runbook-dry-run.test.js` roda o runbook de `b5b7480`, §4–§15, sem produção.

**Montagem:**
- um Postgres descartável como a produção de hoje: 6 migrations, dado legado das três lojas e
  credenciais nas colunas antigas;
- criativos com chaves e arquivos reais no diretório legado;
- uploads num diretório temporário;
- os arquivos de rollout preenchidos a partir dos templates, com o `grep` do §5.3 sem saída.

Os blocos de shell saem do próprio texto: §8.2 do runbook e §7.5 de `round19-trilha-g.md`.

**Substituições explícitas nos blocos:**
- `<ORGANIZATION_ID_USE_ORIGENS>` → id do ensaio;
- `/tmp/tenancy-mapping.json` → diretório temporário do teste;
- na D', a linha do import ganha `--waba-id/--phone-number-id`, como o §12 manda.

| passo | como | resultado |
|---|---|---|
| §5.4 | `release:preflight --from-env-file --stage release-n --legacy-forward-panel`, com banco (schema de antes da Fase 1) | exit 0, sem BLOCK, nenhum valor sensível; MAPPING, ROLLOUT e ENTITLEMENTS OK; migrations "pendente (o pre-deploy aplica)" |
| §5.4 | `tenant1:preflight --rollout --estagio antes-da-b` | PASS; imprime a linha do import |
| §7 | bloco `ops22-vincular-sh` | "vínculo criado …" |
| §8.2 | bloco do runbook com o código de `31a7cdb` (git archive), mapeamento via `TENANCY_MAPPING_JSON` → arquivo | exit 0; 17 migrations; seed e import aplicados |
| §8.4 | `tenant1:verify --estagio release-b` | só PASS/INFO; `creatives.arquivos` PASS (vinculado); arquivo antigo lido por `tenant/<org>/…` |
| §10 | preflight D0 + bloco com o código de `8c024d2` + OPS-34 | 21 migrations; URL opaca emitida por `emitirUrlInk` (mesma regra da rota da tela), só em arquivo 0600 |
| §12 | preflight D' sem `--legacy-forward-panel`, com segredo novo ≥ 32, tolerância e `CREATIVE_LEGACY_READ_*` | sem BLOCK; segredo legado curto → BLOCK (controle) |
| §12 | bloco com o código do HEAD | "No migrations to run!"; seed `<org>: nada mudou` (carimbo intacto); import com o par certo → OK; par errado → recusa |
| §12 | `tenant1:verify --rollout` (sem estágio) | só PASS/INFO; `ink.webhook` PASS; posses `waba` e `phone_number` na mesma Organization |
| §13.2 | `mover-criativos --verificar` → `--desvincular --aplicar` → `--verificar` | PASS-VINCULADO → "vínculo removido", N movidos → PASS (separado); verify segue verde |
| §14 | `release:preflight --stage after-ops14` (`MIGRATION_DATABASE_URL` dona, `DATABASE_URL` = role do app, `DB_ENFORCE_APP_ROLE=1`) | **ver divergência 1**; sem a flag: sem BLOCK, role OK, usuário distinto, WARN da lista antiga |
| §14 | `tenant1:verify --rollout --app-role <role>` com `DB_ENFORCE_APP_ROLE=1` | `role.app` PASS; role inexistente → FAIL (controle) |
| §5.3 | ensaio preflight → plan → apply → verify `--rollout` num segundo banco | PASS nos quatro |
| gate | `productization:gate --skip-suite --no-go-tests --json --evidence-dir <vazio>` | OVERALL BLOCKED; 36 OPS NOT VERIFIED; DOGFOOD NOT STARTED; exit 1 |

Por que o gate roda com `--skip-suite`: o teste já está **dentro** da suíte, e rodá-la de novo seria
recursivo. Com isso, `CODE` fica NOT VERIFIED e o exit é 1. Com a suíte completa, o §5.3 espera
exit 2. `--no-go-tests` não muda nada, porque sem a suíte os testes do Go não rodam.
`WHATSAPP_GO_DIR` vem do ambiente.

### Correções de tooling que o dry-run exigiu (commit desta etapa)

1. **`tenant1` × vínculo dos criativos.** `creatives.arquivos` usava `planejarMovimento`, que recusa o
   vínculo. Assim, o verify da B e o da D' davam FAIL entre o §7 e o §13.2. Agora, com
   `tenant/<org>` como link, o item usa `verificarCriativos` + as referências do banco:
   `PASS-VINCULADO` → PASS, mais o INFO `creatives.materializacao`.
2. **`role.app` antes do OPS-14.** Com `rollout: true` e sem `DB_ENFORCE_APP_ROLE=1`, a role da
   aplicação ausente ou incompleta vira **INFO**. Antes, o verify da D' dava FAIL, e o §12 pede "só
   PASS/INFO". Com `DB_ENFORCE_APP_ROLE=1`, o item volta a ser FAIL (testado); no ensaio, sempre FAIL.
3. **`emitirUrlInk` exportada** (`scripts/tenant1/acoes.mjs`), para o dry-run emitir a URL da D0 pela
   mesma regra da tela.

### Divergências do runbook (texto a corrigir; o teste registra, não contorna)

1. **§14 (RELEASE F) × §15.2.** O `release:preflight --stage after-ops14` dá **BLOCK** em
   `ALLOW_LEGACY_INTEGRATION_ENV=1` (permitida só em `release-n`). O mesmo vale para
   `ALLOW_LEGACY_ADMIN_PASSWORD`, se ligada. O runbook só as remove no CLEANUP (§15.2), então o
   preflight da F, como está escrito, não passa. O teste confere que o único BLOCK é esse. Correção
   sugerida no §14, antes do preflight da F: "desligar `ALLOW_LEGACY_INTEGRATION_ENV` (OPS-24) e
   `ALLOW_LEGACY_ADMIN_PASSWORD` (OPS-19) — o estágio after-ops14 bloqueia as duas. As variáveis
   `INK_*`/`ADMIN_PASSWORD` podem ficar até o §15.2". Isso fecha as alavancas de rollback de nível 1
   a partir da F: **[DECISÃO do lead/usuário]**. A outra opção é permitir essas flags em
   `after-ops14` no preflight.
2. **§12 (preflight D'), WARN esperados.** No estágio padrão (`release-n`), a lista antiga igual ao
   perfil dá **OK**, não WARN; o WARN só aparece em `after-ops14`. Aparecem WARN de
   `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED` e, com a leitura dupla na D', de
   `CREATIVE_LEGACY_READ_*`. Texto sugerido: "WARN esperados: tolerância, leitura dupla dos
   criativos, flags legadas, `INK_*`/`WHATSAPP_LEGACY_*`".
3. **§5.4 (preflight da B).** Com `--legacy-forward-panel`, o segredo legado **presente**, mesmo
   curto, dá **OK** ("valor LEGADO"); só a ausência dá WARN. O texto diz "curto ou ausente (WARN)".
4. **§14 VERIFY F** (`tenant1:verify … --rollout --app-role oria_app`). Rodar com
   `DATABASE_URL=$MIGRATION_DATABASE_URL`, porque o verify exige a visão da role de migration, e
   com `DB_ENFORCE_APP_ROLE=1` no ambiente. Sem essa variável, `role.app` sai INFO (correção 2), não PASS.
5. **§8.4 VERIFY B, INFO esperados.** Acrescentar `creatives.materializacao`. `creatives.arquivos` é
   PASS "vinculado". No §12 (D'), antes do §13.2, os dois continuam assim, e `role.app` é INFO até a F.
