# Dashboard (Visão geral) — proposta visual e Fase 1

Frente aberta junto com a Home V3: deixar o painel mais maduro e coerente com a nova home, sem quebrar
o design system. Regras novas documentadas em `DESIGN.md › Evolução visual 2026-09`.

## Diagnóstico (antes)

1. **Valores cortados no Resultado do período.** Seis células numa linha só: em 1440px com a sidebar aberta, "R$ 38.233,…", "R$ 18.346,…" e "R$ 10.965,…" apareciam truncados (captura com dados sintéticos).
2. **O número mais importante não tinha hierarquia.** "Lucro após mídia" tinha o mesmo peso de "Receita líquida".
3. **Cabeçalho prometia "tempo real"**, mas o webhook da Reserva Ink está desligado em produção e os pedidos chegam por sync. O texto foi corrigido.
4. **Superfícies totalmente planas** e gráfico principal sem ênfase na série de faturamento.

## Fase 1 (implementada neste PR, só na Visão geral)

- **Resultado do período reestruturado.** As saídas ficam numa grade de 4 células (2×2; 4×1 em telas muito largas): faturamento, receita líquida, custo de produção e mídia. O resultado ganha um bloco de destaque com valor grande, margem, delta e tendência.
- **Estado honesto de mídia.** Sem conta de anúncios da loja, a célula diz "Não entra na conta" e o destaque vira "Lucro bruto" com aviso. Prejuízo aparece em `danger`.
- **Barra "para onde foi o faturamento"** (frete e descontos, produção, mídia, sobra) com percentuais. A função pura `decomposicaoResultado.ts` é coberta por `test/invariants/dashboard-decomposicao.test.js` (mídia desconhecida não vira fatia; prejuízo não gera fatia negativa).
- **Profundidade mínima** dos painéis (`--shadow-painel`) e brilho só no resultado (`--glow-resultado`).
- **Movimento sutil**: os valores assentam em 240ms e a barra cresce uma vez. Tudo zerado por `prefers-reduced-motion`.
- **Gráfico principal**: área suave sob o faturamento e eixo de valor mais largo (o rótulo "R$ 2,2 mil" quebrava linha).

## Fase 2 (proposta)

1. **Promover ao DS** o que se provar na Visão geral: `--shadow-painel` em `.ds-card` e `.ds-kpi-strip`, e o bloco de destaque como variante de `KpiStrip` (`destaque`).
2. **Aplicar a mesma leitura de resultado** onde há resultado: aba Resultado do Meta Ads (DRE), Financeiro e Desempenho de produtos.
3. **Tema único de gráficos** com a área da série principal (`chartTheme.ts`), tooltip com o mesmo acabamento e legenda clicável para esconder séries.
4. **Cabeçalho da página** com a hora da última sincronização (dado já existe: `sincronizadoEm`), em vez de qualquer promessa de "tempo real".
5. **Estados de carregamento** com skeleton no formato exato do novo Resultado e transição suave skeleton → dado.
6. **QA visual automatizado** (captura com API simulada, como a usada nesta rodada) no CI, para pegar truncamento de valor e overflow.
