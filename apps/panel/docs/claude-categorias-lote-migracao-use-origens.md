# Claude Code — Categorias em Lote + Associação Múltipla + Migração Use Origens

## Contexto

O painel já está em **React + TypeScript**, integrado à Reserva Ink e funcional.

Precisamos agora adicionar um conjunto de ferramentas para facilitar a migração e organização do catálogo por categorias.

Existem **dois níveis de funcionalidade**:

### A. Funcionalidades genéricas do produto

Devem poder permanecer no SaaS:

1. **Criar categorias em lote**
2. **Associar vários produtos a uma ou mais categorias**
3. **Selecionar produtos através de filtros**
4. **Executar a associação como job com progresso**
5. **Permitir modo seguro de adicionar preservando categorias existentes**

### B. Ferramenta interna específica

Criar uma ferramenta interna chamada provisoriamente:

```text
Migração Use Origens
```

Ela será utilizada apenas no nosso cenário atual de migração.

Essa ferramenta pode:

- filtrar produtos pelo nome;
- identificar coleção;
- identificar UF;
- combinar múltiplas regras;
- atribuir várias categorias ao mesmo produto;
- substituir completamente as categorias atuais;
- simular antes de executar;
- executar milhares de atualizações;
- gerar relatório final.

Esta ferramenta específica **não precisa aparecer para clientes normais do SaaS**.

---

# Premissas da API da Reserva Ink

Antes de implementar, confirme os contratos reais no client/service atual e na documentação da Ink.

## Categorias

A API trata categorias como `collections`.

Endpoints relevantes:

```text
GET    /v1/stores/collections
POST   /v1/stores/collections
GET    /v1/stores/collections/{id}
PATCH  /v1/stores/collections/{id}
DELETE /v1/stores/collections/{id}
```

### Limite importante

`product_ids` e `kit_ids` em criação/edição de categoria possuem limite de:

```text
100 ids por lista
```

Além disso, quando `product_ids` é enviado no PATCH da categoria, a associação é substituída.

Portanto NÃO implementar isto:

```text
PATCH categoria com produtos 1-100
PATCH mesma categoria com produtos 101-200
PATCH mesma categoria com produtos 201-300
```

Isso não é um append seguro.

---

# Associação correta para mais de 100 produtos

A associação em massa deve acontecer pelo **produto**.

O produto suporta atualização de `collections`.

Ao enviar:

```ts
collections: [1, 2, 3]
```

o conjunto de categorias do produto passa a ser esse conjunto.

Portanto:

```text
1 categoria
↓
5.000 produtos
↓
5.000 updates de produto
```

é uma estratégia válida.

---

# Modos de associação

Precisamos suportar dois modos.

## 1. ADD / PRESERVE

Modo genérico e seguro.

Fluxo:

```text
GET produto
↓
ler collections atuais
↓
union(collections atuais + selecionadas)
↓
PATCH produto
```

Exemplo:

```text
atuais:
[2, 8]

adicionar:
[15, 20]

resultado:
[2, 8, 15, 20]
```

Esse deve ser o modo padrão da funcionalidade pública.

---

## 2. REPLACE

Modo para migração.

Não precisa buscar categorias atuais.

Exemplo:

```text
categorias calculadas:
[15, 20, 31]

PATCH produto:

collections:
[15, 20, 31]
```

As categorias antigas são substituídas.

### Contexto atual

Na migração atual isso é aceitável porque estamos reorganizando a loja e queremos definir o estado final das categorias.

Na ferramenta:

```text
Migração Use Origens
```

o modo padrão pode ser:

```text
REPLACE
```

Mas deve existir aviso visual claro.

---

# Arquitetura geral

Criar três recursos.

```text
Categorias
├── Nova categoria
├── Criar em lote
└── Associar produtos
```

E em área interna:

```text
Ferramentas internas
└── Migração Use Origens
    ├── Categorias
    ├── Regras
    ├── Simulação
    ├── Execução
    └── Histórico
```

---

# PARTE 1 — Criar categorias em lote

## Entrada

Na tela:

```text
Categorias
```

adicionar botão:

```text
Criar em lote
```

Abrir Drawer ou Modal grande.

### Método principal

Textarea:

```text
LEGADO - MT
PONTO ORIGEM - MT
COORDENADAS - MT
TIPOGRAFIA - MT
TRAÇO - MT
TERRITÓRIO - MT
FEITO EM - MT
GENTILICO - MT
```

Interpretar:

```text
1 linha = 1 categoria
```

Ignorar:

- linhas vazias;
- espaços nas extremidades.

Detectar duplicados.

---

# Limite de nome

Antes de enviar para a Ink, validar o limite real de nome da API.

A documentação atual indica limite de 20 caracteres para `name`.

Portanto:

- mostrar contador;
- marcar nome inválido;
- não truncar silenciosamente;
- permitir editar antes de criar.

---

# Configurações em lote

Campos:

```text
Disponível na loja:
[ ] Sim
[x] Não

Descrição padrão:
[ opcional ]

Posição:
● continuar após última categoria
○ definir manualmente
```

Para a migração interna, default:

```text
is_available = false
```

---

# Preview

Antes de criar:

```text
32 categorias detectadas

28 válidas
2 já existem
2 inválidas
```

Tabela:

```text
Nome
Status
Ação
```

Estados:

```text
Pronta
Já existe
Nome inválido
Duplicada na lista
```

---

# Criação

Criar uma chamada por categoria.

Não enviar produtos nesse momento.

Cada operação precisa usar:

```text
Idempotency-Key
```

determinístico ou persistido pelo job.

---

# Resultado

Exibir:

```text
Criadas: 28
Existentes: 2
Falharam: 2
```

Registrar mapa:

```ts
{
  "LEGADO - MT": 123,
  "PONTO ORIGEM - MT": 124
}
```

Esse mapa será útil para a migração.

---

# PARTE 2 — Associação genérica de produtos

Adicionar na página:

```text
Categorias
```

ação:

```text
Associar produtos
```

Pode abrir página dedicada.

Sugestão de rota:

```text
/admin/categorias/associar
```

---

# Etapa 1 — Escolher categorias

Select múltiplo:

```text
Categorias de destino

[x] LEGADO - MT
[x] MT
[x] CENTRO - MT
```

Permitir selecionar:

```text
1..N categorias
```

---

# Etapa 2 — Filtrar produtos

Filtros:

```text
Nome contém
Tipo
Visibilidade
Status
Aprovação
Categoria atual
```

Usar apenas filtros suportados pelos dados reais do painel/API.

Filtro fundamental:

```text
Nome contém
```

porque será essencial na migração.

---

# Resultado do filtro

Exemplo:

```text
2.746 produtos encontrados
```

Tabela:

```text
[ ] Produto
    ID
    Tipo
    Categorias
```

A seleção deve suportar:

```text
Selecionar página
Selecionar todos os resultados
```

Não depender de renderizar milhares de produtos de uma vez.

---

# Etapa 3 — Modo

Mostrar:

```text
Modo de associação

● Adicionar preservando categorias atuais
○ Substituir categorias atuais
```

Para a feature pública:

```text
default = ADD
```

Ao escolher REPLACE:

mostrar warning:

```text
As categorias atuais dos produtos selecionados serão substituídas pelas categorias escolhidas.
```

---

# Etapa 4 — Simular

Antes de executar:

```text
2.746 produtos selecionados
3 categorias selecionadas
Modo: Adicionar
```

Mostrar amostra.

Para REPLACE:

```text
Produto B

Depois:
LEGADO - MT
MT
CENTRO - MT
```

---

# PARTE 3 — Bulk Job

Não executar milhares de requests diretamente no request HTTP da página.

Criar arquitetura de job.

Conceito:

```text
BulkCategoryAssignmentJob
```

## Estados

```text
draft
queued
running
completed
completed_with_errors
failed
cancelled
```

## Modelo

Adaptar ao banco atual, mas persistir no mínimo:

```ts
type BulkCategoryJob = {
  id: string
  storeId: string
  mode: "add" | "replace"
  categoryIds: number[]
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
  status: string
}
```

E por item:

```ts
type BulkCategoryJobItem = {
  jobId: string
  productId: number
  status: "pending" | "running" | "success" | "failed" | "skipped"
  categoriesBefore?: number[]
  categoriesAfter?: number[]
  attempts: number
  error?: string
}
```

---

# Execução ADD

Para cada produto:

```text
GET produto
↓
collections atuais
↓
union com categorias selecionadas
↓
se não mudou → skipped
senão → PATCH produto
```

---

# Execução REPLACE

Para cada produto:

```text
categoriesAfter = targetCategoryIds
↓
PATCH produto
```

Não precisa realizar GET apenas para descobrir categoria anterior.

---

# Concorrência

Não disparar milhares de requests simultâneos.

Começar conservadoramente:

```text
concurrency = 3
```

Se a API demonstrar estabilidade, isso pode ser aumentado depois.

---

# Retry

Retry apenas para falhas transitórias:

```text
429
500
502
503
504
network error
```

Backoff sugerido:

```text
1s
3s
10s
30s
```

Máximo inicial:

```text
3 ou 4 tentativas
```

---

# Idempotência

Cada PATCH deve usar:

```text
Idempotency-Key
```

Chave estável por:

```text
job + product
```

Exemplo conceitual:

```text
bulkcat:{jobId}:{productId}
```

---

# Progresso

Frontend deve exibir:

```text
Associando categorias

1.842 / 2.746

████████████████░░░░ 67%

Sucesso       1.829
Falha             5
Ignorados          8
Pendentes        904
```

Polling é suficiente.

---

# Ações mínimas

```text
Cancelar
Reexecutar falhas
```

Pausar/continuar pode ficar para uma segunda versão se complicar a infraestrutura.

---

# PARTE 4 — Ferramenta interna "Migração Use Origens"

Criar página interna.

Sugestão:

```text
/admin/internal/origens-migration
```

Não exibir para clientes SaaS normais.

Proteção mínima:

```text
feature flag
role admin/internal
environment flag
```

Não confiar apenas em esconder link na sidebar.

---

# Objetivo da migração

O nome do produto permite identificar:

- coleção;
- UF;
- eventualmente região.

Queremos transformar isso em categorias estruturadas.

---

# Dimensões

## Coleção

Inicialmente:

```text
Legado
Ponto de Origem
Coordenadas
Tipografia
Traço
Território
Feito Em
Gentilico
```

Deixar configurável quando simples.

## UF

Exemplos:

```text
MT
GO
MS
RS
SC
PR
```

## Região

Exemplo:

```text
Sul
Centro
Norte
```

O mapeamento UF → Região deve ser configurável.

---

# Modelo de regras

Preferir regras componíveis.

Exemplo:

```text
se nome contém "Legado"
→ classificar coleção Legado

se nome contém "MT"
→ classificar UF MT
→ classificar região Centro
```

Depois transformar classificação em categorias finais.

Exemplo:

```text
Produto:
Legado Cuiabá MT

Resultado:
LEGADO - MT
MT
CENTRO - MT
```

---

# Matchers

MVP:

```text
contains
not_contains
starts_with
ends_with
equals
```

Case insensitive.

Normalizar para comparação:

```text
trim
lowercase
espaços repetidos
```

Pode remover acentos apenas para matching, sem alterar o nome real.

---

# Estrutura conceitual de regra

```ts
type MigrationRule = {
  id: string
  name: string
  enabled: boolean
  conditions: {
    field: "product_name"
    operator: "contains" | "not_contains" | "starts_with" | "ends_with" | "equals"
    value: string
  }[]
  outputCategoryIds: number[]
  priority: number
}
```

Adapte se a abordagem por dimensões ficar mais limpa.

---

# Combinação de regras

Um produto pode bater em várias regras.

Usar:

```text
Set(categoryIds)
```

para remover duplicidades.

---

# Conflitos

Definir como conflito quando:

- produto detecta duas UFs;
- detecta categorias mutuamente exclusivas;
- categoria esperada não existe;
- regra referencia categoria removida;
- UF obrigatória não é detectada.

Produto com conflito:

```text
NÃO executar automaticamente
```

---

# Produto sem regra

Status:

```text
Sem classificação
```

Não alterar automaticamente.

---

# PARTE 5 — Simulação obrigatória

Botão:

```text
Simular migração
```

Não realizar PATCH.

Resumo:

```text
3.842 produtos analisados

3.510 prontos
219 sem regra
113 com conflito
```

Filtros:

```text
Todos
Prontos
Sem regra
Conflitos
```

Tabela:

```text
Produto
Nome
Coleção detectada
UF detectada
Categorias finais
Status
```

---

# Detalhe da simulação

Exemplo:

```text
Legado Cuiabá MT

Regras aplicadas:
✓ Coleção = Legado
✓ UF = MT
✓ Região = Centro

Categorias finais:
LEGADO - MT
MT
CENTRO - MT
```

---

# Override manual

Na simulação permitir:

```text
+ adicionar categoria
x remover categoria
Ignorar este produto
```

Salvar override na própria simulação.

---

# PARTE 6 — Execução da migração

Só permitir depois de uma simulação válida.

Confirmação:

```text
3.510 produtos serão atualizados.

Modo:
SUBSTITUIR CATEGORIAS

113 produtos com conflito não serão alterados.
219 produtos sem classificação não serão alterados.
```

CTA:

```text
Confirmar e executar
```

---

# Snapshot

Antes da execução salvar:

```text
productId
productName
matchedRules
targetCategoryIds
```

O job deve executar exatamente esse snapshot.

Não recalcular regras durante a execução.

---

# Novos produtos após simulação

Não incluir automaticamente.

Nova simulação deve gerar nova execução.

---

# PARTE 7 — Histórico e relatório

Registrar:

## Categorias em lote

```text
Data
Usuário
Quantidade
Sucesso
Falhas
```

## Associação em lote

```text
Data
Modo
Categorias
Produtos
Sucesso
Falhas
```

## Migração

```text
Data
Produtos analisados
Conflitos
Executados
Falhas
Status
```

---

# CSV

Permitir exportação:

```text
product_id
product_name
status
matched_rules
categories_after
error
collection_detected
uf_detected
region_detected
```

---

# Interface

Usar o design system dark atual.

Na página Categorias, adicionar:

```text
Nova categoria
Criar em lote
Associar produtos
```

A ferramenta interna pode usar stepper:

```text
1 Categorias
2 Regras
3 Produtos
4 Simulação
5 Execução
6 Resultado
```

---

# Backend/API interna

Seguir a arquitetura existente do projeto.

Não criar uma arquitetura paralela.

Endpoints internos sugeridos, adaptando ao padrão real:

```text
POST /admin/api/categories/bulk-preview
POST /admin/api/categories/bulk-create

POST /admin/api/category-assignments/preview
POST /admin/api/category-assignments

GET  /admin/api/category-jobs/{id}
POST /admin/api/category-jobs/{id}/retry-failed
POST /admin/api/category-jobs/{id}/cancel
```

Migração:

```text
GET    /admin/api/internal/origens-migration/rules
POST   /admin/api/internal/origens-migration/rules
PATCH  /admin/api/internal/origens-migration/rules/{id}
DELETE /admin/api/internal/origens-migration/rules/{id}

POST /admin/api/internal/origens-migration/simulate
POST /admin/api/internal/origens-migration/execute

GET /admin/api/internal/origens-migration/jobs/{id}
```

Não é obrigatório usar esses paths literalmente.

---

# Paginação e "selecionar todos"

Não buscar apenas os primeiros 100 produtos.

Quando o usuário escolher:

```text
Selecionar todos os resultados
```

o backend deve reproduzir o filtro e resolver todos os produtos paginados.

Preferir não mandar milhares de IDs do browser quando o backend já consegue resolver o filtro.

---

# Proteções obrigatórias

Validar:

```text
categoria existe
categoria pertence à loja
produto pertence à loja
categoryIds sem duplicidade
```

Em REPLACE:

```text
categoryIds.length === 0
```

deve ser bloqueado por padrão.

Não permitir limpeza total acidental.

---

# Observabilidade

Logs estruturados:

```text
bulk_category_job_started
bulk_category_product_updated
bulk_category_product_failed
bulk_category_job_completed

origens_migration_simulated
origens_migration_started
origens_migration_completed
```

Não logar tokens Ink.

Métricas úteis:

```text
total_products
success_count
failed_count
skipped_count
duration
retries
rate_limit_hits
```

---

# Testes

Testar motor de regras:

```text
1 regra
2 regras combinadas
duplicidade de categoria
case insensitive
espaço extra
sem regra
conflito de UF
categoria ausente
rule disabled
override manual
```

Testar associação:

```text
ADD:
before [1,2]
target [2,3]
after  [1,2,3]

REPLACE:
before [1,2]
target [3,4]
after  [3,4]
```

Testar idempotência e retry.

---

# NÃO fazer

Não implementar:

```text
PATCH de categoria em blocos de 100 como append
```

Não:

```text
milhares de requests simultâneos
```

Não:

```text
migração sem simulação
```

Não:

```text
produto em conflito atualizado automaticamente
```

Não:

```text
IDs de categoria hardcoded
```

Não:

```text
Migração Use Origens disponível para clientes normais
```

Não reescrever módulos existentes sem necessidade.

---

# Ordem de implementação

## Fase 1

```text
Criar categorias em lote
```

## Fase 2

```text
Associação genérica
ADD
REPLACE
preview
job
progresso
```

## Fase 3

```text
Migração Use Origens
regras
simulação
conflitos
overrides
```

## Fase 4

```text
execução
histórico
retry
CSV
```

---

# Critérios de aceitação

## Cenário A

Criar 40 categorias internas em um único fluxo.

## Cenário B

Filtrar 3.000 produtos e associar 3 categorias a todos, sem limite de 100 produtos.

## Cenário C

```text
Legado Cuiabá MT
→ LEGADO - MT
→ MT
→ CENTRO - MT
```

## Cenário D

Simular 5.000 produtos antes de alterar qualquer produto.

## Cenário E

Executar modo REPLACE com:

```text
progresso
retry
idempotência
relatório
```

sem congelar a aplicação.

---

# Entrega esperada

Ao finalizar, informar:

1. arquivos criados;
2. arquivos alterados;
3. models/tabelas criados;
4. rotas frontend criadas;
5. endpoints backend criados;
6. libs adicionadas;
7. estratégia de job;
8. concorrência;
9. política de retry;
10. proteção da ferramenta interna;
11. testes;
12. exemplo de simulação;
13. exemplo de relatório;
14. limitações restantes.

Confirmar explicitamente:

```text
Nenhuma associação >100 produtos foi implementada via chunked PATCH da categoria.

A associação em massa é feita por atualização individual de produto.

REPLACE substitui explicitamente collections.

ADD preserva explicitamente as categorias existentes.
```
