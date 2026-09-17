# Migração Centro + Norte → Sul — criação de produtos pelo painel

> Levantamento de 11/09/2026. Complementa `docs/claude-categorias-lote-migracao-use-origens.md`
> (que trata de reclassificar produtos já existentes). Este documento trata de **criar** os
> produtos de Use Centro e Use Norte dentro da loja Use Sul, a partir das artes locais.

Artes: `/Users/gtomazi/projects/arte-lojas/migracao-useorigens`

---

## 1. Como a Reserva Ink cria um produto

### 1.1 Tipo de peça → áreas de impressão

`GET /v1/stores/product_types` (exposto como `GET /api/admin/produto-tipos?loja=`) devolve cada
tipo de peça com `printable_areas[]`. Cada área é uma combinação **modelo + cor**, identificada
por `base_image_id`.

> **Variação de cor na Ink É o `base_image_id`.** Não existe campo "cor" separado na criação.

Os ids são por loja e por tipo — **nunca hardcodar**, sempre resolver em runtime pelo nome da cor
(mesma regra já adotada no preset de regras da migração).

### 1.2 Uma área por (MODELO, COR) — não por cor

`printable_areas` traz **uma entrada por combinação modelo + cor**. A Camiseta da Use Sul tem
**18 áreas = 9 cores × 2 modelos** (Baby Look Feminino e Clássica Masculina).

> Indexar as áreas por cor sozinha faz um modelo sobrescrever o outro e publica o produto com
> arte em metade das variantes. Aconteceu no piloto de 12/09: 54 variantes em vez de 108, e a
> estampa saiu só na Baby Look.

A cobertura correta é **todas as áreas**, não uma por cor. O job valida isso antes de enviar:
a soma dos `base_image_ids` dos grupos tem que bater com `printable_areas.length`.

### 1.3 Criar o produto

`POST /v1/stores/products`:

```json
{
  "product_type_id": 12,
  "name": "Bodoquena | Origem MS",
  "price": "...",
  "collections": [101, 102, 103, 104, 105],
  "arts": [
    { "base_image_id": 901, "art_attachment": "<base64>" },
    { "base_image_id": 902, "art_attachment": "<base64>" }
  ]
}
```

Uma entrada de `arts` **por cor**. O painel já resolve isso: o client manda `artGroups`
(`{ base_image_ids: [...], art_attachment }`) e `server.js:2694` expande pra 1 entrada por cor.
O agrupamento existe porque repetir o mesmo base64 N vezes estourava o body — comentário no
código registra o bug.

`art_url` é a alternativa documentada, mas **não serve aqui**: `/api/admin/media/:id/arquivo`
está atrás de `requireAdmin` e a Ink não conseguiria baixar. Fica `art_attachment` (base64).

Tamanhos são gerados pela Ink a partir da grade do tipo — não há como escolher.

### 1.4 Copiar pras outras peças

`POST /v1/stores/products/:id/copy` (exposto como `POST /api/admin/produtos/:loja/:id/duplicar`):

```json
{ "product_type_id": <peça destino>, "include_categories": true }
```

Sem `price`, a Ink usa o preço padrão da loja para o tipo de destino — que é o combinado
(preço já ajustado na loja).

Efeito colateral desejado: **a cópia entra no `product_cluster_id` do original** (cria o
agrupamento se não existir) → 1 card na vitrine com todas as peças.

Restrições documentadas:

- tipo destino ≠ tipo de origem;
- a estampa precisa existir **nas cores do tipo de destino** (grade diferente → `resizing`);
- produto reprovado não pode ser copiado;
- a cópia nasce sem imagem principal, `approval_status=waiting`, mockups assíncronos.

### 1.5 Categorias

`POST /api/admin/categorias/:loja/bulk-create` já existe, com `bulk-preview` antes, e devolve
`mapaIds` (nome → id) — que é exatamente o que alimenta `collections` na criação do produto.

---

## 2. Inventário das artes locais

```
7.581 produtos-base (modelo × cidade)
  993 cidades distintas
   11 UFs: AC AM AP DF GO MS MT PA RO RR TO
16.114 arquivos PNG — 8,1 GB, média 526 KB
```

Sem nenhum par de cor incompleto (verificado após a cópia do `origem` em 11/09).

### 2.1 Estrutura

```
{modelo}/{UF}/{cidade_normalizada}[_{token}]_{sufixo}.png
```

| Modelo (pasta) | Token no meio | Sufixos | Produtos |
|---|---|---|---|
| tipografia | `_arte` | branco, preto | 964 |
| feito_em | — | branco, preto, **amarelo** | 952 |
| coordenadas | `_coord` | branco, preto | 951 |
| origem | `_arte` | branco, preto | 950 |
| traco | `_arte` | branco, preto | 949 |
| legado | `_arte` | branco, preto | 949 |
| territorio | `_arte` | branco, preto | 948 |
| gentilicos | — | branco, preto | 918 |

Produtos por UF: GO 1969 · PA 1153 · MT 1133 · TO 1112 · MS 632 · AM 496 · RO 422 · DF 237 ·
AC 176 · AP 128 · RR 123.

### 2.2 A convenção de sufixo NÃO é uniforme

Luminância média dos pixels opacos (amostras por pasta/sufixo):

| Modelo | `_branco` | `_preto` | Sufixo nomeia |
|---|---|---|---|
| coordenadas | 252.9 (clara) | 18.0 (escura) | cor da **arte** |
| legado | 237.5 (clara) | 4.8 (escura) | cor da **arte** |
| origem | 246.9 (clara) | 2.1 (escura) | cor da **arte** |
| territorio | 231.5 (clara) | 15.4 (escura) | cor da **arte** |
| tipografia | 245.4 (clara) | 0.0 (escura) | cor da **arte** |
| traco | 238.0 (clara) | 6.0 (escura) | cor da **arte** |
| **gentilicos** | **0.0 (escura)** | **255.0 (clara)** | cor da **peça** |
| **feito_em** | **38.4 (escura)** | **215.4 (clara)** | cor da **peça** |

Em `gentilicos` e `feito_em` o sufixo nomeia a **camiseta**, não a arte — invertido em relação
aos outros 6. São **1.870 produtos** que sairiam com arte preta sobre peça preta se a regra
global fosse aplicada.

> A tabela de mapeamento arte → cores é **por modelo**, nunca global.

`feito_em` tem um terceiro sufixo, `_amarelo`: arte escura como a `_branco`, mas com os detalhes
dourados trocados por verde/azul — dourado não lê sobre amarelo.

### 2.3 Mapeamento de cor (confirmado)

Cores escuras: **Bordeaux, Vermelho, Marinho, Preta, Verde**.
Cores claras: **Cinza, Rosa, Amarelo, Branca**.

| Modelo | Cores escuras | Cores claras (menos Amarelo) | Amarelo |
|---|---|---|---|
| coordenadas, legado, origem, territorio, tipografia, traco | `_branco` | `_preto` | `_preto` |
| gentilicos | `_preto` | `_branco` | `_branco` |
| feito_em | `_preto` | `_branco` | **`_amarelo`** |

### 2.4 Apóstrofo: 7 artes de `tipografia` estão erradas e não têm substituta

Cidades com apóstrofo aparecem no acervo em até três grafias de arquivo — `espigao_d'oeste`,
`espigao_d_oeste`, `espigao_doeste`. A chave canônica (§7) normaliza as três para o mesmo item,
então isso não atrapalha o casamento. O problema é outro: **a grafia sem apóstrofo corresponde a
uma arte em que o apóstrofo também some da estampa**.

Conferido abrindo os arquivos:

| arquivo | o que a estampa diz |
|---|---|
| `alvorada_d'oeste_arte_preto.png` | `ALVORADA D'OESTE` ✅ |
| `alvorada_d_oeste_arte_preto.png` | `ALVORADA D OESTE` ❌ |

Nos 6 modelos regulares o acervo tem as 16 cidades com apóstrofo escritas corretamente.
**Só `tipografia` tem o defeito**, em dois graus:

- **7 cidades têm as duas versões** (PA Pau d'Arco; RO Alta Floresta, Alvorada, Espigão,
  Machadinho, Nova Brasilândia e São Felipe d'Oeste). O indexador fica com a versão correta e
  registra o descarte — nunca em silêncio.
- **7 cidades só têm a versão defeituosa** e precisam ser regeradas:

  ```
  GO  São João d'Aliança · Sítio d'Abadia
  MT  Conquista d'Oeste · Figueirópolis d'Oeste · Glória d'Oeste
      Lambari d'Oeste · Mirassol d'Oeste
  ```

  Essas 7 entram como bloqueadas na simulação. Publicar um erro de grafia em produto de cidade é
  pior que não publicar.

`feito_em` não tem nenhum arquivo com apóstrofo — usa a grafia colada (`espigao_doeste`) em todos
os casos, que é consistente e não indica defeito.

### 2.5 Guarda automática contra arte invertida

O job já lê cada PNG para gerar o base64. Calcular a luminância média dos pixels opacos no mesmo
passo custa quase nada e detecta qualquer arquivo que contradiga a convenção do seu modelo.

Regra: arte destinada a cores escuras precisa ter luminância alta; a cores claras, baixa.
Divergência **bloqueia o item** (não sobe para a Ink) e entra no relatório do job.

---

## 3. Nome do produto — uma forma por coleção

A forma **não é única**. Confirmado contra os slugs reais das lojas de origem
(`data/cities.json`, 7.369 produtos): seis coleções usam `{Cidade} | {Modelo} {UF}`, mas
`feito_em` usa prefixo e `gentilicos` troca a cidade pelo gentílico.

| Coleção | Forma do nome | Exemplo | Slug de origem que comprova |
|---|---|---|---|
| legado | `{Cidade} \| Legado {UF}` | `Bodoquena \| Legado MS` | `{cidade}-legado-{uf}` (908×) |
| origem | `{Cidade} \| Origem {UF}` | `Bodoquena \| Origem MS` | `{cidade}-origem-{uf}` (858×) |
| coordenadas | `{Cidade} \| Coordenadas {UF}` | `Bodoquena \| Coordenadas MS` | `{cidade}-coordenadas-{uf}` (856×) |
| tipografia | `{Cidade} \| Tipografia {UF}` | `Bodoquena \| Tipografia MS` | `{cidade}-tipografia-{uf}` (910×) |
| traco | `{Cidade} \| Traço {UF}` | `Bodoquena \| Traço MS` | `{cidade}-traco-{uf}` (908×) |
| territorio | `{Cidade} \| Território {UF}` | `Bodoquena \| Território MS` | `{cidade}-territorio-{uf}` (906×) |
| **feito_em** | **`Feito em {Cidade} {UF}`** | `Feito em Bodoquena MS` | `feito-em-{cidade}-{uf}` (943×) |
| **gentilicos** | **`{Gentílico} \| Gentílico {UF}`** | `Bodoquenense \| Gentílico MS` | `{gentílico}-gentilico-{uf}` (874×) |

> Atenção: o rótulo do modelo no **nome** difere do rótulo na **categoria** em um caso —
> nome usa `Origem`, categoria usa `PONTO DE ORIGEM`. São dois campos separados na configuração.

### 3.1 Fonte do nome da cidade

`/Users/gtomazi/projects/pontos-turisticos/gentilicos_{uf}.json` — código IBGE, município
acentuado e gentílico. Cobre **7.541 dos 7.574** itens do acervo. Não é preciso consultar o
catálogo de origem para nomear.

Os 33 restantes (39 chaves distintas):

- **36 regiões administrativas do DF** (Águas Claras, Ceilândia, Gama, Taguatinga…) — não são
  municípios IBGE, logo não estão no JSON. ~237 produtos. Nome precisa vir do catálogo de origem
  ou de lista confirmada.
- **3 variantes de grafia**: GO `goias_velho` (IBGE: *Goiás*), MT `alto_coite` (distrito, não
  município), RR `sao_luiz`.

### 3.2 Gentílico: resolvido, com 11 casos para revisão

O JSON fecha **918/918** com o acervo — zero sobra, zero falta. E 190 dos 211 gentílicos
compostos batem exatamente com o slug da loja de origem, o que confirma que é a mesma fonte
que gerou os produtos originais. Não é preciso busca na storefront.

O que o dicionário arrasta junto, e que não pode virar nome de produto:

| Caso | Município | Valor no JSON |
|---|---|---|
| alternativas | AP Tartarugalzinho | `tartarugalense ou tartaruguense` |
| | GO Rio Verde | `rio-verdense ou rio-verdino` |
| | MT Barra do Bugres | `barrense / barra-bugrense` |
| | MT Guiratinga | `guiratinguense / guiratingano` |
| | MT Itiquira | `itiquirense / itiquirano` |
| | MT Poxoréu | `poxoreano ou poxorense` |
| | MT Santo Antônio de Leverger | `levergense / santoantoniense` |
| | RO Nova Mamoré | `nova-mamonense ou nova-mamorense` |
| apelido | MT Cuiabá | `cuiabano (papa peixe)` |
| caixa errada | GO Americano do Brasil | `americanense-do-Brasil` |
| | MT União do Sul | `União-sulense` |

Esses 11 entram no balde de revisão com sugestão preenchida. Os outros 907 saem automáticos.

## 4. Categorias — bloqueado pelo limite de 20 caracteres da Ink

### 4.1 O limite

`server.js:5094` já registra: **a Ink limita `name` de coleção a 20 caracteres.** A loja Sul é a
prova viva — todo nome que caberia em 20 ficou inteiro, todo que estouraria foi abreviado:

| Nome completo | ch | O que a Sul tem | ch |
|---|---|---|---|
| `SUL - LEGADO - SC` | 17 | `SUL - LEGADO - SC` | 17 |
| `SUL - ORIGEM - SC` | 17 | `SUL - ORIGEM - SC` | 17 |
| `SUL - FEITO EM - SC` | 19 | `SUL - FEITO EM - SC` | 19 |
| `SUL - COORDENADAS - SC` | 22 | `SUL - COORD. - SC` | 17 |
| `SUL - TIPOGRAFIA - SC` | 21 | `SUL - TIPOG. - SC` | 17 |
| `SUL - TERRITÓRIO - SC` | 21 | `SUL - TERRIT. - SC` | 18 |
| `SUL - GENTÍLICO - SC` | 20 (21 bytes) | `SUL - GENTILICO - SC` | 20 (20 bytes) |

O último caso é o mais revelador: o acento foi removido sem encurtar a contagem de caracteres —
só a de **bytes**. Trate o limite como 20 bytes e use ASCII nos rótulos.

### 4.2 O esquema `ZZ` não cabe

Das 117 categorias pedidas, **90 estouram**. Só 27 cabem. O prefixo `ZZ - ` (5 chars) somado a
`NORTE` (5) não deixa orçamento para modelo + UF.

Risco concreto se a Ink truncar em vez de rejeitar: `ZZ - NORTE - COORDENADAS - {AC,AM,AP,PA,RO,RR,TO}`
viram todas `ZZ - NORTE - COORDEN` — as 7 UFs colapsam numa categoria só, sem erro nenhum.

### 4.3 Duas saídas que cabem (decisão pendente)

**Opção 1 — mantém o `ZZ`, abrevia região e modelo.** 117/117 cabem, maior = 20.

```
ZZ - CO                ZZ - NO
ZZ - CO - MT           ZZ - NO - AC
ZZ - CO - COORD        ZZ - NO - COORD
ZZ - CO - COORD - MT   ZZ - NO - COORD - AC
```

Rótulos: `LEG` · `ORIG` · `COORD` · `TIPOG` · `TRACO` · `TERR` · `FEITO` · `GENT`.
Regiões: `CO` e `NO` (simétrico, 2 chars cada).

**Opção 2 — espelha a convenção que a Sul já usa, sem `ZZ`.** 117/117 cabem, maior = 20.

```
CO - LEGADO            NORTE - LEGADO
CO - LEGADO - MT       NORTE - LEGADO - AC
CO - COORD. - MT       NORTE - COORD. - AC
CO - TERRIT. - MT      NORTE - TERRIT. - AC
```

Rótulos: `LEGADO` · `ORIGEM` · `COORD.` · `TIPOG.` · `TRAÇO` · `TERRIT.` · `FEITO` · `GENT.`
Fica consistente com `SUL - COORD. - SC`, mas **perde a ordenação no fim** que era o objetivo do `ZZ`.

### 4.4 Rótulo do modelo: `ORIGEM`

Confirmado em 12/09, e o catálogo concorda: a Sul usa `SUL - ORIGEM` (1.236 produtos), não
"PONTO DE ORIGEM". Nome do produto e categoria usam a mesma palavra.

## 5. Volume — o fator que dimensiona tudo

| | |
|---|---|
| Produtos criados (Camiseta) | **7.581** |
| Cópias (9 peças de destino) | **68.229** |
| **Total de chamadas à Ink** | **75.810** |
| Bytes de arte enviados | ~11 GB (base64 infla 8,1 GB em ~33%) |

Ordem de grandeza do tempo: `POST /products` com 2-3 artes é a chamada cara (o código já usa
timeout de 120s por causa disso); `/copy` é leve. Em série isso é medido em **dias**. Mesmo com
concorrência, é um job de muitas horas.

Consequências de projeto, todas obrigatórias:

- job **retomável** (nada de reprocessar do zero após queda);
- **concorrência configurável** com backoff — a documentação da Ink não publica rate limit, então
  começa conservador (2-4 em paralelo) e ajusta observando erro/latência;
- **execução em fatias** (por UF ou por modelo), pra ter valor entregue antes do fim;
- as 9 cópias de um produto só entram na fila depois do `product_id` existir.

---

## 6. O que já existe vs. o que falta

| Peça | Status |
|---|---|
| Criar 1 produto com arte × cores | ✅ `/admin/produtos/novo` |
| Copiar pra outra peça (entra no cluster) | ✅ `POST /api/admin/produtos/:loja/:id/duplicar` |
| Criar categorias em lote | ✅ `POST /api/admin/categorias/:loja/bulk-create` |
| Cache do catálogo de origem | ✅ cache do catálogo + feed CSV |
| **Criar produtos em lote** | ❌ só 1 a 1 no wizard |
| **Job/fila de criação de produto** | ❌ existe `bulk_category_jobs` (categoria), não produto |
| **Ler artes de um diretório local** | ❌ o painel só recebe upload pelo browser |
| **Casar arte ↔ produto de origem por slug** | ❌ |
| **Copy em cadeia após criar** | ❌ |

---

## 7. Plano — aba "Criar produtos" na Migração

Nova aba em `/admin/internal/origens-migration`, atrás de `requireInternalTools` como o resto.

### Passo 1 — Indexar o acervo

Varre o diretório de artes no servidor, monta `(modelo, uf, cidade, sufixo) → caminho`.
Diretório vem de env var (`MIGRACAO_ARTES_DIR`), não de input do usuário — evita path traversal.

### Passo 2 — Casar com o catálogo de origem

Para cada combinação, acha o produto correspondente em Centro/Norte no cache do catálogo
(match por slug do link). De lá vêm nome e UF já corretos.

Saída por item: `pronto` · `sem_arte` · `sem_produto_origem` · `arte_invertida`.

### Passo 3 — Categorias

Deriva os 118 nomes, roda `bulk-preview`, mostra o que falta, cria com `bulk-create`.
Guarda o `mapaIds` pra usar na criação.

### Passo 4 — Mapa de cores

Lê `GET /api/admin/produto-tipos?loja=sul`, lista as `printable_areas` da Camiseta e deixa
marcar quais cores são escuras/claras. Resolve `base_image_id` por nome de cor em runtime.
Mesma tela escolhe as 9 peças de destino do `/copy`.

### Passo 5 — Simulação

Mesma UX do resto do painel: tabela com nome final, categorias, quantas cores por arte, e o
que está bloqueado. Nada é gravado.

### Passo 0 — Piloto de 1 produto — RODADO 12/09

Executado com `feito_em/MS/bodoquena` → produto `4937439`, cluster `514346`.

| Pergunta | Resposta |
|---|---|
| Nome de categoria > 20 trunca? | **Não trunca.** `ZZ - CO - FEITO - MS` (20) gravado intacto. Esquema Opção 1 validado. |
| Produto nasce oculto? | **Sim**, `visible_in_store:false` respeitado. |
| Cópias herdam o oculto? | **Sim**, as 9 nasceram ocultas. **Nenhum PATCH extra** — o volume continua 75.810 chamadas. |
| Cópias entram no mesmo cluster? | **Sim**, todas em `514346`. |
| Preço das cópias? | **Correto**, cada uma pegou o padrão do seu tipo (Body 89,90 · Hoodie 209,90 · Suéter 179,90…). |
| Arte aplicada certo? | **NÃO** — bug do indexador (seção 1.2). Corrigido; exige nova rodada. |

Checklist do piloto:

1. a arte subiu e ficou aplicada em **todas as áreas** (todos os modelos × todas as cores);
2. a arte certa foi para cada balde de cor (clara/escura/amarelo);
3. as 5 categorias ficaram vinculadas com o nome que a Ink realmente gravou;
4. o produto nasceu desativado;
5. as 9 cópias entraram no mesmo `product_cluster` e também nasceram desativadas;
6. **as cores que só existem no destino** (Azul Bebê, Rosa Bebê, Off White, Areia, Bege, Verde
   Musgo, Verde Oliva) receberam a arte de claridade certa — ver a tabela de paletas abaixo.

### Passo 0c — Lições da primeira execução (12/09)

Quatro bugs reais, todos corrigidos. Registrados porque cada um é uma armadilha que volta.

**1. `Idempotency-Key` regerada a cada tentativa.** O cliente gerava `crypto.randomUUID()` por
chamada, inclusive nos retries do `comRetry`. Um `POST /products` que criava na Ink mas cuja
resposta se perdia na rede virava **3 produtos idênticos**, um por tentativa. A chave agora é
derivada do item (`sha256('produto|origem/MS/aguaclara')`), estável entre tentativas e entre
reinícios do processo.

**2. Body de ~12 MB derrubando a conexão.** A Ink exige uma entrada de `arts` por
`base_image_id`, então a mesma arte vai repetida 18 vezes. Com concorrência 3 eram ~36 MB
simultâneos e a conexão caía (`fetch failed`). Concorrência padrão passou para **1**; a 1,3
item/min medido, 7.553 itens levam ~95 h.

**3. Estado gravado só no fim.** Entre criar o produto e gravar o estado havia 9 chamadas de
cópia — minutos em que uma queda deixaria o produto na Ink e ausente do arquivo, e a rodada
seguinte recriaria. O estado agora é por fase: `criado` (antes das cópias) · `copia` · `concluido`.

**4. Guarda de luminância reprovando arte boa.** Contava pixels com `alpha > 200` numa miniatura
de 80×80. A arte é traço fino num canvas 4270×4900: ao reduzir, a antialiasing espalha a
opacidade e quase nenhum pixel sobrevive — em `origem/MS/fatima_do_sul` sobravam **zero**, e a
guarda barrava o upload. Passou a usar **média ponderada por alpha** a 400 px (243 vs 4 no mesmo
arquivo, separação limpa), e arte sem pixel mensurável é tratada como inconclusiva, nunca como
reprovação.

### Duas redes de segurança contra duplicata

Nenhuma sozinha basta, porque a API da Ink **não tem DELETE de produto** — duplicata só sai à mão.

- **Índice do catálogo por nome**, montado no início da execução (~850 páginas). Nome já
  existente é **adotado** em vez de recriado. Só vale quando o nome identifica um produto sem
  ambiguidade: nome único no plano e um único id na loja.
- **Reconciliação**: item marcado como concluído cujo produto não está mais no catálogo é
  **reaberto**. Apagar produto no painel deixou de ser forma silenciosa de perder item — foi o
  que aconteceu com Anastácio e Anaurilândia em 12/09.

### Gentílico repetido não é duplicata

O mesmo gentílico serve cidades diferentes: `Boa-vistense | Gentílico PR` existe para mais de uma
cidade do PR, e a loja já tinha 97 casos assim antes desta migração. No plano atual isso acontece
em 2 nomes:

```
Formosense | Gentílico GO   <-  Formosa, Formoso
Lagunense  | Gentílico MS   <-  Guia Lopes da Laguna, Laguna Carapã
```

Esses nomes ficam **fora da adoção por nome** (adotariam o produto da cidade vizinha) e dependem
só do arquivo de estado. Os outros 7 modelos são imunes: o nome carrega cidade + UF.

#### Paletas dos 9 tipos de destino

Medido na loja no piloto:

| Peça | Cores | Só no destino |
|---|---|---|
| Camiseta (base) | 9 | — |
| Cropped | 7 | — |
| Camiseta Infantil | 6 | — |
| Camiseta Algodão Peruano | 5 | Verde Musgo, Verde Oliva |
| Body Infantil | 4 | Azul Bebê, Rosa Bebê |
| Hoodie Moletom | 4 | Off White, Bege |
| Suéter Moletom | 4 | Off White, Bege |
| Camiseta Oversized | 3 | Off White, Areia |
| Cropped Moletom | 2 | — |
| Regata | 2 | — |

O `/copy` gerou variantes **nessas cores novas mesmo sem arte correspondente na origem** (Body
Infantil saiu com 24 variantes incluindo Azul Bebê e Rosa Bebê). Falta confirmar visualmente qual
arte a Ink escolheu para elas: são todas cores claras, então precisam da arte escura — se vier a
clara, a estampa some.

#### Checklist original

Antes de qualquer lote, criar **um** produto de ponta a ponta e conferir na loja:

1. a arte subiu e ficou aplicada em todas as cores da camiseta;
2. a arte certa foi para cada balde de cor (clara/escura/amarelo);
3. as 5 categorias ficaram vinculadas, com o nome que a Ink realmente gravou
   (**é aqui que se descobre se ela trunca ou rejeita acima de 20 caracteres**);
4. o produto nasceu **desativado**;
5. as 9 cópias entraram no mesmo `product_cluster` e também nasceram desativadas.

Só depois disso o job em lote é liberado.

### Passo 6 — Execução em job

Tabelas novas `produto_criacao_jobs` + `produto_criacao_job_items` (+ `_copias`), retomáveis.
Por item:

1. lê os 2-3 PNGs, valida a luminância contra a convenção do modelo (§2.4);
2. `POST /v1/stores/products` na Sul, tipo Camiseta, `artGroups` = artes × suas cores,
   **`visible_in_store: false`** — Centro e Norte nascem desativados;
3. guarda `product_id` e `product_cluster_id`;
4. enfileira 9 × `/copy`, uma por peça de destino. `/copy` não aceita `visible_in_store`:
   conferir no piloto se a cópia herda o estado do original e, se não herdar, emendar um
   `PATCH visible_in_store:false` por cópia;
5. grava resultado por peça.

Idempotência por `(job_id, modelo, uf, cidade)` e por `(item, peça)`, mais `Idempotency-Key`
por chamada.

---

## 8. Onde as artes vivem — decidido

**Execução local.** O job roda com `node server.js` na máquina do operador, apontando pros
tokens de produção (`INK_TOKEN_*`) e pro `DATABASE_URL` de produção. Nada de bucket.

Precedente: o upload já era feito direto no painel da Ink com o Chrome em modo debug, com a
máquina ligada o tempo todo — este job troca isso por um processo Node, que consome muito menos.

Requisitos da execução local:

- `INK_TOKEN_SUL` (destino) e `INK_TOKEN_CENTRO`/`INK_TOKEN_NORTE` (leitura do catálogo de origem);
- `DATABASE_URL` de produção — o job é retomável e o estado tem que sobreviver a reinício;
- `INTERNAL_TOOLS_ENABLED=true`;
- `MIGRACAO_ARTES_DIR` apontando pro acervo.

---

## 9. Acesso ao Postgres de produção — pendente

`railway ssh` não serve: o remoto embrulha o comando num `sh -c` que só entrega o primeiro token
e quebra em qualquer parêntese (`node -p 1+1` funciona, `node -e console.log(1)` não).
`railway run` também não, porque `postgres.railway.internal` só resolve dentro da rede do Railway,
e o serviço Postgres não expõe `DATABASE_PUBLIC_URL`.

Falta decidir uma das opções:

- expor o proxy TCP do Postgres no Railway e usar a URL pública;
- instalar `psql` na máquina local e usar `railway connect Postgres`;
- liberar o uso da API do painel em `orgulhoregional.com.br` com a senha de admin.

Só é preciso para (a) nomear as 36 regiões administrativas do DF e (b) conferir o casamento
arte ↔ produto antes de rodar. Nada dos outros 7.337 produtos depende disso.

---

## 10. Execução — 12 a 15/09

### 10.1 Fila de `resizing` da Ink e como destravar

Só 5 peças passam por `resizing` depois do `/copy`: **Cropped, Body Infantil, Hoodie Moletom,
Cropped Moletom e Regata** (grade de impressão diferente da Camiseta). Camiseta, Algodão Peruano,
Camiseta Infantil, Oversized e Suéter Moletom nunca passaram.

Medido por comparação de fotos do catálogo (`produtos_ink`):

| Janela | O que aconteceu |
|---|---|
| 12/09 ~22h → 14/09 ~09h | nenhuma cópia saiu de `resizing` (5.277 → 6.465) |
| 14/09 08:52 → 17:13 | 3.267 terminaram (~390/h) |
| 14/09 17:13 → 15/09 | parou de novo (3.595 idêntico) |

Tentativas de destravar num Cropped preso desde 12/09:

| Tentativa | Resultado |
|---|---|
| Recópia (`/copy` de novo) | cópia nova entra na mesma fila; a antiga vira órfã (API sem DELETE) |
| `PATCH arts` trocando a arte | continuou em `resizing` — contra o que a doc promete |
| Reaplicar imagem pelo editor do painel | destravou as variantes tocadas; o produto seguiu `resizing` |
| **`remove_variants` + `arts` em duas metades** | **destravou: imagens carregadas e fora de `resizing`, mesmo id, sem órfão** |

A API não aceita desativar todas as variantes de uma vez, por isso as duas metades. Implementado
em `reaplicarProduto` (`scripts/migracao-config.mjs`), usado por `migracao-verificar.mjs
--executar` (lote) e `migracao-corrigir.mjs --reaplicar` (um id).

### 10.2 Execução faseada

Decisão de 15/09: subir primeiro só a Camiseta base (`--fase=base`) e as peças uma por rodada
(`--copias=<peça>`), destravando o que prender entre uma e outra. As estampas de Centro/Norte não
serão ativadas agora na Sul.

### 10.3 Incidentes

- **12→13/09, 05h–11h**: PC hibernou — buraco de 6h sem nenhum registro. Usar `caffeinate -i`.
- **13→14/09, 23h–07h**: Ink respondeu `500` contínuo no `POST /products` com o processo acordado
  (150–200 erros por meia hora). Nenhum produto criado escondido. O lote passou a pausar após 8
  falhas de servidor seguidas e a devolver o item pra fila.
- **409 de Idempotency-Key**: confirma que a Ink honra a chave, mas recusa reusar uma cuja 1ª
  tentativa caiu no meio. Tratado conferindo agrupamento/nome antes de gerar chave nova.

### 10.4 Pendente

- Confirmar os baldes das cores exclusivas das peças de destino (`--cores-extras`):
  arte clara em Verde Musgo e Verde Oliva; arte escura em Rosa Bebê, Azul Bebê, Off White, Areia e Bege.
- 21 itens bloqueados (9 gentílicos ambíguos, 5 cidades sem nome oficial, 7 artes de tipografia sem apóstrofo).
- Mockup de vitrine (camiseta dobrada) não é configurável pela API.
