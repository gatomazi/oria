# Fase G.2 — Multipeça na UI V2

**Escopo**: `GerarTabV2.tsx` (frontend) + uma extensão pontual e read-only de `planSummary()`
(`requests.js`, Node) para expor `subjects` (já calculado pelo core, nunca inventado). **Zero
mudança no core Python.** V1 intacta. Sem chamadas OpenAI, sem push/merge/deploy, sem ativação de
flags para clientes.

## 1. Inspeção obrigatória — antes de qualquer linha de UI nova

Fontes: `creative_core/strategies.py` (`MULTI_PRODUCT_RULES`/`product_limits`),
`creative_core/products.py` (`validate_products`), `creative_core/composition.py`
(`explicit_subjects`/`enforce_infant_wearers`/`recommend`), `creative_core/planner_v2.py`
(`derive_subjects`/`build`), `creative_core/engines.py` (`plan_creative`, `people_needed`),
`GerarTab.tsx` (V1, multipeça já existente), `requests.js` (`buildRequests`/`planSummary`).

### Como a V1 já envia multipeça hoje

`GerarTab.tsx`: `productMode` (`single_product`/`multi_product`), limite lido de
`catalog.multiProductRules[engine]` (o mesmo `MULTI_PRODUCT_RULES` do core, exposto por
`/catalog`), `multiPermitido = status.flags.creative_multi_product && regra.enabled`. A V1 **não
tem nenhuma UI de "quem veste o quê"** — sempre manda `product_ids` e deixa o core decidir a cena
inteira sozinho (nenhum `subjects` explícito nunca é montado por ela para um lote novo; só existe
para "Copiar dados"/"Gerar de novo", que replica a cena de um criativo JÁ gerado).

### Limites reais por motor (`MULTI_PRODUCT_RULES`, `strategies.py`)

| Motor | Habilitado | Min | Max | Restrição adicional |
|---|---|---|---|---|
| `CLEAN_ANGLES` | sim | 2 | 6 | — |
| `REMARKETING` | sim | 2 | 5 | `product_view` é **só produto único** (`singleOnlyIntents`); `cart`/`checkout` multipeça exigem `products_source:"basket"` (carrinho/pedido real, não "vários produtos avulsos") |
| `FUNNEL_VISUAL` | sim | 2 | 6 | — |

Flag: `creative_multi_product` — já **auto-ligada** junto com `creative_generator` (nenhum eixo
comercial por capability desde a rodada que unificou o módulo, `flags.js`); a tela ainda precisa
checar `status.flags.creative_multi_product` (pode ser desligada via escape hatch de teste) antes
de oferecer o modo, mesmo padrão que a V1 já usa.

### Quem decide "quem veste o quê" — e quando isso é automático vs precisa de humano

`composition.explicit_subjects()`/`planner_v2.derive_subjects()` — **ambos** usam a MESMA regra
posicional por padrão quando o pedido não diz nada mais específico: **a i-ésima pessoa veste o
i-ésimo produto** (`products[i] if len(products) > 1 and i < len(products) else products[0]`).

O número de pessoas (`people_needed`) é:
- **`CLEAN_ANGLES`/`FUNNEL_VISUAL`**: sempre `== len(products)` quando o ângulo usa pessoa e há mais
  de 1 produto (`engines.py::plan_creative`, linhas 344/360) — a atribuição posicional é **sempre
  inequívoca por construção**: nunca sobra produto sem pessoa nem pessoa sem produto.
- **`REMARKETING`**: `people_needed` vem do LAYOUT escolhido (`ESPEC_LAYOUT[layout]["pessoas"][0]`,
  o MÍNIMO do intervalo do layout) — pode ser **0** (layouts flatlay: produtos exibidos sem
  ninguém vestindo, ex. `flatlay_grid`) ou **menor que o número de produtos** (ex.
  `hero_support_models` pede no mínimo 2 pessoas mesmo com 3 produtos selecionados). **Este é o
  único caso onde a atribuição automática pode deixar produto(s) sem pessoa** — não por erro, mas
  porque o layout real do motor não usa todo mundo vestindo.

`comp.recommend()` (a "Sugestão para esta estampa" de produto único) só funcia com **exatamente 1
produto** — para multipeça o "Sugestão" que a tela mostra é sempre o resultado de
`derive_subjects()`/atribuição posicional, nunca uma recomendação semântica por peça.

### Segurança infantil (`enforce_infant_wearers`, `composition.py`)

Estrutural, já roda dentro de `plan_creative` (logo em `/preview`, **antes** de qualquer chamada
paga): quem o PEDIDO escolheu explicitamente (`subjects` com `source:"user"`) vestindo uma peça
infantil incompatível com a faixa etária vira **erro** (`GenerationError`, nunca um prompt
contraditório); quem o PLANNER escolheu automaticamente é recastado (`infant_wearer_recast`) ou
simplesmente para de vestir a peça (`infant_wearer_removed`), com aviso — nunca falha para o
caminho automático. Duas crianças + peças infantis diferentes funciona (cada uma validada contra
sua PRÓPRIA peça); um adulto de apoio nunca precisa vestir nada (`product_use:"none"`,
`wears_product_id: null`).

### Custom Angle × multipeça

Já resolvido, motor-agnóstico, reaproveitado sem mudança: `custom_angle.allowed_product_modes`
(`_resolve_angle_id`, `engines.py`) barra um ângulo customizado incompatível com `multi_product`
antes de qualquer coisa (`UNSUPPORTED_ANGLE`).

### O que falta para a UI mostrar "quem veste o quê"

`planSummary()` (`requests.js`) hoje só expõe `people_count` (um número) — o plano real do core
**já calcula** o array `subjects` completo (`planner_v2.py::build`, campo `fields.subjects`, cada
item com `persona`, `role`, `product_id`, `relation_to_primary`, `age_band`...), só que
`planSummary()` não repassa isso. **Única extensão necessária**: expor um resumo desse array já
existente — nunca uma capacidade nova do core, só ler um campo que já está no plano. O formato
escolhido reaproveita `CenaPessoa` (já existe em `api/criativos.ts`, já usado por "Copiar dados") —
mesmo tipo, sem contrato duplicado.

## 2. Matriz de suporte real por motor (multipeça)

| Motor | Multipeça suportada | Faixa | Pode ficar sem pessoa | Observação |
|---|---|---|---|---|
| Ângulos Limpos | sim | 2–6 | só se a família não usa pessoa (`product_no_person`/`product_focus`) | atribuição sempre 1:1 |
| Remarketing | sim, com intent compatível | 2–5 | sim (layouts flatlay) | atribuição pode deixar produto sem pessoa — layout decide, não a tela |
| Funil por Criativo | sim | 2–6 | só se a família não usa pessoa | atribuição sempre 1:1 |

`product_view` (Remarketing) fica **só produto único** — não aparece como opção de intent quando
`product_mode=multi_product`, sem inventar um fallback que o core recusa.

## 3. UX implementada

Fluxo: **Motor → um ou mais produtos → objetivo (quando aplicável) → recomendação real via
`/preview` → Gerar assim, ou Personalizar.**

- **"2. Produto"** ganha um seletor de quantidade (Um produto / Multipeça, com a faixa real do
  motor) — mesmo padrão de rótulo da V1, checkbox vira multi-seleção respeitando o `max`.
- A prévia (mesma função `montarInput`, nunca duas cópias) mostra, quando há mais de 1 produto e o
  plano usa pessoa: uma lista simples "Pessoa 1 veste **Produto A**" / "Pessoa 2 veste **Produto
  B**" (rótulos de tela, nunca `age_band`/ids/JSON) — vinda de `preview.first.subjects`.
- **Personalizar → "Quem veste o quê"** só aparece quando `subjects.length >= 2`: um `Select` por
  pessoa (produto selecionado, ou "Sem peça — apoio"), pré-preenchido com a atribuição REAL que o
  core resolveu — nunca uma escolha em branco. Sem edição nenhuma, nada de `subjects` é mandado no
  request (o core decide, exatamente como no clique de 1 passo). Ao editar qualquer linha, TODAS as
  linhas passam a ir explícitas no request (round-trip do `persona` opaco que o próprio preview
  devolveu — nunca reconstruído à mão, mesmo mecanismo que "Copiar dados" já usa com `CenaPessoa`).
- Produto sem pessoa (família `product_no_person`/`product_focus`, ou intent/layout que não usa
  ninguém): a seção "Quem veste o quê" nem aparece — nenhum elenco forçado.

## 4. Request e prévia — mesma fonte de verdade, invariantes

`montarInput()` estendido (não bifurcado): `product_mode`/`product_ids` (array), `subjects`
(opcional, só quando personalizado). A troca de qualquer entrada relevante invalida a prévia e
reagenda a busca — resolvido de forma genérica na G.1 (§ do relatório G.1, efeito único com guarda
`ignorar` contra resposta assíncrona desatualizada); a extensão de G.2 só adiciona `productIds`/
`subjects` às dependências do MESMO efeito, sem um segundo mecanismo.

`custom_angle_replay_of` continua o único caminho de reuso histórico; nenhum objeto de Custom Angle
cru volta a ser aceito do navegador (inalterado desde D.1.1).

## 5. Casos de teste

Cobertos por `apps/panel/test/criativos-v2-multiproduto-input.test.js` (lógica pura, mesmo padrão
`.mjs` de G.1/F.2.B.1):

1. Produto único nos 3 motores: regressão do request da G.1 (idêntico, sem `subjects`).
2. Dois produtos adultos, sem edição: nenhum `subjects` no request (core decide).
3. Dois produtos infantis, edição explícita de "quem veste o quê": `subjects` completo, com
   `wears_product_id` correto por pessoa, `persona` preservado tal como veio da prévia.
4. Troca de motor com multipeça: `subjects`/objetivo limpos, produtos preservados.
5. `product_view` nunca aparece como opção de intent quando `product_mode=multi_product`.
6. Produto arquivado/sem referência: tratado pelo erro real do backend (`erro` state), nenhum envio
   silenciosamente incompleto — sem fixture que finja uma capacidade que não existe.
7. `product_name` (campo só de exibição) nunca sobrevive à montagem do request — achado real do smoke
   visual, ver "Aceite visual" abaixo.
8. `relation_to_primary`/`relation_label` nulos ficam ausentes (nunca `null` explícito) — segundo achado
   real do mesmo smoke visual.

## Aceite visual

Ambiente: mesmo padrão da G.1 — Postgres isolado (`TEST_PG_CONTAINER=oria-g2-smoke`), core Python real
(`python3 -m creative_core.service`), painel real (`node server.js`) com login real de sessão de teste,
BYOK **nunca configurada** (`status.openaiKey.configured=false`), então "Gerar assim"/"Gerar N
criativos" permaneceu estruturalmente desabilitado durante todo o teste — nenhuma chamada OpenAI, nem
por clique nem por engano. Dois produtos sintéticos locais (`Camiseta Listrada Smoke G2`,
`Camiseta Smoke G2`), nunca dados de cliente real.

Verificado ao vivo, contra o backend real (não mockado), inspecionando o request/response reais de
`/preview` via interceptação de `window.fetch`:

1. **Ângulos Limpos, multipeça, 2 produtos** — seleção, prévia com "Quem veste o quê" (atribuição
   posicional real do core, não inventada pela tela), "Personalizar" mostrando as duas linhas
   pré-preenchidas com a atribuição real.
2. **Remarketing, multipeça, 2 produtos, troca de motor a partir de Ângulos Limpos** — produtos e
   família de ângulo preservados; intent/texto resetados (regra G.1, reaproveitada); limite de produtos
   mudou corretamente de 2–6 para 2–5 (regra real do motor); "quem veste o quê" recalculado do zero
   (nenhum override do motor anterior vazou).
3. **Switch de cesta (`products_source: 'basket'`)** — aparece só quando `intent` é `cart`/`checkout`
   em multipeça; ligado, o request passou a levar `remarketing.products_source:"basket"`; prévia sem
   erro.
4. **Funil por Criativo, multipeça, mesma troca de motor** — produtos/estilo preservados, etapa
   resetada para TOFU (padrão), limite de produtos 2–6 (regra real do motor), sem erro.
5. **"Quem veste o quê" → "Sem peça — apoio"** — ver bugs abaixo; recuperado e reverificado ao vivo
   depois do fix, sem erro, com a Prévia refletindo corretamente "veste nenhuma peça (apoio)".

### Dois bugs reais encontrados e corrigidos nesta rodada

**Bug 1 — `product_name` vazava no request.** Ao editar qualquer linha de "Quem veste o quê", o
backend recusava com `"pessoas: campo desconhecido: product_name"`. Causa: `subjectsComOverride()`
espalhava (`...s`) o objeto inteiro devolvido pela prévia — que agora inclui `product_name` (novo campo
só de exibição, adicionado por esta própria rodada em `planSummary()`). Corrigido: a função monta o
objeto de saída campo a campo, só com a whitelist que o backend aceita (`requests.js::SUBJECT_KEYS`),
nunca por spread. Regressão coberta em teste (constrói um subject com `product_name` grudado e garante
que nunca sobrevive).

**Bug 2 — `relation_to_primary`/`relation_label` como `null` explícito.** Depois do fix do Bug 1, o
mesmo fluxo ainda falhava, agora com `"subjects[0].relation_to_primary: must not be null"` /
`"subjects[0].relation_label: must not be null"` (contrato `CreativeRequest` do core). Causa: diferente
de `wears_product_id` (o único campo com `nullable=True` em `contracts.py::RequestSubject` — `null` ali
É um valor válido, "sem peça"), `relation_to_primary`/`relation_label` (e, pelo mesmo contrato,
qualquer outro campo da whitelist) devem ficar **ausentes** quando não se aplicam — nunca `null`
explícito. `planSummary()` devolve esses campos como `null` quando o plano não tem essa relação (ex.:
sujeito `primary`, sem `relation_to_primary`), e a cópia campo-a-campo do fix do Bug 1 ainda copiava
esse `null` de forma explícita. Corrigido: a cópia agora omite qualquer campo (exceto
`wears_product_id`) cujo valor seja `null`/`undefined`. Dois testes de regressão cobrem isso: um confirma
que `null` vira ausência, outro que um valor real (`'child'`) continua preservado.

Os dois bugs só aparecem no fluxo de edição manual (`subjectsComOverride`), nunca no clique de 1 passo
sem edição (onde `subjects` nem é enviado) — por isso não haviam sido pegos pela suíte de testes escrita
antes da verificação visual; ambos ganharam teste de regressão dedicado depois do achado real.

### Limitações honestas desta rodada

- **Mobile 390px**: não reexercitado (mesma limitação já registrada na G.1 — `resize_window` não altera
  o viewport renderido neste ambiente).
- **Cenários de segurança infantil (produtos infantis reais)**: não exercitados ao vivo no navegador
  nesta rodada — exigiriam cadastrar produtos sintéticos do tipo infantil antes. A garantia estrutural
  (`comp.enforce_infant_wearers()` rodando dentro de `plan_creative`, antes de qualquer chamada paga;
  atribuição explícita incompatível vira `GenerationError` comprensível; atribuição do planner é
  recastada ou removida com aviso) foi verificada por leitura de código na inspeção da §1, não por teste
  ao vivo — registrado aqui como o que É e o que NÃO é evidência visual.
- **Produto arquivado/sem referência em multipeça**: não exercitado ao vivo (exigiria arquivar um
  produto de teste no meio do fluxo); o tratamento de erro do backend é genérico e já coberto por teste
  de unidade existente (não específico de multipeça).
- **Custom Angle + multipeça**: não exercitado ao vivo; a checagem de compatibilidade
  (`_resolve_angle_id`/`allowed_product_modes`, `UNSUPPORTED_ANGLE`) é código pré-existente,
  engine-agnóstico, não tocado nesta rodada — confirmado por leitura, não por clique.
- **Screenshots como arquivo**: diferente da G.1 (`docs/features/g1-smoke-evidence/`), esta rodada não
  salvou capturas como arquivo `.jpg` separado — as evidências acima vêm da inspeção direta do
  request/response reais de `/preview` (via `window.fetch` interceptado), que é a evidência mais precisa
  para os dois bugs encontrados (ambos são sobre o *conteúdo* do request, não o *visual* da tela). As
  telas foram revisadas via captura em sessão durante o trabalho, mas nenhum arquivo de imagem foi
  persistido no repositório para esta rodada — registrado aqui em vez de inventar uma captura.

## Resultado dos testes direcionados

Suíte segmentada (não a monolítica de ~1h — achado já registrado na G.1, harness ainda não corrigido):

| Suíte | Testes | Resultado |
|---|---|---|
| `test/criativos-v2-multiproduto-input.test.js` (novo, G.2) | 14 | ✅ todos passando |
| `test/creative-custom-angle-effect.test.js` (3 novos de `subjects` em `planSummary`) | 22 | ✅ todos passando |
| `test/criativos-v2-motor-input.test.js` (G.1, regressão) | 15 | ✅ todos passando |

`npx tsc -b --noEmit`: limpo. `npx vite build`: sucesso (`CriativosPage-CJ9lQWRy.js`).
`apps/creative-generator/creative_core/` (Python): **intocado nesta rodada** — os 546 goldens e a
validação visual da V1 continuam válidos sem re-execução.

## 6. Limitações e gate

- Multi-model layouts do Remarketing continuam podendo deixar produto sem pessoa (comportamento do
  motor, documentado, não uma lacuna desta tela).
- Gate: cobertura segmentada acima — **não repetida a suíte monolítica** (achado documentado na G.1,
  harness ainda não corrigido). Limitações não exercitadas ao vivo estão listadas em "Aceite visual"
  acima; nenhuma foi apresentada como testada sem ter sido.
