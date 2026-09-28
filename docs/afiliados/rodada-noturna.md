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

---

# Validação da branch (rodada 2 · 28/09/2026)

Somente local. **Nenhum push, PR, merge/rebase, deploy, migration fora de bancos descartáveis, escrita na INK, pagamento real ou contato com parceiro.**
Nenhum código de produto foi alterado nesta rodada (nenhum bug encontrado); só documentação.

## Git

- Branch `feature/oria-parcerias-afiliados`, worktree `/Users/gtomazi/projects/oria-afiliados`, árvore limpa no início. Commits existentes: `9ccd099`, `a247c75`, `b5c6939`, `67a395f`, `770d34a`.
- `git fetch`: `origin/main` = `b32e25b`, dois commits além da base `8dfe5a8` (PR #44 "filtro de data/intervalo" e `3e28cb7` "período global em Google Ads, Custos de API, GA4 e Meta Ads"). `git diff 8dfe5a8 origin/main -- apps/panel/migrations` **vazio**: sem migration nova.
- **Migrations sem colisão** (`1790002900000_partnerships`/`0044`, `1790003000000_pedidos-ink-afiliados-campos`/`0045`); nada renumerado. O merge com `main` não foi feito (regra da rodada); a verificação anterior indicou que é textualmente limpo.
- Commits novos: 1 (docs desta validação). Árvore final limpa.

## Testes

**Incidente de ambiente.** O Docker/Colima caiu no meio do primeiro run do `app-role` (VM parada, hostagent preso): o run foi **invalidado** (o banco sumiu durante o teste) e descartado. Recuperação: `colima stop -f` + `colima start`, container `oria-afil-pg` recriado (porta 53954) e banco de demonstração recriado/semeado. Causa: infraestrutura da máquina (carga muito alta com várias sessões), não código.

**`app-role` pelo wrapper oficial.** Comando (mesmo wrapper de `npm run test:app-role`: `TEST_APP_ROLE=1` + `scripts/test-db.mjs run`, que exporta `DB_ENFORCE_APP_ROLE`, `DATABASE_URL` da role da aplicação e `TEST_OWNER_DATABASE_URL`):

```
TEST_APP_ROLE=1 TEST_PG_CONTAINER=oria-afil-pg TEST_PG_KEEP=1 node scripts/test-db.mjs run -- node --test --test-concurrency=1 \
  test/invariants/app-role-suite.test.js test/invariants/afiliados-db.test.js test/invariants/afiliados-http.test.js \
  test/invariants/tenancy-isolation.test.js test/invariants/tenancy-upsert.test.js test/invariants/navegacao-painel.test.js test/invariants/td001-rls-contract.test.js
```

Resultado: **211 / 211 passam, 0 falham** (exit 0, ~49 s). A falha do run manual anterior era ambiental (faltavam as variáveis do wrapper), confirmada. **Não foi executado o `npm run test:app-role` inteiro** (`test/*.test.js` + `test/invariants/*.test.js`, mais de 1 h sob esta carga): o `app-role` e tudo que a branch toca foram rodados como subconjunto pelo mesmo wrapper.

**Checklist manual, 10 itens** (painel real do `server.js` na porta 48123, `AFILIADOS_MODULE_ENABLED=true`, jobs de fundo desligados, sem credencial INK, dados sintéticos; scripts de verificação fora do repositório: API + banco + Chrome headless por CDP):

| # | Item | Resultado | Evidência |
|---|---|---|---|
| 1 | Subir local (seed + painel) | **PASS** | seed: 20 pedidos, 17 atribuições, 2 revisões, 2 propostas de nível, 1 pagamento parcial |
| 2 | Collab sem cupom | **PASS** | pedido 90001: base `collab`, sem cupom, R$ 6,00 |
| 3 | Pedido misto | **PASS** | 90003: 2 atribuições (1 por item); collab → Amanda R$ 4,50; comum → Bruno via `BRUNO10` R$ 9,00; cupom no item da collab só como evidência (`paidOnThisLine=false`) |
| 4 | Devolução parcial | **PASS** | 90007 (2 un., 1 devolvida): R$ 6,00 sobre a unidade elegível, snapshot original (`qtdPaga=2`) preservado. 90009 com devolução simulada de 1 de 2 un. depois da liberação (UPDATE só no banco descartável): ajuste `−700` sobre `1400`; lançamento original intacto; reprocessar não duplica |
| 5 | Cancelado / troca / sem custo / sem snapshot / sem produto | **PASS** | 90008 e 90012 sem atribuição; 90013 `manual_review/cost_unknown` sem lançamento; 90014 `order_data_incomplete`; 90015 `item_without_product_id`; 90019 provisionado (aguarda entrega); 90020 provisionado (aguardando pagamento) |
| 6 | Pagamento parcial | **PASS** | pagar R$ 4,50 de R$ 9,00 → aceito, restante R$ 4,50; mesma `idempotencyKey` → 200 `deduplicated`; pagar acima do saldo → 422 "excede o saldo em aberto", nada gravado; estorno → 201, **contralançamento novo** (`kind=reversal`), pagamento original preservado, saldo volta; segundo estorno → 409; `UPDATE` direto no pagamento recusado (append-only) e `DELETE` recusado |
| 7 | Filtros de data e vencido por lançamento | **PASS** | "pagamento efetivo" no dia do pagamento acha a linha; o mesmo dia como "vencimento" não; KPI "pago no período" segue `paid_at` (262 / 0). Grupo ago/2026 da Amanda com vencimentos 10/09 e 12/10: aberto 1575, **vencido 975** (só a parcela vencida) |
| 8 | Permissões (member) | **PASS** | 8 endpoints financeiros/aprovação → 403; visão geral sem valores ("Sem acesso a valores"); sem aba "A pagar" (screenshot); `/a-pagar` direto mostra "Área do owner"; 0 pagamentos criados pelo member |
| 9 | Cupom/INK: prévia | **PASS** | "Prévia INK" de `CARLA20` (screenshot): `POST /v1/stores/promotions/standard`, escopo `store.promotions.write`, `Idempotency-Key` estável, "Escrita na INK: DESLIGADA"; `POST …/ink-create` → 409 `INK_PROMOTION_WRITES_DISABLED`; `inkPromotionWritesEnabled=false` |
| 10 | Cupom/INK: verificar (leitura) | **PASS (limitação esperada)** | sem token INK local: 502 `INK_LEITURA_FALHOU` explícito, sem escrita e sem efeito |

(A lista tem 10 linhas: a linha 1 é o setup e o item 10 do relatório da rodada 1 foi dividido em prévia e verificação; os itens 2–9 do relatório correspondem às linhas 2–8 e 9–10 acima, na mesma ordem.)

Placar: **10/10 PASS** — 24 verificações de API/banco (itens 2–5, 7, 8, 10), 11 do fluxo de pagamento (item 6) e 3 telas por screenshot.

**Testes isolados, typecheck e build:** não reexecutados (nenhum código foi alterado); a evidência da rodada 1 continua válida (77 puros, 31 `afiliados-db`, 6 `afiliados-http`, 168 tenancy/migrations, 29 `navegacao-painel`, typecheck/build limpos), somada aos 211 do wrapper acima. **Suíte completa: não realizada** nesta rodada.

## INK real

**Chamada GET real: NÃO realizada.** Endpoint previsto: `GET /v1/stores/promotions?code=<CÓDIGO>&per_page=5` (`store.promotions.read`). Motivo: o ambiente local não tem token da INK (nenhuma variável `INK_*`, nenhum `.env`; a Organization de demonstração não tem o segredo `ink/api_token`); o token real só existe nos bancos de produção/staging, fora do alcance desta rodada, e a regra é não inventar nem pedir segredo. Etapa interrompida sem nenhuma chamada à INK.

Confirmado por inspeção do código: o cliente injetado só tem `get`; `inkFetchDaStore('GET', …)` fixa o método; `criarCupom` sem `client.post` lança `PromotionWritesDisabledError`; nenhum caminho dispara POST/PATCH/PUT/DELETE. **Nenhuma escrita na INK.** Detalhes, campos ainda não observados e decisões antes de habilitar escrita: `auditoria-integracao.md` §6.

## Bugs encontrados

**Nenhum** bug de código nesta rodada (portanto nenhum commit de correção nem teste novo). Falhas observadas foram de script de verificação próprio (expectativa errada do item 4 na 1ª leitura, coluna inexistente) e de infraestrutura (Colima), todas resolvidas fora do repositório.

Observações (não são defeitos):
- `DELETE` direto em `partner_payment_records` é barrado pela FK das alocações (o trigger append-only cobre `UPDATE`); o resultado — histórico imutável — se mantém.
- `CARLA20` (aguardando validação) mostra "Ativar" habilitado mesmo com a verificação na INK falhando/ausente; é decisão de produto (cadastro manual é fallback integral).
- 403 preexistente em `/api/admin/whatsapp-web/config` na Organization de demonstração (sem plano de WhatsApp) — não relacionado.

## Verificação final de segurança

| Item | Resultado |
|---|---|
| `AFILIADOS_MODULE_ENABLED` opt-in, desligado por padrão | **sim** (`=== 'true'`; sem ela as rotas respondem 404 e o job fica inerte) |
| Escrita de promoções INK bloqueada | **sim** (409; flag `false` fixa no código) |
| Nenhum cliente de escrita injetado | **sim** (`inkClient: { get }`) |
| RLS em todas as tabelas do módulo | **sim**: 20/20 com RLS habilitada, `FORCE` e ≥ 1 política, todas com `organization_id` (consulta ao catálogo) |
| Nenhum endpoint aceita seletor de `organization_id` | **sim**: o contexto vem só de `req.tenant`; seletor no request → 400 (`TENANT_SELECTOR_NOT_ALLOWED`); coberto por `afiliados-http` |
| `member` sem dinheiro/aprovação | **sim** (item 8; 26 rotas → 403 nos testes) |
| Histórico append-only/imutável | **sim**: 8 tabelas com trigger (ledger, benefícios, histórico de nível, alocações, pagamentos, auditoria, versões de contrato, regras de nível) |
| Sem abstração multi-loja | **sim**: 1 Organization = 1 Store preservado; nenhum `store_id` como seletor |

## Pendências

**Bloqueantes para PR:** nenhuma. **Para o merge:** rodar a suíte completa `npm run test:app-role` no CI/ambiente sem contenção e reexecutar após integrar `main` (`b32e25b`, sem migrations, mas toca `server.js`).

**Não bloqueantes / P2:** validação real de `GET /v1/stores/promotions` (formato, `free_quantity`, `usage_limit`, escopo); backfill de pedidos antigos (ficam em Revisões); `paid_at` inexistente no cache; papéis `finance`/`marketing`; feriados; upload de comprovante; portal/candidatura/e-mail/WhatsApp; ensaio das migrations contra dump de produção.

**Decisões de produto abertas:** permitir "Ativar" cupom não verificado na INK; semântica de `free_quantity` e cupom reaproveitável; margem = receita líquida − custo de produção (sem taxas/impostos/frete); política de conflito padrão (`collab_precedence`); quando liberar escrita de promoções (por release, com token/escopo de escrita confirmados).

## Recomendação

**APTO PARA PR COM RESSALVAS**

Motivos: checklist manual 10/10 PASS, 211/211 no wrapper `app-role` (subconjunto que cobre a branch), nenhum bug de código, invariantes de segurança confirmados (flag off, sem escrita na INK, RLS 20/20, append-only, member sem dinheiro, 1 workspace = 1 loja), sem colisão de migrations. Ressalvas: (1) o contrato real da INK **não foi validado** por falta de credencial local — a integração de promoções segue só com mock e a escrita permanece desligada; (2) o `npm run test:app-role` completo e a suíte inteira não foram concluídos nesta máquina e devem rodar no CI antes do merge; (3) `main` avançou (sem migrations), exigindo reexecução após a integração.
