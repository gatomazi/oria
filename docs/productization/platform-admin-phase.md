# Fase Platform Admin — o que o control plane vende

O Oria Admin (`apps/platform-admin`) é o control plane: organizations, planos, assinaturas,
overrides, onboarding e auditoria. Este documento fixa o que ele deve — e não deve — mostrar como
**feature de plano**, depois da rodada de reclassificação.

Vocabulário completo e classificação item a item:
[`docs/architecture/features-vs-connectors.md`](../architecture/features-vs-connectors.md).
Contrato de API e schema: [`docs/architecture/control-plane.md`](../architecture/control-plane.md).

## O que o plano vende

A tela de criar/editar plano mostra **só feature comercial**, agrupada como o cliente lê o
catálogo:

```text
COMUNICAÇÃO
  WhatsApp
  Instagram
  Automações avançadas

FINANCEIRO
  Financeiro

CRIATIVOS
  Gerador de Criativos
```

O agrupamento é `GRUPOS_DE_FEATURES` (`public/js/vocabulario.js`). É só apresentação — a autoridade
continua sendo `FEATURES`, e o formulário monta a lista a partir dos grupos, então feature fora de
grupo sumiria da tela. Um teste confere que todas estão cobertas.

### Marketing & Dados

O comando previa um grupo `MARKETING & DADOS` com Meta Ads, Google Ads e Analytics GA4. Essas três
**não existem** no vocabulário: nenhuma rota as confere hoje, e o seed só aceita feature
`implementada`. Criá-las agora seria vocabulário comercial sem aplicação — e abriria o risco de
alguém ligar um guard depois e tirar Meta Ads do Tenant #1, que não teria a chave no plano. Ficam
como **feature comercial planejada**, a criar junto com os guards de rota. O grupo aparece na UI no
mesmo commit em que as features existirem.

## O que o plano NÃO vende

| Não aparece como checkbox | Por quê | Onde aparece |
|---|---|---|
| Catálogo, Trocas, Reembolsos | connector capability da Reserva Ink | tela de Integrações do painel |
| Ângulos limpos, Remarketing, Funil visual, Multiproduto | modo interno do Gerador | dentro do próprio módulo de Criativos |

No **detalhe do plano**, `creative_generator` mostra um "Inclui atualmente: Ângulos limpos ·
Remarketing · Funil visual · Multiproduto" em read-only. É informação, não entitlement: não é
editável, não vira linha em `plan_features`.

## Overrides

Override comercial atua em feature comercial. Chave reclassificada é recusada com
`422 feature_desconhecida`, e a mensagem diz que a chave foi reclassificada — para o erro não
parecer erro de digitação. Isso vale no servidor, não só na tela: `exigirFeaturesConhecidas()`
rejeita, e o mesmo caminho protege criação de plano, troca de features e override.

## Detalhe da Organization

O acesso efetivo é calculado sobre `FEATURES`, então as chaves reclassificadas simplesmente não
aparecem. Uma Organization **não** deve ser lida como "sem feature" porque um connector está
ausente: connector é outro eixo, e a tela de integrações do painel é que mostra o estado dele.

## Três cópias do vocabulário, e agora quatro listas

| Cópia | Arquivo |
|---|---|
| Registry canônico | `apps/panel/lib/platform/entitlements.js` → `FEATURES` |
| Control plane (backend) | `apps/platform-admin/lib/entitlements.js` → `FEATURES` |
| Control plane (UI) | `apps/platform-admin/public/js/vocabulario.js` → `FEATURES` |
| Banco | domain `platform_feature` |

O teste `registry` compara as quatro. O banco continua aceitando as sete chaves depreciadas — é a
Phase E da depreciação, deliberadamente adiada — e o teste sabe disso: compara o `CHECK` com
`FEATURES ∪ FEATURES_DEPRECIADAS` e exige que as duas sejam disjuntas.

## Não fechado aqui

Pricing, billing e catálogo comercial de verdade seguem abertos (PD-005/PD-009). `plans` continua
sendo vocabulário técnico de acesso.
