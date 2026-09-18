# `negative-controls.test.js`: por que custa 637 s e o que fazer — PROPOSTA

Este documento **não implementa nada**. Ele mede, explica e propõe. A regra que vale enquanto isso é
a de sempre: **nenhum controle negativo pode ser removido, encurtado ou pulado**.

> Atualizado depois do merge com `main` em `e6b307d`: a rodada de entitlement canônico acrescentou
> uma violação da classe `entitlement/*`, então são **65**, não 64. A proposta não muda — o
> custo continua sendo estrutural e proporcional ao número de violações.

## 1. O fato — MEDIDO

No GitHub Actions (PR #1, runs 35394926454 e 35394886466) o shard `painel · banco 1/4` levou **680 s
e 739 s**, contra 96–108 s dos outros três. O relatório de duração por arquivo, coletado no runner,
aponta um culpado único:

```
test/invariants/negative-controls.test.js   637,8 s
test/invariants/r19-release-b-contrato.test.js      4,7 s
test/invariants/tenancy-isolation.test.js           2,3 s
test/invariants/r19-whatsapp-webhook-secret-boot.test.js  0,8 s
test/invariants/hotpix.test.js                      0,2 s
test/invariants/tenancy-schema.test.js              0,1 s
test/invariants/fase6-tenant1-config.test.js          0 s
test/invariants/inv-td003-postgres-obrigatorio.test.js 0 s
```

Ou seja: **um arquivo é 94 % de um shard, e o shard é o caminho crítico do CI inteiro.** Enquanto a
suíte rodava como um bloco de 1057 s, isso era invisível.

## 2. Por que custa tanto — FATO OBSERVADO

`negative-controls.test.js` declara **65 violações** (`VIOLACOES`), e para cada uma roda o ciclo de 5
passos do plano de productização:

1. copia `lib/`, `routes/` e `server.js` para um diretório temporário (`copiarLib`, com symlink para
   `node_modules`);
2. **passo 1** — roda o invariant correspondente contra a cópia intacta: tem que passar;
3. **passo 2** — aplica o defeito histórico na cópia;
4. **passo 3** — roda o MESMO invariant: tem que reprovar;
5. **passo 4/5** — desfaz o defeito e roda de novo: tem que voltar a passar.

São **3 `node --test` em subprocesso por violação** — 195 processos Node no total — cada um pagando
boot do runtime e carga dos módulos, mais 65 cópias da árvore de código. O custo é estrutural, não
um teste lento: é o preço de provar que 65 invariants detectam o que dizem detectar.

**Esse preço não deve ser cortado.** Foi ele que transformou "os invariants passam" em "os
invariants reprovam quando o defeito volta".

## 3. Os controles são independentes entre si? — SIM, por construção

Cada violação é `{ classe, invariant, teste, aplicar }`, roda numa cópia própria do código
(`INVARIANT_SUBJECT_ROOT`), e o arquivo tem um teste que prova que **o repositório nunca é
modificado pelo ciclo**. Não há estado compartilhado entre violações, nem ordem exigida entre elas.
As 65 se distribuem em 66 classes distintas, que se agrupam por prefixo — contagem MEDIDA no
arquivo:

| grupo proposto | prefixos | violações |
|---|---|---|
| `whatsapp` | `whatsapp` | 15 |
| `auth` | `auth` (5), `convite` (4), `onboarding` (5) | 14 |
| `tenancy` | `tenancy` (7), `dre` (3), `fase6` (1), `audit` (1) | 12 |
| `integracoes` | `integracoes` (4), `webhook` (3), `secrets` (3), `oauth` (1) | 11 |
| `connector-creative` | `connector` (4), `creative` (3), `entitlement` (3), `jobs` (2), `recuperacao` (1) | 13 |

## 4. Proposta (não implementada)

1. **Filtro por grupo, fail-closed.** `negative-controls.test.js` passa a aceitar
   `NEGATIVE_CONTROLS_GROUP=<grupo>` e roda só as violações daquele grupo. Sem a variável, roda
   todas — o comportamento local e o do gate não mudam.
2. **Cobertura verificada, não presumida.** Um teste no próprio arquivo (ou em `scripts/ci/`) exige
   que a união dos grupos seja exatamente as 65 violações, sem sobra e sem repetição — a mesma regra
   que `suites.mjs verify` já aplica aos shards. Grupo novo sem dono reprova.
3. **Um job por grupo, com Postgres próprio**, exatamente como os shards de hoje (invariante D18/D23
   preservado). ESTIMADO: 5 jobs de ~130 s cada no lugar de um de ~640 s.
4. **Copiar a árvore uma vez por grupo**, não uma vez por violação: `copiarLib` num `before` do
   grupo, com a violação aplicada e desfeita sobre a mesma cópia. As 65 cópias viram 5. Requer
   cuidado: o passo 5 já prova que a cópia volta ao estado correto, então a garantia continua
   existindo — mas isso precisa ser medido antes de ser afirmado.
5. **Não mexer nos 5 passos.** Nem juntar passo 1 e 5, nem rodar só o passo 3. O ciclo inteiro é o
   que dá sentido ao controle negativo.

ESTIMADO do ganho: o wall time do CI rápido cairia de ~11,5 min para a ordem de **~4 min** (o próximo
maior job é o gate de productização, com 218 s medidos).

## 5. O que decidir antes de implementar (OPEN)

- **OPEN-A** — os grupos acima são um rascunho derivado dos prefixos de `classe`. Quem manda é a
  intenção do invariant, não o nome: a lista final precisa de revisão humana.
- **OPEN-B** — a cópia única por grupo (item 4) muda o isolamento entre violações. Só entra com
  medição e com o teste de "o repositório nunca é modificado" ainda verde.
- **OPEN-C** — se o gate de productização (`npm test` inteiro) continua rodando todas as 65 de uma
  vez no nightly, o custo total não some; ele só sai do caminho crítico do PR. Isso é aceitável, e
  provavelmente desejável, mas é uma decisão consciente.
