# Clientes/RFM — Encerramento: estabilização, revisão do fluxo de campanhas e resumo do PR

Branch local `feature/clientes-rfm`, a partir de `28f6366`. **Nada foi enviado**: sem push, PR, merge, deploy, CI remoto, envio,
campanha real, dados reais, snapshot, job diário ou integração nova. Mantidos: `rfm-v1:c35267c2`, 45/90/180/365, P75 da soma, janela de
365 dias, **opção A**. Calibração real continua pendente (sem acesso somente leitura autorizado).

---

## 1. O teste instável INV-12 / STORE-02 — causa e correção

**Sintoma (Rodadas 5 e 6):** `fase4-server-integrations › INV-12 · requests intercaladas e concorrentes não cruzam credenciais` viu **5 chamadas
em vez de 4** ao Ink com o token da Org A (e, na Rodada 5, `tenant novo · Integrações abre…` viu **49 em vez de 47**). Reprovava o negative control
`STORE-02` no passo 1 (estado correto) e o `INV-12/oauth`. Passava isolado.

**Causa (reproduzida de forma determinística, não "sob carga"):** o servidor de teste sobe **com os jobs de fundo ligados**. O job de boot
`boot-redes-de-seguranca` dispara **5 s depois de subir** e chama `GET /v1/stores/orders` no Ink **3 vezes por Organization**
(`sincronizarControleEstoque`, `registrarPixPendentes`, `persistirCarrinhosAbandonados`). O teste conta **todas** as chamadas ao mock numa
janela de tempo; se a janela cai sobre o 5º–6º segundo do processo (máquina lenta, ou uma pausa na janela), as chamadas do job entram na
conta. Deslocando a janela de propósito (`REPRO`, arquivo temporário descartado): espera 3 s/4,5 s + medição de 2,5 s ⇒ **7 × 4 por token
(3 extras por Org)**, sempre; espera 5,5 s/7 s ⇒ passa. Com os jobs desligados, as três configurações que antes falhavam **passam**.

**Correção (sem timeout maior, sem enfraquecer assert):** isolar o mock — `ORIA_JOBS_DE_FUNDO=off` desliga os timers de fundo
(`lib/platform/jobs.js`, opção `desligado`); **só é honrado fora de produção** (em produção é ignorado e vira erro no log; `NODE_ENV` de produção
não permite parar a fila de campanhas por engano). Aplicado **somente** ao servidor de `fase4-server-integrations` (nenhum teste dele depende de job;
outros arquivos que **exercitam** jobs de propósito não foram alterados). Testes: `jobs-desligados.test.js` (4: desligado não cria timer nem roda, avisa
uma vez; ligado continua agendando; `executarPorOrganizacao` segue disponível; guarda de produção no `server.js`). Nenhum assert do INV-12 foi tocado.

---

## 2. Revisão do fluxo de campanhas (disparo e agendamento)

| Cenário | Comportamento verificado | Prova |
|---|---|---|
| Filtro inválido (campo/operador/tipo/valor, `match`, exclusão) | 400 `AUDIENCIA_FILTRO_INVALIDO` na prévia, criação/edição e `/start`; **nenhum destinatário**; definição antiga **não reescrita** | HTTP `clientes-rfm-http` (definição legada inválida gravada direto no banco) + 62 puros |
| Sem condição / `{}` (antigo "todos") | `AUDIENCIA_SEM_FILTRO`; universal só com `todosClientes` explícito | HTTP + puros |
| Segmento RFM legado ("aproximado") | 409 `RFM_SEGMENTO_APROXIMADO` em agendar (`PUT scheduled`), `/start` e agendador, **antes** de criar destinatários; libera só com `aproximadoConfirmado` | HTTP (por `segmentoId` **e** por definição idêntica) |
| Regra RFM mudou / base insuficiente / junção inconsistente | 409 `RFM_*`; nunca "todos" | HTTP (`/start` e prévia) + puros |
| Erro de prévia na Revisão | erro verdadeiro, **Agendar/Enviar bloqueados**, reavalia ao entrar **e** antes de confirmar | Playwright `qa-rfm-r6`/`qa-rfm-audiencia` |
| **Agendada** cuja hora chegou com definição recusada | **não dispara**, continua `scheduled`, **sem destinatários**; motivo tipado **registrado**; a campanha fica **em espera 10 min** | `campanhas-agendadas.test.js` (6) — o agendador usa o mesmo `iniciarDisparoCampanha` do `/start` (teste de fonte) |

**Achado corrigido nesta etapa:** o agendador lê `LIMIT 5` das agendadas vencidas mais antigas. Com "continua `scheduled` quando recusada", as **5 mais antigas
bloqueadas monopolizariam a janela para sempre** e campanhas válidas seguintes nunca iniciariam. Agora as bloqueadas há < 10 min ficam fora da consulta
(`NOT (id = ANY(...))`) e voltam depois da espera (a causa pode mudar sem edição, ex.: regra RFM). Editar/excluir limpa o registro na hora.

**Motivo visível ao administrador (sem migração, sem gravar estado novo):** `GET /api/admin/campaigns` e `/campaigns/:id` devolvem `bloqueio
{ codigo, mensagem, origem: 'definicao'|'agendador', desde?, ultimaTentativa? }` para rascunho/agendada:
(a) **estático**, da definição salva (sempre disponível): inválida, sem condição explícita (agendada), segmento RFM aproximado sem confirmação;
(b) **do agendador**, o que ele já tentou e recusou (ex.: `RFM_REGRA_DIVERGENTE`, `RFM_AMOSTRA_INSUFICIENTE`) — em memória por réplica, restaurado em até um ciclo (30 s)
após reinício. Na tela: **lista** com selo "Agendada · bloqueada"/"Bloqueada" + motivo ao lado; **editar** com aviso "Campanha agendada BLOQUEADA: não será enviada como está"
+ motivo + orientação ("Nada foi enviado e nenhum destinatário foi criado"). Salvar uma definição aceita limpa o aviso. Playwright `qa-campanhas-bloqueadas` **8/8**
(1440 e 390; sem rolagem horizontal). Tudo sintético; nada foi enviado.

---

## 3. Isolamento, migrations, build, contratos, CI

- **Isolamento entre Organizations:** testes HTTP com RLS e duas Organizations: matriz/lista/prévia/segmento/`bloqueio` de campanha não vazam (a Org B recebe 404 na
  campanha da A e não vê o motivo). O agregado e a RFM leem `pedidos_ink` sob o contexto da Organization/Store; a junção usa `loja + customerKey`.
- **Migrations:** este trabalho não adiciona migration. A migration da feature (`0034-segments-rfm`, aditiva com `DEFAULT`) **sobe idempotente** (`migrate:up` ×2: "No migrations to run")
  e **desce/sobe** limpa em banco descartável (down: 0 das 6 colunas; up: 6; `segments` intacto). O diff `main…HEAD` traz 15 arquivos de migration (0028–0034, de várias frentes da branch).
- **Build/contratos:** `tsc -b --noEmit` e `npm run build` limpos; `check-contracts` OK; `repo:self-check` OK; `suites.mjs verify` OK (o novo teste puro cai no grupo sem banco).
- **CI (`.github/workflows/ci.yml`, PR → `main`):** YAML válido (10 jobs). Jobs: `changes` → `contracts` → `panel-pure` ×2 → `panel-db` ×4 sob `oria_app` (Postgres 16 próprio por job)
  → `panel-migrations` (do zero + idempotente) → `panel-build`. Node 22, Go 1.25; variáveis não secretas (`TEST_DATABASE_URL` local do serviço). Os shards foram reproduzidos **localmente** (§4).

---

## 4. Validação executada

Todos sobre `354da9f` (código final; os commits seguintes são só documentação), containers/portas exclusivos desta sessão, máquina com load 10–86 de outras sessões:

| Execução | Resultado |
|---|---|
| INV-12 (2 testes) + 8 controles (`STORE-02`, INV-12 ×5…) + `tenant novo` | **16/16** |
| `jobs-desligados` 4 · `campanhas-agendadas` 6 · `campanhas-audiencia-filtros` 62 · `clientes-rfm-http` 30 (com o novo teste de bloqueio) · `fase5c-leases`+`fase3-static` 17 | todos verdes |
| Playwright `qa-campanhas-bloqueadas` (1440/390) | **8/8** |
| **Shards locais do CI** (`panel-suite.mjs`, pure ×2 + db ×4 sob `oria_app`, um container por shard) | **1.963 testes · 1.963 passaram · 0 falhas · 0 cancelados · 0 ignorados** (6 shards, exit 0) |
| **`npm test` integral** (owner, container próprio, uma execução) | **1.963 testes · 1.963 passaram · 0 falhas · 0 cancelados · 0 ignorados** (exit 0) |
| `tsc -b --noEmit` · `npm run build` · `check-contracts` · `repo:self-check` · `suites.mjs verify` (132 arquivos: 64 sem banco, 68 com banco) | limpos/OK |
| Migrations: `migrate:up` ×2 (idempotente) e `down`/`up` da `0034` em banco descartável | OK |

**Um achado real dos shards:** uma execução anterior dos shards (código `17e24ad`) reprovou `INV-18 · estático` (`fase5c-leases`): o contrato fixa `poolReal` +
`leases` no início da chamada de `createJobRunner` e a opção nova `desligado` havia sido inserida antes. Corrigido no `354da9f` (a opção vai depois de `leases`,
teste inalterado) e **todos os shards foram refeitos** sobre o código final. Nenhum teste foi enfraquecido ou teve timeout aumentado nesta etapa.

**Local verde ≠ CI verde:** o CI remoto não foi executado (exige push).

---

## 5. Resumo do PR (rascunho, **não publicado**)

**Título:** Clientes 360°/RFM: segmentos, Audiência exata e motor de campanhas fail-closed

**O que entra (73 commits desde `main`, foco RFM nas últimas rodadas):**
1. **Clientes 360°** (indicadores, lista, drawer, exportação auditada) e **RFM `rfm-v1`** explicável (11 segmentos, regra versionada, cobertura ≠ amostra).
2. **Segmentos de campanha** a partir da RFM/lista (`segments`: origem, política, predicado, versão da regra) — migration `0034` aditiva.
3. **Audiência exata**: segmento RFM persiste um filtro `rfm` (predicado + corte salvo + regra) avaliado pela mesma classificação da matriz.
4. **Motor de audiência fail-closed** para todos os filtros; universal só explícita; segmentos RFM legados exigem confirmação/recriação; agendador não dispara definição recusada e mostra o motivo.
5. **UI**: RFM Explorer proporcional (11 segmentos legíveis), painel do segmento, Revisão que reavalia, cartão do segmento RFM na Audiência, motivo do bloqueio na lista.
6. **Ferramentas/QA**: fixture sintética, scripts Playwright, benchmark local, relatório/runbook de calibração (somente leitura), negative controls ajustados.

**Mudanças de comportamento (para revisão):**
- Lista de condições **vazia deixou de significar "todos os clientes"** (`AUDIENCIA_SEM_FILTRO`); "todos" exige `todosClientes` explícito.
- Campo/operador/tipo/valor inválidos **recusam** a definição inteira (antes: descartava e alargava).
- Campanhas **agendadas** com definição inválida, sem condição explícita ou de segmento RFM aproximado sem confirmação **não disparam** (ficam `scheduled`, com motivo visível).
- Segmentos RFM novos usam avaliação **exata**; os antigos seguem intactos ("avaliação aproximada").
- Textos: "Receita líquida" → "Valor pago"; critério de pedido válido explicitado (pagamento confirmado; situação do pedido não considerada).
- `ORIA_JOBS_DE_FUNDO=off` (só fora de produção) para isolar testes.

**Pendências / fora do escopo:** calibração real (acesso somente leitura); opção B do corte de valor; snapshots/job diário; `paid` + pedido encerrado e reembolso parcial;
`.pre-commit-config.yaml` (hook global do desenvolvedor sem config → `PRE_COMMIT_ALLOW_NO_CONFIG=1`); migração dos segmentos legados (hoje recriação explícita).

**Checklist de merge:** CI remoto verde (todos os jobs) · homologação/QA na loja · decisão do proprietário sobre as pendências · autoria `gatomazi` (regra do projeto).
