# Gerador de Criativos V2 — backlog (não bloqueante)

Achados registrados durante o desenvolvimento que não impedem o uso e foram deliberadamente
adiados, para não abrir novas microfases de validação. Cada item cita onde foi encontrado.

- **Avisos do plano aparecem como código cru na UI**, exceto `geographic_context_unresolved_used_niche_context`
  (traduzido no hotfix do primeiro uso real). Os demais (`people_count_risk:5`,
  `above_recommended_products_for_angle:4`, `layout_fallback_angle_not_compatible`, etc.) continuam
  crus — corretos e já visíveis (não escondidos), só não traduzidos. `textoAviso()` em
  `criativosMotorInput.mjs` já existe para isso; é só ir acrescentando entradas conforme aparecem
  reclamações reais, nunca traduzir tudo de uma vez "por precaução". (G.2.1; ampliado no hotfix do
  primeiro uso real.)
- **Famílias de estilo sem NENHUM preset disponível para a marca continuam aparecendo como cartões
  clicáveis normais** (ex.: "Creator / social" para a Use Origens, que não libera nenhum preset dessa
  família) — ao clicar, a prévia falha com uma explicação real e específica (não mais o erro genérico
  antigo, e a prévia anterior não fica mais visível por baixo — ambos corrigidos no hotfix do primeiro
  uso real), mas o cartão em si não avisa ANTES do clique. Desabilitar/marcar esses cartões de antemão
  exigiria expor disponibilidade por família no catálogo (`GET /catalog`), calculada contra o Brand
  Kit ativo — deliberadamente adiado: o core já nunca recomenda nem aceita silenciosamente um ângulo
  indisponível (achado e corrigido nesta mesma rodada), então o que falta aqui é só descoberta
  antecipada na UI, não uma lacuna de segurança ou de dado incorreto. (Hotfix do primeiro uso real,
  24/09.)
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
- **`test_enrichment.py`/`test_enrichment_openai.py` (F.2.B.1) rodam sob `run_tests.py` só como "importa
  sem quebrar"** — o runner chama cada suíte como script solto (`python3 suite.py`) e só olha o exit
  code; como essas duas são pytest-style puro (sem `run()` no fim, ao contrário de toda outra suíte),
  suas asserções nunca foram de fato coletadas/executadas por ele, antes ou depois do fix de CI desta
  rodada (que só resolveu o import quebrado). Rodar de verdade exige `pytest` de fato (coleção), não
  só o módulo instalado — mudança maior no runner, fora do escopo de um hotfix de CI. (Achado na
  integração do Gerador V2, ao investigar a primeira falha real de CI do branch.)
