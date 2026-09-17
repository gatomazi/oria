# Instrução para Claude — Criar `productization-plan.md`

Sim. Pode escrever agora o `docs/produtizacao-saas/productization-plan.md`.

Considere a auditoria encerrada e use como fontes de verdade:

- `productization-audit.md`
- `productization-decisions.md`
- `productization-progress.md`
- anexos A–E
- auditoria consolidada do `whatsapp-webhook-go`

Não altere código, migrations, schema ou infraestrutura nesta etapa. O objetivo agora é exclusivamente produzir o **plano executável de productização**.

---

# 1. Fase 5 — mantenha as duas variantes

Documente explicitamente:

```text
Fase 5 — WhatsApp
├── 5a — preparação independente
├── 5b — janela coordenada painel ↔ serviço Go
└── 5c — entrada/webhook multi-tenant
```

Para a 5c, mantenha:

```text
Variante A — 1 processo whatsapp-webhook-go por Organization
Variante B — processo compartilhado multi-tenant
```

**Não feche PD-023 por conta própria.**

Registre:

- PD-023 continua `OPEN`;
- recomendação atual = **Opção B, processo compartilhado**;
- Opção A só passa a ser necessária se uma restrição real da Meta/provisionamento tornar o modelo compartilhado inviável;
- essa verificação deve aparecer como **OPS-10 / gate da Fase 5**, não como blocker para escrever ou iniciar as demais fases.

Mostre claramente o impacto:

```text
A → esforço aproximado XS no código Go,
    mas cria custo recorrente de provisionamento/infra por Organization

B → esforço L na entrada/webhook,
    porém mantém uma única arquitetura de tenancy na plataforma
```

Não use horas.

---

# 2. Preserve a ordem obrigatória da Fase 5b

A janela coordenada deve deixar explícita esta ordem:

```text
1. painel passa identidade/remetente explicitamente;
2. serviço Go passa a aceitar e validar essa identidade;
3. serviço deixa de aceitar ausência/default implícito;
4. painel deixa de descobrir phone_number_id via /health;
5. ambos removem phone_number_id do contrato de /health.
```

Não permitir um estado intermediário em que:

- o painel espera identidade nova e o serviço ainda não entende;
- ou o serviço exige identidade e o painel ainda não envia.

Essa fase precisa ter plano de rollout e rollback coordenado.

---

# 3. Incorpore WG-01..WG-26

Não renumere para `F-xx`.

Preserve duas séries:

```text
F-01..F-12
→ repo principal

WG-01..WG-26
→ whatsapp-webhook-go
```

Cada item relevante do plano deve apontar para:

```text
finding
blocker
invariant
fase
critério de aceite
```

Os invariants continuam na série única da plataforma:

```text
INV-01..INV-38
```

porque são contratos verificáveis de CI, independentemente do repositório onde o defeito estava.

---

# 4. Atualize o conjunto de blockers no plano

O plano deve trabalhar com:

```text
B-01..B-26
```

incorporando:

- B-20 — remoção de agregações cross-Organization;
- B-21 — invariants obrigatórios em CI;
- B-22..B-26 — blockers vindos do whatsapp-webhook-go;
- B-08 ampliado para incluir o roteamento de webhook Meta no serviço Go.

Não rebaixe os blockers encontrados.

Para cada blocker, indique:

```text
prioridade
fase que resolve
findings relacionados
invariants relacionados
dependências
critério objetivo de encerramento
```

---

# 5. Fases precisam fechar por invariants, não por checklist subjetivo

Quero que cada fase tenha:

```text
Objetivo
Pré-requisitos
Mudanças de schema
Mudanças backend
Mudanças frontend
Jobs/workers
Integrações afetadas
Migração de dados
Testes
Rollout
Rollback
Blockers resolvidos
Findings resolvidos
Invariants que devem estar verdes
Critérios de saída
```

Uma fase **não está concluída** porque os arquivos foram alterados.

Está concluída quando os invariants daquela fase passam.

Exemplo:

```text
Fase N concluída somente se:
INV-x PASS
INV-y PASS
INV-z PASS
```

---

# 6. Segundo tenant deve ter um gate explícito

Crie uma seção destacada:

```text
SECOND TENANT GATE
```

O segundo tenant externo não pode ser criado enquanto houver qualquer condição crítica de isolamento aberta.

Inclua pelo menos:

```text
B-20 fechado
B-21 operacional no CI
F-01/F-02/F-05/F-11 corrigidos
WG blockers de saída/entrada aplicáveis fechados
conexões externas keyed por organization_id
defaults implícitos críticos removidos
tenant context derivado exclusivamente da sessão
rotas tenant-facing incapazes de agregar Organizations
invariants P0 verdes
```

Refine a lista com base na auditoria completa.

---

# 7. PD-022 é definitiva

Não planeje:

```text
multi-store
visão consolidada entre Organizations
modo "all"
fetchAcrossInkStores
DRE consolidada
platform admin usado para operar Use Sul/Centro/Norte
```

A visão consolidada atual será eliminada antes da migração.

O alvo interno preferencial é o cenário B de PD-019:

```text
Use Origens consolidada
↓
1 Organization
↓
1 Store
```

O plano pode citar que isso depende apenas do momento operacional da consolidação, não de uma nova decisão arquitetural.

---

# 8. F-02 deve ser tratado por remoção

Não desenhar guards sofisticados para preservar agregação cross-store.

Com PD-022:

```text
fetchAcrossInkStores
→ remover

loja='all'
→ remover

endpoint que omite loja e agrega todas
→ passar a usar Organization/Store da sessão
```

Especial atenção ao endpoint de customers, pois há PII.

---

# 9. Ownership padrão

Fixe no plano como regra central:

```text
Session
  ↓
Organization
  ↓
Store 1:1
```

`organization_id` é o eixo de isolamento.

`store_id` continua entidade de domínio, mas não é um segundo tenant selector na V1.

Frontend não escolhe tenant.

Endpoints não devem receber `organization_id` ou `store_id` para decidir ownership quando isso puder ser derivado da sessão.

IDs de recurso vindos da request continuam exigindo ownership check.

---

# 10. Conexões externas

Transformar o padrão atual:

```text
singleton por instalação
```

em:

```text
recurso pertencente à Organization
```

Principalmente:

```text
Meta Ads
Google Ads
GA4
WhatsApp
Creative Core
OpenAI BYOK
```

Onde hoje houver:

```text
CHECK (id = 1)
seleção global
env usada como identidade
LIMIT 1 de recurso "selecionado"
```

indicar explicitamente a migração para chave de Organization.

---

# 11. Fail-closed deve ser regra transversal

O plano deve codificar:

```text
ausência de escopo
ambiguidade de ownership
recurso não atribuído
identificador pertencente a outra Organization
```

como:

```text
erro/exclusão/sinalização
```

nunca como:

```text
remover filtro
inferir o único candidato
pegar o primeiro
usar configuração global
```

Isso deve aparecer associado especialmente a INV-09, INV-11, INV-24 e aos invariants novos do serviço Go.

---

# 12. Duplicação de regra de domínio

F-01 e G-01 demonstraram a mesma regra financeira implementada duas vezes com rigor diferente.

Onde o plano identificar duas implementações da mesma regra de ownership/atribuição:

```text
centralizar a regra
```

em vez de corrigir cada cópia independentemente.

Não quero uma refatoração estética ampla; apenas eliminação de duplicação que possa provocar divergência de isolamento.

---

# 13. Creative Core

Considere D-1 fechado:

```text
Node
→ http://creative-lab.railway.internal:8080
→ Railway Private Network
```

creative-lab:

```text
sem Public Domain
sem Custom Domain
sem TCP Proxy
```

`/v1/health` sem auth é apenas:

```text
H-01 — hardening opcional LOW
```

Não blocker.

OPS-01 deve continuar no runbook:

```text
creative-lab MUST NOT have public networking enabled
```

TD-008 continua aberto porque tenant context/correlation ID entre Node e creative-core é uma questão separada da exposição de rede.

---

# 14. INV vs OPS

Preserve a distinção:

```text
INV
→ verificável automaticamente por teste/lint/CI

OPS
→ configuração/infra validada em runbook/deploy
```

Não crie invariant que o CI não consiga provar.

Inclua no plano os gates OPS pertinentes à entrada em produção.

---

# 15. Estratégia de migrations

Não fazer big-bang destrutivo.

Quero sequência segura:

```text
adicionar estrutura nova
→ backfill
→ dual-read/write somente onde realmente necessário
→ validar invariants
→ trocar leitores
→ remover caminho antigo
→ DROP apenas em migration posterior
```

As tabelas `origens_migration_*` continuam:

```text
LEGACY / TO_REMOVE
```

sem `DROP` precoce.

---

# 16. Plano precisa separar esforço de productização de melhoria futura

Classifique cada item como:

```text
REQUIRED BEFORE SECOND TENANT
REQUIRED BEFORE PUBLIC LAUNCH
POST-LAUNCH HARDENING
FUTURE PRODUCT
```

Não deixe features futuras aumentarem o caminho crítico.

---

# 17. Decisões OPEN

Não pare o plano por causa das 23 decisões OPEN.

Para cada uma:

- se bloquear uma implementação específica, marque o gate correspondente;
- se puder ser decidida depois, mantenha fora do critical path;
- nunca invente a decisão.

PD-023 deve ser adicionada formalmente a `productization-decisions.md` como OPEN, com as duas opções e recomendação B.

---

# 18. Railway / serviço Go

Existem alguns valores de deploy que ainda podem alterar o **esforço local da Fase 5**, mas não a arquitetura geral.

Registre-os como OPS/verification gate:

```text
META_APP_SECRET
API_KEY
DATABASE_URL
modelo do access token Meta
topologia/provisionamento do whatsapp-webhook-go
```

Não bloqueie a escrita do plano por isso.

Se algum deles for necessário antes da execução da Fase 5, deixe exatamente indicado em seu pré-requisito.

---

# 19. Entrega

Ao terminar:

1. criar `docs/produtizacao-saas/productization-plan.md`;
2. atualizar `productization-decisions.md` apenas com PD-023 e referências necessárias;
3. atualizar `productization-progress.md` indicando auditoria fechada e plano criado;
4. não alterar código;
5. não criar migrations;
6. não fazer commit.

Pare novamente no checkpoint.

No resumo final, me entregue:

```text
número de fases
ordem das fases
quais podem rodar em paralelo
critical path
blockers por fase
invariants por fase
ponto exato do SECOND TENANT GATE
variantes A/B da Fase 5
decisões OPEN que realmente bloqueiam alguma fase
maior risco de execução do plano
```

Antes de escrever, releia os documentos consolidados para não usar contagens antigas como 53 tabelas, 278 rotas, 26 invariants ou 21 blockers onde os números já mudaram.

Pode prosseguir até o checkpoint de documentação.
