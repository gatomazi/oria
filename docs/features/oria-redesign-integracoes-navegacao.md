# Rodada noturna — redesign de Integrações e reorganização da navegação

Branch: `feature/redesign-integracoes-navegacao` (criada a partir de `feature/clientes-rfm`, a árvore mais atual do
monorepo). App: `apps/panel`. Sem push, merge, deploy nem migração.

## Decisões de arquitetura (o que o código real determinou)

| Ponto | Decisão | Motivo |
|---|---|---|
| Onde trabalhar | `/Users/gtomazi/projects/oria` (worktree principal) | A sessão foi aberta em `use-origens-workers` (Worker do widget da loja), que não tem painel. O `oria` é o checkout mais recente e limpo. |
| Fonte da navegação | `src/shell/nav.ts` (já era única) | Ganhou `NAV_STORE_MENU` + `STORE_MENU_GROUP`; sidebar, dropdown, breadcrumb e título leem de lá. |
| Autorização | Sem mudança | O guard real é o servidor (`requireAdmin`/`requireOwner`); a navegação só reflete. Membros continuam sem poder gravar Ink/WhatsApp. |
| Estado das linhas | Read model do servidor (`/api/admin/integrations` → `integracoes`) | Nenhum status é fixo no front; `estadoIntegracao.ts` só traduz (puro, testado). |
| Webhooks | O recebimento continua ativo; a **tela** de eventos brutos saiu | Ver "Segurança". |
| Campos personalizados | Página real (`/admin/campos`) → item do dropdown | Não foi criado CRUD novo. |
| Gerador V2 | Uma rota (`/admin/criativos`, com abas Gerar/Lotes/Histórico/Cadastros dentro) → grupo "Criativos" com 1 item | Não há rotas separadas para inventar. |
| PIX | Tem tela própria (`/admin/pix`) → Comunicação | Conforme o briefing. |
| Recolher a sidebar / grupos colapsáveis | Não implementado | O shell não tem o mecanismo; adicionar exigiria persistência por usuário fora do escopo. |

## Mapa `item atual → grupo final → rota → visibilidade`

Sidebar (só operação):

| Grupo | Itens (rota) |
|---|---|
| — | Visão geral (`/admin/dashboard`) |
| Operação | Pedidos (`/admin/pedidos-central`), Clientes, Trocas e devoluções, Estoque, **Simular frete** (`/admin/simular-frete`, vinha de Ferramentas) |
| Catálogo | Produtos, Categorias, Agrupamentos, Promoções (sem mudança) |
| Comunicação (era "WhatsApp") | Canal (`/admin/whatsapp`), **Recuperação** (vinha de Operação), **PIX** (vinha de Ferramentas), Automações, Templates (só modo API Meta), Mensagens e Fila de envio (só modo WhatsApp Web) |
| Marketing e dados (era parte de "Ferramentas") | Meta Ads, Google Ads, Google Analytics 4, UTM Tracker, Desempenho de produtos e Jornada de compra (estes dois continuam gated por `analytics_product_performance`) |
| Criativos | Gerador de criativos (`/admin/criativos`) |
| Campanhas | Todas as campanhas, Segmentos |
| Financeiro | Visão financeira, Despesas, Custos de API, Reembolsos |

Grupos removidos: **Ferramentas** e **Sistema**. Itens "em breve" (`comingSoon`) continuam declarados e invisíveis.
Instagram continua sem página → grupo invisível.

Menu da loja (canto superior direito, `NAV_STORE_MENU`): Configurações (`/admin/configuracoes`), Integrações
(`/admin/integracoes`), Campos personalizados (`/admin/campos`), separador, Sair. Todas as rotas são `requireAdmin`
(qualquer membro), então o item aparece para todos; o servidor segue negando o que for de `owner`.

Removido da navegação: **Webhooks e logs** (`/admin/eventos`). A URL antiga redireciona para `/admin/integracoes`
(favoritos não viram 404).

## Navegação — o que mudou

- Dropdown existente aprimorado (não foi criado outro menu): itens vêm de `NAV_STORE_MENU`, item da página atual
  destacado (`aria-current="page"`), largura mínima 240px e máxima `100vw - 16px`, `collisionPadding` 8px, linha
  "Plano atual: …" só aparece se o servidor respondeu (antes mostrava "…" ou um "Sem plano ativo" enganoso em erro de
  rede — novo `entitlementsCarregados()`).
- Breadcrumb das três páginas: `Loja › Integrações` etc.; nenhum item da sidebar acende.
- Drawer mobile: conteúdo atrás fica `inert` enquanto aberto; o drawer fecha ao alargar a janela até o layout desktop.
  Foco vai ao "Fechar" ao abrir (já existia) e volta ao botão de menu no Esc.
- Troca de organização continua recarregando a aplicação inteira (`AuthContext`); a página de Integrações também é
  remontada por `key={organizacaoAtiva.id}`.

## Integrações — o que mudou

`IntegracoesPage` virou uma central de conexões: alerta agregado (só se houver ação real e executável) → 4 seções
(Vendas e catálogo, Comunicação, Marketing e mensuração, Inteligência artificial) → um card expansível por provedor,
fechados por padrão, **um aberto por vez**, estado em `?provedor=<chave>&aba=<aba>` (deep link abre o card, rola e
foca o cabeçalho). O corpo só monta quando aberto: nada é consultado ao abrir a página além do resumo, pollers param ao
fechar e nada digitado (segredos) fica preso num card recolhido.

Arquivos:

| Arquivo | Papel |
|---|---|
| `estadoIntegracao.ts` | Rótulos/tons, `resumoDoProvedor`, `alertasDeAtencao` (puro). |
| `IntegracaoAcordeao.tsx` | Card acessível (`h3 > button[aria-expanded][aria-controls]`, região `aria-labelledby`), `Secao`, contexto `useAtualizarResumo`. |
| `IntegracoesPage.tsx` | Composição, deep link, alertas, releitura do resumo (resposta atrasada não sobrescreve a nova). |
| `InkIntegracao.tsx` | Reserva Ink: resumo de saúde + abas Conexão / Pedidos / Catálogo. |
| `InkCredenciaisCard.tsx` | Dividido em `InkConexaoSecao` (token) e `InkRecebimentoSecao` (recebimento automático). |
| `InkWebhookGuia.tsx` | Passo a passo guiado, com "Gerar URL" no passo 1 e "Salvar segredo" no passo 4. |
| `WhatsappIntegracao.tsx` | Abas Conexão (número/Meta) e Canal de envio (API Meta × WhatsApp Web). |
| demais cards | `Card` → `Secao`; ações e regras preservadas. |

Estados (traduzidos do read model): Conectado · Conectado · ação necessária · Reconexão necessária · Não conectado ·
Configuração pendente · Conectando… · Não foi possível verificar · Indisponível no momento · Não incluída no plano ·
Em breve. Cor nunca é o único sinal (o selo sempre leva texto).

Regras de honestidade:

- **Ink**: credencial salva ≠ funcionando (só "Testar conexão" prova) → "Credencial cadastrada", nunca "Conectado".
  O recebimento automático é um indicador à parte.
- **WhatsApp com cadastro manual**: "Token cadastrado" (só o Embedded Signup passa pela Meta). Token recusado pela Meta →
  "Reconexão necessária" + alerta (só para o responsável, que é quem pode agir).
- **WhatsApp Web**: o estado vem do app no computador da loja (heartbeat), não do token da Meta.
- **Leitura que falhou** (`error` + `retry`) → "Não foi possível verificar", sem pedir reconexão e sem alerta.
- Opcional desligado, plataforma indisponível e plano sem a integração **não** geram alerta.
- O selo "API conectada" do WhatsApp (que só significava "serviço de envio configurado no ambiente") saiu da UI; se o
  serviço não existe, aparece um aviso na aba Canal de envio.

### Recebimento automático de pedidos (webhook da Ink) — tratamento

O código trata a ausência do webhook como **adiada de propósito, não como falha** (contrato antigo, mantido:
`integration-read-model.js`, `ink-webhook-guia.test.js`). Por isso ele **não** entrou no alerta do topo: mostrei como
indicador secundário na linha ("Recebimento automático não ativado") e, na aba Pedidos, um aviso informativo com o botão
**Ativar recebimento automático** (só responsável) que abre o guia. O guia mantém as informações estritamente necessárias:
gerar a URL (aparece uma única vez), o que cadastrar no painel da Reserva Ink, os 11 eventos (recolhidos), o segredo
(cifrado, só os 4 últimos caracteres voltam) e como confirmar. Se a decisão de produto for tratar como "ação
necessária" para lojas novas, é uma linha em `estadoIntegracao.ts`.

Ações que já existiam e foram preservadas: trocar/testar credencial Ink, importar histórico de pedidos, sincronizar
catálogo (busca e análises) com renovação automática/intervalo/cancelamento, escolha Meta × WhatsApp Web, token do app,
limites diários, cadastro manual e Embedded Signup, Meta/Google Ads (escolher/trocar conta, vincular à loja, sincronizar,
desconectar), GA4, OpenAI (salvar/testar/remover). Acrescentei confirmação (dialog) em **Remover credencial da Ink** e
**Remover chave OpenAI**, que removiam sem confirmar.

## Segurança

- Preservados: gravação de eventos (`webhook_eventos`), rotas de entrega (`/api/webhooks/ink/...`), jobs, criptografia
  de segredos, RBAC/entitlements. Nenhum worker, tabela, log estruturado ou pipeline de pedidos foi tocado.
- `GET /api/admin/webhook-log` deixou de devolver `headers` e `body` (payload cru com dados pessoais dos clientes e a
  assinatura da entrega). Só metadados (evento, origem, verificado, horário). Consumidores (Automações, Templates) usam só
  o nome do evento. O corpo/headers seguem gravados; a plataforma (`apps/platform-admin`) já tem sua própria leitura
  de metadados de webhooks — acesso técnico preservado. Teste `fase3-server-ab` ajustado para conferir por nome do
  evento e que corpo/headers não saem.
- Sem novos segredos na UI: campos são `type="password"`, limpos após salvar; nenhuma captura mostra valores.
- Tenant: página remontada por organização; troca de organização recarrega a aplicação.

## Qualidade (resultados reais)

- `npx tsc -b --noEmit`: sem erros. `vite build` (para pasta temporária): OK.
- Não há ESLint no projeto.
- Novos testes: `test/invariants/integracoes-resumo-front.test.js` (14) e `test/invariants/navegacao-painel.test.js` (11).
- Testes existentes atualizados porque o comportamento pretendido mudou (copy/estrutura, não regra): `ink-webhook-guia`,
  `integracoes-estado-front`, `store-escopo-front`, `fase3-server-ab`.
- Rodada focada com Postgres descartável (container Docker de teste, sem dados reais): 121/121 passaram
  (`fase3-server-ab`, `auth-server`, `integracoes-read-model`, `site-fora`, `fase4-server-integrations`,
  `r19-entitlement-seed` e os testes de front).
- Suíte completa (`npm test`): ver seção final na resposta da rodada / `Pendências`.

## Aceite visual

API **falsa** local (fixtures fictícias, sem credenciais nem dados reais) + Vite; navegador real. Capturas em
`docs/features/evidence/redesign-integracoes-navegacao/`:

1. `01-visao-geral-dropdown-loja-desktop.jpg` — Visão geral com sidebar reorganizada e dropdown aberto.
2. `02-integracoes-recolhidas-alerta-desktop.jpg` — Integrações recolhidas com alerta acionável (cenário fictício: WhatsApp com token recusado e GA4 sem propriedade).
3. `03-reserva-ink-conexao-desktop.jpg` / `04-reserva-ink-pedidos-desktop.jpg` — Reserva Ink expandida.
4. `05-whatsapp-reconexao-necessaria-desktop.jpg` — WhatsApp em "Reconexão necessária".
5. `06-mobile-integracoes-lista-e-ink-390.jpg` / `07-mobile-drawer-sidebar-390.jpg` — 390px (iframe de 390px; a janela do navegador de automação não reduz o viewport).

Também verificado por script no navegador: um card aberto por vez, deep link com foco, Esc fecha o dropdown
(`data-state=closed`), navegação por teclado até "Configurações", cenários membro (sem alerta de WhatsApp) / WhatsApp Web
offline / tudo saudável (sem alerta).

## Pendências reais

- Não validado contra backend/credenciais reais: OAuth Meta/Google, Embedded Signup (indisponível na plataforma em
  homologação), teste de conexão da Ink/OpenAI e o fluxo completo de ativação do webhook (dependem de contas externas).
- Decisão de produto: promover "recebimento automático não ativado" a alerta do topo? (hoje é informativo, alinhado ao
  contrato de que webhook adiado não é falha.)
- Sidebar recolhível e grupos colapsáveis não existem no shell; não foram criados.
