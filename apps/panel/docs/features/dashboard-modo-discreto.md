# Visão geral — modo discreto (ocultar valores) e pente-fino visual

Entrega empilhada sobre a Fase 1 visual (PR #52). Só a Visão geral (`/admin/dashboard`) mudou;
nenhuma rota, API, cálculo ou dado do backend foi alterado.

## Modo discreto

- **Um botão só**, com ícone de olho / olho cortado, no cabeçalho ao lado do período. O tooltip e o `aria-label` dizem "Mostrar valores" (oculto) ou "Ocultar valores" (visível). Funciona por teclado (Tab + Enter/Espaço) com o foco padrão do DS. Os ícones `eye` e `eye-off` foram adicionados ao conjunto único `icons.ts`, sem dependência nova.
- **Primeira visita = oculto.** Depois, vale a última escolha.
- **Sem blur:** o número não é renderizado. No lugar entra um marcador de largura estável (`R$ •••••`), com "valor oculto" só para leitor de tela. O valor não aparece em `title`, `aria-label`, `data-*` nem em tooltip.
- **Implementação:**
  - `src/state/modoDiscreto.ts`: funções puras de persistência.
  - `src/pages/dashboard/ModoDiscreto.tsx`: provider, hook `useModoDiscreto`, `ValorOculto` e o botão.
  - `KpiCard` ganhou a prop opcional `oculto`. É retrocompatível: sem ela, nada muda nas outras telas.

### Persistência

- A preferência fica no `localStorage`, na chave `oria.dashboard.valores.v1:<userId>:<organizationId>`, com valor `oculto` ou `visivel`. Nada além disso é gravado: nem número, nem nome, nem token.
- Sobrevive a navegação, refresh, logout e novo login **na mesma conta, no mesmo navegador**. Outra conta ou outra Organization no mesmo navegador começa oculta.
- **Não sincroniza entre navegadores ou dispositivos:** não existe preferência de usuário no servidor hoje, e a tela não promete "salvo na conta".
- A leitura é síncrona no primeiro render. Sem identidade resolvida, sem preferência ou com o armazenamento bloqueado, a tela começa oculta. Com o armazenamento bloqueado, a troca vale em memória enquanto a aba estiver aberta, sem erro.
- É privacidade **visual**: quem tem acesso à conta ou às respostas de rede continua vendo os dados.

### Matriz: ocultado × visível

| Área | Oculto no modo discreto | Continua visível |
|---|---|---|
| Indicadores de hoje | Receita estimada (valor, delta e sparkline) | Pedidos hoje (com delta), carrinhos recuperáveis, taxa de recuperação, pedidos com atenção |
| Resultado do período | Faturamento, receita líquida, custo de produção, mídia, lucro após mídia / lucro bruto; deltas financeiros; "% da receita líquida"; margem; sparkline do lucro; barra de decomposição (vira trilho neutro, "Proporções ocultas") | Nº de pedidos pagos, rótulos, "Retido pela Reserva Ink", estado da mídia ("Não entra na conta" + aviso) |
| Gráfico "Faturamento e lucro" | Linhas de faturamento e lucro bruto, área, eixo em reais, valores do tooltip | Barras de pedidos por dia, eixo de contagem, tooltip com nº de pedidos, legenda "Valores ocultos" |
| Status dos pedidos | — | Donut e contagens por etapa |
| Recuperação via WhatsApp | Receita recuperada | Mensagens enviadas, taxa de conversão, conversões, mensagens por dia |
| Lucro por produto/modelo | Lucro bruto, lucro por peça, barras proporcionais, `aria-label` com a fatia; a ordenação passa a ser por peças (a ordem por lucro revelaria o ranking) | Nomes, peças, abas Produto/Modelo (título vira "Peças por produto") |
| Fluxo de pedidos, dia da semana, horários | — | Todos (contagens) |
| Carrinhos quentes | Valor do carrinho | Nome, itens, tempo, botão WhatsApp |
| Últimos pedidos | Coluna Valor | Cliente, status, data, ações (o link copiado é o da hotpage, sem valor) |
| Avisos | — | Todos (contagens) |

Não é anonimização: nomes e telefones de clientes continuam visíveis. Se isso for necessário, é uma melhoria separada.

## Pente-fino

1. **Gráficos "vazios" — sem defeito reproduzido.** Com API simulada, os 4 gráficos (faturamento e lucro, status, dia da semana, horários) desenham SVG com carregamento normal, com CPU 6× + rede lenta e com reduced motion. Duas situações reproduzem o sintoma:
   - **Captura feita durante o carregamento:** os cards ainda são skeletons (`qa/graficos-captura-imediata.png`).
   - **Período sem pedidos:** os cards mostram o estado vazio com texto; nenhuma série é inventada.
2. **Marca/topo "sobrepostos" — artefato de captura.** A sidebar e o topo são fixos na janela. Numa captura de página inteira feita depois de rolar, eles aparecem "carimbados" no meio do conteúdo (`qa/fullpage-apos-rolar-1440.png`). Na navegação normal não há sobreposição, inclusive com nome de produto longo em 1440 e 1024px (reticências, sem invadir o símbolo).
3. **Dois avisos âmbar seguidos:** o de carrinhos virou `info` (oportunidade), e o de problema de pagamento continua em âmbar. A ordem de urgência é: falha de integração (vermelho) > pagamento (âmbar) > carrinhos (ciano). Os CTAs foram mantidos.
4. **Recuperação via WhatsApp sem histórico:** com o WhatsApp da loja não conectado, a tela mostra "WhatsApp ainda não conectado" e o botão "Configurar WhatsApp" (Integrações). Com ele conectado e sem eventos, explica quando o histórico aparece. Nada afirma bloqueio.
5. **Rótulos financeiros:** a série do gráfico e o ranking por produto usam `lucroOperacional`, que é venda − custo de produção, **antes** da mídia e das despesas. É o mesmo número do KPI "Lucro bruto". A legenda, o tooltip e o card diziam "Lucro operacional" e passaram a dizer **"Lucro bruto"**. Nenhum cálculo mudou.
6. **Frescor:** o cabeçalho mostra "financeiro sincronizado há X" (campo `sincronizadoEm`, que a API já devolvia) em vez de sugerir tempo real.
7. **Hierarquia:** o lucro após mídia continua como destaque da tela.

## Evidências (QA local, dados 100% sintéticos)

Script Playwright com API simulada no navegador. Resultado: 33/33 PASS.

- 1ª visita, com a API lenta: nenhum "R$ + dígito" em texto ou atributo **em nenhum momento** (um MutationObserver vigia desde o primeiro nó), e nada é gravado antes da escolha.
- Tooltip do gráfico oculto: só nº de pedidos. Visível: faturamento e lucro bruto.
- Teclado: Enter no olho alterna. Refresh mantém a escolha. Chave gravada: `oria.dashboard.valores.v1:u1:o1 = visivel`.
- Outra conta no mesmo navegador: começa oculta, sem flash. Ao voltar à conta original, a preferência dela está preservada.
- `localStorage` bloqueado: carrega oculto, alterna em memória, sem erro de página.
- 768, 390, 360, zoom 200% e reduced motion: sem overflow, oculto e visível.
- Suíte sem banco: 1435/1435. Novos testes de persistência em `test/invariants/dashboard-modo-discreto.test.js` (7 casos), com controle negativo: padrão invertido e chave sem Organization reprovam.
- O modo discreto não faz nenhuma chamada de rede nova.

## Próximos passos (fora deste escopo, baixo risco)

- Sincronizar a preferência entre dispositivos se um dia existir preferência de usuário no servidor.
- Estender o modo discreto a Financeiro, Meta Ads (Resultado) e Desempenho de produtos, reutilizando `useModoDiscreto`/`ValorOculto`.
- Ocultação opcional de PII (nome e telefone) como recurso separado.
- Estado de carregamento da Visão geral com skeletons no formato exato dos novos blocos.
