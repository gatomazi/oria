# Checkpoint da rodada — 2026-09-21 (PRs #10 a #20)

Fechamento formal do estado do produto depois da sequência de PRs #10–#20. Nada foi implementado ou corrigido
para produzir este documento: só leitura, smoke em produção e registro.

## 1. GERAL

| Item | Estado |
|---|---|
| `main` HEAD | `52d3e8d` (merge do #20). Nenhum commit posterior. |
| PRs #10–#20 | Todos `MERGED` (#16 entrou junto com o #18: a branch do #18 continha os commits do #16). |
| Working tree | Sem alteração em arquivo rastreado. Só arquivos não rastreados em `docs/commands/` e `docs/features/` (comandos do usuário e docs de outras frentes), fora desta rodada. |
| Full Verification (referência) | run `35639104337`, `main` `52d3e8d`: **success**. |
| Full Verification #19 (`1c75ae3`) | success. #18 (`7352daa`) success. |
| Falhas históricas | #10: flake do teste `ink-lote` (janela ampliada em 60 s, depois verde). #12: shutdown do runner (infra), runs seguintes verdes. #17: cancelado por concorrência, coberto pelo run do #18. |
| Migrations | 0029 (`campanhas-store-id`) e 0030 (`reparar-loja-uuid-em-pedidos`) — as duas únicas do intervalo. Registradas em produção nos deploys do #10 e do #14. Deploy atual: "No migrations to run" + "conexão e migrations verificadas". |
| Deploy | `9d3cc421` SUCCESS (#20). Zero `UNHANDLED_REJECTION` nos logs verificados. |

## 2. Full Verification do `main` `52d3e8d` — jobs

- 4 fatias × 2 variantes (owner e `oria_app`): **8/8 success** (9–14 min cada).
- Negative controls: **124 ciclos de 5 passos por variante, 0 falha** (31 por fatia × 4) = total de violações do `main`.
- sem banco 1/2 e 2/2, migrations do zero e idempotentes, control plane, serviço Go, criativos (Python), build do SPA, contratos: success.
- `full-gate`: success. "second tenant gate (nightly)": skipped (é do nightly).

## 3. Validado em produção nesta sequência

- **Google Ads:** OAuth sem developer token, 3 contas, conta Use Sul (197-246-1352) selecionada, sync sem erro, gasto no Dashboard (Mídia).
- **Ink, GA4, Meta Ads, OpenAI:** "Estado das integrações" conectadas (Meta e Google Ads "com dados").
- **Dashboard, Pedidos (440 em 22 páginas), Clientes, Trocas (141, status em português), Recuperação (79 recuperáveis), Promoções (8 ativas, 2 encerradas), Campanhas (vazia, sem resíduo), Categorias, Agrupamentos, Integrações:** carregam.
- **Clientes:** 4.071 (393 com pedido + 3.678 só cadastro), 163 páginas de 25, filtros Todos/Com pedido/Só cadastro sem duplicação após 6 trocas seguidas.
- **Categorias:** 176 (a tela mostrava 100), 8 páginas; a página 8 traz 1 item.
- **Agrupamentos:** 10.650 (a tela mostrava 100), 426 páginas; a página 427 vem vazia.

## 4. Coberto apenas por testes (não exercido em produção)

- CRUD de Campanhas (criar/editar/duplicar/cancelar), Promoções e Despesas com escrita.
- Reembolsos (fluxo implementado; nenhum estorno real executado).
- Job de recuperação por polling: leitura validada; envio depende do WhatsApp.
- Isolamento entre Organizations (produção tem uma Organization efetiva): tenancy-isolation, fase3-server-ab, CLI-03 e demais controles.
- Migração de `store_id` composto e RLS/app-role.

## 5. Bloqueado externamente

- **WhatsApp:** a Meta recusa o token (expirado/revogado; token de teste dura 24 h) e há restrição de destino (erro 130497). O Oria mostra "Erro — reconectar" e mensagens classificadas. Não é bug do Oria.
- **Tech Provider em produção:** Business Verification, App Review, páginas de privacidade e exclusão de dados (registrado como requisito futuro).

## 6. Campanhas, Automações, Templates

- **Funciona:** Campanhas lista/vazio; Segmentos; Automações carrega e explica o canal indisponível; Templates falha de forma amigável (token expirou); erros da Meta classificados; token nunca vai a log.
- **Bloqueado (externo):** vincular evento→template, listar/criar templates, wizard de campanha até o envio, qualquer envio.
- **Coberto por testes:** criar/duplicar/cancelar campanha por Store nativa, vínculo de automação, job de recuperação.

## 7. Clientes — ressalva factual

"Só cadastro" significa **sem pedido no histórico local sincronizado**. Não afirma que a pessoa nunca comprou na Ink.

Cobertura provada do histórico local: as linhas de pedidos do endpoint financeiro (janela máxima de 180 dias) começam em **2026-08-19** e vão até 2026-09-20; o total local é de 440 pedidos (393 clientes). A série de mídia recua até 2026-06-24, o que confirma que a janela cobria mais tempo e que os pedidos não. `GET /api/admin/pedidos/backfill-historico` retorna `jobs: []`: nenhum backfill histórico foi executado. A tela de Integrações já avisa que o sync automático cobre só os últimos 30 dias desde a 1ª ativação e oferece "Sincronizar histórico completo" (não executado nesta rodada).

## 8. Reembolsos

Fluxo implementado e coberto por testes. **Falta validação em produção com pedido real.** Nenhum estorno foi executado.

## 9. Dados

- `store_id`: identidade canônica `organization_id + store_id`; sem regressão (controles PED-01/PED-02, migration 0030, testes de Store nativa verdes).
- `loja_legada`: Use Sul usa a Store nativa. Evidência **indireta** em produção: linhas de Clientes saem com `loja` = UUID da Store; o Dashboard devolve `loja: null`. Não consultei o banco diretamente (host só interno da Railway).
- Paginação server-side: Clientes, Categorias, Agrupamentos (novas), Pedidos e Trocas (já existentes).

## 10. CI / hardening

- Negative controls em 4 fatias: caminho crítico de ~31 min para ~11–14 min. Nenhum controle removido; teste de cobertura garante que a união das fatias é a lista inteira.
- Controles novos nesta sequência: PED-01, PED-02, PAG-01, CLI-01, CLI-02, CLI-03, CLI-04 (e INK-01 reancorado).

## 11. Dívidas registradas (nada foi corrigido)

**P2**
- Histórico local de pedidos só desde 2026-08-19: "Só cadastro" impreciso até rodar a sincronização histórica.
- "Associar produtos", "Produtos novo" e Origens leem só as 100 primeiras categorias (existem 176).
- Reembolsos sem validação com pedido real.
- CRUD de Campanhas/Promoções/Despesas não exercido em produção.

**P3**
- Trocas: "Criada em" aparece como "—" (a lista da Ink não traz `created_at`).
- Coluna "Loja" aparece como "—" em Pedidos e Trocas (Store nativa sem chave legada).
- Agrupamentos: vários sem imagem.
- Categorias: ainda há demora residual da resposta da Ink (ids completos).
- Recuperação: carrinho "Auditoria Plataforma" (`auditoria.plataforma@example.com`) parece fixture de outra auditoria.
- Google Ads: a série de gasto termina em 2026-09-15; confirmar se é a conta ou a janela de sync.
- Higiene local: arquivos não rastreados em `docs/commands/` e worktrees de outras frentes.

## 12. Deferred

Webhook real da Ink, WhatsApp Tech Provider em produção, Estoque, Feed, Artwork Vault, Instagram (COMING SOON).

## 13. Matriz de dogfooding

| Área | Status |
|---|---|
| Dashboard | READY |
| Pedidos | READY WITH POLISH |
| Clientes | READY WITH POLISH |
| Financeiro | READY (leitura Ink; sem mídia por desenho) |
| Despesas | READY (escrita só por testes) |
| Trocas | READY WITH POLISH |
| Reembolsos | PARTIAL (sem validação com pedido real) |
| Recuperação | PARTIAL (envio bloqueado pelo WhatsApp) |
| Promoções | READY (escrita só por testes) |
| Campanhas | PARTIAL (envio bloqueado pelo WhatsApp) |
| Segmentos | READY |
| Automações | BLOCKED (WhatsApp/Meta, externo) |
| Templates | BLOCKED (WhatsApp/Meta, externo) |
| UTM | READY (não retestado nesta sequência) |
| Produtos | READY (cache de 105.857; UI não retestada nesta sequência) |
| Categorias | READY WITH POLISH |
| Agrupamentos | READY WITH POLISH |
| Ink API | READY |
| Ink webhook | DEFERRED |
| GA4 | READY |
| Meta Ads | READY |
| Google Ads | READY |
| OpenAI | READY |
| WhatsApp | BLOCKED (externo) |
| Instagram | COMING SOON |

**GO/NO-GO geral: GO para dogfooding geral, com três ressalvas:** (1) nenhum envio de WhatsApp até a Meta liberar o token e o destino; (2) "Só cadastro" só é confiável depois da sincronização histórica de pedidos; (3) Reembolsos ainda sem validação com pedido real.
