# Rodada 19 · Trilha G — OPS-22 sem janela de 404 dos criativos (§8)

Base: `883e157`. Worktree destacado; o lead faz o cherry-pick.

## 1. Problema

- A RELEASE B lê os arquivos do Creative Core em `UPLOADS_DIR/creatives/tenant/<organization_id>/`
  (INV-22: tenant = Organization da request).
- Os arquivos antigos estão em `creatives/tenant/<CREATIVE_TENANT_ID antigo ou default>/`.
- O mover (`tenancy:mover-criativos`) só roda onde o volume está montado. O pre-deploy do Railway
  pode não ter o volume, então ele roda **depois** de a release entrar no ar.
- Entre o deploy e o fim do mover, toda referência de produto e todo asset antigo falhavam.
  - O runbook chamava isso de "404". Na prática o arquivo ausente virava **500** (`erro interno no gerador de criativos`).
  - O worker também falhava ao ler as referências de um lote na fila ou num retry.
- Havia um segundo defeito, escondido: o mover antigo fazia `rename` do diretório inteiro e
  recusava destino existente.
  - A release nova grava no diretório da Organization assim que alguém cria um produto ou um criativo termina.
  - Qualquer upload entre o deploy e o mover fazia o mover falhar com "destino já existe".

## 2. Escolha: leitura dupla temporária (a preferida do §8)

A alternativa "mover + verificar antes do tráfego" foi descartada. Ela exige o volume antes da
release, e o comando proíbe contar com isso. Além disso, a release anterior continua gravando no
diretório legado até a troca, e isso reabriria a janela.

### Como funciona

`lib/creative-core/storage.js` + `lib/creative-core/leitura-legada.js`:

- Configuração explícita, **desligada por padrão**:
  - `CREATIVE_LEGACY_READ_FROM=<tenant legado>`: o nome do diretório antigo, igual a `CREATIVE_TENANT_ID` ou `default`;
  - `CREATIVE_LEGACY_READ_ORGANIZATION_ID=<uuid>`: a **única** Organization que lê desse diretório.
  - As duas vão juntas. Uma sozinha, origem com forma de uuid, origem com `/`, `..` ou vazia, ou id inválido derrubam o boot (`[CRIATIVOS] configuração inválida`, exit ≠ 0).
  - Nada é deduzido: "só existe uma Organization" não liga nada, e `CREATIVE_TENANT_ID` também não.
- **Só leitura, e só no fallback.** A leitura tenta primeiro o diretório da Organization. Só se ele der `ENOENT` e a Organization da request for a declarada, tenta o diretório legado.
  - Se o arquivo sumir do legado entre as duas leituras (o mover está rodando), tenta o caminho novo mais uma vez.
- **Confinamento.**
  - As chaves continuam validadas por regex: `products/<uuid>/<uuid>.(png|jpg|webp)` e `creatives/<uuid>/image.png`.
  - O diretório legado precisa ser filho direto de `creatives/tenant/`, casar com `[a-z0-9_-]{1,64}` e **não** ter forma de uuid. Assim não pode ser o diretório de outra Organization.
  - O caminho final passa por `path.resolve` e é conferido como prefixo do diretório legado.
  - Link simbólico no legado não é seguido.
- **Escrita sempre no diretório novo.** `saveProductReference` e `saveCreativeAsset` não mudaram.
- **Observabilidade.**
  - Cada uso do fallback incrementa um contador por tipo (`referencia` / `asset`), exposto em `modulo.leituraLegada.contagem()`.
  - Também gera `[CRIATIVOS] OPS-22 leitura legada usada (referencias=N assets=M) …` no log, no máximo 1 vez por minuto, sem caminho nem nome de arquivo.
  - No boot, com a leitura dupla ligada: `[CRIATIVOS] OPS-22: leitura legada LIGADA para 1 Organization (temporária)…`.
- **INV-22 continua valendo.** O tenant continua sendo a Organization da request. A configuração só diz de onde uma Organization específica pode **ler** arquivos ainda não movidos. `CREATIVE_TENANT_ID` continua fora do código da aplicação (fase3-static).

### Mover (`scripts/tenancy/mover-criativos.mjs`), agora arquivo a arquivo e idempotente

- Destino ausente: o arquivo é movido com `link` + `unlink`, que nunca sobrescreve.
  - Se o destino estiver em outro dispositivo, faz uma cópia exclusiva, confere o sha256 e só então apaga a origem.
- Destino idêntico (mesmo sha256): só remove a origem. Cobre uma execução interrompida.
- Destino diferente: **conflito**. Nada é movido, sai com erro e lista os nomes relativos.
- Link simbólico ou arquivo especial na origem: erro.
- No fim, os diretórios vazios da origem são removidos. Rodar de novo: `nada a mover (origem inexistente)`.
- `--de` com forma de uuid ou fora de `[a-z0-9_-]` é recusado.
- A saída mostra só `tenant/<de> → tenant/<para>`, contagens e nomes relativos. Nunca caminho absoluto.
- A API usada por `tenant1:*` (`planejarMovimento` / `moverCriativos`, `acao: 'nada'|'mover'`, `aplicado`) foi mantida.

### Verificação (`--verificar`, somente leitura, exige `DATABASE_URL`)

A verificação lê do banco, numa transação READ ONLY e com `app.current_organization_id` = `--para` (RLS):

- `creative_assets.storage_key` / `sha256` / `byte_size`;
- `creative_products.references_json[].ref` / `sizeBytes`, inclusive de produtos arquivados;
- `creative_generations.plan.references[].ref`, que o worker lê num retry.

**PASS** só quando todas as condições abaixo valem:

- 0 arquivo no diretório legado;
- toda chave do banco é válida e existe como arquivo regular no diretório **novo**;
- o sha256 e o tamanho de cada asset batem com o banco;
- o tamanho de cada referência de produto bate com o banco.

Exit 0 = PASS, 1 = FAIL ou erro de banco (só o código SQLSTATE/errno), 2 = sem `DATABASE_URL`.
A saída mostra só contagens e nomes relativos.

### Preflight (`release:preflight`, seção FLAGS, item `CREATIVE_LEGACY_READ_*`)

| estado | release-n / after-ops14 | cleanup |
|---|---|---|
| ausente | OK | OK |
| ligada e válida | WARN (temporária) | **BLOCK** |
| parcial / inválida | BLOCK | BLOCK |
| `FROM` ≠ `CREATIVE_TENANT_ID` (ou `default`) | BLOCK | BLOCK |
| `ORGANIZATION_ID` ≠ dona do `creative_tenant` no `TENANCY_MAPPING_FILE` | BLOCK | BLOCK |

Nunca imprime os valores. O id da Organization também não aparece.

## 3. Testes

- `test/invariants/ops22-creative-dual-read.test.js` (8 testes, sem banco; alvo dos negative controls):
  - **antes do mover:** arquivo só no legado → 200 pelo fallback, com contagem e aviso sem caminho. Upload novo grava só no diretório da Organization;
  - **durante:** parte movida à mão, parte pendente, parte gravada pela release nova → tudo 200. O mover aceita destino já em uso, move só o que falta e remove o duplicado idêntico. Depois disso, nenhuma leitura usa o legado;
  - **depois:** tudo movido → 200 sem fallback, com a leitura dupla ligada e desligada. `verificarCriativos` dá PASS (FAIL antes). Re-execução = `nada`;
  - a verificação reprova arquivo ausente, sha256 divergente, tamanho divergente e chave inválida;
  - **fallback desligado:** comportamento anterior (arquivo só no legado → 500, como hoje);
  - **duas Organizations:** B, com as mesmas chaves no próprio banco, nunca lê o legado de A. Mapeada para B, A também não lê;
  - **confinamento:** origem = uuid de outra Organization, `..`, `../..`, `default/../..`, `.` e vazio são recusados. Chaves com traversal são recusadas. Link simbólico no legado não é seguido. O mover recusa link simbólico, origem uuid/traversal e conflito, sem sobrescrever nem apagar;
  - configuração explícita (parcial/inválida lança; `CREATIVE_TENANT_ID` não liga nada) e o limite de frequência do aviso.
- `test/invariants/ops22-creative-verify.test.js` (4 testes, Postgres descartável migrado com o cenário A):
  - CLI `--verificar`: FAIL antes; simulação; `--aplicar`; PASS depois (3 assets / 3 hashes / 3 referências, incluindo as do plano); re-execução; FAIL depois de corromper um asset e apagar uma referência;
  - a outra Organization é conferida isolada;
  - a saída não contém caminho absoluto nem URL, usuário ou senha do banco;
  - uso inválido: sem `DATABASE_URL` → 2; `--aplicar` com `--verificar` → 1; origem uuid → 1; banco inalcançável → 1, sem credencial na saída;
  - boot: 4 configurações parciais/inválidas → exit ≠ 0. Configuração válida → escuta e avisa, sem repetir o id.
- `test/invariants/release-preflight.test.js`: +1 teste (tabela acima, sem vazamento).
- **Negative controls** (`negative-controls.test.js`, lista de classes atualizada):
  - `creative/dual-read-organization`: o fallback deixa de checar a Organization mapeada → o teste de duas Organizations reprova;
  - `creative/dual-read-confinamento`: o diretório legado passa a ser montado sem validar nem confinar → o teste de confinamento reprova.

## 4. Riscos

- **Arquivo legado sem referência no banco.** O mover o leva junto (move o diretório inteiro), e a verificação não o exige. Isso não gera 404.
- **Conflito real** (mesmo nome, conteúdo diferente): só acontece se alguém copiou à mão. Nomes são uuid gerados pelo servidor. O mover para sem mexer em nada, e o fallback continua servindo a versão nova, que é lida primeiro.
- **Link simbólico no volume legado:** o fallback não o serve e o mover recusa. É preciso resolver à mão antes do `--aplicar`.
- **Contador por processo:** zera a cada deploy e não é somado entre réplicas. Para decidir o desligamento, vale a **verificação PASS**. O log/contador só confirma que ninguém mais depende do legado.
- **Com a leitura dupla desligada, arquivo ausente continua 500** (comportamento anterior, pedido pelo §8). Trocar para 404 fica fora do escopo.
- `CREATIVE_TENANT_ID` com forma de uuid como tenant legado não é aceito pela leitura dupla nem pelo mover. Em produção o valor esperado é `default` ou um nome.
  - Se não for, a leitura dupla não se aplica. Resta a alternativa do §8 (mover antes do tráfego), que precisa de decisão.

## 5. Texto para o runbook

Substituir o §6.2 e os pontos citados abaixo.

> ### 6.2 OPS-22 — arquivos do Creative Core (leitura dupla, sem janela de 404)
>
> Estratégia: **leitura dupla temporária**. O pre-deploy pode não ter o volume, então o mover roda
> depois do deploy e a release lê o legado enquanto isso.
>
> **Antes da RELEASE B (§4.5, configurar):**
> - [ ] `CREATIVE_LEGACY_READ_FROM` = o tenant legado (`CREATIVE_TENANT_ID` atual, ou `default` se ausente).
> - [ ] `CREATIVE_LEGACY_READ_ORGANIZATION_ID` = a Organization dona do `creative_tenant` no arquivo de
>   mapeamento (PD-019 cenário B: a Organization Use Origens).
> - [ ] `release:preflight` (estágio `release-n`): `CREATIVE_LEGACY_READ_*` = WARN; o item
>   `CREATIVE_LEGACY_READ_ORGANIZATION_ID` = OK; nenhum BLOCK.
>
> **RELEASE B no ar (§6.3)**
> - [ ] O boot mostra `[CRIATIVOS] OPS-22: leitura legada LIGADA para 1 Organization (temporária)`.
> - [ ] Abrir um criativo antigo e uma foto de referência antiga no painel → carregam.
>   O log mostra `OPS-22 leitura legada usada`.
>
> **Mover (no host com `UPLOADS_DIR` montado e `DATABASE_URL` do serviço):**
> - [ ] Simular: `npm run tenancy:mover-criativos -- --uploads $UPLOADS_DIR --de <tenant legado> --para <organization_id>`.
>   Mostra `N a mover · M já idêntico(s)`. Conflito → parar e resolver à mão.
> - [ ] Aplicar: o mesmo comando com `--aplicar`. É idempotente: se cair no meio, rodar de novo.
> - [ ] Verificar: o mesmo comando com `--verificar` → `criativos: PASS` (exit 0).
>   - `legado restante: 0`;
>   - `sha256 conferidos` = `assets no banco`;
>   - `presentes` = `referências no banco`. [EVIDÊNCIA: as 4 linhas de contagem]
> - [ ] Painel: os mesmos criativos antigos continuam carregando. Não surge nova linha `OPS-22 leitura legada usada`
>   depois do mover (o contador só sobe com fallback).
>
> **Release seguinte (N+1):**
> - [ ] Só com `--verificar` PASS registrado: remover `CREATIVE_LEGACY_READ_FROM` e
>   `CREATIVE_LEGACY_READ_ORGANIZATION_ID` e fazer o deploy. Rodar `--verificar` de novo depois do deploy.
> - [ ] O CLEANUP (§13) remove `CREATIVE_TENANT_ID` depois disso. Com a leitura dupla ainda presente,
>   `release:preflight --stage cleanup` dá BLOCK.
> - [ ] Remover o código da leitura dupla numa release posterior. Ele fica inerte sem as variáveis.
>
> **Rollback**
> - RELEASE B → versão anterior **depois** do mover: a versão anterior lê `tenant/<legado>`, que ficou
>   vazio. O mover não tem direção inversa (a origem nunca pode ter forma de uuid).
>   - Antes de voltar a versão, copiar de volta à mão: `cp -an $UPLOADS_DIR/creatives/tenant/<organization_id>/. $UPLOADS_DIR/creatives/tenant/<tenant legado>/`.
>     `-n` não sobrescreve. Manter o diretório novo, que a RELEASE B, ao voltar, lê primeiro.
>   - Recomendação: aplicar o mover só depois de VERIFY B, quando o rollback de B já não é provável.
> - RELEASE B → versão anterior **antes** do mover: nada a fazer com arquivos. Os uploads feitos pela release B
>   ficam em `tenant/<organization_id>` e a versão anterior não os vê (arquivos novos da janela).
> - Desligar a leitura dupla antes do PASS: criativos antigos voltam a falhar. Religar as duas variáveis e
>   fazer o redeploy. Nenhum dado é alterado pela leitura dupla.
> - Configuração errada (parcial, inválida): o boot falha e a versão anterior continua no ar (exit ≠ 0).
>
> Ordem (§3): o passo 11 continua "creative migration (OPS-22), no host com o volume", mas agora
> **depois** do passo 12 (RELEASE B no ar, com a leitura dupla) e antes do CLEANUP.

Ajustes pontuais para o lead:

- §4.5, OPS-24: "Manter … `CREATIVE_TENANT_ID` até o CLEANUP". Acrescentar "e `CREATIVE_LEGACY_READ_*` até o `--verificar` PASS".
- §4.5, WARN esperados no `release-n`: acrescentar "leitura dupla de criativos ligada (`CREATIVE_LEGACY_READ_*`)".
- §6.2: remover o **[DECISÃO]** "Janela…". A janela deixa de existir com a leitura dupla.
- §13, CLEANUP: antes de remover `CREATIVE_TENANT_ID`, confirmar que `CREATIVE_LEGACY_READ_*` já saíram.
- Checkpoint §22, item 7: `creative OPS-22 zero-404 strategy` = **leitura dupla temporária (CREATIVE_LEGACY_READ_FROM + CREATIVE_LEGACY_READ_ORGANIZATION_ID) → mover idempotente → --verificar PASS → release seguinte remove**.

## 6. Decisões para o usuário

- **Nenhuma decisão nova é necessária para o caminho padrão.** O valor de `CREATIVE_LEGACY_READ_ORGANIZATION_ID` segue a PD-019 (cenário B, fechada pelo lead) e o arquivo de mapeamento.
- **Rollback depois do mover:** a volta é uma cópia manual (ver acima). Se isso for inaceitável, a alternativa é um `--reverter` no mover. Não foi implementado: a direção inversa exigiria aceitar uuid como origem, o que o confinamento proíbe de propósito.
- Um re-mover depois dessa cópia (roll-forward) acha os arquivos idênticos no destino e só limpa a origem.

---

## 7. Revisão: RELEASE B = 31a7cdb

### 7.1 O problema (confirmado no código)

- **Produção** (`ed5a5b0`, master), `routes/criativos.js:91-94`:
  - o tenant é `CREATIVE_TENANT_ID || 'default'`, e o storage é `creatives/tenant/<esse tenant>/`;
  - o repositório não tem `scripts/tenancy/mover-criativos.mjs`.
- **RELEASE B** (`31a7cdb`), `routes/criativos.js:94,120-127`:
  - o tenant é a Organization da sessão, e o storage é `creatives/tenant/<organization_id>/`;
  - não há leitura dupla, que só existe a partir do HEAD desta trilha;
  - a troca veio em `c6fe058`, que é ancestral de `31a7cdb`.
- **Os dois `lib/creative-core/storage.js`** diferem só numa mensagem de erro:
  - o caminho é conferido por string (`path.resolve` + prefixo, sem `realpath`);
  - a I/O é `readFileSync` / `writeFileSync` / `mkdirSync({ recursive: true })`, que **seguem link simbólico**;
  - arquivo ausente vira `ENOENT` e depois **500**.
- **Conclusão:** com a B no ar, todo arquivo em `tenant/<legado>` dá 500 até ser movido. A leitura dupla do HEAD não ajuda na B.
  - O mover da própria B (`31a7cdb`) faz `rename` do diretório inteiro e recusa destino existente.
  - Teste de controle: `ops22-creative-release-b.test.js`, "sem o vínculo, a RELEASE B não serve os arquivos existentes" (500/500).

### 7.2 Plano: vínculo antes da B (opção (a) do lead, na direção sem janela)

- **Antes da B**, no host com o volume (a produção atual), um único passo atômico: criar `tenant/<organization_id>` como **link simbólico relativo** para `<legado>`.
  - A produção continua lendo e gravando no diretório real `tenant/<legado>`.
  - A B lê e grava pelo link: é o mesmo diretório físico.
  - Uploads de uma versão aparecem na outra. O rollback B → produção não perde nada.
- **Direção escolhida.** Não há rename, e a produção nunca perde o caminho dela.
  - A direção inversa (renomear o legado para o id e deixar o link no legado) teria uma janela entre `rename` e `ln`, durante a qual a produção não acha os arquivos.
  - `ln -s` é uma chamada só (`symlink(2)`): falha com `EEXIST` se o destino aparecer no meio.
- **Materialização** (remover o link e mover arquivo a arquivo): **só** numa release que já tem a leitura dupla (a D' ou posterior, a partir deste HEAD), com `CREATIVE_LEGACY_READ_*` ligadas.
  - Entre o `unlink` do link e o fim do movimento, a leitura dupla serve o que ainda está no legado.
  - Uploads vão para o diretório real novo.
  - **Esta é a função que sobra para a leitura dupla**, e por isso ela fica. Sem ela, remover o link reabriria a janela.
  - Ela não é usada enquanto o vínculo existe (contador = 0).
- **Opção (b) descartada.** Cópia com escrita congelada exigiria janela de manutenção e congelamento de uploads nas duas versões, que o código não suporta (não há flag de somente leitura no módulo). Além disso, uploads da B entre a cópia e a recópia não apareceriam na produção num rollback.

### 7.3 Mudanças no código (sobre `2eeaf30`)

`scripts/tenancy/mover-criativos.mjs`:

- **`--vincular [--aplicar]`:**
  - cria o link relativo;
  - cria o legado vazio se ele não existir (senão cada versão criaria o seu diretório);
  - é idempotente ("vínculo já existe");
  - recusa se `tenant/<org>` já existir como diretório, ou como link para outro lugar, ou se o legado for um link.
- **Movimento comum com o vínculo presente é RECUSADO.**
  - O mover de `2eeaf30` via cada arquivo "já idêntico no destino" (é o mesmo arquivo, alcançado pelo link) e **apagava a origem, que é o único arquivo**.
  - Há também uma segunda defesa: um arquivo do destino cujo `realpath` cai dentro da origem é tratado como conflito, nunca como duplicado.
- **`--desvincular --aplicar`:**
  - confere de novo que o link é o esperado, faz `unlink` e move tudo;
  - se o link já tiver saído (execução interrompida), segue como movimento comum, idempotente;
  - `--desvincular` sem `--aplicar` é erro; para simular, rode sem as duas opções. A simulação recusa com a mensagem do vínculo.
- **`--verificar`:**
  - estado `vinculado`: todas as referências do banco acessíveis e íntegras pelo link dão **`PASS-VINCULADO`** (exit 0). Arquivos no legado são esperados;
  - estado `separado`: vale o **`PASS`** de antes;
  - link para outro lugar, link pendurado ou legado que é link dão FAIL.
- A leitura dupla (`storage.js`) e o preflight não mudaram.

### 7.4 Teste executável (`test/invariants/ops22-creative-release-b.test.js`)

- Roda o **código real** de `ed5a5b0` e de `31a7cdb`: `git archive` de `routes/criativos.js` + `lib/creative-core/` num diretório temporário, com os routers HTTP de cada commit.
- Também roda o do HEAD (com a leitura dupla), todos sobre o **mesmo volume**.
- Casos cobertos:
  - **Controle:** sem o vínculo, a B dá 500 nos arquivos existentes.
  - **Antes / vínculo / durante / rollback / roll-forward:**
    - a produção lê tudo;
    - `--vincular` simulado não muda nada, e aplicado cria o link relativo, de forma idempotente;
    - verificação `PASS-VINCULADO`;
    - produção e B no ar ao mesmo tempo leem os arquivos existentes (200, conteúdo idêntico);
    - upload da produção aparece na B e vice-versa;
    - só existe um diretório físico;
    - o movimento comum é recusado;
    - com a B fora (rollback), a produção vê tudo, inclusive o que a B gravou;
    - a B de volta vê tudo.
  - **Materialização com o HEAD + leitura dupla:**
    - vinculado, o fallback não é usado;
    - sem `--desvincular`, o movimento é recusado;
    - depois do `unlink`, os arquivos antigos continuam 200 pelo fallback, e o upload vai para o diretório real;
    - o mover termina o serviço: 200 sem fallback, `PASS` separado, legado vazio.
  - **`--desvincular --aplicar` num passo:**
    - legado inexistente é criado vazio antes do link;
    - uploads das duas versões são movidos, e a B continua servindo;
    - documentado: a produção anterior à B **não** vê mais os arquivos depois da materialização;
    - re-execução não faz nada.
  - **Recusas:** diretório real já existente, link para outro lugar, legado que é link, link pendurado (verificação FAIL).
  - **Negative control (5 passos, no próprio arquivo):**
    - a violação reproduz o mover de `2eeaf30`, por substituição de texto na cópia: sem reconhecer o vínculo nem o arquivo alcançado por link;
    - diante do vínculo, esse mover apaga os arquivos, e o teste reprova;
    - o mover atual preserva;
    - o mover atual, restaurado, volta a passar.
  - **Procedimento de shell do runbook** (bloco abaixo): o teste extrai o bloco **deste documento** e o executa com `sh`.
    - Verifica que é idempotente e recusa diretório existente.
    - O resultado é o mesmo estado que `--vincular` produz (`PASS-VINCULADO`, e `--vincular` responde "já existe").

- CLI contra Postgres real (`ops22-creative-verify.test.js`):
  - `--vincular` simulado e aplicado, idempotente;
  - `--verificar` com `estado: vinculado` e `PASS-VINCULADO`;
  - movimento comum e simulação recusados com o vínculo;
  - combinações inválidas de opções;
  - `--desvincular --aplicar` seguido de `PASS` separado;
  - sem vazamento de caminho nem URL.

### 7.5 Texto para o runbook (substitui o §5 deste documento onde conflitar)

> ### 6.2 OPS-22 — arquivos do Creative Core (vínculo antes da B; materialização com leitura dupla)
>
> A RELEASE B (`31a7cdb`) lê `creatives/tenant/<organization_id>/` e não tem a leitura dupla. O
> vínculo faz esse caminho apontar para o diretório atual, **antes** do deploy da B.
>
> **Antes da RELEASE B — no serviço de produção atual (tem o volume; o código `ed5a5b0` não tem o mover):**
> - [ ] `ORG` = a Organization dona do `creative_tenant` no arquivo de mapeamento (PD-019 B: Use Origens).
>   `LEGADO` = `CREATIVE_TENANT_ID` atual, ou `default` se ausente.
> - [ ] Rodar o bloco abaixo (shell do serviço). Ele para sem mudar nada se `tenant/<ORG>` já existir.
>   [EVIDÊNCIA: a linha "vínculo criado" ou "vínculo já existe"]
>
> <!-- ops22-vincular-sh -->
> ```sh
> set -eu
> : "${UPLOADS_DIR:?defina UPLOADS_DIR}" "${LEGADO:?defina LEGADO}" "${ORG:?defina ORG}"
> case "$LEGADO" in *[!a-z0-9_-]*|'') echo "PARAR: LEGADO inválido"; exit 1;; esac
> case "$ORG" in *[!0-9a-f-]*|'') echo "PARAR: ORG inválido"; exit 1;; esac
> mkdir -p "$UPLOADS_DIR/creatives/tenant"
> cd "$UPLOADS_DIR/creatives/tenant"
> if [ -L "$ORG" ] && [ "$(readlink "$ORG")" = "$LEGADO" ]; then echo "vínculo já existe"; exit 0; fi
> if [ -e "$ORG" ] || [ -L "$ORG" ]; then echo "PARAR: tenant/$ORG já existe (use a leitura dupla + mover)"; exit 1; fi
> if [ -L "$LEGADO" ]; then echo "PARAR: tenant/$LEGADO é um link"; exit 1; fi
> [ -d "$LEGADO" ] || mkdir "$LEGADO"
> ln -s "$LEGADO" "$ORG"
> [ "$(readlink "$ORG")" = "$LEGADO" ]
> echo "vínculo criado: tenant/$ORG -> tenant/$LEGADO ($(find "$LEGADO" -type f | wc -l | tr -d ' ') arquivo(s))"
> ```
>
> - [ ] A produção continua servindo criativos antigos (abrir um no painel).
>
> **RELEASE B (§6.3) e as seguintes (C, D0…):**
> - [ ] **Não** rodar `tenancy:mover-criativos` das releases B/C/D0. Aquele mover faz rename do diretório;
>   com o vínculo, ele recusa ("destino já existe"), mas não há motivo para chamá-lo.
> - [ ] VERIFY B: criativos antigos e fotos de referência carregam. Um upload novo aparece.
>   `readlink $UPLOADS_DIR/creatives/tenant/<ORG>` continua `<LEGADO>`.
> - Rollback B → produção: nada a fazer com arquivos (um só diretório físico).
>
> **Materialização — na primeira release com a leitura dupla (este HEAD em diante; D' ou posterior):**
> - [ ] Configurar `CREATIVE_LEGACY_READ_FROM=<LEGADO>` e `CREATIVE_LEGACY_READ_ORGANIZATION_ID=<ORG>` **nessa**
>   release (não antes: a B as ignora). O boot mostra `OPS-22: leitura legada LIGADA`. Preflight: WARN.
> - [ ] `npm run tenancy:mover-criativos -- --uploads $UPLOADS_DIR --de <LEGADO> --para <ORG> --verificar`
>   → `estado: vinculado` · `criativos: PASS-VINCULADO`.
> - [ ] **Ponto sem volta para a produção anterior à B:** depois do próximo passo, uma versão anterior à B
>   não vê mais os arquivos. Só seguir quando o rollback para antes da B já estiver fora do plano
>   (a cadeia de rollback da D' já não volta até lá).
> - [ ] `… --desvincular --aplicar` → "vínculo removido" e "N movido(s)". Idempotente: se cair, rodar de novo.
> - [ ] `… --verificar` → `estado: separado` · `criativos: PASS`. [EVIDÊNCIA: as linhas de contagem]
> - [ ] Na release seguinte: remover `CREATIVE_LEGACY_READ_*` (preflight `cleanup` bloqueia se ficarem).
>   Depois, o CLEANUP remove `CREATIVE_TENANT_ID`.
>
> **Rollback**
> - Vínculo criado, B ainda não publicada: `rm $UPLOADS_DIR/creatives/tenant/<ORG>`. É um link: `rm` sem `-r`
>   remove só o link. Nada mais muda.
> - B → produção: sem ação sobre arquivos.
> - Materialização → release anterior com leitura dupla: sem ação (a anterior lê o diretório real novo).
>   → B/C/D0: também lêem o diretório novo. → produção anterior à B: **não suportado** sem copiar de volta
>   (`cp -an tenant/<ORG>/. tenant/<LEGADO>/`, conferindo).
> - Configuração errada da leitura dupla: o boot falha e a versão anterior continua no ar.
>
> Ordem (§3): **"11a. creative link (OPS-22)"** antes do passo 12 (RELEASE B), fora do pre-deploy.
> **"11b. creative materialization (OPS-22)"** depois da RELEASE D' (ou da primeira release a partir
> deste HEAD) e antes do CLEANUP.

**Substituições no §5 anterior:**
- Deixam de valer "configurar `CREATIVE_LEGACY_READ_*` antes da RELEASE B" e "mover depois da RELEASE B". As duas coisas passam para a materialização.
- Os ajustes pontuais do §5 continuam válidos, com uma troca: "até o `--verificar` PASS" passa a ser "até o `--verificar` PASS **separado**".

### 7.6 Riscos

- **Link simbólico no volume do Railway.** O volume é ext4, o que suporta links, mas não foi exercitado em produção.
  - Se `ln -s` falhar, o bloco para com erro e nada muda.
  - O primeiro passo do VERIFY B (abrir um criativo antigo) detecta um link que não funcione.
- **Ferramentas que copiam o volume** (backup/restauração) precisam preservar links. Um backup que siga o link duplica os arquivos. Isso não causa perda, mas depois da restauração, `--vincular`/`--verificar` acusam o estado.
- **Materialização antes de o rollback para a produção sair do plano** deixaria a produção sem arquivos. O runbook marca o ponto sem volta.
- **Uma release sem leitura dupla** (B, C, D0) no ar durante a materialização abriria a janela. O runbook só materializa a partir de uma release com a leitura dupla.
  - A CLI não tem como checar isso sozinha. A mensagem do `--desvincular` lembra disso.
- **O contador e o log da leitura dupla** só registram uso depois da materialização. Enquanto houver vínculo, o normal é 0.
- **`tenant1:apply`/`tenant1:plan`** (só local): com o vínculo presente, o `moverCriativos` recusa. O ensaio local não cria vínculo.

### 7.7 Decisões

- **Nenhuma decisão nova de produto.**
- **Operacional:** o momento da materialização. Recomendo depois de a RELEASE D' estabilizar, quando o rollback para antes da B já não está no plano.
- **Possível sem código na B:** sim. O vínculo usa só o que `ed5a5b0` e `31a7cdb` já fazem: seguir link ao ler e gravar.
