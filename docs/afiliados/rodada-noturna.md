# Parcerias e Afiliados · relatório da rodada noturna (27–28/09/2026)

Tudo local. **Sem push, merge, PR, deploy, migration em produção/staging, escrita na INK, pagamento ou contato com parceiro.**

## Git

- Worktree nova: `/Users/gtomazi/projects/oria-afiliados`, branch `feature/oria-parcerias-afiliados`, criada de `origin/main` (`8dfe5a8`). O checkout
  original (`bugfix/dashboard-kpi-lucro-bruto`) não foi tocado.
- Commits locais: `9ccd099` (backend), `a247c75` (telas, rotas, ingestão de cupom), `b5c6939` (docs, seed, vencido por lançamento) e o commit final
  desta rodada (ver `git log`).
- Migrations novas: `1790002900000_partnerships` (SQL `0044`) e `1790003000000_pedidos-ink-afiliados-campos` (SQL `0045`) — `main` não tinha nada além
  de `1790002800000` no `git fetch` de 27/09; renumere se outra branch entrar antes (ver a memória de colisão de migrations).
- Testes literais de lista de migrations atualizados (`migrations`, `inv-td003`, `r19-runbook`, `tenancy-migrations`) e `tenant-owned-tables.md` regenerado.

## O que está funcionando (com referência a rotas/telas)

| Área | Estado | Onde |
|---|---|---|
| Cadastro de parceiro (candidato → aprovado, vínculo, afiliado nativo declarado) | **pronto** | `/admin/parcerias/parceiros`, perfil `/…/parceiros/:id` |
| Contratos versionados (append-only), simulação, teto de nível com override | **pronto** | perfil › Contratos e cupons |
| Cupom manual (fallback integral), ativar/pausar/retomar/encerrar, verificar na INK (leitura), prévia de criação | **pronto**; criação na INK **desligada** | perfil › Contratos e cupons |
| Collab por estampa (produto isolado ou agrupado, vários criadores, descoberta por agrupamento com aprovação, histórico de vínculo) | **pronto** | `/admin/parcerias/collabs` |
| Motor por item (desconto rateado, base, política de conflito, devolução, cancelamento, chargeback, custo desconhecido, fail-closed) | **pronto** | `lib/afiliados/engine.js` |
| Ledger com deltas, idempotência, estornos, previsão/liberação/vencimento (fuso da loja) | **pronto** | `lib/afiliados/reconcile.js`, `schedule.js` |
| Contas a pagar: KPIs, filtros por 6 tipos de data, lote, pagamento parcial com rateio, estorno, vencimento manual, cachê, CSV | **pronto** | `/admin/parcerias/a-pagar` |
| Vendas atribuídas por item + Revisões (associação manual auditada) | **pronto** | `/…/vendas`, `/…/revisoes` |
| Níveis (regras versionadas, propostas com aprovação, override) e carteira de benefícios | **pronto (P1)** | `/…/niveis`, perfil › Níveis e benefícios |
| Visão geral (KPIs com período + tipo de data, série diária, próximos vencimentos, pendências in-app) | **pronto** | `/admin/parcerias` |
| Job de reconciliação por Organization (30 min, lease) | **pronto**, inerte sem a flag | `server.js` |
| Portal externo do afiliado, candidatura pública, e-mail/WhatsApp, upload de comprovante | **não iniciado** (P2 / sem infraestrutura segura) | — |

Flags: `AFILIADOS_MODULE_ENABLED` (**desligada** por padrão); `ink_promotion_writes_enabled` **fixa em `false` no código** e nenhum cliente de escrita é injetado.

## Evidência de teste (números reais desta máquina)

| Suíte | Resultado |
|---|---|
| `afiliados-money-schedule`, `afiliados-engine`, `afiliados-adapters`, `afiliados-routes` (puros, sem banco) | 14 + 34 + 16 + 13 = **77 passam / 0 falham** |
| `invariants/afiliados-db.test.js` (Postgres real, role `oria_app`, RLS forçada) | **31 passam / 0 falham** |
| `invariants/afiliados-http.test.js` (processo real do `server.js`, provider mock) | **6 passam / 0 falham** |
| Tenancy/migrations: `migrations`, `tenancy-schema`, `tenancy-isolation` (matriz das 20 tabelas novas), `td001-rls-contract`, `inv-td003`, `tenancy-migrations`, `tenancy-db-negative-controls` | **168 / 168** (run com `INVARIANTS_APP_DATABASE_URL`) |
| `navegacao-painel` (após ajuste do regex da sidebar) | **29 / 29** |
| Suíte completa (`test/*.test.js` + `test/invariants/*.test.js`, `--test-concurrency=1`, run único antes das correções abaixo) | **2517 testes: 2500 passam, 4 falham, 13 pulados** (os pulados já existiam). Depois das correções, as 4 falhas ficaram assim: 2 corrigidas (2 e 3 abaixo) e 2 de ambiente (1 e 4) |
| `npm run typecheck` / `npm run build` | limpos |

Falhas da suíte completa, com causa e situação atual:

1. `app-role · com TEST_APP_ROLE=1…` — depende das variáveis que só o wrapper oficial (`npm run test:app-role` / `npm test`) exporta (`DATABASE_URL` da role da aplicação, `TEST_OWNER_DATABASE_URL`…); no meu run manual elas não existiam. **Ambiental, não é regressão**; não roda de forma significativa fora do wrapper.
2. `boot · dev sem DATABASE_URL e sem modo declarado → exit ≠ 0` — estourou 20 s com load médio ~330. **Reexecutado depois: passa** (junto com os outros 18 de `boot-exit-code`).
3. `navegacao-painel · ocultar por plano/canal só filtra…` — **causada por esta rodada** (a sidebar agora parte de `gruposBase`); regex ajustado preservando a intenção (só `map`+`filter`, sem reordenar, item de Parcerias no fim de Comunicação e só com o módulo liberado). **Passa (29/29)**.
4. `tenancy-upsert · todo ON CONFLICT com alvo em tabela tenant-owned começa por organization_id` — **causada por esta rodada**: o contador de alvos `ON CONFLICT` subiu de 41 para 48 com o código novo. Todos os 7 novos começam por `organization_id` (a asserção `ruins` passa); atualizei o contador esperado com comentário. **Passa (30/30)** com `INVARIANTS_DATABASE_URL`.

Nenhuma rodada final única da suíte inteira foi feita depois das correções (a suíte leva mais de uma hora sob a carga desta máquina); os arquivos corrigidos foram reexecutados isoladamente.

Verificação visual: screenshots headless do Chrome em 1440/768/390 px das 9 telas, owner e member, contra o cenário sintético — sem overflow horizontal e sem erro de console
das telas do módulo (o único log de erro é um 403 preexistente de `/api/admin/whatsapp-web/config`, porque a Organization de demonstração não tem plano de WhatsApp). O diálogo de pagamento foi aberto e renderizado. A extensão de Chrome travou; por isso o Chrome foi dirigido direto por CDP (script fora do repositório).

## API da INK: confirmado × mock × primeira operação futura

Ver a matriz completa em `auditoria-integracao.md`. Resumo: campos do pedido gravados e provados **com mock** (loja de teste `F`); semântica de custo confirmada pelo código
existente; `free_quantity`, cupom reaproveitável e escopo de escrita de promoções **pendentes de validação real**. Primeira operação remota futura (não executada):
`GET /v1/stores/promotions?code=<CÓDIGO>&per_page=5` (`store.promotions.read`). O log do mock nos testes HTTP prova **nenhum POST de promoção**.

## Segurança e tenancy

- Isolamento de dois workspaces: matriz de RLS nas 20 tabelas (`tenancy-isolation`), `afiliados-db` (13 operações cruzadas → 404) e `afiliados-http` (mesmas operações por HTTP, sessão real). Seletor de tenant em query/corpo → 400.
- Papéis chamando endpoint direto: 26 rotas de dinheiro/aprovação → 403 para `member`, sem chegar ao serviço (`afiliados-routes`) e por HTTP real (`afiliados-http`).
- Históricos append-only (versões de contrato, pagamentos, alocações, auditoria, benefícios, regras/histórico de nível) e valor do ledger imutável, por trigger.
- CSV: fórmulas neutralizadas; sem e-mail, documento, token ou dado de comprador.

## Limites conhecidos (não verificados / decisões pendentes)

1. Pedidos anteriores à migration só entram depois que sync/webhook/backfill os tocar (ficam em **Revisões** como `order_data_incomplete`). Backfill em produção: fora desta rodada.
2. Margem = receita líquida − custo de produção da INK (sem taxas/impostos/frete). A tela rotula assim.
3. `paid_at` não existe no cache: `payment_plus_days` usa a data de observação.
4. Afiliado nativo da INK não é detectável pela API: declaração manual + bloqueio.
5. Só `owner`/`member` existem no schema; `finance`/`marketing` exigem migration e decisão de produto.
6. Feriados não são calculados (fim de semana → segunda).
7. Comprovante de pagamento = referência textual (sem upload protegido).
8. Nada foi validado contra a INK real nem com dados reais; toda a demonstração é sintética.
9. Migrations não foram ensaiadas contra um dump de produção (só bancos descartáveis).

## Checklist de aceite manual (10 itens)

1. Subir local: `DATABASE_URL=… DEMO_SENHA='…' node apps/panel/scripts/afiliados/seed-demo.cjs` e `AFILIADOS_MODULE_ENABLED=true npm --prefix apps/panel start`; abrir `/admin/parcerias` (menu em Comunicação).
2. **Collab sem cupom**: perfil da Amanda › Vendas — pedido 90001 comissiona R$ 6,00 (15% de margem) sem código de cupom.
3. **Pedido misto**: Vendas atribuídas, pedido 90003 — item da collab paga a Amanda, item comum paga o Bruno pelo cupom `BRUNO10`; nada duplicado; o cupom no item da collab aparece só como evidência.
4. **Devolução parcial**: pedido 90007 (2 un., 1 devolvida) — comissão pela unidade elegível; extrato mostra o ajuste compensatório.
5. **Cancelado/troca/sem custo/sem snapshot**: 90008 não comissiona, 90012 (troca) não é venda, 90013 vira revisão de custo, 90014 e 90015 aparecem em **Revisões**; associar 90015 a uma collab pede motivo e audita.
6. **Pagamento parcial**: A pagar › Registrar pagamento (Amanda) — pagar valor menor que o aberto; conferir saldo restante, recibo gerencial e status "Parcialmente pago"; tentar pagar acima do saldo (recusado); estornar e ver o contralançamento.
7. **Filtro por data efetiva**: A pagar › tipo de data "Pagamento efetivo" com o dia do pagamento do item 6 — a linha aparece; trocar para "Vencimento" no mesmo dia — não aparece. KPI "Pago no período" segue `paid_at`.
8. **Vencido por lançamento**: conferir que "Vencido" mostra só a parte já vencida de um grupo com prazos diferentes.
9. **Papéis**: entrar como `demo-member@local.oria` — sem aba A pagar, sem valores na visão geral; chamar `/api/admin/afiliados/payables` direto responde 403.
10. **Cupom/INK**: perfil › cupom `CARLA20` (aguardando validação): "Prévia INK" mostra o pedido que seria enviado e informa escrita desligada; "Verificar na INK" só lê (falhará sem token da INK no ambiente local).

## Como reproduzir os testes

```bash
# Postgres descartável (Docker) com as migrations, e depois:
export TEST_DATABASE_URL=postgres://…/oria_test INVARIANTS_APP_DATABASE_URL=postgres://oria_app:…@…/oria_test
cd apps/panel
node --test test/afiliados-*.test.js
node --test test/invariants/afiliados-db.test.js test/invariants/afiliados-http.test.js
node --test --test-concurrency=1 test/invariants/tenancy-*.test.js test/invariants/migrations.test.js
```
