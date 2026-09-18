# Productização do Connector Ink — eliminar dependência de `loja_legada` para clientes novos

## Contexto

Durante o primeiro dogfood real do Oria com:

```text
Organization = Use Origens
Store = Use Sul
```

foi identificado que o Connector Ink ainda depende de uma chave herdada do sistema antigo:

```text
stores.loja_legada
```

Hoje essa coluna usa valores como:

```text
sul
centro
norte
```

e é consumida por fluxos como:

```text
pedidos_ink
webhook_eventos
audit_log
roteamento de webhook
jobs
fallbacks de env
```

A Store criada nativamente pelo Oria tem:

```text
loja_legada = NULL
```

e isso está correto.

O objetivo do dogfood é testar o Oria como **um cliente novo de verdade**, sem qualquer dependência de estrutura histórica.

Portanto:

```text
NÃO preencher loja_legada='sul'
```

e não usar a chave legada como atalho para fazer a Ink funcionar.

---

# 1. Objetivo

Fazer o Connector Ink funcionar integralmente para uma Store nativa do Oria:

```text
Organization
→ Store canônica
→ Connector Ink
```

usando:

```text
organization_id
+
store_id
```

como identidade interna.

`loja_legada` passa a existir somente como:

```text
metadata de compatibilidade/migração histórica
```

e nunca como requisito para cliente novo.

---

# 2. Estado que deve permanecer

Manter exatamente:

```text
Organization = Use Origens
Store = Use Sul
stores.loja_legada = NULL
```

Não:

```text
renomear Store
preencher loja_legada
recriar Organization
recriar Store
criar segunda Store
```

---

# 3. Auditar dependências legadas

Localizar todos os usos de:

```text
lojaDoContexto()
lojaDoContextoOuNulo()
loja_legada
pedidos_ink.loja
webhook_eventos.loja
audit_log.loja
LOJAS
INK_TOKEN_<LOJA>
```

e qualquer outro código equivalente.

Para cada ocorrência, classificar:

```text
A. compatibilidade histórica / migração
B. runtime novo do Oria
```

Toda dependência classificada como `B` deve deixar de exigir `loja_legada`.

---

# 4. Regra arquitetural definitiva

Novo runtime:

```text
organization_id
+
store_id
```

são autoridade.

Legacy:

```text
loja
loja_legada
sul/centro/norte
```

não são autoridade de tenancy.

Nunca derivar Organization ou Store a partir da chave legada no fluxo novo.

---

# 5. Credencial Ink — save

O endpoint:

```text
PUT /api/admin/integrations/ink/credenciais
```

deve funcionar com:

```text
organization_id válido
store_id válido
loja_legada = NULL
```

Fluxo esperado:

```text
tenant session
→ Organization
→ Store 1:1
→ integration
→ integration_secrets
→ audit
→ resposta sucesso
```

Não chamar:

```text
lojaDoContexto()
```

para tornar o save possível.

---

# 6. Atomicidade do save

Foi identificado um problema importante:

```text
hoje o segredo pode ser salvo
e depois a auditoria falhar por STORE_WITHOUT_INK
```

Isso é inaceitável.

O save deve ser transacional:

```text
integration
+ secrets
+ status
+ audit
```

Se qualquer etapa falhar:

```text
ROLLBACK
```

Não pode existir:

```text
UI diz que falhou
mas secret ficou persistido
```

Adicionar teste específico.

---

# 7. Auditoria

Novos eventos devem usar:

```text
organization_id
store_id
actor
action
request_id
```

como contexto.

Se existir:

```text
audit_log.loja
```

ela deve:

```text
ser nullable
ou
ser preenchida somente em eventos históricos/compatibilidade
```

Não obrigar cliente novo a possuir `loja_legada`.

---

# 8. Teste de conexão Ink

O endpoint:

```text
POST /api/admin/integrations/ink/teste
```

não deve depender de `loja_legada`.

A própria investigação já comprovou que o request Ink é:

```text
GET /v1/stores/orders?per_page=1
```

e a identidade externa é determinada pela credencial/token.

Portanto:

```text
Organization atual
→ Store atual
→ Integration Ink da Organization
→ apiToken
→ Ink API
```

é suficiente.

Não enviar:

```text
sul
centro
norte
```

ao provider.

---

# 9. Identidade externa da Ink

Documentar explicitamente:

```text
a identidade da loja externa Ink
é determinada pela credencial/token
```

Não por:

```text
stores.loja_legada
```

Se no futuro a Ink passar a devolver:

```text
store id
account id
tenant id
```

persistir como:

```text
external_resource_id
```

da integração.

Não reutilizar `loja_legada` para isso.

---

# 10. Webhook Ink

O webhook novo já usa rota opaca:

```text
/api/webhooks/ink/:token
```

O fluxo deve ser:

```text
opaque integration token
→ Organization
→ Store 1:1
→ validação do webhook secret
→ persistência
→ efeitos
```

Não:

```text
webhook
→ sul|centro|norte
→ tenant
```

---

# 11. Persistência de webhook

Novo evento deve persistir:

```text
organization_id NOT NULL
store_id NOT NULL
```

quando pertencer a uma Store.

Se hoje houver:

```text
webhook_eventos.loja
```

ela pode continuar para dados legados, mas:

```text
nullable
não-authoritative
não exigida para INSERT novo
```

---

# 12. Pedidos Ink

Auditar schema de:

```text
pedidos_ink
```

Alvo para registros novos:

```text
organization_id NOT NULL
store_id NOT NULL
```

A coluna textual:

```text
loja
```

se ainda necessária para histórico:

```text
nullable
não-authoritative
não exigida para novo pedido
```

Não preencher artificialmente com:

```text
sul
```

---

# 13. Foreign keys e índices

Se faltarem:

```text
store_id
organization_id
```

nas tabelas do Connector Ink:

criar nova migration forward-only.

Preferir:

```text
FK organization_id → organizations(id)
FK store_id → stores(id)
```

e, quando aplicável:

```text
FK composta/constraint
```

garantindo que a Store pertence à Organization.

Não editar migrations já aplicadas.

---

# 14. Compatibilidade de dados existentes

Não quebrar dados históricos.

Estratégia preferida:

```text
NEW PATH
organization_id + store_id

LEGACY READ/MIGRATION PATH
loja / loja_legada
```

Para dados antigos que ainda não possuem `store_id`:

```text
resolver somente no caminho explícito de migração/compatibilidade
```

Nunca fazer o runtime novo depender desse fallback.

---

# 15. Jobs Ink

Auditar jobs relacionados a:

```text
reconcile-ink
PIX
carrinho
produção
despacho
trânsito
entrega
problem orders
retry
```

Todo job novo deve carregar/persistir:

```text
organization_id
store_id
```

Não recuperar contexto principal via:

```text
loja_legada
```

---

# 16. Leasing / queues

Preservar toda a lógica existente de:

```text
leases
SKIP LOCKED
idempotência
retry
```

Apenas garantir que a chave tenant/store do job seja:

```text
organization_id
store_id
```

e não texto legado.

---

# 17. Fallback legado de env

Hoje o fallback legado exige algo como:

```text
ALLOW_LEGACY_INTEGRATION_ENV=1
INK_TOKEN_<LOJA>
loja_legada presente
```

Preservar somente como compatibilidade temporária.

Para Store nativa:

```text
loja_legada = NULL
```

o fallback deve ser:

```text
inelegível
```

mas isso NÃO pode causar falha no runtime novo.

O caminho normal deve usar:

```text
integration_secrets
```

---

# 18. Credenciais

Continuar com:

```text
integration_secrets
AES-256-GCM
HKDF
ENCRYPTION_MASTER_KEY
key_version
```

Não alterar criptografia.

Não retornar secret ao browser.

Não logar secret.

---

# 19. Organization-scoped vs Store-scoped

Revalidar a classificação.

## Organization-scoped

Provavelmente:

```text
integrations
integration_secrets
subscription
entitlements
```

## Store-scoped

Provavelmente:

```text
pedidos
eventos operacionais
catálogo/provider mapping
estoque
produção
shipping/tracking
```

Se o token Ink puder futuramente variar por Store, registrar essa dívida.

Não mudar para multi-store nesta rodada.

---

# 20. V1 continua 1:1

Manter:

```text
1 Organization = 1 Store
```

Pode resolver server-side:

```text
Organization
→ Store única
```

Mas persistir:

```text
store_id
```

explicitamente nas entidades Store-scoped.

Não introduzir Store selector.

Não remover constraint 1:1.

---

# 21. `lojaDoContexto()`

Auditar o helper.

Se ele existe para recuperar:

```text
sul|centro|norte
```

renomear/documentar como helper legado, se ainda necessário.

Exemplo:

```text
lojaLegadaDoContexto()
```

ou equivalente.

Não deixar nome genérico sugerindo que é a Store canônica.

Novo runtime deve usar algo equivalente a:

```text
storeDoContexto()
storeIdDoContexto()
```

---

# 22. LOJAS map

O map:

```text
const LOJAS = {
  sul: 'Use Sul',
  centro: 'Use Centro',
  norte: 'Use Norte'
}
```

deve ser classificado como legado.

Não usar para:

```text
tenant routing
Ink routing
store identity
authorization
```

no runtime novo.

Pode permanecer em:

```text
migração
compatibilidade histórica
display legado
```

se ainda necessário.

---

# 23. Criar URL de webhook

Qualquer ação de:

```text
gerar webhook URL
mostrar webhook URL
auditar webhook setup
```

deve funcionar com:

```text
loja_legada = NULL
```

A URL deve depender da integração canônica, não da chave textual antiga.

---

# 24. UI de Integrações

Com Store nova:

```text
loja_legada = NULL
```

deve ser possível:

```text
abrir tela
salvar Ink credential
testar
visualizar status
gerar/configurar webhook
```

sem mensagens do tipo:

```text
STORE_WITHOUT_INK
loja não mapeada
```

---

# 25. Estado não configurado

Antes de conectar:

```text
Ink
→ not_configured
```

Depois de salvar sem testar:

```text
Ink
→ configured
```

ou equivalente.

Depois do teste bem-sucedido:

```text
Ink
→ connected / healthy
```

Não usar `connected` apenas porque secret foi salvo, se o modelo já diferencia configuração de validação.

Se mudar isso for grande demais nesta rodada, documentar sem ampliar escopo.

---

# 26. Teste principal — cliente novo real

Criar fixture/cenário:

```text
Organization nova
Store nova
loja_legada = NULL
nenhuma integração
nenhum dado legado
```

Provar:

```text
GET integrations = 200

PUT Ink credentials = 200
secret persistido de forma atômica

POST Ink test
→ alcança mock/provider

gerar webhook URL = sucesso

audit = sucesso

persistir webhook event = sucesso

persistir Ink order = sucesso
```

Tudo sem preencher `loja_legada`.

---

# 27. Teste save rollback

Obrigatório:

forçar falha na auditoria após tentativa de salvar secret.

Esperado:

```text
response = erro
integration_secrets = 0 novas linhas
integration status não mudou
```

Provar atomicidade.

---

# 28. Testes tenant isolation

Criar:

```text
Organization A / Store A
Organization B / Store B
```

com credenciais diferentes.

Provar:

```text
A nunca lê token de B
B nunca recebe pedido de A
webhook A nunca grava em B
job A nunca processa B
```

Sem usar `loja_legada`.

---

# 29. Negative controls

Executar controles que façam a suíte reprovar se reintroduzir:

```text
save Ink exige loja_legada

test Ink exige loja_legada

webhook novo roteia por "sul"

pedido novo exige coluna loja textual

audit novo exige loja textual

job novo recupera tenant via loja_legada

tenant A usa token de B

secret persiste mesmo quando save retorna erro
```

---

# 30. Migration strategy

Antes de escrever migration:

```text
inspecionar schema real
```

Algumas tabelas já podem possuir:

```text
organization_id
```

Adicionar apenas o que falta.

Qualquer migration deve ser:

```text
forward-only
idempotente quando aplicável
compatível com dados atuais
```

Não apagar colunas legadas nesta rodada.

---

# 31. Backfill histórico

Se houver dados históricos no novo banco:

```text
não inferir Store pela única Organization
```

Usar somente mapping explícito existente.

No banco atual do dogfood, foi verificado:

```text
zero pedidos
zero webhook_eventos
zero integrations
zero integration_secrets
```

Portanto o Tenant #1 não precisa de backfill legado.

---

# 32. Audit manifest / tenancy manifest

Atualizar os manifests canônicos para refletir qualquer nova coluna/tabela tenant-owned.

Garantir:

```text
RLS ENABLE
RLS FORCE
```

onde aplicável.

Não introduzir tabela tenant-owned sem tenancy manifest.

---

# 33. `oria_app`

Todas as novas operações precisam funcionar sob:

```text
oria_app
NOSUPERUSER
NOBYPASSRLS
nonowner
```

Não usar migration role/runtime owner para contornar RLS.

---

# 34. TRUNCATE

Não introduzir:

```text
TRUNCATE
```

em testes/runtime de tabelas tenant-owned.

Preservar as proteções já existentes.

---

# 35. Não alterar produção legada

NÃO:

```text
acessar banco legado para mutação
alterar antigo Railway
alterar antigo webhook
alterar token legado
```

A productização ocorre somente no projeto Oria.

---

# 36. Não conectar credencial real nesta rodada

Esta rodada prepara o runtime.

Não:

```text
salvar token real
testar token real
trocar webhook real
importar pedidos
importar catálogo
```

Depois do checkpoint, o usuário fará o fluxo pela UI.

---

# 37. Não implementar multi-store

Não alterar:

```text
1 Organization = 1 Store
```

nesta rodada.

O objetivo é somente:

```text
cliente novo 1:1
sem loja_legada
```

---

# 38. Docs

Criar/atualizar:

```text
docs/architecture/ink-connector-tenancy.md
docs/operations/connector-ink.md
docs/productization/legacy-store-key-deprecation.md
```

Documentar:

```text
loja_legada
= migration compatibility only
```

e o fluxo canônico novo.

---

# 39. Depreciação futura

Registrar plano posterior:

```text
Phase 1
runtime novo deixa de depender

Phase 2
dados históricos recebem store_id

Phase 3
leitura legado isolada

Phase 4
coluna loja/loja_legada pode ser removida
```

Não executar Phase 4 agora.

---

# 40. Sequência de execução

Executar:

```text
1. mapear usos de loja_legada
2. classificar legacy vs runtime
3. inspecionar schema
4. criar migrations necessárias
5. productizar save/test
6. productizar audit
7. productizar webhook
8. productizar pedidos
9. productizar jobs
10. preservar legacy compatibility
11. testes tenant novo
12. isolation tests
13. negative controls
14. suíte sob oria_app
15. docs
16. deploy
17. smoke sem credencial real
```

---

# 41. Smoke após deploy

Com a Organization real existente:

```text
Organization = Use Origens
Store = Use Sul
loja_legada = NULL
```

validar sem salvar secret:

```text
/admin/integracoes abre
Ink mostra not_configured
formulário disponível
nenhum erro STORE_WITHOUT_INK
geração da superfície de webhook não exige legacy key
```

Não conectar.

---

# 42. Checkpoint final

Retornar:

```text
1. usos encontrados de loja_legada
2. classificação de cada uso
3. usos removidos do runtime novo
4. helpers novos/alterados
5. schema antes/depois
6. migrations
7. save flow Ink
8. atomicidade do save
9. test flow Ink
10. webhook flow
11. pedido Ink flow
12. audit flow
13. jobs
14. fallback legado
15. compatibilidade histórica
16. tenant isolation
17. RLS / oria_app
18. teste Store com loja_legada=NULL
19. save rollback test
20. negative controls
21. docs
22. commits
23. CI
24. deploy
25. smoke
26. blockers
27. GO / NO-GO para o usuário inserir a credencial Ink real pela UI
```

---

# Estado esperado

```text
Use Origens
└── Use Sul
    ├── store_id = UUID canônico
    └── loja_legada = NULL
              ↓
         Connector Ink
              ↓
      organization_id
      + store_id
```

Cliente novo nunca precisa saber que:

```text
sul
centro
norte
```

existiram.

`loja_legada` fica exclusivamente como compatibilidade de migração até sua remoção futura.
