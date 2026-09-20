# Rodada paralela — Auditoria do workspace + otimização do CI

## Contexto

Enquanto seguem duas frentes já em andamento:

```text
A. Connector Ink sem loja_legada
B. Features × Connector Capabilities
```

abrimos duas frentes adicionais, independentes e não conflitantes:

```text
C. Auditoria/consolidação dos diretórios paralelos do workspace
D. Otimização do CI do monorepo
```

Estas duas novas frentes podem rodar em paralelo com as atuais.

IMPORTANTE:

```text
NÃO alterar arquivos das frentes A ou B sem necessidade comprovada.
NÃO interromper suítes já em execução.
NÃO fazer mudanças destrutivas.
NÃO remover diretórios nesta primeira fase.
```

---

# PARTE C — Auditoria dos diretórios paralelos do workspace

## Situação observada

No workspace existem hoje quatro diretórios no mesmo nível:

```text
oria/
oria-capabilities/
oria-panel-flat/
oria-platform-admin/
```

A arquitetura canônica esperada é o monorepo:

```text
oria/
├── apps/
│   ├── panel/
│   ├── platform-admin/
│   └── creative-generator/
├── services/
│   └── whatsapp/
├── contracts/
├── docs/
├── infra/
└── scripts/
```

Os três diretórios paralelos parecem ter sido criados em rodadas anteriores para worktrees, migrações ou trabalho isolado.

Não assumir que podem ser removidos sem auditoria.

## C1. Objetivo

Para cada diretório:

```text
oria-capabilities
oria-panel-flat
oria-platform-admin
```

descobrir se é:

```text
A. Git worktree ativo
B. clone temporário
C. branch de trabalho paralela
D. staging de migração
E. código ainda não incorporado no monorepo
F. duplicação já totalmente absorvida pelo monorepo
G. diretório ainda exigido por CI/deploy/tooling
```

E classificar como:

```text
KEEP
MERGE INTO ORIA
ARCHIVE
SAFE TO REMOVE
```

## C2. Regras da auditoria

Nesta primeira etapa:

```text
NÃO apagar
NÃO mover
NÃO renomear
NÃO fazer merge
NÃO fazer cherry-pick
NÃO fazer rebase
NÃO remover worktree
NÃO alterar Railway
NÃO alterar GitHub
```

Somente leitura e comparação.

## C3. Natureza Git de cada diretório

Para:

```text
oria/
oria-capabilities/
oria-panel-flat/
oria-platform-admin/
```

levantar:

```text
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short
git remote -v
git worktree list
```

Determinar:

```text
repo independente
clone do mesmo remote
worktree do mesmo repo
diretório sem Git próprio
```

## C4. Dirty state

Para cada diretório paralelo:

```text
git status
git diff
git diff --cached
```

Listar:

```text
arquivos modificados
arquivos novos
arquivos untracked
staged
commits locais não enviados
```

Um diretório com trabalho exclusivo NÃO pode ser considerado removível.

## C5. Comparação de commits

Comparar cada paralelo com:

```text
oria/main
```

Identificar:

```text
commits exclusivos
commits já absorvidos
commits equivalentes via squash/cherry-pick
divergência real
```

Não comparar somente SHA quando houver possibilidade de squash/cherry-pick.

Comparar também conteúdo.

## C6. Comparação por diretório

### `oria-platform-admin`

Comparar com:

```text
oria/apps/platform-admin/
```

Verificar:

```text
source
migrations
tests
negative controls
scripts
package files
docs
CI
Railway config
```

Responder se tudo relevante já foi incorporado ao monorepo.

### `oria-panel-flat`

Comparar com:

```text
oria/apps/panel/
```

Especialmente:

```text
server.js
frontend SPA
package.json
package-lock.json
vite config
routes
migrations
tests
scripts
docs
```

Determinar se ele foi apenas staging da refatoração que promoveu o antigo painel para a raiz de `apps/panel`.

### `oria-capabilities`

Descobrir exatamente qual frente criou este diretório.

Provável relação com:

```text
features
capabilities
entitlements
connectors
creative capabilities
plan registry
```

Comparar com a frente atualmente em andamento de:

```text
Features × Connector Capabilities
```

ATENÇÃO:

Se `oria-capabilities` estiver sendo usado pelo agente dessa frente AGORA:

```text
classificar temporariamente como KEEP / ACTIVE WORKTREE
```

Não consolidar enquanto a frente não terminar.

## C7. Referências externas

Buscar referências textuais aos diretórios:

```text
oria-capabilities
oria-panel-flat
oria-platform-admin
```

em:

```text
scripts
docs
README
CI
GitHub Actions
Railway
Dockerfiles
Claude configs
VS Code workspace
shell scripts
runbooks
package scripts
symlinks
```

## C8. Railway

Verificar apenas leitura.

Arquitetura esperada:

```text
oria-panel
→ oria/apps/panel

oria-admin
→ oria/apps/platform-admin

oria-creatives
→ oria/apps/creative-generator

oria-whatsapp
→ oria/services/whatsapp
```

Se algum serviço ainda depender de:

```text
oria-panel-flat
oria-platform-admin
oria-capabilities
```

registrar como blocker.

Não alterar Railway.

## C9. CI

Verificar se workflows ainda referenciam algum diretório paralelo.

Ideal:

```text
todos os jobs
→ checkout do monorepo oria
→ working-directory dentro dele
```

## C10. Migrations

Comparar migrations cuidadosamente.

Nenhuma migration presente somente em diretório paralelo pode ser perdida.

Listar:

```text
migration
origem
existe no monorepo?
mesmo conteúdo?
já aplicada?
```

## C11. Testes e negative controls

Comparar:

```text
testes
fixtures
negative controls
smokes
runbooks
```

Listar qualquer arquivo exclusivo.

## C12. Docs

Comparar:

```text
docs/architecture
docs/productization
docs/operations
docs/commands
docs/runbooks
```

Listar docs ainda não incorporados.

## C13. Secrets/env

Somente detectar existência:

```text
.env
.env.local
.env.production
```

Retornar:

```text
existe?
tracked?
untracked?
```

NÃO imprimir valores.
NÃO copiar automaticamente.

## C14. Verificar monorepo canônico

Antes de recomendar remoção, provar que `oria/` contém e consegue representar:

```text
Panel
Platform Admin
Creative Generator
WhatsApp
contracts
migrations
tests
docs
infra
CI
```

## C15. Checkpoint da auditoria

Para cada paralelo retornar:

```text
diretório:
natureza:
branch:
HEAD:
remote:
dirty:
commits exclusivos:
arquivos exclusivos:
migrations exclusivas:
testes exclusivos:
docs exclusivos:
referências externas:
dependência de CI:
dependência de Railway:
classificação:
motivo:
```

Depois retornar:

```text
sequência segura de consolidação
GO / NO-GO para no futuro ficar apenas com oria/
```

NÃO executar consolidação ainda.

---

# PARTE D — Otimização do CI

## Situação observada

O CI já possui jobs separados por projeto:

```text
contratos cross-service e autocontenção
painel (Node)
control plane (Oria Admin)
gerador de criativos (Python)
serviço de whatsapp (Go)
```

Portanto:

```text
NÃO dividir repositórios apenas para acelerar CI.
```

O maior gargalo observado está dentro do job:

```text
painel (Node)
```

Exemplo recente:

```text
suíte normal do painel       ~17 min
suíte sob oria_app           executada novamente
build SPA                    depois
```

Além disso, localmente a suíte completa pode passar de 2h em rodadas pesadas.

## D1. Objetivo

Reduzir significativamente o tempo de feedback sem reduzir cobertura de segurança.

Alvo conceitual:

```text
FAST CI
~5–12 min quando possível

FULL VERIFICATION
mais pesada
somente quando necessária
```

Não sacrificar:

```text
RLS
tenant isolation
migrations
dry-run de release
negative controls
cross-service contracts
```

## D2. Primeira tarefa: medir

Antes de alterar o workflow, produzir inventário de tempo.

Para cada etapa do CI:

```text
setup
npm ci
migrations do zero
migrations idempotentes
suite painel
suite oria_app
build SPA
negative controls
dry-run
```

Registrar:

```text
tempo médio
quantidade de testes
dependência de banco?
precisa realmente rodar sob oria_app?
pode ser paralelizada?
```

Não otimizar no escuro.

## D3. Auditar a segunda suíte sob `oria_app`

Hoje aparentemente grande parte da suíte roda novamente usando:

```text
oria_app
```

Auditar teste a teste ou grupo a grupo.

Classificar:

```text
A. precisa rodar sob oria_app
B. independe da role DB
C. puro/unitário
D. integração DB mas não RLS
E. tenancy/RLS
```

Regra:

```text
teste que não valida comportamento dependente da role do PostgreSQL
não precisa ser executado uma segunda vez sob oria_app
```

Objetivo:

```text
oria_app suite
→ somente testes que realmente provam runtime role/RLS/tenancy
```

## D4. Separar tipos de teste

Estruturar suites conceitualmente:

```text
unit
integration-db
tenancy-rls
negative-controls
migrations
release-compatibility
spa-build
```

Não precisa reorganizar toda árvore de arquivos se tags/scripts já resolverem.

Preferir menor mudança estrutural.

## D5. Sharding da suíte pesada

Auditar possibilidade de dividir:

```text
integration-db
```

em shards.

Exemplo:

```text
panel-db-1
panel-db-2
panel-db-3
panel-db-4
```

IMPORTANTE:

```text
cada shard deve usar ambiente DB isolado
```

Não:

```text
4 workers → mesmo Postgres
```

Isso já causou falhas falsas na prática.

Preferir:

```text
job 1 → Postgres service próprio
job 2 → Postgres service próprio
job 3 → Postgres service próprio
job 4 → Postgres service próprio
```

## D6. Determinar shard strategy

Investigar o test runner atual.

Preferir uma estratégia determinística:

```text
por arquivo
por grupo
por hash de filename
por suite explícita
```

Evitar divisão aleatória.

Cada teste deve rodar em exatamente um shard.

## D7. Suites que não devem ser shardadas sem prova

Manter separadas:

```text
migration from zero
migration idempotency
old-release dry-run
global negative controls
```

especialmente se exigirem sequência.

## D8. CI afetado por paths

Criar um estágio inicial:

```text
changes
```

que detecta quais partes foram alteradas.

Matriz conceitual:

```text
apps/panel/**
→ panel

apps/platform-admin/**
→ platform-admin

apps/creative-generator/**
→ creative-generator

services/whatsapp/**
→ whatsapp

contracts/**
→ consumidores necessários

migrations/shared tenancy/contracts críticos
→ suites ampliadas
```

## D9. Não depender apenas de filtros de workflow

Preferir:

```text
1 workflow principal
→ job "changes"
→ jobs condicionais
→ gate final
```

em vez de espalhar vários workflows com `paths` de forma que checks obrigatórios possam ficar inconsistentes.

## D10. Gate agregado

Criar/avaliar um job final:

```text
ci-gate
```

que passa somente se todos os jobs relevantes para aquele diff passaram.

Isso permite branch protection depender de:

```text
ci-gate
```

em vez de dezenas de checks condicionais.

## D11. Fast CI

Para PR/commit comum:

```text
lint/typecheck se existentes
affected projects
unit
integration shards relevantes
subset tenancy/RLS
negative controls relevantes
build do app afetado
```

Meta:

```text
feedback rápido
```

## D12. Full Verification

Rodar em:

```text
merge/main
manual
release
nightly
mudança crítica de tenancy/schema
```

Conteúdo:

```text
todas as suítes
todas as roles
migrations from zero
idempotency
old-release dry-run
negative controls completos
cross-service contracts
builds completos
```

Não remover essa camada.

## D13. Regras especiais para migrations

Se diff toca:

```text
migrations
tenancy manifests
RLS
integration_secrets
store identity
shared DB infrastructure
```

forçar automaticamente:

```text
full panel DB suite
oria_app/RLS suite
migration tests
dry-run compatibility
negative controls relevantes
```

## D14. Regras especiais para contracts

Se diff toca:

```text
contracts/**
```

rodar consumidores afetados.

Exemplo:

```text
WhatsApp contract
→ panel + whatsapp
```

Derivar do repo real.

## D15. Cache

Auditar uso atual de cache.

Configurar quando útil:

```text
npm cache
Go modules/build cache
Python pip cache
```

Mas não tratar cache como solução principal.

Se:

```text
npm ci ~7s
```

não gastar grande esforço nisso antes dos testes.

## D16. Build SPA

Verificar se:

```text
build SPA
```

pode rodar em paralelo com suites DB depois de dependências instaladas.

Não precisa esperar 25 minutos de testes se não há dependência lógica.

Preferir job independente:

```text
panel-build
```

se simples.

## D17. Migrations

Verificar se:

```text
migrations do zero
migrations idempotentes
```

podem rodar em jobs paralelos usando Postgres isolado.

Se não dependem uma da outra:

```text
job migration-zero
job migration-idempotency
```

## D18. Test isolation

Criar/verificar regra explícita:

```text
nenhuma suite DB paralela compartilha o mesmo banco/container
```

Adicionar comentário/documentação no workflow.

## D19. Local developer workflow

Criar scripts claros para evitar rodar 2h toda hora.

Exemplo conceitual:

```text
npm run test:unit
npm run test:panel:affected
npm run test:db
npm run test:rls
npm run test:full
```

Adaptar aos scripts reais.

Objetivo:

```text
durante desenvolvimento → suite direcionada
antes de commit crítico → suite maior
CI/main → full verification
```

## D20. Não mascarar regressões

Nenhuma otimização pode simplesmente:

```text
remover testes lentos
pular RLS
pular dry-run
pular migrations
pular negative controls
```

A otimização é:

```text
não duplicar
selecionar
paralelizar com isolamento
mover full checks para momento adequado
```

## D21. Medir ganho

Depois das alterações, comparar:

```text
ANTES
wall time
CPU total aproximada
jobs críticos
suite duplicada

DEPOIS
wall time
número de shards
tempo até primeiro feedback
tempo full verification
```

## D22. Meta inicial

Não prometer número artificial.

Mas mirar:

```text
PR comum:
~5–12 min

mudança de painel mais pesada:
~10–20 min

Full Verification:
pode continuar maior,
mas não deve bloquear toda iteração de desenvolvimento
```

## D23. Segurança de concorrência

Como já houve 28 falhas falsas por dois testes DB simultâneos no mesmo container:

```text
essa regra precisa virar invariant do CI
```

Nunca paralelizar testes DB dentro do mesmo banco sem isolamento provado.

## D24. Interação com as frentes atuais

Enquanto:

```text
Connector Ink
Features × Connector Capabilities
```

estão em andamento:

```text
NÃO reformatar workflows indiscriminadamente
NÃO mudar scripts usados por suítes que já estão rodando
```

Primeiro:

```text
auditar
propor
preparar mudança em arquivos isolados
```

Se precisar tocar arquivo que outra frente também toca:

```text
STOP
reportar conflito
```

---

# DIVISÃO DE ARQUIVOS / FRONTEIRAS

## Frente C — Workspace audit

Preferencialmente só leitura.

Pode criar apenas:

```text
docs/architecture/workspace-consolidation-audit.md
```

Não alterar source code.

## Frente D — CI

Antes de implementar, pode criar:

```text
docs/operations/ci-optimization-audit.md
```

Depois da auditoria, alterações permitidas somente em:

```text
.github/workflows/**
scripts de teste/CI
package scripts estritamente necessários
docs/operations/**
```

NÃO tocar:

```text
apps/panel/server.js
migrations
connector Ink runtime
feature registry
entitlements
```

sem autorização explícita.

---

# ESTRATÉGIA DE EXECUÇÃO

Estas duas frentes podem ser executadas em paralelo por agentes separados.

## Agente C

Responsável por:

```text
workspace audit
worktrees
duplicações
comparação
consolidação futura
```

## Agente D

Responsável por:

```text
CI timings
suite classification
sharding
affected paths
fast/full CI
```

Eles não devem editar os mesmos arquivos.

---

# CHECKPOINT FINAL — FRENTE C

Retornar:

```text
1. natureza de oria-capabilities
2. natureza de oria-panel-flat
3. natureza de oria-platform-admin
4. branches/HEAD/remotes
5. dirty state
6. commits exclusivos
7. arquivos exclusivos
8. migrations exclusivas
9. testes exclusivos
10. docs exclusivos
11. Railway dependencies
12. CI dependencies
13. classificação KEEP/MERGE/ARCHIVE/REMOVE
14. blockers
15. sequência de consolidação
16. GO/NO-GO para deixar só oria/
```

Não consolidar ainda.

---

# CHECKPOINT FINAL — FRENTE D

Retornar:

```text
1. timeline atual do CI
2. tempo por etapa
3. quantos testes realmente precisam de oria_app
4. duplicações encontradas
5. divisão unit/integration/RLS/etc.
6. shard strategy
7. isolamento de Postgres por shard
8. affected-project strategy
9. fast CI proposto
10. full verification proposto
11. migration rules
12. contracts rules
13. ci-gate
14. scripts locais
15. alterações de workflow
16. tempo antes/depois
17. riscos
18. blockers
19. commits
20. GO/NO-GO para adotar o novo pipeline
```

---

# Resultado desejado

## Workspace

Ideal futuro:

```text
workspace/
└── oria/
```

somente se comprovadamente seguro.

## CI

Ideal:

```text
changes
   ↓
affected jobs
   ├── panel unit
   ├── panel DB shards
   ├── tenancy/RLS
   ├── panel build
   ├── admin
   ├── creatives
   ├── whatsapp
   └── contracts
        ↓
     ci-gate
```

com:

```text
Fast CI
→ feedback rápido

Full Verification
→ segurança completa em main/release/nightly
```
