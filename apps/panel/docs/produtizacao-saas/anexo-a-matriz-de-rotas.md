# Anexo A — Tenant Surface Matrix: inventário de rotas (`server.js` + `routes/criativos.js`)

> Anexo de [`productization-audit.md`](./productization-audit.md). Baseline: commit `8a7ea3d`, 15/09/2026.
>
> Auditoria READ-ONLY. Todas as linhas citam `arquivo:linha` do início do handler.
> Metodologia e limitações no final do documento.

**Correções aplicadas pela revisão do lead** (a tabela abaixo já as incorpora):

1. `GET /assets/pedidos/:filename` (server.js:1666) foi originalmente marcado como "path.join sem
   checagem extra". **Incorreto**: o handler valida com `/^[A-Za-z0-9_-]{10,14}\.png$/` antes de
   qualquer uso, e nem sequer toca o disco — o QR é gerado em memória a partir do `pixCode`.
   Não há path traversal. Reclassificado.
2. A limitação "entropia dos ids de pedido não confirmada" foi **resolvida**: `generatePedidoId`
   (server.js:1525-1531) usa `crypto.randomBytes(9).toString('base64url')` — 12 caracteres,
   ~72 bits de entropia, com verificação de colisão. Os ids de pedido **não** são enumeráveis.
   A entropia de `media_assets.public_token` foi confirmada em separado (24 bytes aleatórios).

## Atualização após a revisão de decisões do usuário

Duas decisões fechadas mudam como esta matriz deve ser lida. As linhas abaixo **não** foram
reescritas (elas continuam sendo o retrato fiel do commit `8a7ea3d`), mas a leitura muda:

1. **As 35 linhas de `/api/admin/internal/origens-migration/*` são `TO_REMOVE`.** A ferramenta de
   Migração Use Origens cumpriu seu objetivo e **não faz parte do Oria**. Não devem ser portadas,
   nem contadas como superfície tenant-facing futura. Com elas fora, a superfície administrativa
   a productizar cai de 278 para **~243 rotas**.
2. **`loja` deixa de ser parâmetro de request na maioria das rotas.** Com a cardinalidade
   1 Organization = 1 Store da V1, a Store é resolvida pelo contexto autenticado. As ~125 rotas
   classificadas MEDIUM ("`loja` validada só por enum") não precisam ganhar checagem de posse —
   precisam **parar de receber `loja`**. O risco não é mitigado nessas rotas: ele é eliminado ao
   remover o parâmetro.

Isso não vale para as 10 rotas CRITICAL nem para as ~38 HIGH: essas selecionam credencial ou
recurso por identificador e continuam exigindo verificação de posse contra a Organization autenticada.

## server.js (243 registros: app.get/post/put/patch/delete/use)

| Método | Rota | Linha | Domínio | Guard atual | Identificador vindo do cliente | Validado no servidor? | Classe | Risco de tenancy |
|---|---|---|---|---|---|---|---|---|

| USE | `express.json({` | server.js:1637 | Outro | nenhum (middleware global) | — | — | STATIC | LOW |
| GET | `/img/:filename` | server.js:1646 | Estático — proxy de imagem | nenhum | filename (regex) | Sim (regex VALID_IMG) | PUBLIC | LOW |
| GET | `/assets/pedidos/:filename` | server.js:1666 | Estático — QR do PIX (gerado em memória) | nenhum | filename | **Sim** — regex estrita `/^[A-Za-z0-9_-]{10,14}\.png$/` antes de qualquer uso; não toca o disco | PUBLIC | LOW (URL-capacidade ~72 bits, sem TTL) |
| USE | `(req, res, next) => {` | server.js:1683 | Outro | nenhum | — | — | STATIC | LOW |
| USE | `/admin/assets` | server.js:1706 | Estático — build do admin (SPA) | nenhum | — | — | STATIC | LOW |
| GET | `/^\/admin(\/.*)?$/` | server.js:1710 | Estático — fallback SPA do admin | nenhum | — | — | STATIC | LOW |
| POST | `/api/log` | server.js:1719 | Observabilidade — log do cliente (site público) | nenhum | loja (body, texto livre) | Não (apenas logado) | PUBLIC | LOW |
| GET | `/^\/(?:sul\|centro\|norte)\/loja(\/[^.]*)?$/` | server.js:1733 | Loja pública (storefront personalizados) | nenhum | — | — | PUBLIC | LOW |
| POST | `/api/loja/log` | server.js:1738 | Observabilidade — log do cliente (loja) | nenhum | loja (body, texto livre) | Não (apenas logado) | PUBLIC | LOW |
| GET | `/^\/(?:sul\|centro\|norte)(\/[^.]*)?$/` | server.js:1746 | Site público regional (cidade) | nenhum | — | — | PUBLIC | LOW |
| GET | `new RegExp(`^\\/(?:${UF_CODES.join('\|')})\\/[a-z0-9-]+$`)` | server.js:1752 | Site público regional (UF/cidade) | nenhum | — | — | PUBLIC | LOW |
| POST | `/api/admin/login` | server.js:1756 | Autenticação | nenhum (é o próprio login) + rate limit por IP | senha (body) | Sim (compara com ADMIN_PASSWORD) | PUBLIC | LOW |
| POST | `/api/admin/logout` | server.js:1786 | Autenticação | nenhum (logout) | — | — | PUBLIC | LOW |
| GET | `/api/admin/session` | server.js:1791 | Autenticação | nenhum (checa cookie e responde estado) | — | — | PUBLIC | LOW |
| GET | `/api/admin/webhook-log` | server.js:1798 | Observabilidade — log de webhooks | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/pedidos` | server.js:1817 | Pedidos — manuais (Pix) | requireAdmin | — | Sim (enum LOJAS/INK_STORES) | ADMIN | LOW |
| GET | `/api/admin/pedidos/ink/pendentes` | server.js:1893 | Pedidos — Ink | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/pedidos/ink` | server.js:1929 | Pedidos — Ink | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/pedidos/:id/sync` | server.js:1969 | Pedidos — sync individual | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/dashboard/abandoned-carts` | server.js:2006 | Dashboard — carrinhos abandonados | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/dashboard/recuperacao-resumo` | server.js:2030 | Recuperação de carrinho | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/recuperacao` | server.js:2131 | Recuperação de carrinho | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| POST | `/api/admin/recuperacao/carrinho/enviar` | server.js:2340 | Recuperação de carrinho | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/recuperacao/pix/enviar` | server.js:2402 | Recuperação de carrinho | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/dashboard/orders` | server.js:2486 | Dashboard — pedidos | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/dashboard/lucro-produtos` | server.js:2537 | Dashboard — lucro | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/dashboard/financeiro` | server.js:2594 | Dashboard — financeiro | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/pedidos/central` | server.js:2818 | Pedidos — central | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/pedidos/central/:loja/:id` | server.js:2898 | Pedidos — central | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/trocas` | server.js:2936 | Trocas | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/trocas/:loja/:id` | server.js:2976 | Trocas | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/trocas` | server.js:2992 | Trocas | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/reembolsos` | server.js:3044 | Reembolsos | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/pedidos/central/:loja/:id/reembolsos` | server.js:3054 | Pedidos — central | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/pedidos/:loja/:id/reembolsos` | server.js:3069 | Reembolsos | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/produtos` | server.js:3190 | Catálogo — produtos | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/produtos/catalogo/status` | server.js:3863 | Catálogo — sync/config | requireAdmin | — | Sim (enum LOJAS/INK_STORES) | ADMIN | LOW |
| POST | `/api/admin/produtos/catalogo/sync` | server.js:3905 | Catálogo — sync/config | requireAdmin | loja (body) | Não | ADMIN | MEDIUM |
| PUT | `/api/admin/produtos/catalogo/config` | server.js:3920 | Catálogo — sync/config | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/produtos/feed/status` | server.js:3949 | Catálogo — feed | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/produtos/feed/sync` | server.js:3981 | Catálogo — feed | requireAdmin | loja (body) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/produtos/:loja/:id` | server.js:3993 | Catálogo — produtos | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/produto-tipos` | server.js:4005 | Catálogo — tipos de produto | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/produtos` | server.js:4018 | Catálogo — produtos | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| PATCH | `/api/admin/produtos/:loja/:id` | server.js:4074 | Catálogo — produtos | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/produtos/:loja/:id/duplicar` | server.js:4100 | Catálogo — produtos | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/categorias/:loja` | server.js:4146 | Categorias | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/categorias/:loja/:id` | server.js:4158 | Categorias | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/categorias/:loja/:id/produtos-nomes` | server.js:4174 | Categorias | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/categorias` | server.js:4211 | Categorias | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| PATCH | `/api/admin/categorias/:loja/:id` | server.js:4230 | Categorias | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| DELETE | `/api/admin/categorias/:loja/:id` | server.js:4252 | Categorias | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/categorias/:loja/:id/adicionar-produto` | server.js:4266 | Categorias | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/categorias/:loja/:id/vitrine` | server.js:4284 | Categorias | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| PUT | `/api/admin/categorias/:loja/:id/vitrine` | server.js:4296 | Categorias | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/categorias/:loja/bulk-preview` | server.js:4323 | Categorias | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/categorias/:loja/bulk-create` | server.js:4367 | Categorias | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/categorias/:loja/bulk-ativar` | server.js:4413 | Categorias | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/categorias/:loja/bulk-excluir` | server.js:4460 | Categorias | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/category-assignments/preview` | server.js:4576 | Categorias — atribuição | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/category-assignments` | server.js:4613 | Categorias — atribuição | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/category-jobs/:id` | server.js:4656 | Categorias — jobs em lote | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/category-jobs/:id/items` | server.js:4670 | Categorias — jobs em lote | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/category-jobs/:id/falhas-por-tipo` | server.js:4692 | Categorias — jobs em lote | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/internal/origens-migration/debug/testar-item/:itemId` | server.js:4741 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | itemId (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/category-jobs/:id/retry-failed` | server.js:4804 | Categorias — jobs em lote | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/category-jobs/:id/cancel` | server.js:4817 | Categorias — jobs em lote | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/internal-tools/status` | server.js:4826 | Ferramenta interna — status | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/internal/origens-migration/rules` | server.js:6240 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (query) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/rules` | server.js:6248 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| PATCH | `/api/admin/internal/origens-migration/rules/:id` | server.js:6298 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path), loja (body) | Não | INTERNAL | MEDIUM |
| DELETE | `/api/admin/internal/origens-migration/rules/:id` | server.js:6340 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/simulate` | server.js:6596 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id` | server.js:6621 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/simulations/:id/reavaliar-conflitos` | server.js:6692 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id/corrigir-categoria-extra/preview` | server.js:6745 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/simulations/:id/corrigir-categoria-extra` | server.js:6765 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id/auditoria-fala-daqui` | server.js:6840 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path), loja (query) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/simulations/:id/corrigir-fala-daqui-indevido` | server.js:6901 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path), loja (body) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations` | server.js:6974 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (query) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id/gentilico-fala-daqui/preview` | server.js:7024 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/simulations/:id/gentilico-fala-daqui/aplicar` | server.js:7044 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id/corrigir-por-nome/preview` | server.js:7114 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/simulations/:id/corrigir-por-nome/aplicar` | server.js:7136 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path), loja (body) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id/items` | server.js:7174 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| PATCH | `/api/admin/internal/origens-migration/simulations/:id/items/:itemId` | server.js:7192 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path), itemId (path) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id/rule-counts` | server.js:7212 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/simulations/:id/execute` | server.js:7256 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path), loja (body) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/simulations/:id/export.csv` | server.js:7334 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/rules/preset-preview` | server.js:7356 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (query) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/rules/preset-create` | server.js:7443 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/rules/preset-especiais-preview` | server.js:7509 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (query) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/city-uf-map` | server.js:7591 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (query) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/city-uf-map` | server.js:7601 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| PATCH | `/api/admin/internal/origens-migration/city-uf-map/:id` | server.js:7621 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| DELETE | `/api/admin/internal/origens-migration/city-uf-map/:id` | server.js:7633 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | id (path) | Não | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/city-uf-map/bulk-preview` | server.js:7641 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/city-uf-map/bulk-create` | server.js:7677 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/city-uf-map/importar-dicionario` | server.js:7706 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/city-uf-map/discover` | server.js:7728 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| GET | `/api/admin/internal/origens-migration/categorias-antigas` | server.js:7840 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (query) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| POST | `/api/admin/internal/origens-migration/categorias-antigas/excluir` | server.js:7853 | Ferramenta interna — migração Use Origens | requireAdmin + requireInternalTools | loja (body) | Sim (enum LOJAS/INK_STORES) | INTERNAL | MEDIUM |
| GET | `/api/admin/agrupamentos/:loja` | server.js:8046 | Agrupamentos de produto | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/agrupamentos/:loja/:id` | server.js:8071 | Agrupamentos de produto | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/agrupamentos` | server.js:8088 | Agrupamentos de produto | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| DELETE | `/api/admin/agrupamentos/:loja/:clusterId/produtos/:produtoId` | server.js:8102 | Agrupamentos de produto | requireAdmin | loja (path), clusterId (path), produtoId (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/promocoes/:loja` | server.js:8117 | Promoções | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/promocoes` | server.js:8131 | Promoções | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| PATCH | `/api/admin/promocoes/:loja/:type/:id` | server.js:8146 | Promoções | requireAdmin | loja (path), type (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| DELETE | `/api/admin/promocoes/:loja/:id` | server.js:8159 | Promoções | requireAdmin | loja (path), id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/financeiro/:loja/resumo` | server.js:8175 | Financeiro — resumo por loja | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/financeiro/:loja/movimentacoes` | server.js:8187 | Financeiro — resumo por loja | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/financeiro/:loja/antecipacoes` | server.js:8202 | Financeiro — resumo por loja | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/financeiro/:loja/saques` | server.js:8214 | Financeiro — resumo por loja | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/frete/:loja/simular` | server.js:8229 | Frete | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/estoque` | server.js:8246 | Estoque | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/controle-estoque` | server.js:8292 | Estoque — controle dedicado | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/controle-estoque/sincronizar` | server.js:8334 | Estoque — controle dedicado | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/controle-estoque/limpar` | server.js:8357 | Estoque — controle dedicado | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/dashboard/customers` | server.js:8380 | Dashboard — clientes | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/clientes` | server.js:8402 | Clientes — CRM | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/campaigns/audience/preview` | server.js:8688 | Campanhas — audiência | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/segments` | server.js:8710 | Segmentos de clientes | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/segments` | server.js:8721 | Segmentos de clientes | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/segments/:id` | server.js:8738 | Segmentos de clientes | requireAdmin | id (path) | Não | ADMIN | HIGH |
| DELETE | `/api/admin/segments/:id` | server.js:8756 | Segmentos de clientes | requireAdmin | id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | HIGH |
| GET | `/api/admin/utm/campaigns` | server.js:8830 | UTM | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/utm/campaigns/:id` | server.js:8849 | UTM | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/utm/campaigns` | server.js:8861 | UTM | requireAdmin | loja (body) | Não | ADMIN | MEDIUM |
| PATCH | `/api/admin/utm/campaigns/:id` | server.js:8878 | UTM | requireAdmin | id (path), loja (body) | Não | ADMIN | MEDIUM |
| DELETE | `/api/admin/utm/campaigns/:id` | server.js:8897 | UTM | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/utm/campaigns/:id/duplicate` | server.js:8910 | UTM | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/utm/campaigns/:id/archive` | server.js:8928 | UTM | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/utm/campaigns/:id/unarchive` | server.js:8943 | UTM | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/utm/presets` | server.js:8963 | UTM | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/utm/presets` | server.js:8974 | UTM | requireAdmin | — | — | ADMIN | LOW |
| DELETE | `/api/admin/utm/presets/:id` | server.js:8994 | UTM | requireAdmin | id (path) | Sim (formato UUID) | ADMIN | HIGH |
| GET | `/api/admin/campaigns` | server.js:9038 | Campanhas WhatsApp | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/campaigns/:id` | server.js:9052 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/campaigns` | server.js:9064 | Campanhas WhatsApp | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| PUT | `/api/admin/campaigns/:id` | server.js:9086 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| DELETE | `/api/admin/campaigns/:id` | server.js:9119 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/campaigns/:id/duplicate` | server.js:9137 | Campanhas WhatsApp | requireAdmin | id (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | HIGH |
| POST | `/api/admin/campaigns/:id/start` | server.js:9285 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/campaigns/:id/batches` | server.js:9351 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/campaigns/:id/pause` | server.js:9373 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/campaigns/:id/resume` | server.js:9388 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/campaigns/:id/summary` | server.js:9425 | Campanhas WhatsApp | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/campaigns/:id/recipients` | server.js:9492 | Campanhas WhatsApp | requireAdmin | id (path), loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/integrations` | server.js:9529 | Outro | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/integrations/google-analytics/status` | server.js:9757 | Integração — Google Analytics (GA4) | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/integrations/google-analytics/connect` | server.js:9770 | Integração — Google Analytics (GA4) | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| GET | `/api/admin/integrations/google-analytics/callback` | server.js:9792 | Integração — Google Analytics (GA4) | nenhum (callback OAuth externo) — loja resolvida no servidor a partir do state, não do client | state (query, HMAC/assinado ou mapa em memória) | Sim (state validado contra GA_OAUTH_STATES / assinatura HMAC p/ Google Ads) | PUBLIC | HIGH |
| GET | `/api/admin/integrations/google-analytics/properties` | server.js:9845 | Integração — Google Analytics (GA4) | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| POST | `/api/admin/integrations/google-analytics/property` | server.js:9858 | Integração — Google Analytics (GA4) | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| POST | `/api/admin/integrations/google-analytics/disconnect` | server.js:9872 | Integração — Google Analytics (GA4) | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| GET | `/api/admin/integrations/google-analytics/performance` | server.js:10003 | Integração — Google Analytics (GA4) | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| GET | `/api/admin/integrations/google-analytics/performance/series` | server.js:10066 | Integração — Google Analytics (GA4) | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| GET | `/api/admin/integrations/google-analytics/overview` | server.js:10169 | Integração — Google Analytics (GA4) | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| GET | `/api/admin/integrations/google-ads/oauth/start` | server.js:10302 | Integração — Google Ads | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/integrations/google-ads/disconnect` | server.js:10372 | Integração — Google Ads | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/integrations/google-ads/status` | server.js:10539 | Integração — Google Ads | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/integrations/google-ads/contas/sincronizar` | server.js:10579 | Integração — Google Ads | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/integrations/google-ads/contas/:customerId/selecionar` | server.js:10589 | Integração — Google Ads | requireAdmin | customerId (path), loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| POST | `/api/admin/integrations/google-ads/contas/:customerId/loja` | server.js:10625 | Integração — Google Ads | requireAdmin | customerId (path), loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| POST | `/api/admin/integrations/google-ads/sync` | server.js:10644 | Integração — Google Ads | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/google-ads/overview` | server.js:10665 | Integração — Google Ads (analytics) | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/integrations/meta/status` | server.js:11275 | Integração — Meta Ads | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/integrations/meta/connect` | server.js:11312 | Integração — Meta Ads | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/integrations/meta/callback` | server.js:11330 | Integração — Meta Ads | nenhum (callback OAuth externo) | state (query) | Sim (state validado contra META_OAUTH_STATES) | PUBLIC | MEDIUM |
| GET | `/api/admin/integrations/meta/ad-accounts` | server.js:11384 | Integração — Meta Ads | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/integrations/meta/select-account` | server.js:11402 | Integração — Meta Ads | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | CRITICAL |
| POST | `/api/admin/integrations/meta/sync` | server.js:11439 | Integração — Meta Ads | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/integrations/meta/disconnect` | server.js:11453 | Integração — Meta Ads | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/meta/overview` | server.js:11528 | Integração — Meta Ads (analytics) | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/meta/timeseries` | server.js:11563 | Integração — Meta Ads (analytics) | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/meta/entities` | server.js:11620 | Integração — Meta Ads (analytics) | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/meta/metas` | server.js:11689 | Integração — Meta Ads (analytics) | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/analytics/meta/metas` | server.js:11698 | Integração — Meta Ads (analytics) | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/meta/creatives` | server.js:11733 | Integração — Meta Ads (analytics) | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/meta/ads/:adId` | server.js:11795 | Integração — Meta Ads (analytics) | requireAdmin | adId (path), loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/financeiro/despesas` | server.js:12000 | Financeiro — despesas | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/admin/financeiro/despesas` | server.js:12022 | Financeiro — despesas | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| PUT | `/api/admin/financeiro/despesas/:id` | server.js:12042 | Financeiro — despesas | requireAdmin | id (path) | Não | ADMIN | HIGH |
| DELETE | `/api/admin/financeiro/despesas/:id` | server.js:12061 | Financeiro — despesas | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/financeiro/custos-api/precos` | server.js:12088 | Financeiro — custos de API | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/financeiro/custos-api/precos/:chave` | server.js:12097 | Financeiro — custos de API | requireAdmin | chave (path) | Não | ADMIN | HIGH |
| DELETE | `/api/admin/financeiro/custos-api/precos/:chave` | server.js:12119 | Financeiro — custos de API | requireAdmin | chave (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/financeiro/custos-api` | server.js:12130 | Financeiro — custos de API | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/analytics/consolidado` | server.js:12249 | Analytics — consolidado | requireAdmin | loja (query) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/automation-settings` | server.js:12570 | Automação — configurações | requireAdmin | — | — | ADMIN | LOW |
| PATCH | `/api/admin/automation-settings` | server.js:12584 | Automação — configurações | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| POST | `/api/whatsapp-web-agente/heartbeat` | server.js:12845 | Agente WhatsApp Web (bridge) | requireAgenteWhatsappWeb (token de serviço do agente, não é sessão admin) | — | — | INTERNAL | MEDIUM |
| POST | `/api/whatsapp-web-agente/claim` | server.js:12873 | Agente WhatsApp Web (bridge) | requireAgenteWhatsappWeb (token de serviço do agente, não é sessão admin) | — | — | INTERNAL | MEDIUM |
| POST | `/api/whatsapp-web-agente/:id/resultado` | server.js:12943 | Agente WhatsApp Web (bridge) | requireAgenteWhatsappWeb (token de serviço do agente, não é sessão admin) | id (path) | Sim (formato UUID) | INTERNAL | MEDIUM |
| GET | `/api/admin/whatsapp-web/config` | server.js:13010 | WhatsApp Web — admin | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/whatsapp-web/config` | server.js:13027 | WhatsApp Web — admin | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/whatsapp/meta-app` | server.js:13074 | WhatsApp — config app Meta | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/whatsapp/meta-app` | server.js:13083 | WhatsApp — config app Meta | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/whatsapp-web/agente-token` | server.js:13109 | WhatsApp Web — admin | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/whatsapp-web/resumo` | server.js:13125 | WhatsApp Web — admin | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/whatsapp-web/fila` | server.js:13156 | WhatsApp Web — admin | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| POST | `/api/admin/whatsapp-web/fila/:id/assumir` | server.js:13196 | WhatsApp Web — admin | requireAdmin | id (path) | Sim (formato UUID) | ADMIN | HIGH |
| POST | `/api/admin/whatsapp-web/fila/:id/concluir` | server.js:13242 | WhatsApp Web — admin | requireAdmin | id (path) | Sim (formato UUID) | ADMIN | HIGH |
| POST | `/api/admin/whatsapp-web/fila/acao` | server.js:13285 | WhatsApp Web — admin | requireAdmin | loja (body) | Sim (formato UUID) | ADMIN | MEDIUM |
| GET | `/api/admin/settings/product` | server.js:13333 | Configurações — produto | requireAdmin | — | — | ADMIN | LOW |
| PATCH | `/api/admin/settings/product` | server.js:13343 | Configurações — produto | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/entitlements` | server.js:13387 | Entitlements | requireAdmin | — | Sim (enum LOJAS/INK_STORES) | ADMIN | LOW |
| POST | `/api/admin/pedidos/:loja/backfill-historico` | server.js:14465 | Pedidos — backfill histórico | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/pedidos/:loja/backfill-historico/:jobId` | server.js:14493 | Pedidos — backfill histórico | requireAdmin | loja (path), jobId (path) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/pedidos/:loja/backfill-historico` | server.js:14504 | Pedidos — backfill histórico | requireAdmin | loja (path) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/pedidos/:loja/uf-diagnostico` | server.js:14518 | Pedidos — diagnóstico UF | requireAdmin | loja (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/whatsapp/visao-geral` | server.js:15205 | WhatsApp — visão geral | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/media` | server.js:15274 | Mídia | requireAdmin | loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/media` | server.js:15336 | Mídia | requireAdmin | loja (query) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/media/:id/arquivo` | server.js:15358 | Mídia | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/midia/:token/arquivo` | server.js:15380 | Mídia — acesso público por token | nenhum — segurança é o token opaco, não sessão | token (path, alta entropia) | Sim (SELECT ... WHERE public_token = $1) | PUBLIC | MEDIUM |
| DELETE | `/api/admin/media/:id` | server.js:15391 | Mídia | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/whatsapp-templates` | server.js:15406 | Templates WhatsApp | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/whatsapp-templates` | server.js:15433 | Templates WhatsApp | requireAdmin | — | — | ADMIN | LOW |
| DELETE | `/api/admin/whatsapp-templates/:nome` | server.js:15501 | Templates WhatsApp | requireAdmin | nome (path) | Não | ADMIN | HIGH |
| PUT | `/api/admin/whatsapp-templates/:nome/amostra` | server.js:15530 | Templates WhatsApp | requireAdmin | nome (path) | Não | ADMIN | HIGH |
| POST | `/api/admin/whatsapp-templates/:nome/test` | server.js:15581 | Templates WhatsApp | requireAdmin | nome (path), loja (body) | Não | ADMIN | MEDIUM |
| GET | `/api/admin/campos-customizados` | server.js:15666 | Campos customizados | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/campos-customizados` | server.js:15677 | Campos customizados | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/campos-customizados/:chave` | server.js:15697 | Campos customizados | requireAdmin | chave (path), loja (body) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| DELETE | `/api/admin/campos-customizados/:chave` | server.js:15725 | Campos customizados | requireAdmin | chave (path) | Não | ADMIN | HIGH |
| GET | `/api/admin/automacao-eventos` | server.js:15766 | Automação de eventos | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/automacao-eventos/:loja/:evento` | server.js:15791 | Automação de eventos | requireAdmin | loja (path), evento (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| DELETE | `/api/admin/automacao-eventos/:loja/:evento` | server.js:15904 | Automação de eventos | requireAdmin | loja (path), evento (path) | Não | ADMIN | MEDIUM |
| PUT | `/api/admin/automacao-eventos/:loja/:evento/web` | server.js:15925 | Automação de eventos | requireAdmin | loja (path), evento (path) | Sim (enum LOJAS/INK_STORES) | ADMIN | MEDIUM |
| GET | `/api/admin/whatsapp-web/mensagens` | server.js:16018 | WhatsApp Web — admin | requireAdmin | — | — | ADMIN | LOW |
| GET | `/api/admin/whatsapp-web/mensagens/:id` | server.js:16033 | WhatsApp Web — admin | requireAdmin | id (path) | Sim (formato UUID) | ADMIN | HIGH |
| POST | `/api/admin/whatsapp-web/mensagens` | server.js:16046 | WhatsApp Web — admin | requireAdmin | — | — | ADMIN | LOW |
| PUT | `/api/admin/whatsapp-web/mensagens/:id` | server.js:16065 | WhatsApp Web — admin | requireAdmin | id (path), loja (body) | Sim (formato UUID) | ADMIN | MEDIUM |
| DELETE | `/api/admin/whatsapp-web/mensagens/:id` | server.js:16098 | WhatsApp Web — admin | requireAdmin | id (path) | Sim (formato UUID) | ADMIN | HIGH |
| POST | `/api/webhooks/ink` | server.js:16129 | Webhook — Ink | assinatura HMAC (x-webhook-signature) testada contra o segredo de cada loja | loja (não é lida do body — resolvida no servidor via HMAC por loja) | Sim (HMAC por loja, identifyInkWebhookStore) | WEBHOOK | LOW |
| POST | `/api/webhooks/whatsapp` | server.js:16233 | Webhook — WhatsApp | query secret == WHATSAPP_WEBHOOK_SECRET | secret (query) | Sim (comparação com WHATSAPP_WEBHOOK_SECRET) | WEBHOOK | LOW |
| POST | `/api/admin/qr-preview` | server.js:16265 | Pix — preview QR | requireAdmin | — | — | ADMIN | LOW |
| POST | `/api/admin/pedidos` | server.js:16279 | Pedidos — manuais (Pix) | requireAdmin | loja (body) | Não | ADMIN | MEDIUM |
| DELETE | `/api/admin/pedidos/:id` | server.js:16307 | Pedidos — manuais (Pix) | requireAdmin | id (path) | Não | ADMIN | HIGH |
| GET | `/api/pedidos/:id` | server.js:16320 | Pedidos — rastreio público | nenhum — id de alta entropia funciona como capability token | id (path, regex PEDIDO_ID_RE) | Sim (formato) — sem outra autenticação (rastreio público por ID) | PUBLIC | LOW |
| GET | `new RegExp(`^/([A-Za-z0-9_-]{10,14})$`)` | server.js:16344 | Site público — hotpage do pedido | nenhum — hotpage pública | id (path, regex 10-14 chars) | Sim (formato) | PUBLIC | LOW |

## routes/criativos.js (montado em `/api/admin/criativos`, 35 endpoints — inclui expansão do loop de 4 tipos de perfil × 4 verbos)

| Método | Rota | Linha | Domínio | Guard atual | Identificador vindo do cliente | Validado no servidor? | Classe | Risco de tenancy |
|---|---|---|---|---|---|---|---|---|

| GET | `/api/admin/criativos/status` | routes/criativos.js:123 | Gerador de Criativos (Oria) | requireAdmin | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/catalog` | routes/criativos.js:144 | Gerador de Criativos (Oria) | requireAdmin | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/settings/openai-key` | routes/criativos.js:158 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| PUT | `/api/admin/criativos/settings/openai-key` | routes/criativos.js:159 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | apiKey (body) | Sim (nunca devolvida/logada; tenant fixo por env) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| DELETE | `/api/admin/criativos/settings/openai-key` | routes/criativos.js:163 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/settings/openai-key/test` | routes/criativos.js:167 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/brand-kits` | routes/criativos.js:176 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo (env CREATIVE_TENANT_ID), não vem do request | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/brand-kits` | routes/criativos.js:213 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo por env; contrato validado no core antes de salvar | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| PUT | `/api/admin/criativos/brand-kits/:id` | routes/criativos.js:214 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — sem checar dono; tenant_id fixo por env (single-tenant) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| DELETE | `/api/admin/criativos/brand-kits/:id` | routes/criativos.js:215 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — idem | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/niche-kits` | routes/criativos.js:176 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo (env CREATIVE_TENANT_ID), não vem do request | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/niche-kits` | routes/criativos.js:213 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo por env; contrato validado no core antes de salvar | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| PUT | `/api/admin/criativos/niche-kits/:id` | routes/criativos.js:214 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — sem checar dono; tenant_id fixo por env (single-tenant) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| DELETE | `/api/admin/criativos/niche-kits/:id` | routes/criativos.js:215 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — idem | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/context-profiles` | routes/criativos.js:176 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo (env CREATIVE_TENANT_ID), não vem do request | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/context-profiles` | routes/criativos.js:213 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo por env; contrato validado no core antes de salvar | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| PUT | `/api/admin/criativos/context-profiles/:id` | routes/criativos.js:214 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — sem checar dono; tenant_id fixo por env (single-tenant) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| DELETE | `/api/admin/criativos/context-profiles/:id` | routes/criativos.js:215 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — idem | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/personas` | routes/criativos.js:176 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo (env CREATIVE_TENANT_ID), não vem do request | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/personas` | routes/criativos.js:213 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo por env; contrato validado no core antes de salvar | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| PUT | `/api/admin/criativos/personas/:id` | routes/criativos.js:214 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — sem checar dono; tenant_id fixo por env (single-tenant) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| DELETE | `/api/admin/criativos/personas/:id` | routes/criativos.js:215 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — idem | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/products` | routes/criativos.js:223 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | tenant_id fixo por env | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/products` | routes/criativos.js:227 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | whitelist de campos (permitidos) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/products/:id/references/:n` | routes/criativos.js:248 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id, n (path) | Sim (UUID_RE + regex numérico) — sem checar dono além do tenant fixo | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| DELETE | `/api/admin/criativos/products/:id` | routes/criativos.js:257 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/preview` | routes/criativos.js:277 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/jobs` | routes/criativos.js:301 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/jobs` | routes/criativos.js:311 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/jobs/:id` | routes/criativos.js:314 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) — sem dono além do tenant fixo | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/jobs/:id/cancel` | routes/criativos.js:320 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id (path) | Sim (UUID_RE) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/jobs/:id/items/:creativeId/retry` | routes/criativos.js:326 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | id, creativeId (path) | Sim (UUID_RE) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/history` | routes/criativos.js:334 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | limit (query) | Sim (clamp 1-200) | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| GET | `/api/admin/criativos/assets/:creativeId` | routes/criativos.js:339 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | creativeId (path) | Sim (UUID_RE) — sem dono além do tenant fixo | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |
| POST | `/api/admin/criativos/copies` | routes/criativos.js:348 | Gerador de Criativos (Oria) | requireAdmin + exigirStore + exigirModulo | — | — | ADMIN | LOW (tenant_id fixo por env, nunca do request; todas as rotas atrás de requireAdmin) |

## Metodologia e legenda

- Levantamento por `grep -nE "^\\s*app\\.(get|post|put|patch|delete|use)\\("` em `server.js` (243 ocorrências) e `grep -nE "router\\.(get|post|put|patch|delete|use)\\("` em `routes/criativos.js` (24 ocorrências, sendo 1 `router.use(deps.requireAdmin)` global). O loop que registra 4 tipos de perfil (`brand-kits`, `niche-kits`, `context-profiles`, `personas`) × 4 verbos foi expandido manualmente para 16 linhas reais (total de 35 linhas para o módulo de criativos).
- **Guard atual**: lido diretamente do argumento de middleware na própria linha `app.METHOD(...)`. `requireAdmin` (server.js:1574) só verifica assinatura HMAC do cookie de sessão — não existe usuário, organização nem membership (confirmado pelo comentário em server.js:1580-1583 e pelo código de `requireAdmin`/`requireInternalTools`, server.js:1574-1589).
- **Identificador vindo do cliente**: presença de `:param` na rota, ou de `loja`/outro campo lido de `req.query`/`req.body` dentro do corpo do handler (ou de uma função auxiliar já lida, como `prepararUtmCampanha`, quando citada). Rotas sem nenhum identificador estão marcadas `—`.
- **Validado no servidor?**: distingue dois tipos de checagem, que este relatório trata como coisas diferentes:
  1. *Whitelist de enum* — `LOJAS[loja]` ou `INK_STORES[loja]` (31 + 86 ocorrências no arquivo) confirma que `loja` é uma das 3 chaves fixas (`sul`/`centro`/`norte`) definidas em server.js:58 e server.js:69. Isso é validação de **formato/pertencimento a um enum fixo**, não de **posse** (não existe verificação de que o autor da requisição "é dono" daquela loja, porque não existe conceito de dono).
  2. *Formato de ID* — `UUID_RE.test(...)` (routes/criativos.js) ou regex de path (`PEDIDO_ID_RE`, `VALID_IMG`) confirma só a forma do identificador, não a posse do recurso.
  Nenhuma rota do server.js ou de routes/criativos.js foi encontrada checando "este registro pertence a este usuário/organização autenticado" — porque essa noção não existe no modelo de auth atual (senha única compartilhada).
- **Classe**: PUBLIC (sem guard), ADMIN (`requireAdmin`), INTERNAL (`requireInternalTools` — 404 quando `INTERNAL_TOOLS_ENABLED` não é `'true'`, server.js:1585-1589 — ou o guard de token do agente WhatsApp Web, que não é sessão admin), WEBHOOK (assinatura/segredo verificado), STATIC (assets/SPA/middleware não funcional).
- **Risco de tenancy**: heurística factual, não prescritiva (a tarefa pede fatos, não correções):
  - **CRITICAL** — o identificador vindo do cliente (`loja`) seleciona diretamente uma credencial/conexão OAuth por loja (token GA4, propriedade GA4, revogação, contas do Google Ads/Meta) com apenas checagem de enum, sem qualquer verificação de posse — hoje mitigado só pelo fato de existir uma única senha admin para as 3 lojas.
  - **HIGH** — rota com `:id`/`:chave`/`:nome`/`:customerId`/`:adId` que seleciona um recurso "dono de alguém" (campanha, segmento, campanha UTM, despesa, mídia, mensagem, job de categoria, simulação de migração) sem nenhuma amarração desse recurso a quem está autenticado.
  - **MEDIUM** — rota com `loja` (path/query/body) validada só por enum, usada para filtrar/gravar dados (não credenciais); ferramentas internas atrás de `requireInternalTools` (desligadas por padrão, mas sem escopo por loja quando ligadas).
  - **LOW** — sem identificador vindo do cliente, ou rota pública/webhook cuja segurança vem de um segredo/HMAC/token de alta entropia (não de sessão), ou já protegida por checagem de posse real.
- **Limitações conhecidas (não verificado em profundidade nesta passada)**:
  - Chamadas de função auxiliar fora do bloco da própria rota (ex.: `prepararUtmCampanha`, `prepararCampanha`) foram abertas manualmente para os casos citados no resumo final, mas nem toda função auxiliar referenciada por uma rota foi lida linha a linha — pode haver validações adicionais (ou ausências) em helpers não inspecionados.
  - Não foi auditada a entropia/geração dos identificadores usados como "capability token" (`media_assets.public_token`, id de pedido em `/api/pedidos/:id` e na hotpage `/{id}`) — o relatório assume que são de alta entropia com base no comentário do código, mas não confirmou a função geradora.
  - `app.use(...)` que montam middlewares inline (ex.: server.js:1637, server.js:1683) foram listados por completude do grep pedido, mas não são "rotas" no sentido do resto da tabela.
  - Regex routes (paths com `RegExp`/`/^.../ `) têm a "Rota" reproduzida como no código-fonte (com escapes), não normalizada.
