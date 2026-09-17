# ETAPA 2 — Construção do Gerador SaaS no Painel

## Pré-condição

Executar somente depois da **Etapa 1 — Gerador Interno + Inteligências Compartilhadas** estar validada.

O SaaS deve reaproveitar o core compartilhado.

Ele NÃO deve expor todas as estratégias internas.

---

# 1. Escopo do SaaS

O produto SaaS terá somente 3 motores:

```text
Gerador de Criativos — SaaS
├── Ângulos Limpos
├── Remarketing
└── Funil por Criativo
```

Ficam exclusivamente internos:

```text
Coleção do Estado
Ângulos Multipeça / Multiestampa
Orgânico
```

---

# 2. Regra importante sobre Multipeça no SaaS

No SaaS, **Multipeça não será uma estratégia separada**.

Ela será uma capacidade de geração dentro dos 3 motores expostos.

Estrutura:

```ts
productMode:
  | "single_product"
  | "multi_product"
```

Assim:

```text
Ângulos Limpos
├── 1 produto
└── Multipeça

Remarketing
├── 1 produto
└── Multipeça

Funil por Criativo
├── 1 produto
└── Multipeça
```

---

# 3. Diferença entre o interno e o SaaS

## Interno

```text
Ângulos Multipeça / Multiestampa
```

continua como estratégia própria porque já existe e atende a operação interna.

## SaaS

Multipeça vira uma opção do fluxo:

```text
Quantidade de produtos
(•) Um produto
( ) Vários produtos
```

Não criar um quarto motor SaaS.

---

# 4. Limites sugeridos

```text
single_product:
1 produto

multi_product:
2 a 6 produtos
```

O limite pode variar por estratégia/ângulo se necessário.

---

# 5. Multipeça em Ângulos Limpos

A imagem continua sem texto promocional.

Exemplo:

```text
2–6 produtos
+
contexto
+
ângulo
+
sem overlay
```

Pode ser útil para:

- coleção;
- kits;
- variedade;
- família de produtos;
- catálogo visual.

---

# 6. Multipeça em Remarketing

Pode ser usada quando a intenção envolver:

```text
collection_discovery
site_visitor
objection
social_proof
```

Exemplo:

```text
NÃO ACHOU A SUA AINDA?
Várias opções disponíveis

[ VER TODAS ]
```

Não usar multipeça automaticamente em:

```text
product_view
cart
checkout
```

quando a intenção for recuperar um produto específico.

---

# 7. Multipeça em Funil por Criativo

Pode ser usada nos três estágios.

## TOFU

Comunicar variedade/coleção.

## MOFU

Explicar que existem diversas opções.

## BOFU

Mostrar opções + CTA + benefícios.

A seleção deve depender do objetivo.

---

# 8. Core SaaS

O painel deve consumir:

```text
Shared Intelligence
├── Brand Kit
├── Niche Kit
├── Context Intelligence
├── Products
├── Personas
├── Angles
├── Prompt Builder
├── Model Router
└── Validation
```

E somente as Strategies SaaS:

```text
CLEAN_ANGLES
REMARKETING
FUNNEL_VISUAL
```

---

# 9. Filtro de estratégias

Não duplicar código.

Exemplo conceitual:

```ts
const INTERNAL_STRATEGIES = [
  "FUNNEL_VISUAL",
  "STATE_COLLECTION",
  "REMARKETING",
  "CLEAN_ANGLES",
  "MULTI_PRODUCT_INTERNAL",
  "ORGANIC",
];

const SAAS_STRATEGIES = [
  "FUNNEL_VISUAL",
  "REMARKETING",
  "CLEAN_ANGLES",
];
```

---

# 10. Feature Flags

Sugestão:

```text
creative_generator
creative_clean_angles
creative_remarketing
creative_funnel_visual
creative_multi_product
```

Isso permite controlar:

- plano;
- rollout;
- teste;
- upsell.

---

# 11. Multi-tenant

Todo dado deve possuir:

```text
tenant_id
```

Isolar:

- API Key;
- Brand Kits;
- Niche Kits;
- produtos;
- personas;
- Context Profiles;
- jobs;
- assets;
- histórico;
- configurações.

---

# 12. BYOK OpenAI

O cliente utiliza a própria API Key.

UI:

```text
Configurações
> Integrações
> OpenAI
```

Obrigatório:

- criptografar em repouso;
- descriptografar apenas no backend;
- nunca devolver key completa;
- nunca salvar em logs;
- nunca usar localStorage;
- nunca incluir em jobs;
- nunca incluir em erros.

---

# 13. OpenAI Client por tenant

Criar:

```text
get_openai_client(tenant_id)
```

Responsabilidades:

1. validar feature;
2. carregar integração;
3. descriptografar key;
4. criar client;
5. nunca persistir key aberta.

---

# 14. Navegação

Sugestão:

```text
Criativos
├── Gerar
├── Produtos
├── Marca
├── Contextos
├── Personas
├── Histórico
└── Configurações
```

Performance pode entrar depois.

---

# 15. Tela Gerar — primeira decisão

```text
Tipo de criativo

[ Ângulos Limpos ]
[ Remarketing ]
[ Funil por Criativo ]
```

Não exibir:

```text
Coleção do Estado
Ângulos Multipeça
Orgânico
```

---

# 16. Segunda decisão — produtos

Depois do motor:

```text
Produtos

(•) Um produto
( ) Vários produtos
```

Se vários:

```text
2 a 6 produtos
```

Essa decisão deve adaptar o restante do fluxo.

---

# 17. Formulário — Ângulos Limpos

```text
Produto(s)
Contexto
Ângulo(s)
Persona
Formato
Quantidade
Qualidade
Copy opcional
```

Não mostrar:

- headline na imagem;
- CTA na imagem;
- badges;
- benefícios.

Multipeça altera apenas produto/composição.

---

# 18. Formulário — Remarketing

```text
Produto(s)
Remarketing Intent
Contexto
Ângulo
Persona
Formato
Text Density
CTA Emphasis
Clean Mode
Headline
CTA
Benefícios
```

Multipeça deve ser permitida apenas quando fizer sentido para a intenção selecionada.

---

# 19. Formulário — Funil por Criativo

```text
Produto(s)
Funil
Contexto
Ângulo
Persona
Formato
Text Density
CTA Emphasis
Clean Mode
Headline
Subheadline
CTA
Badges
Benefícios
Search Bar
Chips
```

Usar progressive disclosure.

---

# 20. Preview

Exemplo:

```text
Motor: Funil por Criativo
Produtos: 4
Modo: Multipeça
Funil: MOFU
Ângulo: Flatlay
Formato: Feed
Quantidade: 4
```

CTA:

```text
Gerar 4 criativos
```

---

# 21. Placements

Primeira versão:

```text
Feed 4:5
Story 9:16
```

Arquitetura preparada para expansão.

---

# 22. Jobs

Lotes devem rodar em queue.

Estados:

```text
queued
planning
generating
processing
completed
partial
failed
cancelled
```

---

# 23. Progress

Mostrar:

```text
Gerando 8 de 20
```

Por item:

```text
✓ Feed — Lifestyle
✓ Feed — Flatlay
⟳ Story — Premium
```

---

# 24. Retry

Permitir retry individual.

Manter:

```text
creative_id
generation_attempt
```

---

# 25. Histórico

Registrar:

```text
creative_id
tenant_id
brand_id
engine
product_mode
product_id(s)
angle
context_id
persona
placement
funnel_stage
remarketing_intent
brand_kit_version
niche_kit_version
prompt_version
quality
asset
created_at
```

---

# 26. Storage

Estrutura:

```text
tenant/{tenant_id}/creatives/{creative_id}/
```

Não usar disco efêmero.

---

# 27. Entidades mínimas

Reutilizar estrutura existente quando houver equivalente.

Sugestão:

```text
creative_settings
creative_brand_profiles
creative_niche_profiles
creative_context_profiles
creative_products
creative_personas
creative_jobs
creative_generations
creative_assets
```

Performance pode entrar depois.

---

# 28. Brand Kit no SaaS

Permitir:

- selecionar;
- editar;
- versionar;
- definir padrão;
- ativar/desativar ângulos;
- revisar regras.

---

# 29. Niche Kit no SaaS

Permitir:

- selecionar;
- editar;
- customizar;
- revisar regras.

Primeiros:

```text
generic_commerce
fashion
```

---

# 30. Context Intelligence

Consumir providers compartilhados:

```text
GeographicContextProvider
NicheContextProvider
CustomContextProvider
```

Não duplicar no painel.

---

# 31. Use Origens como cliente do SaaS

Exemplo:

```text
BrandKit:
use_origens

NicheKit:
fashion

ContextProvider:
geographic
```

---

# 32. Outro cliente

Exemplo:

```text
BrandKit:
fitness_brand_x

NicheKit:
fashion

ContextProvider:
niche
```

O mesmo fluxo precisa funcionar.

---

# 33. Regras de Multipeça por motor

Criar configuração central.

Exemplo:

```ts
multiProductRules = {
  CLEAN_ANGLES: {
    enabled: true,
    min: 2,
    max: 6
  },

  REMARKETING: {
    enabled: true,
    min: 2,
    max: 6,
    allowedIntents: [
      "site_visitor",
      "collection_discovery",
      "social_proof",
      "objection"
    ]
  },

  FUNNEL_VISUAL: {
    enabled: true,
    min: 2,
    max: 6
  }
}
```

---

# 34. Performance

Pode entrar depois do MVP.

Quando entrar:

```text
spend
impressions
reach
clicks
link_clicks
ctr
cpc
add_to_cart
purchases
purchase_value
cpa
roas
```

Associar por `creative_id`.

---

# 35. Critérios de aceite

- [ ] SaaS exibe somente 3 motores.
- [ ] Coleção do Estado não aparece.
- [ ] Orgânico não aparece.
- [ ] Ângulos Multipeça não aparece como motor.
- [ ] Multipeça funciona dentro dos 3 motores.
- [ ] Ângulos Limpos continua sem overlay.
- [ ] Remarketing continua independente.
- [ ] Funil por Criativo continua independente.
- [ ] Feature flags controlam acesso.
- [ ] BYOK funciona.
- [ ] Tenant isolation funciona.
- [ ] Brand/Niche Kits persistem.
- [ ] Context Intelligence é reaproveitado.
- [ ] Jobs funcionam.
- [ ] Retry funciona.
- [ ] Assets são persistentes.
- [ ] Histórico registra product_mode.
- [ ] Outro cliente não regional consegue usar.

---

# 36. Tarefa inicial do Claude

Antes de modificar o painel:

criar:

```text
docs/creative-generator-saas-integration-plan.md
```

Mapear:

- arquitetura atual do painel;
- pontos de integração com o core;
- estratégias SaaS;
- productMode;
- multi-product rules;
- feature flags;
- BYOK;
- jobs;
- storage;
- migrations;
- endpoints;
- páginas;
- permissões;
- riscos;
- testes.

Só depois implementar.

---

# 37. Resultado esperado

```text
Painel SaaS
└── Gerador de Criativos
    ├── Ângulos Limpos
    │   ├── 1 produto
    │   └── Multipeça
    │
    ├── Remarketing
    │   ├── 1 produto
    │   └── Multipeça quando aplicável
    │
    └── Funil por Criativo
        ├── 1 produto
        └── Multipeça
```

Sem expor as estratégias internas exclusivas.
