# Complemento — Granularidade das Features: Gerador de Criativos como feature única

## Contexto

Este documento complementa:

```text
claude-separar-features-comerciais-connectors-capabilities.md
```

A rodada anterior separa:

```text
FEATURE COMERCIAL
CONNECTOR
CONNECTOR CAPABILITY
PERMISSÃO
```

Durante a revisão do plano `internal`, apareceu outra mistura conceitual:

```text
Gerador de criativos
Criativos · ângulos limpos
Criativos · remarketing
Criativos · funil visual
Criativos · multiproduto
```

Hoje todos aparecem como features independentes do plano.

Isso deixa o catálogo comercial granular demais e expõe detalhes internos do módulo como se fossem produtos separados.

A decisão nova é:

```text
creative_generator
= FEATURE COMERCIAL

creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
= MODULE CAPABILITIES / MODOS INTERNOS
```

---

# 1. Objetivo

Simplificar o modelo de plano para que ele represente:

```text
o que o cliente compra
```

e não:

```text
cada engine/modo interno existente dentro do produto
```

Ao final, o plano deve mostrar apenas:

```text
Gerador de Criativos
```

como feature comercial.

---

# 2. Feature comercial canônica

Manter:

```text
creative_generator
```

Nome exibido:

```text
Gerador de Criativos
```

Essa feature habilita o módulo como um todo.

---

# 3. Reclassificar modos internos

Reclassificar:

```text
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

para uma camada separada:

```text
Creative Module Capabilities
```

ou equivalente.

Não devem mais aparecer como checkboxes independentes em planos.

---

# 4. Modelo conceitual

Antes:

```text
PLAN
├── creative_generator
├── creative_clean_angles
├── creative_remarketing
├── creative_funnel_visual
└── creative_multi_product
```

Depois:

```text
PLAN
└── creative_generator
      ↓
   Creative Module
      ├── clean_angles
      ├── remarketing
      ├── funnel_visual
      └── multi_product
```

---

# 5. Regra de produto

Pergunta para decidir se algo é feature comercial:

```text
"O cliente entende isso como um módulo/produto que compra
ou é apenas um modo interno daquele módulo?"
```

Se for modo interno:

```text
MODULE CAPABILITY
```

não feature de plano.

---

# 6. UI de planos

Na tela de criar/editar plano:

REMOVER:

```text
Criativos · ângulos limpos
Criativos · remarketing
Criativos · funil visual
Criativos · multiproduto
```

MANTER:

```text
Gerador de Criativos
```

---

# 7. Estrutura visual esperada do plano

Exemplo:

```text
COMUNICAÇÃO
WhatsApp
Instagram
Automações avançadas

MARKETING & DADOS
Meta Ads
Google Ads
Analytics GA4

FINANCEIRO
Financeiro

CRIATIVOS
Gerador de Criativos
```

Não expor engines internas nessa superfície.

---

# 8. Registry de capabilities do módulo

Criar/reusar um registry separado, por exemplo:

```text
creative_capabilities
```

ou registry em código.

Exemplo:

```text
clean_angles
remarketing
funnel_visual
multi_product
```

Não precisa ser tabela se não houver necessidade de persistência.

---

# 9. Relação feature → capabilities

Regra default V1:

```text
creative_generator = true
→ módulo disponível
→ capabilities atuais disponíveis
```

Ou seja:

```text
clean_angles = available
remarketing = available
funnel_visual = available
multi_product = available
```

---

# 10. Não usar entitlement individual por engine

No runtime novo, não exigir:

```text
creative_clean_angles = true
```

para liberar Ângulos Limpos.

A autorização deve ser:

```text
creative_generator = true
AND capability existe no módulo
```

---

# 11. Compatibilidade com código atual

Auditar todos os usos de:

```text
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

Classificar:

```text
A. entitlement comercial
B. capability interna
C. feature flag técnica
D. teste/compat legado
```

Migrar usos do tipo `A` para:

```text
creative_generator
```

---

# 12. Não quebrar os motores

Esta mudança não remove nenhum motor.

Depois da migração, continuam existindo:

```text
Ângulos limpos
Remarketing
Funil visual
Multiproduto
```

Apenas deixam de ser entitlement comercial independente.

---

# 13. Runtime do Gerador

Fluxo:

```text
Organization
→ entitlement creative_generator
→ Creative Generator habilitado
→ lista de capabilities disponíveis
→ usuário escolhe modo
```

---

# 14. OpenAI BYOK

A regra definida anteriormente continua:

```text
creative_generator = true
→ OpenAI BYOK pode aparecer no onboarding
```

Não derivar OpenAI de cada capability individual.

---

# 15. Plano `internal`

Atualizar o `internal`.

Antes:

```text
creative_generator
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

Depois:

```text
creative_generator
```

Mas:

```text
nenhuma funcionalidade de criativos pode desaparecer
```

As quatro capabilities continuam disponíveis pelo módulo.

---

# 16. Baseline Tenant #1

Atualizar:

```text
config/entitlements/tenant1-entitlements.json
```

ou equivalente.

Remover como entitlements comerciais:

```text
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

Manter:

```text
creative_generator
```

---

# 17. Migration strategy

Se as quatro keys já existem em:

```text
plan_features
organization overrides
DB constraints
enums/domains
```

não remover de forma destrutiva imediatamente.

Preferir:

```text
Phase A
parar de usá-las comercialmente

Phase B
migrar runtime guards para creative_generator

Phase C
remover do internal

Phase D
marcar antigas como deprecated

Phase E
remover do registry físico em migration futura
```

Evitar migration arriscada desnecessária agora.

---

# 18. Deprecated legacy feature keys

Se precisar manter temporariamente:

```text
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

marcar explicitamente:

```text
deprecated
non-commercial
ignored for entitlement resolution
```

Não mostrar na UI de planos.

---

# 19. Organization overrides

Não permitir novos overrides para:

```text
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

na UI do Control Plane.

Overrides comerciais passam a atuar em:

```text
creative_generator
```

---

# 20. Se futuramente quiser limitar modos por plano

Não voltar automaticamente ao modelo de feature por engine.

Preferir:

```text
creative_generator = true

creative_generator.capabilities = [...]
```

ou:

```text
module capability policy
```

Exemplo futuro:

```text
Starter
Gerador de Criativos
capabilities:
- clean_angles
- remarketing

Pro
Gerador de Criativos
capabilities:
- clean_angles
- remarketing
- funnel_visual
- multi_product
```

Mas NÃO implementar isso agora.

---

# 21. Se futuramente quiser limitar uso

Também não criar entitlement por engine.

Preferir:

```text
creative_generator.limits.monthly = 100
```

ou modelo de usage/quota separado.

Não implementar quotas nesta rodada.

---

# 22. Novo modo futuro

Se amanhã surgir:

```text
UGC
Lifestyle
Carrossel
Vídeo
Produto em ambiente
```

não criar automaticamente novas features comerciais.

Adicionar como:

```text
Creative Module Capability
```

e manter o plano simples:

```text
Gerador de Criativos
```

---

# 23. UI do módulo Criativos

Dentro do Tenant Panel, o módulo pode continuar mostrando:

```text
Ângulos limpos
Remarketing
Funil visual
Multiproduto
```

como opções/motores.

Isso é UI funcional, não plano comercial.

---

# 24. Control Plane

No detalhe do plano:

ANTES:

```text
Gerador de criativos           incluído
Criativos · ângulos limpos     incluído
Criativos · remarketing        incluído
Criativos · funil visual       incluído
Criativos · multiproduto       incluído
```

DEPOIS:

```text
Gerador de Criativos           incluído
```

Opcionalmente, em read-only:

```text
Inclui atualmente:
• Ângulos limpos
• Remarketing
• Funil visual
• Multiproduto
```

Mas não como features editáveis do plano.

---

# 25. Testes — feature registry

Provar:

```text
creative_generator
→ feature comercial válida
```

E:

```text
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

não aparecem como features comerciais selecionáveis.

---

# 26. Testes — capability registry

Provar:

```text
clean_angles
remarketing
funnel_visual
multi_product
```

existem como capabilities do Creative Generator.

---

# 27. Testes — entitlement

Cobrir:

```text
creative_generator=true
→ todos os modos V1 disponíveis

creative_generator=false
→ nenhum modo disponível
```

---

# 28. Testes — UI de planos

Garantir:

```text
Criar plano
Editar plano
```

mostram apenas:

```text
Gerador de Criativos
```

na seção Criativos.

Negative control:

```text
qualquer engine interna voltar como checkbox de plano
→ teste falha
```

---

# 29. Testes — Tenant Panel

Com:

```text
creative_generator=true
```

o painel continua permitindo:

```text
Ângulos limpos
Remarketing
Funil visual
Multiproduto
```

Sem depender das antigas keys individuais.

---

# 30. Atualizar a matriz de arquitetura

No documento:

```text
features-vs-connectors.md
```

ou equivalente, incluir:

```text
ITEM                          TIPO
---------------------------------------------------
Gerador de Criativos          Feature
Ângulos limpos                Module Capability
Remarketing                   Module Capability
Funil visual                  Module Capability
Multiproduto                  Module Capability
```

---

# 31. Princípio geral

Registrar:

```text
Feature
= unidade comercial

Module Capability
= comportamento interno de uma feature

Connector Capability
= comportamento suportado por um provider externo
```

Exemplos:

```text
creative_generator
→ Feature

multi_product
→ Module Capability

ink.refunds
→ Connector Capability
```

---

# 32. Não fazer

NÃO:

```text
remover motores
quebrar rotas do Gerador
alterar prompts
alterar geração de imagens
alterar OpenAI integration
implementar quotas
implementar planos Starter/Pro reais
criar pricing
```

---

# 33. Sequência

Executar:

```text
1. auditar usos das 4 creative_* keys
2. classificar usos
3. criar/reusar capability registry
4. migrar guards para creative_generator
5. atualizar internal plan
6. atualizar Tenant #1 baseline
7. atualizar Control Plane UI
8. atualizar Tenant Panel guards
9. marcar keys antigas deprecated se necessário
10. testes
11. negative controls
12. docs
13. deploy
14. smoke
```

---

# 34. Smoke esperado

No Oria Admin:

```text
Plano Internal
```

deve mostrar:

```text
Gerador de Criativos → incluído
```

e não quatro features adicionais.

No Tenant Panel:

```text
Criativos
```

continua oferecendo os motores existentes.

---

# 35. Checkpoint final

Retornar:

```text
1. usos encontrados de creative_clean_angles
2. usos encontrados de creative_remarketing
3. usos encontrados de creative_funnel_visual
4. usos encontrados de creative_multi_product
5. nova classificação
6. feature registry antes/depois
7. capability registry
8. internal plan antes/depois
9. tenant1 baseline antes/depois
10. runtime guards alterados
11. Control Plane UI
12. Tenant Panel UI
13. deprecated keys strategy
14. testes
15. negative controls
16. docs
17. commits
18. CI
19. deploy
20. smoke
21. blockers
22. GO / NO-GO
```

---

# Estado esperado

```text
PLAN
└── Gerador de Criativos
    key: creative_generator

CREATIVE MODULE CAPABILITIES
├── clean_angles
├── remarketing
├── funnel_visual
└── multi_product
```

O cliente compra:

```text
Gerador de Criativos
```

O produto decide internamente quais modos existem dentro dele.
