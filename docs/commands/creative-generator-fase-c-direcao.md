# Creative Generator V2 — Gate da Fase B e direção da Fase C

## Gate de fechamento da Fase B

A arquitetura da Fase B está aprovada em princípio.

Não iniciar a Fase C até concluir a suíte completa do painel e atualizar o relatório final.

Para fechar a Fase B, preciso apenas:

1. suíte completa do painel 100% verde;
2. relatório atualizado com o resultado final;
3. commit dos docs;
4. confirmação final de:
   - sem push;
   - sem deploy;
   - sem chamada OpenAI;
   - Fase C não iniciada.

Se houver qualquer falha na suíte completa, corrigir antes de continuar.

---

# 1. O que considero aprovado na Fase B

A direção do `CreativePlan V2` está correta.

Quero preservar especialmente:

- plano autossuficiente e recompilável;
- `scene.picks` resolvidos no planner;
- `gaze_mode` resolvido antes do compiler;
- `minor_safety` global separado da política de vestuário da marca;
- `product.semantic_context`;
- `provenance`;
- `resolved_inputs`;
- seções explícitas do compiler;
- compatibilidade integral com V1;
- rollout por flag;
- `GenerationDraft` e `FeedbackSnapshot` derivados do plano persistido.

O princípio segue sendo:

> backend rico, planner inteligente, UI simples.

Não transformar o schema do plano em formulário.

---

# 2. Observação importante sobre UX

O relatório mostra que hoje só:

- objetivo;
- produto;

são inputs obrigatórios.

Quero manter essa meta.

Inclusive, no futuro, até o objetivo pode ter um default/recomendação por contexto, mas não precisamos mexer nisso agora.

Não quero que Subjects/Relations da próxima fase façam o número de campos obrigatórios crescer.

A maioria das pessoas deve continuar podendo fazer:

1. escolher produto;
2. aceitar recomendação;
3. gerar.

Ou:

1. escolher produto;
2. escolher tipo de criativo;
3. gerar.

`Personalizar cena` é opcional.

---


## 2.1 Proveniência composta precisa continuar precisa

Antes de expandir Subjects/Relations, revisar um detalhe do modelo de provenance.

No exemplo atual, algumas seções agregadas podem aparecer com uma única origem mesmo quando foram compostas por várias fontes.

Exemplo:

- subject principal pode vir do usuário/persona;
- subject de apoio pode vir de `product.semantic_context`;
- gaze pode vir do angle;
- interação pode vir do planner.

Não quero que uma seção agregada seja marcada simplesmente como `user` se parte relevante dela veio de `product`, `brand`, `angle` ou `planner_default`.

Pode resolver de uma destas formas:

```ts
source: "mixed"
sources: ["user", "product"]
```

ou mantendo provenance apenas nos campos-folha e fazendo a seção agregada apontar para eles.

O importante é:

- analytics futuro não atribuir uma decisão automática ao usuário;
- feedback `Gostei/Não gostei` conseguir correlacionar corretamente o que foi escolhido pelo usuário versus inferido;
- `Copiar Dados` saber o que carregar como escolha explícita e o que pode ser recalculado;
- futuras recomendações não aprenderem de provenance incorreta.

Não precisa quebrar o schema se houver solução aditiva.


# 3. Fase C — escopo

Depois que a Fase B estiver totalmente verde, autorizo a **Fase C**, mas quero dividi-la em três blocos independentes.

## C1 — Subjects, Relations e Interactions

Objetivo:

substituir de vez a lógica implícita de “persona única + segunda pessoa inventada” por composição estruturada.

Implementar os contratos e planner para:

- `subjects[]`;
- pessoa principal;
- pessoas de apoio;
- relação com a principal;
- quem veste qual produto;
- quem não veste produto;
- prominence;
- age band;
- interaction;
- gaze derivado da interação quando aplicável;
- pose risk;
- warnings semânticos.

### Limite

Máximo de 4 pessoas.

- 1–2: normal;
- 3: warning;
- 4: high risk;
- 4 nunca sugeridas automaticamente como configuração segura.

### Casos obrigatórios

Cobrir por fixtures/testes:

#### Caso A
Produto infantil “Brincar com Meu Pai”

- menina usando produto;
- pai como apoio;
- interação brincando;
- relação father_child;
- gaze interaction.

#### Caso B
Produto infantil

- menino usando produto;
- mãe presente;
- mãe não veste o produto;
- lendo juntos.

#### Caso C
Duas irmãs

- duas subjects;
- produtos diferentes;
- relation sibling;
- interação natural.

#### Caso D
Casal

- dois adultos;
- produtos diferentes;
- relation partner.

#### Caso E
Família

- mãe;
- pai;
- duas crianças;
- 4 subjects;
- warning/high risk;
- poses simples.

---

# 4. Relações

Não usar apenas texto livre.

Criar tipo estruturado equivalente a:

```ts
type RelationType =
  | "mother"
  | "father"
  | "daughter"
  | "son"
  | "sibling"
  | "partner"
  | "friend"
  | "grandparent"
  | "custom"
```

Pode ajustar os nomes se houver modelo melhor.

A relação deve permitir:

- planner;
- semantic matching;
- interaction filtering;
- warnings;
- compiler.

Ela não pode depender de inferência posterior do prompt.

---

# 5. Interações

Criar catálogo estruturado de interações.

Exemplos iniciais:

- candid;
- talking;
- looking_at_each_other;
- walking;
- hugging;
- reading_together;
- playing;
- cooking;
- doing_activity;
- gifting;
- group_photo.

Cada interação deve declarar metadados como:

- mínimo/máximo de pessoas;
- age compatibility;
- contact level;
- hand complexity;
- object use;
- gaze default;
- pose risk contribution.

Não quero lógica espalhada em `if` pelo planner.

Preferir configuração/catalog data.

---

# 6. Produto semântico + Subjects

A semântica do produto agora deve influenciar Subjects em qualquer cena aplicável, não só `PRESENTE_AFETO`.

Exemplo:

`father_child`

pode recomendar:

- criança como wearer;
- pai como supporting subject.

Mas:

- sugestão automática deve respeitar;
- escolha manual contrária continua permitida;
- mostrar warning;
- nunca bloquear apenas por semântica.

A semântica ajuda o planner, não manda no usuário.

---

# 7. Safety de menores

Na Fase C, remover a dependência principal da heurística textual.

Cada Subject deve carregar idade/faixa explícita quando conhecida.

Exemplo:

```ts
{
  "age_band": "child_6_9",
  "is_minor": true
}
```

A heurística atual continua como fallback para compatibilidade, mas a fonte preferida passa a ser o Subject/Persona.

A política global e a política da marca continuam funcionando como na Fase B.

---

# 8. Feedback — Gostei / Não gostei

Quero implementar agora a base proposta na Fase B.

Cada criativo deve poder receber:

- `liked`;
- `disliked`;
- limpar feedback.

Implementar tabela `creative_feedback`.

Requisitos:

- `organization_id`;
- `store_id nullable`;
- `creative_id`;
- `job_id`;
- `user_id`;
- `verdict`;
- `snapshot`;
- versões relevantes;
- campos indexáveis úteis;
- timestamps;
- UNIQUE por organization + creative + user;
- trocar feedback = upsert.

Seguir tenancy padrão:

- trigger;
- RLS;
- FORCE RLS;
- manifest/invariantes.

## Importante

O `snapshot` deve nascer do plano persistido.

Não reconstruir informação a partir da UI.

---

# 9. FeedbackSnapshot

Expor no core uma função/endpoint puro equivalente a:

`POST /v1/feedback-snapshot`

Input:

- CreativePlan persistido;
- metadata/result quando necessário.

Output:

- `FeedbackSnapshot`.

O Node adiciona:

- organization;
- store;
- job;
- user;
- verdict;
- timestamps.

Não duplicar regra de snapshot em JS.

---

# 10. Uso do feedback

Nesta fase NÃO implementar machine learning.

Também não quero alterar automaticamente geração com base em likes/dislikes ainda.

Só criar uma base confiável.

Preparar consultas futuras para:

- taxa de aprovação por angle;
- contexto;
- interaction;
- persona/subject composition;
- produto;
- objective;
- mockup recipe futuramente.

Nenhum desses números deve influenciar o planner ainda.

---

# 11. Copiar Dados

Implementar a base proposta.

A ação deve nascer do plano persistido.

Expor endpoint puro no core equivalente a:

`POST /v1/draft`

ou nome melhor.

Input:

- CreativePlan persistido.

Output:

- `GenerationDraft`.

No painel:

`GET /api/admin/criativos/items/:creativeId/draft`

deve:

1. carregar o plano;
2. chamar o core;
3. validar se produtos/perfis ainda existem;
4. retornar:
   - draft;
   - carried;
   - unavailable;
   - warnings.

---

# 12. Gerar de novo × Gerar variação

Quero distinguir explicitamente:

## Gerar de novo

Preserva:

- seed;
- scene picks;
- subjects;
- interaction;
- angle;
- gaze;
- contexto;
- produto;
- formato.

Objetivo: tentar reproduzir a mesma configuração.

## Gerar variação

Preserva a intenção/configuração principal, mas descarta:

- seed;
- picks que devam ser rerolados.

Mantém:

- produto;
- subjects;
- relation;
- interaction;
- angle;
- contexto;
- formato;
- demais escolhas humanas.

Objetivo: produzir outra interpretação da mesma ideia.

Essas duas ações devem ficar preparadas no `GenerationDraft`.

---

# 13. UI nesta fase

Não quero ainda o redesign completo do Gerador V2.

Mas pode implementar o mínimo necessário para validar:

### Nos cards/resultados/histórico

Adicionar:

- `Gostei`;
- `Não gostei`;
- `Copiar dados`.

Se a UI completa ainda estiver atrás de flag, pode manter isso igualmente atrás de flag ou em uma superfície controlada.

O importante é:

- não criar formulário gigante;
- não antecipar o builder completo;
- provar o fluxo de feedback e reuse.

### Copiar Dados

Ao clicar:

- abrir o Gerador atual/V2 de acordo com a flag;
- pré-popular o que ele suporta;
- o que ainda não existir na UI deve ficar preservado no draft para a futura UI V2.

Não perder dados silenciosamente.

---

# 14. Progressive disclosure continua obrigatório

Mesmo com Subjects:

não mostrar quatro cards vazios de pessoa esperando preenchimento.

Fluxo esperado:

### Automático

Produto selecionado.

Sistema mostra:

> Recomendado  
> Menina + pai · brincando juntos · parque · conexão/vínculo

Botões:

- `Gerar assim`
- `Personalizar cena`

### Personalizar cena

Só então mostrar:

- Pessoas
- Interação
- Ambiente
- Enquadramento
- Olhar

Não mostrar:

- age_band;
- pose_risk;
- relation ids;
- safety policy;
- semantic context;
- compiler metadata.

Esses são dados internos.

---

# 15. Não fazer ainda

Nesta fase não implementar:

- Mockup Generator;
- Commerce Connector;
- Product Enrichment via GPT;
- aprendizado automático por likes;
- ranking automático por feedback;
- nova Biblioteca Criativa completa;
- UI final do Gerador;
- QA retry automático;
- deploy;
- push.

---

# 16. Persistência / migrations

Quero proposta antes de criar migrations se surgir dúvida de tenancy.

Esperado:

### próxima migration disponível

- tabela de feedback;
- qualquer coluna necessária para Subjects somente se realmente precisar de coluna indexável.

Subjects/relations/interactions devem continuar prioritariamente dentro do `plan JSONB`.

Não criar tabela para cada conceito sem necessidade.

---

# 17. Testes obrigatórios

Antes de fechar:

## Core

- Subjects validation;
- relations;
- interaction compatibility;
- age/minor propagation;
- semantics → subject recommendation;
- manual semantic mismatch warning;
- gaze resolution;
- pose risk;
- generation draft;
- feedback snapshot;
- recompilation;
- V1 golden intacto.

## Painel

- feedback upsert;
- feedback removal;
- tenancy isolation;
- store nullable/shared behavior;
- history with current-user verdict;
- draft endpoint;
- unavailable entities;
- migration invariants;
- full suite.

---

# 18. Entrega da Fase C

Entregar:

1. commits;
2. migrations;
3. contracts;
4. fixtures dos 5 cenários;
5. exemplos de plans;
6. como relation/interactions funcionam;
7. como semantic_context influencia subjects;
8. como safety de menores passou a usar dados explícitos;
9. schema da tabela de feedback;
10. exemplo de FeedbackSnapshot;
11. endpoints de feedback;
12. exemplo de GenerationDraft;
13. diferença `Gerar de novo` × `Gerar variação`;
14. screenshots ou descrição do mínimo de UI implementado;
15. golden V1;
16. suíte completa;
17. riscos;
18. backward compatibility;
19. confirmação de sem OpenAI desnecessária;
20. sem push/deploy.

Não iniciar a próxima fase automaticamente.

Quero revisar Subjects + Feedback + Copiar Dados antes de avançar para UI V2 completa, Mockups ou Commerce Connector.
