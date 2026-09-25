# Fechamento do redesign de Integrações e Navegação

Branch `feature/redesign-integracoes-navegacao`, sobre o commit local `abb2d6a` (redesign). **Nada foi enviado**: sem push, PR, merge, deploy, migration,
alteração em produção ou dado real. Só dados sintéticos (banco descartável, tokens fabricados, providers simulados). O Worker `use-origens-workers` não foi tocado.

## 1. Base da branch e relação com `main`

| Fato | Valor |
|---|---|
| Base | `6829152` (merge `main` → `feature/clientes-rfm`, já em `origin/main`) |
| Commits próprios | `abb2d6a` (redesign) + o commit desta rodada de fechamento |
| Herdados não mesclados | **nenhum**: `6829152` é ancestral de `origin/main`; a branch não carrega RFM/rodadas paralelas pendentes |
| `origin/main` no fechamento | `d693e40` (PRs #33, #34, #35: desempenho de produtos, RFM visual, reconciliação paginada) |
| Arquivos alterados pela `main` desde a base × pela branch | 29 × (43 + fechamento) — **interseção vazia** |
| Merge de teste (`git merge-tree`) | limpo, sem conflito |
| Migrations | **nenhuma** na branch |

Sem cherry-pick: a integração é um merge/PR normal (plano em §8).

`Webhooks e logs` saiu **só da navegação do lojista**: os eventos continuam sendo recebidos, verificados e gravados em `webhook_eventos` (com headers e corpo, para
diagnóstico da plataforma). `GET /api/admin/webhook-log` deixou de devolver `headers`/`body` — os consumidores (`api/templates.ts`, `api/automacoes.ts`,
`api/eventos.ts`) só leem `eventName`, `verificado`, `loja`, `metodoAuth`, `inkOrderId` e `recebidoEm`; os testes `fase3-server-ab` e `auth-server` cobrem a rota.

## 2. Cabeçalho

O segundo controle deixou de repetir o nome da loja (que já está no seletor à esquerda). Agora é **avatar com iniciais da conta + chevron**, nome acessível
`Abrir menu da conta e da loja` (também `title` no desktop, sem texto ao lado no mobile). O menu aberto continua com organização atual, plano quando carregado,
Configurações, Integrações, Campos personalizados e Sair, `aria-current`, Esc/clique externo e devolução de foco ao gatilho. Nenhum fluxo de autenticação ou
de troca de loja foi alterado. O botão do drawer passou a se chamar `Abrir menu de navegação` (antes "Abrir menu", prefixo do nome do menu da conta).

## 3. Sidebar compactável (sem backend)

- **Desktop ≥ 1024 px:** botão `Recolher menu lateral` / `Expandir menu lateral` (`aria-expanded`, `aria-controls="ad-sidebar"`) no rodapé da sidebar. Recolhida = trilho de
  64 px só com ícones, **todas as rotas continuam alcançáveis**, tooltip com o nome (mouse e teclado), barra lateral no item ativo; sem flyout (o ícone + tooltip não ficou ambíguo).
- **Grupos** recolhíveis (`aria-expanded` + `aria-controls`); todos abertos por padrão. Um grupo fechado mostra só o item da página atual, para não perder a orientação.
- **Persistência local:** `localStorage`, chave versionada `oria.shell.nav.v1` (`{colapsada, gruposFechados}`), leitura tolerante (JSON inválido/forma errada → padrão), limites de tamanho,
  falha de storage ignorada. Nenhuma coluna, tabela ou API. Módulo puro `src/shell/navPrefs.ts`.
- **Mobile/tablet < 1024 px:** drawer inalterado (foco, `inert`, retorno de foco); a preferência "reduzida" nunca é aplicada por cima do drawer (o drawer abre completo, com rótulos).
- Mapa de rotas e gating dos itens **inalterados** (teste de contrato).

### Defeito real achado e corrigido (vinha do commit anterior)
Ao fechar o drawer com Esc, o foco caía no `<body>` (o `menuBtn.focus()` rodava enquanto o conteúdo ainda estava `inert`). Agora o foco é devolvido depois que o
drawer fecha (efeito pós-fechamento). Coberto pelo QA de shell e por teste de contrato.

## 4. Homologação funcional de Integrações

Ambiente: servidor real (`server.js`, role `oria_app` sem BYPASSRLS, Postgres descartável) + `test/helpers/provider-mock.cjs` + serviço de WhatsApp falso local;
apps OAuth de plataforma fictícios; duas Organizations e um membro (`member`) sintéticos. `scripts/qa-integracoes-homologacao.mjs` (Playwright, 150 verificações no último run).
Nenhuma resposta `/api/` devolveu token, chave ou segredo digitado (verificado em todas as respostas do navegador).

| Integração | Situação | O que foi comprovado | Bloqueado / observação |
|---|---|---|---|
| **Reserva Ink** | validado | estado lido do servidor ("Não conectado" → "Credencial cadastrada", **nunca "Conectado"** só por cadastrar); campo limpo e segredo não ecoado; testar conexão devolve o resultado do provedor; webhook **opcional** (aviso informativo, fora de "Atenção necessária", sem `role=alert`); guia com foco, URL mostrada uma vez, "Gerar nova URL" com confirmação, segredo salvo → "Ativo"; importar histórico e sincronizar catálogo presentes, com confirmação, e iniciam sem erro; remover exige confirmação (cancelar mantém); membro vê o estado e testa a conexão, sem campos, e o servidor recusa gravar/remover (403) | **bloqueado**: recusa real do token pela Ink e entrega real de webhook (sem conta de teste; o mock aceita qualquer token bem formado) |
| **WhatsApp** | validado | deep link `?provedor=whatsapp&aba=conexao` abre e foca; abas Conexão / Canal de envio; API da Meta × WhatsApp Web (trocar pede confirmação, Esc cancela); Embedded Signup **escondido** quando a plataforma não o habilita (com explicação, sem botão); cadastro manual acessível e sem eco do token; token recusado: dono vê `role=alert` + "Reconexão necessária" + CTA no topo, **membro não recebe botão de reconectar/cadastrar nem alerta**; testar conexão devolve resultado explícito; nenhum botão/link sem nome ou sem destino | **bloqueado**: Embedded Signup real (janela da Meta) e envio/recebimento reais (sem app da Meta/WABA de teste). "Testar conexão" com o serviço falso devolve `Falhou (SENDER_REF_UNAVAILABLE)` — resultado verdadeiro, não simulação de sucesso |
| **GA4** | validado | sem conexão → "Conectar"; autorizado sem propriedade → "Falta escolher a propriedade" + alerta "Concluir configuração" (não "Conectado"); escolha persiste após recarregar e o resumo vira "Conectado"; **falha de leitura** (500 no status do card e no resumo) mostra erro + "Tentar novamente", sem pedir Conectar/Reconectar; desconectar com confirmação | OAuth real (consentimento Google) bloqueado |
| **Meta Ads** | validado | autorizado sem conta → "Falta escolher a conta"/"Configuração pendente"; lista contas, escolha persiste; **contas por Organization** (Org 1 `act_A001`, Org 2 `act_B001`, sem cruzar) | consentimento real da Meta bloqueado |
| **Google Ads** | validado (parcial) | autorizado sem conta → "Escolha a conta de anúncios"; conta sincronizada da Organization aparece e é escolhida | **bloqueado**: listagem real de contas e sincronização de campanhas (sem developer token/conta de teste; o mock devolve lista vazia — a conta foi semeada no banco descartável) |
| **OpenAI** | validado | salvar mostra só `final xxxx`, campo limpo, chave nunca ecoada; testar chave válida/inválida (401 do mock → "Falhou"); remover com confirmação | chave real bloqueada |
| **Instagram** | validado | "Em breve", sem botão de expandir, sem botão/link de conexão | — |

**Troca de organização com o painel aberto:** a troca recarrega a aplicação (`window.location.reload()`); com a Ink aberta na Org 1 (final `0001`) e a leitura do resumo atrasada 4 s,
a Org 2 mostra apenas o seu (`0002`, "Use Centro", conta Meta B) e nada da Org 1; voltar à Org 1 não deixa nada da Org 2. Fechar o card com a leitura pendente não gera erro nem reabre o card.
O `?provedor=` da URL continua abrindo o mesmo provedor na Org nova — é o deep link, não estado da Org anterior (todo o conteúdo é relido).

### Correções feitas nesta rodada por causa da homologação
1. **Foco após fechar qualquer modal** (`components/ds/Modal.tsx`): o Modal é aberto por estado, sem `Dialog.Trigger`, e o Radix deixava o foco no `<body>` ao fechar
   (Esc/Cancelar/Confirmar) — em todas as telas. Agora guarda quem estava focado ao abrir e devolve o foco a ele se ainda existir. Teste `modal-foco.test.js`.
2. **Botão de confirmar "Excluir" em "Desconectar …"** (GA4, Meta Ads, Google Ads): o `ConfirmDialog` usava o rótulo padrão. Agora diz "Desconectar".

### Defeitos reproduzíveis registrados (pré-existentes, **não** corrigidos: não são regressão desta branch)
- **D-1 · Membro (`member`) desconecta Meta Ads, Google Ads e GA4.** `POST /api/admin/integrations/{meta,google-analytics,google-ads}/disconnect` respondem **200** para um `member`,
  e a tela mostra "Desconectar"/"Trocar conta"/"Escolher propriedade" a ele (a Ink e o WhatsApp exigem `owner`, corretamente: 403). Reprodução: entrar como `member` de uma Org com Meta conectada e chamar o `POST`.
  Decisão de produto/autorização (o `owner` deve ser o único?); a UI só deve esconder o botão junto com o servidor recusar.
- **D-2 · Card "Catálogo para análises de desempenho" aparece para Organization sem `analytics_product_performance`**, e "Sincronizar catálogo agora" termina em
  "Erro HTTP 403 — resposta inesperada do servidor" (`/api/admin/product-analytics/*` é protegido por essa feature em `feature-routes.js`). Já era assim na `main` (o card era incondicional).
  Correção sugerida: esconder/explicar o card sem a feature.

## 5. Mobile real e acessibilidade

`scripts/qa-integracoes-homologacao.mjs` (fase mobile) e `scripts/qa-shell-navegacao.mjs`, com viewport real do Chromium (Playwright, `isMobile` + toque, **sem iframe**) em 390×844 e 360×800
(o shell também em 1440, 1280, 1024 e 768): seletor de loja, menu da conta e menu de navegação sem sobreposição; menu da conta dentro da tela; alerta com dois CTAs (alvos ≥ 32 px, sem corte);
um card aberto por vez; abas da Ink; modal de confirmação dentro da tela, botões ≥ 32 px, foco preso no diálogo e devolvido no Esc; drawer aberto/fechado; rolagem; **sem rolagem horizontal em nenhum estado**;
teclado (Tab, Shift+Tab, Enter, Espaço, Esc, foco em deep link); todo controle visível com nome acessível; axe-core sem violação serious/critical. Capturas com dados sintéticos em
`apps/panel/relatorios-privados/redesign-{shell,integracoes}` (fora do git).

## 6. Testes

**Reconciliação da execução anterior.** O relatório anterior (1593 testes antes do timeout; 34 arquivos reexecutados com 553 aprovados; `negative-controls-fatia-3` isolado com 31 testes em ~667 s;
"40 arquivos cancelados") não trazia a lista de arquivos e os logs dele não estão neste ambiente — então a contagem **não pôde ser reconstruída a partir dele**. Em vez de presumir, foi feita
**uma única execução integral, sem timeout ampliado e com relatório por arquivo (junit)**, sobre o código final desta rodada (container Postgres próprio, `--test-concurrency=1`):

| Execução integral (`test/*.test.js` + `test/invariants/*.test.js`) | Resultado |
|---|---|
| Arquivos no repositório | **154** |
| Arquivos com resultado no junit | **150** diretos + **4** fatias de negative controls (`fatia-1..4`), cujos testes o junit atribui a `negative-controls-nucleo.cjs` |
| Negative controls executados | **124** (= 31 × 4 fatias, exatamente `VIOLACOES` do núcleo), **0 falhas** — a `fatia-3` rodou junto, sem timeout |
| Testes | **2283 · 2283 aprovados · 0 falhas · 0 cancelados · 0 ignorados** (exit 0, 6 753 s com a máquina compartilhada) |

Portanto: **nenhum arquivo ficou cancelado ou sem cobertura** nesta execução; os "seis arquivos potencialmente faltantes" do relatório anterior estão cobertos por ela (a execução cobre todos os 154).
Isto vale para o **estado local**: o CI remoto não foi executado (exige push). Nenhum teste foi enfraquecido e nenhum timeout foi alterado.

Demais verificações (código final):

| Verificação | Resultado |
|---|---|
| `tsc -b --noEmit` · `npm run build` | limpos |
| Contrato do shell (`navegacao-painel`, 20 testes) · `nav-prefs` (9) · `modal-foco` (2) | verdes (dentro da execução integral) |
| `node scripts/check-contracts.mjs` | OK (3 contratos, 2 cópias idênticas) |
| `repo:self-check` | OK (906 arquivos varridos) |
| `ci/suites.mjs verify` | OK (154 arquivos: 79 sem banco em 2 shards, 75 com banco em 4 shards) |
| QA de shell (Playwright, 6 viewports) | 159/159 |
| Homologação de Integrações (Playwright; desktop 1440, mobile 390 e 360) | 150 validadas · 0 falhas · **4 bloqueadas** (credencial/ambiente) |

Testes novos/alterados desta rodada: `test/nav-prefs.test.js` (novo), `test/invariants/modal-foco.test.js` (novo), `test/invariants/navegacao-painel.test.js` (+ contratos do gatilho da conta,
da sidebar recolhível, dos grupos, do tooltip, do CSS só em ≥ 1024 px, do mapa de rotas inalterado, dos nomes acessíveis e do retorno de foco do drawer).

## 7. Riscos

- A preferência local `oria.shell.nav.v1` é por navegador (não por organização): trocar de loja mantém a sidebar como estava. Aceito: é preferência de layout.
- O shell reduzido usa `useMediaQuery(min-width: 1024px)`; entre 768 e 1023 px vale o drawer (comportamento anterior).
- D-1 e D-2 acima seguem abertos.
- CI remoto não foi executado (exige push): local verde ≠ CI verde.

## 8. Plano exato de integração (não executado)

1. `git fetch origin && git merge origin/main` na branch (esperado: sem conflito; interseção de arquivos vazia).
2. Reexecutar após o merge: `tsc -b`, `npm run build`, `node --test test/invariants/navegacao-painel.test.js test/invariants/modal-foco.test.js test/nav-prefs.test.js test/invariants/integracoes-*.test.js test/invariants/ink-webhook-guia.test.js test/invariants/store-escopo-front.test.js`
   e, com banco, `fase3-server-ab`, `auth-server`, `fase4-server-integrations`.
3. Abrir PR contra `main` (conta `gatomazi`); aguardar o CI remoto verde.
4. QA local opcional: `scripts/qa-shell-navegacao.mjs` e `scripts/qa-integracoes-homologacao.mjs` (exigem servidor local com o mock, ver o cabeçalho de cada script).
5. Decidir D-1 e D-2 (podem ir em PR próprio, sem bloquear este).
