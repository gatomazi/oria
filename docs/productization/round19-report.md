# Rodada 19 — fechar decisões da rodada 18 e preparar o rollout (sem publicar)

**17/09/2026** · comando `docs/commands-produtizacao/claude-rodada-19-fechar-decisoes-e-preparar-rollout.md`

Tudo foi feito localmente: sem push, deploy, Railway, banco de produção ou dogfooding, e a `master`
não foi tocada.

```text
CODE READY
ROLLOUT NO-GO   (OPS-27 NOT VERIFIED)
FASE 6 NOT CLOSED
```

## Como foi executado

Quatro trilhas rodaram em paralelo, cada uma num worktree destacado com Postgres próprio:

| trilha | tema | seções do comando |
|---|---|---|
| E | repasse sem perda | §5 |
| F | boot, gate e dogfood | §4, §12, §13 |
| G | criativos sem 404 | §8 |
| H | cenário B, WhatsApp e seed | §1, §2, §9 e o dry-run do §15 |

O lead integrou tudo por cherry-pick, resolveu os conflitos (`release-preflight.test.js`,
`whatsapp-forward.js`, `negative-controls.test.js`), reescreveu o runbook e acrescentou o OPS-36.
Na consolidação apareceu que a RELEASE B publica o commit antigo `31a7cdb`, e as trilhas G e H refizeram
seus desenhos para esse fato.

Notas por trilha: `round19-trilha-e.md`, `-f.md`, `-g.md` e `-h.md`.

## Checkpoint (§22)

1. **PD-019, alvo do rollout:** **cenário B**, Organization "Use Origens" com Store "Use Origens".
   - Sul, Centro e Norte ficam só como mapeamento legado.
   - O arquivo de rollout marca `rollout: true` e exige `--rollout`. O preflight bloqueia qualquer mapeamento que não seja do cenário B.
   - O cenário A continua como ensaio.
2. **Dono do WhatsApp:** Organization Use Origens / integração WhatsApp dela.
   - O WABA e o `phone_number_id` são **declarados** no arquivo. Sem declaração → FAIL, mesmo com um único número.
   - WABA e número em Organizations diferentes → FAIL.
   - As duas posses ficam na mesma Organization.
3. **OPS-27:** **NOT VERIFIED.** É o primeiro gate de qualquer release; o checklist seguro está em `ops-27-checklist.md`.
4. **Boot sem `WHATSAPP_WEBHOOK_SECRET`:** o HEAD em produção **não sobe** sem ele (≥ 32), com ou sem `WHATSAPP_SERVICE_URL`.
   - Não existe interruptor real do módulo, então nenhuma ausência é aceita.
   - Testado com processo real; o preflight exige a variável em todos os estágios.
5. **Ordem da assinatura de status:** sem perda em nenhuma troca. A sequência é D0 → E → D' → Go sem query → CLEANUP.
   - **D0** = `8c024d2`: painel R1 com o repasse ainda pela query.
   - **E** = Go novo com `WEBHOOK_FORWARD_LEGACY_QUERY_SECRET=1`: assina e mantém a query.
   - **D'** = painel HEAD com `WHATSAPP_WEBHOOK_LEGACY_QUERY_TOLERATED=1`: autentica só pela assinatura e ignora a query.
   - **Prova executável:** painel antigo real (`bfd00a6`) + binário Go real. O status avança no banco.
6. **B e C:** **separadas.** A C só entra depois do smoke e de um ciclo 5b real observado na B.
7. **Criativos sem 404 (OPS-22):** **vínculo antes da B**, depois **materialização com leitura dupla** depois da D'.
   - **Vínculo:** link simbólico `tenant/<org>` → `<legado>`. As duas versões usam o mesmo diretório físico.
   - **Materialização:** `mover-criativos --desvincular --aplicar` com `CREATIVE_LEGACY_READ_*`, fechada por `--verificar` = PASS.
   - **Provas:** código real de `ed5a5b0`/`31a7cdb`/HEAD sobre o mesmo volume, antes, durante e depois, e rollback.
   - **Bug evitado:** o mover apagaria a única cópia com o vínculo presente; corrigido e com controle negativo.
8. **Seed explícito do Tenant #1:** perfil `config/entitlements/tenant1-entitlements.json`, validado contra o registry.
   - **ON (10):** catalog, creative_clean_angles, creative_funnel_visual, creative_generator, creative_multi_product, creative_remarketing, exchanges, financial, refunds, whatsapp.
   - **OFF:** instagram (comingSoon), advancedAutomations (sem uso).
   - **Na B:** `ENTITLEMENTS_SEED_FEATURES` precisa ser igual ao perfil, senão o preflight bloqueia.
   - Não fecha PD-005/PD-009.
9. **Rotação final do `ADMIN_SESSION_SECRET`:** manter o atual → importar/re-cifrar → `integrations:reencrypt` → provar 0 legado (`key_version = 0` → 0 e colunas legadas limpas) → remover `ENCRYPTION_ALLOW_LEGACY_SESSION_KEY` → smoke e `test:app-role` → **só então** rotacionar → as sessões caem. Novo **OPS-36**.
10. **Ordem do OPS-14:** RELEASE F, depois da D' estável e da materialização.
    - **Antes da F:** `DATABASE_URL` é a role dona, e as flags da release N são desligadas.
    - **Na F:** `DATABASE_URL` passa a `oria_app` com `DB_ENFORCE_APP_ROLE=1`, e `MIGRATION_DATABASE_URL` fica com a role dona.
    - **Pre-deploy a partir da F:** `export DATABASE_URL="$MIGRATION_DATABASE_URL"`.
11. **Exit do `productization:gate`:**
    - 0 **somente** com OVERALL READY;
    - 1 = código bloqueado;
    - 2 = código pronto, rollout bloqueado;
    - 64 = uso inválido;
    - `--code-only` foi removido;
    - `--report-only` sai 0 e avisa que não é gate.
12. **Dogfood:** **NOT STARTED.**
    - O `DOGFOOD.json` guarda `dogfood_started_at`; os dias são contados pelo relógio (14, fixos).
    - Marcação manual → FAIL.
    - O início precisa ser ≥ `verified_at` de OPS-14 e OPS-36 (VERIFIED).
13. **Ordem final do runbook:**
    - OPS-27;
    - backup;
    - cenário B;
    - mapeamento e WhatsApp (`antes-da-b`);
    - A (Go aditivo);
    - vínculo dos criativos;
    - B (`31a7cdb`: migrations → owner → entitlements → import → reencrypt → sender) + observação;
    - C;
    - D0 + cutover da Ink;
    - E (migrations 2/3 do Go, inbox, leases);
    - D';
    - Go sem query;
    - materialização dos criativos;
    - F (OPS-14);
    - CLEANUP;
    - rotação do `ADMIN_SESSION_SECRET`;
    - dogfood.

    Detalhes em `production-rollout-runbook.md` §4.
14. **Dry-run:** `r19-runbook-dry-run.test.js` encadeia, num banco montado como a produção de hoje, na ordem:
    - preflight;
    - `antes-da-b`;
    - vínculo;
    - pre-deploy da B com o código de `31a7cdb`;
    - verify da B;
    - D0 com o código de `8c024d2` e emissão da URL da Ink;
    - preflight e pre-deploy da D';
    - verify do HEAD;
    - materialização;
    - preflight `after-ops14` com `oria_app`;
    - ensaio `tenant1:*` num segundo banco;
    - gate sem evidência: 36 OPS NOT VERIFIED, dogfood NOT STARTED, OVERALL BLOCKED, exit ≠ 0.

    O gate completo ficou **CODE PASS, exit 2**. O dry-run achou 5 divergências de texto, já corrigidas no runbook.
15. **Checklist do OPS-27:** `ops-27-checklist.md`. Pede só os 4 últimos dígitos do App ID, MATCH/NO MATCH do App Secret, o status do webhook real, `sig_verify` e os finais de WABA e número. Nunca pede o segredo.
16. **QW-01:** continua **OPEN** (sem evidência da topologia) e não bloqueia.
17. **npm test / build:** **894/894** (dentro do gate) e build PASS.
18. **Suíte sob `oria_app`:** **894/894** na 2ª execução. A 1ª deu 893/894: timeout de boot sob carga no controle negativo `remetente-global`, que passou isolado 3 vezes.
19. **Go:** `go test -race` com **135 PASS** (2 pulos esperados, processos filhos); `vet` e `build` PASS.
20. **Commits do painel:** `883e157..HEAD`, 30 commits (lista em `productization-progress.md`, rodada 19).
21. **Commits do Go:** `789b7c9`, `023398c`, `244bf45`.
22. **Blockers que restam:**
    - OPS-27;
    - consolidação operacional da Use Origens pronta para o corte;
    - OPS-01..36 sem evidência;
    - `ADMIN_SESSION_SECRET` atual, se tiver menos de 32 caracteres (exige decisão nova);
    - OPS-33 (extrator, fora do repositório);
    - dogfood.
23. **GO / NO-GO para o rollout real:** **NO-GO.** O código está pronto (CODE READY), mas o OPS-27 não foi verificado.

## Riscos registrados

- **Não ensaiados no Railway:** link simbólico no volume, entrega do mapeamento por variável (`TENANCY_MAPPING_JSON`) e backup do volume preservando links.
- **Afrouxamento aceito:** `role.app` sai INFO no verify do rollout antes do OPS-14; com `DB_ENFORCE_APP_ROLE=1` volta a FAIL.
- **Rollback de nível 1 some na F:** a Ink lida do ambiente e o login legado deixam de existir quando as flags da release N saem.
- **Testes intermitentes sob carga:** INV-18 (lease de 1 s), boot do servidor em 30 s nos controles negativos e réplica do Go. Passam isolados.
- **Porta sorteada pelo `test-db`:** pode ser ocupada antes do `docker run`, e o gate sai com exit 1 sem rodar teste.
- **Dependência do histórico:** os testes de contrato precisam de `bfd00a6`, `ed5a5b0`, `31a7cdb` e `8c024d2` no repositório (clone raso quebra, de propósito).
