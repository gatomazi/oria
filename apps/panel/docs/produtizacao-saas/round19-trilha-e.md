# Rodada 19 · Trilha E — releases do repasse assinado sem perda de status (§5)

**Repositórios:**

- painel: base `883e157`;
- `whatsapp-webhook-go`: base `23528ae`.

**Limites:** trabalho local, em worktrees destacados. Sem push, sem deploy, sem Railway, sem banco de produção, sem segredo real. **OPS-27 continua NOT VERIFIED.**

**Decisão aplicada:** não aceitar perda deliberada de status. A ordem preferida ("Go aditivo começa a assinar → observar → painel passa a exigir a assinatura") é possível e está provada por teste de contrato **executável**, com processos reais dos dois lados.

---

## 1. O problema, medido

| painel | Go | resultado |
|---|---|---|
| antigo (produção hoje; 5c R1 até `c706da1^`): autentica só por `req.query.secret === WHATSAPP_WEBHOOK_SECRET`, ignora headers | novo (`23528ae`), URL limpa + assinatura | **401**, status parado (teste "o problema original") |
| novo (`883e157`): exige a assinatura e recusa `?secret=` mesmo assinado | 5b (`31b4bc9`), só a query | **401**, status parado |
| novo | novo, URL com `?secret=` | não sobe em produção (boot aborta); fora de produção, repasse desligado |

Há uma restrição extra: o Go R2 (5c) depende dos endpoints de contexto do painel R1. Por isso o Go assinado não pode ir para produção antes de um painel com esses endpoints.

A saída é dividir o R1 do painel:

- **D0:** o R1 **antes** do endurecimento do repasse. Tem os endpoints de contexto e ainda autentica pela query.
- **D':** o HEAD.

Nenhum commit novo é necessário para o D0:

- `c706da1` (endurecimento do repasse) é um commit isolado. O teste confere que a rota em `c706da1^` (= `8c024d2`) é idêntica byte a byte à de `bfd00a6`, a versão testada como painel antigo.
- De `8c024d2` até `883e157` só entram testes, gate, preflight e docs, além do próprio `c706da1`.

## 2. Mudança (aditiva, as duas flags desligadas por padrão)

| flag | serviço | `1` | ausente / `0` | outro valor |
|---|---|---|---|---|
| `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET` | Go (`forward.go`, `main.go`) | aceita a URL legada com **exatamente** `?secret=<valor não vazio>` e cada repasse leva a query **e** `X-Oria-Forward-*`, com o mesmo corpo | rodada 18: URL com query recusada | erro; em produção, o boot aborta |
| `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED` | painel (`lib/platform/whatsapp-forward.js`, `server.js`) | `secret` na query é **ignorado** (nem lido, nem comparado) se a assinatura for válida | rodada 18: 401 mesmo assinado | o boot falha |

**Garantias:**

- **A query nunca autentica no painel novo.** Com a tolerância, continuam dando 401:
  - query sem headers;
  - query igual ao segredo, sem assinatura;
  - assinatura de outro segredo;
  - corpo alterado;
  - timestamp fora da janela.

  Os três controles negativos abaixo cobrem essas recusas.
- **Com a flag, o Go continua exigindo o resto:**
  - https em produção;
  - `WEBHOOK_FORWARD_SECRET` ≥ 32;
  - sem credencial nem fragmento;
  - nenhum outro parâmetro, nem `secret` repetido ou vazio.

  Recusa também **query = segredo da assinatura**: o segredo da assinatura é um valor novo, porque o da query já esteve em URL.
- **Nenhum segredo em log ou erro.** Nenhuma mensagem mostra a URL, a query ou o segredo.
  - O aviso de boot do Go diz "parâmetro secret", sem `secret=`.
  - O painel avisa uma vez por processo quando aceita um repasse com a query legada.
- **Sinais no boot:**
  - Go: `forward_legacy_query=true|false` e `AVISO env=<env>: WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1 — TRANSIÇÃO`.
  - Painel: `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1 — TRANSIÇÃO`.
- **Contrato `forward-auth-v1.json`:** ganhou o bloco `legacy_query_transition`, com as duas cópias idênticas (o gate compara as duas byte a byte).
  - O formato de fio e a semântica sem flags não mudaram, então `version` continua 1 e `CONTRATOS_GO` fica inalterado.
  - Um consumidor v1 que ignore o bloco se comporta como na rodada 18.
- **Preflight (`scripts/release/preflight.mjs`):**
  - As duas flags têm WARN em `release-n`/`after-ops14` e **BLOCK em `cleanup`**. Valor diferente de `1`/`0` também dá BLOCK.
  - No Go, com a flag e fora do cleanup, a URL legada atende (só `secret`, diferente de `WEBHOOK_FORWARD_SECRET`). Um WARN extra diz se a URL ainda leva a query.
  - Nova opção `--legacy-forward-panel`, para o **D0**: `WHATSAPP_WEBHOOK_SECRET` vale com qualquer tamanho, porque é o valor legado comparado pela query.
    - Ausente dá WARN, porque o D0 sem segredo aceita tudo, como a versão anterior.
    - A opção só vale para o painel e fora do cleanup (senão, exit 64).

### Alternativa descartada

**Backport da assinatura para o Go 5b.** Seria um commit sobre `31b4bc9`, publicado antes do R1.

- Também funciona, mas exige uma linha de release fora do histórico linear (branch nova).
- Deixa o Go R2 sem a proteção de flag no rollback.

A divisão D0/D' usa apenas commits que já existem.

## 3. Provas executáveis

**Painel, `test/invariants/r19-contrato-repasse-transicao.test.js`** (processos reais, 9 testes):

- **Painel antigo:** `git archive bfd00a6` em `os.tmpdir()`.
  - `node_modules` vem por symlink.
  - Usa o schema das migrations **daquele** commit, sob a role da aplicação daquele commit, com `DB_ENFORCE_APP_ROLE=1`.
  - `WHATSAPP_WEBHOOK_SECRET` é um valor legado curto.
- **Painel novo:** o `server.js` deste checkout.
- **Go:**
  - binário compilado de `WHATSAPP_GO_DIR`;
  - binário **mutante**: a mesma fonte com `u.RawQuery = ""` no caminho da flag.
- **Prova pelo efeito:**
  1. Um status entra no Go como webhook assinado da Meta.
  2. O Go resolve a Organization no painel e repassa.
  3. `campaign_recipients.status` avança e `webhook_inbox` esvazia.
- **Recusa:** o Go registra `painel respondeu 401`, o status fica `sent` e a linha fica pendente na inbox.

| cenário | resultado |
|---|---|
| a árvore antiga autentica só pela query; a rota é idêntica em `c706da1^` (candidato D0) | ✔ |
| **passo 1:** Go com a flag + URL legada → painel antigo | `delivered` e depois `read` aplicados; aviso de transição no boot; nenhum segredo em log |
| **controle negativo:** Go mutante (flag sem query) → painel antigo | 401, status parado |
| o problema original: Go sem a flag, URL limpa → painel antigo | 401, status parado |
| Go sem a flag com URL legada (fora de produção) | repasse desligado com aviso (o aborto em produção está no teste do Go) |
| **passo 2:** Go com a flag → painel novo com tolerância; **passo 3:** Go sem query → mesmo painel | aplicados; um único aviso "aceito pela assinatura"; nenhum `repasse recusado` |
| painel novo sem tolerância: Go com a flag → 401 com "segredo na query string recusado"; Go sem a flag → aplica | rodada 18 preservada |
| painel novo com tolerância: query legada sem headers / query = segredo novo sem headers / assinatura com o segredo legado | 401, status parado |
| painel novo com `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=true` | não sobe (exit ≠ 0), sem segredo na saída |

**Painel, `test/invariants/r19-whatsapp-forward-transicao.test.js`** (unidade + contrato):

- valores da flag;
- bloco do contrato igual ao código e à cópia do Go;
- query tolerada só com assinatura válida;
- 8 formas de recusa, sem valor sensível no motivo;
- sem tolerância (ou com valor não booleano), 401.

**Painel, `release-preflight.test.js`** — dois testes novos (rodada 19):

- flags por estágio;
- URL legada só com a flag e fora do cleanup;
- outra query, credencial, http ou query = segredo continuam dando BLOCK;
- `--legacy-forward-panel`;
- nenhum valor na saída.

**Go, `forward_transition_test.go`** (12 testes):

- flag só `1`/`0`/ausente;
- URL legada recusada sem a flag e aceita inalterada com ela;
- 8 formas de URL recusadas mesmo com a flag, sem ecoar valores;
- https e segredo continuam exigidos;
- query = segredo recusada;
- com a flag, query **e** assinatura válidas no mesmo repasse, com o mesmo corpo e o mesmo content-type;
- 401 ou painel fora: erro e log sem segredo;
- produção com a flag sobe com aviso e sem segredo na saída (processo filho);
- valor inválido aborta o boot (processo filho);
- flag sem query avisa para desligar;
- contrato igual ao código.

### Controles negativos

**Painel** — `negative-controls.test.js`, ciclo de 5 passos, classe nova `R19-5`:

| classe | violação | teste que reprova |
|---|---|---|
| `whatsapp/tolerancia-sem-assinatura` | na transição, a query basta | `r19-whatsapp-forward-transicao.test.js` |
| `whatsapp/tolerancia-compara-query` | na transição, a query igual ao segredo autentica | idem |
| `whatsapp/tolerancia-sem-flag` | tolera sem a flag explícita | idem |

**Contrato com processos reais:** o binário mutante do Go roda dentro do próprio teste de contrato. É a prova de que o teste contra o painel antigo reprova um Go que deixa de mandar a query.

**Verificados à mão** (cópia da fonte, mesmos testes; não ficam na suíte):

| repositório | violação | resultado |
|---|---|---|
| Go | `u.RawQuery = ""` | 3 testes reprovam |
| Go | URL legada aceita sem a flag | 1 teste reprova |
| preflight | flag do Go permitida em `cleanup` | o teste da rodada 19 reprova |
| preflight | URL legada aceita em `cleanup` | o teste da rodada 19 reprova |

## 4. Texto para o runbook

**Substitui, no `production-rollout-runbook.md`:**

- o marcador **[DECISÃO]** da RELEASE D sobre a janela D→E;
- o OPS-09 da RELEASE E;
- a linha E do §12;
- o item "janela D→E" do §16.

A RELEASE D passa a ser **D0**, e entram dois passos de ambiente e uma RELEASE **D'** depois da E.

> **Pré-requisito comum:** saber, sem imprimir, se o `WHATSAPP_WEBHOOK_SECRET` do painel em produção está definido e se a `WEBHOOK_FORWARD_URL` do Go tem `?secret=`, pelo nome das variáveis e pelo `release:preflight`. O caminho abaixo cobre o caso "definido + URL com query". Se hoje **não houver** segredo, o painel aceita tudo. Nesse caso, pule a flag do Go (E com URL limpa) e siga D' → CLEANUP. O buraco fecha no D'.

### RELEASE D0 — painel R1 da 5c, repasse ainda pela query

- [ ] **Commit:** `c706da1^` (`8c024d2` no histórico atual), ou outro commit aprovado que ainda não contenha `c706da1`.
  - A rota `/api/webhooks/whatsapp` precisa ser a de `bfd00a6`. O teste `r19-contrato-repasse-transicao` confere isso.
- [ ] **PRE-DEPLOY** como na RELEASE D atual (`migrate:up` com as migrations `1790000000000`, `1790000060000`, `1790000120000` e `1790000300000`).
- [ ] **Ambiente:**
  - `WHATSAPP_WEBHOOK_SECRET` **inalterado** (valor legado);
  - **não** definir o valor novo aqui.
- [ ] **Preflight:** `npm run release:preflight -- --from-env-file <export do painel> --legacy-forward-panel` sem BLOCK.
  - O `WHATSAPP_WEBHOOK_SECRET` legado curto é aceito só nesse modo.
- [ ] **Deploy.** Logo depois, o OPS-34 (Ink), como já está no runbook.

**VERIFY D0** (o de D atual, mais):

- [ ] status de campanha de um envio real continuam avançando (o Go 5b manda a query; o D0 aceita);
- [ ] nenhum 401 no repasse (log do proxy / Go 5b).

**Rollback D0:** o da RELEASE D atual. O repasse não muda: as duas versões autenticam pela query.

### RELEASE E — Go R2, assinando junto com a query legada

- [ ] **Pré-requisitos:** os da RELEASE E atual (OPS-31, OPS-32, OPS-30, OPS-33) e D0 observado.
- [ ] **OPS-09 (parte 1)** — no ambiente do Go, **antes** do deploy:
  - `WEBHOOK_FORWARD_SECRET` = valor **NOVO**, gerado fora do repositório, com ≥ 32 caracteres e **diferente** do legado;
  - `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1`;
  - `WEBHOOK_FORWARD_URL` **inalterada** (continua com `?secret=<legado>`).
- [ ] **Preflight:** `npm run release:preflight -- --service go --from-env-file <export do Go>` sem BLOCK.
  - Esperados: WARN na flag e WARN "a URL ainda leva a query legada".
- [ ] **Deploy.** As migrations 2 e 3 rodam no boot, como já está no runbook.

**VERIFY E** (o atual, mais):

- [ ] **Boot do Go:**
  - `forward=true  forward_legacy_query=true`;
  - `[forward] AVISO env=production: WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1 — TRANSIÇÃO`;
  - nenhum `[forward] ... inválida`.
- [ ] **Status real:**
  - avança no painel D0;
  - `SELECT status, count(*) FROM webhook_inbox GROUP BY 1` esvazia, sem `failed`;
  - nenhum `repasse: painel respondeu` no log do Go.
- [ ] **Observar um ciclo real** antes do D'.

**Rollback E**, com o painel ainda em D0 (sem perda):

1. esperar `SELECT count(*) FROM webhook_inbox WHERE status <> 'failed'` = 0;
2. rodar o SQL de whatsapp-inbound-5c §7;
3. voltar o código do Go 5b;
4. o 5b manda a query, e o D0 aceita.

### RELEASE D' — painel HEAD, aceita pela assinatura (tolerando a query)

- [ ] **Pré-requisito:** VERIFY E ok, com o Go no ar mostrando `forward_legacy_query=true`.
  - **Nunca publicar D' com o Go 5b no ar:** o 5b não assina, e o D' recusaria.
- [ ] **Ambiente do painel, no mesmo deploy:**
  - `WHATSAPP_WEBHOOK_SECRET` = o **mesmo valor NOVO** do `WEBHOOK_FORWARD_SECRET` do Go;
  - `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1`.
  - **Guardar o valor legado** até o CLEANUP: o rollback do D' precisa dele.
- [ ] **Preflight:** `npm run release:preflight -- --from-env-file <export do painel>` (sem `--legacy-forward-panel`) sem BLOCK.
  - Esperado: WARN em `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED`.
- [ ] **PRE-DEPLOY:** `migrate:up` para as migrations que o HEAD tiver a mais que o D0.
- [ ] **Deploy.**

**VERIFY D'**

- [ ] Boot do painel: `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1 — TRANSIÇÃO`.
- [ ] No primeiro status real: `repasse com a query legada aceito pela assinatura (transição; aviso único por processo)`.
- [ ] Status avançando; inbox do Go esvaziando; **nenhum** `repasse recusado` no log do painel; nenhum `repasse: painel respondeu` no log do Go.

**Rollback D' → D0** (sem perda; o Go ainda manda a query):

- **um único deploy** com o commit D0 **e** `WHATSAPP_WEBHOOK_SECRET` de volta ao valor **legado**.
- Esquecer o segredo legado = 401 em todo status. O Go R2 tenta de novo por cerca de 4 min (8 tentativas); corrigir dentro desse prazo não perde o evento.

### Passo de ambiente — Go deixa de mandar a query

- [ ] **Pré-requisito:** VERIFY D' ok.
- [ ] **No Go:**
  - `WEBHOOK_FORWARD_URL` **sem** `?secret=`;
  - remover `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET` (ou `0`);
  - redeploy.
- [ ] **Preflight:** `release:preflight -- --service go` sem BLOCK e sem WARN da flag.

**VERIFY**

- [ ] Boot do Go: `forward_legacy_query=false`, sem `AVISO ... TRANSIÇÃO`.
- [ ] Todas as réplicas reiniciadas.
- [ ] Status avançando; inbox esvaziando; nenhum `repasse recusado`.

**Rollback:** recolocar a URL com `?secret=<legado>` e a flag `1`. O D' aceita os dois formatos, então não há janela.

- **Antes de voltar o painel de D' para D0, faça este rollback primeiro.** O D0 precisa da query.

### CLEANUP — painel deixa de tolerar a query

- [ ] **Pré-requisito:** passo anterior verificado e sem rollback pendente.
- [ ] **No painel:** remover `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED`; redeploy.
- [ ] **Preflight:** `release:preflight --stage cleanup` (painel e Go) sem BLOCK. As duas flags ligadas bloqueiam nesse estágio.
- [ ] **Encerrar o valor legado:** ele não é mais usado por ninguém. Apagar do cofre do operador; ele esteve em URL.

**VERIFY**

- [ ] Sem `TRANSIÇÃO` no boot do painel.
- [ ] Status avançando; nenhum `repasse recusado`.

**Rollback:** religar a flag. A partir daqui, o D0 não é mais alvo de rollback.

### Ordem de rollback (substitui a linha E do §12)

Sempre na ordem inversa dos passos:

```text
CLEANUP → passo "Go sem query" → D' → E → D0
```

- **Entre D' e E:** o painel volta **antes** do Go. O D0 também tem os endpoints de contexto, então o Go R2 funciona com ele.
- **Fora desse par:** vale a regra atual (Go antes do painel R1).

### Matriz OPS (§15)

**OPS-09** passa a ter três partes:

| parte | passo |
|---|---|
| 1 | E: segredo novo + flag no Go |
| 2 | D': segredo novo + tolerância no painel |
| 3 | passo do Go sem query + CLEANUP da tolerância |

[EVIDÊNCIA] ao fim da parte 3, sem valores: nomes das variáveis e linhas de boot.

## 5. Arquivos

**Painel:**

| arquivo | mudança |
|---|---|
| `lib/platform/whatsapp-forward.js` | `toleraQueryLegada`, `lerToleranciaQueryLegada` |
| `server.js` | flag lida perto da rota, aviso de boot e aviso único; hunk isolado, fora do bloco do `WHATSAPP_WEBHOOK_SECRET` que o §4 altera |
| `test/fixtures/whatsapp/forward-auth-v1.json` | bloco da transição |
| `scripts/release/preflight.mjs` | flags e `--legacy-forward-panel` |
| `test/invariants/r19-whatsapp-forward-transicao.test.js` | novo |
| `test/invariants/r19-contrato-repasse-transicao.test.js` | novo |
| `test/invariants/negative-controls.test.js` | 3 classes |
| `test/invariants/release-preflight.test.js` | 2 testes |
| docs | este arquivo e `whatsapp-inbound-5c.md` §2.1, §2.2, §6, §7, §8 e §9 |

**Go:**

| arquivo | mudança |
|---|---|
| `forward.go`, `main.go` | a flag |
| `testdata/forward-auth-v1.json` | cópia idêntica do contrato |
| `forward_transition_test.go` | novo |
| `docs/produtizacao-5c-inbound.md` | seção da rodada 19 |

**Não tocados:**

- `package.json`;
- listas de migrations;
- `app-role`;
- manifesto;
- `gate-lib.mjs` (`CONTRATOS_GO` inalterado: versão 1);
- `production-rollout-runbook.md`, `productization-*.md`.
