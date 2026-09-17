# Rodada 7 — Fechamento da Fase 0 antes da implementação

Plano aprovado.

Antes de começar a alterar código, faça uma **Rodada 7 curta de fechamento da Fase 0**, somente documentação e decisão técnica.

Não implemente ainda.

Quero sair desta rodada com **TD-003, TD-004 e TD-010 fechadas**, porque são conteúdo/pré-requisito direto da Fase 0.

---

# 1. Fechar TD-003

Pode registrar como decisão:

```text
TD-003 — CLOSED (V1)

Produção SaaS exige Postgres.

Em production:
- DATABASE_URL ausente → boot falha;
- conexão/migration/bootstrap crítico falhou → boot falha;
- nenhum fallback JSON/memory silencioso para estado de negócio.

Fallback JSON/memory:
- permitido somente em dev/test explicitamente;
- nunca inferido apenas porque DATABASE_URL está ausente.
```

O estado atual sobe mesmo sem Postgres e degrada parcialmente para JSON/503, portanto essa mudança é intencionalmente fail-fast.

---

# 2. Fechar TD-004

Pode registrar como direção V1:

```text
TD-004 — CLOSED (V1)

A chave de criptografia de integrations/secrets é independente
do segredo de sessão.

Requisitos:
- ENCRYPTION_MASTER_KEY própria;
- key_version persistida junto do ciphertext;
- AES-256-GCM pode permanecer;
- rotação incremental, sem downtime;
- leitura aceita chave atual + versões ainda ativas;
- escrita sempre usa versão corrente;
- segredo nunca volta ao frontend;
- logs/API mostram somente metadata, last4/status/validade;
- ADMIN_SESSION_SECRET deixa de participar da derivação de
  segredos persistidos.
```

Antes de fechar a parte de schema, escolha entre:

```text
A. integration_secrets dedicada
B. colunas cifradas em integrations
```

Use a alternativa que melhor combine com o modelo de `integrations` já previsto no plano.

Não crie uma arquitetura paralela só para segurança.

Registre também estratégia de migração dos ciphertexts existentes:

```text
legacy key derivada de ADMIN_SESSION_SECRET
→ leitura temporária compatível
→ reencrypt com ENCRYPTION_MASTER_KEY na nova key_version
→ validação
→ remoção do fallback legacy em migration/release posterior
```

---

# 3. Fechar TD-010

Aqui não quero escolher ferramenta no escuro.

Primeiro inspecione:

```text
package.json
dependências atuais de Postgres
scripts existentes
mecanismo atual de bootstrap
ambiente de deploy
testes
```

E escolha **uma ferramenta/mecanismo de migrations versionadas compatível com a stack atual**.

Critérios obrigatórios:

```text
migrations ordenadas e versionadas
tabela de histórico no banco
execução repetida idempotente no sentido da ferramenta
falha interrompe deploy/boot da etapa de migration
up migration obrigatória
rollback/down somente quando seguro
SQL explícito permitido
suporta backfill em etapas
suporta CREATE INDEX CONCURRENTLY quando necessário
não depende de ORM novo só para migrations
executável localmente e no CI
```

A ferramenta precisa entrar **antes da tenancy**, porque o bootstrap atual com `CREATE TABLE IF NOT EXISTS` não consegue fazer a transformação/backfill que `organization_id` exige.

Traga no checkpoint:

```text
ferramenta escolhida
por que ela encaixa melhor neste repo
dependência adicionada
comandos previstos
onde ficam os arquivos
como CI/deploy roda migrations
como evita duas instâncias migrando simultaneamente
```

Não instale ainda.

---

# 4. Não feche TD-001 ainda nesta rodada

Apenas confirme que ela será a próxima decisão antes da primeira migration de tenancy.

A recomendação atual continua sendo:

```text
schema compartilhado
+ organization_id obrigatório
+ RLS como defesa em profundidade
+ testes automáticos de isolamento
```

Não altere essa decisão sem nova evidência.

---

# 5. OPS-06 / OPS-07 / OPS-08

Prepare para mim a checklist exata do que preciso consultar no Railway do `whatsapp-webhook-go`.

Quero somente nomes de serviço/variável e como interpretar, sem pedir valores secretos completos.

Para secrets, basta eu responder:

```text
definido / não definido
```

ou, quando necessário:

```text
persistente / efêmero
```

Nunca peça para eu colar token, App Secret ou API Key no chat.

As três verificações devem cobrir no mínimo:

```text
META_APP_SECRET
→ definido?
→ HMAC de webhook fica fail-closed em produção?

API_KEY
→ definido?
→ endpoints internos ficam autenticados?

DATABASE_URL
→ definido?
→ serviço Go usa persistência real ou memory store?
```

Se houver uma quarta informação indispensável para OPS-10/PD-023, liste separadamente, mas não transforme em nova rodada de discovery.

---

# 6. Harness de invariants

Antes de implementar a Fase 0, refine o critério já colocado no plano:

```text
o harness só é considerado válido depois que:

1. um invariant é executado e passa no estado correto;
2. introduzimos deliberadamente uma violação controlada;
3. o mesmo invariant falha;
4. removemos a violação;
5. ele volta a passar.
```

Isso deve ser obrigatório para pelo menos um invariant de cada classe crítica:

```text
tenancy/ownership
auth
entitlement
secrets
webhook
```

Inclua explicitamente o caso do INV-09 com **uma única Organization seedada**, para provar que nenhum helper volta a inferir ownership apenas porque existe um único candidato.

---

# 7. Saída desta rodada

Atualize somente:

```text
productization-decisions.md
productization-plan.md, se precisar refletir as decisões
productization-progress.md
```

Não altere código.

Não instale dependência.

Não crie migration.

Não faça commit.

Pare no checkpoint e me retorne:

```text
TD-003 final
TD-004 final
TD-010 final + ferramenta escolhida
impacto dessas decisões na Fase 0
checklist exata OPS-06/07/08 para eu consultar no Railway
qualquer ajuste necessário no critical path
```

Se nenhuma dessas decisões mudar a sequência das fases, diga isso explicitamente.
