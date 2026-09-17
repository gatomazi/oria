# Claude Code — Migração final de categorias com snapshot apenas para coleções especiais

## Contexto

A ferramenta interna de migração da Use Origens já possui:

- regras;
- simulação;
- associação em lote;
- criação de categorias;
- suporte a filtros por nome;
- estrutura de categorias internas por região/UF/coleção.

Existe um bug/limitação prática no fluxo de categorias da API da Reserva Ink que exige um cuidado específico:

> Para algumas coleções antigas, precisamos identificar a categoria antiga do produto ANTES de removê-la. Depois da exclusão, essa informação deixa de existir.

Porém isso **não vale para a massa de estampas de cidades**.

Nas estampas de cidades, o **nome do produto já é suficiente para classificar o destino**, então elas podem ser migradas mesmo depois de ficarem sem categoria.

---

# Regra principal

Existem dois grupos distintos de migração.

## GRUPO A — Produtos de cidade

Não dependem da categoria antiga.

A classificação é feita pelo nome.

Exemplos:

```text
Joinville | Legado SC
Capivari de Baixo | Traço SC
Joinville | Coordenadas
Feito em Joinville
Joinvilense | Gentílico SC
```

Esses produtos podem ser classificados por:

```text
nome
coleção detectada
UF detectada
cidade → UF quando necessário
```

Não precisam de snapshot da categoria antiga para serem migrados.

---

## GRUPO B — Coleções especiais

Dependem da categoria antiga porque o título não identifica necessariamente a coleção.

Exemplos:

```text
Gaúcho
Pescador
Araucária no campo
Navegue-se | Navegantes
Saint Catherine
Pai Gaúcho Pescador Churrasqueiro | Lenda
```

Nesses casos, precisamos ler a categoria antiga ANTES da remoção.

Exemplos de origem:

```text
Marco Zero
Dito no Sul
Fala de Onde
Made in Sul
Minimalista
Essência
Identidade
Lenda do Sul
Básicos de Origem
```

---

# Objetivo

Implementar um fluxo de migração em duas estratégias:

```text
Produtos de cidade
→ classificar pelo nome
→ não dependem de categoria antiga

Coleções especiais
→ classificar pela categoria atual
→ gerar snapshot antes da exclusão
```

Depois disso:

```text
remover categorias antigas
↓
criar nova estrutura
↓
resolver IDs novos
↓
aplicar categorias finais
```

---

# ETAPA 1 — Inventário do catálogo

Antes de qualquer exclusão, analisar:

```text
produtos
categorias atuais
nome do produto
IDs
```

Separar automaticamente em:

```text
A. Cidade — classificação por nome
B. Especial — classificação por categoria antiga
C. Não classificado
D. Conflito
```

---

# ETAPA 2 — Classificação dos produtos de cidade

## Coleções de cidade

Considerar:

```text
Origem
Coordenadas
Tipografia
Traço
Território
Legado
Feito Em
Gentílico
```

## Categorias finais

Para cada produto de cidade, gerar:

```text
SEU LUGAR
SUL
SUL - {UF}
SUL - {COLEÇÃO}
SUL - {COLEÇÃO} - {UF}
```

Exemplo:

```text
Joinville | Legado SC
```

Resultado:

```text
SEU LUGAR
SUL
SUL - SC
SUL - LEGADO
SUL - LEGADO - SC
```

---

# Detecção da coleção pelo nome

Exemplos:

```text
"| Origem"        → ORIGEM
"| Legado"        → LEGADO
"| Coordenadas"   → COORDENADAS
"| Tipografia"    → TIPOGRAFIA
"| Traço"         → TRAÇO
"| Território"    → TERRITÓRIO
"Feito em "       → FEITO EM
"| Gentílico"     → GENTILICO
```

Normalizar acentos apenas para matching.

---

# Detecção de UF explícita

Preferir sufixo:

```text
 RS
 SC
 PR
```

Não usar apenas:

```text
contains "SC"
```

Exemplo conceitual:

```ts
/\s(RS|SC|PR)$/i
```

---

# Produtos de cidade sem UF no nome

Exemplos:

```text
Joinville | Coordenadas
Feito em Joinville
```

Usar fallback:

```text
cidade → UF
```

Ordem:

```text
1. UF explícita no título
2. mapa cidade → UF
3. revisão manual
```

Esses produtos continuam NÃO dependendo da categoria antiga.

---

# ETAPA 3 — Classificação das coleções especiais

Esses produtos devem ser classificados usando:

```text
current_category
```

antes de qualquer remoção.

Mapeamento inicial:

```text
Fala de Onde       → FALA DAQUI
Dito no Sul        → FALA DAQUI

Básicos de Origem  → DA NOSSA TERRA
Marco Zero         → DA NOSSA TERRA
Made in Sul        → DA NOSSA TERRA
Minimalista        → DA NOSSA TERRA
Essência            → DA NOSSA TERRA
Identidade          → DA NOSSA TERRA

Lenda do Sul       → FEITO PRA VOCÊ
```

Criar apenas regras para categorias que realmente existirem.

---

# Importante

Para coleções especiais, não confiar apenas no título.

Exemplo:

```text
Produto:
Gaúcho

Categoria atual:
Marco Zero
```

Resultado:

```text
DA NOSSA TERRA
```

Outro:

```text
Produto:
Guria | Dizeres

Categoria atual:
Dito no Sul
```

Resultado:

```text
FALA DAQUI
```

Outro:

```text
Produto:
Pai Gaúcho Pescador Churrasqueiro | Lenda

Categoria atual:
Lenda do Sul
```

Resultado:

```text
FEITO PRA VOCÊ
```

---

# ETAPA 4 — Criar plano de migração

Antes de remover categorias antigas, gerar um plano persistido.

## Para produtos de cidade

Salvar apenas a classificação calculada pelo nome.

Exemplo:

```ts
{
  productId: 123,
  productName: "Joinville | Legado SC",
  classificationSource: "product_name",
  targetCategoryKeys: [
    "PUBLIC_SEU_LUGAR",
    "REGION_SUL",
    "UF_SC",
    "COLLECTION_LEGADO",
    "COLLECTION_LEGADO_SC"
  ]
}
```

A categoria antiga não é necessária.

---

## Para coleções especiais

Salvar também a categoria de origem usada para classificar.

Exemplo:

```ts
{
  productId: 456,
  productName: "Gaúcho",
  classificationSource: "current_category",
  sourceCategories: [
    "Marco Zero"
  ],
  targetCategoryKeys: [
    "PUBLIC_DA_NOSSA_TERRA"
  ]
}
```

---

# ETAPA 5 — Simulação obrigatória

Antes de excluir qualquer categoria, mostrar:

```text
Produtos analisados: X

CIDADES
Prontos por nome: X
UF via título: X
UF via cidade: X

COLEÇÕES ESPECIAIS
Classificados por categoria antiga: X

SEM CLASSIFICAÇÃO
X

CONFLITOS
X
```

---

# Preview

Tabela:

```text
Produto
Tipo de classificação
Origem
Destino
Status
```

Exemplo cidade:

```text
Joinville | Legado SC
Nome
—
SEU LUGAR + SUL + SC + LEGADO
Pronto
```

Exemplo especial:

```text
Gaúcho
Categoria antiga
Marco Zero
DA NOSSA TERRA
Pronto
```

---

# ETAPA 6 — Congelar plano

Depois da aprovação:

```text
Gerar snapshot / congelar plano
```

O snapshot deve ser persistido.

Após congelar:

- não recalcular regras durante a execução;
- não incluir novos produtos automaticamente;
- não alterar targetCategoryKeys;
- não depender das categorias antigas para continuar.

---

# ETAPA 7 — Remover categorias antigas

Só depois do snapshot.

Mostrar lista das categorias antigas que serão removidas.

Exemplo:

```text
Origem
Coordenadas
Tipografia
Traço
Território
Legado
Feito Em
Gentílico

Fala de Onde
Dito no Sul
Marco Zero
Made in Sul
Minimalista
Lenda do Sul
...
```

## Importante

A remoção deve acontecer apenas depois que:

```text
✓ produtos de cidade foram classificados pelo nome
✓ coleções especiais tiveram sua origem salva no snapshot
✓ conflitos foram separados
```

---

# Fluxo visual

```text
1. Analisar catálogo
2. Simular
3. Congelar plano
4. Remover categorias antigas
5. Validar remoção
6. Criar nova estrutura
7. Resolver IDs
8. Aplicar categorias
9. Validar resultados
10. Relatório final
```

---

# ETAPA 8 — Validação da remoção

Após excluir:

```text
validar via API
```

Não confiar apenas no clique.

Estados:

```text
Removida
Ainda existe
Falha ao remover
```

Só seguir quando as categorias exigidas forem removidas ou quando o usuário confirmar exceção explícita.

---

# ETAPA 9 — Criar nova estrutura

Criar:

## Públicas

```text
SEU LUGAR
FALA DAQUI
DA NOSSA TERRA
DO NOSSO JEITO
FEITO PRA VOCÊ
PRA PRESENTEAR
NOVIDADES
```

## Internas Sul

```text
SUL
SUL - RS
SUL - SC
SUL - PR
```

E:

```text
SUL - {COLEÇÃO}
SUL - {COLEÇÃO} - {UF}
```

conforme lista já aprovada.

---

# Não salvar IDs de destino antes da criação

No snapshot salvar:

```text
category keys
```

e não IDs temporários.

Exemplo:

```text
PUBLIC_SEU_LUGAR
PUBLIC_FALA_DAQUI
PUBLIC_DA_NOSSA_TERRA
PUBLIC_FEITO_PRA_VOCE

REGION_SUL
UF_SC
COLLECTION_LEGADO
COLLECTION_LEGADO_SC
```

Depois da criação:

```text
category key
↓
resolver ID real
↓
PATCH produto
```

---

# ETAPA 10 — Aplicar categorias nos produtos

Como os produtos foram deixados sem categorias, usar modo:

```text
REPLACE
```

com a lista final calculada.

## Cidade

Exemplo:

```text
Joinville | Legado SC
```

PATCH:

```text
collections = [
  SEU LUGAR,
  SUL,
  SUL - SC,
  SUL - LEGADO,
  SUL - LEGADO - SC
]
```

---

## Especial

Exemplo:

```text
Gaúcho
```

PATCH:

```text
collections = [
  DA NOSSA TERRA
]
```

Se alguma coleção especial também precisar de outra nova categoria aprovada, incluir no snapshot antes da execução.

---

# Importante sobre REPLACE

Neste fluxo específico, REPLACE é proposital porque as categorias antigas foram removidas.

Não buscar nem preservar categorias antigas durante a execução final.

O estado final deve ser exatamente o definido pelo snapshot.

---

# ETAPA 11 — Produtos não classificados

Não atualizar automaticamente:

```text
Sem classificação
Conflito
UF não resolvida
Categoria especial não mapeada
```

Esses ficam para revisão.

---

# ETAPA 12 — Relatório de categorias antigas não mapeadas

Antes da exclusão, gerar lista:

```text
Categoria
Quantidade de produtos
3 exemplos
Destino
```

Se não houver destino:

```text
Revisão necessária
```

Exemplos possíveis:

```text
Fé de Origem
Pré-treino Raiz
Carnaval
Dia dos Pais
```

Não excluir silenciosamente se isso fizer perder classificação de produtos especiais.

---

# Regra de segurança para exclusão

Uma categoria antiga especial só pode ser removida quando todos os produtos associados estiverem em um destes estados:

```text
Classificado
Ignorado manualmente
Conflito conhecido e aceito
```

Se houver produtos sem destino:

```text
bloquear exclusão da categoria
```

ou exigir confirmação explícita de risco.

---

# ETAPA 13 — Mudança no Rule Engine

Manter suporte a:

```text
product_name
current_category
```

A lógica deve escolher a fonte correta:

```text
cidade → product_name
especial → current_category
```

Não obrigar as regras de cidade a depender de `current_category`.

---

# ETAPA 14 — Preset atualizado

Criar preset:

```text
Use Origens — Migração Final
```

Ele deve conter dois grupos.

## Grupo A — Cidade

Regras por nome:

```text
Origem
Coordenadas
Tipografia
Traço
Território
Legado
Feito Em
Gentílico
```

com UF por:

```text
sufixo
ou
cidade → UF
```

## Grupo B — Especiais

Regras por categoria atual:

```text
Fala de Onde
Dito no Sul
Básicos de Origem
Marco Zero
Made in Sul
Minimalista
Essência
Identidade
Lenda do Sul
```

---

# ETAPA 15 — Checkpoints visuais

Na UI da migração:

```text
1. Analisar
2. Classificar
3. Revisar
4. Congelar plano
5. Limpar categorias antigas
6. Criar novas categorias
7. Aplicar
8. Validar
9. Relatório
```

---

# ETAPA 16 — Bloqueios

Depois de `Congelar plano`:

- bloquear edição das regras daquela execução;
- bloquear alteração de destinos daquela execução;
- qualquer mudança exige nova simulação.

---

# ETAPA 17 — Testes mínimos

## Cidade com UF

```text
Joinville | Legado SC
→ classifica sem depender da categoria antiga
```

## Cidade sem UF

```text
Joinville | Coordenadas
→ cidade → SC
→ classifica sem depender da categoria antiga
```

## Feito em

```text
Feito em Joinville
→ cidade → SC
→ classifica sem depender da categoria antiga
```

## Especial

```text
Gaúcho
categoria atual = Marco Zero
→ snapshot DA NOSSA TERRA
```

## Especial após remoção

Depois de apagar `Marco Zero`:

```text
Gaúcho
```

continua com destino:

```text
DA NOSSA TERRA
```

porque o snapshot foi salvo antes.

## Reexecução

O job final deve usar somente o snapshot.

---

# Não fazer

Não:

```text
exigir categoria antiga para estampas de cidade
```

Não:

```text
recalcular categoria especial depois da exclusão
```

Não:

```text
excluir categoria especial antes de salvar o snapshot
```

Não:

```text
salvar apenas IDs de destino antes de criar as novas categorias
```

Não:

```text
executar produto em conflito automaticamente
```

Não:

```text
usar ADD/PRESERVE no passo final depois da limpeza
```

O passo final usa:

```text
REPLACE
```

porque queremos o estado final exato.

---

# Critério de aceitação

A migração está correta quando:

## Cenário A

Um produto de cidade pode estar sem categoria e ainda assim ser classificado corretamente pelo nome.

## Cenário B

Um produto especial pode perder a categoria antiga depois que o snapshot foi congelado sem perder seu destino.

## Cenário C

As categorias antigas são removidas antes da criação/aplicação da nova taxonomia.

## Cenário D

A nova associação final usa apenas o plano aprovado.

## Cenário E

Produtos não classificados/conflitantes não são alterados automaticamente.

---

# Entrega esperada

Ao finalizar, informar:

1. como o sistema diferencia cidade vs especial;
2. como produtos de cidade são classificados sem categoria antiga;
3. como o snapshot dos especiais é persistido;
4. quais categorias antigas foram detectadas;
5. quais ficaram bloqueadas por produtos sem classificação;
6. como a exclusão é validada;
7. como as novas categorias são criadas;
8. como category keys são resolvidas para IDs;
9. como o job final usa REPLACE;
10. testes implementados;
11. relatório final de migração.

Confirmar explicitamente:

```text
Produtos de cidade NÃO dependem da categoria antiga.

Coleções especiais dependem da categoria antiga apenas na fase de planejamento/snapshot.

Depois do snapshot, a execução não depende mais das categorias antigas.

As novas categorias são aplicadas em modo REPLACE após a limpeza.
```
