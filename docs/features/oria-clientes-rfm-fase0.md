# Clientes 360°, RFM e campanhas — Fase 0 (auditoria) e estado da rodada

Data: 2026-09-23 · Branch `feature/clientes-rfm` · Brief: `oria_clientes_rfm_campanhas.md`.
Referência funcional: painel da Reserva Ink (capturas) — **nada foi copiado**: visual, regras e nomes são do Oria.
Fonte de dados verificada no repositório; nenhum dado do painel Ink foi usado, e nenhum endpoint foi presumido.

## 1. O que existia

| Peça | Onde | Observação |
|---|---|---|
| Página Clientes | `src/pages/clientes/ClientesPage.tsx`, `src/api/clientes.ts` | lista paginada no servidor; sem indicadores, RFM nem drawer |
| Lista/filtros | `lib/clientes/lista.js` (`GET /api/admin/clientes/lista`) | busca, ordem, inatividade, `tipo` (com pedido / só cadastro) |
| Cadastro Ink | `lib/clientes/cadastro.js` → `GET /v1/stores/customers` | remoto, paginado, cache 5 min por Store |
| Agregado por cliente | `buscarClientesAgregados()` (server.js) | union-find por documento/telefone/e-mail; alimenta Campanhas |
| Pedidos | `pedidos_ink`, `pedidos_ink_itens` | cache local (webhook + sync horário + backfill), escopo `organization_id` + `store_id` |
| Campanhas / Segmentos | `segments`, `campaigns`, `campaign_recipients`; `AudienceBuilder` | segmento = definição de filtro **dinâmica**; motor de audiência já calcula elegíveis (opt-in, número, cooldown) |
| Design system | `src/components/ds/*`, `DESIGN.md` | dark, cor semântica; Drawer, KpiStrip, DataTable, Callout |
| Backfill | `pedidos_backfill_jobs`, `POST /api/admin/pedidos/backfill-historico` | existe; a tela agora declara o estado dele |

## 2. Inventário de dados

| Dado | Situação | Fonte de verdade | Risco |
|---|---|---|---|
| Pedido (id, data, status, total, frete, desconto) | **Disponível** | `pedidos_ink` | cobertura depende de sync/backfill (declarada na tela) |
| Itens do pedido (produto, modelo, cor, tamanho, qtd, valor, desconto rateado) | **Parcial** | `pedidos_ink_itens` | pedido antigo sem itens gravados → soma vira `—` |
| Imagem do produto | **Indisponível** | não vem no payload de pedido da Ink | placeholder na tela, sem URL inventada |
| Reembolso total | **Disponível** | `payment_status = refunded` | — |
| Reembolso parcial | **Indisponível** | só há auditoria dos feitos pelo painel | LTV pode superestimar; declarado na tela e nas lacunas |
| Identidade do cliente | **Disponível (heurística)** | documento/telefone/e-mail, transitivo | duas pessoas da mesma família podem virar uma; `motivosDeUniao` explica o merge |
| Consentimento | **Parcial** | `accepts_marketing` do checkout | não há opt-in/opt-out por canal nem supressão própria |
| Telefone/e-mail válidos | **Disponível** | pedido | qualidade do dado |
| UF | **Disponível** | `buyer_uf` (endereço de entrega) | ausente em pedidos antigos |
| Produto/categoria por cliente | **Parcial** | itens | fora dos filtros nesta rodada |
| WhatsApp 1:1 pelo Oria | **Indisponível** | só campanhas (templates) | botão do drawer abre `wa.me` externo e diz isso |
| E-mail pelo Oria | **Indisponível** | sem provedor | `mailto:` rotulado como abrir app |
| Meta Custom Audiences | **Indisponível** | não configurado | V3, fora da rodada |
| Timezone da Organization | **Parcial** | não há campo; usa `America/Sao_Paulo` | igual ao dashboard financeiro |

Observado × inferido: pedido, itens, status, UF e consentimento são **observados**. Segmento RFM, LTV, recorrência e identidade unificada são **derivados** e vêm com versão, data de referência e cobertura.

Divergência conhecida (herdada, não alterada): o motor de audiência de Campanhas conta pedido de **troca** paga como compra e mede recência em 24h corridas; a RFM exclui troca e conta dias de calendário. A tela avisa (`observacoes`) ao salvar o segmento.

## 3. Decisões financeiras

- **Pedido válido**: `payment_status ∈ {paid, succeeded, free}`, não é troca, com data e valor. Cancelado, expirado, pendente, reembolsado por inteiro e troca ficam fora.
- **Valor**: `total_value` (já líquido de desconto; inclui o frete pago pelo cliente). A Ink fecha `total = Σ itens + frete − desconto` (validado em 152/152 pedidos, `lib/ink/financeiro.js`), então o subtotal do pedido é derivado disso e **conferido** contra os itens gravados (`conciliado`).
- **Faturamento/indicadores**: todos do mesmo universo (pedidos válidos com identidade, Store do contexto, período). Pedido sem documento/telefone/e-mail fica fora de todos e é contado em `cobertura.pedidosSemIdentidade`.
- **Taxa de recompra**: clientes com ≥2 pedidos válidos **no período** ÷ clientes compradores do período.
- **Comparação**: só quando o histórico sincronizado cobre o período anterior inteiro.

## 4. RFM `rfm-v1` (próprio, não reproduz regra de terceiros)

- R: dias de calendário (fuso da Organization) desde a última compra válida até `as_of`. F: pedidos válidos na janela (365 d). M: valor pago na janela. LTV = sem janela.
- Segmentação por **regras** (recência em faixas 45/90/180/365 dias; frequência; valor alto = P75 entre quem tem M>0), não por quantis de F/M, porque em base de baixa recompra quantis colocariam quem comprou 1× ao lado de quem comprou 10×.
- 11 segmentos exclusivos e exaustivos (provado por teste em toda a grade): Campeões, Leais, Potenciais leais, Primeira compra de alto valor, Novos, Aguardando recompra, Precisam de atenção, Prestes a dormir, Em risco, Hibernando, Perdidos. Nomes e limites são **padrões a validar contra a distribuição da base real** (estão configuráveis).
- `Dados insuficientes` quando a base tem <30 clientes ou <90 dias de histórico.
- Notas 1–5 (R e M por quintis; F por contagem) são só leitura relativa; empates caem sempre na mesma nota.
- `as_of` (data de classificação) não muda com o período dos indicadores.

## 5. Entregue nesta rodada

**Fase 1/2 (dados + engine)** — completo no que foi escopado:
`lib/clientes/{identidade,rfm,metricas,analise,segmento,detalhe,exportacao}.js`; regra de identidade única extraída de `buscarClientesAgregados` (comportamento preservado); migration `0034` (origem/política/predicado/versão/data no segmento).
Endpoints: `GET /api/admin/clientes/resumo`, `POST .../detalhe`, `POST .../exportar`, `POST .../segmentos`; `lista` ganhou segmento, faixas, datas, UF, consentimento.

**Fase 3/4 (frontend)**: indicadores, matriz treemap, tabela de distribuição, filtros avançados com URL compartilhável (sem PII), chips, drawer 360°, exportação.

**Fase 5 (parcial, V1)**: segmento dinâmico salvo a partir da RFM ou dos filtros, dedupe por regra, ligação a `Campanhas > Nova campanha` (`?segmento=ID`), origem visível em Segmentos, exportação CSV protegida.

## 6. Não feito / próximos incrementos

- **Snapshots versionados** persistidos e job diário de recálculo: a RFM é calculada sob demanda (com `versao` + `asOf` no retorno). Sem cache; para centenas de milhares de pedidos, medir e materializar.
- **Segmento congelado** (snapshot com data): só dinâmico por enquanto (`politica` restrita a `dinamico`).
- Reembolso parcial por cliente; opt-in/opt-out e supressão por canal; histórico de mensagens/respostas/conversões por cliente.
- Ações do drawer "Adicionar ao segmento" e "Excluir de campanhas": segmento é regra, não lista manual; fica para quando houver lista de supressão.
- Envio massivo WhatsApp (V2), Meta Custom Audiences (V3), produto/categoria e atribuição de receita (V4).
- Validar limites de recência e P75 contra a distribuição da base **real** (a Fase 0 não leu dados de produção).
- `docs/checklist-nova-tela.md` é citado em `.claude/rules/admin-nova-tela.md` mas não existe no repositório.

## 7. Segurança e privacidade

- Organization/Store vêm do contexto da sessão, nunca do request; RLS ativa; testes com duas Organizations (404 cruzado no detalhe, segmento isolado).
- Ver contato de um cliente e exportar são auditados **antes** da resposta (falha na auditoria = nada devolvido); o `audit_log` guarda hash da chave e só a contagem/nomes dos filtros.
- Chave do cliente (CPF/telefone/e-mail) nunca vai na URL (detalhe é POST); busca e cliente aberto não entram na query string.
- CSV sem CPF, com proteção contra fórmula (`=`, `+`, `-`, `@`) e confirmação da quantidade vista na prévia.
- O predicado do segmento é recalculado no servidor; campos extras enviados pelo navegador são ignorados.
- Nenhum disparo ao abrir o drawer; botões de canal só ficam clicáveis com rota real e dizem que não enviam pelo Oria.

---

# Rodada 2 — calibração da RFM e validação ponta a ponta (2026-09-23)

Branch `feature/clientes-rfm`, a partir de `d6df73f` / `17ecb9d` / `5e3ac21`. Sem push, merge, deploy, snapshot, job diário ou disparo.

## 1. Base real: não acessada — nenhum limiar foi alterado

Esta rodada **não teve acesso autorizado à base real** (o painel de produção não roda esta branch e não há credencial de banco de produção na sessão), e o banco local só contém dados **sintéticos** gerados por mim (`~2.600` pedidos aleatórios). Distribuição sintética não prova nada sobre a loja, então **nenhum número de calibração real é apresentado aqui e nenhum limiar foi trocado**: a regra continua `rfm-v1` com 45/90/180/365 dias, P75 da soma, janela de 365 dias.

Entregue no lugar: o relatório reproduzível, somente leitura e anonimizado.

```bash
# Somente leitura: sessão READ ONLY no servidor + BEGIN READ ONLY; escopo = Organization/Store informadas.
DATABASE_URL='postgres://<usuario-somente-leitura>@<host>/<banco>' \
  node apps/panel/scripts/clientes/rfm-calibracao.mjs \
    --organization <uuid-da-organization> [--store <uuid-da-store>] \
    [--as-of 2026-09-23T15:00:00Z] --json calibracao.json --md calibracao.md
```

Ele **nunca seleciona nem imprime** nome, e-mail, telefone ou documento (documento/telefone/e-mail entram só em memória para unir pedidos da mesma pessoa). A saída é agregada (contagens, quantis, somas) e amostras limítrofes com rótulo opaco aleatório (`c_ab12cd34`, diferente a cada execução). Lógica pura e testada em `lib/clientes/calibracao.js` (`test/clientes-calibracao.test.js`). Rodei o script contra o banco local sintético **só para provar que ele executa** (integridade, distribuições, regra atual, recompra, alternativas, amostras e conferências saem; sem exceção).

O relatório traz, nesta ordem: (1) integridade das linhas (duplicidade por `ink_order_id`, sem data/valor/identidade, valor ≤ 0, cruzamento `payment_status × order_status`, status de pagamento **não reconhecidos**, pagamento válido com pedido encerrado); (2) universo e distribuições de recência, frequência (concentração de clientes de 1 compra), LTV, ticket e concentração de receita; (3) a regra atual por segmento (clientes, %, pedidos, receita, ticket, **mediana** de recência e frequência) e a estabilidade perto dos cortes (±3 dias / ±5%); (4) o comportamento de recompra da própria loja (intervalo entre compras e "% que recomprou em até 30/60/90/180 dias" só entre quem já teve tempo — sem viés de censura); (5) oito alternativas, cada uma variando **um** parâmetro, com quantos clientes mudam de segmento e como; (6) amostras limítrofes anonimizadas; (7) conferências de soma.

## 2. Auditoria da regra atual (código real)

| Ponto do brief | Situação verificada |
|---|---|
| Status que entram | `payment_status ∈ {paid, succeeded, free}`, `is_troca = false`, data e valor ≥ 0 presentes (`pedidoValido`). |
| Cancelamento / reembolso | `canceled`, `refunded`, `expired`, `pending` etc. ficam fora. **Reembolso parcial não existe no cache**: só o status final. |
| `order_status` | **Não entra na regra.** Um pedido com pagamento `paid` e `order_status ∈ {canceled, refunded, returned, …}` conta como compra. O relatório mede quantos são; se houver, decidir com o dado (não apliquei sozinho). |
| Valor | `total_value` = Σ itens + frete − desconto (identidade da Ink validada em 152/152 pedidos). É líquido de **desconto** e **inclui o frete pago**. Não há receita "sem frete" nos indicadores. |
| Moeda | A Ink não informa moeda no pedido; assume-se BRL, sem conversão. |
| Fuso / referência | `America/Sao_Paulo` fixo (não há fuso por Organization); recência em dias de calendário; `asOf` = instante da consulta e **não muda com o período dos KPIs**. |
| Sem pedido válido | Fora da RFM, contados à parte (`identidadesSemCompraValida`). |
| Identidade | Documento/telefone/e-mail, transitivo, por Store (1 Organization = 1 Store). Duas pessoas que dividem telefone/e-mail viram uma. Não há identidade entre canais além dessas três chaves. |
| Divergência com Campanhas | O motor de audiência conta troca paga e mede 24h corridas (documentado em `observacoes`); a ida e volta abaixo mede o efeito. |

**Inconsistências encontradas e corrigidas nesta rodada**

1. **Empate de horário** entre pedidos: a chave/nome do cliente (do pedido "mais recente") dependia da ordem de leitura. Agora a ordem é canônica (`criado_em DESC, ink_order_id DESC`), no SQL e na lib.
2. **Pedido duplicado**: as chaves únicas `(org, loja, id)` e `(org, store_id, id)` são independentes, então uma linha legada e uma da Store podem coexistir para o mesmo `ink_order_id` e contar duas vezes. Agora conta uma vez e o excedente sai em `cobertura.pedidosDuplicadosIgnorados`.
3. **Ordem de soma em ponto flutuante**: o mesmo conjunto de pedidos podia render receitas/percentuais diferentes na 15ª casa conforme a ordem. Somas em centavos inteiros (RFM e indicadores).
4. **"Reembolsado" em português**: o rótulo não é mapeado na entrada e ficava fora do contador "pedidos reembolsados" (já ficava fora do faturamento, por não ser `paid`). Agora conta.
5. **Recência "média"** não é a métrica pedida: o resumo passa a trazer a **mediana** de recência e de frequência por segmento (a tela usa a mediana).

## 3. Achados que dependem dos números reais (não resolvidos)

- **"Valor alto" mede a SOMA da janela.** Numa base dominada por clientes de 1 compra, o P75 da soma é um valor de pedido único; quem tem 3+ compras quase sempre o ultrapassa. Consequência **estrutural** (não depende de calibrar): a divisão Campeões × Leais tende a colapsar em "Campeões" e `Leais` fica vazio. Alternativa já disponível e testada: `valorAltoMetrica = 'ticket_medio'` (compara pedido com pedido). **Não foi ativada**; ver §4.
- **Frequência**: por regra, sem quantis (F=1 nunca vira fidelidade; teste dedicado). A nota 1–5 de F é a contagem, sem quantil, para não fabricar diferença entre empates.
- **Cortes de recência 45/90/180/365** e **P75** são padrões, não achados. Sem os intervalos reais de recompra da loja não há critério para trocá-los.

## 4. Opções de calibração e como decidir (sem inventar valores)

Cada opção varia um parâmetro (`ALTERNATIVAS_PADRAO` em `lib/clientes/calibracao.js`); o relatório real diz quantos clientes mudam e para onde.

| Opção | Muda | Efeito esperado | Cuidado |
|---|---|---|---|
| Recência mais curta (30/60/120/270) | Novos/Aguardando/Prestes a dormir encolhem, Hibernando/Perdidos crescem | Reativação mais cedo | mais clientes "em risco" sem evidência de que já pararam |
| Recência mais longa (60/120/240/365) | o inverso | Menos falso alarme | reativa tarde demais |
| Valor alto = P80/P90 da soma | menos "alto valor" | Segmento de proteção mais estreito | corte cai sobre poucos clientes; ver estabilidade |
| Valor alto = ticket médio (P75/P90) | separa valor de frequência | `Leais` deixa de colapsar em `Campeões` | filtro de campanha passa a usar **ticket médio**, não total gasto |
| Janela de frequência 180 d | quem tem 2ª compra antiga cai para F=1 | mais sensível a recorrência recente | histórico curto: janela ≥ histórico é equivalente |

**Critério proposto para escolher, com os números do relatório real** (nenhum foi aplicado ainda):

1. **Recência**: se o relatório trouxer ≥ 30 intervalos entre compras, ancorar "Prestes a dormir"/"Em risco" nos percentis do intervalo (p75/p90) — quem passou do p90 do intervalo típico raramente volta. Se houver < 30 intervalos (esperado com ~5–6% de recompra), **manter 45/90/180/365** e registrar que a amostra não sustenta outra escolha.
2. **Segunda compra**: usar "% que recomprou em até 30/60/90/180 d" (só coortes com ≥ 30 elegíveis) para definir a janela de "Aguardando recompra".
3. **Valor alto**: escolher por **ticket** se o relatório mostrar `Leais` colapsado; conferir `clientesAte5PctDoCorte` (estabilidade) antes de fixar o percentil.
4. **Não** escolher o conjunto que deixa a matriz "equilibrada": só o que os dados e a finalidade do segmento sustentam.

## 4.1 Versão da regra (preparada para snapshots)

`regraVersao = "<algoritmo>:<hash8 da configuração efetiva + tabela de regras>"`, ex.: `rfm-v1:c35267c2` para os padrões atuais. Qualquer mudança de limiar, janela, percentil, métrica ou mínimo muda a versão (teste). Limiares vivem em **um** lugar (`PADROES`/`configuracaoEfetiva`, validados; erro claro se inválidos). A versão vai no resumo (`rfm.regraVersao`, `rfm.configuracao`), na tela e em `segments.rfm_versao` (agora guarda a versão da **regra**, não só a do algoritmo). Nenhum snapshot é persistido.

## 5. Ida e volta com Campanhas (provada)

Teste automatizado (`test/invariants/clientes-rfm-http.test.js`, "ida e volta"), para **cada** segmento com clientes:

1. `POST /api/admin/clientes/segmentos` cria o segmento;
2. lê a **linha do banco** (não a resposta): `origem = rfm`, `politica = dinamico`, `rfm_segmento`, `rfm_versao = regraVersao do resumo`, `classificado_em`, `predicado` idêntico ao do resumo;
3. `filtros` persistidos = tradução do predicado persistido;
4. a prévia de audiência, chamada com os filtros lidos do banco, devolve **exatamente** a contagem de uma avaliação **independente** (recalculada no teste a partir das linhas de pedidos, com a semântica do filtro de audiência);
5. contra a RFM, a diferença é só a documentada (≤ 2 clientes só-troca);
6. `campaigns` e `campaign_recipients` continuam vazias (nada disparado).

O teste **detecta defeito**: alterar o limite superior de recência na tradução (`lte max` → `max − 1`) reprovou; restaurado, passa.

Na tela (`scripts/clientes/smoke-viewport.mjs`, Playwright): o CTA criou o segmento, abriu `Nova campanha?segmento=ID`, o nome veio preenchido, **Avançar → Audiência** mostrou os 4 filtros persistidos com campo, operador e valor iguais aos do banco, e a contagem exibida (`elegíveis / encontrados / excluídos`) foi igual à prévia do servidor com os mesmos filtros (dados locais sintéticos; nenhuma campanha criada).

## 6. 390 × 844 (viewport, com emulação de toque)

Playwright (`isMobile`, `hasTouch`, `deviceScaleFactor 2`); o **viewport** foi redimensionado, não a janela. `scripts/clientes/smoke-viewport.mjs`, **34/34 verificações**:

- página sem rolagem horizontal em indicadores, matriz, painel, filtros, tabela, drawer aberto e Audiência (`scrollWidth 390 = clientWidth 390`);
- KPIs em 2 colunas; treemap 324 px, 9 células, nenhuma coberta por outra (`elementFromPoint`); 11 chips da legenda tocáveis e ≥ 28 px;
- CTA com 290 px, dentro da viewport; botões do painel tocáveis;
- filtros avançados: 14 campos dentro da viewport, ≥ 32 px; tabela com contêiner de 358 px (rolagem só interna), colunas de apoio ocultas, essenciais mantidas;
- drawer 390×844 (tela cheia); ao rolar, **cabeçalho em top 0 e rodapé em bottom 844/844**; 3 botões do rodapé tocáveis e sem sobreposição;
- sem erro de JavaScript. Única resposta ≥ 400 no fluxo: `503 /api/admin/whatsapp-templates` (WhatsApp não configurado no ambiente local; pré-existente, fora desta feature).

Evidências (8 capturas + `resultado.json`, dados sintéticos, sem dado pessoal) em `~/Downloads/oria-clientes-390-evidencias/` — fora do repositório, que não tem pasta de evidências.

## 7. Testes e resultado

**Suítes relacionadas** (Postgres efêmero, role da aplicação, RLS): 200/200 — motor RFM (incl. fronteiras exatas de recência/valor/janela, fuso 23:59×00:00, determinismo com entrada embaralhada, versão da regra, métrica por ticket, duplicidade, empate de horário), métricas, detalhe, CSV, treemap, calibração, lista, migrations, plano/entitlement, `clientes-rfm-http` (13, com duas Organizations e a ida e volta com Campanhas).

**Suíte completa** (`npm test`, incluindo os ciclos de *negative control*, ~2h30 numa máquina compartilhada com outras sessões): **concluiu** — 1.769 testes, 1.764 passaram, **5 falharam**, classificados assim:

| Falha | Natureza | Situação |
|---|---|---|
| `tenancy-migrations` · "banco vazio → todas as migrations" e "rollback das migrations" | **código**: os testes fixam a contagem de migrations (35→36 com a `0034`, criada na rodada anterior e nunca exercitada pela suíte completa) | corrigido (`DEPOIS_DA_FASE1 = 22`); os 2 passam |
| `r19-runbook-dry-run` · conjunto de migrations do pre-deploy da D' | **código**: lista fixa não incluía `1790001900000_segments-rfm` | corrigido; passa (15/15 com o item anterior) |
| negative control `MIDIA-04` e `INK-01` | **infraestrutura**: "o processo não executou nenhum teste" — o filho estourou tempo sob carga (99 s e 83 s no primeiro teste) | reexecutados isolados (fatia 3): **passam** (43 s e 78 s) |

Depois dessas correções **não rodei a suíte completa de novo** (custa ~2h30): a aprovação da suíte inteira, portanto, **não está demonstrada**; o que está demonstrado é a suíte completa com esses 5 itens, os 3 de código corrigidos e revalidados e os 2 de infraestrutura revalidados isoladamente.

## 8. Arquivos e commits desta rodada

- `lib/clientes/{rfm,analise,metricas,segmento,calibracao}.js`, `server.js` (ordem canônica, versão da regra no resumo e no segmento), `src/api/clientes.ts`, `src/pages/clientes/{ClientesPage,SegmentoPanel,rfmTexto}.tsx|ts`;
- `scripts/clientes/rfm-calibracao.mjs` (relatório somente leitura), `scripts/clientes/smoke-viewport.mjs` (390 × 844);
- testes: `test/clientes-rfm.test.js`, `test/clientes-calibracao.test.js`, `test/invariants/clientes-rfm-http.test.js`, contagens de migrations em `tenancy-migrations`/`r19-runbook-dry-run`.
- Commits locais: `5fe90fe` (regra versionada, relatório, testes) e `9d7456c` (contagens de migrations fixadas em testes + esta documentação).

## 9. Riscos que permanecem

1. **Nenhum limiar foi calibrado com dado real.** `rfm-v1` segue com 45/90/180/365, P75 da soma e janela 365 — padrões, não achados. Rodar `rfm-calibracao.mjs` numa réplica/leitura da base real é o passo que destrava a decisão.
2. **Pagamento `paid` com `order_status` encerrado** (cancelado/reembolsado/devolvido) conta como compra. Tamanho desconhecido até o relatório real.
3. **"Valor alto" pela soma** pode esvaziar `Leais` (ver §3).
4. **Reembolso parcial** não é rastreado; **frete** está dentro do valor; **moeda** presumida BRL; **fuso** fixo.
5. Identidade unifica quem divide telefone/e-mail; `Dados insuficientes` depende de ≥ 30 compradores e ≥ 90 dias.
6. Suíte completa não repetida após as correções de contagem (§7).
7. RFM segue calculada sob demanda (sem cache/snapshot); custo cresce com o nº de pedidos.

## 10. Próximo incremento (só depois da calibração real)

Snapshots versionados (`as_of`, `regraVersao`, contagens reconciliáveis) e job diário idempotente; depois, segmento congelado e as ações do drawer (`Adicionar ao segmento`, `Excluir de campanhas`).
