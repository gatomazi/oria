# Clientes 360°, RFM e campanhas — Fase 0 (auditoria) e estado da rodada

Data: 2026-09-23 · Branch `feature/clientes-rfm` · Brief: `oria_clientes_rfm_campanhas.md`.
Referência funcional: painel da Reserva Ink (capturas) — **nada foi copiado**: visual, regras e nomes são do Oria.
Fonte de dados verificada no repositório; nenhum dado do painel Ink foi usado, e nenhum endpoint foi presumido.

## 1. O que existia

| Peça | Onde | Observação |
|---|---|---|
| Página Clientes | `src/pages/clientes/ClientesPage.tsx`, `src/api/clientes.ts` | lista paginada no servidor; sem indicadores, RFM nem drawer |
| Lista/filtros | `lib/clientes/lista.js` (`GET /api/admin/clientes/lista`) | busca, ordem, inatividade, `tipo` (com pedido / só cadastro) |
| Cadastro Ink | `lib/clientes/cadastro.js` → `GET /v1/stores/customers` | remoto, paginado, cache 5 min por Store |
| Agregado por cliente | `buscarClientesAgregados()` (server.js) | union-find por documento/telefone/e-mail; alimenta Campanhas |
| Pedidos | `pedidos_ink`, `pedidos_ink_itens` | cache local (webhook + sync horário + backfill), escopo `organization_id` + `store_id` |
| Campanhas / Segmentos | `segments`, `campaigns`, `campaign_recipients`; `AudienceBuilder` | segmento = definição de filtro **dinâmica**; motor de audiência já calcula elegíveis (opt-in, número, cooldown) |
| Design system | `src/components/ds/*`, `DESIGN.md` | dark, cor semântica; Drawer, KpiStrip, DataTable, Callout |
| Backfill | `pedidos_backfill_jobs`, `POST /api/admin/pedidos/backfill-historico` | existe; a tela agora declara o estado dele |

## 2. Inventário de dados

| Dado | Situação | Fonte de verdade | Risco |
|---|---|---|---|
| Pedido (id, data, status, total, frete, desconto) | **Disponível** | `pedidos_ink` | cobertura depende de sync/backfill (declarada na tela) |
| Itens do pedido (produto, modelo, cor, tamanho, qtd, valor, desconto rateado) | **Parcial** | `pedidos_ink_itens` | pedido antigo sem itens gravados → soma vira `—` |
| Imagem do produto | **Indisponível** | não vem no payload de pedido da Ink | placeholder na tela, sem URL inventada |
| Reembolso total | **Disponível** | `payment_status = refunded` | — |
| Reembolso parcial | **Indisponível** | só há auditoria dos feitos pelo painel | LTV pode superestimar; declarado na tela e nas lacunas |
| Identidade do cliente | **Disponível (heurística)** | documento/telefone/e-mail, transitivo | duas pessoas da mesma família podem virar uma; `motivosDeUniao` explica o merge |
| Consentimento | **Parcial** | `accepts_marketing` do checkout | não há opt-in/opt-out por canal nem supressão própria |
| Telefone/e-mail válidos | **Disponível** | pedido | qualidade do dado |
| UF | **Disponível** | `buyer_uf` (endereço de entrega) | ausente em pedidos antigos |
| Produto/categoria por cliente | **Parcial** | itens | fora dos filtros nesta rodada |
| WhatsApp 1:1 pelo Oria | **Indisponível** | só campanhas (templates) | botão do drawer abre `wa.me` externo e diz isso |
| E-mail pelo Oria | **Indisponível** | sem provedor | `mailto:` rotulado como abrir app |
| Meta Custom Audiences | **Indisponível** | não configurado | V3, fora da rodada |
| Timezone da Organization | **Parcial** | não há campo; usa `America/Sao_Paulo` | igual ao dashboard financeiro |

Observado × inferido: pedido, itens, status, UF e consentimento são **observados**. Segmento RFM, LTV, recorrência e identidade unificada são **derivados** e vêm com versão, data de referência e cobertura.

Divergência conhecida (herdada, não alterada): o motor de audiência de Campanhas conta pedido de **troca** paga como compra e mede recência em 24h corridas; a RFM exclui troca e conta dias de calendário. A tela avisa (`observacoes`) ao salvar o segmento.

## 3. Decisões financeiras

- **Pedido válido**: `payment_status ∈ {paid, succeeded, free}`, não é troca, com data e valor. Cancelado, expirado, pendente, reembolsado por inteiro e troca ficam fora.
- **Valor**: `total_value` (já líquido de desconto; inclui o frete pago pelo cliente). A Ink fecha `total = Σ itens + frete − desconto` (validado em 152/152 pedidos, `lib/ink/financeiro.js`), então o subtotal do pedido é derivado disso e **conferido** contra os itens gravados (`conciliado`).
- **Faturamento/indicadores**: todos do mesmo universo (pedidos válidos com identidade, Store do contexto, período). Pedido sem documento/telefone/e-mail fica fora de todos e é contado em `cobertura.pedidosSemIdentidade`.
- **Taxa de recompra**: clientes com ≥2 pedidos válidos **no período** ÷ clientes compradores do período.
- **Comparação**: só quando o histórico sincronizado cobre o período anterior inteiro.

## 4. RFM `rfm-v1` (próprio, não reproduz regra de terceiros)

- R: dias de calendário (fuso da Organization) desde a última compra válida até `as_of`. F: pedidos válidos na janela (365 d). M: valor pago na janela. LTV = sem janela.
- Segmentação por **regras** (recência em faixas 45/90/180/365 dias; frequência; valor alto = P75 entre quem tem M>0), não por quantis de F/M, porque em base de baixa recompra quantis colocariam quem comprou 1× ao lado de quem comprou 10×.
- 11 segmentos exclusivos e exaustivos (provado por teste em toda a grade): Campeões, Leais, Potenciais leais, Primeira compra de alto valor, Novos, Aguardando recompra, Precisam de atenção, Prestes a dormir, Em risco, Hibernando, Perdidos. Nomes e limites são **padrões a validar contra a distribuição da base real** (estão configuráveis).
- `Dados insuficientes` quando a base tem <30 clientes ou <90 dias de histórico.
- Notas 1–5 (R e M por quintis; F por contagem) são só leitura relativa; empates caem sempre na mesma nota.
- `as_of` (data de classificação) não muda com o período dos indicadores.

## 5. Entregue nesta rodada

**Fase 1/2 (dados + engine)** — completo no que foi escopado:
`lib/clientes/{identidade,rfm,metricas,analise,segmento,detalhe,exportacao}.js`; regra de identidade única extraída de `buscarClientesAgregados` (comportamento preservado); migration `0034` (origem/política/predicado/versão/data no segmento).
Endpoints: `GET /api/admin/clientes/resumo`, `POST .../detalhe`, `POST .../exportar`, `POST .../segmentos`; `lista` ganhou segmento, faixas, datas, UF, consentimento.

**Fase 3/4 (frontend)**: indicadores, matriz treemap, tabela de distribuição, filtros avançados com URL compartilhável (sem PII), chips, drawer 360°, exportação.

**Fase 5 (parcial, V1)**: segmento dinâmico salvo a partir da RFM ou dos filtros, dedupe por regra, ligação a `Campanhas > Nova campanha` (`?segmento=ID`), origem visível em Segmentos, exportação CSV protegida.

## 6. Não feito / próximos incrementos

- **Snapshots versionados** persistidos e job diário de recálculo: a RFM é calculada sob demanda (com `versao` + `asOf` no retorno). Sem cache; para centenas de milhares de pedidos, medir e materializar.
- **Segmento congelado** (snapshot com data): só dinâmico por enquanto (`politica` restrita a `dinamico`).
- Reembolso parcial por cliente; opt-in/opt-out e supressão por canal; histórico de mensagens/respostas/conversões por cliente.
- Ações do drawer "Adicionar ao segmento" e "Excluir de campanhas": segmento é regra, não lista manual; fica para quando houver lista de supressão.
- Envio massivo WhatsApp (V2), Meta Custom Audiences (V3), produto/categoria e atribuição de receita (V4).
- Validar limites de recência e P75 contra a distribuição da base **real** (a Fase 0 não leu dados de produção).
- `docs/checklist-nova-tela.md` é citado em `.claude/rules/admin-nova-tela.md` mas não existe no repositório.

## 7. Segurança e privacidade

- Organization/Store vêm do contexto da sessão, nunca do request; RLS ativa; testes com duas Organizations (404 cruzado no detalhe, segmento isolado).
- Ver contato de um cliente e exportar são auditados **antes** da resposta (falha na auditoria = nada devolvido); o `audit_log` guarda hash da chave e só a contagem/nomes dos filtros.
- Chave do cliente (CPF/telefone/e-mail) nunca vai na URL (detalhe é POST); busca e cliente aberto não entram na query string.
- CSV sem CPF, com proteção contra fórmula (`=`, `+`, `-`, `@`) e confirmação da quantidade vista na prévia.
- O predicado do segmento é recalculado no servidor; campos extras enviados pelo navegador são ignorados.
- Nenhum disparo ao abrir o drawer; botões de canal só ficam clicáveis com rota real e dizem que não enviam pelo Oria.
