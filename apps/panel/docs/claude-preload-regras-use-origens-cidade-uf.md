# Claude Code — Pré-carga de regras da Migração Use Origens + fallback Cidade → UF

## Contexto

A ferramenta interna de migração já possui um formulário de regras com:

- Nome
- Dimensão
- Prioridade
- Habilitada
- Condições
- Categorias de saída

O objetivo agora é **evitar criar manualmente dezenas de regras**.

Quero que o sistema passe a ter uma opção de **pré-carregar automaticamente as regras padrão da migração Use Origens**, com base no padrão atual de nomenclatura dos produtos.

Também precisamos tratar um caso importante:

> alguns produtos não possuem a UF no final do nome.

Exemplos reais:

```text
Joinville | Coordenadas
Feito em Joinville
```

Nesses casos, a ferramenta precisa conseguir resolver a UF pela cidade.

---

# Objetivo

Implementar:

1. um botão para pré-carregar as regras padrão;
2. geração automática das regras coleção + UF;
3. associação automática das categorias de saída corretas;
4. fallback de cidade → UF quando a UF não estiver explícita no nome;
5. simulação segura antes de qualquer execução;
6. conflito quando não for possível identificar a UF com segurança.

---

# Estrutura de categorias esperada

Para cada produto classificado, queremos associar simultaneamente:

```text
SUL
SUL - {UF}
SUL - {COLEÇÃO}
SUL - {COLEÇÃO} - {UF}
```

Exemplo:

```text
Produto:
Joinville | Legado SC
```

Categorias finais:

```text
SUL
SUL - SC
SUL - LEGADO
SUL - LEGADO - SC
```

Outro exemplo:

```text
Capivari de Baixo | Traço SC
```

Categorias finais:

```text
SUL
SUL - SC
SUL - TRAÇO
SUL - TRAÇO - SC
```

---

# Coleções padrão

Pré-carregar regras para estas 8 coleções:

```text
Origem
Legado
Coordenadas
Tipografia
Traço
Território
Feito Em
Gentilico
```

Usar os nomes reais das categorias criadas no painel.

Se os nomes finais cadastrados estiverem abreviados por limite da API, usar os IDs/names reais existentes no banco/API.

Não hardcodar IDs.

---

# UFs da região Sul

```text
RS
SC
PR
```

---

# Quantidade de regras padrão

Gerar automaticamente:

```text
8 coleções × 3 UFs = 24 regras
```

Cada regra deve representar:

```text
coleção + UF
```

Exemplo:

```text
Legado SC
Legado RS
Legado PR

Traço SC
Traço RS
Traço PR
```

---

# Padrão das regras

## Exemplo: Legado SC

```text
Nome:
Legado SC

Dimensão:
colecao_uf

Prioridade:
10

Habilitada:
sim
```

Condições:

```text
contém:
"Legado"

termina com:
" SC"
```

Categorias de saída:

```text
SUL
SUL - SC
SUL - LEGADO
SUL - LEGADO - SC
```

## Exemplo: Território PR

Condições:

```text
contém:
"Território"

termina com:
" PR"
```

Saídas:

```text
SUL
SUL - PR
SUL - TERRITÓRIO
SUL - TERRITÓRIO - PR
```

---

# Operadores necessários

A ferramenta deve suportar no mínimo:

```text
contém
não contém
começa com
termina com
igual
```

Para identificar UF, preferir:

```text
termina com " SC"
termina com " RS"
termina com " PR"
```

Não usar simplesmente:

```text
contém "SC"
```

porque pode gerar falso positivo.

---

# Padrões atuais dos títulos

Os produtos seguem, em geral:

```text
{CIDADE} | Origem {UF}
{CIDADE} | Legado {UF}
{CIDADE} | Coordenadas {UF}
{CIDADE} | Tipografia {UF}
{CIDADE} | Traço {UF}
{CIDADE} | Território {UF}
Feito em {CIDADE}
{GENTÍLICO} | Gentílico {UF}
```

Porém existem produtos antigos/variantes como:

```text
{CIDADE} | Coordenadas
Feito em {CIDADE}
```

sem UF explícita.

---

# Botão de pré-carga

Na página de regras da Migração Use Origens, adicionar:

```text
Pré-carregar regras padrão
```

ou:

```text
Carregar preset Use Origens
```

Ao clicar:

1. analisar categorias existentes;
2. localizar as categorias necessárias;
3. montar as 24 regras;
4. mostrar preview;
5. permitir confirmar criação.

---

# Preview da pré-carga

Antes de salvar:

```text
24 regras serão criadas

22 prontas
2 com categoria ausente
0 duplicadas
```

Tabela:

```text
Regra
Coleção
UF
Categorias de saída
Status
```

---

# Não duplicar regras

Se já existir uma regra equivalente, não criar novamente.

Comparar preferencialmente por:

```text
dimensão
condições normalizadas
categorias de saída
```

e não apenas por nome.

---

# Se categoria necessária não existir

Exemplo:

```text
SUL - LEGADO - SC
```

não encontrada.

A regra correspondente NÃO deve ser criada automaticamente como válida.

Mostrar:

```text
Categoria ausente
```

e permitir ao usuário:

- corrigir categoria;
- criar categoria;
- ignorar regra.

Não inventar ID.

---

# Fallback Cidade → UF

## Problema

Alguns produtos não possuem UF no nome.

Exemplos:

```text
Joinville | Coordenadas
Feito em Joinville
```

Nesses casos:

```text
termina com " SC"
```

não funciona.

---

# Estratégia

Quando nenhuma UF explícita for encontrada no nome:

```text
1. extrair cidade
2. consultar mapa cidade → UF
3. resolver UF
4. aplicar as categorias correspondentes
```

Exemplo:

```text
Feito em Joinville
```

Extrair:

```text
cidade = Joinville
```

Resolver:

```text
Joinville → SC
```

Resultado:

```text
coleção = FEITO EM
UF = SC
região = SUL
```

Categorias:

```text
SUL
SUL - SC
SUL - FEITO EM
SUL - FEITO EM - SC
```

---

# Extração da cidade

## Padrão 1

```text
Feito em {CIDADE}
```

Exemplo:

```text
Feito em Capivari de Baixo
```

Extrair:

```text
Capivari de Baixo
```

## Padrão 2

```text
{CIDADE} | Coordenadas
```

Exemplo:

```text
Joinville | Coordenadas
```

Extrair texto antes de:

```text
|
```

Resultado:

```text
Joinville
```

---

# Mapa cidade → UF

Criar uma estrutura configurável.

Não espalhar isso pelo código.

Sugestão:

```ts
type CityUfMap = {
  cityNormalized: string
  cityDisplay: string
  uf: "RS" | "SC" | "PR"
}
```

Pode ser persistido no banco ou em configuração interna da ferramenta.

---

# Normalização da cidade

Para matching:

```text
trim
lowercase
remover espaços duplicados
remover acentos
```

Exemplo:

```text
"Capivari de Baixo"
"capivari de baixo"
"CAPIVARI DE BAIXO"
```

devem resolver o mesmo registro.

Nunca alterar o nome real do produto.

---

# Como popular o mapa cidade → UF

Criar uma seção interna:

```text
Mapa Cidade → UF
```

Com:

```text
Cidade
UF
Status
```

Permitir:

```text
Adicionar
Editar
Remover
Importar em lote
```

---

# Pré-carga do mapa

Como estamos trabalhando inicialmente apenas com o Sul, permitir pré-carregar cidades já identificadas a partir dos próprios produtos.

Fluxo opcional:

```text
Analisar nomes dos produtos
↓
extrair cidades
↓
mostrar cidades únicas
↓
usuário informa/confirma UF
↓
salvar mapa
```

Não tentar adivinhar UF de cidade desconhecida usando lógica frágil.

---

# Fonte da UF

Na simulação, mostrar de onde veio a classificação.

Exemplo:

```text
Joinville | Legado SC

UF:
SC

Fonte:
título
```

Outro:

```text
Joinville | Coordenadas

UF:
SC

Fonte:
mapa cidade → UF
```

---

# Confiança

Adicionar status conceitual:

```text
Alta
Revisar
```

## Alta

Quando:

```text
coleção encontrada
UF explícita no título
```

ou:

```text
coleção encontrada
cidade encontrada no mapa
UF resolvida unicamente
```

## Revisar

Quando:

```text
cidade não existe no mapa
duas UFs possíveis
coleção não identificada
mais de uma coleção detectada
```

---

# Conflitos

Produto NÃO deve ser executado automaticamente quando:

```text
UF explícita conflita com mapa da cidade
cidade sem UF mapeada
duas UFs encontradas
duas coleções incompatíveis encontradas
categoria de saída ausente
```

---

# Regra de precedência da UF

Usar esta ordem:

```text
1. UF explícita no título
2. mapa cidade → UF
3. conflito / revisão manual
```

Se a UF explícita existir, ela é a principal fonte.

---

# Importante: regras padrão + fallback

As 24 regras padrão continuam válidas para produtos com UF explícita.

Para produtos sem UF, não criar centenas de regras por cidade.

Em vez disso:

```text
detecção da coleção
+
fallback cidade → UF
+
geração das mesmas categorias finais
```

Ou seja:

```text
Joinville | Coordenadas
```

não precisa de uma regra chamada:

```text
Coordenadas Joinville
```

O sistema resolve:

```text
Coordenadas
+
Joinville → SC
=
Coordenadas SC
```

e aplica a mesma saída lógica de uma regra `Coordenadas SC`.

---

# Arquitetura recomendada

Separar:

```text
Rule Engine
```

de:

```text
Location Resolver
```

Conceito:

```text
productName
   ↓
Collection Detector
   ↓
UF Detector
   ├─ explicit suffix
   └─ city resolver
   ↓
Category Resolver
   ↓
targetCategoryIds
```

---

# Exemplos completos

## Exemplo 1

```text
Joinville | Legado SC
```

Resultado:

```text
Coleção: Legado
UF: SC
Fonte UF: Título

Categorias:
SUL
SUL - SC
SUL - LEGADO
SUL - LEGADO - SC

Status: Pronto
```

## Exemplo 2

```text
Joinville | Coordenadas
```

Resultado:

```text
Coleção: Coordenadas
Cidade: Joinville
UF: SC
Fonte UF: Mapa Cidade → UF

Categorias:
SUL
SUL - SC
SUL - COORDENADAS
SUL - COORDENADAS - SC

Status: Pronto
```

## Exemplo 3

```text
Feito em Capivari de Baixo
```

Resultado:

```text
Coleção: Feito Em
Cidade: Capivari de Baixo
UF: SC
Fonte UF: Mapa Cidade → UF

Categorias:
SUL
SUL - SC
SUL - FEITO EM
SUL - FEITO EM - SC

Status: Pronto
```

---

# Interface da pré-carga

Na página da Migração Use Origens:

```text
Regras
```

Adicionar:

```text
[ Pré-carregar regras padrão ]
```

Ao clicar, abrir modal/drawer:

```text
Preset:
Use Origens — Sul

Coleções:
8

UFs:
RS, SC, PR

Regras:
24

[ Gerar preview ]
```

---

# Ações do preview

```text
Criar 24 regras
Criar apenas válidas
Cancelar
```

Se houver regras já existentes:

```text
18 serão criadas
6 já existem
```

---

# Prioridade padrão

Usar:

```text
10
```

para regras padrão, salvo convenção melhor já existente.

---

# Dimensão padrão

Usar:

```text
colecao_uf
```

para as 24 regras, salvo arquitetura atual indicar algo melhor.

---

# Pré-carga deve ser idempotente

Rodar o preset duas vezes não pode duplicar regras.

Comportamento esperado:

```text
Primeira execução:
24 criadas

Segunda execução:
0 criadas
24 já existentes
```

---

# Simulação depois da pré-carga

Após criar as regras:

```text
Simular produtos agora
```

Reutilizar o fluxo de simulação existente.

Adicionar colunas:

```text
Produto
Coleção
Cidade
UF
Fonte UF
Categorias finais
Status
```

---

# Não fazer

Não:

```text
criar regra manual para cada cidade
```

Não:

```text
usar contains "SC" para UF
```

Não:

```text
inferir UF sem fonte segura
```

Não:

```text
executar produto sem UF resolvida
```

Não:

```text
duplicar regras ao rodar preset novamente
```

Não:

```text
hardcode IDs de categoria
```

---

# Testes mínimos

## Preset

```text
24 regras geradas
segunda execução não duplica
categoria ausente gera warning
```

## UF explícita

```text
Joinville | Legado SC
→ SC
```

## UF via cidade

```text
Joinville | Coordenadas
→ Joinville
→ SC
```

## Feito em

```text
Feito em Capivari de Baixo
→ Capivari de Baixo
→ SC
```

## Cidade desconhecida

```text
Feito em Cidade Teste
→ Revisar
```

## Conflito

```text
produto termina SC
mapa da cidade aponta PR
→ Revisar
```

---

# Entrega esperada

Ao finalizar, informar:

1. arquivos alterados;
2. componentes criados;
3. endpoint(s) criados;
4. onde o preset fica definido;
5. como as 24 regras são geradas;
6. como evita duplicação;
7. como cidade → UF é persistido;
8. como cidade é extraída;
9. ordem de precedência da UF;
10. conflitos possíveis;
11. testes implementados;
12. exemplo real de preview.

Confirmar explicitamente:

```text
Produtos sem UF no título podem usar o mapa Cidade → UF.

Nenhum produto com UF não resolvida é executado automaticamente.

A pré-carga das regras é idempotente.

Não são criadas regras individuais por cidade.
```
