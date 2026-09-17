# GENERATOR_HANDOFF_CONTRACT — snapshot no Oria

```text
Source core version:    1.1.0 (schema_version 1)
Source commit:          estamparia-criativos@262756a (espelho) — fonte da verdade agora é services/creative-core neste repositório
Contracts sha256:       dca9529457a43070ac84dffef18cb59829c593d68a6c4bdd33940b58745fd45c (services/creative-core/creative_core/schemas/contracts.d.ts)
Imported/updated at:    2026-09-15
```

## Alterações desde o preenchimento original (Etapa 1)

1. **Local do core:** `services/creative-core/` neste repositório (decisão do usuário em 15/09). Serviço separado no Railway
   (Root Directory `services/creative-core`). O gerador interno mantém espelho verificado por `scripts/check_core_mirror.py`.
2. **core_version 1.1.0** (sem mudança de schema): `GET /v1/contracts` ganhou `catalog` (ângulos, placements, etapas,
   intenções, enums, kits embutidos) e existe `POST /v1/validate/<Contrato>` → `{valid, errors}`.
3. Módulos puros `remarketing`, `cabide`, `regional_context` e o snapshot de `regioes.json`/`cidades.json` agora ficam
   dentro do pacote (`creative_core/domain`, `creative_core/data`).
4. Servidor de produção: gunicorn (`services/creative-core/requirements.txt`, `Procfile`, `gunicorn.conf.py`).

---

## Objetivo

Este documento é o contrato formal entre os dois projetos:

```text
Projeto de origem:
Gerador de Criativos            /Users/gtomazi/projects/estamparia-criativos

Projeto de destino:
Orgulho Regional                /Users/gtomazi/projects/orgulhoregional

Nome do produto SaaS:
Oria
```

Ele deve ser lido antes do início da **Etapa 2**. A função deste arquivo é impedir que o projeto Oria precise "adivinhar" como o Gerador terminou estruturado.

---

# 1. Regra de responsabilidade

## Gerador de Criativos

Responsável por: core criativo (`creative_core/`); estratégias; Brand Kit; Niche Kit; Context Intelligence; Prompt Builder; Model Router; produtos; personas; ângulos; regras de referência; planejamento da geração; contratos de entrada/saída; adaptador HTTP stateless (`creative_core/service.py`).

## Orgulho Regional / Oria

Responsável por: experiência SaaS; multi-tenant; autenticação; planos/features; BYOK (guarda criptografada da key); persistência SaaS (kits, produtos, personas, context profiles, histórico); jobs/fila e retry; storage dos assets; interface; permissões; exposição seletiva das Strategies; deploy e operação do serviço do core.

O core **não** conhece tenant, billing, feature flag, ORM nem storage (verificado por `creative_core/tests/test_core_purity.py`).

---

# 2. Estratégias internas do Gerador — IDs finais

| Canônico (core) | ID interno real (app.py / manifestos / `config/lojas.json`) | Público no Oria |
|---|---|---|
| `FUNNEL_VISUAL` | `FUNIL_VISUAL` | sim |
| `STATE_COLLECTION` | `COLECAO_ESTADO` | não |
| `REMARKETING` | `REMARKETING` | sim |
| `CLEAN_ANGLES` | `ANGULOS_LIMPOS` | sim |
| `MULTI_PRODUCT_INTERNAL` | `ANGULOS_MULTIPECA` | não |
| `ORGANIC` | `ORGANICO` | não |

Fonte: `creative_core/strategies.py` (`STRATEGIES`, `INTERNAL_STRATEGIES`, `SAAS_STRATEGIES`). Os IDs internos **não foram renomeados**. Note a grafia: o spec anterior do handoff citava `FUNIL_VISUAL` como canônico — o canônico é `FUNNEL_VISUAL`; `FUNIL_VISUAL` é o ID interno.

---

# 3. Estratégias públicas do Oria

```text
CLEAN_ANGLES
REMARKETING
FUNNEL_VISUAL
```

O contrato `CreativeRequest.strategy` só aceita esses três valores (enum). `STATE_COLLECTION`, `MULTI_PRODUCT_INTERNAL` e `ORGANIC` são rejeitados com `INVALID_INPUT`.

---

# 4. Regra de Multipeça no Oria

Multipeça **não é Strategy**. É `product_mode`:

```ts
type ProductMode = "single_product" | "multi_product";
```

Regras centrais (`creative_core/strategies.py::MULTI_PRODUCT_RULES`, também em `GET /v1/contracts`):

| Engine | single_product | multi_product | Observação |
|---|---|---|---|
| `CLEAN_ANGLES` | 1 | 2–6 | sem overlay em ambos |
| `REMARKETING` | 1 | **2–5** | ver abaixo |
| `FUNNEL_VISUAL` | 1 | 2–6 | TOFU/MOFU/BOFU |

**Alterações feitas na Etapa 1 (diferenças em relação ao limite recomendado 2–6):**

1. `REMARKETING.max = 5` (não 6): as famílias de layout de remarketing aceitam no máximo 5 produtos (flatlay) e 3 pessoas (multi-modelo). Com 6 produtos o core responde `PRODUCT_COUNT_OUT_OF_RANGE`.
2. Intenções em remarketing multipeça:
   - permitidas: `site_visitor`, `collection_discovery`, `social_proof`, `objection`;
   - `product_view`: **somente single** (`UNSUPPORTED_PRODUCT_MODE`, `reason=single_product_intent`);
   - `cart` / `checkout`: multipeça **somente** quando `remarketing.products_source = "basket"` (os produtos são o carrinho/pedido real). Sem isso: `UNSUPPORTED_PRODUCT_MODE`, `reason=requires_products_source_basket`. Não há proibição rígida para carrinho real com vários itens.
3. Limite recomendado por ângulo (`angle.multi_product_limit`, ex.: `CLOSE_BOLSO = 2`) gera **warning** no plano, não erro — mesmo comportamento do gerador interno.

---

# 5. Regra de Ângulos Limpos

```text
CLEAN_ANGLES = imagem sem overlay promocional
```

Garantias do core (testadas em `test_engines_fixtures.py`):

- `plan.overlay.allowed = false` e todos os campos de overlay nulos/vazios;
- `CreativeRequest.funnel` ou `CreativeRequest.remarketing` enviados com `CLEAN_ANGLES` → `INVALID_INPUT` (o pedido nunca é "silenciosamente limpo");
- `plan.funnel_stage = null`; TOFU/MOFU/BOFU vivem em `plan.copy.funnel_stages` e em `POST /v1/copies`;
- validação `clean_angles_has_no_overlay` precisa passar ou o plano não é emitido (`PROMPT_BUILD_FAILED`).

---

# 6. Contratos expostos

Todos definidos em `creative_core/contracts.py` (fonte única) e exportados para:

- JSON Schema draft 2020-12: `creative_core/schemas/<Contrato>.schema.json`
- TypeScript: `creative_core/schemas/contracts.d.ts`
- Runtime: `GET /v1/contracts` → `schemas`

Regenerar: `venv/bin/python -m creative_core.contracts` (um teste falha se os arquivos divergirem do código).

Convenção de nomes: `BrandKit`, `NicheKit`, `ContextProfile`, `CreativeProduct` usam **camelCase** (literal do spec da Etapa 1). Os demais contratos (request, plan, result, persona, record…) usam **snake_case** (mesmos nomes dos campos de persistência do spec da Etapa 2). Todo contrato **rejeita campos desconhecidos**.

| Contrato | Arquivo de origem | Versão |
|---|---|---|
| BrandKit | `contracts.py` · kits em `creative_core/kits/brand/*.json` | `schemaVersion 1` + `version` do kit |
| NicheKit | `contracts.py` · kits em `creative_core/kits/niche/*.json` | `schemaVersion 1` + `version` |
| ContextProfile | `contracts.py` · `context_intelligence.py` | `schemaVersion/promptVersion/profileVersion` |
| CreativeProduct | `contracts.py` · `products.py` | schema 1 |
| Persona | `contracts.py` · `personas.py` | schema 1 |
| Angle | `contracts.py` · `angles.py` + `templates/angles.json` | schema 1 |
| Placement | `contracts.py` · `placements.py` | schema 1 |
| ProductMode | `contracts.PRODUCT_MODES` | schema 1 |
| CreativeRequest | `contracts.py` | schema 1 |
| CreativePlan | `contracts.py` · `engines.plan_creative` | schema 1 |
| CreativeResult | `contracts.py` · `engines.generate_creative` | schema 1 |
| GenerationError | `contracts.py` · `errors.py` | schema 1 |
| GenerationRecord | `contracts.py` · `history.py` | schema 1 |
| CopyVariant | `contracts.py` · `engines.generate_copy` | schema 1 |

---

# 7. Brand Kit

```text
Arquivo:            creative_core/contracts.py (CONTRACTS["BrandKit"]), creative_core/kits.py
Kits embutidos:     creative_core/kits/brand/use_origens.json
schema_version:     1 (campo schemaVersion)
Obrigatórios:       id, name, schemaVersion, version
Opcionais:          description, positioning[], audience[], tone[], visualStyle[], colors[],
                    typographyNotes[], preferredContexts[], avoid[], manualNotes[],
                    enabledAngles[AngleId], angleLabels{AngleId: string}, headlineStyle[], ctaStyle[],
                    strategyRules{}, defaultNicheKitId, defaultContextProvider (geographic|niche|custom),
                    suggestedPersonas[Persona]   ← extensão: pool de personas sugerido pela marca
Enums:              enabledAngles ⊂ AngleId; defaultContextProvider
```

Uso no request: `brand_kit` (inline, kit do tenant) **ou** `brand_kit_id` (kit embutido). O Oria deve enviar inline os kits do tenant. `enabledAngles` vazio/ausente = todos os ângulos.

Exemplo real (resumo de `use_origens.json`):

```json
{
  "id": "use_origens",
  "name": "Use Origens",
  "positioning": ["regional contemporâneo", "premium acessível", "não souvenir"],
  "tone": ["emocional", "direto", "elegante", "regional sem caricatura"],
  "visualStyle": ["editorial", "clean", "natural", "lifestyle", "premium"],
  "colors": ["#4d543d", "#d6ba8d", "#1a1e14", "#f4efe6"],
  "avoid": ["caricatura regional", "excesso de símbolos", "souvenir turístico", "excesso de texto"],
  "angleLabels": {"IDENTIDADE_ORIGEM": "Identidade / Origem", "PRODUTO_ESTAMPA": "Flatlay"},
  "defaultNicheKitId": "fashion",
  "defaultContextProvider": "geographic",
  "schemaVersion": 1,
  "version": 1
}
```

Kit de cliente não regional (inline, do fixture `fixture-remarketing-multi`):

```json
{"id": "fitness_brand_x", "name": "Fitness Brand X", "positioning": ["roupa de treino que acompanha a rotina"],
 "visualStyle": ["energia", "luz dura de manhã", "contraste"], "defaultContextProvider": "custom",
 "schemaVersion": 1, "version": 1}
```

---

# 8. Niche Kit

```text
Arquivo:            creative_core/contracts.py (CONTRACTS["NicheKit"]), creative_core/kits.py
Kits embutidos:     generic_commerce, fashion (creative_core/kits/niche/)
schema_version:     1
Obrigatórios:       id, name, schemaVersion, version
Opcionais:          audienceBehaviors[], commonUsageScenarios[], activities[], sceneContexts[], materials[],
                    visualCliches[], avoid[], recommendedAngles[AngleId], strategyRules{},
                    angleLabels{}, productTypes[], supportsApparelAngles (bool), suggestedPersonas[]
Resolução:          niche_kit inline > niche_kit_id > brand.defaultNicheKitId > "generic_commerce"
```

Extensões em relação ao spec: `angleLabels`, `productTypes`, `supportsApparelAngles`, `suggestedPersonas`. `supportsApparelAngles=false` torna `CABIDE`, `CAIMENTO`, `CLOSE_ESTAMPA`, `CLOSE_BOLSO` indisponíveis (`UNSUPPORTED_ANGLE`).

Exemplo real (resumo de `generic_commerce.json`):

```json
{
  "id": "generic_commerce",
  "name": "Comércio genérico",
  "sceneContexts": ["bancada ou mesa de madeira clara com luz natural lateral", "sala de estar contemporânea e organizada"],
  "materials": ["textura real do material do produto", "embalagem discreta"],
  "avoid": ["produto distorcido ou com proporção irreal", "logotipos de terceiros visíveis"],
  "recommendedAngles": ["PRODUTO_ESTAMPA", "LIFESTYLE_COTIDIANO", "PREMIUM_ESTILO", "PRESENTE_AFETO", "CREATOR_STYLE"],
  "supportsApparelAngles": false,
  "schemaVersion": 1,
  "version": 1
}
```

---

# 9. Context Profile

```text
Arquivo:            creative_core/contracts.py (ContextProfile), creative_core/context_intelligence.py
Providers:          GeographicContextProvider   (config/regioes.json + config/cidades.json; 14 UFs Sul/CO/Norte)
                    NicheContextProvider        (Niche Kit + brand.preferredContexts)
                    CustomContextProvider       (profile do tenant; só status "approved")
contextType:        geographic | niche | custom | bond | neutral
Seleção (request):  context = {mode: automatic|geographic|niche|custom, profile?, subject?, context_id?}
```

Diferenças de implementação a respeitar no Oria:

- **Geográfico nunca adivinha.** Sem `context_id` explícito ou perfil de cidade com `regional_context_id`, o provider devolve "não resolvido". Hoje **nenhuma cidade** em `config/cidades.json` tem `regional_context_id`, então para Use Origens o Oria deve enviar `context_id` (ex.: `vale_europeu`) quando quiser contexto regional.
- `mode=geographic` não resolvido → `CONTEXT_RESOLUTION_FAILED`. `mode=automatic` não resolvido → usa o nicho e adiciona o warning `geographic_context_unresolved_used_niche_context`.
- Profile `draft`/`rejected` nunca entra em prompt (`CONTEXT_RESOLUTION_FAILED`, `reason=profile_not_approved`). Sugestões de IA devem ser salvas como `draft` e aprovadas por humano no Oria.
- A escolha da cena é determinística (`seed`) e evita as cenas de `history_hints.recent_scenes`.
- O plano carrega o contexto resolvido como `ResolvedContext` (`context_id`, `context_type`, `provider`, `scene`, `supporting_element`, `avoid[]`, `status`, `profile_version`).

---

# 10. Product Contract

```text
Arquivo:            creative_core/contracts.py (CreativeProduct), creative_core/products.py
Tipo:               { id*, brandId?, name*, type*, description?, referenceImages*[1..4], metadata? }
Reference Images:   strings OPACAS (ex.: storage key do tenant). O core não baixa URLs.
                    Os bytes são enviados na geração (POST /v1/generations → references[{ref, data_base64}]).
                    Aceitos: PNG, JPEG, WebP (magic bytes), ≤ 10 MB cada, ≤ 10 imagens por criativo.
Metadata:           livre. Chaves lidas pelo core: city/cidade, state/uf (contexto geográfico automático).
```

O contrato público **não assume camiseta**: `type` é texto livre. Quando `type` corresponde a uma peça do catálogo de vestuário (`products.py::PECAS` ou aliases como `camiseta`, `hoodie`, `regata`), o core acrescenta a regra de preservação da peça e as regras de estampa impressa.

Produtos repetidos (mesmo `id`) → `INVALID_PRODUCT`.

---

# 11. Persona Contract

```text
Arquivo:            creative_core/contracts.py (Persona), creative_core/personas.py
Campos:             id?, label*, age_range?, appearance?, style?, behavior?, notes?, source? (automatic|custom)
Automática:         persona_mode="automatic" (padrão) → brand.suggestedPersonas > niche.suggestedPersonas >
                    pool padrão do core; rotação por seed evitando history_hints.recent_personas
Custom:             persona_mode="custom" + persona{...} (validada; source forçado para "custom")
Nenhuma:            persona_mode="none"
```

Ângulos/layouts sem pessoa ignoram persona (`plan.persona = null`). Em multipeça com pessoas, o plano usa a persona principal + rotação do pool para as demais (listadas no prompt).

As personas estruturadas do gerador interno (`config/personas_cena.json`) **não** fazem parte do contrato público.

---

# 12. Angle Contract

IDs finais (estáveis, iguais aos do gerador interno):

```text
IDENTIDADE_ORIGEM  LIFESTYLE_COTIDIANO  ORGULHO_DISCRETO  PERTENCIMENTO  NOSTALGIA_ORIGEM
CABIDE  PRODUTO_ESTAMPA  CAIMENTO  CLOSE_ESTAMPA  CLOSE_BOLSO  PREMIUM_ESTILO  CREATOR_STYLE  PRESENTE_AFETO
```

`Angle` no plano: `{id, label, description, uses_person, apparel_only, multi_product_limit}`. Rótulo: `brand.angleLabels` > `niche.angleLabels` > rótulo genérico do core (`templates/angles.json`). Sem diferenças de ID.

Ângulos só de vestuário (`apparel_only=true`): `CABIDE`, `CAIMENTO`, `CLOSE_ESTAMPA`, `CLOSE_BOLSO`.

---

# 13. CreativePlan

```text
Arquivo:            creative_core/engines.py
Função que produz:  plan_creative(request: CreativeRequest, *, router=None, geographic=None) -> CreativePlan
HTTP:               POST /v1/plans  {"request": CreativeRequest} -> {"plan": CreativePlan}
Schema:             creative_core/schemas/CreativePlan.schema.json
Determinismo:       mesmo request (com creative_id e seed) → mesmo plano, byte a byte.
                    Sem creative_id o core gera um UUID v4. Sem seed, a semente é derivada do request.
```

Campos: `plan_id`, `creative_id`, `schema_version`, `strategy`, `internal_strategy_id`, `product_mode`, `products[]`, `angle`, `placement`, `persona|null`, `context`, `brand_kit{id,version}`, `niche_kit{id,version}`, `funnel_stage|null`, `remarketing_intent|null`, `layout|null`, `overlay`, `copy{generate, funnel_stages[]}`, `references[{ref, product_id, role, order}]`, `prompt{text, sections[{name,length}], sha256, prompt_version}`, `model{task, model, quality, size}`, `versions{}`, `validations[{rule, passed}]`, `warnings[]`.

Exemplo (fixture `fixture-remarketing-multi`, prompt e listas encurtados):

```json
{
  "plan_id": "plan_1ac1b7630488fea2b893764a",
  "creative_id": "44444444-4444-4444-8444-444444444444",
  "schema_version": 1,
  "strategy": "REMARKETING",
  "internal_strategy_id": "REMARKETING",
  "product_mode": "multi_product",
  "angle": {"id": "PRODUTO_ESTAMPA", "label": "Flatlay", "uses_person": false, "apparel_only": false, "multi_product_limit": 6},
  "placement": {"id": "FEED_4X5", "label": "Feed (4:5 — 1080×1350)", "width": 1080, "height": 1350, "api_size": "1088x1360"},
  "persona": null,
  "context": {"context_id": "ctx-studio-treino", "context_type": "custom", "provider": "custom",
              "scene": "piso emborrachado cinza de estúdio funcional com luz lateral", "supporting_element": null,
              "avoid": ["academia lotada", "..."], "status": "approved", "profile_version": 2},
  "brand_kit": {"id": "fitness_brand_x", "version": 1},
  "niche_kit": {"id": "fashion", "version": 1},
  "funnel_stage": "MOFU",
  "remarketing_intent": "collection_discovery",
  "layout": "flatlay_grid",
  "overlay": {"allowed": true, "headline": "Não achou o seu ainda?", "subheadline": "Várias opções disponíveis",
              "cta": "Ver todas →", "badges": [], "benefits": [], "search_bar_text": null, "chips": [],
              "text_density": "balanced", "cta_emphasis": "medium", "clean": false},
  "copy": {"generate": false, "funnel_stages": ["MOFU"]},
  "references": [{"ref": "fit/p/top-azul.png", "product_id": "top-azul", "role": "product_art", "order": 1}],
  "prompt": {"text": "REGRAS OBRIGATÓRIAS (nunca ignore): …", "sections": [{"name": "core_rules", "length": 685}],
             "sha256": "e00a71a2…", "prompt_version": 1},
  "model": {"task": "image_generation", "model": "gpt-image-2", "quality": "medium", "size": "1088x1360"},
  "validations": [{"rule": "remarketing_multi_product_allowed_for_intent", "passed": true}],
  "warnings": []
}
```

`plan.prompt.text` é conteúdo interno sensível do produto: o Oria pode persistir o `sha256` e as `sections`, mas **não deve expor o prompt completo ao usuário final**.

---

# 14. CreativeResult

```text
Arquivo:            creative_core/engines.py
Função:             generate_creative(plan, *, client, references: {ref: bytes}, router=None, attempt=1) -> CreativeResult
HTTP:               POST /v1/generations {"plan", "references":[{ref, data_base64}], "openai_api_key", "generation_attempt"?}
                    -> {"result": CreativeResult}
Schema:             creative_core/schemas/CreativeResult.schema.json
Asset:              {mime_type:"image/png", width, height, byte_size, sha256, data_base64}  (já no tamanho final do placement)
Metadata:           strategy, internal_strategy_id, product_mode, product_ids[], angle, placement, funnel_stage,
                    remarketing_intent, layout, context_id, persona, brand_kit{}, niche_kit{}, model, quality, prompt_sha256
```

`generate_creative` **nunca lança**: falha vira `status="failed"`, `asset=null`, `error=GenerationError`.

Exemplo:

```json
{
  "creative_id": "44444444-4444-4444-8444-444444444444",
  "plan_id": "plan_1ac1b7630488fea2b893764a",
  "status": "completed",
  "generation_attempt": 1,
  "asset": {"mime_type": "image/png", "width": 1080, "height": 1350, "byte_size": 7347,
            "sha256": "0aeaa962…", "data_base64": "iVBORw0KGgo…"},
  "metadata": {"strategy": "REMARKETING", "product_mode": "multi_product",
               "product_ids": ["top-azul", "top-verde", "legging-preta", "shorts-cinza"],
               "angle": "PRODUTO_ESTAMPA", "placement": "FEED_4X5", "funnel_stage": "MOFU",
               "remarketing_intent": "collection_discovery", "layout": "flatlay_grid", "model": "gpt-image-2"},
  "versions": {"core_version": "1.0.0", "schema_version": 1, "prompt_version": 1, "strategy_version": 1},
  "error": null,
  "created_at": "2026-09-14T20:00:00+00:00"
}
```

---

# 15. APIs / funções públicas

| Função / API | Arquivo | Entrada | Saída | Erros | Sync/Async |
|---|---|---|---|---|---|
| `plan_creative` · `POST /v1/plans` | `engines.py` | `CreativeRequest` | `CreativePlan` | `GenerationError` (HTTP 422 validação / 400 contexto) | sync, sem chamada ao provedor |
| `generate_creative` · `POST /v1/generations` | `engines.py` | `CreativePlan` + refs + key | `CreativeResult` | dentro do result (HTTP 200); 422 para referência inválida; 400 key malformada | sync, 1 chamada `images.edit` (dezenas de segundos) |
| `generate_copy` · `POST /v1/copies` | `engines.py` | `CreativeRequest` + key | `{variants: CopyVariant[]}` | `GenerationError` | sync, 1 chamada `responses.create` |
| `GET /v1/contracts` | `service.py` | — | estratégias, product modes, regras multipeça, matriz, modelos, JSON Schemas | 401 | sync |
| `GET /v1/health` | `service.py` | — | status + versões | — | sync, sem auth |
| `build_record` / `record_from_plan` | `history.py` | plano (+ asset) | `GenerationRecord` | — | sync |

Autenticação do serviço: `Authorization: Bearer <CREATIVE_CORE_SERVICE_TOKEN>` (≥ 32 caracteres, comparação em tempo constante).

---

# 16. Estratégia de integração entre projetos

Opções avaliadas: A (pacote compartilhável), B (serviço/API), C (adaptação por contrato).

# 17. Decisão de integração

```text
Abordagem escolhida:
B — serviço/API. O Oria (Node) chama o core Python por HTTP server-to-server, com contratos em JSON Schema.

Motivo:
- Linguagens/runtime: Gerador = Python 3.12 (Streamlit, Pillow); Oria = Node/Express (server.js) + React/TS.
  Não há como importar o core Python no Node sem embutir um runtime Python no deploy do painel.
- Não duplicar lógica: prompts, regras de multipeça, contexto e kits ficam num lugar só; o Oria só
  orquestra (tenant, BYOK, jobs, storage, UI).
- Segurança: serviço stateless, sem banco, sem storage, sem key persistida; recebe a key do tenant por
  requisição e não a registra; referências só inline (sem SSRF); auth por token de serviço.
- Deploy: Railway já hospeda os dois projetos; o core vira um segundo serviço Python independente do
  app Streamlit (mesmo repositório do Gerador, entrypoint diferente).
- Acoplamento: só por contrato versionado (schema_version / core_version) + GET /v1/contracts.

Alternativas rejeitadas:
- A (pacote): stacks incompatíveis (Python × Node); exigiria processo Python filho dentro do Node —
  mesmo custo operacional de B, sem isolamento.
- C (adapter reimplementado em TS): duplicaria prompt builder, regras de remarketing/multipeça e
  contexto; divergência silenciosa garantida a cada ajuste de prompt.

Riscos:
- Latência: geração síncrona leva dezenas de segundos → o Oria DEVE chamar /v1/generations de dentro
  de um job (nunca na requisição do navegador) e configurar timeout ≥ 180 s.
- Disponibilidade: o serviço vira dependência de runtime do módulo de criativos (health check + retry
  com backoff no job; erros `retryable` do contrato).
- Servidor HTTP: o adaptador é WSGI stdlib; `python -m creative_core.service` usa wsgiref (desenvolvimento).
  Produção precisa de um servidor WSGI (ex.: gunicorn) — dependência ainda NÃO adicionada ao projeto
  (decisão de deploy da Etapa 2).
- Payload: imagens em base64 no JSON (limite de corpo 60 MB); para lotes grandes, 1 chamada por criativo.
- Geração real com gpt-image-2 através do core NÃO foi executada na Etapa 1 (sem autorização de custo e
  sem rede no ambiente de teste) — coberta por test doubles; validar com 1 chamada real no início da Etapa 2.

Versionamento:
- core_version (semver) + schema_version (inteiro). Mudança incompatível de contrato → schema_version+1
  e rota /v2. O Oria deve checar GET /v1/contracts na inicialização e recusar schema_version desconhecido.
- A cópia do contrato no Oria (docs/creative-generator/GENERATOR_HANDOFF_CONTRACT.md) registra
  core_version e o sha256 de creative_core/schemas/contracts.d.ts.
```

---

# 18. Versionamento

```text
core_version:            1.0.0
schema_version:          1
prompt_version:          1   (templates dos motores públicos: creative_core/templates/*.json)
brand_kit_version:       por kit (campo version; use_origens = 1). Schema do kit: 1
niche_kit_version:       por kit (generic_commerce = 1, fashion = 1). Schema do kit: 1
context_profile_version: por profile (profileVersion); schema 1, promptVersion 1
clean_angles_version:    1
remarketing_version:     1
funnel_visual_version:   1
```

Fonte: `creative_core/versions.py` (`version_manifest()`), repetido em `plan.versions` e `result.versions`. O Oria deve persistir no histórico do criativo: `brand_kit_version`, `niche_kit_version`, `prompt_version`, `context_profile_version`, `strategy_version`, `core_version`, `schema_version`.

Gerador interno: `INTERNAL_PROMPT_BANK_VERSION = 1` (bancos `ads/templates`, `lojas/*/templates`), gravado no histórico local.

---

# 19. Error Contract

Fonte: `creative_core/errors.py` (`ERROR_CATALOG`). Formato: `{code, message, retryable, cause, details}`. `message` é segura para o usuário final; `details` só contém nomes de campo, limites e ids.

| code | mensagem segura | retryable | causa |
|---|---|---|---|
| `INVALID_INPUT` | A requisição tem campos inválidos. | não | validation |
| `INVALID_PRODUCT` | Produto inválido ou incompleto. | não | validation |
| `INVALID_REFERENCE` | Imagem de referência ausente ou em formato não suportado. | não | validation |
| `UNSUPPORTED_STRATEGY` | Estratégia não disponível. | não | validation |
| `UNSUPPORTED_ANGLE` | Ângulo não disponível para esta marca, nicho ou estratégia. | não | validation |
| `UNSUPPORTED_PRODUCT_MODE` | Modo de produto não suportado para esta combinação. | não | validation |
| `PRODUCT_COUNT_OUT_OF_RANGE` | Quantidade de produtos fora do limite permitido. | não | validation |
| `INVALID_KIT` | Brand Kit ou Niche Kit inválido. | não | validation |
| `CONTEXT_RESOLUTION_FAILED` | Não foi possível resolver o contexto da cena. | não | context |
| `PROMPT_BUILD_FAILED` | Não foi possível montar o plano do criativo. | não | internal |
| `MODEL_AUTHENTICATION_FAILED` | A credencial do provedor de IA foi recusada. | não | provider_auth |
| `MODEL_RATE_LIMITED` | Limite de uso do provedor de IA atingido. Tente novamente em instantes. | sim | provider_rate_limit |
| `MODEL_UNAVAILABLE` | Provedor de IA indisponível no momento. | sim | provider_unavailable |
| `CONTENT_POLICY_REJECTED` | O provedor de IA recusou gerar este conteúdo. | não | provider_policy |
| `GENERATION_FAILED` | Falha ao gerar o criativo. | sim | provider_error |
| `ASSET_PROCESSING_FAILED` | Falha ao processar a imagem gerada. | sim | asset |

Erros do provedor são classificados por **tipo e status HTTP**, nunca pela mensagem (que pode ecoar a API key). Testado: key presente na mensagem da exceção não aparece no resultado nem na resposta HTTP. Erros inesperados do serviço → HTTP 500 com `GENERATION_FAILED`, sem stack trace. Erros de auth/rota do serviço usam `UNAUTHORIZED` / `NOT_FOUND` (fora do catálogo do core, só HTTP).

---

# 20. Async / Jobs

- O core gera **síncrono**: 1 plano → 1 chamada de imagem → 1 resultado. Não retorna task nem stream.
- `plan_creative` é barato e sem rede: o Oria pode planejar na requisição (pré-visualização, validação de formulário) e enfileirar só a geração.
- **O Oria precisa envolver `/v1/generations` em job** e é dono do lifecycle (`queued → planning → generating → processing → completed | partial | failed | cancelled`).
- Retry individual: reenviar o mesmo `plan` com `generation_attempt` incrementado; `creative_id` é preservado.
- Lote = N planos independentes. Falha parcial não afeta os demais.
- O SDK é instanciado com `max_retries=0` no serviço: a política de retry é do job do Oria (use `error.retryable`).

---

# 21. Assets

O core retorna **bytes em base64** do PNG final (já recortado/redimensionado para o placement) + `mime_type`, `width`, `height`, `byte_size`, `sha256`. Não retorna URL, path nem arquivo temporário e não grava nada em disco no modo serviço.

O Oria deve mover o asset para o storage do tenant (`tenant/{tenant_id}/creatives/{creative_id}/`) e persistir o `sha256`. Storage do Gerador (`outputs/`, disco efêmero do Railway) ≠ storage do Oria.

---

# 22. OpenAI / credenciais

- O core **não lê `OPENAI_API_KEY`** nem `.env` (teste de pureza garante).
- `generate_creative(plan, client=...)` / `generate_copy(request, client=...)` recebem um client pronto (formato do SDK OpenAI: `images.edit`, `responses.create`).
- No serviço: o Oria envia `openai_api_key` no corpo JSON de `/v1/generations` e `/v1/copies`, via TLS, server-to-server. O serviço cria um client só para aquela requisição (`OpenAI(api_key=..., max_retries=0)`), não guarda, não loga e não devolve a key.
- Fluxo alvo:

```text
Oria resolve a credencial BYOK do tenant (descriptografa só no backend, no worker do job)
↓
chama o serviço do core com a key no corpo (nunca em query string, header customizado ou log)
↓
core gera e descarta a key
```

- Model Router (`creative_core/model_router.py`): tarefa → modelo. Padrões `gpt-image-2` (imagem) e `gpt-5.6` (texto); overrides `OPENAI_IMAGE_MODEL`, `OPENAI_TEXT_MODEL`, fallbacks `*_FALLBACKS` (só para modelo inexistente/404). Modelos em uso aparecem em `GET /v1/contracts → models`.
- O gerador interno continua usando o client global com `OPENAI_API_KEY` do `.env` (uso interno, não SaaS).

---

# 23. Test Fixtures

Pasta: `creative_core/fixtures/` — executadas por `creative_core/tests/test_engines_fixtures.py`.

| Fixture | Engine | Modo | Destaque |
|---|---|---|---|
| `fixture-clean-single.json` | CLEAN_ANGLES | single | Use Origens + contexto geográfico explícito |
| `fixture-clean-multi.json` | CLEAN_ANGLES | multi (3) | cliente não regional inline + generic_commerce + copy |
| `fixture-remarketing-single.json` | REMARKETING | single | product_view → single_hanger, BOFU |
| `fixture-remarketing-multi.json` | REMARKETING | multi (4) | collection_discovery → flatlay_grid, Context Profile custom |
| `fixture-funnel-tofu-single.json` | FUNNEL_VISUAL | single | TOFU, contexto automático caindo no nicho (warning) |
| `fixture-funnel-mofu-multi.json` | FUNNEL_VISUAL | multi (3) | MOFU com chips e barra de busca, produto com 2 referências |
| `fixture-funnel-bofu-single.json` | FUNNEL_VISUAL | single | BOFU, persona custom, benefícios e badges, Story |

Cada fixture contém: `input` (CreativeRequest), `expected_plan` (caminhos pontuados → valor), `expected_output` (campos do CreativeResult), `validations` (regras que devem passar), `prompt_must_contain` / `prompt_must_not_contain`.

---

# 24. Compatibility Matrix

| Engine | Single | Multi | Headline na imagem | Funnel visual | Copy externa |
|---|---|---|---|---|---|
| CLEAN_ANGLES | Sim | Sim (2–6) | Não | Não | Opcional (`/v1/copies`) |
| REMARKETING | Sim | Quando aplicável (2–5; ver §4) | Sim | Etapa derivada da intenção (override `stage_override`) | Opcional |
| FUNNEL_VISUAL | Sim | Sim (2–6) | Sim | TOFU/MOFU/BOFU | Opcional |

Variações da implementação final: máximo 5 no remarketing; TOFU descarta badges, chips e barra de busca; benefícios, badges, chips e prova social **nunca têm valor padrão** (só entram se informados — nada de claim inventado).

---

# 25. Handoff checklist — Gerador

- [x] Etapa 1 validada — `docs/creative-generator/01-core-validation-report.md`.
- [x] 6 Strategies internas preservadas (UI, IDs, prompts byte a byte — teste de equivalência).
- [x] 3 Strategies públicas identificadas.
- [x] ProductMode documentado.
- [x] Contracts documentados (JSON Schema + TS gerados do código).
- [x] Versions documentadas.
- [x] Integração escolhida (B — serviço/API).
- [x] Error Contract documentado.
- [x] Fixtures criadas (7).
- [x] Build passa — `compileall` (o projeto não tem bundler).
- [ ] Typecheck passa — **não executado**: não há typechecker no projeto nem instalado, e o ambiente não tem rede para instalar (ver relatório). Substituído por validação de contrato em runtime + compileall + varredura de nomes.
- [~] Testes relevantes passam — 25 suítes; 23 verdes. As 2 vermelhas são **pré-existentes e não relacionadas**: `test_ui_lojas` (1 teste desatualizado em relação à UI de personas) e `test_celular_em_cena` (flaky por construção, ~35% de falha). Detalhes no relatório.
- [x] Relatório da Etapa 1 concluído.

---

# 26. Acceptance checklist — Oria

Antes de começar implementação:

- [ ] Este documento foi lido.
- [ ] Versão do core identificada (`GET /v1/contracts`).
- [ ] Método de integração confirmado (serviço/API).
- [ ] Contracts disponíveis (schemas + `contracts.d.ts` copiados/snapshot).
- [ ] Fixtures executáveis/disponíveis.
- [ ] Não há dependência de Strategies internas exclusivas.
- [ ] Multipeça é ProductMode.
- [ ] CLEAN_ANGLES permanece sem overlay.

---

# 27. Local canônico do documento

Canônico: **Gerador de Criativos** → `docs/saas/SAAS_HANDOFF_CONTRACT_ORIA.md` (este arquivo).

No **Orgulho Regional**, cópia/snapshot em `docs/creative-generator/GENERATOR_HANDOFF_CONTRACT.md` com:

```text
Source core version:    1.0.0 (schema_version 1)
Source commit:          n/a — o projeto Gerador não é um repositório Git; use o sha256 de
                        creative_core/schemas/contracts.d.ts como identificador do snapshot
Imported/updated at:    <data da importação>
```

---

# 28. Nomenclatura

Projeto/repositório: `Orgulho Regional`. Nome de produto: `Oria` (UI e documentação voltada ao cliente). Em paths/repositório/infra existente: preservar `Orgulho Regional` até decisão formal de renomear.
