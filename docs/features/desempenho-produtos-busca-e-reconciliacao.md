# Desempenho de Produtos — situação "ativo", busca por nome e Reconciliação paginada

Continuação de `desempenho-produtos-filtros.md`. Três pedidos do usuário (2026-09-25), depois de usar a
tela com o catálogo real da Use Sul:

1. A aba **Reconciliação** listava o catálogo inteiro (uma linha por produto ativo — dezenas de milhares,
   quase todas "Identidade insuficiente"): paginar.
2. Na **Visão Geral**, trazer por padrão **apenas os ativos**.
3. Um **campo de busca pelo nome**: usado, os demais filtros são ignorados e o produto vem
   independente da situação.

## O que "ativo" quer dizer (a correção mais importante)

Na rodada anterior, "ativo" era `is_active` do catálogo canônico. Mas `is_active` só diz "a Ink ainda lista
o produto no último full sync" — e a Ink lista **também os não publicados** (o próprio cache de catálogo
diz "inclui desativado, oculto e não aprovado"). O que o lojista chama de **desativado** é o que a tela
Produtos mostra em "Status": Não publicado, Recusado, Arte inválida… — o `status` da Ink, que o sync já
grava em `commerce_products.metadata.status`. Por isso a tela continuava mostrando desativados por padrão.

Agora, no repositório do catálogo (`condicaoDeStatus`):

| Situação | Regra |
|---|---|
| `active` (padrão da tela) | `is_active` **e** `status` da Ink = `published` (sem status do provider conta como publicado) |
| `inactive` | o contrário: não publicado, recusado, arte inválida… ou fora da Ink |
| `all` | sem filtro |
| `synced` | só `is_active` (o comportamento antigo) — uso interno |

- **Sem migration e sem novo sync**: `metadata.status` já estava gravado.
- **Oculto** (`visible = false`) **não** entra na definição: a tela Produtos trata "desativado" e "oculto"
  como coisas separadas. Se quiserem que oculto também saia dos "ativos", é um `AND` a mais.
- O detalhe do produto (drawer), os totais da Store e as Prioridades de hoje continuam no `synced` de
  sempre: abrir um produto que a busca achou não pode perder as métricas porque ele não está publicado.
  (Isso quebrou num teste meu durante a rodada e foi corrigido: `idsComIdentidadeResolvida` tinha default
  `active`, que passou a significar "publicado".)
- A linha do produto traz `isActive` (no sentido acima) e `providerStatus` (o status cru); a tela rotula
  o selo com o **motivo** ("Não publicado", "Recusado"…), não só "Desativado".

## Busca por nome

`GET /products?q=…` (campo "Buscar produto pelo nome" no topo dos filtros).
- Cada palavra precisa aparecer no nome (E), sem diferenciar maiúscula; até 100 caracteres e 6 palavras
  (acima disso é 400). `%`, `_` e `\` são letra, nunca curinga, e o texto nunca vira SQL (só parâmetro).
- **Usada, vence tudo**: status, mínimos e "somente com dados" são ignorados (a tela desabilita esses
  campos e avisa) e o produto vem de qualquer situação.
- Ordenação na busca: por padrão "mais dados primeiro" (quem tem dado na frente, o resto por nome). Pedir
  ordenação por **métrica** durante a busca também vira "mais dados", porque o contrato da ordenação por
  métrica (Fase G.1) só lista quem tem identidade no GA4 e **esconderia** um produto que a busca deveria
  achar. A tela desliga a ordenação por coluna durante a busca.
- Sem acento-insensibilidade (não há `unaccent` no banco): "boné" não acha "bone".

## Reconciliação paginada

`GET /reconciliation` agora é **sempre paginada** (`limit`, padrão 50, máx. 200; `cursor` opaco) e devolve
`nextCursor` e `totalCount`. A tela pagina de 25 em 25.
- **Ordem**: mais volume primeiro — itens observados no Analytics **+ unidades em pedidos pagos** do
  Commerce — e o resto do catálogo depois, por nome. Somar o Commerce no ranking evita que um produto que
  vendeu mas o GA4 nunca viu caia no fim da fila. É a mesma mecânica de "mais dados primeiro" da Visão Geral.
- **Só produtos ativos** (publicados), como na Visão Geral.
- Nunca materializa o catálogo inteiro: só a página pedida vira linha (antes eram ~270 páginas internas de
  200 produtos a cada abertura da aba).
- Contrato antigo preservado no service: `reconcileProductPerformance` **sem** `pagination` devolve todas as
  linhas como sempre (a rota é que sempre pagina). A montagem da linha (status, diagnósticos) é uma função
  só (`linhaDeReconciliacao`) nos dois caminhos.
- Não mudei o critério de divergência nem as ressalvas. Não pus "divergentes primeiro" nem filtro por
  diagnóstico — ficam como sugestão.

## Onde está
`lib/product-analytics/`: `commerce-catalog-repository.js` (situação, busca, `isActive`/`providerStatus`),
`performance-filters.js` (busca vence tudo), `product-performance-service.js` (ranking com `rankingExtra`,
identidade só das linhas sem métrica), `reconciliation.js`, `http-routes.js`. Tela: `DesempenhoProdutosPage.tsx`,
`ReconciliacaoPanel.tsx`, `productAnalytics.ts`.

## Verificação
- **Testes** (Postgres real): `performance-filters.test.js` 13 (4 novos, busca) · `product-performance-service.test.js`
  59 (+10: situação = publicado nos 3 modos de ordenação, detalhe de produto não publicado, busca em qualquer
  situação, várias palavras, `%`/`_`/injeção como texto, limites, busca + ordenação por métrica, paginação da
  busca, busca sem analytics no período, `rankingExtra`) · `reconciliation.test.js` 18 (+6: ranking Analytics +
  Commerce, paginação sem repetir/perder, "vendeu e o GA4 viu zero" = divergente, só ativos, contrato antigo sem
  `pagination`, período sem analytics) · `product-analytics-http.test.js` 41 (+2: `q` e a validação de
  `limit`/`cursor` da reconciliação). Com os vizinhos (oportunidades, jornada, identidade, catalog sync):
  **214/214**. `tsc` e `vite build` limpos.
- **Um teste meu pegou uma regressão minha**: o detalhe de um produto não publicado abria sem métricas
  (o helper de identidade ainda usava o default `active`, que passou a significar "publicado"). Corrigido para
  `synced`; o teste segue lá. Também vale registrar: na primeira rodada a inserção dos testes novos do service
  falhou em silêncio e a suíte "passou" com menos testes — descobri porque a contagem não fechou (esperado 77,
  vieram 67) e reaplicei.
- **Navegador** (demo local, números fabricados, 67 produtos: 43 publicados extras + 7 com GA4 + 17 não ativos):
  o padrão mostra **50 produtos "Ativos (publicados)"** (os 17 não ativos ficam de fora); a busca por
  "extra 07" (não publicado) o achou com selo "Não publicado", com os demais campos desabilitados e o aviso
  de busca; a Reconciliação abriu em "Página 1 de 2 · 50 produtos" (25 por página), com os 7 do GA4 primeiro,
  depois os que venderam no Commerce em ordem decrescente de unidades e o resto por nome; página 2 ok.
  **Mobile não foi visto em imagem** (a extensão ignora o resize na captura).
- **Desempenho — inconclusivo.** Medi no perfil real (54.100 produtos, 23.304 ids), mas a máquina estava com
  carga 80–245 (outras sessões rodando suítes), então os valores absolutos (10–26 s) não valem nada. Uma
  medição **pareada** (serviço do `main` × novo, alternados na mesma janela) mostrou os caminhos que existem
  nos dois lados **sem regressão**; os caminhos novos (busca que casa o catálogo inteiro, reconciliação com
  8.000 produtos vendidos) **não têm número confiável**. Antes, numa janela mais calma, o "mais dados
  primeiro" ficou em ~2,4–3,4 s. Vale repetir numa máquina quieta antes de concluir que a busca é rápida no
  catálogo grande.

## Pendências
- Medir a busca e a Reconciliação numa máquina sem carga.
- Confirmar o mobile em navegador real.
- Sem migration e sem passo de produção.
