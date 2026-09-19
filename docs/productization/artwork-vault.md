# Artwork Vault / Protected Artwork — dívida registrada

**Status: NÃO implementado.** Este documento registra a arquitetura pretendida e o compromisso de
honestidade sobre o que ela consegue e o que não consegue. Nada aqui está no código hoje.

## De onde a preocupação veio

A exposição de estampa aparece principalmente na **importação/sincronização de produtos**, ligada à
connector capability `ink.product_import` — que hoje está marcada como `planejada` no registry, e é
por isso que ela existe no vocabulário sem estar disponível.

O que existe hoje é `ink.catalog_sync`: uma varredura de `/v1/stores/products` que guarda metadados
de catálogo em `produtos_ink`. Ela **não** traz o arquivo master da arte para dentro do Oria. O
Vault começa a fazer sentido no dia em que essa importação existir.

## Conceito

Três representações do mesmo ativo, com ciclos de vida distintos:

```
MASTER ASSET       original privado, nunca servido a cliente final
PREVIEW ASSET      visualização protegida (baixa resolução, marca d'água)
PRODUCTION ASSET   arquivo fechado/temporário, gerado por pedido, para o provider produzir
```

## Objetivos

- storage privado (bucket sem leitura pública);
- URLs assinadas, de vida curta;
- expiração — inclusive do production asset, que é por pedido;
- auditoria de acesso: quem pediu qual asset, quando, para qual pedido;
- controle por papel (RBAC de tenant, que é outro eixo — ver `features-vs-connectors.md`);
- cópia de produção por pedido, em vez de um link permanente ao master;
- fingerprint/rastreabilidade, para saber de qual cópia um vazamento saiu.

## O que isto **não** é

O arquivo precisa chegar ao provider para ser produzido. Logo:

> a proteção **reduz exposição**; não garante impossibilidade absoluta de cópia.

Não é DRM, e não deve ser comunicado como DRM infalível — nem em tela, nem em material comercial.
Quem tem o production asset nas mãos pode copiá-lo; o que o Vault entrega é reduzir quem tem, por
quanto tempo, e deixar rastro de quem teve.

## Relação com os outros eixos

| Eixo | Relação |
|---|---|
| Connector capability | `ink.product_import` (planejada) é o gatilho |
| Feature comercial | se um dia for vendido, é feature nova — não capability do Ink |
| Permissão | quem pode baixar master vs. preview é RBAC, não entitlement |

Nada disso deve ser resolvido junto: são eixos separados, e misturá-los é exatamente o defeito que
a rodada de reclassificação corrigiu.

## Pré-requisitos antes de implementar

1. `ink.product_import` sair de `planejada` — ou seja, existir importação de arte de verdade;
2. decisão sobre onde o master mora (storage privado por Organization, com RLS/ownership);
3. decisão de papéis (quem vê master, quem vê preview);
4. decisão comercial: se o Vault é feature vendável ou higiene de plataforma.
