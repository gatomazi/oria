# Gerador V2 — Oferta/Promoção + multi-wearer (Funil por Criativo)

Escopo: evolução do motor existente `FUNNEL_VISUAL` (nenhum motor novo). V1 intacta (546 goldens verdes).

## Contrato

**Preset** — `FunnelOptions.preset: "promo_offer"`. Reaproveita os campos do Funil: Oferta = `headline`,
Benefício = `benefits`, CTA = `cta`, Apoio = `subheadline`. Único campo novo: `FunnelOptions.discount` (o maior texto
da peça: "15% OFF", "A partir de R$ 199"). Nenhum desses campos tem padrão no preset — o core nunca inventa oferta.
Regras: exige ao menos um texto de oferta; recusa `TOFU` (a regra TOFU proíbe desconto/cupom na arte), `clean_mode`,
selos/chips/busca; `discount` fora do preset é recusado. A UI manda o preset sempre com `BOFU`.
Plano: `overlay.preset`/`overlay.discount` e `layout` = `promo_offer_split` (Feed 4:5) ou `promo_offer_stacked`
(Story 9:16) — ausentes em qualquer plano sem preset.

**Multi-wearer** (uma peça, várias pessoas — não é multipeça):
- explícito: `subjects[i].wears_product_id` com o mesmo id em mais de uma pessoa (já aceito antes);
- automático: `CreativeRequest.multi_wearer = {group: one|pair|family, share: auto|all|primary_only}` (só plano v2;
  ignorado com aviso quando há `subjects` explícitos ou o ângulo é só-produto);
- no plano: `composition.multi_wearer = true` + `composition.wearers_by_product = {product_id: [subject ids]}`
  (derivado dos subjects, ausente quando ninguém compartilha); `composition_source = "recommended"`;
- compiler v4: linha "MESMA PEÇA EM VÁRIAS PESSOAS" no contrato de pessoas — esclarece a regra "nunca duplique
  produtos" (cada pessoa veste sua unidade da mesma peça). v1–v3 continuam recompiláveis byte a byte.

Segurança infantil: peça infantil nunca é oferecida a adulto no elenco automático; `enforce_infant_wearers` continua
rodando depois como guarda; adulto explícito vestindo peça infantil continua sendo erro. Versões adulto + infantil
são produtos distintos (multipeça): adultos recebem a adulta, a criança a infantil.

## UI (GerarTabV2)

"3. Objetivo" ganha **Oferta / Promoção** ao lado de TOFU/MOFU/BOFU, com 4 campos inline (Oferta, Desconto ou preço,
Benefício, CTA). "4. Quem usa a peça?" (Automático / Uma pessoa / Duas pessoas / Família), com "Usar a mesma peça em
mais de uma pessoa" para 2+ pessoas. Apoio e ênfase do CTA ficam em Personalizar. Prévia: Preset, Pessoas, Uso,
Quem veste o quê, Oferta, Desconto, Benefício, CTA — sempre lidos do plano real. Prévia e geração continuam usando o
mesmo `montarInput()` na tela e o mesmo `prepararLote()` no servidor.

## Testes

- core: `creative_core/tests/test_promo_multi_wearer.py` (17) + `run_tests.py` 22/22 suítes;
- painel: `test/criativos-v2-promo-multi-wearer.test.js` + regressão G.1/G.2/custom angle/persona/feedback/core;
- `tsc -b --noEmit` limpo, `vite build` ok.

## Smoke (sem geração paga)

Core Python real (HTTP) + rotas reais de criativos do painel com memoryStore (sem Postgres/Docker na máquina) e SPA via
Vite com sessão fake só no harness local. BYOK nunca configurada: `/jobs` devolveu 409 antes de qualquer chamada
OpenAI. Verificados request enviado ao core, prévia e prompt de: Entre Nós família de 3 com a mesma peça, Use Origens
uma pessoa (Story), peça infantil com família (adultos como apoio).

## Limitações

- A seed é sorteada a cada request (comportamento existente, em qualquer cena): a persona escolhida do pool pode
  mudar entre a prévia e a geração. A estrutura (quantas pessoas, quem veste a peça, oferta) é a mesma; para fixar
  também as personas, editar "Quem veste o quê" manda o elenco explícito.
- Qualidade real da composição (texto fora de rostos/estampa) só se confirma gerando imagem — não feito (pago).
