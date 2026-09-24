# Clientes/RFM — Rodada 6: motor de Audiência fail-closed, execução comprovável e preparação de release

Branch local `feature/clientes-rfm`, partindo de `105ac1c` (fim da Rodada 5). **Nada foi enviado**: sem push, PR, merge, deploy, CI remoto,
campanha/envio real, acesso a dados reais/`DATABASE_URL`/Railway, snapshot ou job diário. Mantidos: `rfm-v1:c35267c2`, limites
45/90/180/365, janela de 365 dias, P75 da soma, **opção A** (corte numérico salvo), regra de `payment_status` atual. Massa e capturas:
sintéticas, em `apps/panel/relatorios-privados/rfm-r6/` (ignorado pelo Git, sem PII).

**Quadro final:** ver §6.

---

## 1. Entrega A — motor genérico fail-closed

### 1.1 O risco (Rodada 5 §1.1 item 5, agora fechado também no motor genérico)

Antes: `AUDIENCIA_CAMPOS_FILTRO` descartava campo desconhecido e, sem nenhum filtro válido, todos os clientes casavam; o construtor do
front descartava linha que não conseguia converter; `match` desconhecido virava `ALL`; exclusão com tipo errado era interpretada de
forma frouxa. Uma condição inválida (digitada errada, definição antiga, chamada direta à API) alargava o público.

### 1.2 Contrato único (`lib/campanhas/audiencia-filtros.js`)

`validarDefinicaoAudiencia({ match, filtros, exclusoes })` valida **campo, operador, tipo e valor** de cada condição, `match` e as
exclusões, e devolve a definição normalizada ou **lança `ErroAudienciaFiltro`** (400):

| Código | Quando | Conteúdo |
|---|---|---|
| `AUDIENCIA_FILTRO_INVALIDO` | qualquer condição/`match`/exclusão inválidos | `detalhes[]` com `indice`, `campo`, `operador`, `motivo`; mensagem acionável ("Corrija ou remova a condição; nada foi calculado nem enviado") |
| `AUDIENCIA_SEM_FILTRO` | lista vazia, ausente, `{}` ou nula | "adicione uma condição, escolha um segmento ou confirme explicitamente 'todos os clientes'" |
| `RFM_*` (Rodada 5) | filtro RFM defeituoso, regra que mudou, base insuficiente, junção inconsistente | inalterados |
| `RFM_SEGMENTO_APROXIMADO` (409) | executar/agendar a partir de segmento RFM legado sem confirmação | ver §1.5 |

Nunca há avaliação parcial de `AND`/`OR`: **todos** os problemas são coletados e a definição inteira é recusada (`ALL` e `ANY`).
Mensagens e `detalhes` trazem só campo/operador/motivo — nunca valores de cliente.

**Aplicado em todos os pontos:** prévia (`/audience/preview`) · Revisão (a mesma prévia) · `avaliarAudienciaCampanha` (usada por
`/start` **e** pelo agendador) · criação/edição de segmentos (`POST/PUT /api/admin/segments`) · segmentos gerados por Clientes
(`origem: 'clientes'`) · criação/edição de campanha (`POST/PUT /api/admin/campaigns`; agendar exige definição válida e explícita).
Rascunho ainda sem condição continua permitido (nunca é enviado); condição **inválida** nunca é gravada.

### 1.3 Audiência universal explícita

"Todos os clientes" só existe como **um único filtro** `{ field: 'todosClientes', value: true }`, sozinho (combinar com outra condição ou
com o RFM é inválido), e continua sujeito às exclusões comerciais (opt-in e telefone válido ligados por padrão). Na tela: lista sem
condição mostra "Nenhuma condição definida … nunca vira 'todos os clientes' por padrão" com a caixa **"Usar todos os clientes com pedido
(as exclusões abaixo continuam valendo)"**, desmarcada; sem condição e sem a caixa **nenhuma prévia é pedida** e a Revisão mostra o
erro e bloqueia. Adicionar uma condição desfaz o "todos".

### 1.4 Formatos legados inventariados e compatibilidade

Inventário (construtor do front, segmentos RFM das Rodadas 3–5, testes do repositório): numéricos
`{field, op ∈ gt|gte|lt|lte|eq, value: número ≥ 0}` (`diasSemComprar`, `quantidadePedidos`, `totalGasto`, `ticketMedio`); `uf`
`{field, [op:'eq'], value:'RS'}`; booleanos `optIn`/`temCarrinhoAbandonado` `{field, value}` sem operador; `recebeuCampanha`/
`naoRecebeuCampanha` `{field, value:{campanhaId}}`; `recebeuCampanhaNosUltimosDias` `{field, value:{dias}}`; `rfm` (Rodada 5).
**Todos os válidos seguem funcionando** (testados com `ALL` e `ANY` e por contagem independente no HTTP). Definições no banco **não
são reescritas**: as inválidas são recusadas na hora de avaliar/enviar, com a causa (testado: campo desconhecido, mista, sem condição e
`{}` gravadas direto no banco → prévia 400, `/start` 400, **nenhum destinatário**, status `draft`, definição idêntica depois).

**Impacto em campanhas existentes (documentado):** (a) campanha **agendada** com definição inválida ou **sem condição explícita**
(lista vazia = antigo "todos") **não dispara**: continua `scheduled`, sem destinatários; o log sai uma vez por campanha+causa (não a
cada ciclo) e a Revisão mostra o erro ao abri-la; para enviar, edite a audiência (condição válida ou "todos" explícito); (b) segmento
salvo com lista vazia continua no banco, mas a Audiência dele é recusada até alguém escolher condição ou "todos" de forma explícita.

### 1.5 Segmentos RFM legados ("avaliação aproximada")

Registros **preservados** (nenhuma migração). Identificados pelo id (`segmento_id`) **ou** por definição idêntica (campanhas antigas não
guardam o id). A prévia devolve `rfmAproximado`; a tela mostra o cartão **"Segmento RFM com avaliação aproximada"** com a
confirmação **"Entendo que o público é aproximado e quero usá-lo assim"** (desmarcada) e o botão **"Recriar na avaliação exata"** (cria um
segmento novo pela via exata; o antigo não é tocado). Enquanto não houver confirmação: **Revisão, Agendar e Enviar bloqueados**; no servidor,
`PUT` com `status: scheduled`, `/start` e o agendador recusam com `RFM_SEGMENTO_APROXIMADO` (409) **antes** de criar destinatários; a
confirmação é gravada em `audience_definition.aproximadoConfirmado` (só quando dada). **Impacto em agendamentos existentes:** os que vêm
de segmento RFM legado ficam `scheduled` e **não disparam** até alguém abrir a campanha e confirmar (ou recriar).

### 1.6 Revisão

Reavalia ao entrar **e imediatamente antes de confirmar** (Agendar e Enviar), com guarda contra resposta fora de ordem (`vigente`); erro
bloqueia Agendar/Enviar, mostra a causa e **não cria destinatários**. O wizard agora envia o `segmentoId` e **nenhuma linha incompleta
é descartada**: vai como está e o servidor a recusa com a causa (a tela mostra "condição 1 (diasSemComprar gte): o valor … precisa ser um
número"). Ao recriar o segmento na via exata, a página recarrega a lista de segmentos (antes ficava com a lista antiga).

### 1.7 Testes da Entrega A (todos por dados sintéticos; nada enviado)

- **Puros** `campanhas-audiencia-filtros.test.js` — **62**: 13 formatos legados válidos (ALL e ANY), 28 inválidos por tabela (campo
  desconhecido/digitado errado/ausente, operador ausente/desconhecido/inadequado, tipo texto/NaN/infinito/negativo/nulo/não inteiro,
  booleano como texto/número, UF inexistente/vazia/objeto, `campanhaId`, `dias`, chaves extras, condição nula/texto/lista), condição
  mista válida+inválida (todos os problemas listados), `match` inválido, lista que não é lista, vazio, "todos" explícito (sozinho,
  duplicado, com extras), 7 exclusões inválidas, RFM obrigatório com `ANY`, definição legada inválida sem mutação, e mensagem sem vazar valor.
- **HTTP com RLS e duas Organizations** (`clientes-rfm-http`, agora 29): fail-closed com 5 casos × `ALL`/`ANY`; universal explícita;
  criação/edição novas inválidas sem gravar; **definição legada inválida no banco** bloqueada antes de criar destinatário; compat dos
  filtros legados válidos contra contagem independente; segmento RFM aproximado (prévia sinaliza, agendar/iniciar 409 com `segmentoId`
  **e** por definição idêntica, confirmação libera só o **agendamento futuro**, segmento intacto, via exata não reaproveita o legado).
  Testes de contrato antigos atualizados **porque o contrato mudou de propósito**: lista vazia deixou de ser "todos"
  (`operacao-store-nativa` agora usa `todosClientes` e assere o 400 do vazio); UF `ZZ` → `SC` (UF válida sem compradores); dois filtros RFM → 400.
- **Detector negativo (defeito deliberado, restaurado):** reintroduzir o antigo descarte de campo desconhecido → **6 testes puros**
  reprovaram (62 → 56 verdes) e **3 testes HTTP** reprovaram; restaurado, 62/62 e verdes.
- **Alvos dos 124 negative controls** continuam presentes exatamente uma vez (verificação direta) — o tipo de quebra que a Rodada 5 só
  descobriu na suíte integral (PED-02).
- **Playwright curto** (`qa-rfm-r6.mjs`, 1440 e 390) **36/36**: sem condição ≠ "todos"; Revisão com erro bloqueia; "todos" só marcado;
  linha incompleta não descartada + recuperação; `campanhaId` vazio; segmento aproximado (aviso, bloqueio, confirmação, "recriar");
  axe sem `serious/critical`; nenhuma campanha criada. Regressão preservada: `qa-rfm-audiencia` **57/57**, `smoke-viewport` **38/38**
  (2 execuções seguidas). Os scripts ganharam esperas pela prévia **assentada** (eram corridas de temporização, não defeitos da tela).

---

## 2. Entrega B — execução comprovável e CI

### 2.1 Estado da máquina e da execução

Conferido antes de qualquer execução: `HEAD 105ac1c`, árvore limpa, containers/portas/nomes exclusivos desta sessão. Havia **3 servidores
órfãos de negative control** (`OP-05` ×2, `PAG-01`; `ppid 1`, 1–2,5 h) vazados pelos timeouts da Rodada 5 — encerrados **por PID**
(nenhum `pkill`); um quarto (`R19-04`, 16 h) é de outra sessão e ficou intacto. O load average começou em ~140 e caiu a ~5 depois de
as outras sessões terminarem; **só então** rodei a suíte integral (uma vez).

### 2.2 `ReportCache` (TTL de 50 ms) — diagnóstico

Causa: o teste media **carga de máquina**, não o TTL: a expiração é `relógio() + ttlMs` calculada **antes** da busca, e sob carga a 1ª
chamada leva mais de 50 ms reais → o "cache hit" da 2ª chamada falhava (`2 !== 1`). Correção **sem sleep**: `createReportCache` aceita
um relógio injetável (`agora`, padrão `Date.now`; comportamento de produção idêntico) e o teste usa um relógio controlável
(`+49 ms` → ainda em cache; `+2 ms` → expirou). 35/35 no arquivo. Nenhum outro sistema foi refatorado.

### 2.3 Gate de CI (`.github/workflows/ci.yml`) — roteiro de PR (nada disso foi executado remotamente)

Jobs (PR → `main`): `changes` (classifica o diff; `suites.mjs verify --shards 4 --pure-shards 2`) → `contracts` → `panel-pure` ×2 (sem
banco) → `panel-db` ×4 sob `oria_app` (Postgres 16 próprio por job) → `panel-migrations` (do zero + idempotente; **este diff não tem
migration**) → `panel-build`. Node 22, Go 1.25. Verificado **localmente**: `suites.mjs verify` (131 arquivos: 63 sem banco, 68 com banco),
`check-contracts`, `repo:self-check`, `tsc -b --noEmit`, `npm run build`.

Roteiro (depende de **autorização explícita** do proprietário para publicar a branch):
1. Confirmar autoria `gatomazi` (regra do projeto) e o remote HTTPS autorizado; **não** usar `gtomazi`.
2. `git push -u origin feature/clientes-rfm` → abrir PR contra `main` (título: "Clientes 360°/RFM, segmentos e Audiência exata"); corpo com
   `docs/features/oria-clientes-rfm-rodada{5,6}.md` e a lista de pendências.
3. Aguardar `CI` (workflow do PR): `changes`, `contracts`, `panel-pure 1/2 e 2/2`, `panel-db 1..4/4`, `panel-migrations`, `panel-build`.
4. Só com **todos os jobs verdes** considerar merge; `Full Verification` roda em `main`. "Local verde" ≠ "CI verde".

Comando reproduzível para máquina estável (suíte integral): `cd apps/panel && TEST_PG_CONTAINER=<nome-exclusivo> npm test`. Equivalente ao CI
(fatias): `node scripts/ci/panel-suite.mjs --group pure --shards 2 --index N` e `--group db --shards 4 --index N --app-role` com
`TEST_DATABASE_URL` apontando para um Postgres **próprio** por fatia.

### 2.4 Resultado da suíte integral

**Uma** execução integral (`npm test`, container próprio `oria-r6-full`, sem app-role) sobre `f82db77`, com o load da máquina entre 4 e 29:
**1.952 testes · 1.951 passaram · 1 falha · 0 cancelados · 0 ignorados.** A falha: negative control `STORE-02` (`connector/chamador-exige-loja-legada`),
reprovado no **passo 1 (estado correto)** por `fase4-server-integrations › INV-12 · requests intercaladas e concorrentes não cruzam credenciais`,
que conta chamadas ao provider mock por token e viu **5 em vez de 4** para o token da Org A: uma chamada a mais de um job de fundo dentro da janela
de medição (mesma classe da falha "abrir Integrações disparou chamada a provider externo" vista na Rodada 5). Não envolve RFM/Audiência. Isolado, o
teste e o controle **passam** (9/9: o controle `STORE-02`, 5 controles INV-12 e os 2 testes INV-12; ver §5). **Não** reexecutei a suíte
integral só para repetir; **não há suíte integral 100% limpa** sobre o HEAD final.

---

## 3. Entrega C — preparação da calibração real (sem leitura de produção)

`docs/operations/rfm-calibracao-runbook.md` revisado: (a) CLI conferida na Rodada 5 contra o banco sintético (todas as flags; recusa
fora de localhost sem `--confirmo-host` **antes** de conectar); (b) checklist de acesso (réplica/role somente leitura, `DATABASE_URL`
só no terminal de quem executa, UUID da Organization, destino fora do Git); (c) **novo:** tabela das **cinco decisões** do relatório real —
(i) backfill e `paid` + pedido encerrado, (ii) reembolso parcial, (iii) recompra, (iv) soma × ticket médio e **Leais**, (v) volume/carga para
snapshot — cada uma apontando a seção do relatório e o que fazer sem dado real; (d) **novo:** seção 8 do relatório ("Volume e custo desta
execução": pedidos lidos, compradores, tempo de leitura e de cálculo medidos na máquina de quem executa, com o aviso de que **não** é a
carga do servidor) para subsidiar a decisão (v). Sem acesso real: **bloqueio documentado, regra inalterada**. Nenhum secret foi
procurado; nada do Railway foi tocado.

---

## 4. Decisões preservadas (nada alterado)

RFM `rfm-v1:c35267c2` · 45/90/180/365 · P75 da soma · janela 365 · opção A (sem B) · regra de `payment_status` (limitações exibidas) ·
`pre-commit` global intocado (usa-se `PRE_COMMIT_ALLOW_NO_CONFIG=1`, nunca `--no-verify`; sem `.pre-commit-config.yaml`) · sem snapshots/
job diário/cache novo.

---

## 5. Testes realmente executados e commits

| Execução | Resultado |
|---|---|
| `campanhas-audiencia-filtros` (novo, puro) | 62/62 (detector: 56/62 com o defeito, 62/62 restaurado) |
| Puros relacionados (`clientes-*`, `campanhas-*`) | 166/166 (+ `clientes-calibracao` 23/23 com o teste novo) |
| HTTP com RLS/2 Organizations (`clientes-rfm-http` 29 + `operacao-store-nativa` 25) | 54/54 (detector HTTP: 3 reprovam com o defeito) |
| `product-performance-service` (ReportCache com relógio injetável) | 35/35 |
| Playwright `qa-rfm-r6` (1440 + 390) · `qa-rfm-audiencia` (1440/390/320) · `smoke-viewport` (390) | 36/36 · 57/57 · 38/38 (2×) |
| `tsc -b --noEmit` · `npm run build` · `check-contracts` · `repo:self-check` · `suites.mjs verify` | limpos/OK (131 arquivos: 63 sem banco, 68 com banco) |
| Alvos dos 124 negative controls | todos presentes exatamente 1× |
| **`npm test` integral** (única, sobre `f82db77`) | **1.952 · 1.951 · 1 falha (STORE-02 ← INV-12, temporização de job de fundo) · 0 cancelados** |
| STORE-02 + controles/testes INV-12, isolados | 9/9 |

**Commits locais** (todos em `feature/clientes-rfm`; nada enviado): `58bc4da` motor fail-closed + revisão de segmento aproximado + `ReportCache` com
relógio injetável · `58aadb0` esperas pela prévia assentada nos scripts Playwright · `f82db77` seção de volume/custo no relatório de calibração +
runbook das cinco decisões · (este documento). Rodadas anteriores: `fcca228`…`105ac1c`.

**Status do CI: não executado.** "Local verde" (acima) ≠ "CI verde": CI remoto exige push, que depende de autorização explícita.

## 6. Quadro: corrigido / testado / bloqueado por autorização / decisão futura

| | Itens |
|---|---|
| **Corrigido** | Campo/operador/tipo/valor/`match`/exclusões validados por um contrato único em prévia, Revisão, criação/edição e envio/agendamento · condição inválida nunca alarga o público (`AUDIENCIA_FILTRO_INVALIDO`) · audiência universal só explícita (`todosClientes`) · lista vazia = `AUDIENCIA_SEM_FILTRO` · linha incompleta do front não é mais descartada · Revisão reavalia ao entrar **e** antes de Agendar/Enviar · segmento RFM legado exige confirmação/recriação antes de executar · TTL do `ReportCache` testável sem sleep · negative controls sem alvo quebrado · relatório de calibração ganha volume/custo |
| **Testado** | 62 puros + 5 HTTP novos (RLS, 2 Orgs, legado inválido no banco, aproximado) + 36 Playwright novos + regressões; detectores negativos (puro e HTTP) com defeito deliberado e restauração; compat dos filtros legados válidos; suíte integral 1.951/1.952 (1 falha de temporização, isolada verde) |
| **Bloqueado por autorização** | Acesso de leitura à base real e calibração (limiares, corte soma × ticket, Leais, backfill, `paid` + encerrado, reembolso parcial, decisão de snapshot) · push/PR/CI remoto/merge/deploy |
| **Decisão futura** | Opção B do corte de valor (com snapshots) · snapshots/materialização e job diário (só com volume/carga reais) · política de `paid` + pedido encerrado e reembolso parcial · `.pre-commit-config.yaml` no projeto (hoje a política é o CI) · migrar segmentos legados (hoje: recriação explícita, caso a caso) · teste INV-12 de contagem de chamadas sensível a job de fundo (sistema alheio) |

**Release não liberado:** faltam calibração com acesso autorizado, uma suíte integral 100% limpa em máquina estável e o CI remoto verde.
