# Fechar a rodada de Capabilities durante a madrugada

Pode concluir esta rodada sozinho a partir do estado atual.

Objetivo: fechar com segurança a branch de capabilities e deixar o `main` estável. **Não iniciar novas features nem a rodada de Catálogo Ink depois disso.**

## 1. Termine a suíte que já está rodando

Aguardar a variante sob:

```text
oria_app
```

A suíte normal já fechou:

```text
989/989
0 falhas
0 skipped
```

Não iniciar outra suíte em paralelo no mesmo banco/container.

## 2. Se `oria_app` fechar verde

Antes do commit, confirmar:

```text
capabilities-classificacao = verde
Control Plane = verde
negative controls = verde
panel build = verde
check-contracts = verde
repo:self-check = verde
panel full suite = 989/989
oria_app = verde
```

Também confirmar que a composição final implementada está de acordo com a decisão:

```text
FEATURES COMERCIAIS
- whatsapp
- instagram
- advancedAutomations
- financial
- creative_generator
- meta_ads
- google_ads
- analytics_ga4
```

Plano `internal`:

```text
IN
- whatsapp
- financial
- creative_generator
- meta_ads
- google_ads
- analytics_ga4

OUT
- instagram
- advancedAutomations
```

Connector capabilities:

```text
catalog
exchanges
refunds
```

Creative module capabilities:

```text
clean_angles
remarketing
funnel_visual
multi_product
```

## 3. Compatibilidade obrigatória

Não remover fisicamente de `plan_features` nenhuma key que ainda seja consumida por `requireEntitlement()` no runtime.

Especialmente:

```text
catalog
exchanges
refunds
```

podem ficar temporariamente como:

```text
deprecated compatibility entitlements
```

até suas respectivas rodadas migrarem o runtime.

A classificação nova pode entrar agora. A remoção destrutiva só entra quando os consumidores tiverem sido convertidos.

## 4. Migration

Confirmar que a migration desta branch está com identificador único e não colide com migrations já aplicadas.

NUNCA alterar:

```text
1790000600000_store-id-connector-ink
1790000800000_entitlement-canonico
```

ou qualquer migration já aplicada em produção.

Se a migration da branch ainda estiver como:

```text
1790000700000_features-reclassification
```

confirmar que esse identificador está realmente livre no histórico atual.

Se houver colisão, renumerar apenas a migration ainda não aplicada.

## 5. Se tudo estiver coerente, commit

Fazer commit isolado da rodada.

Antes:

```text
git status
git diff
git diff --cached
```

Stage seletivo.

Não usar:

```text
git add .
git reset --hard
git clean
checkout .
restore .
```

Não tocar em worktrees de outras frentes. Não tocar no `rec`.

## 6. Push e CI

Depois do commit:

```text
push da branch
```

Rodar/acompanhar o CI completo.

Esperado:

```text
painel
control plane
contratos
gerador
whatsapp
```

todos verdes.

## 7. Se CI falhar

### Falha relacionada à branch

Corrigir apenas a causa real.

Depois:

```text
teste direcionado
→ suíte necessária
→ commit de correção
→ push
→ CI novamente
```

### Flaky preexistente

Se algo como:

```text
oauth/org-do-navegador
```

falhar:

1. verificar se passa isoladamente;
2. verificar se a branch tocou o código relacionado;
3. repetir de forma controlada uma vez.

Se for comprovadamente flaky/preexistente:

```text
registrar como dívida
```

Não fazer alteração oportunista fora do escopo só para "deixar verde".

## 8. Merge condicional

Se:

```text
todas as suítes locais verdes
+
CI completo verde
+
migration sem colisão
+
internal exatamente conforme definido
+
nenhum acesso do Tenant #1 removido indevidamente
```

então está autorizado a fazer o merge da branch de capabilities no:

```text
main
```

usando estratégia segura e preservando o histórico atual.

Não force push.

## 9. Depois do merge

Rodar apenas as verificações necessárias para confirmar o merge.

Se o workflow de `main` iniciar automaticamente:

```text
acompanhar o CI
```

Se verde, considerar a rodada fechada.

Se houver deploy automático já configurado para `main`, apenas verificar o resultado normal do pipeline.

Não alterar Railway manualmente nesta rodada, salvo se o fluxo já estabelecido exigir uma ação conhecida e não destrutiva.

## 10. Smoke após merge/deploy, se houver

Validar somente o necessário:

```text
Control Plane abre
Plano internal aparece
effective entitlements da Use Origens continuam válidos
WhatsApp continua true
financial continua true
creative_generator continua true
meta_ads = true
google_ads = true
analytics_ga4 = true
```

Também provar que:

```text
catalog
```

não voltou a `false` enquanto Produtos/Categorias/Agrupamentos ainda dependem temporariamente dele no runtime.

## 11. Pode usar Claude in Chrome para validação visual

Está autorizado a usar **Claude in Chrome** para smoke/browser validation quando isso ajudar a confirmar o comportamento real da interface.

Pode usar para:

```text
abrir o Oria Admin
abrir o Tenant Panel
navegar até planos
navegar até integrações
validar badges/estados
confirmar que menus aparecem ou somem
confirmar que não há 403 visível onde não deveria
confirmar que o plano internal renderiza as features esperadas
confirmar que a Use Origens mantém os entitlements corretos
```

Pode também usar o navegador para reproduzir um fluxo real de leitura e navegação.

Mas:

```text
Claude in Chrome NÃO substitui testes automatizados
Claude in Chrome NÃO substitui CI
Claude in Chrome NÃO deve fazer alterações destrutivas
Claude in Chrome NÃO deve salvar credenciais novas
Claude in Chrome NÃO deve conectar integrações automaticamente
Claude in Chrome NÃO deve alterar billing/plano/Organization sem necessidade explícita
```

Se o navegador encontrar algo diferente do esperado:

```text
registrar evidência
identificar a causa
corrigir apenas se fizer parte do escopo desta rodada
```

Se for fora do escopo:

```text
registrar como blocker/dívida
não abrir nova frente
```

## 12. Validação visual recomendada

Se usar Claude in Chrome, validar pelo menos:

```text
/admin do Control Plane
→ plano Internal
→ features visíveis

Tenant Panel
→ menu lateral
→ integrações
→ estado de WhatsApp/OpenAI
```

O smoke visual deve ser complementar ao smoke por API/logs.

## 13. NÃO iniciar a próxima rodada

Depois disso, PARE.

Não iniciar:

```text
Catálogo Ink
Produtos
Categorias
Agrupamentos
Estoque
Feed
Artwork Vault
Integrações adicionais
```

Essas serão tratadas depois.

## 14. Cleanup

Pode derrubar apenas containers/processos criados por esta própria rodada e que estejam claramente órfãos.

Não remover:

```text
worktrees ativos
branches de outros agentes
containers/processos cuja propriedade não esteja clara
rec
```

Não remover diretórios paralelos ainda — existe uma auditoria separada para isso.

## 15. Relatório final

Ao terminar, deixe um checkpoint completo com:

```text
CAPABILITIES
- suíte normal
- suíte oria_app
- classification tests
- control plane
- negative controls
- build
- contracts
- migration final
- internal final
- compatibility keys preservadas
- commit(s)
- CI
- merge
- main HEAD
- deploy, se ocorreu
- smoke por API/log
- smoke visual via Claude in Chrome, se usado
- flakies encontrados
- blockers
- GO/NO-GO final
```

Se qualquer gate crítico não puder ser provado:

```text
NÃO mergear
```

e deixar o relatório com o motivo exato.
