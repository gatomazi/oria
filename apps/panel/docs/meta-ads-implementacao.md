# Meta Ads — implementação (fases 1 a 5)

> Execução de `docs/meta-ads-analytics-integracao-v2.md` §72 a §76.
> Escopo entregue: **backend somente leitura**, card de conexão em Integrações, telas de análise da
> hierarquia, página de Criativos com metas configuráveis, detalhe do anúncio, e o **resultado
> consolidado** com comparação de atribuição.
> Inclui também as **despesas operacionais** (§53X), que fecham o nível 4 do resultado.
> Fora do escopo por enquanto: taxas automáticas vindas do gateway (§53Y) e atribuição por pedido
> (Fase 6).
>
> A ordem não foi acidental: a spec §87 é explícita em "não começar pela UI fake antes do backend",
> e §88 proíbe fechar com qualquer número vindo de mock.

---

## Implementado

**Conexão**
- OAuth 2.0 com Facebook Login (spec §5.2), escopo `ads_read` apenas.
- Token de longa duração (~60 dias) criptografado em AES-256-GCM, com chave derivada do
  `ADMIN_SESSION_SECRET` por HKDF em contexto próprio (`meta-ads-access-token-v1`), separado do
  contexto do Google.
- `appsecret_proof` (HMAC do token com o app secret) em toda chamada server-side.
- Renovação preventiva automática 7 dias antes do vencimento.
- Descoberta das contas de anúncio e seleção de uma conta principal.

**Sincronização**
- Hierarquia completa: campanhas → conjuntos → anúncios → criativos.
- Insights diários (`time_increment=1`) nos quatro níveis: account, campaign, adset, ad.
- Importação inicial de 90 dias, quebrada em janelas de 30.
- Incremental a cada 45 min (hoje + ontem).
- Backfill de atribuição dos últimos 28 dias, a cada 6 h.
- Paginação por cursor, retry com backoff exponencial, timeout, teto de tentativas.
- Log de auditoria de cada sincronização.

**Leitura**
- Agregação por período direto no Postgres, com as taxas recalculadas a partir das somas.
- Comparação com período anterior e semântica de direção por métrica.

**Despesas operacionais (§53X)**
- Cadastro por loja em Financeiro → Despesas, com as categorias da spec.
- Recorrência mensal como uma linha só, expandida na leitura.
- Entram no Lucro Operacional do Resultado.

**Consolidado financeiro e atribuição (Fase 5)**
- DRE em cascata: Receita real → Lucro do Produto → Lucro após Mídia → Lucro Operacional.
- MER observado, ROAS de margem, break-even ROAS e Blended CAC.
- Comparação Loja × Meta × GA4, com o que cada fonte não mede vindo como travessão.
- Camada de qualidade do dado: o que falta para o resultado estar fechado.

**Criativos e detalhe do anúncio (Fase 4)**
- Agregação por criativo, somando todos os anúncios em que a peça rodou.
- Formato deduzido (imagem, vídeo, carrossel, Advantage+, outro), com "outro" como resposta honesta.
- Metas configuráveis (ROAS alvo, CPA alvo, CTR mínimo, gasto mínimo) e sinalização com o motivo à vista.
- Retenção de vídeo por marco e tempo médio assistido.
- Detalhe do anúncio em drawer: hierarquia, criativo, KPIs, bloco de vídeo e série diária própria.

**Telas (Fase 3)**
- Card de conexão em Integrações: conectar, escolher a conta de anúncios, sincronizar, desconectar,
  com progresso da importação.
- Página **Meta Ads** com quatro abas: Visão geral, Campanhas, Conjuntos, Anúncios.
- Drill-down campanha → conjunto → anúncio, com o filtro de contexto visível e reversível.
- Períodos: hoje, ontem, 7/14/30/90 dias e personalizado.

---

## Arquivos criados

| Arquivo | Papel |
|---|---|
| `lib/meta/actions.js` | `MetaActionMapper` (spec §16), parser monetário, métricas derivadas com divisão por zero protegida |
| `lib/meta/insights.js` | Normalizador de linha de Insights, montagem do upsert em lote, totalização de período, variação e semântica de direção |
| `lib/meta/client.js` | Cliente da Graph API: paginação, retry/backoff, timeout, tradução de erro, mascaramento de token |
| `test/meta.test.js` | 36 testes unitários (spec §66) |
| `test/meta-schema.test.js` | 10 testes de integração contra Postgres real, incluindo o pipeline ponta a ponta (spec §67) |
| `admin/src/api/metaAds.ts` | Camada de API do frontend, tradução dos códigos de erro (spec §64) e máscara do id da conta (spec §61) |
| `admin/src/pages/integracoes/MetaAdsIntegracaoCard.tsx` | Card de Integrações: conectar, escolher a conta, sincronizar, desconectar, progresso da importação |
| `lib/financeiro/consolidado.js` | Resultado progressivo, indicadores de eficiência, qualidade do dado e comparação de atribuição |
| `lib/financeiro/despesas.js` | Expansão de recorrência, totalização por categoria e validação |
| `test/financeiro-despesas.test.js` | 18 testes, concentrados nas armadilhas de recorrência |
| `admin/src/api/despesas.ts` · `admin/src/pages/financeiro/DespesasPage.tsx` | Cadastro de despesas |
| `test/financeiro-consolidado.test.js` | 19 testes, incluindo os exemplos literais da spec |
| `admin/src/pages/meta/MetaConsolidadoTab.tsx` | Aba Resultado: DRE, indicadores e atribuição |
| `lib/meta/criativos.js` | Classificação de formato, avaliação por metas e retenção de vídeo |
| `test/meta-criativos.test.js` | 19 testes das regras acima |
| `admin/src/pages/meta/MetaCriativosTab.tsx` | Cards de criativo, filtros, ranking e formulário de metas |
| `admin/src/pages/meta/MetaAnuncioDrawer.tsx` | Detalhe do anúncio (spec §47) |
| `admin/src/lib/meta.ts` | Períodos, formatação e semântica de variação das telas |
| `admin/src/pages/meta/MetaAdsPage.tsx` | Casca com abas, período e drill-down |
| `admin/src/pages/meta/MetaVisaoGeralTab.tsx` | KPIs com variação, gráfico e funil |
| `admin/src/pages/meta/MetaTabelaTab.tsx` | Tabela única que serve os três níveis |
| `admin/src/pages/meta/FunilMeta.tsx` | Funil Meta (spec §43) |
| `admin/src/pages/meta/MetaToolbar.tsx` | Filtros de período |
| `admin/src/pages/meta/charts/MetaSerieChart.tsx` | Investimento × receita por dia |
| `src/meta-ads.css` | Só a célula de nome com miniatura — o resto vem do design system |
| `docs/meta-ads-implementacao.md` | Este documento |

**Por que `lib/` existe.** O projeto é um monolito (`server.js`, ~13 mil linhas) sem módulos locais,
e a intenção foi preservar essa convenção. Mas a spec §16 exige que o mapper de actions seja
"centralizado e testado" e a §66 lista casos de teste obrigatórios — e nada dentro de `server.js` é
testável: só de ser requerido, ele abre pool do Postgres, registra rotas e liga `setInterval`.
Só as partes puras foram extraídas. Tudo que toca banco ou Express continua em `server.js`.

---

## Arquivos alterados

| Arquivo | Mudança |
|---|---|
| `server.js` | Requires da lib; cripto por contexto; schema das 8 tabelas; módulo Meta completo (~700 linhas) |
| `package.json` | Script `test` (`node --test test/*.test.js`) |

**Mudança de risco em `server.js`:** `encriptarSegredo`/`descriptografarSegredo` ganharam um
parâmetro `contexto` **opcional**, com default no contexto do GA4. Chamadas existentes não mudaram e
os tokens do Google já gravados continuam legíveis. Se o default fosse alterado, todas as conexões
GA4 em produção ficariam ilegíveis de uma vez.

---

## Migrations

Não há sistema de migration neste projeto: o schema é aplicado por `bootstrapPostgres()` a cada
boot, com `CREATE TABLE IF NOT EXISTS`. As 8 tabelas novas entram sozinhas no próximo deploy.

```
meta_connections     meta_ad_accounts   meta_campaigns   meta_adsets
meta_ads             meta_creatives     meta_insights_daily   meta_sync_logs
```

Três invariantes ficam no banco, não na disciplina do código:

- `meta_connections.id SMALLINT PRIMARY KEY CHECK (id = 1)` — uma conexão, sempre. Reflete a decisão
  de produto de 1 cliente = 1 loja. Voltar a multi-tenant significa trocar o PK.
- índice parcial `uq_meta_ad_accounts_selecionada` — impossível ter duas contas selecionadas.
- `UNIQUE (meta_account_id, level, entidade_id, data, attribution_setting)` em `meta_insights_daily`.
  A coluna `entidade_id` existe porque no Postgres dois NULLs são considerados distintos: sem ela, um
  `UNIQUE` sobre `(campaign_id, adset_id, ad_id)` deixaria passar snapshot duplicado no nível
  `account`, onde os três são NULL.

Nenhum valor monetário usa `float` (spec §30) — tudo `NUMERIC`.

---

## Variáveis de ambiente

| Variável | Obrigatória | Observação |
|---|---|---|
| `META_APP_ID` | sim | App da Meta com Facebook Login |
| `META_APP_SECRET` | sim | Nunca vai ao frontend |
| `META_OAUTH_REDIRECT_URI` | sim | `https://<domínio>/api/admin/integrations/meta/callback` — precisa estar cadastrada como "Valid OAuth Redirect URI" no app |
| `META_API_VERSION` | não | Default `v23.0`. **Confirmar a versão vigente** antes de subir (spec §92) |
| `META_BACKFILL_DIAS` | não | Default 28 |
| `META_SYNC_INTERVALO_MIN` | não | Default 45 |
| `ADMIN_SESSION_SECRET` | sim | Já existia. Deriva a chave de criptografia do token |
| `DATABASE_URL` | sim | Sem Postgres o módulo responde 503 |

---

## Rotas adicionadas

Integração:

```
GET   /api/admin/integrations/meta/status
GET   /api/admin/integrations/meta/connect          (redirect pro diálogo OAuth)
GET   /api/admin/integrations/meta/callback         (sem requireAdmin — protegido por state)
GET   /api/admin/integrations/meta/ad-accounts
POST  /api/admin/integrations/meta/select-account   { metaAccountId }
POST  /api/admin/integrations/meta/sync             { dias? }
POST  /api/admin/integrations/meta/disconnect
```

Leitura (base da Fase 3):

```
GET   /api/admin/analytics/meta/overview?from&to&comparar
GET   /api/admin/analytics/meta/timeseries?from&to
GET   /api/admin/analytics/meta/entities?level=campaign|adset|ad&from&to
GET   /api/admin/analytics/meta/creatives?from&to
GET   /api/admin/analytics/meta/ads/:adId?from&to
GET   /api/admin/analytics/meta/metas
PUT   /api/admin/analytics/meta/metas
GET   /api/admin/analytics/consolidado?from&to&loja

GET    /api/admin/financeiro/despesas?loja&from&to
POST   /api/admin/financeiro/despesas
PUT    /api/admin/financeiro/despesas/:id
DELETE /api/admin/financeiro/despesas/:id
```

`select-account` passou a aceitar `loja` — ver "A qual loja a conta atribui", abaixo.

O callback não usa `requireAdmin` porque a Meta redireciona o **navegador** para lá e o cookie de
sessão pode não acompanhar — quem prova legitimidade é o `state` de uso único. É o mesmo desenho já
adotado no callback do Google Analytics.

---

## Jobs adicionados

| Job | Frequência | O que faz |
|---|---|---|
| `jobIncrementalMeta` | 45 min | Insights de hoje e ontem |
| `jobDiarioMeta` | 6 h | Re-sincroniza a hierarquia + backfill de 28 dias |
| `jobRenovarTokenMeta` | 12 h | Renova o token quando faltam ≤ 7 dias |

Todos saem silenciosamente se não houver Postgres, OAuth configurado ou conta selecionada — em dev
local não fazem barulho. Uma trava global impede duas sincronizações simultâneas.

Os jobs usam intervalo em vez de horário fixo de propósito: o container reinicia a cada deploy, e um
job preso às 3h simplesmente não roda no dia em que o processo sobe depois da hora.

---

## Permissões Meta necessárias

```
ads_read
```

Só isso. `ads_management` **não** é pedida (spec §2) — a V1 não pausa campanha, não mexe em
orçamento e não cria anúncio. O callback recusa a conexão se a autorização voltar sem `ads_read`,
para a causa aparecer na hora certa em vez de virar erro genérico no primeiro sync.

Para ler contas de terceiros, o app provavelmente precisará de **Advanced Access** a `ads_read` via
App Review. Nada aqui impede essa evolução.

---

## Como conectar

1. Criar (ou reusar) um app na Meta com o produto **Facebook Login**.
2. Cadastrar a redirect URI em Facebook Login → Settings → Valid OAuth Redirect URIs.
3. Configurar as variáveis de ambiente acima no Railway.
4. No painel, abrir **Integrações** e chamar `GET /api/admin/integrations/meta/connect`.
   *(O card visual é Fase 3 — por ora a rota é chamada direto.)*
5. Autorizar na Meta. O callback grava o token e já lista as contas de anúncio.
6. `POST /api/admin/integrations/meta/select-account` com a conta escolhida. A importação de 90 dias
   começa em background; acompanhe por `GET .../meta/status` (campo `sincronizacoes`).

---

## Como testar

```bash
npm test                     # 36 testes unitários, sem dependência externa

# com Postgres real (valida schema, upsert e pipeline ponta a ponta):
docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=teste --name meta-pg postgres:16-alpine
META_TEST_DATABASE_URL=postgres://postgres:teste@localhost:55432/postgres npm test
docker rm -f meta-pg
```

Sem `META_TEST_DATABASE_URL` os testes de banco são **pulados com aviso**, nunca silenciosamente.

O teste ponta a ponta sobe um servidor HTTP que responde como a Graph API (com paginação por cursor
e os formatos reais: número como string, `outbound_clicks` como array de ações, `purchase` repetido
em três `action_type`) e leva o dado até a query de leitura do painel.

**Verificado nesta entrega:** 46 testes passando; `server.js` sobe e aplica o schema; as 7 rotas
respondem; `overview`, `timeseries` e `entities` devolvem valores conferidos à mão contra dado
carregado no banco.

---

## Fase 3 — decisões das telas

Quatro escolhas que se afastam da leitura literal da spec, e o porquê de cada uma. Todas foram
tomadas olhando dado real da conta, não no papel.

**O funil começa em cliques, não em impressões** (a spec §43 lista impressões primeiro). Com 2
milhões de impressões contra 375 compras, toda barra depois da primeira vira um fio de 0,02% e o
desenho deixa de informar. A passagem impressões → cliques é exatamente o CTR, que já aparece com
destaque na faixa de KPIs logo acima.

**Uma etapa do funil pode ser maior que a anterior.** `view_content` e `landing_page_view` são
contagens de EVENTO, não de pessoas: o mesmo visitante dispara `view_content` várias vezes numa
sessão. Nos dados reais, "Viu produto" (32.398) supera "Cliques no link" (27.309). Exibir "139%
seguiram" seria absurdo, então nesses casos a tela diz que aquela etapa conta evento e não pessoa.

**Alcance do período aparece como "Alcance somado".** A Meta não deduplica alcance por dia; somar as
linhas diárias conta a mesma pessoa mais de uma vez. O campo `reach` vem `null` da API e a soma vai
em `reachSomado`, com o rótulo dizendo o que é (spec §54). O "CTR único" que o Ads Manager mostra
tem a mesma natureza e por isso não é calculado — é deduplicado por pessoa no nível da conta.

**CPA e ROAS sem compra são "—", não 0** (spec §63). E na ordenação esses casos vão para o fim da
lista, em vez de aparecerem como os melhores por terem o menor CPA.

### Cor do delta

A cor vem da semântica da métrica, nunca do sinal do número. O backend manda `direcaoBoa` por
métrica e a tela lê de lá: subir receita é bom (verde), subir CPA é ruim (vermelho), subir gasto não
é nem um nem outro e fica **sem cor**, como informação no rodapé do KPI.

Achado na revisão visual, antes de subir: variação que arredondava para "0,0%" estava ganhando cor,
e o mesmo "+0,0%" saía vermelho no CPM e verde no CTR. Arbitrário o bastante para corroer a
confiança nas cores que de fato importam. Abaixo do limiar de exibição (0,05 p.p.) agora lê
"estável", sem cor.

### Uma tabela para três níveis

`MetaTabelaTab` serve Campanhas, Conjuntos e Anúncios porque o backend expõe uma rota só
(`level=campaign|adset|ad`): o que muda entre elas é a junção e o rótulo, não a lógica. Três
componentes seriam três lugares para corrigir a mesma coluna.

A ordenação é client-side, o que aqui é seguro: a lista do período vem inteira do servidor, já
agregada, sem paginação. É o oposto da Central de Pedidos, onde ordenar só a página carregada já
causou bug real (ver `docs/checklist-nova-tela.md`).

O drill-down filtra no cliente pelo mesmo motivo — a lista já está na memória, e ir buscar de novo
só para aplicar um `where` seria uma ida de rede desnecessária. O filtro aparece como um aviso com
ação "Ver todos": sem isso, a aba Conjuntos mostraria um subconjunto sem explicar por quê e
pareceria dado faltando.

---

## Fase 4 — criativos, metas e sinalização

A pergunta desta tela é diferente da hierarquia: **"qual peça funciona?"**, independente de onde
rodou. Por isso agrega por criativo e não por anúncio — a mesma peça costuma rodar em vários
anúncios e conjuntos, e somá-los é justamente o que produz a leitura útil.

### Formato é deduzido, e a ordem dos sinais importa

A Meta não devolve um campo "tipo de criativo". O formato sai da forma do `object_story_spec` /
`asset_feed_spec`, que muda conforme a origem do anúncio (Ads Manager, API, post impulsionado,
Advantage+). A ordem em `lib/meta/criativos.js` vai do sinal mais específico ao mais genérico:

1. **Advantage+/dinâmico** — `asset_feed_spec` com múltiplos ativos. Vem primeiro porque um dinâmico
   costuma **também** ter `video_data`; testá-lo depois classificaria como vídeo e esconderia
   exatamente o que ele tem de diferente (spec §13).
2. **Carrossel** — `child_attachments`. Vem antes de imagem, senão todo carrossel viraria imagem por
   causa do `image_hash` que ele também tem.
3. **Vídeo** — `video_data`.
4. **Imagem** — `image_hash` / `picture`.
5. **Comportamento medido** — post impulsionado costuma vir com spec vazio; se registrou reprodução
   de vídeo, é vídeo.
6. **Outro** — sem sinal nenhum. Não é categoria de descarte: é a resposta honesta, que a spec §48
   pede explicitamente em vez de um chute. Thumbnail sozinha não decide nada (vídeo também tem).

### Metas nascem vazias

Nenhum valor da Use Origens no código (spec §50). Sem meta preenchida, o painel mostra as métricas e
**cala sobre eficiência** — inventar um limiar "razoável" no lugar de quem cuida da conta seria
opinar sem base.

`gastoMinimo` é a meta mais importante das quatro. Na verificação, o criativo com o **melhor ROAS da
lista (6,41x)** tinha gastado R$ 615 e apareceu como "Sem base ainda", não no topo do ranking — que é
exatamente o ruído que ela existe para suprimir.

### Sinalização, não decisão

Nenhum badge diz PAUSAR ou ESCALAR (spec §49 proíbe). O vocabulário é `Candidato a escala`,
`Monitorar`, `Baixa eficiência` e `Sem base ainda`, e **todo sinal vem com os motivos** — é o que
permite discordar dele.

**Metas de resultado dominam as de meio.** Achado olhando a tela com dado real: um criativo que
gastou R$ 1.435 e vendeu **zero** saía como "Monitorar" — o mesmo selo de outro com ROAS 2,33 — só
porque o CTR passou. ROAS e CPA medem resultado; CTR mede meio do caminho, e clique nenhum redime
venda zero. Falhar em **todas** as metas de resultado definidas agora é baixa eficiência mesmo com
CTR bom.

O CTR aprovado continua aparecendo nos motivos de propósito: "atrai clique e não converte" é um
diagnóstico diferente de "nem atrai clique", e a diferença muda o que se mexe primeiro.

Quando só `ctrMinimo` está definido (nenhuma meta de resultado), o CTR volta a decidir sozinho — não
há resultado para dominar.

### Retenção de vídeo

Relativa a **quem deu play**, não a impressões: a pergunta que o criativo responde é "quem começou,
ficou?". Anúncio sem play não tem retenção 0% — não tem retenção, e o campo vem `null` (spec §20).

O tempo médio assistido é ponderado por plays na agregação (`SUM(avg × plays) / SUM(plays)`); a média
simples das médias diárias daria peso igual a um dia de 10 plays e a um de 10.000.

---

## Fase 5 — consolidado financeiro e atribuição

A premissa que organiza esta fase inteira é a **§53D: atribuição não fecha o caixa**. São duas
perguntas diferentes, e o código as mantém separadas:

| | Pergunta | Fonte |
|---|---|---|
| **Financeiro** | quanto entrou, custou e sobrou | receita e custo reais do pedido (Ink) + gasto real reportado pela plataforma |
| **Atribuição** | de onde veio a venda | o que Meta e GA4 dizem ter gerado |

Receita atribuída **nunca** entra numa conta de resultado — ela só aparece ao lado, para comparação.
Misturar as duas é o que produz lucro inflado, e é o erro que a spec §53E descreve em detalhe: o
gasto de mídia é descontado **uma vez**, no nível de aquisição, nunca também por pedido.

### A camada é provider-agnostic desde o primeiro dia

`totalizarMidia` recebe uma lista de fontes `{ provider, spend, conectado }`. Hoje só a Meta está
conectada; quando o Google Ads entrar, vira mais um item da lista e **nenhuma fórmula muda** — há um
teste que exerce exatamente isso (spec §53P).

Provedor não conectado entra declarado como tal, **não como zero**. A diferença entre "gastou zero" e
"não sei quanto gastou" é a diferença entre um resultado correto e um inflado (§53AA).

### Três recusas deliberadas

**Lucro Operacional vem `null`**, não igual ao Lucro após Mídia, porque a entidade de despesas
operacionais (§53X) ainda não existe. Igualar os dois faria a tela parecer um fechamento que ela não
é; o travessão diz que a resposta é desconhecida.

**Lucro do Produto não é recalculado** quando a Ink já informou. O `kickback_value` do pedido já é
esse número, líquido de desconto — recalcular como receita − custo daria outro valor em pedido com
promoção. O teste cobre o caso real: R$ 109,33 − R$ 49,90 com R$ 10,99 de promoção dá R$ 49,01, não
R$ 59,43.

**Pedido sem custo gravado vira aviso nomeado, no topo da tela**, antes dos números. Um lucro alto
pode ser só custo faltando, e descobrir isso no rodapé é tarde demais (§53AB). Na verificação, 1 de
101 pedidos disparou exatamente esse alerta.

### A qual loja a conta de anúncios atribui

O MER e o ROAS de margem dividem receita **real da loja** por gasto **real da conta**. Comparar o
gasto de uma conta contra a receita de lojas que ela não atende infla o resultado.

Isso começou como env var com valor `sul` e foi corrigido: virou coluna
(`meta_ad_accounts.loja_atribuida`), escolhida na interface. O motivo é de produto — o painel vai ser
SaaS de cliente individual, e `sul` no código é o nome de um cliente específico.

O comportamento reflete os dois cenários:

- instalação com **uma loja só** (o caso do SaaS): o backend resolve sozinho, sem perguntar nada;
- instalação com **várias lojas** (o caso atual): o consolidado **se recusa** a calcular até alguém
  definir, devolvendo `META_LOJA_NAO_DEFINIDA` — e a tela oferece a ação em vez do erro genérico.

Para isso o cliente de API ganhou `ApiError` com o código do backend: nem toda falha é falha, e
"falta configurar" merece um caminho diferente de "deu erro".

### GA4 só lê cache

A linha do GA4 na comparação vem do mesmo cache do Analytics GA4, e esta tela **nunca** dispara
chamada à Data API. Cache frio significa linha indisponível — melhor que fazer o consolidado
inteiro esperar por uma API externa. A tela explica isso em vez de mostrar zeros.

### Cobertura parcial: o bug que a produção mostrou

Descoberto em 15/09/2026, olhando a tela com dado real. Ela exibia:

```
Receita real          R$ 61.467,98      (377 pedidos pagos)
(-) Custo de produção R$  3.664,00      (55 pedidos — os únicos com financeiro gravado)
────────────────────────────────────────
Lucro do Produto      R$  3.790,84   6,17%
(-) Meta Ads          R$ 20.379,38
────────────────────────────────────────
Lucro após Mídia     -R$ 16.588,54
```

`SUM` ignora `NULL` em silêncio. A receita somava todos os pedidos e o custo só os que tinham valor,
produzindo uma margem de 6% onde a real é 45%, um prejuízo que não existia e um break-even de 16,21x.
Tudo apresentado com a mesma confiança dos números corretos.

**A correção tem três partes.**

Receita, custo e lucro passaram a sair do mesmo conjunto, via `FILTER (WHERE lucro_operacional IS NOT
NULL)`. A margem voltou a 45,21% e o break-even a 2,21x.

MER e Blended CAC continuam sobre o total real da loja — nenhum dos dois depende de custo de
produção, então cobertura parcial não os afeta. Eram os únicos números certos na tela original, e
seguem certos.

Absolutos derivados da margem viram travessão enquanto a cobertura for parcial: subtrair o gasto de
mídia de TODO o tráfego de uma margem que cobre 15% dos pedidos inventa um prejuízo. Taxas ficam — a
margem % de um recorte estima bem a margem da loja, e é dela que o break-even sai.

| | cobertura parcial | cobertura completa |
|---|---|---|
| Margem do Produto % | calculada (taxa do recorte) | calculada |
| Lucro após Mídia | — | calculado |
| ROAS de margem | — | calculado |
| Break-even ROAS | calculado | calculado |
| MER, Blended CAC | calculados (total real) | calculados |

**O aviso também estava errado**, e duas vezes. Dizia que o lucro "aparece maior que o real" quando
aparecia menor; depois da primeira correção passou a imprimir "cobre -267 de 55 pedidos", porque
recebia o recorte no lugar do total. Hoje diz quantos pedidos o resultado representa e manda rodar o
backfill.

A lição que fica: **um número que parece autoritativo e está errado é pior que um travessão.** Foi o
mesmo princípio já aplicado em CPA sem compra e Lucro Operacional sem despesa — só não tinha sido
aplicado aqui.

### Verificação

Contra Postgres real, com os dois lados semeados: 100 pedidos pagos da loja atribuída, mais uma
troca, um reembolsado, um de outra loja e um sem financeiro gravado. Receita, custo de produção,
Lucro do Produto, total de mídia, Lucro após Mídia, MER, ROAS de margem, break-even ROAS, Blended
CAC e ROAS Meta bateram ao centavo com o cálculo independente — e os três casos que deviam ficar de
fora ficaram.

---

## Despesas operacionais (§53X)

O que fecha o nível 4 do resultado. Antes disso, o Lucro Operacional era travessão porque era
genuinamente desconhecido — e continua sendo quando ninguém cadastrou nada. Nenhuma despesa
**cadastrada** é diferente de nenhuma despesa **existente**.

### Recorrência é uma linha, não doze

Uma mensalidade é cadastrada uma vez, com data de início e um fim opcional. A expansão acontece na
**leitura** (`lib/financeiro/despesas.js`), não na escrita. Gerar doze registros por ano faria
editar o valor virar caçada, e criaria despesas fantasma para meses que ainda não aconteceram.

Três armadilhas da expansão, cada uma com teste próprio:

| Armadilha | Regra |
|---|---|
| Fevereiro | conta o **mês**, não 30 dias — uma mensalidade de R$ 1.500 não vira R$ 1.400 |
| Dia 31 | cai no último dia dos meses curtos, como cobrança recorrente faz — não pula fevereiro nem inventa 31/02 |
| Um ano | doze incidências, não treze |

### O caso que só o dado real mostrou

Num período de **um dia**, as despesas cadastradas não incidiam (a mensal cai no dia 10, a avulsa no
dia 5). O total dava zero e o Lucro Operacional ficava **igual** ao Lucro após Mídia.

Matematicamente correto — nenhum dinheiro saiu naquele dia — mas lê como "a operação não tem custo
fixo", que é falso. A camada de qualidade agora avisa que aquele recorte não inclui custos lançados
em outras datas. É lançamento por **caixa** (na data da cobrança), não por competência.

### Validações que importam

Valor zero é recusado junto com negativo: uma despesa de R$ 0 não é despesa, é cadastro incompleto —
e passaria batido somando nada ao resultado. Categoria vem de lista fechada, porque categoria livre
vira sinônimo ("Designer", "designer", "Design") e o agrupamento deixa de significar algo. `fim` só
é aceito em despesa recorrente.

### Origem do custo

Cada linha carrega `origem` (§53Y). Hoje tudo é `manual`, vindo do cadastro. Quando as taxas de
gateway forem lidas do pedido, elas entram como `automatico` na mesma estrutura, sem mudar a tela —
e é isso que torna o financeiro auditável: saber que R$ 8.825 de mídia veio da API e R$ 1.500 de
designer foi digitado.

---

## Limitações atuais

- **Taxas de gateway ainda não são automáticas** (§53Y): a estrutura já prevê `origem: automatico`,
  mas o valor por pedido não é lido — hoje entra como despesa manual, se alguém cadastrar.
- **Despesa é lançada por caixa**, na data da cobrança. Em período curto que não contém essa data, o
  custo fixo não aparece (a tela avisa). Rateio por competência seria outra decisão de produto.
- **Sem atribuição por pedido** (Fase 6): a comparação é agregada. Saber qual campanha trouxe qual
  pedido depende de UTM + click IDs persistidos no pedido.
- **Sem comparação entre períodos na aba Criativos**: a Visão Geral compara com o período anterior,
  a de criativos ainda não.
- **Sem exportação** (spec §84): o backend já devolve dado estruturado, não formatado para tela, mas
  não há CSV/XLSX.
- **Sem conexão real com a Meta.** Não há app Meta configurado neste repositório, então o fluxo
  OAuth foi implementado conforme a documentação mas **nunca executado contra a Meta de verdade**.
  O primeiro `connect` real é o teste que falta.
- **`META_API_VERSION` default `v23.0` está desatualizado.** Confirmado em 14/09/2026 contra o
  changelog oficial: a versão vigente é **v26.0** (29/07/2026); v23.0 vale até outubro/2027, então
  funciona, mas são três versões de atraso. Recomendado setar `META_API_VERSION=v25.0` (lançada em
  fev/2026, válida até julho/2028). A restrição de v25 que aparece no changelog — Advantage+ não
  pode mais ser criada/atualizada via API — é de escrita e não afeta esta integração.
- **Alcance de período não é alcance único.** A Meta não devolve deduplicação de alcance por dia.
  A soma vai em `reachSomado` e `reach` fica `null`, para a UI não apresentar um número errado.
- **Uma configuração de atribuição por vez.** Gravamos o marcador `unified`
  (`use_unified_attribution_setting=true`). A chave única já prevê comparar janelas diferentes lado
  a lado, mas nada consulta duas janelas ainda.
- **Sem cache de leitura.** As rotas vão direto ao Postgres. Com os índices criados isso é rápido;
  o cache de 5 min da spec §60 entra junto com a UI, quando houver tráfego real para justificá-lo.
- **Fuso:** as datas são as da conta de anúncios, como a Meta devolve. A normalização para o fuso da
  loja (spec §59) só importa quando Meta e pedidos forem cruzados — Fase 5.

---

## Próximas evoluções

**Fase 3 — UI Meta Ads:** Visão Geral, Campanhas, Conjuntos, Anúncios. As três rotas de leitura já
entregam exatamente o que essas telas precisam.

**Fase 4 — Criativos:** thumbnail, tipo, ranking, badges. Os criativos já estão sincronizados com
`asset_feed_spec`/`object_story_spec` preservados, então Advantage+/Dynamic Creative não vai quebrar
o modelo.

**Fase 5 — Consolidado + financeiro.** O bloqueio que esta auditoria havia levantado **já foi
resolvido** (14/09/2026, sessão do Dashboard): o custo real de produção passou a ser persistido.
Conta em `lib/ink/financeiro.js`, testada em `test/ink-financeiro.test.js`.

| Campo da INK | Onde | Vira no banco |
|---|---|---|
| `items[].unit_ink_base_price` + `unit_additional_service_price` | item | `custo_producao` |
| `shipping_value` | pedido | `frete` |
| `promotion_value` + `payment_discount_value` + `freight_value_difference` | pedido | `descontos` |
| `kickback_value` | pedido | `lucro_operacional` |

A identidade confere exatamente:

```
pedido 1987311
  total pago     109,33
- frete           10,42
- custo INK       49,90
- promocao        10,99
-------------------------
= kickback_value  49,01   OK
```

O **Lucro do Produto** da spec §53H não precisa ser recalculado: `kickback_value` já é ele, com
desconto abatido. `freight_value_difference` (frete grátis bancado pela loja) entra nos descontos —
ignorá-lo erra o lucro em cerca de um terço dos pedidos.

Revalidado de forma independente em 14/09/2026, sobre 191 pedidos únicos de `docs/webhook-log.json`:

- `total_value = somatorio(itens) + frete - descontos` -> **191/191**
- `kickback_value = somatorio(itens) - somatorio(custo base) - descontos` -> **182/191**; as 9
  exceções são 8 trocas (`is_exchange`, kickback zerado pela Ink) e 1 reembolso — nenhuma entra nas
  somas, porque os endpoints filtram `is_troca IS NOT TRUE` e só status pago
- soma do lucro por item = lucro do pedido -> **191/191**
- as queries de `/dashboard/financeiro` e `/dashboard/lucro-produtos`, rodadas contra Postgres real
  com esses pedidos, batem ao centavo com o cálculo independente: 104 pedidos pagos, faturamento
  R$ 16.138,94, custo R$ 7.412,10, lucro R$ 7.357,32

**O que a Fase 5 deve fazer:** ler de `pedidos_ink` (`lucro_bruto`, `custo_producao`,
`lucro_operacional`) e de `pedidos_ink_itens` — **nunca** recalcular custo por preço médio ou
catálogo. Somar sempre com `payment_status = ANY('{paid,succeeded,free}')` e `is_troca IS NOT TRUE`.

**Pré-requisito operacional:** o histórico só existe depois do backfill de pedidos por loja
(Integrações). Até lá, `semFinanceiro` e `pedidosSemItens` indicam a cobertura — a tela avisa em vez
de sub-reportar lucro.

**Decidido em 14/09/2026:** `/dashboard/lucro-produtos` agrupa por `produto_id`. Em 191 pedidos, 8
nomes de produto aparecem com mais de um `produto_id` (ex.: "Made in Santa Catarina" com 2), então a
mesma estampa se divide em duas linhas do ranking. O usuário optou pela precisão do `produto_id`
sabendo desse efeito. Se um dia a leitura por estampa for desejada, o caminho é uma opção nova no
mapa fechado `LUCRO_AGRUPAMENTOS` usando `product_cluster_id` — nunca o nome, que é justamente o que
colide.

**Fase 6 — UTM / atribuição avançada:** o UTM Tracker e o GA4 já existem e já agrupam pelas
dimensões do GA4, então links de campanha da Meta já aparecem lá hoje. Falta a camada de resolução
UTM → IDs da Meta (spec §56), que deve priorizar IDs sobre nomes.
