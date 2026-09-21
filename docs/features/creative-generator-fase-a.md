# Creative Generator V2 — Fase A (trace, referências, prompt V2)

Branch `feature/creative-fase-a` (a partir de `origin/main` `c57aa29`). Escopo autorizado: A1, A2, A3 + harness de A/B **preparado, não executado**. Não inclui CreativePlan V2, Subjects, UI V2 nem Mockups. Base: [`creative-generator-v2-audit.md`](./creative-generator-v2-audit.md).

## Commits

| # | Commit | O que muda |
|---|---|---|
| 0 | `test(creatives): golden hashes for prompt v1` | Rede de segurança: sha256 de 546 prompts V1 (7 fixtures × 13 ângulos × 2 formatos × 3 seeds), capturados **antes** de qualquer mudança |
| A1 | `feat(creatives): record a generation trace per attempt` | Trace observacional + migration `0031-creative-trace` |
| A2 | `feat(creatives): opt-in reference normalization` | PNG real, EXIF, sem resize, atrás de `CREATIVE_NORMALIZE_REFERENCES` |
| A3 | `feat(creatives): prompt v2 for person angles behind a flag` | `PROMPT_VERSION=2` para 4 ângulos com pessoa, atrás de flag |
| A7 | `chore(creatives): a/b harness for the anatomy regression (dry run)` | Harness dos 4 braços (+ E opcional), só dry-run por padrão |

## Flags novas (todas desligadas por padrão)

| Flag | Onde | Efeito |
|---|---|---|
| `CREATIVE_NORMALIZE_REFERENCES` (`1`/`true`/`yes`/`on`) | serviço `oria-creatives` | Padrão de `POST /v1/generations`: cada referência é decodificada, ganha orientação EXIF e é regravada como PNG real (sem resize). A requisição pode sobrescrever com `normalize_references` (boolean) |
| `CREATIVE_PROMPT_VERSION` (`1`/`2`) | serviço `oria-creatives` | Padrão de `POST /v1/plans` quando o request não traz `prompt_version`. Qualquer outro valor vale `1` |
| `prompt_version` (`1`/`2`) | campo do `CreativeRequest` | Escolhe a versão por plano; vence o padrão do serviço |
| `CREATIVE_PROMPT_V2_ORGS` | painel (`oria-panel`) | Lista de ids de Organization (ou `*`) para as quais o painel manda `prompt_version: 2`. Fora da lista o painel não manda nada. **Rollout por Organization**, sem passar por entitlement: não é feature comercial nem module capability |

Os dois lados são independentes e comparáveis: `CREATIVE_NORMALIZE_REFERENCES` liga/desliga só a referência; `prompt_version` liga/desliga só o prompt. É o que permite os braços B/C do A/B.

## Migration

`0031-creative-trace` (`migrations/sql/0031-creative-trace.{up,down}.sql` + `1790001600000_creative-trace.js`). Aditiva, sem backfill, reversível:

`creative_generations` + `generation_trace JSONB`, `model_served TEXT`, `duration_ms INTEGER`, `provider_request_id TEXT`.

Convenção do repo mantida: os três testes que listam as migrations em ordem (`migrations`, `inv-td003-postgres-obrigatorio`, `r19-runbook-dry-run`) foram atualizados.

## A1 — trace

`generate_creative` devolve `metadata.trace`; o worker grava em `creative_generations.generation_trace` **por tentativa** (chave = nº da tentativa) e espelha `model_served`, `duration_ms`, `provider_request_id` da tentativa mais recente em colunas. A rota de itens devolve `trace` (tentativa atual). O trace nunca contém o texto do prompt nem a chave.

Campos: `model_requested`, `model_served`, `models_tried`, `params{size,quality}`, `prompt{sha256,version,length}`, `references{count,normalized,items[]}`, por referência `original_mime`, `sent_name`, `sent_mime` (o que foi **anunciado**), `sent_actual_mime` (o que os bytes **são**), `original_bytes`, `sent_bytes` e, se normalizada, dimensões/modo/orientação EXIF; `provider_request_id`, `provider_ms`, `duration_ms`, `outcome`, `error_code`, `attempt`.

`ModelRouter.run` mantém o comportamento; `run_traced` também devolve qual candidato respondeu.

Exemplo de linha **persistida** (gravada pelo `pgStore` e pelo worker reais num Postgres efêmero, com core e provedor de teste; a tentativa usou o modelo de fallback e uma referência JPEG normalizada):

```json
{
 "status": "completed",
 "generation_attempt": 1,
 "model_served": "gpt-image-1",
 "duration_ms": 48,
 "provider_request_id": "req_8f3a2c19d0b74e",
 "prompt_version": null,
 "modelo_imagem": "gpt-image-2",
 "generation_trace": {
  "1": {
   "params": {
    "size": "1088x1360",
    "quality": "medium"
   },
   "prompt": {
    "length": 5160,
    "sha256": "1a992e48bc694266902be565712e38f9d9ba48334461f2d8b06df419f62dfda7",
    "version": 2
   },
   "attempt": 1,
   "outcome": "completed",
   "error_code": null,
   "references": {
    "count": 1,
    "items": [
     {
      "order": 1,
      "width": 1200,
      "height": 900,
      "mode_in": "RGB",
      "mode_out": "RGB",
      "sent_mime": "image/png",
      "sent_name": "reference_1.png",
      "normalized": true,
      "sent_bytes": 5151,
      "original_mime": "image/jpeg",
      "original_bytes": 17730,
      "exif_orientation": 1,
      "sent_actual_mime": "image/png"
     }
    ],
    "normalized": true
   },
   "duration_ms": 48,
   "provider_ms": 0,
   "model_served": "gpt-image-1",
   "models_tried": [
    "gpt-image-2",
    "gpt-image-1"
   ],
   "trace_version": 1,
   "model_requested": "gpt-image-2",
   "provider_request_id": "req_8f3a2c19d0b74e"
  }
 }
}
```

## A2 — referências

`assets.normalize_reference_png`: decode → `exif_transpose` → PNG. Não redimensiona. Limita pixels decodificados (50 MP; o teto de 10 MB de bytes não limita isso). Referência ilegível **falha o item antes da chamada** (`INVALID_REFERENCE`): sem fallback silencioso, para não contaminar o braço "normalizado". Com a flag desligada, os bytes originais seguem exatamente como antes, e o trace mostra o descompasso (JPEG anunciado como `image/png`).

Efeito colateral a acompanhar: um JPEG fotográfico regravado como PNG fica maior (o trace mostra `original_bytes` × `sent_bytes`).

## A3 — prompt V2

Muda **apenas** os blocos `angle` e `persona` de `CAIMENTO`, `PRESENTE_AFETO`, `CREATOR_STYLE` e `LIFESTYLE_COTIDIANO`, e só em planos `CLEAN_ANGLES`/`FUNNEL_VISUAL` com pessoa no quadro. Todo o resto é idêntico ao V1 (o teste compara seção a seção). O plano informa a versão que **de fato** usou: um ângulo fora do conjunto, `REMARKETING` ou plano sem pessoa reporta `1`.

O que o V2 faz, sem regra negativa genérica de anatomia (há teste proibindo "dedo", "anatomi", "extra finger" etc.):
- **uma ação por cena**, escolhida no plano (determinística, pela seed), não pelo modelo de imagem;
- **onde ficam braços e mãos**, dito como o que está visível ("relaxados ao lado do corpo", "uma mão apoiada no balcão"), não como proibição;
- **papel de cada pessoa**: nenhum template diz "duas pessoas" e deixa uma implícita;
- **precedência**: o bloco de persona diz que pose, ação e enquadramento do ângulo sempre vencem. Além disso, a persona complementa o ângulo **somente com atributos compatíveis**: cláusulas de `behavior` que contradizem uma instrução explícita do ângulo (ex.: "em movimento" sob a pose parada do CAIMENTO) são **omitidas na compilação** (`behavior_drop` em `angles_v2.json`, casamento sem acento e por início de palavra, por cláusula), não ressalvadas com "só se não contrariar". Se não sobra nada, a frase "Jeito natural" some. Só o `behavior` é filtrado; aparência, estilo e notas da persona não.

### Portado × redigido

O que veio do gerador interno (validado visualmente) e o que foi escrito para o V2. Isto está registrado também em `templates/angles_v2.json` (`_authored`).

| Ângulo | Portado do Streamlit | Redigido no V2 |
|---|---|---|
| CAIMENTO | Cena inteira: enquadramento, braços "NUNCA cruzados", barra fora da calça, prioridade visual 1–7, "NÃO mostrar mexendo/ajeitando/puxando/segurando", sem óculos/pose editorial; versão de grupo (medium shot, torso e estampa) | "e sem objetos nas mãos"; "ninguém segurando nada" (grupo) |
| LIFESTYLE_COTIDIANO | Objetivo, as 6 situações, "câmera não perfeitamente alinhada / NÃO ensaio", "pessoa parada olhando para um ponto fixo" evitado; versão de grupo | A cláusula de mãos de cada situação; "apenas essa pessoa em quadro; no máximo um objeto simples"; "braços soltos" (grupo) |
| CREATOR_STYLE | As 3 variantes de foto (selfie de espelho, foto de amigo, braço estendido), os 12 celulares concretos sem marca, "PROIBIDO review/depoimento/unboxing"; versão de grupo | A posição das mãos em cada variante; "no máximo UM celular em cena" (grupo) |
| PRESENTE_AFETO | O embrulho ("tecido, papel kraft, fita de algodão"), "afeto genuíno e contido…", "NINGUÉM veste" na cena de presente | **A cena inteira**: Pessoa A/B, quem veste, quem entrega/recebe, ação principal, posição das mãos. O template interno diz "escolha UMA das duas" e deixa a escolha ao modelo; o V2 escolhe no plano e renderiza só a escolhida. O kit (multiproduto) proíbe pessoas e mãos visíveis (o interno admitia "mãos entregando") |

## Decisões descobertas na implementação

1. **Trace por tentativa dentro de um JSONB**, com colunas escalares para a última. Mantém a porta aberta para a tabela `creative_id + attempt` da Fase H sem depender dela e sem tocar em `creatives/<id>/image.png` (o storage de assets **não** foi alterado nesta fase; nada novo depende de um único asset por criativo).
2. **`sent_mime` × `sent_actual_mime`** no trace: o descompasso (D2) fica visível em qualquer geração, com a flag ligada ou não.
3. **V2 não se aplica a `REMARKETING`.** Ali o layout já define quantas pessoas e onde; uma cena V2 com elenco próprio contradiria o layout. Também não se aplica a plano sem pessoa (layout só-produto).
4. **`PRESENTE_AFETO` multiproduto vira kit sem pessoas** no V2 (persona `null`). No V1 o mesmo plano pedia N pessoas no bloco de persona e um "kit" na cena, uma contradição.
5. **Regra de peça infantil estreitada só na cena de presente V2.** "O MODELO da cena é SEMPRE uma criança" vira "Quem VESTE a peça é SEMPRE uma criança", porque a cena tem um adulto e uma criança. É o acoplamento C3 da auditoria, resolvido só no ponto necessário; a solução geral é da Fase C (Subjects).
6. **A seed não inclui `prompt_version`.** V1 e V2 do mesmo request escolhem a mesma cena, persona e itens de pool: um A/B entre versões muda o prompt e mais nada. O `plan_id` continua diferindo.
7. **Falha fechada na normalização** (ver A2).
8. **O rollout por Organization é env do painel, não entitlement.** O repo separa feature comercial, module capability e connector capability; um interruptor de experimento de qualidade não é nenhuma das três.
9. Ordem de deploy: **Python antes do Node** (o serviço rejeita campos desconhecidos; `prompt_version` e `normalize_references` são novos). Com todas as flags desligadas, nada muda de comportamento.
10. O trabalho foi feito em um `git worktree` (`../oria-creative-fase-a`), porque o checkout principal troca de branch sob sessões paralelas. Branch sem upstream, sem push.

## A/B (harness pronto, não executado)

`apps/creative-generator/scripts/ab_harness.py`. Braços: **A** prompt Streamlit + PNG normalizado · **B** Oria v1 + bytes originais · **C** Oria v1 + PNG normalizado · **D** Streamlit + bytes originais · **E** (opcional) Oria v2 + PNG normalizado.

```bash
cd apps/creative-generator
# dry run: escreve só o manifest, nada é enviado
python scripts/ab_harness.py plan --out ab_run --reference arte.jpg \
  --streamlit-golden ../../../estamparia-criativos/app_tests/golden/internal_prompts.json --arms ABCDE
# execução paga: exige --execute, CREATIVE_AB_ALLOW_PAID=1 e uma chave dedicada
CREATIVE_AB_ALLOW_PAID=1 CREATIVE_AB_OPENAI_API_KEY=... python scripts/ab_harness.py run --out ab_run --reference arte.jpg \
  --streamlit-golden … --execute
python scripts/ab_harness.py report --out ab_run   # depois de preencher ratings.csv às cegas
```

Todas as imagens passam por `generate_creative` (mesmo caminho da produção), então cada uma tem trace. Os braços Oria usam a mesma seed por índice. A planilha de avaliação é cega (o braço fica em `key.json`, separado). Teto padrão de 80 imagens por execução.

## Pendências operacionais (não bloqueiam a Fase A)

- Conferir no serviço `oria-creatives`: `OPENAI_IMAGE_MODEL` e `OPENAI_IMAGE_MODEL_FALLBACKS`. A leitura via Railway CLI foi negada pelo classificador de permissões e não foi contornada. Depois desta fase, `metadata.trace.model_served` mostra qual modelo respondeu de fato.
- Autorizar (ou não) o A/B pago.

## Regras de produto registradas para as próximas fases (sem implementação nesta)

- **Escopo Organization + Store opcional.** Todo registro tem `organization_id`; recurso que possa ser específico de uma loja também tem `store_id NULL`-able (`NULL` = compartilhado pela Organization). Dentro de uma Store a UI mostra os recursos da Store **e** os compartilhados; cadastro novo dentro de uma Store nasce **Store-specific**, com opção explícita de compartilhar. Vale para Brand Kit, Niche Kit, Personas, Ângulos customizados e Mockup Recipes; produto vindo de connector é obrigatoriamente da Store de origem; ângulos `system` são globais e ficam fora do escopo de tenant. As migrations futuras (`creative_angles`, `creative_profile_versions`, receitas, `creative_products`) já devem nascer com `store_id UUID NULL` + FK composta como nas migrations 0025–0029, para não haver uma segunda migração estrutural.
- **QA** é governado por policy, não "sempre ligado". Modo **observação** primeiro (anatomia, contagem de pessoas, objetos fundidos, texto indesejado, fidelidade de produto/estampa, composição); retry automático só depois de validar contra conjunto rotulado. Regra desejada: `pose_risk=low` QA opcional; `medium/high` QA ligado por padrão; no máximo 1 retry; o tenant pode desligar por custo.
- **Pessoas:** V1 suporta até **4**. 1–2 normal; 3 = warning de risco; 4 = composição avançada/`high`, nunca sugerida automaticamente como "segura"; 3–4 favorecem poses simples e forçam QA quando ele existir.
- **Crianças e famílias:** suportadas como categoria comercial (a Entre Nós depende delas), modeladas estruturalmente: relação adulto/criança explícita no plano quando há interação relevante; referência de produto nunca serve de identidade facial de criança (referência externa com criança serve só para composição/blueprint/estilo); vestuário apropriado à idade; nada revelador ou sexualizado; contato físico só em situações familiares/cotidianas coerentes com a relação declarada; contexto restrito a uso comercial de vestuário (família, brincadeiras, rotina, passeios, estudo, leitura).
