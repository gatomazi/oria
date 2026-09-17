# Execução noturna — Productização Oria

Quero que você atue como **lead de implementação autônoma durante a noite** e avance o máximo possível na productização do Oria sem depender de confirmações intermediárias.

A prioridade é **entregar código funcionando, testado e com commits pequenos**, seguindo estritamente `docs/produtizacao-saas/productization-plan.md`, `productization-audit.md`, `productization-decisions.md` e `productization-progress.md`.

Não faça perguntas durante a execução salvo quando houver um bloqueio realmente impossível de contornar sem decisão humana. Se um workstream bloquear, avance outro independente.

---

# 0. Princípio de autonomia

Durante esta execução:

```text
PODE:
- alterar código;
- instalar dependências aprovadas pelo plano;
- criar migrations;
- criar/alterar testes;
- criar helpers/middlewares;
- refatorar apenas quando necessário para tenancy/segurança;
- criar commits locais pequenos;
- usar subagentes/worktrees;
- rodar build/test/lint/migrations em ambiente local/test;
- corrigir regressões encontradas durante a implementação.

NÃO PODE:
- fazer push;
- fazer deploy em produção;
- alterar Railway;
- alterar secrets reais;
- rodar migration contra banco de produção;
- apagar dados reais;
- fazer DROP destrutivo antecipado;
- alterar billing/preços/planos;
- fechar decisões comerciais OPEN por conta própria;
- iniciar janela coordenada de produção da Fase 5b;
- criar segundo tenant externo real.
```

A regra é:

```text
se for reversível, local e coberto pelo plano → execute;
se exigir ação externa/produção/credencial/decisão comercial → documente e siga outro workstream.
```

---

# 1. Antes de começar

Em cada repositório tocado:

```bash
git status
git log -5 --oneline
git diff
```

Preserve qualquer trabalho concorrente.

Nunca:

```bash
git reset --hard
git checkout -- .
git restore .
git add .
```

Faça staging seletivo.

Se houver trabalho não relacionado de outra sessão, não reverta, não incorpore e não mova.

---

# 2. Estratégia de execução noturna

Orquestre o trabalho em duas trilhas.

## Trilha A — repo principal Oria/painel

Execute sequencialmente:

```text
Fase 0 — Foundations
→ Fase 1 — Tenancy
→ Fase 2 — Auth
→ Fase 3 — Tenant Context
→ Fase 4 — Integrations
```

Só avance de fase se os critérios objetivos da fase anterior estiverem satisfeitos.

## Trilha B — `whatsapp-webhook-go`

Execute em paralelo:

```text
Fase 5a — preparação independente
```

Não entre em 5b/5c durante a madrugada, salvo se o plano indicar explicitamente que alguma parte é puramente local e não depende de cutover coordenado.

A janela coordenada painel ↔ Go é um ponto de parada deliberado.

---

# 3. Fase 0 — executar integralmente

Implemente tudo que já foi fechado na Rodada 7:

```text
TD-003 — Postgres obrigatório em produção
TD-004 — integration_secrets + ENCRYPTION_MASTER_KEY versionada
TD-010 — node-pg-migrate
```

Entregáveis mínimos:

```text
- node-pg-migrate instalado/configurado;
- migrations versionadas;
- baseline segura para banco existente;
- banco vazio monta schema somente por migrations;
- nenhum DDL/backfill de evolução no application boot;
- produção fail-fast sem DATABASE_URL;
- fallback efêmero apenas por opt-in explícito em dev/test;
- integration_secrets 1:N;
- key_version por segredo;
- ENCRYPTION_MASTER_KEY separada de ADMIN_SESSION_SECRET;
- compatibilidade legacy temporária e explícita;
- caminho auditável de recriptação;
- Postgres efêmero no CI/test;
- harness dos invariants;
- negative controls reais;
- INV-09 com exatamente uma Organization e recurso sem atribuição.
```

## Validação obrigatória do harness

Não aceite um harness que só fica verde.

Para cada classe crítica disponível:

```text
PASS
→ violação deliberada
→ FAIL
→ remover violação
→ PASS
```

Classes:

```text
tenancy/ownership
auth
entitlement
secrets
webhook
```

Quando uma classe depender de fase futura, construa somente o detector/foundation necessário sem antecipar a feature.

---

# 4. Fechamento técnico de TD-001

Após a Fase 0 estar verde, reavalie TD-001 usando a evidência real produzida.

Direção preferencial já documentada:

```text
shared schema
+ organization_id
+ RLS
+ testes automáticos de isolamento
```

Se **nenhuma evidência nova contrariar essa direção**, feche TD-001 como:

```text
CLOSED (V1)
```

e registre a decisão com a justificativa factual.

Se surgir evidência material contra essa direção, **não invente nova arquitetura**. Marque como blocker e continue a Fase 5a ou outro trabalho independente.

---

# 5. Fase 1 — Tenancy

Objetivo:

```text
introduzir Organization como fronteira real de isolamento
sem introduzir multi-store
```

Modelo obrigatório:

```text
Session
  ↓
Organization
  ↓
Store 1:1
```

Regras:

```text
organization_id = eixo de isolamento
store_id = entidade de domínio, não tenant selector da V1
```

Implemente as migrations em etapas:

```text
1. adicionar novas estruturas/colunas nullable quando necessário;
2. backfill determinístico;
3. validar;
4. criar constraints;
5. RLS/policies;
6. migrar leitores/escritores;
7. só depois remover legado.
```

Nunca atribua Organization fictícia apenas para satisfazer `NOT NULL`.

## Dados atuais internos

Respeite PD-019/PD-022:

```text
sem visão consolidada cross-Organization
sem multi-store
sem modo "all"
sem fetchAcrossInkStores
```

Se a consolidação Use Origens ainda não estiver refletida no banco local/test, use fixtures de migração, não invente estado de produção.

## RLS

Use RLS como defesa em profundidade, não como substituto de ownership checks.

Testes obrigatórios:

```text
Org A não lê/escreve B
Org B não lê/escreve A
recurso sem Organization não aparece em nenhum tenant
IDs válidos de outro tenant falham
RLS protege mesmo quando uma query esquece filtro explícito
```

---

# 6. Fase 2 — Auth

Implemente identidade individual.

Direção já fechada:

```text
sem senha global compartilhada
usuário individual
organization_members
```

Para roles, se a decisão rica continuar aberta, use somente o mínimo já recomendado:

```text
owner
member
```

Não crie matriz sofisticada de permissões.

Objetivos:

```text
- autenticação identifica user;
- sessão referencia identidade real;
- membership resolve Organizations autorizadas;
- offboarding é possível;
- audit log recebe actor_user_id;
- sessão não carrega tenant vindo do browser.
```

Se alguma decisão comercial sobre convite/billing impedir UI completa, implemente backend/foundation e prossiga.

---

# 7. Fase 3 — Tenant Context

Esta é a fase de maior risco. Trabalhe por domínio, não por rename em massa.

Pipeline alvo obrigatório:

```text
authenticateUser
      ↓
resolveOrganization
      ↓
verifyMembership
      ↓
resolveOrganizationStore
      ↓
checkEntitlement
      ↓
handler
```

## Remover tenant controlado pelo frontend

Nas rotas onde hoje há:

```text
?loja=
body.loja
params.loja
```

e a Store é derivável da sessão:

```text
remover o parâmetro de tenant da API
```

Não apenas validar melhor.

Para rotas por recurso:

```text
/:id
/:campaignId
/:jobId
/:customerId
...
```

faça ownership check explícito contra a Organization autenticada.

## F-02

Tratar por remoção:

```text
fetchAcrossInkStores → remover
loja='all' → remover
omissão que agrega todas → remover
```

Especial atenção a Customers/PII.

## Fail-closed

Qualquer:

```text
escopo ausente
ownership ambíguo
recurso não atribuído
id de outra Organization
```

deve resultar em:

```text
erro / exclusão / sinalização
```

Nunca:

```text
pegar único candidato
pegar primeiro
desligar filtro
usar global
```

---

# 8. Entitlements dentro da Fase 3

TD-012 continua decisão técnica aberta, mas a direção auditada é clara:

```text
backend authoritative
fail-closed
frontend = UX
```

Se nenhuma evidência nova contradizer isso, implemente o mecanismo mínimo:

```text
checkEntitlement()
```

com:

```text
ausente/indeterminado → deny
```

Não invente pricing ou plano comercial.

Use entitlements neutros/configuráveis para que PD-005/PD-009 possam ser preenchidas depois.

---

# 9. Fase 4 — Integrations

Migrar conexões de:

```text
singleton por instalação
```

para:

```text
ownership por Organization
```

Prioridades:

```text
Meta Ads
Google Ads
GA4
Reserva Ink
Creative Core / OpenAI BYOK
WhatsApp contract no painel
```

Remover padrões como:

```text
CHECK (id = 1)
seleção global
LIMIT 1 global
env usada como identidade de tenant
```

Substituir por:

```text
organization_id
ownership explícito
fail-closed
```

## Financeiro

F-01 e G-01 mostram regra duplicada.

Centralize o resolver de recursos financeiros/marketing para garantir:

```text
recurso só entra na DRE se ownership resolve inequivocamente para a Organization
```

Não corrija duas implementações separadamente se puder existir uma única fonte de verdade.

---

# 10. Fase 5a — `whatsapp-webhook-go` em paralelo

No repo Go, implemente apenas o que é independente do cutover multi-tenant.

Inclua prioritariamente:

```text
- produção sem META_APP_SECRET → boot aborta;
- webhook sem assinatura → rejeita;
- assinatura inválida → rejeita;
- API_KEY obrigatória em produção;
- DATABASE_URL obrigatória em produção;
- remover defaults fail-open de segurança;
- corrigir problemas independentes de tenancy já classificados na 5a;
- preparar metaPost para receber identidade/remetente explicitamente,
  mantendo compatibilidade temporária apenas onde o plano permite;
- testes negativos correspondentes.
```

Não faça ainda a troca coordenada do contrato com o painel que removerá `phone_number_id` do `/health`.

## OPS-06

A variável foi adicionada no Railway, mas até confirmação de restart permaneça factual:

```text
OPS-06 = definido, aguardando restart/deploy
```

Isso não fecha o blocker estrutural.

---

# 11. Não executar Fase 5b durante a madrugada

Pare antes da janela coordenada se ela exigir:

```text
deploy dos dois serviços
mudança de contrato ativa
alteração de Railway
troca de variável real
cutover que possa interromper envio/recebimento
```

Deixe tudo pronto para que a janela possa ser feita depois com uma sequência curta e previsível.

---

# 12. Product decisions

Não feche sozinho decisões comerciais como:

```text
pricing
trial
free tier
módulos de plano
retenção comercial
add-ons
Instagram
Mailchimp
```

Se alguma delas bloquear UI/feature:

```text
implemente foundation neutra
documente o gate
avance outro domínio
```

## Decisões técnicas

Pode fechar uma decisão técnica OPEN **somente** quando:

```text
- a recomendação já está documentada;
- a implementação fornece evidência;
- não há tradeoff comercial;
- não muda o tenant model;
- não cria nova arquitetura incompatível com o plano.
```

Registre a justificativa.

---

# 13. Política de commits

Faça commits pequenos e coerentes.

Formato preferencial:

```text
chore(db): ...
feat(tenancy): ...
feat(auth): ...
refactor(scope): ...
feat(integrations): ...
test(isolation): ...
fix(security): ...
```

Não misture:

```text
migration + UI grande + refactor unrelated
```

Antes de cada commit:

```bash
git status
git diff --staged
```

Nunca inclua arquivos concorrentes sem relação com o workstream.

Não faça push.

---

# 14. Regra para regressões

Se build/test quebrar:

```text
não avance fingindo que a fase fechou
```

Corrija até:

```text
build verde
testes da fase verdes
invariants da fase verdes
```

Se a regressão for externa/infra e impossível localmente:

```text
documente evidência
marque blocker
continue workstream independente
```

---

# 15. Regra de invariants

Uma fase só fecha quando os invariants aplicáveis realmente passam.

Sinal de alarme:

```text
Fase 1, 3 ou 5a fechar com todos os invariants verdes na primeira execução,
sem nenhum teste negativo demonstrado
```

Nesse caso, revise os testes antes de considerar a fase concluída.

O objetivo é detectar falha, não apenas obter verde.

---

# 16. Testes e evidência

Ao longo da noite, mantenha em `productization-progress.md`:

```text
- fase atual;
- commits;
- blockers fechados;
- blockers restantes;
- invariants PASS/FAIL;
- migrations executadas;
- resultado de build;
- resultado de testes;
- decisões técnicas fechadas;
- qualquer desvio do plano e motivo.
```

Não atualize a documentação com afirmação que não esteja sustentada pelo código/teste real.

---

# 17. Critério de parada automática

Pare a execução quando ocorrer o primeiro destes:

```text
1. chegar à Fase 5b e precisar de cutover coordenado;
2. faltar decisão comercial humana;
3. faltar secret/infra externa impossível de simular;
4. alguma migration exigir ação destrutiva em dados reais;
5. aparecer evidência que invalida o tenant model já fechado;
6. os repos entrarem em conflito com trabalho concorrente impossível de reconciliar com segurança.
```

Se isso acontecer:

```text
não espere parado
→ avance qualquer workstream independente ainda disponível
```

Pare de fato somente quando não houver mais trabalho seguro e independente.

---

# 18. Meta para esta madrugada

Objetivo ideal, se tudo ficar verde:

```text
Fase 0 concluída
TD-001 fechada
Fase 1 concluída
Fase 2 concluída
Fase 3 substancialmente concluída
Fase 4 iniciada/concluída conforme tempo
Fase 5a concluída no repo Go
Fase 5b preparada, mas NÃO executada
```

Não force essa meta sacrificando invariants ou segurança.

Qualidade e isolamento têm precedência sobre quantidade de fases.

---

# 19. Relatório final para amanhã

Quando não houver mais trabalho seguro para executar, deixe um relatório final em:

```text
docs/produtizacao-saas/overnight-report.md
```

Estrutura:

```text
# Overnight Productization Report

## Estado final
## Commits por repositório
## Fases concluídas
## Fases parcialmente concluídas
## Blockers fechados
## Blockers restantes
## Invariants PASS
## Invariants FAIL / não implementados
## Migrations criadas
## Mudanças de schema
## Mudanças de contrato
## Testes antes/depois
## Build
## Decisões técnicas fechadas
## Ações externas que ficaram pendentes
## Riscos encontrados
## Primeiro passo recomendado para a manhã
```

No terminal/chat, retorne uma versão curta com:

```text
- onde parou;
- último commit de cada repo;
- testes/build;
- blocker que impediu continuar, se houver;
- primeira ação que eu devo tomar ao acordar.
```

---

# 20. Regra final

Não me acorde por dúvida pequena.

Use o plano, os invariants e as decisões já registradas como contrato.

Quando houver duas soluções equivalentes, prefira:

```text
a mais simples
a mais fail-closed
a mais fácil de testar
a que introduz menos estado global
a que elimina caminho legado em vez de mantê-lo indefinidamente
```

Pode começar.
