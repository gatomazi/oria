# Gerador de Criativos — Fase F.1 (Product Enrichment: proposta, revisão humana, sem chamada real)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. Implementação **local**, atrás de
`CREATIVE_ENRICHMENT_ORGS` (mesmo mecanismo de rollout operacional por Organization das fases anteriores —
nunca comercial). **Zero chamada paga, zero chave OpenAI real, zero push/merge/deploy.** Mockup Generator,
Commerce Connector, aprendizado por feedback, QA/retry automático e F.2 (provider real) não foram
iniciados.

**Pré-condição confirmada**: gate da Fase E fechado antes de começar esta rodada — 1332/1333 na suíte
completa, a única falha (`R19 · Go novo sem a flag`, colisão de porta num subprocesso) demonstrada como
ambiental e não relacionada às mudanças da própria Fase E (reproduzida limpa isolada, 9/9). Ver
`docs/features/creative-generator-fase-e.md` §4.

## 1. O que já existia (§1 do comando: inspecionar antes de implementar)

Ler o código antes de desenhar qualquer coisa nova mudou o escopo real do trabalho — boa parte da F.1 já
estava preparada, só nunca conectada:

- **`semantic_context` já tinha lar**: vive em `creative_products.metadata.semantic_context` (JSONB),
  extraído pelo painel em `produtoDoRegistro()` (`lib/creative-core/requests.js`) para o campo tipado que o
  core lê. O contrato `ProductSemanticContext` (`contracts.py`) já tinha `source: enum("manual",
  "enrichment")` e `confidence` — literalmente esperando esta fase, com o comentário "the GPT enrichment
  that proposes it is a later phase and never saves without approval" já no código desde a Fase B.
- **O consumo pelo planner já está pronto e correto**: `composition.py`/`planner_v2.py` já leem
  `semantic.get("source")` e marcam a proveniência do plano como `"product_enrichment"` quando
  `source == "enrichment"` (contracts.py já tinha esse valor em `VALUE_ORIGINS`). **Isto significa que a F.1
  não precisou tocar em nenhuma linha do planner, engines ou compiler** — aprovar uma proposta e a PRÓXIMA
  geração já usa a proveniência certa, automaticamente, porque esse fio já estava ligado.
- **`model_router.py` já tinha `STRUCTURED_OUTPUT`** como task, nunca usada em lugar nenhum — outro sinal de
  que esta fase era esperada.
- **Não havia** nenhum mecanismo de proposta/aprovação genérico reaproveitável como está (o rascunho/
  aprovado de Context Profile é da entidade errada — é sobre o profile em si, não sobre uma SUGESTÃO
  aplicada a outra entidade já existente); por isso a F.1 criou uma tabela nova (§2), como o comando previu
  ("só crie migration quando houver necessidade concreta").
- **Não havia** rota de UPDATE em produtos (só create/archive) — a aprovação precisou de um caminho de
  escrita novo, propositalmente estreito (só `metadata.semantic_context`, nunca os outros campos).

## 2. Contrato da proposta

`EnrichmentProposal` (novo, `contracts.py`, exportado e versionado como os demais — `python -m
creative_core.contracts` já rodou, `schemas/EnrichmentProposal.schema.json` e `contracts.d.ts` atualizados):

```
{ id, product_id, schema_version, proposed: ProductSemanticContext, recommended_angle_families,
  recommended_interactions, field_notes, provider: "fake"|"openai", product_snapshot_hash, created_at }
```

`proposed` **reusa `ProductSemanticContext` tal como já existia** — nenhum campo novo em `CreativeProduct`,
exatamente como o comando pediu ("não é necessário introduzir todos como novos campos"). `field_notes` é
livre (justificativa curta + origem por campo, só para a tela mostrar) — nunca lido de volta em nenhuma
decisão, só validação estrutural real (`proposed`) decide o que é aceitável.

## 3. Provider: só "fake" nesta fase

`creative_core/enrichment.py` — um provider **determinístico, sem rede, sem chave, sem custo**: heurística
por palavra-chave sobre o texto do PRÓPRIO produto (nome/tipo/descrição), vocabulário fechado (~25 palavras
em português, dobradas como `composition.fold` já faz). Nenhuma interpretação de instrução: o texto do
produto é comparado contra a lista fechada, nunca executado como comando — testado explicitamente com uma
descrição no estilo "ignore all previous instructions..." (nada é inferido dela).

Sem sinal suficiente → proposta conservadora (`confidence < 0.5`, arrays vazios, **nenhuma família
inventada**). O core recusa qualquer `provider` que não seja `"fake"` (`INVALID_INPUT`) — a interface já
existe (`propose(product, provider=...)`) para quando F.2 trouxer um provider real, mas nada além de "fake"
funciona hoje, em nenhuma camada (core recusa; a rota do painel também só aceita "fake").

Toda proposta passa por `contracts.ensure_valid` antes de sair do core — um bug no provider (fake ou,
futuramente, real) não consegue devolver um campo fora do enum, string longa demais ou tipo errado.

## 4. Aprovação humana obrigatória — merge explícito e auditável

Nova tabela `creative_enrichment_proposals` (migration 0036), Organization-scoped, RLS forçada (mesma
policy canônica de todas as outras), **FK composta `(product_id, organization_id)` → `creative_products`**
(protege no banco, não só na aplicação, contra um `product_id` de outra Organization — mesmo padrão da FK
de `creative_angles` para `stores`), e **um índice único parcial garantindo só uma proposta pendente por
produto** (pedir de novo com uma já pendente devolve a mesma, nunca empilha).

A decisão (`POST /products/:id/enrichment/:proposalId/decide`, `decideEnrichmentProposal` em `pgStore.js`)
roda numa transação com `FOR UPDATE` no produto e na proposta:

- `rejected`: só marca a proposta; **zero mutação no produto**.
- `approved`/`adjusted`: exige `acceptedFields` (lista fechada dos 6 campos de `ProductSemanticContext`);
  só esses campos vêm da proposta, **o resto do `semantic_context` atual é preservado intacto** (um campo
  manual não listado sobrevive ao merge — testado explicitamente, com e sem Postgres real).
- **Checagem de frescor**: a proposta guarda o `product_updated_at` de quando foi feita; se o produto mudou
  desde então (qualquer edição concorrente), a aprovação é recusada com 409 — nunca aprovação silenciosa.
  Isto é o token de concorrência real (mesma linguagem/banco); `product_snapshot_hash` (calculado pelo core,
  em Python) fica só como auditoria — não tentei fazer a MESMA serialização JSON bater byte a byte entre
  Python e Node só para uma checagem que o banco já resolve de forma mais simples e confiável.
- Nada de resposta bruta do provider é guardado — só a proposta já validada (`proposed`/`field_notes`) e,
  após a decisão, o antes/depois do `semantic_context` (`before_semantic_context`/`applied_semantic_context`)
  para auditoria e reprodução, exatamente o "necessário", nada a mais.

## 5. UX: revisão em poucos segundos

Reaproveita o padrão visual da Fase E (`criativos-v2__sugestao*`, `Card`, `Modal`, `Checkbox`). Botão
**Enriquecer** por produto (aba Produtos, só quando `status.enrichment` está ligado) abre um modal:

> **Sugestão para "Brincar com Meu Pai"**
> família · pai brincando
> Sugestão automática (provider "fake") — nada foi aplicado ao produto ainda.
>
> [Aprovar sugestão] [Ajustar] [Descartar]

**Ajustar** mostra um checkbox por grupo (Quem veste / Tema da relação / Quem mais aparece / O que fazem /
Texto visível), cada um com o valor proposto ao lado, em português — nunca os nomes internos do contrato. O
rótulo do provider ("fake") fica sempre visível: a tela nunca finge que uma análise real aconteceu.

Escopo desta rodada, deliberadamente contido (a UI existe, mas é modesta — o comando permitia entregar só
contrato/API se a tela ficasse grande; ficou pequena o bastante para entrar): um modal por produto na aba
Produtos, não um redesign de tela.

## 6. Integração com o motor existente

Nada mudou em `engines.py`/`planner_v2.py`/`composition.py`/`compiler.py` — o fio já existia (§1). Provado
por: (a) `produtoDoRegistro()` já lê `metadata.semantic_context` para QUALQUER produto, aprovado ou manual;
(b) `composition.py`/`planner_v2.py` já usam `source` para a proveniência correta; (c) nenhum teste do
core quebrou (334/334, goldens incluídos) só de existir `enrichment.py` — ele não é importado por nenhum
caminho de planejamento/compilação, só pela rota nova do serviço.

`Copiar Dados`/`Gerar de novo` continuam lendo o **plano persistido**, nunca o produto ao vivo — uma
proposta aprovada DEPOIS de um criativo já gerado não muda esse criativo nem sua recompilação; só a
PRÓXIMA geração nova vê o `semantic_context` atualizado.

## 7. Testes

| Suite | Resultado |
|---|---|
| Core Python completo (inclui 546 golden V1) | 334/334 (322 + 12 novos de `test_enrichment.py`) |
| Painel — `creative-enrichment.test.js` (rota, flag, tenancy, merge, concorrência, injeção) | 12/12 |
| Painel — `creative-enrichment-pg.test.js` (FK composta, RLS, índice único, Postgres real) | 1/1 |
| Painel completo (`test/*.test.js` + `test/invariants/*.test.js`) | **1347/1347, 0 falhas** (≈44min, uma rodada) |

Cobertura dos 12 casos pedidos (§7): #1 "Brincar com Meu Pai" → pai+criança+playing com justificativa
(`test_enrichment.py` + `creative-enrichment.test.js`); #2 sem semântica → conservador; #3 descrição
maliciosa → schema preservado; #4 pendente/rejeitada → zero mutação; #5 ajustada/aprovada → merge exato;
#6 campo manual preservado; #7 edição concorrente → 409, sem lost update; #8 isolamento Organization (RLS +
FK composta, real e via memoryStore); #9 nova geração só com o aprovado, recompilação histórica intacta
(provado por inspeção — nenhum caminho de recompilação lê o produto); #10 V1/compiler/546 goldens
byte-idênticos (nenhuma seção/versão tocada); #11 nenhum provider real possível (core recusa qualquer
`provider != "fake"`; a rota do painel também); #12 falha de validação → `GenerationError`/400, nada parcial.

## 8. Tenancy e controle de acesso

- `creative_enrichment_proposals`: RLS habilitada e FORÇADA, policy `tenancy_isolamento` canônica, registrada
  no manifesto (`lib/platform/tenancy-manifest.js`) e no doc gerado (`docs/productization/tenant-owned-tables.md`).
- FK composta `(product_id, organization_id)` → `creative_products (id, organization_id)`: um `product_id`
  de outra Organization é recusado pelo BANCO, não só pela aplicação (testado com Postgres real).
- A decisão sempre lê o produto e a proposta com `FOR UPDATE` dentro da mesma transação — duas decisões
  concorrentes na mesma proposta nunca aplicam duas vezes (a segunda recebe 409).
- Autor (`created_by`) e revisor (`reviewed_by`) sempre gravados na proposta quando decidida — um CHECK no
  banco (`ck_creative_enrichment_proposals_reviewed`) impede uma linha `approved`/`adjusted`/`rejected` sem
  os dois preenchidos.
- **A matriz de isolamento existente (`tenancy-isolation.test.js`) já testou a tabela nova sozinha** — é o
  mecanismo genérico que gera uma linha válida por tabela RLS a partir do schema
  (`test/helpers/linhas.js`), sem fixture escrita à mão. Duas colunas precisaram de um caso especial (mesmo
  padrão que `creative_angles`/`creative_feedback` já tinham): `provider` (enum fechado — o gerador genérico
  só sabe preencher pelo TIPO da coluna, não por CHECK) e `product_id` (FK composta — precisa apontar para
  um produto real da mesma Organization, não um UUID qualquer). Achado rodando a suíte completa, corrigido
  em `tenancy-isolation.test.js`, não em produção. Junto com isso, 4 arquivos tinham contagem/lista de
  migrations fixada em código (`creative-core-pg.test.js`, `migrations.test.js`,
  `inv-td003-postgres-obrigatorio.test.js`, `r19-runbook-dry-run.test.js`) e `tenancy-migrations.test.js`
  tinha `DEPOIS_DA_FASE1` (usado também como ARGUMENTO do `migrate down N`, não só numa asserção) — todos
  atualizados para contar a 0036. Nenhum é específico da F.1; qualquer migration nova neste repositório
  precisa dos mesmos ajustes — vale documentar isso como um passo do checklist de nova migration.

## 9. Riscos e decisões abertas para F.2

- **Provider real**: nenhuma verificação de contrato/endpoint/preço da API real foi feita — deliberadamente
  isolado para F.2, como o comando pediu. `enrichment.py`/`service.py` já têm o ponto de extensão
  (`provider="openai"` recusado hoje, não implementado).
- **UI**: modesta de propósito — um modal por produto, sem edição livre de texto nos campos, sem histórico
  visível na tela (existe via API — `GET /products/:id/enrichment` — só não tem tela própria ainda).
- **`field_notes`/justificativa**: hoje é uma frase técnica (lista de palavras-chave encontradas); uma
  versão mais legível ("porque o nome menciona 'pai' e 'brincar'") é possível, não fiz por ser puramente
  cosmético.
- **`visible_text`**: o fake provider NUNCA o preenche a partir do nome/descrição (só de um campo de
  metadata que já declare ser transcrição) — deliberado (§2: "somente se conhecido a partir de metadados
  confiáveis ou de análise real da referência"); um provider real com visão computacional é que poderia
  preencher isto de verdade, e mesmo assim como proposta, nunca direto.
- **Duplicação pequena e deliberada**: `mergeSemanticContext` existe em Python (`enrichment.py`, para o
  core ser testável isoladamente) E em Node (`pgEnrichment.js`, porque é o painel que de fato escreve no
  produto, numa transação Postgres). Mesma regra, mesmo resultado — considerei mais simples e mais seguro
  do que fazer o painel chamar o core de novo só para recalcular um merge de 15 linhas.

## 10. Confirmação

Zero chamada OpenAI, zero chave real, zero custo externo. Zero push, merge ou deploy. Trabalho feito
inteiramente no worktree `oria-creative-fase-a` (branch `feature/creative-fase-c`), sem tocar processos ou
recursos de outras sessões — containers Postgres próprios (`oria-test-pg-f1*`), sempre derrubados ao fim de
cada rodada de teste.

**Parando aqui para revisão, como o comando pediu.**
