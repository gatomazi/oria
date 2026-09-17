# Rodada 21 — Tornar o Oria autocontido, marcar OPS-27 VERIFIED e fechar estratégia de rollout

O monorepo Oria está pronto localmente.

Agora faça uma rodada curta de consolidação **antes do primeiro push**.

Tudo continua local nesta rodada:

```text
SEM push
SEM deploy
SEM criar projeto Railway
SEM tocar produção
SEM banco de produção
SEM alterar repositórios antigos
```

O objetivo é deixar o novo repositório `oria` completamente autocontido e remover decisões que já foram tomadas.

## 1. Estado aceito

Repo novo:

```text
/Users/gtomazi/projects/oria
branch: main
origin atual: git@github.com:gatomazi/oria.git
```

Componentes:

```text
apps/panel
apps/creative-generator
services/whatsapp
```

Estado:

```text
panel: 895/895 + build PASS
panel under oria_app: 895/895
creative-generator: 104 tests PASS
whatsapp: 135 PASS with -race + vet/build PASS
root npm test: PASS
```

Gate atual:

```text
CODE PASS
OPS NOT VERIFIED
DOGFOOD NOT STARTED
OVERALL BLOCKED
exit 2
```

## 2. OPS-27 — marcar VERIFIED

Atualização operacional confirmada pelo usuário:

```text
o META_APP_SECRET foi recuperado novamente diretamente
no Meta Developers, no mesmo App correspondente ao META_APP_ID
usado pelo whatsapp-webhook-go.

Após atualizar o secret no ambiente real,
o fluxo real de mensagens voltou a funcionar normalmente.

A validação HMAC continuou habilitada.
Não foi necessário desabilitar ou enfraquecer
X-Hub-Signature-256.
```

Portanto registrar:

```text
OPS-27 = VERIFIED
```

Atualizar todos os lugares que ainda mostram `OPS-27 NOT VERIFIED` ou `OPS-27 blocker`, incluindo docs de productization, operations, gates, preflight, runbook e bootstrap. Não reescrever relatórios históricos; neles, se necessário, adicionar apenas nota posterior de resolução.

## 3. Interpretação técnica

Registrar explicitamente:

```text
META_APP_SECRET é secret da plataforma/App Meta
META_APP_ID e META_APP_SECRET precisam pertencer ao mesmo App
HMAC permanece obrigatório
```

Não mover META_APP_SECRET para tenant secret.

## 4. Estratégia Railway — decisão fechada

Remover a bifurcação que restou no bootstrap.

A decisão atual é:

```text
NOVO projeto Railway chamado Oria
```

com:

```text
oria-panel
oria-creatives
oria-whatsapp
```

todos apontando para o novo monorepo `gatomazi/oria`.

O projeto Railway antigo continua como stack legada / rollback e NÃO é o alvo final do rollout.

Atualizar `docs/operations/railway-bootstrap.md`, `docs/productization/production-rollout-runbook.md` e `infra/railway/services.md`. Remover texto do tipo "decidir se usa projeto antigo ou novo".

## 5. Estratégia de cutover

Documentar como única direção:

```text
LEGACY RAILWAY continua live
→ NEW ORIA RAILWAY sobe isolado
→ validação/migrations/import
→ cutovers coordenados
→ dogfood
→ legacy permanece disponível para rollback por janela definida
```

Não executar.

## 6. Tornar o monorepo autocontido

O checkpoint informou que 4 testes de contrato ainda exigem o repositório antigo. Isso é blocker para considerar o novo repo independente.

Localizar os 4 casos e remover a dependência externa.

Objetivo:

```text
clone limpo de gatomazi/oria
→ consegue rodar toda a suíte
→ sem precisar de sibling repos antigos
```

Se precisarem de fixtures, mover/canonicalizar em `contracts/`. Se precisarem de source snapshot, substituir por fixture mínima versionada. Não referenciar caminho absoluto da máquina.

## 7. check_core_mirror.py

O Streamlit NÃO entrou no produto Oria.

Se o script não pertence ao runtime/build/test do Oria, não importar/remover referência residual. Se alguma suíte do Gerador ainda depende dele, adaptar para `apps/creative-generator`.

Ao final:

```text
grep por path do repo antigo → zero em código executável/testes
```

Documentação histórica pode citar a origem.

## 8. Gerador — PyPI inacessível nesta máquina

Isso não é blocker se dependências estão declaradas corretamente e CI consegue instalar em ambiente normal.

Verificar requirements/pyproject/lock e garantir que CI não depende de `CREATIVE_PYTHON` apontando para ambiente local.

Não vendorizar pacotes só porque a máquina local estava sem acesso ao PyPI.

## 9. CI do monorepo

Garantir que `.github/workflows/ci.yml` roda a partir de clone limpo.

Não pode depender de paths absolutos, sibling repos antigos ou `CREATIVE_PYTHON` local.

Pode usar Postgres service container, setup-node, setup-go e setup-python.

Sem deploy.

## 10. Root self-containment test

Adicionar `npm run repo:self-check` ou equivalente.

Ele deve falhar se encontrar em código executável/config de teste:

```text
paths absolutos locais
paths dos source repos
dependência de sibling repo
```

Evitar falso positivo em manifesto de origem e relatórios históricos.

## 11. Remote Git — trocar para HTTPS

Trocar SOMENTE o remote local do NOVO repo Oria:

```bash
git remote set-url origin https://github.com/gatomazi/oria.git
git remote -v
```

Esperado:

```text
origin https://github.com/gatomazi/oria.git (fetch)
origin https://github.com/gatomazi/oria.git (push)
```

Não tocar remotes dos repos antigos. NÃO executar push nesta rodada.

## 12. Primeiro push — apenas preparar

Validar `git status`, `git log --oneline --decorate -15` e `git remote -v`.

Informar no checkpoint o comando:

```bash
git push -u origin main
```

Mas NÃO executar.

## 13. Gate depois do OPS-27

Esperado:

```text
CODE PASS
OPS remaining NOT VERIFIED > 0
DOGFOOD NOT STARTED
OVERALL BLOCKED
exit 2
```

OPS-27 não aparece mais na lista de pendências.

## 14. Fase 6

Continuar:

```text
CODE READY
CLOSED = NÃO
```

Ainda faltam infra Railway nova, rollout real, demais OPS e dogfood 14 dias.

## 15. Railway bootstrap

Sem criar nada no Railway ainda.

O runbook final deve dizer inequivocamente:

```text
Project: Oria

Services:
- oria-panel
- oria-creatives
- oria-whatsapp

Databases:
- painel postgres
- whatsapp postgres

Volume:
- painel somente, conforme path documentado
```

## 16. Networking

Confirmar no runbook:

```text
oria-panel:
  public web
  private access to creative + whatsapp

oria-creatives:
  private only

oria-whatsapp:
  public ingress necessário para Meta webhook
  internal endpoints protected
```

Se Ink webhook entra no painel, panel public ingress cobre Ink.

## 17. Env manifest

Atualizar para refletir OPS-27 VERIFIED sem inserir valor real de secret. Checar novos envs das rodadas 18/19.

## 18. Secret scan

Repetir antes do commit para `.env`, private keys, DB URLs, Meta secrets, tokens, API keys e fixtures reais.

## 19. Validação final

Root:

```bash
npm test
npm run repo:self-check
```

Panel:

```bash
npm test
npm run build
```

e suíte sob `oria_app`.

Creative Generator: suite/build/typecheck existentes em ambiente limpo quando possível.

Go:

```bash
go test -race ./...
go vet ./...
go build ./...
```

## 20. Commits sugeridos

```text
fix(repo): remove legacy repository dependencies
fix(ci): make Oria builds self-contained
docs(ops): mark OPS-27 verified
docs(railway): lock rollout to new Oria project
```

## 21. Checkpoint

Retornar:

```text
1. OPS-27 final
2. blockers restantes
3. Railway target final
4. status do Railway legado
5. dependências dos source repos removidas
6. 4 contract tests — como ficaram
7. check_core_mirror status
8. generator clean-environment status
9. CI self-contained
10. repo:self-check
11. remote final
12. git status
13. root test
14. panel test/build
15. panel oria_app
16. generator tests/build
17. Go race/vet/build
18. productization gate
19. Fase 6 state
20. secret scan
21. commits
22. comando de primeiro push, NÃO executado
23. recomendação objetiva do próximo passo
```

Esperado:

```text
ORIA REPO = SELF-CONTAINED
OPS-27 = VERIFIED
NEW RAILWAY PROJECT ORIA = TARGET FECHADO
LEGACY RAILWAY = ROLLBACK SOURCE
PRODUCTION ROLLOUT = AINDA BLOCKED
FASE 6 = CODE READY, NOT CLOSED
FIRST PUSH = READY, NOT EXECUTED
```

Pare aí.
