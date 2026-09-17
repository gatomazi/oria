# Relatório da execução noturna — rodada 18 (Phase 6+)

16–17/09/2026 · comando `docs/commands-produtizacao/claude-rodada-18-execucao-noturna-phase6plus.md`.
**Tudo local.** Sem push, deploy, Railway, banco de produção, tenant externo ou dogfooding. `master` intocada.

```text
Fase 6 CODE/ROLLBACK READINESS = READY
Fase 6 CLOSED                  = NÃO
Fase 7 CONSTRUCTION            = backend pronto localmente (não exposto)
Second Tenant Gate             = automatizado (npm run productization:gate)
Rollout runbook                = consolidado (production-rollout-runbook.md)
Hardening crítico 5c           = feito (repasse assinado, aceite durável, cache curto, páginas removidas)
OVERALL PRODUCTION ROLLOUT     = BLOCKED por OPS-27 + OPS pendentes + dogfooding
```

## Como foi executado

Quatro trilhas em paralelo, cada uma num `git worktree` destacado com Postgres descartável próprio
(nenhuma escreveu na árvore compartilhada com a outra sessão). O lead integrou por cherry-pick num
worktree de integração, resolveu os conflitos (só em `negative-controls.test.js`), corrigiu os
buracos de integração e rodou a verificação completa.

Notas de cada trilha: `overnight-trilha-a.md` (seção "Rodada 18"), `overnight-trilha-b.md`,
`overnight-trilha-c.md`, `overnight-trilha-d.md`.

## Checkpoint (§38)

1. **Trilha A — READY.** Tooling, ensaio e rollback prontos; nada executado em produção.
2. **Cenário A (3 Orgs / 3 Stores / 3 cadeias):** preflight → plan → apply → verify PASS em banco descartável montado como produção; re-execução sem mudança.
3. **Cenário B (1 Org / 1 Store, Sul/Centro/Norte convergindo):** idem, em banco independente. Histórico de Centro/Norte fica invisível nas telas/DRE (INFO) — insumo para PD-019.
4. **preflight/plan/apply/verify:** `npm run tenant1:*` (+ `rollback`). Cenário e mapeamento obrigatórios, sem inferência; preflight/plan/verify em sessão somente leitura; apply/rollback recusam produção/Railway; saída PASS/FAIL sem segredo; controles negativos de dado (owner removido, posse movida, linha reassociada, entitlement desligado).
5. **Rollback rehearsal:** local, por configuração e caminho de leitura, sem DROP/DELETE/troca de dono, com impressão digital antes/depois; runbook em `overnight-trilha-a.md` §6.
6. **Fase 6 code readiness:** **READY**. Teste estático sem `internalTenant`/`useOrigens`/`ourStore` (com controle negativo `fase6/bypass-interno`).
7. **Por que a Fase 6 não fecha:** o critério é operação interna rodando como Organization normal por ≥ 2 semanas em produção. Falta a escolha A/B (PD-019), o rollout (bloqueado por OPS-27 e demais OPS) e o dogfood (NOT STARTED).
8. **Trilha B — onboarding construído:** `onboarding_sessions`/`onboarding_steps` (RLS), convites com token opaco (hash, expiração, uso único), `createOrganizationWithStore` atômico e idempotente por chave explícita, passos de provider derivados de `integrations`, erros por código, retomada após logout/restart/erro. Requisito por passo só por configuração (sem default comercial).
9. **Gate/flag:** `SECOND_TENANT_ENABLED` desligada por padrão, conferida no serviço (não só UI), controle negativo `onboarding/gate`; o `release:preflight` bloqueia a flag ligada em qualquer estágio. Sem rota HTTP e sem UI.
10. **Onboarding E2E em tenant descartável:** convite → owner → Org → Store → integrações mock → entitlement explícito → complete, sob `oria_app`; segundo tenant de teste isolado (aplicação + RLS); falha no meio sem Organization incompleta; concorrência (8 chamadas → 1 Org; 5 aceites → 1).
11. **Trilha C — segredo na query:** removido. HMAC-SHA256 em header (`X-Oria-Forward-*`, ±300 s), `?secret=` recusado sem modo legado, painel sem segredo → 503, Go valida URL (https, sem query/credencial) e aborta em produção se inválida. Contrato `forward-auth-v1` idêntico nos dois repos e no gate. Controles negativos nos dois lados.
12. **Aceite durável:** 200 só depois de gravar idempotência + `webhook_inbox` na mesma transação (migration 3 do Go); worker com lease e passos registrados. Eventos/retry exatamente uma vez; repasse pelo menos uma vez; aviso/auto-resposta no máximo uma vez (a Meta não tem chave de idempotência).
13. **Crash-after-200:** teste com processos reais — queda logo após o 200, queda com evento gravado (outra réplica assume) e queda entre marca e envio; efeito uma vez, sem duplicar em restart ou reentrega.
14. **Cache:** 30 s (válido) / 15 s (recusa), com relógio injetado no teste. Limite real: troca/desconexão vale para a entrada por até 30 s por réplica; envios continuam conferidos na hora.
15. **Trilha D — `productization:gate`:** blocos CODE / OPS / DOGFOOD; 16 checks de código; OPS só VERIFIED com evidência em arquivo. Resultado: **CODE PASS · 35 OPS NOT VERIFIED · DOGFOOD NOT STARTED · OVERALL BLOCKED** (exit 2; `--code-only` exit 0). Piso de testes 806.
16. **`release:preflight`:** somente leitura, só nomes/booleanos; estágios `release-n`/`after-ops14`/`cleanup`. No ambiente local: `BLOCKED (11)` (variáveis de produção ausentes — esperado).
17. **Runbook:** `production-rollout-runbook.md` — BEFORE RELEASE, releases A–F com PRE-DEPLOY/VERIFY, ROLLBACK, CLEANUP, dogfood, matriz OPS → passo e §16 com a consolidação. Nenhum marcador "a confirmar" aberto.
18. **npm test/build:** **807/807 PASS**, 0 skipped (execução do gate, que roda a suíte completa); `npm --prefix admin run build` PASS.
19. **Suíte sob `oria_app`:** `npm run test:app-role` → **807/807 PASS**. 5 arquivos de schema/SQL usam a role dona por lista fechada e verificada.
20. **Go:** `go test -race ./...` **123 PASS** (2 pulos esperados: processos filhos), `go vet` e `go build` PASS — pelo lead e pelo gate.
21. **Commits painel** (`feature/produtizacao-saas`, sobre `bfd00a6`):
    - A: `ca5b56f` `1017cbe` `cf53497`
    - B: `b0ef336` `2353adb` `485cab3` `8c024d2`
    - C: `c706da1` `87b0002`
    - D: `4e7cd7f` `54d65fe` `e3ef343` `693fd11`
    - consolidação: `4198fdd` `8b33f79` `6e86872` + commit de docs desta rodada
22. **Commits Go** (`feature/produtizacao-saas`, sobre `445ead9`): `40cf2e1` `c735c7e` `d47b2af` `b426acb` `23528ae`.
23. **Blockers encontrados:** nenhum stop condition do §35 foi atingido. Na integração: gate sem o contrato novo e reprovando o processo filho novo do Go; preflight sem as variáveis de B/C (corrigidos). Nas trilhas: `ON CONFLICT (email)` global (B, corrigido); suíte sob `oria_app` inexistente (D, criada; 41 falhas de fixture corrigidas); falha isolada do Go sem nome que não reproduziu (C, risco registrado).
24. **OPS ainda NOT VERIFIED:** todos, OPS-01..35 (OPS-27 incluído; OPS-06/07/08 precisam ser re-registrados no formato de evidência; OPS-09 foi atualizado para o segredo novo do repasse). Dogfood NOT STARTED.
25. **Mudanças concorrentes preservadas:** as trilhas trabalharam em worktrees destacados; a árvore principal só recebeu os arquivos dos commits desta rodada. UTM em `server.js`/`admin/src`, `scripts/migracao-verificar.mjs`, `docs/painel-estado-atual.md` e os docs apagados da outra sessão continuam não commitados e intactos.
26. **Próximo passo recomendado:** decidir PD-019 (A ou B) e as pendências da rodada 18 (`productization-decisions.md`), depois verificar o OPS-27 com a credencial real e registrar a evidência — é o único caminho que destrava qualquer release. Em paralelo, ensaiar `tenant1:*` sobre uma restauração local do backup de produção.

## Decisões que ficaram com o usuário

1. PD-019 A ou B, e qual Organization fica com o número WhatsApp atual.
2. Janela RELEASE D → E: status de campanha do Go 5b recusados pelo painel novo até o Go R2.
3. Boot do painel sem `WHATSAPP_WEBHOOK_SECRET`: aviso (hoje) ou abort.
4. Release do painel antes do OPS-27 (runbook assume que não); RELEASE B e C juntas.
5. Janela de 404 de criativos (OPS-22); features do seed; troca do `ADMIN_SESSION_SECRET` se < 32.
6. Onboarding: PD-005/006/007/008/009/011/012, provedor de e-mail, rotas/UI.

## Riscos residuais

- Varredura de bypass é textual; dados do ensaio são sintéticos.
- `onboarding_emitir_convite` é executável pela role da aplicação; a trava de produção está no serviço (rota futura precisa passar por ele).
- Retry de `failed` no Go ainda depende do pedido original em memória; cooldown da auto-resposta em memória; sem cota por tenant.
- Falha isolada não reproduzida no Go (testes sensíveis a tempo sob carga).
