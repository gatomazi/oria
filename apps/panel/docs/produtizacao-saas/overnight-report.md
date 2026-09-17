# Overnight report — 5a + Fase 0

Execução noturna de 15→16/09/2026. Duas trilhas paralelas, dois repositórios.

**Nada foi empurrado, deployado, nem tocou Railway ou banco de produção. A Fase 1 não foi iniciada.**

---

## Resultado

| | `whatsapp-webhook-go` (5a) | painel Oria (Fase 0) |
|---|---|---|
| baseline | `bf91ff1` | `8a7ea3d` |
| HEAD | `6eb6274` | `a5bc84e` |
| commits | 16 | 5 |
| testes antes | 6 | 228 (6 pulados) |
| testes depois | **43** | **325 (0 pulados)** |
| build / vet / test / race | ✅ todos verdes | ✅ `npm run build` + 325 pass |

Verificação independente rodada após a entrega das trilhas, não apenas relatada por elas.

---

## Trilha A — `whatsapp-webhook-go`, Fase 5a

`bf91ff1` → `6eb6274`, working tree limpo.

| hash | commit |
|---|---|
| `c7dc5aa` | fix(security): require meta app secret in production |
| `79a390a` | test(security): cover production boot env requirement |
| `86bbd0d` | fix(security): never skip webhook signature check |
| `7e8ad44` | test(security): cover webhook signature fail-closed |
| `846c397` | fix(security): require api key in production |
| `b4657a1` | fix(security): close api key auth fail-open |
| `2f2b4d3` | fix(security): drop dashboard key from query string |
| `fde05b1` | test(security): add negative controls for api key auth |
| `1d253cc` | fix(security): require database url in production |
| `7bd0f27` | refactor(security): extract production boot check |
| `4bf4af4` | test(security): make accepted webhook test race-free |
| `f12ec38` | test(security): prove boot aborts without production secrets |
| `741a372` | refactor(sender): give metaPost a sender identity |
| `8a90f39` | test(sender): cover meta identity resolution |
| `ba5922d` | fix(security): compare webhook verify token in constant time |
| `6eb6274` | docs(queue): record why source wamid need not persist |

**Os cinco controles.** `META_APP_SECRET`, `API_KEY` e `DATABASE_URL` obrigatórios em produção, abortando o boot pelo `mustEnv` que **já existia no próprio repo** (`main.go:147-153`); `auth()` e `dashAuth` fail-closed com comparação em tempo constante; `?key=` removido. Bônus barato: verify token do webhook em tempo constante, e `db.go` deixou de degradar em silêncio para memória em produção.

**Produção vs dev.** `env.go` novo: `APP_ENV` → `RAILWAY_ENVIRONMENT_NAME` → `development`. Só a *exigência* dos segredos no boot é condicional; os controles em si são fail-closed nos dois ambientes.

**`metaPost`** recebe `metaIdentity{PhoneNumberID, AccessToken}` — número e credencial **juntos por construção**, para não repetir o defeito do `appId`, em que a identidade viajou e a credencial não. Os 9 call sites passam `defaultIdentity()`; o fallback de env continua valendo e o contrato com o painel está intacto. **Cutover da 5b não iniciado.**

**`SourceWamid`: backlog, não corrigido.** Retry só nasce do `retryStore`, volátil e restrito a envios do processo atual — todo item capaz de duplicar ainda tem o campo em memória; item vindo do banco nunca é candidato. Não existe hoje sequência de eventos que produza retry duplicado. Torna-se necessário quando o escopo do envio tiver de sobreviver ao restart (5b/5c). Análise registrada em comentário no campo.

---

## Trilha B — painel, Fase 0

`8a7ea3d` → `a5bc84e`.

| hash | commit |
|---|---|
| `8dfa29d` | chore(db): move schema from boot to versioned migrations |
| `c3308a5` | feat(secrets): add an encryption key of its own, versioned |
| `3cb351f` | feat(platform): add tenancy, auth and entitlement contracts |
| `14930f0` | test(platform): add invariant harness with negative controls |
| `a5bc84e` | docs(productization): add the SaaS audit, decisions and plan |

`server.js` ficou inteiro em `chore(db)` — é onde estão suas ~1.012 linhas removidas. `git add -p` é interativo e não roda neste ambiente, então o corte fino das ~40 linhas de cripto não foi feito; está sinalizado no corpo do commit.

**DDL no boot: ~1.010 linhas → 0.** O `bootstrapPostgres()` e os três `backfill*` eram migrations disfarçadas — não versionadas, não transacionais, sob um `.catch` que só logava, e com réplicas rodando todas ao mesmo tempo. O DDL foi movido **sem uma edição**, para que a baseline seja revisável como movimento puro.

**Cobertura de tenancy/auth/entitlement/secrets/webhook: 0 → 48 testes.** Os 6 pulados foram destravados por Postgres efêmero com migrations do zero.

---

## O critério de saída inegociável

Os cinco ciclos completaram os cinco passos. **A violação não é flag:** o `lib/` é copiado, um **defeito histórico real** é escrito sobre a cópia, e o mesmo teste roda contra ela via `INVARIANT_SUBJECT_ROOT`.

```
✔ tenancy/ownership  INV-09  passa → viola → FALHA → restaura → passa
✔ auth               INV-02  passa → viola → FALHA → restaura → passa
✔ entitlement        INV-23  passa → viola → FALHA → restaura → passa
✔ secrets            INV-13  passa → viola → FALHA → restaura → passa
✔ webhook            INV-15  passa → viola → FALHA → restaura → passa
```

**INV-09 semeia uma única Organization** e assere isso antes de continuar — a forma de dados que o banco de produção, com três lojas, é estruturalmente incapaz de reprovar. É a razão de aquela classe de defeito ter sobrevivido.

Na Trilha A, o mesmo rigor: 9 quebras deliberadas, cada uma restaurada por backup e **nunca** por `git checkout --`. O fail-fast é provado **matando processo**, num subprocesso do binário de teste, porque `log.Fatalf` não é observável de dentro — e o filho deliberadamente **não usa `t.Fatalf`**, senão falha de teste e fatal ficariam indistinguíveis pelo código de saída e o teste passaria pelo motivo errado. O pai exige saída ≠ 0 **e** a mensagem do fatal. Rejeição de webhook é verificada por ausência de efeito, não só por status.

---

## Três blockers encontrados por medição, não por leitura

**B-2 — o fail-fast saía com exit code 0.** `server.js` instala `uncaughtException` como rede de segurança, e ele capturava o throw na avaliação do próprio módulo: o erro virava uma linha de log, `app.listen` nunca era alcançado, e o processo terminava com **0**. O Railway não abortaria o deploy. Medido, depois corrigido. Fica como aviso para as próximas fases: **aqui, `throw` no topo do módulo não derruba nada.**

**B-3 — o negative control passava sem rodar teste nenhum.** Node injeta `NODE_TEST_CONTEXT` no filho, que saía com 0 sem executar (`skipping running files`). Corrigido removendo a variável **e** exigindo `# tests N > 0` nos passos 1, 3 e 5.

Os dois são exatamente o risco máximo que o plano previa — um detector que concorda em silêncio — e foram pegos porque o critério exigia ver o teste **reprovar**, não apenas passar.

**B-5 (LOW, aberto)** — dois jobs consultam o banco antes da verificação de boot. Não bloqueia: o exit 1 acontece e nada é escrito. Endereço: Fase 5c / TD-006.

---

## Pré-requisitos de deploy que passaram a existir

Nenhum destes era necessário antes. **Conferir antes do próximo deploy de cada serviço.**

| id | o quê | consequência se faltar |
|---|---|---|
| **OPS-12** | `ENCRYPTION_MASTER_KEY` no painel | boot falha em produção |
| **OPS-13** | `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY=1` | ciphertexts atuais ficam ilegíveis |
| — | `META_APP_SECRET`, `API_KEY`, `DATABASE_URL` no serviço Go | boot falha em produção |

Enquanto OPS-13 estiver ligada, **`ADMIN_SESSION_SECRET` não pode ser rotacionado**; o boot avisa no log.

**A re-cifra dos segredos existentes não foi feita** — é Fase 4, e acontece depois que a leitura já passa pela nova camada. Fazer agora inverteria a ordem do plano.

---

## Duas mudanças de comportamento que exigem decisão

**1. O dashboard do serviço Go deixa de abrir pelo navegador.** As três páginas HTML autenticavam por `?key=` na URL, e navegação não manda header. É consequência direta da remoção pedida, e o trade-off é deliberado: a alternativa é a credencial real circulando em log de CDN e em `Referer`. O conserto certo é login com cookie de sessão — feature nova, fora da 5a.

**2. Esta versão do serviço Go derruba o boot se faltar segredo em produção.** É a intenção do INV-38, mas é mudança de comportamento no deploy: conferir as variáveis no Railway antes de subir.

---

## Estado dos blockers estruturais

**B-25 — implementation: FIXED locally · rollout: PENDING DEPLOY.** O código falha no boot sem os segredos e está testado (com negative controls); só vira fato em produção depois do deploy. Os dois irmãos — `auth()` e `dashAuth` — foram corrigidos no mesmo movimento.

---

## Primeiro passo que pode começar sem novas confirmações

1. **Ler as variáveis de produção do serviço Go no Railway** (somente leitura) — destrava quatro `NOT VERIFIED` da auditoria e é pré-requisito do deploy.
2. Mover o `access_token` do upload resumable da query string para header (Trilha A).
3. Decidir **TD-001**, documentada no §10 do relatório da Trilha B com os seis pontos que a decisão precisa fixar. O mais fácil de esquecer: **`BYPASSRLS`** — com ele, a RLS existe, não faz nada, e o teste passa.

**A Fase 1 não foi iniciada e não deve ser antes de TD-001 estar fechada.**

---

## Relatórios detalhados

- `overnight-trilha-a.md` — Fase 5a, por arquivo, com o ciclo dos negative controls
- `overnight-trilha-b.md` — Fase 0, lista exata de arquivos, migrations, §10 com a proposta de TD-001

---

## Correções factuais — revisão matinal (rodada 10, 16/09)

Verificação contra o código, não contra este relatório. Duas afirmações acima estavam erradas:

| afirmação | fato | correção |
|---|---|---|
| "DDL no boot: ~1.010 linhas → **0**" | `routes/criativos.js` ainda rodava o DDL do Gerador de Criativos no mount, sob `.catch` que só loga. O teste do critério 4 só lia `server.js` | migration `1789509900000_creative-core-schema`; teste varre `server.js`, `lib/`, `routes/`, `services/` |
| B-2 "medido, depois corrigido" | a correção cobriu `resolveDatabaseMode`; `createKeyring` no topo tinha o mesmo defeito — e pior: com chave malformada o processo ficava **vivo sem escutar** | handler sai com 1 durante a avaliação do módulo; teste de exit code no processo real |

Também: o teste "baseline irreversível" usava `down --count 4`, e a CLI 9.0.0 ignora `--count` em
silêncio (contagem é posicional). Passava por outro motivo. Corrigido.

Itens do "primeiro passo" deste relatório: **2 feito** (`access_token` em header, Go `c89bb71` +
`9f0f655`); **3 feito** (TD-001 CLOSED, ver `productization-decisions.md`). Estado atualizado em
`productization-progress.md`.
