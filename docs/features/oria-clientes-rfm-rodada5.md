# Clientes/RFM — Rodada 5: mesma população da matriz até a campanha, financeiro, desempenho e gate de CI

Branch local `feature/clientes-rfm`. **Nada foi enviado**: sem push, merge, deploy, CI remoto, envio de WhatsApp/e-mail, campanha real,
sync/backfill de produção nem leitura de dados reais. **Não** mudaram: limiares 45/90/180/365, P75 da soma, janela de 365 dias,
`rfm-v1:c35267c2`, política A (corte de valor materializado), snapshots, job diário. Toda massa, fixture e captura desta rodada é
**sintética** e fica em `apps/panel/relatorios-privados/rfm-r5/` (ignorado pelo Git, sem PII).

Estado de partida verificado (não presumido): `HEAD 9b4ee29` = fim da Rodada 4, árvore limpa, nenhum processo/container meu ativo.

---

## 1. Da pedido à audiência: o caminho, os universos e as invariantes

```
pedidos_ink (uma Store, RLS)
  └─ ordem canônica (criado_em ↓, ink_order_id ↓) + dedup por ink_order_id               lib/clientes/analise.js
      └─ identidade única (documento | telefone | e-mail, transitivo, por loja)           lib/clientes/identidade.js
          ├─ RFM: pedido válido → R (dia de calendário, fuso da Org), F (365 d), V (soma)  lib/clientes/rfm.js
          │        └─ segmento (regra 1ª que casa) ── matriz de Clientes / lista / drawer
          └─ agregado de Campanhas (herdado): compra = pagamento convertido, inclui troca,
                                              histórico inteiro, 24 h corridas             lib/clientes/agregado.js
segmento salvo (segments.filtros)  ──►  Audiência (prévia = disparo)                       server.js avaliarAudienciaCampanha
   · antes: 4 filtros genéricos (diasSemComprar, quantidadePedidos, totalGasto)  → população APROXIMADA
   · agora: 1 filtro `rfm` (predicado + corte SALVO + regra)  → população EXATA (mesma classificação da matriz)
        └─ condições adicionais → exclusões de contato (opt-in → telefone válido → comprou recentemente → cooldown)
```

**Universos (nunca somados):** *pessoas com pedido* ⊃ *compradores válidos* (a RFM) ⊃ *segmento*; o cadastro remoto da Ink é um
quarto conjunto, só quando a Ink responde e nenhum filtro exige pedido. **Elegibilidade comercial** (pertencer ao segmento pela RFM)
≠ **elegibilidade de contato** (opt-in, telefone, cooldown): a segunda só atua depois e cada excluído tem exatamente um motivo.

| # | Invariante | Onde é provada |
|---|---|---|
| I1 | Para cada um dos 11 segmentos, Audiência exata = matriz (mesmo conjunto de pessoas, por rótulo opaco), e os 11 particionam os compradores válidos | `clientes-audiencia-rfm.test.js` (equivalência global); HTTP `ida e volta` |
| I2 | Fronteiras 45/90/180/365: no limite fica na faixa; +1 dia na seguinte | 4 casos por tabela |
| I3 | 23:59 → 00:01, virada de mês e de ano: RFM conta dia de calendário local; o filtro genérico (24 h) diverge exatamente em quem está em 45/46 dias | 3 casos por tabela (relógio e fuso controlados) |
| I4 | Troca paga: RFM exclui, genérico inclui; compra + troca: RFM vê 1 pedido, genérico 2 | teste dedicado |
| I5 | Quem só tem pedido **cancelado** nunca é "Perdidos" (genérico incluía: `diasSemComprar` nulo casa com "há mais de N dias") | teste dedicado; reproduzido no banco sintético (0 × 20) |
| I6 | Pedido duplicado (mesmo `ink_order_id`): conta um na RFM e na via exata; o legado cru contaria dois | teste dedicado |
| I7 | Identidade compartilhada (documento/telefone/e-mail, transitiva) = 1 pessoa; mesmo documento em lojas diferentes = 2 | 2 testes |
| I8 | P75 muda **sem** mudar `regraVersao`: o segmento salvo continua com o corte salvo, a divergência é declarada, o filtro salvo não é reescrito | unitário + HTTP `corte materializado` |
| I9 | Só o tempo passando não move o corte de valor; a recência é reavaliada a cada uso | unitário |
| I10 | 0, 1, 2, 3, 5+ compras; valor exatamente no corte (≥ = alto); segmento com 0 compradores = conjunto vazio, sem erro | unitário |
| I11 | Filtro RFM em erro (forma inválida, regra que mudou, base insuficiente, junção inconsistente, mais de um filtro) **lança** `ErroAudienciaRfm` → 409 acionável; nunca "todos os clientes" | 11 formas inválidas + 4 códigos; HTTP |
| I12 | O filtro `rfm` é **obrigatório** mesmo com `match: ANY` | HTTP |
| I13 | Exclusões de contato só depois; opt-in e telefone batem com a lista de Clientes; `matched` não muda com elas | HTTP |
| I14 | Multi-tenant: o mesmo filtro avaliado na Org B usa só a base da B | HTTP |
| I15 | Prévia × revisão: reavaliar após um pedido novo muda a população **e** o `asOf`; nada é disparado | HTTP + Playwright |

Detector: um teste com o limite de recência deslocado em 1 dia reprova (o teste percebe a divergência). **Defeito deliberado
no código**, restaurado depois: (a) `casaPredicado(..., k.r − 1, …)` → 10 dos 45 testes puros reprovaram; (b) desligar a
checagem de `regraVersao` → o teste HTTP "filtro RFM em erro" reprovou. Restaurados, 45/45 e 23/23.

### 1.1 Inconsistências encontradas (e como foram reproduzidas)

1. **Calendário × 24 h** — reproduzido com relógio controlado: pessoa com compra às 23:59 do dia 9/8 e `asOf` 00:01 do dia 24/9 está a
   46 dias de calendário (Aguardando recompra) mas a 45 dias e 2 min corridos (dentro de "≤ 45", Novos) no filtro genérico.
2. **Troca paga** conta como compra nos filtros genéricos e não na RFM.
3. **Janela de 365 dias / duplicados** — o genérico soma todo o histórico e conta linhas duplicadas duas vezes.
4. **"Só cancelado" em Perdidos** — reproduzido no banco sintético: matriz 0 × Audiência genérica 20 (as 20 identidades só com pedido
   cancelado). É pior que "diferença de fronteira": inclui gente que **nunca comprou** como "perdida".
5. **Filtro descartado em silêncio** — o motor genérico filtra campos desconhecidos (`AUDIENCIA_CAMPOS_FILTRO`) e, sem filtros
   válidos, devolve **todos**; o construtor do front descarta filtros que não consegue parsear. Um filtro RFM que não fosse entendido
   viraria "todos os clientes".
6. **Revisão com prévia envelhecida/erro engolido** — a Revisão exibia a prévia da etapa Audiência (foto de um instante anterior);
   ao editar uma campanha, `previewAudiencia(...).catch(() => {})` engolia o erro; se a prévia falhava, ficava "Calculando…".
7. **Segmento RFM salvo + "Montar filtros manualmente"** deixava a condição RFM oculta atrás de um seletor que dizia "manual".

### 1.2 Corrigido × apenas documentado

| Item | Situação |
|---|---|
| Divergências 1–4 | **Corrigidas** para segmentos de origem RFM por uma via específica (filtro `rfm`), sem tocar os filtros genéricos |
| Descarte silencioso (5) | **Corrigido** para o filtro RFM (erro 409 tipado; obrigatório; um só). O descarte de campos desconhecidos nos filtros **genéricos** legados foi **mantido** (não alterar campanhas antigas) e fica registrado como risco |
| Revisão (6) e seletor (7) | **Corrigidos** no front (reavalia ao entrar e antes de confirmar; erro verdadeiro bloqueia "Agendar"/"Enviar"; guarda contra resposta fora de ordem) |
| Segmentos RFM já salvos com filtros genéricos | **Preservados como estão**, marcados "avaliação aproximada" (Segmentos e Audiência) com a saída "Criar segmento com avaliação exata" (cria um novo; o antigo não é reescrito) |
| Política de `paid` com pedido encerrado; reembolso parcial | **Documentadas** (§2), não alteradas |
| Opção B (recalcular o percentil na prévia/execução) | **Não** implementada |

### 1.3 Contrato do filtro persistido (opção A preservada)

`{ field: 'rfm', op: 'segmento', value: { segmento, regraVersao, classificadoEm, predicado } }` em `segments.filtros` e
`campaigns.audience_definition.filtros`. **Sem migração** (jsonb; a reutilização de segmento igual só considera segmentos já no
formato exato: `filtros @> '[{"field":"rfm"}]'`).

- `predicado` guarda o corte de valor **salvo**; `corteAtual` (P75 de hoje) só é informado (`divergente`, `pessoasNoSegmentoDeHoje`).
- Mesma classificação (`classificarRfm`), mesmo avaliador (`casaPredicado`), mesmas linhas canônicas (deduplicadas) para a RFM e para o
  agregado de contato; **junção** por `loja + customerKey`; se uma pessoa da RFM não tem par no cadastro → `RFM_JUNCAO_INCONSISTENTE`.
- `regraVersao` salva ≠ atual → `RFM_REGRA_DIVERGENTE` (não avalia com outra regra); base insuficiente → `RFM_AMOSTRA_INSUFICIENTE`.
- Prévia devolve `rfm { universos, asOf, regraVersao, corteSalvo, corteAtual, divergente, pessoasNoSegmentoDeHoje }`.
- Disparo: `iniciarDisparoCampanha` usa o mesmo avaliador; erro RFM → 409 **antes** de criar destinatários (campanha segue em rascunho;
  agendada continua `scheduled` e é retentada a cada ciclo sem gerar destinatário — fail-closed).
- Modificações fora do RFM: extração pura do agregado (`lib/clientes/agregado.js`, com relógio injetável); `buscarClientesAgregados`
  virou leitura + chamada a ele. Comportamento dos filtros genéricos idêntico (testes HTTP de compatibilidade contra uma contagem
  independente seguem verdes).

### 1.4 Contagens RFM → público comercial → elegíveis (massa **sintética**, `seed-sintetico-rfm.mjs`)

Exclusões padrão (opt-in e telefone válido); universo: 1.000 compradores válidos + 20 identidades sem compra válida.

| Segmento | RFM (matriz) | Público comercial (Audiência exata) | Sem opt-in | Sem telefone válido | Elegíveis | Genérico legado |
|---|---:|---:|---:|---:|---:|---:|
| Campeões | 0 | 0 | 0 | 0 | 0 | 0 |
| Leais | 0 | 0 | 0 | 0 | 0 | 0 |
| Potenciais leais | 6 | 6 | 3 | 0 | 3 | 6 |
| Primeira compra de alto valor | 1 | 1 | 1 | 0 | 0 | 1 |
| Novos | 50 | 50 | 25 | 0 | 25 | 50 |
| Aguardando recompra | 169 | 169 | 85 | 0 | 84 | 169 |
| Precisam de atenção | 3 | 3 | 1 | 0 | 2 | 3 |
| Prestes a dormir | 250 | 250 | 125 | 0 | 125 | 250 |
| Em risco | 1 | 1 | 0 | 0 | 1 | 1 |
| Hibernando | 520 | 520 | 260 | 0 | 260 | 520 |
| Perdidos | 0 | 0 | 0 | 0 | 0 | **20** (só cancelado) |
| **Total** | **1.000** | **1.000** | **500** | **0** | **500** | 1.020 |

Nesta massa o legado só diverge em Perdidos; os casos de fronteira/troca/duplicidade que o fazem divergir estão nos testes por tabela
(a massa sintética não tem trocas nem compras a 23:59). Números **não** descrevem a loja.

---

## 2. Financeiro e cobertura — sem calibrar por suposição

### 2.1 Matriz de estados (política **atual**; `test/clientes-status-financeiro.test.js`, 19 casos com 4 consumidores reais)

| `payment_status` / `order_status` | RFM/indicadores/360° | Campanhas (genérico) | Valor usado | Informação ausente | Decisão pendente |
|---|---|---|---|---|---|
| `paid`/`sent` | conta | conta | `total_value` | — | — |
| `free` | conta (valor 0) | conta | 0 | — | — |
| `paid`/`canceled` | **conta** | **conta** | `total_value` | motivo/instante do cancelamento, estorno | **RISCO:** pagamento válido com pedido encerrado |
| `paid`/`returned` | **conta** | **conta** | `total_value` | valor devolvido | idem |
| `paid`/`refunded` (pedido) | **conta** | **conta** | `total_value` | valor reembolsado | idem |
| `refunded` | não | não | — | — | — |
| `Reembolsado` (rótulo PT) | não | não | — | a entrada **não normaliza** o rótulo (só o contador o reconhece) | mapear com amostra confiável |
| `refund_requested` | não | não | — | se concluiu | sai dos dois enquanto só solicitado |
| `partially_refunded` (hipotético) | **não (a pessoa some)** | não | — | **valor reembolsado** | RISCO: nunca se infere o parcial |
| `canceled`, `waiting_payment`, `expired`, `not_authorized`, `awaiting_analysis` | não | não | — | — | — |
| `paid` + troca | não | **conta** | — (RFM) | — | divergência: a Audiência exata segue a RFM |

Valor financeiro: `total_value` (já líquido de desconto **e com frete pago**); frete/desconto separados não são somados de novo;
pedido zerado (`free`) é compra válida com valor 0; sem valor ou sem data, nunca conta. Consumidores validados: `pedidoValido`
(RFM, indicadores, 360°/LTV) e o agregado de Campanhas. A regra global **não** foi trocada por causa de fixture.

### 2.2 Backfill e `backfillConfirmado` (leitura do código, nenhum backfill iniciado)

- `pedidos_backfill_jobs`: `processando` → `concluido` (o laço de páginas terminou sem exceção) ou `falhou`. `concluido` **não** compara
  com a origem: significa "todas as páginas que a API devolveu para `begin_date=desde` foram lidas". Só jobs `concluido` confirmam
  cobertura; `coberturaConfirmadaDias` usa o **menor** `desde` entre eles (testado: `falhou`/`processando` não confirmam).
- Reexecução/backfill parcial: o upsert é idempotente por `(org, store, ink_order_id)`, mas **sobrescreve** `payment_status`,
  `order_status`, `total_value` e demais campos com o estado atual da Ink (um pedido antigo pode passar de `paid` a reembolsado); itens
  são apagados e regravados; `is_troca` preserva o valor anterior quando o novo é nulo. Um job que `falhou` a meio deixa as páginas já
  gravadas (dado real sem cobertura confirmada). O backfill não toca `sync_estado` (cursor do sync incremental).
- Pendente (só o dado real fecha): a semântica exata de `begin_date` na API da Ink (criação × atualização) e se pedidos encerrados
  aparecem nas páginas.

### 2.3 Textos revistos ("completo", "líquida", "recompra", "Perdidos")

- "Receita líquida" (coluna) → **"Valor pago"**; "LTV líquido" → **"LTV (valor pago)"**; "Total líquido" (pedido) → **"Conta no LTV"**:
  o valor é líquido de desconto e **inclui frete**, e não desconta reembolso parcial.
- Tooltip de Faturamento/Pedidos válidos: agora diz que o critério é **pagamento confirmado**, que a situação do pedido
  (cancelado/devolvido) **não é considerada** e que reembolso parcial não é descontado.
- "Dados completos": só existe em frases que **negam** completude ("não trate como o histórico completo"); "recompra" tem denominador
  declarado no tooltip; "Perdidos" explica a exigência de > 365 dias de histórico.

### 2.4 Calibração real — status

Nenhuma leitura real e **nenhum** acesso a `DATABASE_URL`/Railway. `docs/operations/rfm-calibracao-runbook.md` conferido com a CLI:
`--listar-organizacoes`, `--organization`, `--store`, `--as-of`, `--json`, `--md`, `--confirmo-host` funcionam como descrito contra o
banco **sintético local**; fora de localhost e sem confirmação, recusa **antes** de abrir conexão. Checklist de acesso adicionado (§6
do runbook).

---

## 3. Desempenho — benchmark **local**, massa sintética (não é produção)

Ambiente: macOS arm64 (8 núcleos, 16 GB), Node 26.7, Postgres 16.15 em container, painel e banco na mesma máquina, um cliente,
requisições sequenciais, 1 aquecimento + 7 amostras. Massa: `scripts/clientes/benchmark-local.mjs` (SQL determinístico; ~1,6
pedido/comprador, 400 dias, 3% não pagos, 1% troca, 70% com opt-in), volumes 2 mil, 20 mil e 100 mil pedidos. **A máquina estava
compartilhada com outras sessões (load average 30–130):** tempos de parede têm ruído grande (p95 alto); por isso há também um A/B
em processo (abaixo), que é a evidência confiável do ganho.

**Sem N+1:** o nº de consultas SQL por endpoint é **constante** entre 2 mil e 100 mil pedidos (10–27, contando `BEGIN/COMMIT/
set_config` do contexto de tenant). **Sem cache:** um pedido novo altera a leitura seguinte (universo +1); 8 resumos simultâneos
devolvem o mesmo resultado; importação duplicada (1% em linha legada) não altera o universo. Loja vazia: 38 ms; histórico curto: 58 ms.

Endpoints a 100 mil pedidos (mediana / p95 ms; antes = código da Rodada 4 sob carga alta; depois = otimizado):

| Endpoint | antes | depois | CPU depois (ms) | RSS (MB) |
|---|---|---|---|---|
| resumo (indicadores + matriz) | 4046 / 10768 | 2490 / 3393 | 1808 | 290 |
| lista por segmento | 5461 / 8381 | 3946 / 7346 | 2378 | 303 |
| lista sem filtro (p.1) | 3831 / 6954 | 5173 / 6631 | 2617 | 327 |
| detalhe | 4239 / 6178 | 2551 / 2999 | 1695 | 308 |
| estado dos segmentos salvos | 6664 / 10102 | 2282 / 5121 | 1760 | 311 |
| prévia · genérico | 1739 / 2743 | 1122 / 1647 | 778 | 364 |
| prévia · segmento RFM (exata) | 3887 / 7087 | 1784 / 2680 | 1640 | 437 |

(2 mil pedidos: 95–200 ms por endpoint; 20 mil: 0,5–1,5 s. As colunas "antes/depois" a 20 mil ficaram **invertidas por ruído**
de carga — não interprete como regressão; o A/B abaixo mostra ganho.)

**Onde o tempo vai (perfil em processo, 100 mil pedidos):** a leitura SQL é ~200 ms (`EXPLAIN ANALYZE`: seq scan + sort externo; sem
necessidade de índice — não houve mudança de schema); o resto é JavaScript: `classificarRfm` dominava (formatar datas com `Intl`
por uso), seguido do sort canônico (reparse de data por comparação).

**Gargalos corrigidos (baixo risco, resultado idêntico):** (1) dia de calendário de `asOf` calculado uma vez e o de cada compra uma
vez (em vez de por uso); (2) ordem canônica com chave pré-calculada. **A/B no mesmo processo** (`analisarRfm`, alternando antiga ×
nova, 6 rodadas, massa de 3.000 dias): **20 mil pedidos 280 → 141 ms (×1,98); 100 mil 1.584 → 848 ms (×1,87).**
Equivalência provada por hash contra a saída do código antigo (`clientes-rfm-equivalencia.test.js`: 300/5 mil/40 mil pedidos,
horário de verão de SP 2018/19, viradas de dia locais, ids duplicados).

**Gargalo que permanece (não corrigido de propósito):** cada endpoint relê todos os pedidos e reclassifica (O(N) por requisição); a
página de Clientes dispara vários. A 100 mil pedidos cada chamada custa 1,7–2,6 s de CPU do processo único do Node. A correção
estrutural é materializar (snapshots) — decisão do proprietário, fora desta rodada; nenhum cache/snapshot foi introduzido.

---

## 4. Higiene e gate de CI

### 4.1 Hook `pre-commit`

Diagnóstico verificado: o `core.hooksPath` vem de `~/.gitconfig` (**global do desenvolvedor**) e aponta para
`~/.config/git/hooks/{pre-commit,post-commit}`, scripts **templated do framework pre-commit** (`hook-impl --config=.pre-commit-config.yaml`).
O repositório **não tem** `.pre-commit-config.yaml` (nem husky/lint-staged). Sem essa config, o hook falha com "config file not found"
a menos que `PRE_COMMIT_ALLOW_NO_CONFIG=1` (variável documentada do próprio framework) seja definida: **nenhuma verificação definida
pelo projeto é pulada**, porque não há nenhuma para rodar; nunca se usou `--no-verify`. **Decisão para o proprietário**, não tomada
aqui (não há padrão claro no projeto e a configuração global não é minha): (a) manter assim, com a política real no CI; ou (b) adicionar
um `.pre-commit-config.yaml` que rode `repo:self-check` e `check-contracts`. Configurações globais **não** foram tocadas.

### 4.2 Gate de CI (revisável; nenhum CI remoto foi iniciado)

`.github/workflows/ci.yml` (PR → `main`): `changes` (classifica o diff e verifica o particionamento dos shards) → `contracts`
(`check-contracts`, `repo:self-check`) → `panel-pure` ×2 (sem banco) → `panel-db` ×4 sob `oria_app` (Postgres 16 **próprio por job**,
`TEST_DATABASE_URL` não secreta) → `panel-migrations` (do zero + idempotente) → `panel-build`. Node 22, Go 1.25. Isolamento: cada job
com seu Postgres; paralelismo só entre jobs. Timeouts/estratégia: ver o workflow e `scripts/ci/weights.json`.

Verificado **localmente** nesta rodada: `suites.mjs verify --shards 4 --pure-shards 2` OK (130 arquivos: 62 sem banco, 68 com banco — os
novos testes puros caíram no grupo sem banco); `check-contracts` OK; `repo:self-check` OK; `npm run build` (tsc + vite) OK. Diff **sem
migration**. Execução das fatias: ver §6.

---

## 5. UI — Rodada 4 preservada; só o necessário

Explorer, painel, paleta e componentes **não** foram refeitos. Mudanças funcionais: cartão do segmento RFM na Audiência (condição
obrigatória, somente leitura, com regra, versão, data e universos), motivos de exclusão, aviso de corte defasado (salvo × hoje),
"avaliação aproximada" para segmentos antigos, Revisão que reavalia ao entrar e antes de confirmar (com o erro verdadeiro e bloqueio de
"Agendar"/"Enviar"), guarda contra resposta fora de ordem, "manual" que zera a condição RFM, contraste AA de uma nota em callout.

QA Playwright (sintético; **nunca** clica em Enviar/Agendar/Salvar): `qa-rfm-ui.mjs` (Rodada 4, regressão) **158/158**;
`qa-rfm-audiencia.mjs` (nova; Explorer → CTA → Audiência → Revisão em 1440, 390 e 320) **57/57**, incluindo resposta lenta/fora de
ordem, erro 409 da prévia, troca de segmento sem resquício da regra anterior e axe sem `serious/critical`; `smoke-lista` **13/13**;
`smoke-viewport` (390) **38/38**. Todos os 11 segmentos seguem com nome legível, inclusive zeros e < 0,1%.

---

## 6. Testes, commits e pendências

(Preenchido ao final da rodada — ver a seção "Rodada 5" de `oria-clientes-rfm-fase0.md` e o relatório executivo.)
