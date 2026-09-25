# Hotfix pré-merge — RBAC de integrações de mídia (D-1) e entitlement do catálogo de análises (D-2)

Branch `feature/redesign-integracoes-navegacao`, sobre `57b91dd`. Sem push, merge, deploy ou migration. Só banco descartável e providers simulados.

## Política efetiva por endpoint (D-1)

Regra: **criar, trocar ou revogar credencial/vínculo de Meta Ads, Google Ads e GA4 exige `owner` da Organization ativa** — a mesma política da credencial da Ink e do número do WhatsApp
(`TENANT.requireOwner` → `403 {codigo: 'OWNER_REQUIRED'}`, antes de qualquer mutação ou chamada externa). O contrato do projeto já usava `owner`-only para credenciais (Ink `PUT/DELETE credenciais`,
`POST webhook-url`, WhatsApp `PUT/DELETE remetente`, Embedded Signup); **não há regra explícita que autorize `member` a desconectar mídia** (busca em `server.js`, `lib/` e `docs/`: nenhum teste ou comentário afirma isso; a matriz de roles
segue **aberta** em `docs/productization/productization-decisions.md` PD-004, com só `owner`/`member` na V1), então aplicou-se `owner`-only por consistência. Se o produto decidir o contrário, é remover `exigirOwner` das rotas abaixo.

| Rota | Efeito | Antes | Agora |
|---|---|---|---|
| `GET  /integrations/google-analytics/connect` | inicia OAuth (o callback grava/substitui tokens) | admin | **owner** |
| `POST /integrations/google-analytics/property` | troca a propriedade vinculada | admin | **owner** |
| `POST /integrations/google-analytics/disconnect` | revoga no Google + apaga segredos | admin | **owner** |
| `GET  /integrations/meta/connect` | inicia OAuth | admin | **owner** |
| `POST /integrations/meta/select-account` | troca a conta vinculada (libera a posse da anterior) | admin | **owner** |
| `POST /integrations/meta/disconnect` | apaga conexão, segredos e dados | admin | **owner** |
| `GET  /integrations/google-ads/oauth/start` | inicia OAuth | admin | **owner** |
| `POST /integrations/google-ads/contas/:id/selecionar` | troca a conta vinculada | admin | **owner** |
| `POST /integrations/google-ads/contas/:id/loja` | reatribui a Store da conta | admin | **owner** |
| `POST /integrations/google-ads/disconnect` | revoga no Google + apaga segredos | admin | **owner** |
| `GET  …/status`, `…/properties`, `meta/ad-accounts`, `meta/sync`, `google-ads/sync`, `google-ads/contas/sincronizar` e todas as leituras `analytics/*` | leitura / sincronização | admin | **inalterado** (member continua usando) |
| `GET …/callback` (GA4/Google Ads/Meta) | conclui o OAuth | `state` de uso único | **inalterado**: o `state` só nasce nas rotas `connect`/`start`, agora owner-only; sem sessão não há papel a conferir |

Não há rota legada paralela: `desconectarMeta`/`desconectarGA4` só são chamadas pelas rotas acima. Autenticação, papel e Organization são resolvidos pela sessão (`requireAdmin` → contexto do tenant);
seletores forjados (`?organization_id=`, `X-Organization-Id`) são recusados (>= 400) e nunca deslocam a Organization.

**UI** (`Meta Ads`, `Google Ads`, `GA4`): para `member`, somem Conectar/Reconectar, Escolher/Trocar conta ou propriedade, Vincular à loja e Desconectar; ficam Sincronizar agora e Buscar contas, com a nota
"Só o responsável pela loja conecta, troca ou desconecta esta integração." O hook único `useEhOwner` (em `IntegracaoAcordeao.tsx`) agora também serve a Ink. A confirmação continua com o verbo **"Desconectar"**.

## D-2 — "Catálogo para análises de desempenho"

O card `CatalogSyncCard` usa só `/api/admin/product-analytics/catalog-sync*`, protegido no servidor por `analytics_product_performance` (`feature-routes.js`) — o `403` **continua** (esconder é UX, não segurança).
Na aba Catálogo da Reserva Ink ele agora só aparece com `useEntitlement('analytics_product_performance')` (novo hook em `state/entitlements.ts`, **a mesma fonte** de `/api/admin/entitlements` que esconde
"Desempenho de produtos" e "Jornada de compra" no menu; sem regra duplicada). O hook é fail-closed: carregando, falha de leitura ou troca de Organization = não mostra; a resposta é atrelada à Organization ativa e
respostas atrasadas são descartadas. O catálogo genérico da Ink ("Catálogo para busca de produtos", `/api/admin/produtos/catalogo/*`) **não depende dessa feature** e permanece intacto.

## Matriz (testes de servidor, `integracoes-rbac-entitlement-server.test.js`)

| Ator | Org X (sem `analytics_product_performance`) | Org Y (com a feature) |
|---|---|---|
| owner X — desconecta GA4/Meta/Google Ads da própria X | **200**, segredos removidos, Google recebe a revogação | — |
| member X — 10 rotas de credencial/vínculo | **403 OWNER_REQUIRED**; banco idêntico; 0 revogações e 0 chamadas externas | — |
| member X — status, sincronizar, listar contas | permitido (≠ 403/401) | — |
| owner Y / member Y sobre a Org X (com `organization_id` e `X-Organization-Id` forjados) | X **intacta** (>= 400 em todas) | — |
| owner X — catálogo de análises (`status`, `catalog-sync`, `cancelar`) | **403 `feature_nao_disponivel`**; nenhum registro em `commerce_catalog_sync_logs`; nenhuma chamada à Ink | — |
| owner X — catálogo genérico (`/produtos/catalogo/status`) | 200 | — |
| owner Y — catálogo de análises | — | **200** |
| `/api/admin/entitlements` por Organization, sessões alternadas | `false` | `true` |

Front (`integracoes-rbac-entitlement-front.test.js`, contrato de fonte): cada ação de credencial dos três cards está atrás de `ehOwner`; "Desconectar" é o rótulo de confirmação; o card de análises
depende de `useEntitlement('analytics_product_performance')`; o hook é chaveado pela Organization ativa, fail-closed e descarta resposta atrasada. Não há infraestrutura de render de componente no repositório;
o comportamento visual foi comprovado antes, no Playwright da rodada anterior (`qa-integracoes-homologacao.mjs`) — **não foi reexecutado neste hotfix** (ver Limitações).

**Controle negativo:** com `server.js` sem o guard, o teste "member recebe 403" **reprova** (os demais seguem verdes); com o guard, 6/6.

## Comandos e resultados

| Comando | Resultado |
|---|---|
| `node scripts/test-db.mjs run -- node --test test/invariants/integracoes-rbac-entitlement-server.test.js` | 6/6 (controle negativo: 1 falha sem o guard) |
| `node --test test/invariants/integracoes-rbac-entitlement-front.test.js` | 7/7 |
| 20 arquivos relacionados (auth-server, entitlement-canonico, fase3-server-ab, fase4-integrations, fase4-server-integrations, ga4-store-nativa, google-http, ink-webhook-guia, integracoes-* (5), meta-campaign-performance, meta-store-nativa, modal-foco, navegacao-painel, r19-entitlement-seed, store-escopo-front, nav-prefs, e os 2 novos) | **219 testes · 219 aprovados · 0 falhas · 0 cancelados · 0 ignorados** |
| `npm run build` (`tsc -b` + `vite build`) · `check-contracts` · `ci/suites.mjs verify` · `repo:self-check` | limpos / OK (3 contratos; 156 arquivos: 80 sem banco em 2 shards, 76 com banco em 4 shards; 911 arquivos varridos) |

A suíte integral (2283 testes) **não** foi repetida: a mudança é aditiva em 10 rotas e em 5 componentes; a execução integral anterior cobriu o resto e os 20 arquivos acima cobrem as áreas tocadas.

## Limitações

- O CI remoto não roda sem push.
- Não há teste de render do componente: a parte visual (member sem botões; card de análises ausente sem a feature) é provada por contrato de fonte + servidor; o último Playwright completo foi o do fechamento anterior.
- O `entitlements` do front tem cache global de módulo; a troca de Organização recarrega a aplicação (`window.location.reload()`), e o hook ainda re-chaveia por Organization.
- Os fluxos reais (OAuth, Embedded Signup, envio do WhatsApp, Ink/OpenAI reais, APIs reais de mídia) **continuam sem validação**: dependem de credenciais e ambiente adequados.
