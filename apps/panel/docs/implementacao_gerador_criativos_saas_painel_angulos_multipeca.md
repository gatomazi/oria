> **SUPERADO (15/09/2026) — não implementar a partir deste documento.**
> O escopo aqui (Ângulos Limpos + Ângulos Multipeça como motores do SaaS) foi substituído pela spec v2:
> `docs/creative-generator/02-etapa-saas-3-motores-multipeça-integrado-v2.md` (3 motores — Ângulos Limpos,
> Remarketing, Funil por Criativo — com Multipeça como `product_mode` dentro de cada um) e pelo plano de integração
> `docs/creative-generator-saas-integration-plan.md`. Mantido só como histórico.

# Implementação no Painel — Gerador de Criativos SaaS
## Escopo revisado: somente Ângulos Limpos + Ângulos Multipeça

> Projeto: **Painel Estamparia / produto SaaS**
>
> Objetivo: portar para o painel apenas os dois modos mais genéricos do gerador local:
>
> 1. **Ângulos Limpos**
> 2. **Ângulos Multipeça**
>
> Os demais modos atuais — **Funil por Criativo**, **Coleção do Estado** e **Orgânico** — continuam sendo ferramentas internas da operação e **não devem ser migrados para o produto SaaS** nesta implementação.
>
> A cobrança da OpenAI deve ocorrer diretamente na conta do cliente via **BYOK (Bring Your Own Key)**. O cliente conecta sua própria API Key no painel para utilizar o módulo.
>
> O Gerador de Criativos será uma feature de plano/assinatura separada.

---

# 1. Escopo definitivo do produto

O módulo SaaS deve oferecer:

```text
Gerador de Criativos
├── Ângulos Limpos
└── Ângulos Multipeça
```

Fora do escopo:

```text
Funil por Criativo
Coleção do Estado
Orgânico
```

Esses três permanecem no gerador local/interno.

Não criar menus, endpoints, tabelas ou abstrações específicas para eles no painel.

---

# 2. Por que esses dois modos

Os dois modos escolhidos são os mais genéricos e reutilizáveis para qualquer nicho.

## Ângulos Limpos

Conceito:

```text
IMAGEM = produto + contexto + ângulo
COPY = separada da imagem
```

A imagem não precisa carregar:

- headline;
- CTA;
- preço;
- selo;
- oferta;
- estágio de funil.

Isso torna o motor utilizável para:

- moda;
- fitness;
- pet;
- alimentação;
- beleza;
- decoração;
- presentes;
- produtos físicos em geral.

## Ângulos Multipeça

Mesmo motor conceitual, mas com:

```text
2 a 6 produtos / peças na mesma cena
```

Serve para:

- coleção;
- variedade;
- kits;
- linha de produtos;
- combinações;
- família de produtos;
- catálogo visual.

---

# 3. Estratégias SaaS

IDs sugeridos:

```text
CLEAN_ANGLES
MULTI_PRODUCT
```

Pode manter compatibilidade interna com os IDs atuais:

```text
ANGULOS_LIMPOS
ANGULOS_MULTIPECA
```

se isso reduzir trabalho de migração.

---

# 4. Estrutura do módulo

```text
Criativos
│
├── Gerar
│   ├── Ângulos Limpos
│   └── Multipeça
│
├── Produtos
├── Marca
├── Contextos
├── Personas
├── Histórico
├── Performance
└── Configurações
```

Não criar:

```text
Funil
Coleção do Estado
Orgânico
```

na navegação do cliente.

---

# 5. Produto SaaS, não gerador regional

O core não deve assumir:

```text
cidade
UF
região
DDD
regionalismo
```

A Use Origens será apenas uma configuração específica.

Exemplo:

```text
Brand:
Use Origens

Niche:
moda regional

Context Provider:
geographic

Subject:
Florianópolis / SC
```

Outro cliente:

```text
Brand:
Marca Fitness X

Niche:
moda fitness

Context Provider:
niche/activity

Subject:
musculação
```

O mesmo motor gera ambos.

---

# 6. Multi-tenant

Todo dado novo deve ser vinculado a:

```text
tenant_id
```

ou identificador equivalente já existente no painel.

Isolar por tenant:

- API Key OpenAI;
- marca;
- nicho;
- produtos;
- imagens;
- personas;
- contextos;
- jobs;
- histórico;
- performance;
- configurações.

Nenhum tenant deve acessar dados de outro.

---

# 7. Plano / assinatura

Criar feature:

```text
creative_generator
```

Não hardcodar nome do plano.

Exemplo conceitual:

```json
{
  "features": {
    "creative_generator": true
  }
}
```

Backend deve validar essa feature antes de:

- abrir geração;
- criar job;
- chamar OpenAI;
- acessar histórico;
- pesquisar contextos;
- importar performance.

---

# 8. Upsell

Cliente sem a feature:

```text
Gerador de Criativos

Crie imagens de produto com IA diretamente pelo painel.

• Ângulos Limpos
• Multipeça
• Contextos inteligentes
• Histórico de criativos

[Conhecer plano]
```

Não depender apenas de esconder menu.

Endpoint também deve bloquear.

---

# 9. BYOK — OpenAI do próprio cliente

A assinatura do painel cobra:

```text
acesso à ferramenta
```

A OpenAI cobra:

```text
consumo da API do próprio cliente
```

O painel não deve usar a API Key global da plataforma para gerações de clientes.

---

# 10. Integração OpenAI

Adicionar em:

```text
Configurações
> Integrações
> OpenAI
```

UI:

```text
OpenAI

Conecte sua própria conta OpenAI para utilizar o Gerador de Criativos.

API Key
[sk-................................]

[Testar conexão]
[Salvar]
```

Após conectar:

```text
Conectado
••••••••••••••••xxxx

Último teste: ...
[Substituir chave]
[Remover]
```

---

# 11. Segurança da API Key

Obrigatório:

- criptografar em repouso;
- descriptografar somente no backend;
- nunca devolver chave completa ao frontend;
- nunca salvar em logs;
- nunca colocar em localStorage;
- nunca incluir em jobs;
- nunca incluir em manifests;
- nunca incluir em erros retornados ao cliente.

Reutilizar infraestrutura de integrações/segredos do painel, se existir.

---

# 12. OpenAI Client por tenant

Criar abstração:

```python
get_openai_client(tenant_id)
```

Responsabilidades:

1. validar plano;
2. carregar integração;
3. descriptografar chave;
4. criar client;
5. nunca persistir chave descriptografada.

Erros de domínio:

```text
CreativeGeneratorNotAvailable
OpenAIIntegrationNotConfigured
OpenAIAuthenticationFailed
```

---

# 13. Arquitetura de inteligência

Separar:

```text
Brand Intelligence
Niche Intelligence
Context Intelligence
```

O motor usa as três camadas para montar a cena.

---

# 14. Brand Intelligence

Perfil permanente da marca.

Exemplo:

```json
{
  "name": "Marca X",
  "positioning": "premium acessível",
  "audience": [
    "mulheres 25-40"
  ],
  "tone": [
    "natural",
    "moderno"
  ],
  "visual_style": [
    "clean",
    "editorial"
  ],
  "colors": [],
  "preferred_contexts": [],
  "avoid": [],
  "manual_notes": []
}
```

Campos de onboarding:

```text
Nome da marca
Descrição
O que vende
Público
Posicionamento
Tom
Estilo visual
Cores
Evitar
Observações
```

---

# 15. Niche Intelligence

Perfil do nicho.

Exemplo:

```json
{
  "niche": "moda fitness",
  "audience_behaviors": [],
  "common_usage_scenarios": [],
  "activities": [],
  "scene_contexts": [],
  "materials": [],
  "visual_cliches": [],
  "avoid": []
}
```

Pode ser:

- preenchido manualmente;
- gerado via IA;
- revisado pelo cliente.

---

# 16. Context Intelligence

Abstração genérica:

```text
ContextProfile
```

Exemplo:

```json
{
  "context_id": "ctx_...",
  "context_type": "activity",
  "subject": {
    "name": "musculação",
    "metadata": {}
  },
  "summary": "...",
  "scene_contexts": [],
  "visual_signatures": [],
  "activities": [],
  "materials": [],
  "environment": [],
  "domain_elements": [],
  "avoid": [],
  "sources": [],
  "confidence": 0.91,
  "status": "approved",
  "profile_version": 1
}
```

---

# 17. Context Providers

Criar interface:

```text
ContextProvider
```

Implementações iniciais:

```text
GeographicContextProvider
NicheContextProvider
CustomContextProvider
```

### GeographicContextProvider

Para Use Origens e clientes que dependem de lugar.

### NicheContextProvider

Para a maioria dos clientes.

### CustomContextProvider

Para briefing manual.

Não acoplar o motor a nenhum provider.

---

# 18. Contexto automático não é aleatório

Quando o cliente escolher:

```text
Contexto: Automático
```

o sistema deve considerar:

```text
Brand
+
Niche
+
Product
+
Angle
+
Context Intelligence
+
History
```

e escolher uma cena coerente.

Nunca interpretar automático como:

```text
escolher qualquer cenário visualmente bonito
```

---

# 19. Responses API + web search

Usar quando for necessário construir ou enriquecer um contexto.

Fluxo:

```text
contexto já existe?
  ├── sim -> reutilizar
  └── não -> pesquisar
             ↓
        Responses API
        + web_search
        + Structured Output
             ↓
         salvar perfil
```

Não pesquisar a web a cada geração.

---

# 20. Structured Outputs

Perfis persistidos por IA devem seguir JSON Schema.

Não depender de texto livre.

Versionar:

```text
schema_version
prompt_version
profile_version
```

---

# 21. Model Routing

Criar módulo central.

Modelos configuráveis:

```text
Luna
Terra
Sol
```

### Luna

- copies;
- classificação;
- resumo;
- variações;
- organização;
- seleção simples de contexto.

### Terra

- Context Intelligence;
- web search;
- Structured Output complexo;
- interpretação de nicho;
- conceitos mais exigentes.

### Sol

- fallback;
- conflito;
- tarefa difícil;
- máxima qualidade manual.

---

# 22. Configuração de IA

UI:

```text
Modelo de texto

(•) Automático
( ) Econômico
( ) Equilibrado
( ) Máxima qualidade
```

Mapear internamente:

```text
auto
luna
terra
sol
```

A imagem continua com:

```text
gpt-image-2
```

---

# 23. Produtos / referências

Criar entidade genérica:

```text
CreativeProduct
```

Campos:

```text
id
tenant_id
brand_id
name
type
description
reference_images
metadata
created_at
updated_at
```

Não assumir camiseta.

---

# 24. Metadata flexível

Use Origens:

```json
{
  "city": "Florianópolis",
  "uf": "SC",
  "print_type": "central"
}
```

Fitness:

```json
{
  "product_type": "legging",
  "color": "preto"
}
```

Pet:

```json
{
  "product_type": "cama",
  "animal_size": "grande"
}
```

---

# 25. Uploads

Aceitar:

```text
PNG
JPG
WEBP
```

Converter internamente quando necessário.

Permitir:

- 1 referência;
- múltiplas referências;
- produto;
- estampa;
- mockup;
- detalhe.

---

# 26. Ângulos Limpos — comportamento

Preservar o motor atual.

Conceito:

```text
imagem sem texto promocional
```

A imagem representa:

```text
produto
+
contexto
+
ângulo
```

---

# 27. Ângulos existentes

Migrar os 13 IDs atuais:

```text
IDENTIDADE_ORIGEM
LIFESTYLE_COTIDIANO
ORGULHO_DISCRETO
PERTENCIMENTO
NOSTALGIA_ORIGEM
CABIDE
PRODUTO_ESTAMPA
CAIMENTO
CLOSE_ESTAMPA
CLOSE_BOLSO
PREMIUM_ESTILO
CREATOR_STYLE
PRESENTE_AFETO
```

Os labels podem variar por Brand/Niche Pack.

---

# 28. Labels por nicho

Exemplo:

```text
IDENTIDADE_ORIGEM
```

Use Origens:

```text
Identidade / Origem
```

Fitness:

```text
Identidade / Lifestyle
```

Entre Nós:

```text
Retrato do laço
```

IDs permanecem estáveis.

---

# 29. Ângulos aplicáveis

Nem todo ângulo precisa aparecer em todo nicho.

Brand/Niche Pack pode definir:

```json
{
  "enabled_angles": [
    "LIFESTYLE_COTIDIANO",
    "CABIDE",
    "PRODUTO_ESTAMPA",
    "PREMIUM_ESTILO"
  ]
}
```

Não excluir ângulos do core.

Apenas controlar disponibilidade.

---

# 30. Multipeça

Preservar:

```text
2 a 6 produtos
```

Com:

- mapper produto/referência;
- N pessoas quando aplicável;
- N peças quando sem pessoa;
- limites recomendados;
- contexto único da cena;
- regras de preservação por item.

---

# 31. Contexto do Multipeça

No SaaS:

```text
uma cena
+
vários produtos
```

O Context Intelligence deve resolver contexto da cena, não de cada peça individualmente.

Pode usar:

- produto principal;
- Brand;
- Niche;
- objetivo;
- ângulo.

---

# 32. Personas

Migrar sistema atual, mas tornar por tenant/brand.

Permitir:

```text
Automáticas
Customizadas
```

Campos:

```text
label
age_range
appearance
style
behavior
notes
```

Rotacionar sem repetição grosseira.

---

# 33. Product Types

Migrar tipos atuais como seed para moda:

```text
camiseta
camiseta premium
regata
oversized
body infantil
moletom
cropped moletom
hoodie
infantil
cropped
```

Mas permitir criar outros.

Exemplo:

```text
legging
top
caneca
embalagem
cama pet
garrafa
```

---

# 34. Placements

Primeira versão:

```text
Feed 4:5
Story 9:16
```

Carrossel não é obrigatório neste MVP.

Arquitetura deve permitir adicionar depois.

---

# 35. Copies

Como Ângulos Limpos e Multipeça deixam funil fora da imagem:

copies continuam separadas.

Permitir:

```text
Sem copy
Gerar copy
```

Se gerar:

```text
TOFU
MOFU
BOFU
```

pode continuar existindo apenas como lógica textual.

Não criar o modo Funil Visual.

---

# 36. Copy por IA

Entrada:

```text
Brand
Niche
Product
Angle
Context
Funnel
Offer/Claims
```

Saída estruturada:

```json
{
  "primary_text": "...",
  "headline": "...",
  "description": "..."
}
```

---

# 37. Tela principal — Gerar

Primeiro escolher:

```text
Tipo de criativo

[Ângulos Limpos]
1 produto por imagem

[Multipeça]
2 a 6 produtos na mesma imagem
```

Depois:

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

---

# 38. Preview antes da geração

Exemplo:

```text
Resumo

Modo: Ângulos Limpos
Produtos: 3
Ângulos: 5
Formatos: Feed + Story
Total: 30 imagens

As gerações utilizarão sua conta OpenAI.

[Gerar 30 criativos]
```

---

# 39. Jobs

Lotes não devem rodar em request síncrono longo.

Usar queue/job do painel.

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

# 40. Progress

UI:

```text
Gerando 8 de 20
```

Por item:

```text
✓ Feed — Lifestyle
✓ Feed — Flatlay
⟳ Story — Premium
…
```

Falha parcial não deve destruir lote.

---

# 41. Retry

Permitir retry individual.

Manter:

```text
creative_id
```

e aumentar:

```text
generation_attempt
```

---

# 42. `creative_id`

Todo criativo recebe ID antes de chamar a OpenAI.

Exemplo:

```text
cr_20260912_225501_a8f31c
```

Usar no filename.

---

# 43. Histórico

Registrar:

```text
creative_id
tenant_id
brand_id
product_id(s)
mode
angle
context_id
persona
placement
models
quality
prompt_version
created_at
asset
```

---

# 44. Histórico de cenas

Registrar também:

```text
scene_id
```

Assim o sistema pode:

- evitar repetir última cena;
- priorizar cenas menos utilizadas;
- comparar performance depois.

---

# 45. Performance

Permitir importar CSV.

Métricas:

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

# 46. Associação com Meta

Procurar `creative_id` em:

1. coluna explícita;
2. nome do anúncio;
3. filename;
4. `utm_content`.

Nunca associar apenas por data/produto.

---

# 47. Performance não otimiza geração ainda

Nesta fase:

```text
performance = histórico / análise
```

Não usar automaticamente:

```text
melhor ROAS -> repetir sempre
```

A única automação baseada em histórico:

```text
evitar repetição recente de cena
```

---

# 48. Storage

Não usar disco local/efêmero.

Salvar em storage persistente do painel.

Estrutura lógica:

```text
tenant/{tenant_id}/creatives/{creative_id}/
```

---

# 49. Entidades mínimas

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
creative_performance
```

Reutilizar estrutura existente quando equivalente.

---

# 50. OpenAI usage

Registrar quando disponível:

```text
model
input_tokens
output_tokens
cached_tokens
web_search_used
image_model
image_quality
```

Não usar isso para faturar OpenAI.

Serve para telemetria.

---

# 51. Brand Packs

Transformar configurações específicas existentes em:

```text
BrandPack
```

Exemplo:

```text
use_origens
```

Pode definir:

```text
positioning
visual rules
angle labels
personas
default context provider
prompt blocks
avoid
```

---

# 52. Niche Packs

Criar suporte a:

```text
NichePack
```

Primeiros:

```text
generic_commerce
fashion
```

Não precisa criar dezenas no MVP.

---

# 53. Use Origens no painel

A própria Use Origens deve usar:

```text
BrandPack:
use_origens

NichePack:
fashion

ContextProvider:
geographic
```

Assim o comportamento regional continua funcionando sem contaminar o core.

---

# 54. Entre Nós

Pode futuramente usar:

```text
BrandPack:
entre_nos

NichePack:
family_apparel

ContextProvider:
custom/relationship
```

Mas não precisa fazer parte do MVP do painel.

---

# 55. O que fica exclusivamente local/interno

Manter fora do painel SaaS:

```text
Funil por Criativo
Coleção do Estado
Orgânico
```

Esses modos podem continuar usando:

- estrutura local;
- templates próprios;
- necessidades específicas da Use Origens;
- experimentações internas.

Não apagar nem refatorar obrigatoriamente essas estratégias por causa do SaaS.

---

# 56. Compartilhamento de core

Se possível:

```text
core comum
```

para:

- product handling;
- personas;
- prompt rules;
- context;
- image adapter;
- model router;
- reference handling.

Mas:

```text
estratégias privadas
```

continuam no projeto local.

Não forçar o painel a carregar código desnecessário dos modos internos.

---

# 57. Migração recomendada

## Fase 1 — Infra SaaS

- feature de plano;
- OpenAI BYOK;
- criptografia;
- tenant client;
- storage;
- jobs;
- entidades.

## Fase 2 — Core

- Brand;
- Niche;
- Context;
- produtos;
- personas;
- placements;
- image adapter;
- model router.

## Fase 3 — Ângulos Limpos

Portar totalmente e validar.

## Fase 4 — Multipeça

Portar sobre o mesmo core.

## Fase 5 — Histórico + Performance

- creative_id;
- histórico;
- CSV;
- métricas.

## Fase 6 — refinamentos

- context research;
- UI de packs;
- filtros;
- exportações.

---

# 58. MVP

MVP concluído quando possuir:

- plano/feature;
- OpenAI do cliente;
- Brand Profile;
- Niche Profile;
- Context Intelligence;
- Produtos;
- Personas;
- Ângulos Limpos;
- Multipeça;
- Feed;
- Story;
- Jobs;
- Histórico;
- Download;
- `creative_id`.

Performance pode entrar logo depois se reduzir prazo.

---

# 59. Não fazer

Não:

- migrar Funil Visual;
- migrar Coleção do Estado;
- migrar Orgânico;
- criar código regional dentro do core;
- assumir camiseta;
- assumir estampa;
- assumir cidade;
- usar API Key global;
- guardar key plaintext;
- executar grandes lotes síncronos;
- usar disco local;
- pesquisar contexto toda vez;
- misturar tenant data;
- criar lógica de otimização por ROAS agora.

---

# 60. Critérios de aceite

- [ ] Somente Ângulos Limpos e Multipeça aparecem no painel.
- [ ] Nenhum código SaaS depende dos outros três modos.
- [ ] Feature `creative_generator` controla acesso.
- [ ] Cliente conecta própria API Key.
- [ ] Chave fica criptografada.
- [ ] Todas as chamadas usam client do tenant.
- [ ] Core não depende de cidade/UF.
- [ ] Context Intelligence é genérico.
- [ ] Geographic Provider atende Use Origens.
- [ ] Niche Provider atende clientes não regionais.
- [ ] Ângulos Limpos gera corretamente.
- [ ] Multipeça gera corretamente.
- [ ] Produtos não são limitados a camisetas.
- [ ] Feed funciona.
- [ ] Story funciona.
- [ ] Todo criativo recebe `creative_id`.
- [ ] Histórico é tenant-scoped.
- [ ] Outputs usam storage persistente.
- [ ] Jobs suportam progresso e falha parcial.
- [ ] Model Router é centralizado.
- [ ] Performance pode ser associada ao creative_id.
- [ ] Use Origens consegue usar o mesmo módulo com contexto geográfico.
- [ ] Outro cliente consegue usar sem nenhum conceito regional.

---

# 61. Tarefa inicial do Claude

Antes de modificar código, analisar:

## Painel

- tenants;
- autenticação;
- planos/features;
- integrações;
- encryption;
- jobs;
- storage;
- uploads;
- ORM;
- services;
- frontend routing;
- permissões.

## Gerador local

Analisar especificamente:

```text
Ângulos Limpos
Ângulos Multipeça
```

e dependências compartilhadas necessárias:

- prompts;
- referencias;
- peças;
- personas;
- placements;
- escala;
- cabide;
- context;
- OpenAI;
- copies.

Ignorar como alvo de migração:

```text
Funil por Criativo
Coleção do Estado
Orgânico
```

---

# 62. Entrega antes da implementação

Criar primeiro:

```text
docs/creative-generator-migration-plan.md
```

O documento deve informar:

- quais arquivos do painel serão alterados;
- quais módulos dos dois modos serão portados;
- quais dependências compartilhadas precisam ser extraídas;
- migrations;
- endpoints;
- páginas;
- jobs;
- storage;
- integração OpenAI;
- feature de plano;
- riscos;
- testes;
- fases de implementação.

Após o plano, implementar por etapas.

---

# 63. Princípio final

O produto não deve ser:

```text
um gerador regional simplificado
```

Deve ser:

```text
um gerador genérico de criativos de produto
```

com duas estratégias bem definidas:

```text
1 produto -> Ângulos Limpos
vários produtos -> Multipeça
```

A inteligência de contexto adapta a cena à:

```text
marca
nicho
produto
ângulo
objetivo
histórico
```

A Use Origens é apenas um dos clientes possíveis desse motor.
