# Runbook único de rollout em produção — painel Oria + whatsapp-webhook-go

- **Versão:** rodada 19 (17/09/2026).
- **Origem:** consolida a rodada 18 (trilhas A–D) com as decisões da rodada 19 (trilhas E–H e lead).
- **Nada aqui foi executado.**

```text
ESTADO: rollout NO-GO — OPS-27 NOT VERIFIED; demais OPS NOT VERIFIED; dogfood NOT STARTED
Fase 6: CODE READY · NÃO CLOSED
PRODUCTION ROLLOUT START requires OPS-27 VERIFIED (nenhuma exceção, nem "só migrations")
```

Este runbook junta, numa ordem só, os OPS-01..36. As fontes originais continuam valendo como
contexto; onde divergirem, vale este documento, e o motivo está em §17:

- `productization-plan.md`;
- `whatsapp-sender-contract.md`;
- `whatsapp-inbound-5c.md`;
- os `round19-trilha-*.md`.

> **Onde rodar os comandos (monorepo Oria, rodada 20).** Tudo aqui foi escrito com o painel na raiz de
> um repositório. No monorepo, `npm run <script>` roda em `apps/panel`, ou pela raiz com os atalhos
> `npm run panel:*`, `npm run productization:gate`, `npm run release:preflight` e `npm run tenant1:*`.
> As releases B, C e D0 publicam commits do **repositório antigo** (`orgulhoregional`), que continua
> existindo; ver `docs/operations/railway-bootstrap.md` §"O que este projeto novo muda no runbook".

**Marcadores**

| marcador | significado |
|---|---|
| **[EVIDÊNCIA]** | gravar `docs/produtizacao-saas/ops-evidence/OPS-XX.json` (formato em §2) para o gate contar o item |
| **[SEM VOLTA]** | ponto a partir do qual um rollback para trás exige procedimento manual |
| **[NÃO ENSAIADO NO RAILWAY]** | procedimento testado localmente, mas não na plataforma |

---

## 0. Índice

| § | conteúdo |
|---|---|
| 1 | Ferramentas |
| 2 | Evidência OPS e dogfood (formato) |
| 3 | Decisões fechadas que este runbook aplica |
| 4 | Ordem única |
| 5 | BEFORE RELEASE |
| 6 | RELEASE A — Go aditivo 5b |
| 7 | OPS-22 passo 1 — vínculo dos criativos |
| 8 | RELEASE B — painel `31a7cdb` (checkpoint observável) |
| 9 | RELEASE C — cutover 5b |
| 10 | RELEASE D0 — painel R1 da 5c, repasse ainda pela query + cutover da Ink |
| 11 | RELEASE E — Go R2 da 5c, assinando junto com a query |
| 12 | RELEASE D' — painel HEAD, aceita pela assinatura |
| 13 | Ambiente — Go deixa de mandar a query; OPS-22 passo 2 (materialização) |
| 14 | RELEASE F — OPS-14 (role da aplicação) |
| 15 | CLEANUP e rotação do `ADMIN_SESSION_SECRET` |
| 16 | ROLLBACK |
| 17 | Divergências resolvidas |
| 18 | Dogfood, SECOND TENANT GATE e onboarding |
| 19 | Matriz OPS → passo |

---

## 1. Ferramentas

| comando | onde | o que faz |
|---|---|---|
| `npm run productization:gate` | máquina do operador / CI, com Docker | **O gate.** Blocos CODE (suíte, invariants, estático, Go), OPS e DOGFOOD. Exit: 0 **somente** com OVERALL READY; 1 = código bloqueado; 2 = código pronto, rollout bloqueado; 64 = uso inválido |
| `npm run productization:gate -- --report-only [--json]` | idem | **Não é gate.** Só relatório: sai 0 mesmo bloqueado e mostra o exit que o gate daria (`gateExit`). Nunca usar como condição de avanço |
| `npm run release:preflight -- --from-env-file <export> [--stage release-n\|after-ops14\|cleanup] [--service painel\|go] [--legacy-forward-panel] [--no-db]` | máquina do operador | Somente leitura: nomes de variáveis, flags de transição, role de migration, contrato da role, schema (READ ONLY), mapeamento, perfil de entitlements, alvo PD-019. **Nunca imprime valores.** Exit 1 com qualquer BLOCK |
| `npm run tenant1:preflight\|plan\|verify -- --scenario B --mapping <arquivo> --rollout [...]` | máquina do operador, código do HEAD | Somente leitura. `--estagio antes-da-b` (preflight/plan, sem banco) e `--estagio release-b` (verify, schema da B). `apply`/`rollback` só em banco **local** |
| `npm run tenancy:mover-criativos -- ... --vincular\|--verificar\|--desvincular --aplicar` | serviço com o volume, código do HEAD | OPS-22 (§7, §13.2) |
| `npm run test:app-role` | CI / operador | Suíte com a aplicação conectando como `oria_app` + `DB_ENFORCE_APP_ROLE=1` |

**Observações**

- `--code-only` foi removido na rodada 19 (saía 0 com OVERALL BLOCKED). Passá-lo é uso inválido (64).
- **Export de variáveis** (`--from-env-file`): arquivo `KEY=VALUE` gerado pelo operador a partir do Railway. Contém segredos, fica fora do repositório e é apagado depois.
- **Código do HEAD:** `tenant1:*`, `release:preflight` e o gate **não existem** nos commits antigos publicados em B/C/D0. Rodam de um checkout do HEAD, na máquina do operador.

---

## 2. Evidência OPS e dogfood (formato)

Diretório: `docs/produtizacao-saas/ops-evidence/`. Um arquivo por item. **Hoje nenhum existe**, então
todos aparecem como NOT VERIFIED, inclusive os OPS-06/07/08 da rodada 8, que precisam ser
registrados de novo neste formato.

```json
{
  "format": "oria-ops-evidence/v1",
  "id": "OPS-27",
  "status": "VERIFIED",
  "verified_at": "2026-09-20T12:00:00Z",
  "verified_by": "nome de quem verificou",
  "environment": "production",
  "evidence": "o que foi observado, sem segredo"
}
```

- `status`: `VERIFIED` ou `NOT_APPLICABLE`; este último exige `reason`.
- `environment` precisa ser `production`.
- **Nunca** coloque token, secret, senha, URL de banco ou valor de variável. O gate reprova campo
  sensível ou valor com cara de credencial.

**Dogfood (`DOGFOOD.json`).** É criado **uma vez**, no dia em que o dogfood começa (§18). Depois disso,
só `open_incidents` é editado.

```json
{
  "format": "oria-ops-evidence/v1",
  "id": "DOGFOOD",
  "environment": "production",
  "dogfood_started_at": "2026-10-01T00:00:00Z",
  "dogfood_required_days": 14,
  "recorded_by": "nome de quem registrou",
  "open_incidents": 0
}
```

- **Contagem:** o gate calcula os dias pelo relógio (agora − `dogfood_started_at`) e exige 14.
  `dogfood_required_days` é opcional; se vier, precisa ser 14.
- **Não há marcação de fim.** Com `status`, `started_at`, `ended_at`, `completed_at`, `closed_at`,
  `days` ou `elapsed_days` → FAIL.
- **Início:** ISO 8601 com hora e fuso, nunca no futuro.
- **Início depois das etapas finais:** o `dogfood_started_at` precisa ser **≥ `verified_at`** do
  `OPS-14.json` (§14) **e** do `OPS-36.json` (rotação final, §15.3). As duas referências precisam
  estar VERIFIED; NOT_APPLICABLE não serve.
- **Fechamento:** só com `open_incidents` = 0.
- **Sem arquivo:** NOT STARTED.

---

## 3. Decisões fechadas que este runbook aplica (rodada 19)

| # | decisão |
|---|---|
| D1 | **PD-019 = cenário B.** Organization "Use Origens" com Store "Use Origens". Sul/Centro/Norte só como mapeamento legado. O cenário A continua suportado e testado, mas **não** é o plano. Mudar exige nova confirmação do usuário |
| D2 | **Número WhatsApp atual** (WABA + phone_number_id) → Organization Use Origens, **declarado** no arquivo de rollout. Nunca inferido |
| D3 | **OPS-27 primeiro.** Nenhuma release da productização, nem só migrations, antes do OPS-27 VERIFIED. Sem enfraquecer HMAC nem fail-fast |
| D4 | **`WHATSAPP_WEBHOOK_SECRET` obrigatório no boot de produção** do HEAD (≥ 32; sem modo que o dispense) |
| D5 | **Status assinados sem perda.** O R1 vira D0 (repasse pela query) + E (Go assina e mantém a query) + D' (painel exige assinatura e tolera a query) + Go sem query + CLEANUP. Nenhum passo aceita perda |
| D6 | **B e C separadas.** B é checkpoint observável/reversível; C é cutover. C só depois de smoke + ciclo real observado na B |
| D7 | **Criativos sem 404.** Vínculo antes da B; materialização com leitura dupla depois da D' |
| D8 | **Seed explícito do Tenant #1** pelo perfil `config/entitlements/tenant1-entitlements.json` (10 features implementadas e usadas). Não fecha PD-005/PD-009 |
| D9 | **`ADMIN_SESSION_SECRET` rotacionado por último** (§15.3), só com 0 ciphertext dependente |
| D10 | **OPS-14 só com a release estável**; role de migration separada (§14) |
| D11 | **Gate:** exit 0 só com OVERALL READY |
| D12 | **Dogfood factual** (§2) |
| D13 | **QW-01 (`trust proxy`) continua OPEN**, sem evidência da topologia. Não bloqueia |

---

## 4. Ordem única

```text
 0. OPS-27 VERIFIED ................................................ §5.1
 1. backup/restore readiness (OPS-04) ............................. §5.2
 2. cenário B configurado (arquivos de rollout preenchidos) ....... §5.3
 3. mapping Tenant #1 + WhatsApp declarado (antes-da-b PASS) ...... §5.3–5.5
 4. Go aditivo 5b (RELEASE A) ..................................... §6
 5. criativos: vínculo tenant/<org> → legado (OPS-22 passo 1) ..... §7
 6. RELEASE B (31a7cdb), pre-deploy nesta ordem:                     §8
      migrations Fase 1+ (OPS-11/16/17) → owner (OPS-18) → entitlements Tenant #1 (OPS-21)
      → integrations import (OPS-23) → reencrypt parte 1 (OPS-25) → sender (OPS-29)
 7. observação B: smoke + ciclo 5b real + verify release-b ........ §8.4
 8. RELEASE C — cutover 5b ........................................ §9
 9. RELEASE D0 (8c024d2) + Ink webhook cutover (OPS-34) ........... §10
10. RELEASE E — Go R2 (migrations 2/3, leases, inbox; assina + query) §11
11. RELEASE D' (HEAD) — painel exige assinatura (tolera query) ..... §12
12. Go sem query (OPS-09 parte 3) ................................. §13.1
13. criativos: materialização com leitura dupla (OPS-22 passo 2) .. §13.2  [SEM VOLTA para antes da B]
14. RELEASE F — OPS-14 (oria_app + MIGRATION_DATABASE_URL) ......... §14
15. CLEANUP legado (N+1) .......................................... §15.1–15.2
16. ADMIN_SESSION_SECRET: rotação por último (OPS-36) ............. §15.3
17. iniciar dogfood (DOGFOOD.json) ................................ §18
```

**Checkpoints versionados**

| release | repositório | commit | conteúdo |
|---|---|---|---|
| A | Go | G2 `8c3fe50` | inclui G1 `40f4c35` |
| B | painel | P2 `31a7cdb` | Fases 0-4 + 5b aditiva |
| C | Go | G4 `31b4bc9` | inclui G3 `55647c0` |
| C | painel | P3 `3adad08` | — |
| D0 | painel | `8c024d2` | R1 da 5c + rodada 18 A/B, sem o endurecimento do repasse `c706da1` |
| E | Go | HEAD da productização | ≥ `789b7c9`, com a flag de transição |
| D' | painel | HEAD da productização | — |

---

## 5. BEFORE RELEASE

Nada aqui altera produção, exceto quando o passo diz "configurar": são variáveis sem efeito até o deploy.

### 5.1 Gate zero — OPS-27

- [ ] **OPS-27** — checklist em [`ops-27-checklist.md`](ops-27-checklist.md): App ID, MATCH/NO MATCH do
  App Secret, webhook real, `sig_verify=true`, WABA e número.
  - **Nunca colar o App Secret.**
  - Depois, com autorização explícita para chamar produção, rodar a bateria 5a:

    | chamada | esperado |
    |---|---|
    | sem assinatura | 403 |
    | assinatura inválida | 403 |
    | sem `API_KEY` | 401 |
    | `API_KEY` errada | 401 |
    | `API_KEY` correta | 200 |
    | `?key=<válida>` | 401 |

  - **[EVIDÊNCIA]** Enquanto o OPS-27 não estiver VERIFIED, **nenhum passo de §6 em diante acontece.**
    Qualquer NO MATCH, 403 no evento real ou "nada chegou" mantém **NO-GO**.
- [ ] **OPS-10** — `NOT_APPLICABLE` com `reason` "absorvido por OPS-27".

### 5.2 Infraestrutura e backup (OPS-01..08)

- [ ] **OPS-01** — `creative-lab` sem networking público. [EVIDÊNCIA]
- [ ] **OPS-02** — `CREATIVE_CORE_URL` no domínio privado. [EVIDÊNCIA]
- [ ] **OPS-03** — volume persistente em `STORAGE_DIR`/`UPLOADS_DIR`/`IMG_CACHE_DIR`. [EVIDÊNCIA]
- [ ] **OPS-04** — backups dos **dois** Postgres (painel e Go) habilitados **e testados por restauração**.
  - O backup do volume precisa preservar links simbólicos (§7).
  - É pré-condição de todo rollback. [EVIDÊNCIA]
- [ ] **OPS-05** — `DATABASE_URL` do painel presente. [EVIDÊNCIA]
- [ ] **OPS-06/07/08** — `META_APP_SECRET`, `API_KEY` e `DATABASE_URL` do Go, registrados de novo no formato. [EVIDÊNCIA]

### 5.3 Código e arquivos do cenário B

- [ ] **Hashes registrados:** B/C/D0 conforme §4; D' e E = HEAD da productização nos dois repositórios.
- [ ] **Gate:** no HEAD do painel, `npm run productization:gate`, com `WHATSAPP_GO_DIR` no HEAD do Go.
  - Esperado: **exit 2** com `CODE: PASS`.
  - **Exit 1 = pare.**
  - Exit 0 aqui é erro de evidência: nenhum OPS pode estar VERIFIED antes do rollout.
- [ ] **Suíte e build:** `npm run test:app-role` verde e `npm run build` verde.
- [ ] **Arquivos de rollout** (fora do repositório; têm ids de produção, não segredos):
  1. `cp config/tenant1/rollout-scenario-b.template.json config/tenant1/rollout-scenario-b.json`
  2. `cp config/tenant1/tenancy-scenario-b.template.json config/tenant1/tenancy-scenario-b.json`
  3. Substituir todos os `<…>` (tabela em `round19-trilha-h.md` §1). Este comando não pode imprimir nada:
     `grep -n '<[A-Z_]*>' config/tenant1/rollout-scenario-b.json config/tenant1/tenancy-scenario-b.json`
  4. O bloco `whatsapp` declara `waba.id` e `phoneNumber.id` (os `META_*` conferidos no OPS-27), os dois
     com `organizationId` = Use Origens.
     - Sem essa declaração → FAIL, mesmo havendo um único número.
     - Organizations diferentes → FAIL.
- [ ] **Ensaio obrigatório** (OPS-04): restaurar o backup de produção num Postgres **local** e rodar:

  ```bash
  ARQ=config/tenant1/rollout-scenario-b.json
  npm run tenant1:preflight -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout
  npm run tenant1:plan      -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout
  npm run tenant1:apply     -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout --saida-segredos <dir 0700>
  npm run tenant1:verify    -- --scenario B --mapping $ARQ --uploads <UPLOADS_DIR> --rollout
  ```

  Esperado:
  - `· ALVO DE ROLLOUT`;
  - `PASS rollout.alvo` e `PASS whatsapp.declaracao`;
  - `RESULTADO …: PASS`;
  - no verify, só PASS/INFO.

  Para ensaiar a B **como ela é** (scripts antigos), siga o roteiro de
  `test/invariants/r19-release-b-contrato.test.js`.

### 5.4 Ambiente do painel (configurar para o pre-deploy e o boot da RELEASE B)

- [ ] **OPS-15** — Node ≥ 20.11; PostgreSQL ≥ 15. [EVIDÊNCIA]
- [ ] **OPS-12** — `ENCRYPTION_MASTER_KEY` (32 bytes em base64), gerada fora do repositório. [EVIDÊNCIA]
- [ ] **OPS-13** — `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1`: mantém legíveis os tokens cifrados com a
  chave derivada do `ADMIN_SESSION_SECRET` **atual**. [EVIDÊNCIA]
- [ ] **OPS-20** — **manter o `ADMIN_SESSION_SECRET` atual.** Não rotacionar agora, nem que ele tenha
  menos de 32 caracteres. A rotação é o último passo (§15.3).
  - O P2 (`31a7cdb`) exige ≥ 32 em produção: confira com o `release:preflight` antes.
  - Se o atual for curto, o rollout **para aqui**: não existe procedimento seguro para trocá-lo antes
    da re-cifra. Nesse caso, uma decisão nova do usuário é necessária. [EVIDÊNCIA]
- [ ] **OPS-16** — mapeamento do cenário B no pre-deploy da B.
  - `31a7cdb` só lê o arquivo apontado por `TENANCY_MAPPING_FILE`, e a imagem da B não contém os
    arquivos preenchidos. **[NÃO ENSAIADO NO RAILWAY]** Publique o conteúdo numa variável e deixe o
    pre-deploy gravar o arquivo (§8.2):
    - `TENANCY_MAPPING_JSON` = conteúdo compacto de `config/tenant1/tenancy-scenario-b.json`
      (`jq -c . <arquivo>`, sem segredos);
    - o pre-deploy grava em `/tmp/tenancy-mapping.json` e exporta `TENANCY_MAPPING_FILE` para esse caminho.
  - `CREATIVE_TENANT_ID` = `creativeTenantLegado` do arquivo (ou ausente, se for `default`).
  - Localmente, `TENANCY_MAPPING_FILE=config/tenant1/tenancy-scenario-b.json` no export do preflight:
    `MAPPING OK` e `ROLLOUT PD-019 OK (cenário B)`. [EVIDÊNCIA]
- [ ] **OPS-18** — `AUTH_BOOTSTRAP_OWNER_EMAIL` (o do arquivo), `AUTH_BOOTSTRAP_OWNER_PASSWORD_HASH`
  (`npm run auth:hash-password`, na máquina do operador) e
  `AUTH_BOOTSTRAP_ORGANIZATION_IDS=<ORGANIZATION_ID_USE_ORIGENS>`.
- [ ] **OPS-21** — seed explícito:
  - `ENTITLEMENTS_SEED_ORGANIZATION_IDS=<ORGANIZATION_ID_USE_ORIGENS>`;
  - `ENTITLEMENTS_SEED_PROFILE=config/entitlements/tenant1-entitlements.json` (fonte da verdade; a B
    ignora, o HEAD usa);
  - `ENTITLEMENTS_SEED_FEATURES` = **exatamente** a linha do perfil, porque o seed da B só lê esta variável:
    `catalog,creative_clean_angles,creative_funnel_visual,creative_generator,creative_multi_product,creative_remarketing,exchanges,financial,refunds,whatsapp`.
    Qualquer divergência → BLOCK no preflight, que mostra o valor esperado.
  - **OFF:** `instagram` (comingSoon) e `advancedAutomations` (sem uso).
- [ ] **OPS-19 (release N)** — opcional: `ALLOW_LEGACY_ADMIN_PASSWORD=1` + `LEGACY_ADMIN_USER_EMAIL`.
- [ ] **OPS-24 (release N)** — `ALLOW_LEGACY_INTEGRATION_ENV=1`.
  - **Manter** até o CLEANUP: `INK_TOKEN_*`, `INK_FEED_URL_*`, `INK_WEBHOOK_SECRET_*`,
    `GOOGLE_ADS_EM_USO` e `CREATIVE_TENANT_ID`.
- [ ] **OPS-28 (painel)** — `WHATSAPP_SENDER_REF_SECRET` e `WHATSAPP_SENDER_RESOLVER_KEY`, cada um com ≥ 32.
- [ ] **OPS-29 (insumo)** — no ambiente do pre-deploy:
  - `WHATSAPP_LEGACY_PHONE_NUMBER_ID` e `_WABA_ID` **iguais** a `whatsapp.phoneNumber.id` e `waba.id` do
    arquivo (o import da B não confere);
  - `WHATSAPP_LEGACY_ACCESS_TOKEN`;
  - `WHATSAPP_LEGACY_REPLY_*`, se houver auto-resposta.
- [ ] **OPS-09 (estado atual)** — descobrir, **sem imprimir**, se o painel de produção tem
  `WHATSAPP_WEBHOOK_SECRET` e se a `WEBHOOK_FORWARD_URL` do Go tem `?secret=` (pelos nomes e pelo preflight).
  - **Não trocar nada agora:** B, C e D0 autenticam o repasse pela query.
  - Gerar e guardar fora do repositório o valor **novo** (≥ 32, diferente do legado), usado a partir da E.
- [ ] **Preflight da B:**

  ```bash
  npm run release:preflight -- --from-env-file <export do painel> --stage release-n --legacy-forward-panel
  ```

  - Esperado: sem BLOCK.
  - O modo `--legacy-forward-panel` aceita o segredo legado presente, mesmo curto (OK), e a ausência
    com WARN: B/C/D0 ainda não têm o boot fail-fast da rodada 19.
  - WARN esperados: flags legadas, `INK_*`, `WHATSAPP_LEGACY_*`.
- [ ] **Antes da B, cruzando o ambiente com o arquivo:**

  ```bash
  npm run tenant1:preflight -- --scenario B --mapping config/tenant1/rollout-scenario-b.json --rollout --estagio antes-da-b
  ```

  - Esperado: `RESULTADO preflight: PASS`.
  - O bloco `VALORES para o pre-deploy da RELEASE B` é a fonte dos valores acima, incluindo o
    `--organization` do import.

### 5.5 Ambiente do Go (configurar)

- [ ] **OPS-28 (Go)** — `PANEL_SENDER_RESOLVER_URL` (https) e `PANEL_SENDER_RESOLVER_KEY`
  (= `WHATSAPP_SENDER_RESOLVER_KEY`). [EVIDÊNCIA depois dos dois lados]
- [ ] **OPS-35 (parte 1)** — `META_GRAPH_BASE_URL` **ausente** em produção.
- [ ] **Preflight do Go:** `release:preflight -- --service go --from-env-file <export do Go>` → sem BLOCK.
  - `META_PHONE_NUMBER_ID/ACCESS_TOKEN/WABA_ID`: WARN; **ficam** até o CLEANUP.

---

## 6. RELEASE A — Go aditivo 5b

**Pré-requisitos:** §5.1 VERIFIED, §5.5 feito, backup do banco do Go.

- [ ] Deploy do Go **G2 `8c3fe50`**. Aceita `X-Sender-*`; sem os headers, ainda usa o ambiente; grava a
  referência na fila.

**VERIFY A**

- [ ] O envio atual continua saindo.
- [ ] `/health` responde.
- [ ] Boot sem erro de segredo.

---

## 7. OPS-22 passo 1 — vínculo dos criativos (antes da RELEASE B)

A B (`31a7cdb`) lê `creatives/tenant/<organization_id>/` e **não** tem leitura dupla. O vínculo faz
esse caminho apontar para o diretório atual. Assim, a produção atual e a B leem e gravam no mesmo
diretório físico, e o rollback B → produção não perde nada.

- [ ] **Serviço de produção atual** (tem o volume; o código atual não tem o mover):
  - `ORG` = Organization Use Origens (dona do `creative_tenant` no mapeamento);
  - `LEGADO` = `CREATIVE_TENANT_ID` atual, ou `default`.
- [ ] Rodar o bloco de shell de `round19-trilha-g.md` §7.5 (marcador `ops22-vincular-sh`).
  - Ele é idempotente e para sem mudar nada se `tenant/<ORG>` já existir.
  - O teste `ops22-creative-release-b` executa esse mesmo bloco extraído do documento.
  - **[NÃO ENSAIADO NO RAILWAY]** Se o `ln` falhar, o bloco para sem efeito.
  - [EVIDÊNCIA: a linha "vínculo criado" ou "vínculo já existe"]
- [ ] A produção continua servindo criativos antigos.
- **Não** rodar o `tenancy:mover-criativos` das releases B/C/D0.

**Rollback do passo, com a B ainda não publicada:** `rm $UPLOADS_DIR/creatives/tenant/<ORG>` (é um link;
`rm` sem `-r`).

---

## 8. RELEASE B — painel `31a7cdb` (checkpoint observável e reversível)

**Pré-requisitos:** A estável; §5.4 completo; §7 feito; backup do banco do painel **imediatamente antes**.

### 8.1 OPS-17 — só se a base de produção estiver antes da Fase 1

- [ ] Deploy intermediário de `b8f2ac7` (migrations até `1789600360000`). Com a base já adiante disso,
  registrar `NOT_APPLICABLE` com `reason`.

### 8.2 PRE-DEPLOY (Railway *Pre-deploy Command*; antes do OPS-14 a role de migration é a `DATABASE_URL` atual)

```bash
printf '%s' "$TENANCY_MAPPING_JSON" > /tmp/tenancy-mapping.json \
  && export TENANCY_MAPPING_FILE=/tmp/tenancy-mapping.json \
  && npm run migrate:up \
  && npm run auth:bootstrap-owner \
  && npm run tenancy:seed-entitlements \
  && npm run integrations:import-legacy -- --aplicar \
  && npm run integrations:reencrypt \
  && npm run integrations:import-whatsapp-sender -- --organization <ORGANIZATION_ID_USE_ORIGENS> --aplicar
```

| passo | OPS | se falhar |
|---|---|---|
| `migrate:up` com o mapeamento B | 11, 16 | deploy aborta; versão anterior no ar |
| `auth:bootstrap-owner` | 18 | ninguém entra (só o legado, se ligado) |
| `tenancy:seed-entitlements` (lista = perfil) | 21 | toda feature protegida responde 403 |
| `integrations:import-legacy -- --aplicar` | 23 | sai com erro se houver segredo ilegível |
| `integrations:reencrypt` | 25 (parte 1) | sai com erro se sobrar versão antiga |
| `integrations:import-whatsapp-sender` | 29 | Organization sem número: envio falha fechado depois do C |

- **`--organization`:** a linha do `antes-da-b` (Use Origens).
- **`--waba-id`/`--phone-number-id`:** **não** passar aqui; a B não conhece essas opções.
- **Criativos:** já resolvidos pelo §7.

### 8.3 RELEASE B

- [ ] Deploy do painel `31a7cdb` com as flags da release N: OPS-13, OPS-24 e, se quiser, OPS-19.

### 8.4 VERIFY B (smoke + observação; a C só vem depois disto)

- [ ] **Boot:** `[POSTGRES] conexão e migrations verificadas`; nenhum erro de chave; só os avisos esperados.
- [ ] **Login:** o owner declarado entra (as sessões antigas caíram).
- [ ] **OPS-26:** `POST /api/admin/integrations/{ink,meta,google_ads,ga4,openai}/teste` na Use Origens. [EVIDÊNCIA]
- [ ] **Entitlements:** as 10 features ON abrem; Instagram oculto;
  `GET /api/admin/entitlements` com `instagram: false` e `advancedAutomations: false`.
- [ ] **Criativos:**
  - criativos antigos e fotos de referência carregam;
  - um upload novo aparece;
  - `readlink $UPLOADS_DIR/creatives/tenant/<ORG>` = `<LEGADO>`.
- [ ] **Ciclo 5b real completo,** com remetente explícito e resolver 200: automação, campanha, fila
  manual, retry de `failed` e auto-resposta. **Sem este ciclo, a C não começa.**
- [ ] **Verify da B** (HEAD, role de migration, READ ONLY):

  ```bash
  npm run tenant1:verify -- --scenario B --mapping config/tenant1/rollout-scenario-b.json --uploads $UPLOADS_DIR --rollout --estagio release-b
  ```

  - **PASS obrigatórios:** `db.migrations` (17), `entitlements[<org>]` (nenhum `.extras`),
    `whatsapp.declaracao`, `whatsapp.remetente[<org>]` e `whatsapp.posse`.
  - **INFO esperados:** `whatsapp.posse-waba`, `tenancy.gates`, `role.app`, `jobs.leases`,
    `ink.webhook`, `audit[<org>]`, `tenancy.loja-fora-da-store` e `creatives.materializacao`
    (com `creatives.arquivos` PASS "vinculado").
  - [EVIDÊNCIA]
- [ ] **Preflight com banco:** `release:preflight --stage release-n --legacy-forward-panel` → schema em dia.
- [ ] [EVIDÊNCIA] OPS-11, 12, 13, 15, 16, 18, 20 (parte 1), 21, 23 e 29 (e 19/24 da release N).

---

## 9. RELEASE C — cutover 5b (Go G3+G4 e painel P3, juntos)

**Pré-requisitos:** VERIFY B completo, com o ciclo real observado. **B e C nunca vão juntas.**

- [ ] **OPS-30** — esvaziar a fila do Go. [EVIDÊNCIA]
- [ ] Deploy do Go **G4 `31b4bc9`**: exige o remetente, sem fallback de ambiente, `/health` só com `status`.
- [ ] Deploy do painel **P3 `3adad08`** na mesma janela: falha fechado sem número e não lê `/health`.
- [ ] Preflight: `--legacy-forward-panel` (o repasse ainda é pela query).

**VERIFY C**

- [ ] O envio real da Use Origens sai pelo número dela.
- [ ] Organization sem número → `WHATSAPP_SENDER_NOT_CONFIGURED` e nada é enviado.
- [ ] `GET /health` do Go sem credencial → `{"status":"ok"}`.
- [ ] OPS-26 repetido com `whatsapp`.

---

## 10. RELEASE D0 — painel R1 da 5c, repasse ainda pela query + cutover da Ink

**Pré-requisitos:** OPS-27 VERIFIED; C estável; OPS-29 com `WHATSAPP_LEGACY_REPLY_*`; backup dos **dois** bancos.

- [ ] **Commit:** `8c024d2` (`c706da1^`). A rota `/api/webhooks/whatsapp` é idêntica à de `bfd00a6`,
  como confere o teste `r19-contrato-repasse-transicao`.
- [ ] **PRE-DEPLOY:** o mesmo bloco do §8.2.
  - As etapas repetidas são idempotentes.
  - `migrate:up` aplica `1790000000000`, `1790000060000`, `1790000120000` e `1790000300000`.
- [ ] **Ambiente:** `WHATSAPP_WEBHOOK_SECRET` **inalterado** (legado); `SECOND_TENANT_ENABLED` ausente.
- [ ] **Preflight:** `release:preflight -- --from-env-file <export> --legacy-forward-panel` → sem BLOCK.
- [ ] **Deploy.** Mudanças que entram:
  - endpoints de contexto (aditivos);
  - jobs com lease (`job_leases`);
  - **a rota `/api/webhooks/ink` deixa de existir.**
- [ ] **OPS-34 — imediatamente depois:**
  1. gerar a URL opaca na tela (mostrada uma vez);
  2. cadastrar o segredo que a Ink mostra;
  3. trocar a URL no cadastro de webhook da Reserva Ink;
  4. validar um evento real.

  Entre o deploy e a troca, eventos na URL antiga dão 404. Os pedidos são recuperados pelos jobs de
  reconciliação/sincronização; carrinhos abandonados desse intervalo não disparam. [EVIDÊNCIA]

**VERIFY D0**

- [ ] **Ink:**
  - evento real na URL nova;
  - URL desconhecida → 404;
  - assinatura errada → 401.
- [ ] **Boot:** sem erro de lease; cada job roda uma vez por intervalo.
- [ ] **Repasse:** status de campanha reais continuam avançando (o Go 5b manda a query; o D0 aceita);
  nenhum 401 no repasse.

---

## 11. RELEASE E — Go R2 da 5c, assinando junto com a query legada

**Pré-requisitos:** D0 observado; OPS-31 (WABA interna em `subscribed_apps`, `waba_id` importado);
backup do banco do Go.

- [ ] **OPS-32** — `LEGACY_ORGANIZATION_ID=<ORGANIZATION_ID_USE_ORIGENS>`. Sem ele, com linhas antigas, a
  migration 2 falha e o boot aborta. [EVIDÊNCIA]
- [ ] **OPS-30** de novo, se houver itens antigos.
- [ ] **OPS-33** — o extrator (`extrator-pedidos-web`) passa a mandar `X-Sender-Phone-Number-Id` +
  `X-Sender-Ref`.
  - Valores: `npm run integrations:whatsapp-referencia -- --organization <uuid>`.
  - Sem eles, `/problems/*` responde 400. [EVIDÊNCIA]
- [ ] **OPS-09 parte 1** — no ambiente do Go, **antes** do deploy:
  - `WEBHOOK_FORWARD_SECRET` = valor **novo** (≥ 32, diferente do legado);
  - `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1`;
  - `WEBHOOK_FORWARD_URL` **inalterada** (com `?secret=<legado>`).
  - Caso "hoje sem segredo": URL limpa, sem a flag. O painel antigo aceita tudo, e o buraco fecha no D'.
- [ ] **Preflight:** `release:preflight -- --service go` → sem BLOCK. Esperado: WARN da flag e da URL com query.
- [ ] **Deploy** do Go no HEAD da productização. As migrations 2 e 3 (`webhook_inbox`) rodam no boot,
  com advisory lock.

**VERIFY E**

- [ ] **Boot:**
  - `forward=true forward_legacy_query=true`;
  - aviso `TRANSIÇÃO`;
  - `sig_verify=true`;
  - nenhum `[forward] ... inválida`.
- [ ] **Entrada:** mensagem real → evento no painel da Use Origens + auto-resposta; `failed` → retry na
  fila certa; `/dashboard/events` por Organization; WABA desconhecida → descartada.
- [ ] **Repasse:** status avança no D0; `SELECT status, count(*) FROM webhook_inbox GROUP BY 1` esvazia,
  sem `failed`; nenhum `repasse: painel respondeu`.
- [ ] **Hardening R18:**
  - `/dashboard`, `/problems` e `/automaticos` → 410;
  - cache de contexto de 30 s: uma troca de número na tela vale para a entrada em ≤ 30 s.
- [ ] **Aceite durável:** num restart planejado do Go durante tráfego, os eventos aceitos (200) são
  processados depois do boot, sem duplicar (log do worker da inbox).
- [ ] **Leases do Go:** com duas réplicas, cada item da fila sai uma vez.
- [ ] **OPS-35 parte 2:** `REPLY_*` ignoradas com aviso.
- [ ] **Observar um ciclo real antes da D'.**

---

## 12. RELEASE D' — painel HEAD, aceita pela assinatura (tolerando a query)

**Pré-requisito:** VERIFY E ok, com o Go no ar mostrando `forward_legacy_query=true`. **Nunca publicar
D' com o Go 5b no ar.**

- [ ] **Ambiente do painel, no mesmo deploy:**
  - `WHATSAPP_WEBHOOK_SECRET` = o **mesmo valor novo** do Go. Desde a rodada 19, o HEAD **não sobe**
    sem ≥ 32 em produção.
  - `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1`.
  - **Guardar o valor legado** até o CLEANUP: o rollback do D' precisa dele.
  - `SECOND_TENANT_ENABLED` ausente/`0`/`false` (o preflight bloqueia se estiver ligada).
- [ ] **Preflight:** `release:preflight -- --from-env-file <export>` (sem `--legacy-forward-panel`) → sem BLOCK.
  - WARN esperados: tolerância, `CREATIVE_LEGACY_READ_*` (§13.2), flags legadas da release N,
    `INK_*` e `WHATSAPP_LEGACY_*`. A lista antiga igual ao perfil dá OK neste estágio.
- [ ] **PRE-DEPLOY** com o bloco do §8.2, agora com o código do HEAD:
  - o seed usa o perfil, e o esperado é `<org>: nada mudou`;
  - se o import do WhatsApp rodar de novo, usar
    `--organization <org> --waba-id <WABA_ID> --phone-number-id <PHONE_NUMBER_ID>`.
- [ ] **Deploy.**

**VERIFY D'**

- [ ] **Boot:**
  - `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1 — TRANSIÇÃO`;
  - nenhum `WHATSAPP_WEBHOOK_SECRET ausente/curto`.
- [ ] **Repasse:**
  - no primeiro status real: `repasse com a query legada aceito pela assinatura`;
  - status avançando e inbox do Go esvaziando;
  - **nenhum** `repasse recusado`.
- [ ] **Verify do HEAD:**

  ```bash
  npm run tenant1:verify -- --scenario B --mapping config/tenant1/rollout-scenario-b.json --uploads $UPLOADS_DIR --rollout
  ```

  - Sem `--estagio` → só PASS/INFO.
  - INFO esperados até a F: `role.app`; até o §13.2: `creatives.materializacao`
    (`creatives.arquivos` PASS "vinculado").
  - A posse `waba` fica na mesma Organization do número.
  - `ink.webhook[<org>]` = PASS (depois da emissão no D0).
  - [EVIDÊNCIA]

---

## 13. Passos de ambiente depois da D'

### 13.1 Go deixa de mandar a query (OPS-09 parte 3)

- [ ] **Pré-requisito:** VERIFY D' ok.
- [ ] **No Go:** `WEBHOOK_FORWARD_URL` **sem** `?secret=`; remover `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET`;
  redeploy de **todas** as réplicas.
- [ ] **Preflight:** `release:preflight -- --service go` → sem BLOCK e sem WARN da flag.

**VERIFY**

- [ ] Boot com `forward_legacy_query=false`.
- [ ] Status avançando; inbox esvaziando; nenhum `repasse recusado`.

### 13.2 OPS-22 passo 2 — materialização dos criativos (com a leitura dupla)

- [ ] **Na D' (ou na release seguinte do HEAD):** configurar `CREATIVE_LEGACY_READ_FROM=<LEGADO>` e
  `CREATIVE_LEGACY_READ_ORGANIZATION_ID=<ORG>`.
  - Boot: `OPS-22: leitura legada LIGADA`.
  - Preflight: WARN.
- [ ] **Conferir o estado vinculado:**
  `npm run tenancy:mover-criativos -- --uploads $UPLOADS_DIR --de <LEGADO> --para <ORG> --verificar`
  → `estado: vinculado` · `criativos: PASS-VINCULADO`.
- [ ] **[SEM VOLTA]** Depois do próximo passo, uma versão **anterior à B** não vê mais os arquivos. Só
  seguir quando o rollback para antes da B estiver fora do plano.
- [ ] **Materializar:** `… --desvincular --aplicar` → "vínculo removido" e "N movido(s)". É idempotente.
- [ ] **Conferir:** `… --verificar` → `estado: separado` · `criativos: PASS`. [EVIDÊNCIA OPS-22: as linhas de contagem]
- [ ] **Painel:** os criativos antigos continuam carregando.
- [ ] **Na release seguinte:** remover `CREATIVE_LEGACY_READ_*`. O preflight `cleanup` bloqueia se ficarem.

---

## 14. RELEASE F — OPS-14 (role da aplicação)

**Pré-requisitos:**

- D' estável;
- `npm run test:app-role` verde no commit em produção;
- funções `SECURITY DEFINER` com dono BYPASSRLS (a role dona das migrations; no Railway, `postgres`).

| variável | antes da F (A…D', §13) | a partir da F |
|---|---|---|
| `DATABASE_URL` | role dona (`postgres`), usada pela app **e** pelo pre-deploy | **`oria_app`**, só a app |
| `MIGRATION_DATABASE_URL` | ausente (o preflight mostra INFO) | role dona; usada **só** no pre-deploy |
| `DB_ENFORCE_APP_ROLE` | ausente | `1` |

- [ ] **Antes da F, fechar as alavancas da release N** (um redeploy só de ambiente):
  - `ALLOW_LEGACY_INTEGRATION_ENV` removida (ou `0`);
  - `ALLOW_LEGACY_ADMIN_PASSWORD` removida (ou `0`), se estava ligada.

  As variáveis de dado (`INK_*`, `ADMIN_PASSWORD`, `LEGACY_ADMIN_USER_EMAIL`) ficam até o §15.2.
  Motivo: o `release:preflight --stage after-ops14` só permite essas flags em `release-n`. A partir
  daqui, o rollback de nível 1 (Ink lida do ambiente, login legado) deixa de existir; a volta para
  antes da B já saiu do plano no §13.2.
- [ ] **Leases do painel:** com mais de uma réplica, ou num restart, cada job roda uma vez por intervalo;
  lease indisponível aparece no log. Registrar no relatório.
- [ ] **Criar `oria_app`** com o SQL de `lib/platform/app-role.js`:
  - `NOSUPERUSER NOBYPASSRLS NOINHERIT`;
  - DML só nas tabelas sob RLS e nas globais da aplicação;
  - senha gerada fora do repositório.
- [ ] **`MIGRATION_DATABASE_URL`** = URL da role dona.
- [ ] **Pre-deploy passa a ser:**

  ```bash
  export DATABASE_URL="$MIGRATION_DATABASE_URL" && <bloco do §8.2 a partir de printf>
  ```

  Os scripts só leem `DATABASE_URL`: sem essa troca, eles rodariam como `oria_app` e falhariam.
- [ ] **RELEASE F:** `DATABASE_URL` do app → `oria_app` e `DB_ENFORCE_APP_ROLE=1`.

**VERIFY F**

- [ ] Boot: `role da aplicação oria_app verificada: sem SUPERUSER, sem BYPASSRLS, não dona`. Se falhar,
  o boot sai com erro e a versão anterior continua no ar.
- [ ] `release:preflight --stage after-ops14` com banco:
  - role do app OK;
  - usuário de migration distinto;
  - WARN para remover `ENTITLEMENTS_SEED_FEATURES`.
- [ ] Repetir por amostragem: login, listas, webhooks (Ink e repasse), envio e criativos.
- [ ] `DATABASE_URL=$MIGRATION_DATABASE_URL DB_ENFORCE_APP_ROLE=1 npm run tenant1:verify -- … --rollout --app-role oria_app`
  → `role.app` PASS. Sem `DB_ENFORCE_APP_ROLE=1`, o item sai INFO e não vale como evidência.
  [EVIDÊNCIA OPS-14 — referência do dogfood]

---

## 15. CLEANUP e rotação do `ADMIN_SESSION_SECRET`

Só depois de VERIFY F e de um período sem rollback. Cada item é uma release própria ou um lote explícito.

### 15.1 Transições

- [ ] **OPS-09 parte 3b** — painel: remover `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED`; redeploy.
  Depois, apagar o valor legado do repasse do cofre do operador (ele esteve em URL).
- [ ] **OPS-22** — `CREATIVE_LEGACY_READ_*` já removidas (§13.2); então remover `CREATIVE_TENANT_ID`.
- [ ] **OPS-21** — remover `ENTITLEMENTS_SEED_FEATURES` (o perfil fica).

### 15.2 Legado

- [ ] **OPS-19** — todo owner entrou com a conta individual → remover `ADMIN_PASSWORD` e
  `LEGACY_ADMIN_USER_EMAIL` (a flag saiu antes da F). [EVIDÊNCIA]
- [ ] **OPS-24** — `ALLOW_LEGACY_INTEGRATION_ENV` já desligada antes da F.
  - Rodar `npm run integrations:import-legacy -- --aplicar --limpar-colunas-legadas` (role de migration).
  - Remover `INK_TOKEN_*`, `INK_FEED_URL_*` e `GOOGLE_ADS_EM_USO`. [EVIDÊNCIA]
- [ ] **OPS-34 parte 2** — remover `INK_WEBHOOK_SECRET_*` (a D0 não volta mais para antes).
- [ ] **OPS-32 parte 2** — remover `LEGACY_ORGANIZATION_ID` do Go. [EVIDÊNCIA]
- [ ] **OPS-35 parte 2** — remover `REPLY_*` do Go. [EVIDÊNCIA]
- [ ] **5b Release D** — remover `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN` e `META_WABA_ID` do Go
  (a C não volta mais).
- [ ] **OPS-29 parte 2** — remover `WHATSAPP_LEGACY_*` do painel.

### 15.3 Rotação do `ADMIN_SESSION_SECRET` (último passo; OPS-25 parte 2 + OPS-36)

Nunca rotacionar enquanto qualquer ciphertext depender dele.

1. [ ] O `ADMIN_SESSION_SECRET` atual continua o mesmo desde o início (§5.4).
2. [ ] Todos os segredos persistidos já foram importados/re-cifrados (§8.2; repetir se algum foi
   gravado depois).
3. [ ] `npm run integrations:reencrypt` (role de migration) → 0 pendentes.
4. [ ] Provar **0 ciphertext legado**:
   - a saída do reencrypt diz `0 ainda em versão antiga`, e ele sai com 0;
   - `SELECT count(*) FROM integration_secrets WHERE key_version = 0` (role de migration) = 0;
   - as colunas legadas já foram limpas (OPS-24, §15.2).
   [EVIDÊNCIA OPS-25]
5. [ ] Remover `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY` (fim do OPS-13); redeploy.
6. [ ] Rodar o smoke (login, integrações `…/teste`, envio, webhooks) e `npm run test:app-role` no commit em
   produção → verdes.
7. [ ] **Só então** gerar um `ADMIN_SESSION_SECRET` novo (≥ 32, fora do repositório) e fazer o redeploy.
8. [ ] **Efeito esperado:** todas as sessões caem; cada owner entra de novo. Integrações continuam
   legíveis, porque dependem só da `ENCRYPTION_MASTER_KEY`. [EVIDÊNCIA OPS-36 — referência do dogfood]

- [ ] `release:preflight --stage cleanup` (painel e Go) → sem BLOCK.
- [ ] `npm run productization:gate` → exit 2, com todos os OPS VERIFIED/N.A. e só `DOGFOOD NOT STARTED`.

---

## 16. ROLLBACK

**Regras gerais**

- **Backup testado (OPS-04)** antes de cada release.
- **Ordem inversa** das releases.
- **Repasse:** a ordem inversa é `CLEANUP → Go sem query → D' → E → D0`.
- **Par D'/E:** entre D' e E, o **painel volta antes** do Go (a D0 também tem os endpoints de contexto).
  Fora desse par, o Go volta antes do painel.

| passo | como voltar | cuidado |
|---|---|---|
| A | Go para o commit anterior | As `META_*` ficam até o CLEANUP |
| §7 vínculo | `rm` do link (só antes da B) | — |
| B | versão anterior da app | Um só diretório físico de criativos, nada a fazer com arquivos. O import **copia** (colunas antigas intactas). A migration `1789900000000` tem down. A Fase 1 volta por migration reversa. Baseline e `creative-core-schema` são irreversíveis por desenho |
| C | **conjunto, ordem inversa:** painel P3 → P2, depois Go G4 → G2 | Nunca só o painel para antes de P2 com o Go em G3. Nunca só o Go para antes de G2 com itens novos na fila |
| D0 | versão anterior (C) | Voltar a URL antiga no cadastro da Ink **e** manter `INK_WEBHOOK_SECRET_*`. `migrate:down` só se necessário (aditivas). Repasse: as duas autenticam pela query |
| E | **com o painel em D0:** esperar `webhook_inbox` sem pendentes → SQL de `whatsapp-inbound-5c.md` §7 → Go 5b | SQL seguro só com uma Organization no banco do Go |
| D' | **um único deploy** com o commit D0 **e** `WHATSAPP_WEBHOOK_SECRET` = valor **legado** | Esquecer o legado = 401. O Go R2 tenta de novo por cerca de 4 min |
| §13.1 Go sem query | recolocar `?secret=<legado>` e a flag `1` | Fazer **antes** de voltar D' → D0 |
| §13.2 materialização | para releases com leitura dupla, B, C ou D0: nada a fazer | **Para antes da B:** não suportado sem `cp -an tenant/<ORG>/. tenant/<LEGADO>/` [SEM VOLTA] |
| F | `DATABASE_URL` → role anterior; remover `DB_ENFORCE_APP_ROLE`; pre-deploy sem o `export` | Com a role errada, o boot falha e a versão anterior continua no ar. As flags da release N não voltam junto (o preflight `release-n` as aceitaria, mas a D' não precisa delas) |
| CLEANUP | religar a variável/flag removida | Só enquanto o código legado existir |
| §15.3 rotação | **não há volta** ao segredo anterior depois das sessões novas; em caso de falha, gerar outro e repetir o passo 7 | Integrações não dependem dele depois do passo 5 |

---

## 17. Divergências resolvidas

1. **OPS-27 antes de tudo.** O §31 da rodada 18 listava o OPS-27 depois da configuração do remetente.
   A rodada 19 fecha isso: nenhuma release da productização antes do OPS-27, nem "só migrations"
   (decisão D3).
2. **Ink logo depois do R1.** A D0 remove a rota legada da Ink, e o Go R2 depende dos endpoints da D0.
3. **Painel em quatro commits (P2 → P3 → D0 → D').** A D' existe para que nenhum status se perca:
   - o painel antigo só aceita a query;
   - a D' exige assinatura;
   - o Go novo manda as duas durante a transição.

   A alternativa de um Go 5b com assinatura (backport) foi descartada, porque exigiria uma branch de
   release fora do histórico linear.
4. **B e C nunca juntas** (decisão D6).
5. **Leases** não têm OPS próprio: são verificação da D0/E e da F.
6. **OPS-06/07/08** estão VERIFIED no progresso da rodada 8, mas sem evidência no formato de §2.
7. **O pre-deploy da B roda o código da B.** Por isso:
   - seed pela lista igual ao perfil;
   - mapeamento entregue por variável;
   - par do WhatsApp conferido pelo HEAD antes e depois;
   - criativos pelo vínculo, não pelo mover.
8. **Flags da release N saem antes da F** (dry-run da rodada 19): o preflight `after-ops14` só as
   permite em `release-n`.
9. **OPS-36 é novo** (rodada 19): a rotação final do `ADMIN_SESSION_SECRET` ganhou evidência própria e
   é referência do dogfood junto com o OPS-14.

---

## 18. Dogfood, SECOND TENANT GATE e onboarding

- [ ] **Dogfood:** criar `DOGFOOD.json` (formato de §2) com `dogfood_started_at` = o instante em que a
  operação interna passa a rodar como Organization normal, sem bypass.
  - Só **depois** de `OPS-14.json` e `OPS-36.json` VERIFIED.
  - Até 14 dias pelo relógio: `IN PROGRESS`.
  - Incidente aberto: atualizar `open_incidents`, o que bloqueia o fechamento.
- [ ] **SECOND TENANT GATE:** `npm run productization:gate` → **exit 0 (OVERALL READY)** é a condição
  técnica. É o único caso de exit 0 do gate. A Fase 6 só fecha com isso **e** com a decisão do usuário.
  `--report-only` nunca serve de evidência.
- [ ] **OPS-31 por cliente:** inscrever o App da plataforma na WABA do cliente antes de cadastrar o número.
- [ ] **Onboarding** (construído, não exposto): só depois do gate exit 0 **e** de decisão explícita.
  Antes de ligar `SECOND_TENANT_ENABLED`:
  - `ONBOARDING_STEP_REQUIREMENTS` (PD-005/011/012);
  - provedor de e-mail do convite;
  - rotas/UI pelo serviço `lib/platform/onboarding.js`.

---

## 19. Matriz OPS → passo

| OPS | passo | quando |
|---|---|---|
| 01-05 | 5.2 | antes de tudo |
| 06-08 | 5.2 | antes de tudo (re-registrar) |
| 09 | 5.4 / 11 / 12 / 13.1 / 15.1 | estado atual antes; segredo novo + flag no Go (E); segredo novo + tolerância no painel (D'); Go sem query; fim da tolerância |
| 10 | 5.1 | junto com OPS-27 (absorvido) |
| 11 | 8.2 / 10 / 12 | pre-deploy B, D0 e D' |
| 12, 13, 15 | 5.4 | antes de B |
| 14 | 14 / 18 | RELEASE F; referência do dogfood |
| 16 | 5.3 / 5.4 / 8.2 | arquivos, variável, pre-deploy B |
| 17 | 8.1 | antes de B, se aplicável |
| 18, 21, 23 | 5.4 / 8.2 | pre-deploy B (21: perfil; lista removida no 15.1) |
| 19 | 5.4 / 14 / 15.2 | release N / flag desligada antes da F / variáveis na N+1 |
| 20 | 5.4 / 15.3 | manter o atual; rotação por último |
| 22 | 7 / 13.2 / 15.1 | vínculo antes de B; materialização depois de D'; limpeza |
| 24 | 5.4 / 14 / 15.2 | release N / flag desligada antes da F / limpeza na N+1 |
| 25 | 8.2 / 15.3 | pre-deploy B / prova de 0 legado antes da rotação |
| 26 | 8.4 / 9 | depois de B e de C |
| 27 | 5.1 | gate zero |
| 28 | 5.4 / 5.5 | antes de A e B |
| 29 | 5.4 / 8.2 / 15.2 | insumo, pre-deploy B, limpeza |
| 30 | 9 / 11 | antes de C (e de E) |
| 31 | 11 / 18 | antes de E (WABA interna) e por cliente |
| 32 | 11 / 15.2 | E / limpeza |
| 33 | 11 | com E |
| 34 | 10 / 15.2 | logo após D0 / limpeza |
| 35 | 5.5 / 11 / 15.2 | antes de A / E / limpeza |
| 36 | 15.3 / 18 | rotação final; referência do dogfood |
