# Creative Generator V2 — Relatório de auditoria (rodada 1)

Data: 2026-09-21 · Branch: `fix/loja-uuid-em-pedidos` · Escopo: **somente leitura**. Nenhum código de produto foi alterado, nenhuma chamada paga à OpenAI foi feita, sem push/deploy.
Spec de origem: [`creative-generator-v2.md`](./creative-generator-v2.md).

## 0. Resumo executivo

1. **Não achei um parâmetro de transporte que explique a regressão.** Modelo (`gpt-image-2`), endpoint (`images.edit`), tamanho (`1088x1360` → crop para 1080×1350), qualidade padrão (`medium`), função de crop, ordem das referências, ausência de compressão no navegador/Node: tudo igual ou equivalente ao gerador local.
2. **Achei duas divergências concretas e uma lacuna de observabilidade:**
   - **D1 — banco de prompts diferente (alta relevância).** O "local" é o Streamlit (`../estamparia-criativos`), que usa bancos de templates longos e iterados. O serviço atual (`oria-creatives`) usa os "motores públicos" do core, com **um banco genérico de 1–2 frases por ângulo**, que o próprio backlog registra como **nunca validado visualmente** (`B-009`). Nos ângulos com pessoa, a cena ocupa ~6% do prompt e faltam os controles de pose/braços/mãos que o local tinha.
   - **D2 — referências sem normalização (impacto desconhecido).** O local reencoda toda referência para PNG (`converter_para_png`). O serviço atual repassa os bytes originais (JPEG/WebP) rotulados como `reference_N.png`.
   - **D3 — não dá para provar hoje qual modelo respondeu.** `metadata.model` grava o modelo **pedido**, não o que serviu (o router tem fallback por env). Também não há duração, parâmetros efetivos nem trace por tentativa.
3. **Nenhuma das duas bases tem regra explícita de anatomia** ("cinco dedos" etc.). Portanto a regressão não vem de "perdemos a regra de dedos"; vem de **composição menos controlada** (D1) e possivelmente de **entrada de imagem diferente** (D2). Isso confirma o alerta do spec: mais texto negativo não é o caminho.
4. **Não consigo atribuir causa com certeza sem A/B.** Proponho um experimento de 4 braços (§1.5). Ele custa chamadas reais e precisa da sua autorização.
5. **Recomendação de início:** Fase A em três passos pequenos — trace, normalização de referências (atrás de flag), e portar para o core as diretivas de pose validadas do Streamlit como `PROMPT_VERSION=2` só para ângulos com pessoa (atrás de flag), medindo por A/B. Só depois CreativePlan v2 (§12).

O que **não** consegui verificar: variáveis de ambiente e logs de produção do `oria-creatives` (a leitura via Railway CLI foi bloqueada pelo classificador de permissões; não contornei). Ver §1.6.

---

## 1. Diagnóstico da regressão: local × atual

### 1.1 O que é "local" e o que é "atual"

| | Local (baseline) | Atual (regressão) |
|---|---|---|
| Código | `/Users/gtomazi/projects/estamparia-criativos` (Streamlit, `app.py`, repo separado; ver `AGENT_WORKSPACE_MAP.md`) | `apps/panel` (Node) → `apps/creative-generator` (Python, serviço `oria-creatives`) |
| Chamada ao modelo | `gerar_imagem()` em `app.py:1288` | `generate_creative()` em `engines.py:567` |
| Prompt | Bancos por loja/modo: `ads/templates/*.json`, `lojas/entre_nos/templates/*.json`, `organico/`, montados por `montar_prompt_*` | Motores públicos `CLEAN_ANGLES`/`REMARKETING`/`FUNNEL_VISUAL`; bancos genéricos `templates/angles.json` + `communication.json` |
| Chave OpenAI | `OpenAI()` global (env) | BYOK por tenant, cliente novo por requisição |

`creative_core` do Streamlit é um espelho do core do Oria (`diff -rq`: só `engines.py`/`service.py` diferem, e apenas por contabilidade de `usage`). **O core é o mesmo; o que muda é qual banco de prompts cada lado usa.** O docstring de `engines.py:1-10` diz isso: *"The internal strategies (app.py) keep their own prompt banks; these engines use the product-agnostic templates."*

### 1.2 Tabela de comparação

| Item | Local (Streamlit) | Atual (Oria) | Igual? | Afeta anatomia | Afeta fidelidade | Afeta composição |
|---|---|---|---|---|---|---|
| Provider | OpenAI | OpenAI (BYOK) | sim | – | – | – |
| Modelo | `MODEL_ROUTER.model_for(imagem)` → `gpt-image-2` (env `OPENAI_IMAGE_MODEL` opcional) | idem (`model_router.py:29`); override/fallback por env no serviço | **sim no código; prod não verificado** | possível | possível | possível |
| Endpoint | `client.images.edit` multipart | `client.images.edit` multipart | sim | – | – | – |
| Qualidade | UI `low/medium/high`, padrão `medium` | `requests.js:60` padrão `medium`; UI `GerarTab.tsx:72` `medium` | sim | – | – | – |
| Tamanho pedido | Feed `1088x1360`, Story `1024x1824` | idem (`placements.py`, mesma tabela) | sim | – | – | – |
| Pós-processo | `redimensionar_cover` → 1080×1350 / 1080×1920 | idem (`assets.asset_from_provider_b64`) | sim | – | – | – |
| Formato de saída | PNG base64 | PNG base64 | sim | – | – | – |
| Nº de refs | 1 arte (+ apoio opcional com bloco de papéis) | todas as refs do produto, até 10 (`references.reference_roles`) | **diferente** | baixo | médio | baixo |
| Ordem das refs | ordem de upload; apoio depois | produto a produto, na ordem de cadastro; declarada no prompt ("imagem N") | equivalente | – | – | – |
| Transformação da ref | `converter_para_png` → PNG em memória | **bytes originais**, `BytesIO.name="reference_N.png"` (`engines.py:595`) | **diferente (D2)** | desconhecido | desconhecido | – |
| Compressão no cliente/Node | n/a | nenhuma: browser só lê arquivo, Node grava bytes (`storage.js:saveProductReference`) | sim | – | – | – |
| Prompt-base | Template do ângulo (900–1150 chars) + regras + zero-texto | Bloco do ângulo (255–309 chars) dentro de ~4.100 chars | **diferente (D1)** | **alto** | médio | **alto** |
| System instructions | não há (só `prompt`) | não há | sim | – | – | – |
| Wrappers do backend | `montar_regras_fixas` + `REGRA_ZERO_TEXTO` + bloco persona | `PromptBuilder` canônico: core_rules → strategy_rules → brand → niche → context → product → angle → persona → placement → avoid | diferente (ordem e peso) | médio | baixo | médio |
| Regras negativas | `EVITAR` do contexto; templates trazem "EVITAR EXPLICITAMENTE…" por ângulo | `EVITAR` do contexto (531 chars) | parcial | médio | – | médio |
| Regra explícita de dedos/mãos | **nenhuma** | **nenhuma** | sim (ambos sem) | – | – | – |
| Persona | `persona_cena` estruturada, com bloco "em conflito, pose/ação/enquadramento do ângulo vencem" | `describe(persona)` plano; **sem regra de precedência**; persona padrão tem `behavior: "gestos naturais, em movimento"` | **diferente** | médio | – | médio |
| Serialização | `.format(**variavel)` + concatenação | `PromptBuilder`, separador `\n\n` | equivalente | – | – | – |
| Truncamento/normalização | nenhum | nenhum | sim | – | – | – |
| Retry | nenhum na chamada | `max_retries=0` (SDK); retry é da fila (falha de infra) | irrelevante p/ qualidade | – | – | – |
| Versão do SDK | `openai>=1.50` | `openai>=1.50,<3` (não pinado) | equivalente | – | – | – |

### 1.3 Evidência do D1 (renderizei os prompts atuais)

`plan_creative` sobre `fixture-clean-single.json` (Use Origens, 1 produto, Feed 4:5), mesmo produto, 4 ângulos. Saída completa: scratchpad `oria_plans.json`.

| Ângulo | Prompt total | Seção do ângulo | Persona injetada |
|---|---|---|---|
| LIFESTYLE_COTIDIANO | 4.070 | 261 (6%) | Mulher 30 anos… "gestos naturais, em movimento" |
| CAIMENTO | 4.118 | 309 (7%) | idem |
| PRESENTE_AFETO | 4.064 | 255 (6%) | idem |
| CREATOR_STYLE | 4.105 | 296 (7%) | idem |

Os ~3.800 chars restantes são regras de fidelidade, regra de texto, marca, nicho, contexto e EVITAR. O modelo recebe muito contrato de **produto** e quase nenhum contrato de **corpo**.

Comparação direta dos ângulos (Streamlit `angulos_limpos_feed.json` × Oria `templates/angles.json`):

- **CAIMENTO** — local (1.142 chars): "braços em posição natural e relaxada ao lado do corpo (**NUNCA cruzados**)… A pessoa deve estar parada — **NÃO mostrar a pessoa mexendo, ajeitando, puxando ou segurando** qualquer parte da peça… sem jaqueta/mochila cobrindo a peça". Atual (309): "corpo inteiro ou 3/4, pose neutra que mostra silhueta". **Sem regra de braços/mãos**, e a persona ainda diz "em movimento".
- **PRESENTE_AFETO** — local: escolhe **UMA** de duas cenas, "NUNCA combine", descreve papel de cada pessoa. Atual: "**duas pessoas** num momento de presentear… {persona} entrega ou recebe". O motor calcula `people_needed=1` (`engines.py`, `angle["uses_person"]` só vale 1 para produto único), então **a segunda pessoa nunca é definida**: o modelo inventa, e é exatamente o cenário de mão-com-objeto entre duas pessoas.
- **CREATOR_STYLE** — local sorteia celular concreto (`CELULARES_CENA`, para não sair sempre o mesmo aparelho) e enumera 3 poses de selfie. Atual: "selfie de espelho ou braço estendido" sem descrição do celular ou do braço.
- **LIFESTYLE_COTIDIANO** — local lista situações e proíbe explicitamente "pessoa parada". Atual: "em movimento, fazendo algo cotidiano com o produto". Vago sobre o que as mãos fazem.

Efeito provável: sem instrução sobre onde estão braços/mãos, o modelo escolhe poses de alto risco (mão segurando objeto, duas pessoas em contato). É uma hipótese forte, mas **hipótese** (ver §1.5).

Ressalva de honestidade: o local também tem cenas com mão (sacola, café, celular). Então "o local não tinha mãos" não é a explicação; a diferença é o **grau de direção** da cena. Também não é possível descartar variância do modelo entre lotes pequenos.

### 1.4 Evidência do D2

`engines.py:594-595`:

```python
buf = io.BytesIO(data)
buf.name = f"reference_{role['order']}.png"   # data pode ser JPEG ou WebP
```

`storage.js:detectarImagem` aceita PNG/JPEG/WebP e guarda os bytes como vieram; `references.decode_reference` só valida assinatura. O `httpx` deriva o `Content-Type` do nome do arquivo → corpo JPEG anunciado como `image/png`. O local passa por `converter_para_png` (`assets.py:15`), que decodifica com Pillow e regrava PNG de verdade. Também nenhum dos dois aplica `ImageOps.exif_transpose`.

Impacto: **desconhecido**. Pode ser nulo (a API decodifica pelo conteúdo) ou degradar leitura da estampa. Não mediu-se porque exige chamada paga. Correção é barata e de baixo risco, então entra na Fase A mesmo assim, atrás de flag para permitir A/B.

### 1.5 Como provar a causa (A/B proposto, exige autorização de custo)

Mesmo produto (1 estampa em JPEG), ângulos CAIMENTO e PRESENTE_AFETO, 8 imagens por braço, `quality=medium`, avaliação cega por você (contagem de mão/dedo incorretos):

| Braço | Prompt | Referência |
|---|---|---|
| A | Streamlit | PNG normalizado (baseline local) |
| B | Oria atual | bytes originais (estado de produção) |
| C | Oria atual | PNG normalizado (isola D2) |
| D | Streamlit | bytes originais (isola D2 no prompt bom) |

Leitura: A×B = tamanho da regressão; C×B = efeito da referência; A×C = efeito do prompt; D×A = confirmação cruzada da referência. Se A×C for o grande delta, a Fase A corrige com prompt de pose, não com "texto negativo". ~64 imagens; o custo depende do preço do `gpt-image-2` e do tamanho de entrada (você vê na tela de custos). Não rodei nada.

### 1.6 Lacunas e itens a você conferir

- **`OPENAI_IMAGE_MODEL` e `OPENAI_IMAGE_MODEL_FALLBACKS` no serviço `oria-creatives`.** Se houver fallback configurado e o tenant não tiver acesso ao `gpt-image-2`, o `router.run` troca para o modelo de fallback **sem registrar** qual respondeu (`worker.consumoDoResultado` grava `plan.model.model`). Comando (você): `railway variables --service oria-creatives --kv | grep OPENAI`.
- **A chave BYOK do tenant** pode ter acesso/limites diferentes da chave global do local (org de projeto, verificação de organização para o modelo). Não verificável daqui.
- **Volume real de referências por produto em produção** (a hipótese de "muitas refs do mesmo produto" só se confirma vendo os planos gravados em `creative_generations.plan`, coluna que já existe).

### 1.7 Correções recomendadas (Fase A)

| # | Correção | Risco | Como validar |
|---|---|---|---|
| A1 | **Trace por geração**: modelo servido, parâmetros efetivos (`size`, `quality`, nº e formato original/enviado de cada ref, bytes), duração, `request_id` do provedor, hash do prompt. Só grava; comportamento idêntico. | baixo | teste unitário + coluna nova |
| A2 | **Normalizar referências** em `generate_creative`: decodificar e regravar PNG real, `exif_transpose`, nome coerente. Sem redimensionar. Flag `CREATIVE_NORMALIZE_REFERENCES`. | baixo | A/B braço C×B |
| A3 | **`PROMPT_VERSION=2` só para ângulos com pessoa**: portar do Streamlit o contrato de pose por ângulo (braços, ação única, papel da 2ª pessoa, celular concreto), e a regra de precedência "persona refina, ângulo manda". Flag por tenant. `PROMPT_VERSION=1` permanece byte a byte. | médio | A/B braço A×C |
| A4 | **Registrar o modelo servido** (candidato do router que respondeu). | baixo | teste do router |
| A5 | **Não adicionar** "sem dedos extras" como correção. Só como braço extra opcional do A/B. | – | – |

---

## 2. Mapa do pipeline atual

```
Browser (React)                     Node (apps/panel)                             Python (apps/creative-generator)            OpenAI
GerarTab.tsx  ──POST /preview──►  routes/criativos.js
   │                                 requests.normalizeJobInput (whitelist)
   │                                 requests.buildRequests → N CreativeRequest
   │                                 (N = ângulos × formatos × quantidade, máx 40)
   │                                 core.plan ─────────────────────────────►  POST /v1/plans → engines.plan_creative
   │                                                                             (kits, contexto, persona, PromptBuilder)
   │                                 ◄──────────────────────────── CreativePlan (schema_version 1)
   ├──POST /jobs────────────────►  pgStore: creative_jobs + creative_generations (status queued)
   │                                 worker.tick (setInterval 5s, 1 item/tenant/tick)
   │                                   queued → planning (core.plan se não houver plan)
   │                                   → generating: byok.resolve(); storage.readProductReference(ref) p/ cada ref
   │                                   core.generate ─────────────────────────►  POST /v1/generations (≤10 refs, base64)
   │                                                                             engines.generate_creative
   │                                                                               BytesIO(reference_N.png)                  ─►  images.edit
   │                                                                               router.run (fallback só 404)              ◄─  b64 PNG + usage
   │                                                                               asset_from_provider_b64 (crop cover)
   │                                 ◄──────────────────────────── CreativeResult {asset, metadata.usage}
   │                                   → processing: saveCreativeAsset (creatives/<id>/image.png)
   │                                   → completed: record, custo (tokens_* colunas)
   └──GET /jobs/:id (poll)──────►  progress(items)
```

Pontos relevantes do pipeline:
- `plan` completo (incl. `prompt.text`, `references`, `model`) **já é persistido** em `creative_generations.plan` (JSONB); `plan_summary` omite o texto do prompt por segurança. O que **falta** no registro é o que aconteceu na chamada (D3).
- O worker processa **um item por tenant por tick**, sequencial. QA e retry (Fase H) alongam a fila.
- Timeouts do cliente (`client.js`): plans 30s, generations 240s, copies 90s.
- `VISION_QA`, `STRUCTURED_OUTPUT` e `PROMPT_PLANNING` já existem como tarefas no `ModelRouter` (`model_router.py:21-26`), **mas nenhum código as usa**. Ponto de extensão pronto.
- Custo: colunas `tokens_*`/`modelo_imagem` em `creative_generations`, lidas por `lib/custos/precos.js`. Assumem **uma chamada por geração**.

---

## 3. Pontos de acoplamento existentes

| # | Acoplamento | Onde | Consequência para o V2 |
|---|---|---|---|
| C1 | Persona é **singular** em toda a cadeia (`plan.persona`, `planSummary`, `record.persona`, coluna `persona TEXT`, UI) | `engines.py`, `worker.js`, `requests.js`, `GerarTab.tsx` | Subjects exigem contrato novo; manter `persona` = persona do sujeito principal (dual-write) |
| C2 | Nº de pessoas **derivado** do ângulo e do nº de produtos: `people_needed = len(products) if uses_person and >1 else int(uses_person)` | `engines.py` (plan_creative) | Passa a vir de `subjects[]`; regra atual vira o "preenchimento automático" |
| C3 | Regra de peça infantil fixa "O MODELO da cena é SEMPRE uma criança" | `products.py` (`PECAS[...].regra_preservacao`) injetada em `core_rules` | Conflita com "menino + mãe". Precisa escopo por sujeito que **veste** |
| C4 | Ângulo = ID fixo, validado por `ANGLE_RE=/^[A-Z_]{3,40}$/` e enum `ANGLE_IDS`; `angle TEXT` na tabela | `requests.js`, `angles.py`, `contracts.py` | Ângulo customizado (UUID) não passa. Precisa `angle_ref {source,id,version}` |
| C5 | `Brand Kit.enabledAngles`, `angleLabels`, `niche.supportsApparelAngles` referenciam IDs antigos | `angles.py:angle_is_available`, `kits/*.json`, perfis no Postgres | Migração 13→7 exige mapa de aliases permanente |
| C6 | Whitelist rígida de entrada (`INPUT_KEYS`) e `additionalProperties` proibido no serviço Python | `requests.js:23`, `service.py:_read_json` | Todo campo novo precisa entrar nos dois lados; deploy ordenado (Python primeiro) |
| C7 | Storage de asset com chave fixa `creatives/<id>/image.png` (`ASSET_RE`) e 1 asset por `creative_id` | `storage.js`, `creative_assets` | **Retry do QA sobrescreveria a imagem anterior**; precisa chave por tentativa |
| C8 | Referências só em `products/<id>/<uuid>.<ext>` (`REF_RE`) | `storage.js` | Mockup de referência precisa de namespace próprio |
| C9 | Perfis (brand/niche/context/persona) têm `version` mas **só incrementam**; não há histórico | `pgStore.updateProfile` | "Restaurar versão" exige tabela de versões |
| C10 | Custo assume 1 chamada por geração | `worker.consumoDoResultado`, `custos/precos.js` | QA + retry + análise de mockup + GPT-fill precisam de contabilidade por chamada |
| C11 | `creative_*` é escopo **Organization**; domínios novos (0025–0029) migraram para `organization_id + store_id` | migrações 0002, 0025+ | Decisão de produto: catálogos criativos por Store? Afeta produto sincronizado do connector (`produtos_ink` tem `store_id`) |
| C12 | Toda tabela nova precisa do ciclo de tenancy: `organization_id`, trigger, RLS `FORCE` (0004/0007/0008/0009) | `migrations/sql/` | Custo fixo por tabela; usar molde de `creative_personas` |
| C13 | Modos são **module capabilities** de `creative_generator`, não features comerciais; Gerador é independente do connector Ink | `module-capabilities.js`, `connector-capabilities.js` | `mockup`, `multi_person`, `qa` entram como capabilities do módulo; commerce source é capability de **connector**, opcional |
| C14 | Core é "puro": teste `test_core_purity.py` proíbe SDK no core; cliente é injetado | `creative_core/tests/` | QA/estruturado seguem o padrão `client` injetado |
| C15 | Espelho no Streamlit: README diz que o gerador interno espelha o core; script de verificação vive lá e aponta para caminho antigo. Já divergem (`engines.py`, `service.py`) | `README.md` | Mudanças no core **não** propagam ao Streamlit. Manter o Streamlit como baseline visual até o A/B provar paridade |
| C16 | Testes existentes são contrato (fixtures com `expected_plan`, `prompt_sha256`) | `creative_core/tests`, `test/creative-core*.test.js`, invariantes INV-22 | Compiler v2 precisa de golden test provando v1 idêntico |
| C17 | Frontend: `GerarTab.tsx` (423 linhas) mistura estado, regras e layout numa função só | `src/pages/criativos/` | UI V2 é reescrita do formulário, não retoque; manter o atual atrás de flag |

---

## 4. Proposta arquitetural

### 4.1 Fluxo alvo

```
UI (builder) ──► CreativeConfig (request v2)
                     │  normalizeJobInput (Node, whitelist)
                     ▼
              plan_creative_v2  ── resolve kits/contexto/ângulo(system|brand)/subjects/interaction
                     │             calcula composition {people, hands_visible, pose_risk}
                     ▼
              CreativePlan v2 (JSON versionado, persistido)
                     │
                     ▼
              Prompt Compiler (compiler_version) ──► CompiledPrompt {text, sections, image_roles}
                     │
                     ▼
              images.edit (refs normalizadas) ──► asset (tentativa N)
                     │
                     ▼
              QA (vision, JSON estruturado) ──► pass? → completed
                     │ fail objetivo e retry<1
                     ▼
              retry único com `compiler hints` (mesmo plano, composição mais segura) → QA final
                     ▼
              persistir: plan, prompt, trace, qa, tentativas, custo
```

Princípio: **o plano é a fonte de verdade; o prompt é derivado e descartável**. Toda decisão de UI vira campo do plano, nunca texto.

### 4.2 CreativePlan v2 (evolução aditiva do `schema_version 1`)

Campos novos (o restante permanece):

```jsonc
{
  "schema_version": 2,
  "mode": "creative" | "mockup",
  "objective": "clean_creative" | "remarketing" | "funnel_visual" | "mockup_ecommerce",
  "subjects": [ CreativeSubject ],
  "assignments": [ { "subject_id": "s1", "product_id": "…", "mode": "wears" | "holds" } ],
  "relations": [ { "from": "s2", "to": "s1", "type": "mother_of" } ],
  "interaction": { "preset": "reading_together", "custom": null, "contact": "light", "hands_weight": 1 },
  "composition": { "people_count": 2, "hands_visible_estimate": 4, "pose_risk": "medium", "risk_reasons": ["two_people","light_contact"], "policy": "commercial_cap_medium" },
  "angle": { "ref": { "source": "system" | "organization" | "brand", "id": "…", "version": 3 }, "…campos atuais…" },
  "mockup": { "recipe_ref": null, "blueprint": null, "preset": null },
  "qa_policy": { "enabled": true, "max_auto_retries": 1, "checks": ["anatomy","people_count","product_fidelity","print_fidelity","unwanted_text"] },
  "compiler": { "version": 2, "sections": [ { "name": "composition_contract", "length": 812 } ] },
  "persona": { "…persona do sujeito principal, para compatibilidade…" }
}
```

Compatibilidade: plano v1 continua válido. O worker lê `plan.schema_version`; `planSummary` e `record` continuam derivando `persona`/`angle` dos campos antigos.

### 4.3 Pessoas e composição (não é texto livre)

```ts
type CreativeSubject = {
  id: string                         // "s1", "s2"…
  role: "primary" | "supporting"
  personaId?: string                 // creative_personas
  generated?: { label: string; ageBand: AgeBand; genderPresentation?: string }
  ageBand: "baby"|"child_3_5"|"child_6_9"|"teen"|"adult"|"senior"
  relationToPrimary?: RelationType   // enum fechado + "custom" com rótulo
  wearsProductId?: string | null     // null = NÃO veste (mãe do exemplo)
  holdsProductId?: string | null
  prominence: "hero" | "secondary" | "background"
  visibleBody: "face"|"bust"|"half"|"three_quarter"|"full"
  position?: "left"|"center"|"right"|"foreground"|"background"
  wardrobeRule?: "neutral_plain" | "coordinated" | "free"   // apoio sem estampa concorrente
}
```

Regras de validação (no core, com `GenerationError`):
- exatamente 1 `primary`; máx. 4 sujeitos (soft warning a partir de 3; bloqueio configurável);
- `wearsProductId` só aponta produto do plano; produto vestível não pode ser vestido por 2 sujeitos salvo "peça repetida" explícita;
- faixa etária do sujeito que **veste** deve ser compatível com o tipo de peça (resolve C3: "infantil" restringe quem veste, não a cena);
- relações formam grafo sem ciclo; `mother_of` exige `ageBand` de adulto, etc.;
- interação filtrada por nº de pessoas e faixa etária (tabela `templates/interactions.json`).

Os três exemplos do pedido:

| Cenário | Subjects | Assignments | Interação |
|---|---|---|---|
| Menino + mãe lendo | s1 primary child_6_9; s2 supporting adult, `relationToPrimary=mother` | s1 wears P1; s2 sem produto | `reading_together` |
| Duas irmãs | s1 primary, s2 supporting `sibling` | s1 wears P1; s2 wears P2 | `candid` |
| Casal | s1 primary, s2 `partner` | s1 wears P1; s2 wears P2 (mesmo kit) | `looking_at_each_other` |

Pré-existente aproveitável: o Streamlit da Entre Nós já tem `lojas/entre_nos/vinculos.json` (mãe-filho, pai-filho, irmãos…) com `pessoas`, `persona_padrao`, **`gestos`** e contextos por laço. É o melhor ponto de partida para `relations` + presets de interação, já validado visualmente.

### 4.4 Pose risk (consciência de anatomia)

Cálculo determinístico no plano, sem chamar modelo:

| Fator | Peso |
|---|---|
| nº de sujeitos ≥ 3 | +2 |
| 2 sujeitos | +1 |
| contato físico (`light`=+1, `physical`=+2) | +1/+2 |
| sujeito segurando objeto (`holdsProductId` ou preset com objeto) | +1 por sujeito |
| `visibleBody` ≥ `half` em mais de 1 sujeito | +1 |
| ângulo/enquadramento que esconde mãos (busto, close) | −1 |

`low` ≤ 1 · `medium` 2–3 · `high` ≥ 4. Política de objetivo comercial: se `pose_risk=high` e a interação **não** foi escolhida explicitamente, o planner troca por preset de menor risco e emite `warning: pose_downgraded`. Se foi escolhida, gera com `qa_policy.enabled=true` forçado e sugere `quality=high`.

### 4.5 Prompt Compiler

Novo pacote `creative_core/compiler/` (o `PromptBuilder` atual vira detalhe interno). Entrada: CreativePlan v2. Saída: `CompiledPrompt {text, sections[], image_roles[], sha256, compiler_version}`.

Seções (ordem fixa, cada uma com teste): `fidelity_rules` → `reference_roles` → `composition_contract` → `scene` → `brand` → `niche` → `context` → `text_rules` → `avoid` → `format`. O **`composition_contract`** é o que falta hoje. Exemplo (menino + mãe lendo):

```
COMPOSIÇÃO (contrato — exatamente 2 pessoas visíveis):
- Pessoa A (principal, destaque): menino de 5–7 anos, à esquerda. VESTE o produto (imagem 1).
- Pessoa B (apoio): mulher adulta, mãe de A, à direita. NÃO veste o produto; roupa lisa e neutra, sem estampa.
- Interação: leem um livro juntos; o livro aberto apoiado no colo de A; a mão de B apoia a página, sem cruzar o corpo de A.
- Mãos: no máximo 4 visíveis; nenhuma mão cruza outra pessoa; nenhuma mão segura o produto.
```

Regras do compilador: descrever **o que está visível e onde**, não o que evitar; um único verbo de ação; papéis por sujeito; a instrução de ângulo customizado entra **dentro de `scene`** e nunca abaixo das regras de fidelidade (não pode sobrescrevê-las). Versão 1 continua produzindo exatamente os prompts de hoje (golden test).

### 4.6 Ângulos

**Catálogo global (7)** e mapa das 13 IDs atuais (IDs antigos continuam resolvendo para sempre, via alias):

| Novo (system) | Absorve | Observação |
|---|---|---|
| `lifestyle_cotidiano` | LIFESTYLE_COTIDIANO | pessoa 1, ação única |
| `conexao_vinculo` | PRESENTE_AFETO, PERTENCIMENTO (versão sem região) | ≥2 sujeitos; interação obrigatória |
| `retrato_editorial` | PREMIUM_ESTILO, ORGULHO_DISCRETO | limpo e controlado; risco baixo |
| `acao_movimento` | (novo, derivado do LIFESTYLE local) | risco médio |
| `produto_em_foco` | CAIMENTO, CLOSE_ESTAMPA, CLOSE_BOLSO | framing como parâmetro, não ID |
| `produto_sem_pessoa` | CABIDE, PRODUTO_ESTAMPA | layout: cabide/flatlay/dobrado |
| `creator_social` (opcional) | CREATOR_STYLE | |

**Saem do global** e viram **ângulos de marca** semeados na Use Origens (nada se perde, some do catálogo global): IDENTIDADE_ORIGEM, NOSTALGIA_ORIGEM, ORGULHO_DISCRETO (regional), PERTENCIMENTO (regional). Entre Nós recebe: mãe e filho, irmãos, casal, família em casa, presente afetivo (a partir de `vinculos.json`/`angulos.json` do Streamlit).

**`CreativeAngle`** conforme o spec, mais: `brandRef {source:'builtin'|'profile', id}`, `peopleMode`, `poseRiskCeiling`, `defaultInteraction`, `version`. `promptInstructions` é texto de usuário: limite de tamanho (≤ 1.200), sem placeholders fora da whitelist, e entra na seção `scene` (nunca acima das regras de fidelidade).

### 4.7 Mockup Blueprint e Receitas

- **Modo** `mockup` reutiliza produto, kits e pipeline; troca compiler section `scene` por `mockup_scene` e o QA ganha checagem de fidelidade de estampa e caimento.
- **Análise de referência**: nova chamada `VISION` com **saída estruturada** (schema fechado: enums para enquadramento, luz, fundo, pose, mãos, crop; strings curtas para estilo). A imagem de referência **não** vai ao gerador por padrão; só o blueprint vai. (Opcional, depois: como `layout_only`, papel que o core já define em `references.REFERENCE_ROLES` com as listas `LAYOUT_REFERENCE_MAY_COPY/NEVER_COPY`.)
- **Blueprint** = o JSON do spec, com `schema_version`, `confidence` por campo e `user_overrides`. O usuário ajusta antes de gerar.
- **Receita** = blueprint + `promptInstructions` + preset + `brandRef`, versionada. Pode ser criada com ou sem a imagem de origem (guardar a imagem é opcional; direitos de terceiros).
- **Cache de análise** por `sha256` da referência para não cobrar duas vezes.
- **Injeção via imagem**: texto dentro da referência é dado, não instrução. Campos livres do blueprint são curtos, sanitizados e nunca concatenados sem passar pelo compilador.

### 4.8 QA pós-geração e retry

- Chamada de visão com JSON estruturado (`VISION_QA` já roteada): `anatomy`, `people_count`, `merged_objects`, `unwanted_text`, `product_fidelity`, `print_fidelity`, `composition`. Cada check: `pass`, `issues[]` de um enum fechado, `confidence`.
- **Retry**: no máximo 1, só para falhas objetivas (`extra_finger_*`, `people_count_mismatch`, `merged_*`, `unwanted_text`). O retry regenera com o **mesmo plano** e `compiler_hints` (ex.: reduzir risco: `visibleBody`↓, interação mais simples), nunca "mais prompt". Ambas as tentativas ficam salvas; o resultado exibido é a de melhor QA; se as duas falham, entrega a menos ruim marcada `qa_failed` para revisão humana.
- **Antes de ligar o retry**: medir precisão do QA em um conjunto rotulado (≥ 50 imagens boas e ruins). Um QA com falso positivo alto dobra custo à toa; com falso negativo, é teatro. Enquanto isso, QA roda em modo **observação** (registra, não regenera).
- Custo: cada tentativa e o QA entram na contabilidade (C10). Toggle explícito por tenant e por lote (é a chave BYOK dele).

### 4.9 Produtos: manual ou connector

```ts
type ProductSource =
  | { type: "manual" }
  | { type: "connector"; connectorKey: string; externalProductId: string }
```

- Novas colunas em `creative_products` (ver §6). Vínculo por `(connector_key, external_id)`; o produto sincronizado mantém cópia das imagens no storage do Gerador (referências precisam de bytes locais: o core nunca baixa URL, garantia anti-SSRF que deve continuar).
- Fonte da sincronização: o catálogo já existente do connector (`produtos_ink`, com `store_id`). Disponibilidade governada por **connector capability** (padrão `connector-capabilities.js`), sem tornar o Gerador dependente do connector (C13).
- Enriquecimento por GPT: `POST …/products/:id/analyze` devolve **proposta** (não persiste); aprovação do usuário grava em `enrichment`.

### 4.10 Preenchimento com GPT (Brand/Niche/Contexto/Ângulo/Produto)

Um único endpoint no core, `POST /v1/structured/<kind>` (`kind` ∈ brand, niche, context, angle, product), usando a tarefa `STRUCTURED_OUTPUT` do router, com **JSON Schema derivado dos contratos que já existem** (`contracts.json_schema`). Fluxo: perguntas guiadas → proposta estruturada → tela de revisão (diff campo a campo) → salvar via CRUD atual (que já valida no core). Nunca grava direto.

### 4.11 Biblioteca criativa

Sem mudar rota nem tabela de início: agrupar as abas Marca e nicho, Contextos, Personas, Ângulos e Receitas sob "Biblioteca criativa" (navegação secundária) com o mesmo padrão de lista (estado vazio, Novo, Preencher com GPT, duplicar, arquivar, versões). Todos são `profile kinds` do mesmo `PROFILE_PATH` do `routes/criativos.js`, então `angle` e `mockup_recipe` entram no mesmo laço de CRUD.

---

## 5. Models e contratos a criar/alterar

**Core Python (`contracts.py` + `schemas/*.schema.json` + `contracts.d.ts`, gerados por `export_all`)**

| Contrato | Ação |
|---|---|
| `CreativeRequest` | **alterar (aditivo)**: `mode`, `objective`, `subjects[]`, `assignments[]`, `relations[]`, `interaction`, `angle_ref`, `mockup`, `qa_policy` |
| `CreativePlan` | **alterar (aditivo)**: campos de §4.2; `schema_version` 2 |
| `CreativeSubject`, `SubjectAssignment`, `Relation`, `Interaction` | **novos** |
| `CompositionAnalysis` | **novo** (`people_count`, `hands_visible_estimate`, `pose_risk`, `risk_reasons`, `policy`) |
| `CompiledPrompt` | **novo** (extrai o que hoje é `plan.prompt`) |
| `Angle` | **alterar**: `scope`, `brandRef`, `peopleMode`, `poseRiskCeiling`, `promptInstructions`, `version`; hoje é só descritor |
| `Persona` | **alterar (opcional)**: `ageBand`, `genderPresentation`, `wardrobeRule` |
| `MockupBlueprint`, `MockupRecipe`, `MockupAnalysis` | **novos** |
| `QAReport`, `QAPolicy` | **novos** |
| `GenerationTrace` | **novo** (A1): `model_requested`, `model_served`, `params`, `references[{order, original_mime, sent_mime, bytes}]`, `duration_ms`, `provider_request_id`, `usage`, `attempt` |
| `GenerationRecord` | **alterar**: `qa`, `attempts[]`, `compiler_version`, `plan_schema_version` |
| `CreativeProduct` | **alterar**: `source`, `enrichment`, `syncStatus` |
| `StructuredProposal` | **novo** (envelope: `kind`, `proposal`, `assumptions[]`, `questions[]`) |

**Node**: `INPUT_KEYS` e `normalizeJobInput` ganham os campos novos; `planSummary`/`planPrompt` passam a incluir `subjects`, `composition`, `qa`; `worker.processarItem` ganha etapa QA/retry; `custos` soma por tentativa.

---

## 6. Migrations necessárias

Numeração continua de `0030-reparar-loja-uuid-em-pedidos`. Todas com `.up/.down`, molde de tenancy (`organization_id`, trigger, RLS `FORCE`) nas tabelas novas.

| Fase | Migration | Conteúdo | Reversível |
|---|---|---|---|
| A | `0031-creative-trace` | `creative_generations` + `generation_trace JSONB`, `model_served TEXT`, `duration_ms INT`, `provider_request_id TEXT` | sim (drop coluna) |
| B | `0032-creative-plan-v2` | `creative_generations` + `plan_schema_version INT`, `compiler_version INT` | sim |
| H | `0033-creative-attempts-qa` | Nova `creative_generation_attempts` (`creative_id`, `attempt`, `status`, `asset_id`, `trace`, `qa`, `usage cols`) + `creative_generations.qa_status TEXT`. **Resolve C7 e C10**: tentativa própria com storage key própria | sim |
| D | `0034-creative-angles` | `creative_angles` (`id`, `organization_id`, `tenant_id`, `scope`, `brand_source`, `brand_ref`, `data JSONB`, `version`, `status`, `archived_at`) + `creative_profile_versions` (`kind`, `profile_id`, `version`, `data`, `created_at`) para "restaurar versão" (C9, vale para brand/niche/context/persona/receita) + `creative_generations.angle_ref JSONB` | sim |
| F | `0035-creative-product-source` | `creative_products` + `source_type TEXT DEFAULT 'manual'`, `connector_key`, `external_id`, `external_hash`, `sync_status`, `synced_at`, `sync_error`, `enrichment JSONB`, `enrichment_status`; índice único parcial `(organization_id, connector_key, external_id) WHERE source_type='connector'` | sim |
| G | `0036-creative-mockup-recipes` | `creative_mockup_recipes` (`brand_source`, `brand_ref`, `name`, `source_asset_key`, `blueprint JSONB`, `prompt_instructions`, `version`, `status`) + `creative_mockup_analyses` (cache por `reference_sha256`) | sim |

Sem migration: Subjects, interação, composição e `mode` vivem no `request`/`plan` JSONB existentes. `persona` (perfil) ganha campos opcionais só no contrato. Decisão pendente que muda o desenho: **escopo Store × Organization (C11)** para `creative_products`/recipes/angles.

Backfill: nenhum obrigatório. `angle_ref` de gerações antigas deriva de `angle TEXT` por leitura (alias), não por UPDATE.

---

## 7. Endpoints afetados

**Node (`/api/admin/criativos/*`)**

| Endpoint | Mudança |
|---|---|
| `POST /jobs`, `POST /preview` | aditivo: `mode`, `objective`, `subjects`, `interaction`, `angle_ref`, `mockup`, `qa`; `ANGLE_RE` relaxado para `angle_ref` |
| `GET /catalog` | + `interactions`, `relation_types`, `age_bands`, `angles v2` (system + da marca), `mockup_presets` |
| `GET /jobs/:id`, `GET /history` | + `qa`, `attempts`, `composition` no resumo |
| `POST /jobs/:id/items/:creativeId/retry` | passa a criar tentativa nova sem sobrescrever asset |
| `GET /assets/:creativeId` | + `?attempt=` |
| `POST /products` | + `source` |
| **novos** `/angles` (CRUD + `/:id/versions`, `/:id/restore`) | entra no laço `PROFILE_PATH` |
| **novos** `/mockup/recipes` (CRUD), `/mockup/analyze`, `/mockup/presets` | |
| **novos** `/fill/{brand,niche,context,angle}` e `/products/:id/analyze` | devolvem proposta, não persistem |
| **novos** `/products/connector`, `/products/sync` | condicionados à connector capability |
| **novo** `/plan` | devolve o CreativePlan (aba avançada; `/preview` atual continua) |

**Python (`/v1/*`)**: `POST /v1/plans` aceita schema 2; `POST /v1/generations` devolve `trace`; **novos** `POST /v1/qa`, `POST /v1/analyses/mockup`, `POST /v1/structured/<kind>`. A orquestração (gerar → QA → retry) fica no **worker Node**, uma chamada HTTP por passo, para não estourar o timeout de 240s de uma requisição única.

**Deploy ordenado**: Python primeiro (aceita campos novos, ignora ausentes) → Node depois. O serviço Python rejeita campos desconhecidos (`_read_json`), então a ordem inversa quebra.

---

## 8. Wireframe textual do Gerador V2

Direção: builder progressivo, sem wizard rígido. Topo: `Criativo | Mockup`. Coluna esquerda com etapas colapsáveis (resumo quando fechada); coluna direita sticky.

```
┌ Gerador de Criativos ────────────────────────────────────  [Criativo | Mockup]  [Classic ▾ flag] ┐
│ ┌──────────────── CONFIGURAÇÃO (esq.) ────────────────┐ ┌────────── PRÉVIA (dir., sticky) ────┐ │
│ │ ✔ 1 Objetivo   · Criativo limpo (funil na copy)   ⌄ │ │ ┌───┐ Produto: Brincar com Meu Pai  │ │
│ │ ✔ 2 Produto    · Pipa Menina  [Sincronizado]      ⌄ │ │ │img│ 3 refs (ordem 1·2·3)          │ │
│ │ ▶ 3 Pessoas e cena                                  │ │ └───┘                                │ │
│ │   ┌ Pessoa principal ─────────────────────────────┐ │ │ Pessoas   Menino 6–8 + mãe          │ │
│ │   │ [thumb] Menino 6–8 anos    ▾ persona          │ │ │ Interação Lendo juntos              │ │
│ │   │ Veste: (•) Pipa Menina  ( ) nenhum            │ │ │ Ângulo    Conexão / vínculo         │ │
│ │   │ Enquadramento: ( ) busto (•) 3/4 ( ) corpo    │ │ │ Formato   Feed 4:5 · 2 imagens      │ │
│ │   └───────────────────────────────────────────────┘ │ │ Risco de anatomia  ● médio          │ │
│ │   ┌ Mãe (apoio) ─────────────────────── [remover] ┐ │ │   ↳ 2 pessoas, contato leve         │ │
│ │   │ Relação: Mãe ▾   Veste: ( ) sim (•) não       │ │ │ QA automático  [✓] (1 retry)        │ │
│ │   │ Destaque: ( ) hero (•) apoio ( ) fundo        │ │ │                                      │ │
│ │   └───────────────────────────────────────────────┘ │ │ [ Pré-visualizar plano ]            │ │
│ │   [+ Adicionar pessoa]                              │ │ [ Gerar 2 criativos ]  ~ custo est. │ │
│ │   Interação: chips  [espontâneo][abraço][conversa]  │ │ ──────────────────────────────────  │ │
│ │   [olhando][caminhando][brincando][●lendo][cozinhando]│ │ Avançado:  Plano JSON │ Prompt │ Trace │ │
│ │   [atividade][presenteando][foto de grupo][custom]  │ │ (fechado por padrão)                │ │
│ │   (incompatíveis com a idade ficam desabilitados)   │ └─────────────────────────────────────┘ │
│ │ ○ 4 Ângulo          · Conexão / vínculo   [Da marca]│                                          │
│ │ ○ 5 Marca e contexto· Entre Nós · Casa · auto       │   [Usar configuração recomendada]        │
│ │ ○ 6 Saída           · Feed 4:5 · 2 · medium         │                                          │
│ └─────────────────────────────────────────────────────┘                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Etapa 2 Produto**: cards com thumbnail e badge `Manual | Sincronizado | Atualização pendente | Erro de sync`; "Analisar com GPT" no drawer do produto.
- **Etapa 4 Ângulo**: cards em grupos "Globais" e "Da marca"; cada card mostra `peopleMode` e risco típico; ângulo incompatível com o nº de pessoas fica desabilitado com motivo.
- **Etapa 5**: Marca/Nicho/Contexto entram automáticos do produto/marca; "editar" abre drawer, não formulário inline.
- **Etapa 6 Saída**: formato, quantidade, qualidade, **QA automático** (com nota de custo), copy externa.
- **Modo Mockup** (mesma casca): 1 Produto → 2 Fonte `[Preset][Receita salva][Nova referência]` → (referência) upload → **Blueprint editável** (chips/selects por campo, com confiança) → 3 Pessoa (opcional) → 4 Saída → `[Salvar como receita]` após gerar.
- **Mobile**: prévia vira barra inferior com resumo + botão Gerar; etapas continuam colapsáveis.
- **Estados**: cada etapa mostra vazio, erro e "recomendado" (badge) quando veio de `Usar configuração recomendada`; tudo editável.
- Biblioteca criativa: as abas atuais (Marca e nicho, Contextos, Personas) + Ângulos + Receitas sob um agrupamento único; mesmo padrão de lista/versões/Preencher com GPT.

Tela atual, para referência: 7 abas (`Gerar`, `Lotes`, `Histórico`, `Produtos`, `Marca e nicho`, `Contextos`, `Personas`); `Gerar` é um formulário único de ~420 linhas com seções numeradas 1–4 (tipo, produtos, ângulos por checkbox de 13 itens, marca/nicho/contexto/persona em selects) e prévia em card abaixo.

---

## 9. Plano incremental

Ordem recomendada (difere da ordem A–H do spec em um ponto: **QA sobe para antes do redesenho**, porque anatomia é a prioridade máxima e o QA em modo observação gera os dados que validam todo o resto).

| Fase | Entrega | Depende de | Risco | Saída verificável |
|---|---|---|---|---|
| **A** | Trace (A1), modelo servido (A4), normalização de refs por flag (A2), `PROMPT_VERSION=2` de pose para ângulos com pessoa por flag (A3), A/B | – | baixo–médio | A/B com números; trace visível no histórico |
| **B** | CreativePlan v2 + Compiler; **v1 byte a byte igual** (golden) | A | médio | mesmos hashes de prompt em fixtures v1; `plan` v2 persistido |
| **C** | Subjects, relações, atribuição de produto, interações, pose risk (contrato + planner; ainda sem UI nova, via API/JSON) | B | médio | 3 exemplos do pedido geram plano válido; C3 resolvido |
| **H** | QA (observação) → medição em conjunto rotulado → retry limitado; tabela de tentativas; custo por tentativa | B (e C para `people_count`) | médio–alto | relatório de precisão do QA; retry só liga com precisão aceita |
| **D** | Ângulos V2: catálogo 7 + aliases + CRUD por marca + versões | B | médio | jobs antigos legíveis; Use Origens com ângulos regionais semeados |
| **E** | UI Gerador V2 (atrás de flag; o formulário atual segue vivo) | C, D (H recomendado) | médio | Chrome smoke; paridade funcional com o atual |
| **G** | Modo Mockup: presets, análise, blueprint, receitas | B, H, E | alto | subir referência → blueprint → gerar → salvar receita |
| **F** | Product Source + connector + enriquecimento GPT | independente (paralelizável) | médio (conflita com trilha de integrações) | produto sincronizado gera; manual intacto |

`GPT-fill` (§4.10) entra junto de D (ângulos) e E (Brand/Niche/Contexto), com o mesmo endpoint estruturado.

---

## 10. Riscos e backward compatibility

**Compatibilidade (regras)**
- Aditivo em tudo: nenhum campo removido; `schema_version 1` continua aceito e gerando os mesmos prompts.
- IDs de ângulo antigos resolvem por alias permanente (jobs, histórico, `enabledAngles`, `angleLabels`).
- Formulário atual permanece atrás de flag até equivalência funcional (restrição do spec).
- Streamlit fica como baseline visual e **não** é desligado antes do A/B.
- Ordem de deploy: Python antes do Node; migrations aditivas antes de código que as usa.

**Riscos**

| Risco | Impacto | Mitigação |
|---|---|---|
| Causa da regressão ser variância/modelo, não prompt | corrigimos o que não é | A/B de 4 braços antes de decidir A3 |
| QA de visão com falso positivo alto | custo dobrado, fila lenta | modo observação + conjunto rotulado antes de ligar retry |
| Custo/latência: geração + QA + retry por item, worker sequencial | fila longa, fatura maior (BYOK do cliente) | toggle, teto de 1 retry, custo por tentativa exibido, concorrência do worker como fase própria |
| Ângulo customizado com texto livre sobrescrevendo fidelidade | perda de estampa | seção fixa abaixo das regras + limite de tamanho + validação |
| Prompt injection via imagem de mockup/produto do connector | conteúdo indevido no prompt | saída estruturada com enums; campos livres curtos e sanitizados; imagem não vai ao gerador por padrão |
| Propriedade intelectual de mockup de terceiros | jurídico | armazenar só blueprint por padrão; imagem de origem opcional; aviso de uso |
| Imagens de crianças/família geradas | política do provedor e LGPD | revisar política de uso da OpenAI para menores; prompts só de vestuário; sem pessoa identificável; avaliar antes da Fase C |
| Retry sobrescrevendo asset | perda da tentativa boa | C7: chave por tentativa (Fase H) |
| Mudar escopo Store×Org no meio | migração dupla | decidir C11 **antes** das Fases D/F/G |
| Drift core Oria × espelho Streamlit | baseline visual desatualizado | congelar Streamlit como baseline; não sincronizar durante o A/B |
| Conflito com a trilha de integrações (Ink/Meta) | merge | Fase F em branch própria; toca `creative_products` e `lib/platform/connector-capabilities.js` |
| GPT-fill alucinando marca/público | cadastro errado | proposta com `assumptions[]` + revisão campo a campo; nada grava sem aprovação |
| Mais campos = mais superfície de teste | regressão | golden tests do compilador; invariante INV-22 de tenant nas novas tabelas |

---

## 11. Arquivos que cada fase provavelmente toca

Legenda: **N** = novo · **M** = modificado.

**A — regressão/trace**
- `apps/creative-generator/creative_core/engines.py` M (normalização, trace, modelo servido)
- `…/assets.py` M (reuso de `converter_para_png`, `exif_transpose`)
- `…/model_router.py` M (`run` devolve o candidato que respondeu)
- `…/templates/angles.json` M e `…/versions.py` M (`PROMPT_VERSION=2` para ângulos com pessoa)
- `…/tests/test_engines_fixtures.py`, `test_usage_accounting.py` M; novo teste de normalização N
- `apps/panel/lib/creative-core/worker.js` M, `pgStore.js` M, `memoryStore.js` M
- `apps/panel/migrations/sql/0031-creative-trace.{up,down}.sql` N + wrapper em `migrations/`
- `apps/panel/routes/criativos.js` M (resumo com trace), `src/pages/criativos/LotesTab.tsx` M (mostrar trace)
- `scripts/` N (harness do A/B, sem rodar sem autorização)

**B — Plan v2 + Compiler**
- `creative_core/compiler/` N; `prompt_builder.py` M; `engines.py` M; `contracts.py` M; `schemas/*.json` e `contracts.d.ts` M (gerados)
- `creative_core/tests/` N (golden v1 idêntico, snapshots v2)
- `apps/panel/lib/creative-core/requests.js` M, `worker.js` M
- `migrations/sql/0032-creative-plan-v2.*` N

**C — Pessoas**
- `creative_core/composition.py` N; `templates/interactions.json` N; `personas.py` M; `products.py` M (C3); `contracts.py` M
- `apps/panel/lib/creative-core/requests.js` M (`INPUT_KEYS`, validação de subjects)
- `src/api/criativos.ts` M (tipos)

**H — QA/retry**
- `creative_core/qa.py` N; `engines.py` M; `service.py` M (`/v1/qa`); `model_router.py` M
- `apps/panel/lib/creative-core/{worker,client,pgStore,memoryStore,storage}.js` M (etapa QA, tentativas, chave por tentativa)
- `apps/panel/lib/custos/precos.js` e SQL de custos M (soma por tentativa)
- `apps/panel/routes/criativos.js` M (`?attempt=`, retry)
- `migrations/sql/0033-creative-attempts-qa.*` N
- `apps/panel/test/creative-core*.test.js`, invariantes INV-22 M/N

**D — Ângulos V2**
- `creative_core/angles.py` M; `templates/angles.json` M (+ `angles_system_v2.json` N, alias map); `kits/brand/*.json` M (semear ângulos regionais)
- `apps/panel/routes/criativos.js` M (`PROFILE_PATH` + `angle`), `lib/creative-core/pgStore.js` M (`PROFILE_TABLE`), `requests.js` M (`ANGLE_RE`/`angle_ref`)
- `src/pages/criativos/CadastrosTabs.tsx` M, `AnguloEditor.tsx` N
- `migrations/sql/0034-creative-angles.*` N

**E — UI V2**
- `src/pages/criativos/GerarTab.tsx` M (vira "clássico" atrás de flag), `GeradorV2/` N (etapas, prévia, pessoas, interação), `PromptsPrevia.tsx` M, `CriativosPage.tsx` M, `src/criativos.css` M, `src/api/criativos.ts` M
- `lib/creative-core/flags.js` M, `module-capabilities.js` M

**G — Mockup**
- `creative_core/mockup.py` N, `compiler/` M, `service.py` M (`/v1/analyses/mockup`), `contracts.py` M, `templates/mockup_presets.json` N
- `apps/panel/routes/criativos.js` M, `lib/creative-core/storage.js` M (`REF_RE`, namespace de referência de mockup), `pgStore.js` M
- `src/pages/criativos/Mockup/` N; `migrations/sql/0036-creative-mockup-recipes.*` N

**F — Product Source**
- `apps/panel/lib/platform/connector-capabilities.js` M, `lib/creative-core/pgStore.js` M, `routes/criativos.js` M, `lib/creative-core/storage.js` M (cópia de imagens do connector)
- `src/pages/criativos/CadastrosTabs.tsx` M (`ProdutosTab`)
- `migrations/sql/0035-creative-product-source.*` N

**Transversal (B→H)**: `creative_core/structured.py` N + `service.py` M (`/v1/structured/<kind>`), `KitEditor.tsx`, `ContextoEditor.tsx`, `PersonaEditor.tsx` M (botão Preencher com GPT).

---

## 12. Recomendação de onde começar

**Começar pela Fase A, em três commits pequenos e independentes**, antes de qualquer trabalho de UI ou de CreativePlan v2:

1. **A1 + A4 (trace + modelo servido).** Zero mudança de comportamento; dá, por fim, dados reais para comparar versões e responde D3.
2. **A2 (normalizar referências), atrás de flag.** Barato e isola a variável D2.
3. **A3 (`PROMPT_VERSION=2`, pose de ângulos com pessoa), atrás de flag por tenant**, portando do Streamlit o que já foi validado (braços, ação única, papel da 2ª pessoa, precedência persona×ângulo). Começar por CAIMENTO, PRESENTE_AFETO, CREATOR_STYLE e LIFESTYLE_COTIDIANO, os quatro comparados aqui.

Em paralelo, **rodar o A/B de §1.5** (precisa da sua autorização de custo) e **conferir as variáveis do `oria-creatives`** (§1.6). Só decidir B em diante quando o A/B disser quanto do problema é prompt e quanto é entrada.

Decisões suas antes da Fase B/D:
- Escopo dos catálogos criativos: **Organization** (como hoje) ou **Store** (C11)?
- QA automático: ligado por padrão para cenas com ≥2 pessoas, ou sempre opt-in? (impacta custo BYOK do cliente)
- Sujeitos: limite de 3 ou 4 pessoas no V1 do builder?
- Política para imagens de crianças/família (revisão da política de uso do provedor).

---

## Anexo — o que foi feito nesta rodada

- Lido: spec, `engines.py`, `service.py`, `references.py`, `assets.py`, `placements.py`, `model_router.py`, `prompt_builder.py`, `personas.py`, `products.py`, `angles.py`, `versions.py`, templates, kits, `contracts.py` (estrutura), `worker.js`, `client.js`, `storage.js`, `requests.js`, `routes/criativos.js`, `pgStore.js`, migração `0002`, `GerarTab.tsx`, `CriativosPage.tsx`, `module-capabilities.js`, `connector-capabilities.js`; no Streamlit: `gerar_imagem`, `montar_regras_fixas`, `montar_prompt_angulo_limpo`, `montar_bloco_referencias_apoio`, `personas_cena.py`, templates de ângulos e `lojas/entre_nos/vinculos.json`.
- Executado: `plan_creative` sobre a fixture para 4 ângulos (sem rede); `python3 run_tests.py` no core → **7/7 suítes OK** (baseline); `diff -rq` entre o core do Oria, o espelho do Streamlit e o core pré-migração (`orgulhoregional/services/creative-core`: `creative_core/` idêntico).
- Não executado: qualquer chamada OpenAI; leitura de env/logs de produção (bloqueada); testes Node/Chrome (não há mudança de código).
