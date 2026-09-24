# Gerador de Criativos V2 — backlog (não bloqueante)

Achados registrados durante o desenvolvimento que não impedem o uso e foram deliberadamente
adiados, para não abrir novas microfases de validação. Cada item cita onde foi encontrado.

- **Avisos do plano aparecem como código cru na UI** (ex.: `people_count_risk:5`,
  `above_recommended_products_for_angle:4`, `layout_fallback_angle_not_compatible`). Corretos e já
  visíveis (não escondidos), só não traduzidos para texto amigável. (G.2.1, smoke visual desktop.)
- **Lista de abas (`Gerar · Lotes · Histórico · Produtos · ...`) não cabe em ~590px** — precisa
  rolar horizontalmente dentro da própria lista; não quebra a página (sem scroll horizontal geral),
  só não é óbvio que há mais abas fora da tela. (Aceite visual mobile, G.2.1.)
- **`resize_window` (ferramenta de automação) não reproduz 390px neste ambiente** — o mais estreito
  alcançado foi ~591px. O aceite mobile desta rodada foi feito nessa largura (suficiente para
  confirmar reflow/sem overflow), não exatamente na largura de um iPhone. Limitação da ferramenta,
  não do produto — repetir com um dispositivo real antes do lançamento amplo, se possível.
- **Suíte monolítica de goldens (~1h) ainda não roda no harness atual** (achado original da G.1) —
  V1/core Python seguem intocados por esta e pelas rodadas anteriores, então o risco de regressão
  real é baixo, mas o gate formal completo continua pendente para antes de um lançamento amplo
  (fora desta conta interna).
