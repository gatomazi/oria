# Plano — Envio de WhatsApp via WhatsApp Web (alternativa à API da Meta)

## Contexto

Hoje todo envio de WhatsApp do painel passa pelo `whatsapp-webhook-go` (Meta Cloud API, cobrado
por mensagem). São 4 pontos de envio no `server.js`:

| Ponto | Função | Como envia hoje |
|---|---|---|
| Automação de pedido | `enviarMensagemDePedido` (`server.js:8982`) | `modoEnvio` → `/send/template` ou `/queue/add` |
| Carrinho abandonado | `enviarCarrinhoAbandonado` (`server.js:9128`) | idem |
| Lembrete de Pix | `enviarLembretePix` (`server.js:9227`) | idem |
| Campanhas | `processarLoteCampanha` (`server.js:9852`) | sempre `/send/template` |

(+ envio de teste de template em `server.js:10585`, que continua sempre via Meta.)

O cliente do painel (futuro SaaS) pode não querer pagar a API. O projeto antigo
`extrator-pedidos-web/main.py` já enviava de forma automática pelo WhatsApp Web com Selenium
conectado a um Chrome em modo debug (`enviar_whatsapp` / `_clicar_enviar`).

O servidor roda no Railway (processo remoto), então **não tem como abrir o WhatsApp Web**: quem executa o envio
precisa estar na máquina do usuário.

## Objetivo

Permitir escolher, na tela de Integrações, entre **API da Meta** e **WhatsApp Web**. No modo Web:

1. Todo envio vira um item numa fila no Postgres do painel (`whatsapp_web_outbox`), com o texto
   já montado.
2. Um **agente local** (Python + Selenium, mesma mecânica do `main.py`) consome a fila
   automaticamente, envia pelo WhatsApp Web e reporta o resultado.
3. O painel mostra a fila (pendentes, enviados, falhas) e permite cancelar e reenviar.

A fila e o contrato HTTP do agente são desenhados para que uma **extensão Chrome** substitua o
agente Python depois, sem mudar o servidor.

## Decisões

Do usuário (2026-09-12):
- Começar direto pelo WhatsApp Web **automático**, igual ao projeto antigo (sem modo assistido).
- Extensão Chrome fica como evolução futura.

- Volume diário visível como no InkPilot: faixas 0–50 seguro, 51–200 atenção, 201–500 risco,
  limite recomendado de 100/dia. Na API da Meta esse medidor não se aplica (o limite lá é tier
  da conta + saldo).
- **Campanhas entram no modo Web**, mas só saem enquanto o dia está abaixo do limite
  recomendado; pedido, Pix e carrinho continuam até o teto diário.

Defaults assumidos:
- **Mídia no cabeçalho** (IMAGE/VIDEO/DOCUMENT) fica fora da V1: envia só o texto e marca o item
  com `midia_ignorada = true`. V1.1 anexa a imagem.
- **Botões**: botão de URL vira linha de texto (`Texto do botão: https://...`); resposta rápida
  é descartada.
- Nenhuma mudança no `whatsapp-webhook-go`.

## Arquitetura

```
evento (webhook Ink / job de carrinho / job de Pix / lote de campanha)
        │
        ▼
despacharWhatsapp({ origem, referencia, loja, to, template, components, texto, ... })
        │
        ├─ provider = meta_api     → whatsappRequest('/send/template' | '/queue/add')  (como hoje)
        │
        └─ provider = whatsapp_web → INSERT whatsapp_web_outbox (texto renderizado)
                                            ▲
                     POST /api/whatsapp-web-agente/claim      (reserva 1 item, lease)
                     POST /api/whatsapp-web-agente/:id/resultado
                     POST /api/whatsapp-web-agente/heartbeat
                                            │  Authorization: Bearer <token do agente>
                                            │
                     scripts/whatsapp-web-agente/agente.py (máquina do usuário)
                       Chrome debug :9225 → web.whatsapp.com/send?phone=…&text=…
                       → espera o campo → clica enviar → confirma → reporta
```

## Arquivos

| Arquivo | Ação | Descrição |
|---|---|---|
| `server.js` (DDL de startup) | alterar | Tabela `whatsapp_web_outbox` + índices |
| `server.js` | alterar | Config `whatsapp-provider` (`lerConfigPostgres`/`salvarConfigPostgres`) |
| `server.js` | alterar | `despacharWhatsapp()`, ponto único que substitui o `if modoEnvio` repetido nas 3 funções de automação |
| `server.js` | alterar | `renderizarTextoWhatsappWeb()`: reaproveita `renderizarMensagemTemplate` + botão de URL |
| `server.js` | alterar | `processarLoteCampanha`: no modo Web enfileira na outbox em vez de `/send/template` |
| `server.js` | alterar | `recuperarDestinatariosTravados`: ignorar destinatário que tem item vivo na outbox |
| `server.js` | alterar | Endpoints do agente: `claim`, `resultado`, `heartbeat` |
| `server.js` | alterar | Endpoints admin: provider GET/PUT, fila (listar/cancelar/reenviar/aprovar), gerar token do agente |
| `server.js` | alterar | `/api/admin/integrations` devolve `provider` + status do agente |
| `admin/src/api/integracoes.ts` | alterar | Tipos de provider e status do agente |
| `admin/src/api/whatsappWeb.ts` | criar | Cliente de config, resumo e fila |
| `admin/src/components/VolumeWhatsappWebCard.tsx` | criar | Medidor de volume diário (faixas + limite recomendado) |
| `admin/src/pages/integracoes/WhatsappIntegracaoCard.tsx` | criar | Card WhatsApp de Integrações |
| `admin/src/state/whatsappProvider.ts` | criar | Hook do provider para rótulos |
| `src/whatsapp-web.css` | criar | Estilos do medidor, card e fila |
| `admin/src/pages/integracoes/IntegracoesPage.tsx` | alterar | Card WhatsApp: seletor API / Web, status do agente, gerar token |
| `admin/src/pages/whatsapp-web-fila/FilaWhatsappWebPage.tsx` | criar | Fila com filtros por status/origem, cancelar, reenviar, aprovar |
| `admin/src/App.tsx` + `admin/src/shell/nav.ts` | alterar | Rota `/admin/whatsapp/fila` e item de menu |
| `admin/src/pages/automacoes/AutomacoesPage.tsx` | alterar | Texto do `modoEnvio` conforme o provider |
| `admin/src/pages/recuperacao/AcoesRecuperacao.tsx` | alterar | "Enviar via Meta" → "Enviar pelo WhatsApp Web" no modo Web |
| `scripts/whatsapp-web-agente/agente.py` | criar | Loop do agente (porte de `main.py`) |
| `scripts/whatsapp-web-agente/requirements.txt` | criar | `selenium`, `requests` |
| `scripts/whatsapp-web-agente/iniciar_chrome.sh` | criar | Chrome com `--remote-debugging-port` e perfil dedicado |
| `scripts/whatsapp-web-agente/README.md` | criar | Instalação e uso |

## Detalhes técnicos

### Tabela `whatsapp_web_outbox`

```sql
CREATE TABLE IF NOT EXISTS whatsapp_web_outbox (
  id              UUID PRIMARY KEY,       -- crypto.randomUUID() no Node
  origem          TEXT NOT NULL,          -- pedido | carrinho | pix | campanha | recuperacao
  referencia      TEXT NOT NULL,          -- id do pedido / chave do carrinho / id do campaign_recipient
  loja            TEXT,
  evento          TEXT,                   -- payment.approved, cart.abandoned...
  telefone        TEXT NOT NULL,
  nome            TEXT,
  template        TEXT,
  texto           TEXT NOT NULL,
  midia_ignorada  BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL,          -- ver estados abaixo
  dedupe_key      TEXT NOT NULL,
  tentativas      INTEGER NOT NULL DEFAULT 0,
  claimed_at      TIMESTAMPTZ,
  lease_ate       TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  failure_code    TEXT,
  failure_message TEXT,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_web_outbox_status ON whatsapp_web_outbox (status, criado_em);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wa_web_outbox_dedupe
  ON whatsapp_web_outbox (dedupe_key)
  WHERE status IN ('aguardando_aprovacao', 'pending', 'claimed', 'sent', 'desconhecido');
```

UUID como id (não sequencial), já que o id trafega até o agente.

### Estados

```
aguardando_aprovacao ──aprovar──▶ pending ──claim──▶ claimed ──resultado──▶ sent
        │                            ▲                  │                    failed
        └──────cancelar──────────────┼──────────────────┼──▶ cancelado
                                     └────reenviar──────┘
                                     claimed com lease vencido ──▶ desconhecido
```

- `modoEnvio = manual` → nasce `aguardando_aprovacao`; `automatico` → nasce `pending`. Reaproveita o
  switch que já existe em Automações, só muda o destino.
- `desconhecido`: agente morreu no meio. **Não** volta para `pending` sozinho, porque a mensagem
  pode ter saído. Mesma lógica de `recuperarDestinatariosTravados`. O admin decide se reenvia.

### Dedupe

`dedupe_key = origem:referencia:template`, equivalente ao `dedupKey` do `queue.go`. O índice
único parcial impede dois itens vivos iguais e permite reenviar após falha ou cancelamento.
`INSERT ... ON CONFLICT DO NOTHING`.

### `despacharWhatsapp`

Substitui o bloco repetido:

```js
if (modoEnvio === 'automatico') await whatsappRequest('POST', '/send/template', payload);
else await whatsappRequest('POST', '/queue/add', { ... });
```

por uma chamada única que lê o provider e decide. No modo Web precisa do `templateMeta` para
renderizar o texto. Usar o `/templates/list` com cache em memória curto (60s), já que
cada automação chamaria o Go para isso.

Enquanto o cliente tiver templates da Meta, o texto sai deles (`renderizarMensagemTemplate`,
`server.js:~8445`). Para cliente SaaS sem conta Meta vão ser necessários **templates de texto
próprios do painel**. Fica fora da V1 e está registrado como pendência.

### Claim (endpoint do agente)

```sql
UPDATE whatsapp_web_outbox
   SET status = 'claimed', claimed_at = now(), lease_ate = now() + interval '5 minutes',
       tentativas = tentativas + 1, atualizado_em = now()
 WHERE id IN (
   SELECT id FROM whatsapp_web_outbox
    WHERE status = 'pending'
    ORDER BY (evento = 'payment.approved') DESC, criado_em ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
 )
RETURNING id, telefone, texto, nome, origem;
```

Antes do claim, o servidor aplica:
- **Janela de envio** (`dentroDaJanelaDeEnvio`), exceto `payment.approved`, porque o agente pode
  ficar offline e voltar de madrugada.
- **Teto diário** (`count(*) WHERE status = 'sent' AND sent_at >= início do dia em Brasília`),
  configurável em Integrações (padrão 200, máximo 500). Atingido → nada sai.
- **Limite recomendado** (padrão 100): acima dele, campanhas ficam na fila (motivo
  `limite_recomendado`); transacionais seguem até o teto.
- **Provider ativo**: se o admin voltou para API, o claim devolve vazio.

O mesmo tick marca `claimed` com `lease_ate < now()` como `desconhecido`.

### Autenticação do agente

- O admin gera o token em Integrações. Ele aparece **uma vez** e só o hash SHA-256 vai para o
  `app_config`. Gerar de novo invalida o anterior.
- O agente envia `Authorization: Bearer <token>` (header padrão, sem header customizado).
- Comparação com `crypto.timingSafeEqual` sobre os hashes.
- O token só vale para `/api/whatsapp-web-agente/*`. Nunca dá acesso a rota admin.
- O telefone e o texto não aparecem em log. Logar só `id`, `origem` e `status`.
- Futuro SaaS: token por organização (`integrations` do doc de productização).

### Campanhas

- `processarLoteCampanha` no modo Web: em vez de `/send/template`, insere na outbox com
  `origem='campanha'`, `referencia=campaign_recipients.id`, e deixa o destinatário em `queued`.
- `resultado` do agente com `origem='campanha'` atualiza `campaign_recipients` (`sent`/`failed`).
  Sem `delivered`/`read`: não há webhook de status no WhatsApp Web.
- **Atenção:** `recuperarDestinatariosTravados` marca como falha todo `queued` com mais de
  15 min. No modo Web o item pode esperar horas pelo agente. Ajustar para ignorar destinatários
  com item vivo na outbox (`pending`/`claimed`/`aguardando_aprovacao`).

### Agente (`scripts/whatsapp-web-agente/agente.py`)

Configuração via env: `PAINEL_URL`, `WHATSAPP_WEB_AGENTE_TOKEN`, `CHROME_DEBUG_PORT` (padrão 9222).

Loop:

1. `heartbeat` a cada ciclo: versão do agente e estado do WhatsApp (`logado` ou
   `aguardando_qr`, detectado pelo canvas do QR code). Em `aguardando_qr`, não faz claim.
2. `claim`. Vazio: dorme 30s.
3. `driver.get("https://web.whatsapp.com/send?phone=…&text=…")`, igual ao `main.py:518`.
4. Espera até 30s por um de:
   - campo `//div[@contenteditable='true'][@data-tab='10']` → segue;
   - diálogo de número inválido (`div[role='dialog']`) → `failed / numero_invalido`;
   - timeout → `failed / timeout`.
5. Clica enviar com os mesmos seletores de fallback de `_clicar_enviar` (`main.py:463`).
6. Confirma: campo de texto vazio e novo balão de mensagem enviada no fim da conversa. Se não
   confirmar, `failed / nao_confirmado`.
7. `resultado`.
8. Ritmo: espera aleatória entre 8 e 20s; pausa de 2 a 4 min a cada 20 envios.

Seletores num bloco único no topo do arquivo, para facilitar ajuste quando o WhatsApp mudar o
HTML. Na extensão eles viram JSON remoto.

Mensagem com quebra de linha: o `text=` da URL preserva `\n` (o `main.py` já envia assim).

### Integrações (UI)

Card WhatsApp:
- Seletor **API da Meta** / **WhatsApp Web**.
- Modo Web mostra: agente online/offline (último heartbeat < 90s), estado do WhatsApp
  (logado / aguardando QR), versão do agente, pendentes na fila, botão "Gerar token do agente",
  teto diário.
- Aviso fixo no modo Web: automação do WhatsApp Web não é oficial e pode levar ao bloqueio do
  número; o computador precisa ficar ligado com o Chrome do agente aberto.
- Trocar de provider com itens pendentes: confirmar e oferecer cancelar a fila.

## Test Impact

- O repositório não tem suíte de testes automatizados (`package.json` sem script de teste).
- Validação por `npm --prefix admin run typecheck`, `npm run build` e roteiro manual abaixo.
- Contrato existente preservado: com `provider = meta_api` (padrão), os 4 pontos de envio
  continuam fazendo exatamente as mesmas chamadas ao `whatsapp-webhook-go`.

## Verificação

1. `provider = meta_api`: disparar automação de pedido e conferir item no dashboard do Go (sem
   regressão).
2. Trocar para `whatsapp_web` com `modoEnvio = manual`: evento cria item `aguardando_aprovacao`,
   aprovar → `pending`.
3. Rodar o agente apontando para o **próprio número** como destinatário: `pending → claimed → sent`,
   mensagem chega com quebras de linha e link do botão.
4. Número inválido → `failed / numero_invalido`.
5. Matar o agente logo após o claim → após 5 min o item vira `desconhecido`; reenviar funciona.
6. Mesmo evento duas vezes → um item só (dedupe).
7. Fora da janela: claim vazio; `payment.approved` sai mesmo assim.
8. Teto diário atingido → claim vazio.
9. Campanha de teste com 3 destinatários → `campaign_recipients` fica `sent` e a campanha
   completa; nenhum destinatário marcado como `interrompido` enquanto espera o agente.
10. Token antigo após regenerar → 401.
11. WhatsApp deslogado → heartbeat `aguardando_qr`, card mostra o estado, nenhum claim.

## Evolução: extensão Chrome

A extensão substitui só o `agente.py`: service worker chama os mesmos `claim`/`resultado`/
`heartbeat`, content script faz o passo 3-6 no DOM sem recarregar a página. Servidor, tabela e
telas não mudam.

## Pendências

- Templates de texto próprios do painel para clientes sem conta Meta.
- Envio de mídia de cabeçalho (V1.1).
- Distribuição do agente para clientes SaaS (Python local só é viável para uso interno; para
  cliente final a resposta é a extensão).

## Status da implementação (2026-09-12)

Implementado: tabela + endpoints (agente e admin), `despacharWhatsapp` nas 3 automações, campanhas
no modo Web, ajuste de `recuperarDestinatariosTravados`, card de Integrações (provider, agente,
token, limites), medidor de volume, página Fila de envio, textos de Automações/Recuperação e o
agente Python.

Validado localmente (Postgres embutido): roteiro de verificação itens 2, 4-8, 10 via API, dedupe,
ordem de prioridade do claim, lease → desconhecido, vínculo com `campaign_recipients`, renderização
de texto (header, variáveis, botões, rodapé, mídia ignorada), `typecheck` e `build` do admin.

Não validado: envio real pelo agente no WhatsApp Web (`--testar`), fluxo com o
whatsapp-webhook-go real (templates da Meta), revisão visual das telas.

## Etapa 2 — Mensagens do WhatsApp Web (2026-09-12)

Decisões do usuário:
- Executor ainda em aberto (usuário investigando como o InkPilot e a versão antiga faziam). Extensão
  descartada. O agente Python (`scripts/whatsapp-web-agente/`) não é o caminho do cliente.
- Templates separados por modo: API mantém Templates (cabeçalho, rodapé, botões, aprovação);
  WhatsApp Web ganha **Mensagens** (só texto). Sem imagem e sem variações de texto por enquanto.

Implementado:
- Tabela `whatsapp_web_mensagens` (id UUID, nome único sem diferenciar maiúsculas, tipo
  `comum | pedido | carrinho`, corpo até 4096 caracteres).
- CRUD `GET/POST /api/admin/whatsapp-web/mensagens`, `GET/PUT/DELETE /api/admin/whatsapp-web/mensagens/:id`.
  Valida variáveis por tipo (`comum` só aceita cliente/loja/personalizadas), bloqueia excluir
  mensagem em uso e trocar o tipo quando conflita com o evento vinculado.
- Vínculo por modo no mesmo evento: `template` (API) e `mensagemWeb` (Web), cadência compartilhada.
  `PUT /api/admin/automacao-eventos/:loja/:evento/web`; `DELETE ...?modo=api|web` remove só o
  vínculo daquele modo. Salvar o vínculo da API preserva o da Web e excluir um template da Meta
  preserva o vínculo da Web.
- `vinculoConfigurado(eventoConfig, provider)` substitui as checagens de `.template` nos jobs
  (pedido, fila de janela, carrinho, Pix, rede de segurança), na Recuperação e na visão geral.
- `despacharWhatsapp` no modo Web renderiza a mensagem vinculada (`{{chave}}` → valor; sem valor
  vira vazio) e **não depende mais do whatsapp-webhook-go**. No modo API monta o payload da Meta
  só quando vai usar.
- Painel: telas Mensagens (lista) e editor (formatação *negrito* _itálico_ ~riscado~ ```mono```,
  inserir variável no cursor, contador, prévia com formatação e links). Menu mostra Templates ou
  Mensagens e Fila de envio conforme o modo, atualizando na hora ao trocar em Integrações.
  Automações no modo Web vincula evento → mensagem (lista só compatíveis). Recuperação copia a
  mensagem do modo ativo. Aviso em Templates (modo Web) e Mensagens (modo API).

Comportamento importante: ao trocar para WhatsApp Web, evento que só tem template da API **não
envia** até ganhar uma mensagem vinculada (e vice-versa).

Pendente (na época): Nova campanha no modo Web — resolvido na etapa 3.

## Etapa 3 — Campanhas no modo WhatsApp Web (2026-09-12)

- Novo tipo de mensagem **Campanha**, com as variáveis que o disparo resolve por cliente:
  `cliente.primeiro_nome`, `cliente.nome`, `cliente.email`, `cliente.telefone`,
  `cliente.quantidade_pedidos`, `cliente.total_gasto`, `cliente.ticket_medio`,
  `cliente.ultima_compra`, `loja.nome` e personalizadas. Não pode ser vinculada a automações.
  Campanha aceita mensagem do tipo Campanha ou Comum.
- `campaigns.mensagem_web_id` (escolha) e `campaigns.mensagem_web_corpo` (texto congelado no início).
  Editar a mensagem depois não muda campanha já iniciada; mensagem usada por campanha em rascunho ou
  agendada não pode ser excluída.
- `iniciarDisparoCampanha` decide o canal pelo provider no momento do início (vale pro "Enviar
  agora" e pro agendamento): Web exige mensagem e grava `resolved_variables` nomeadas; API exige
  template (mapeamento posicional como antes).
- `processarLoteCampanha` com texto congelado não consulta a Meta: renderiza e enfileira direto.
- Wizard: no modo Web são 4 etapas (Campanha, Audiência, Mensagem, Revisão), sem mapeamento, mídia
  nem envio de teste. A revisão estima quantos dias o envio leva pelo limite recomendado. O
  mapeamento da API salvo na campanha é preservado.
- Lista e detalhe da campanha mostram a mensagem quando for Web.

Validado localmente: variável inválida pro tipo, mensagem de campanha recusada em automação,
exclusão bloqueada por campanha em rascunho, snapshot com variáveis por cliente, texto congelado
mesmo após editar a mensagem, fila recebendo o texto final, campanha em `sending`, e campanha só
com mensagem Web recusada ao iniciar no modo API. Não validado: telas no navegador.

Pendente: executor do envio (depende da investigação do usuário).

## Etapa 4 — Variações de mensagem (2026-09-12)

- `whatsapp_web_mensagens.variacoes` (JSONB, até 4 além do corpo = 5 versões). Validação de
  variáveis e tamanho vale pra todas; nenhuma versão vazia.
- `sortearVersaoMensagemWeb` (crypto.randomInt) escolhe a versão a cada envio de automação e a cada
  destinatário de campanha. Campanha congela as variações junto com o corpo
  (`campaigns.mensagem_web_variacoes`). A fila grava `variacao` (1 = texto principal).
- Editor com abas "Versão 1..5", adicionar/remover e prévia da versão ativa; lista de mensagens
  mostra quantas versões; fila mostra a versão enviada; Nova campanha sugere criar versões.
- Recuperação ("Copiar mensagem") usa sempre a versão 1.

Decisões do usuário para o executor: app desktop em **Electron** (feito com IA), enviando pelo
**WhatsApp Desktop e pela aba do WhatsApp Web** no navegador normal.

## Etapa 5 — App desktop Electron (2026-09-12)

Substitui o agente Python (removido). Pasta `desktop/`, instruções em `desktop/README.md`.

- Envia pelo **WhatsApp Desktop** (`whatsapp://send`) ou pelo **WhatsApp Web** no navegador padrão
  (`https://web.whatsapp.com/send`, fechando a aba depois).
- Sem módulos nativos: tecla e app em primeiro plano via `osascript`/System Events (macOS) e
  PowerShell/`WScript.Shell`/`user32` (Windows); tempo ocioso via `powerMonitor`.
- Proteções: só aperta Enter com o WhatsApp/navegador em primeiro plano e com o computador parado;
  não reserva item da fila enquanto o computador está em uso; abre sempre pausado; pausa ao
  suspender/bloquear; token via `safeStorage`; janela com `contextIsolation` + `sandbox`, CSP e
  navegação bloqueada; `openExternal` só aceita os 2 formatos de link montados pelo app.
- Motor (`src/envio.js`) sem Electron, com 15 testes (`npm test`) e teste de integração contra o
  servidor local com automação simulada.
- Servidor: heartbeat recebe `executor` (desktop | navegador), `plataforma` e `pausado`; estado
  `nao_verificavel`; resultado aceita `confirmado` (grava `envio_confirmado`); novos códigos de
  falha `interrompido` e `app_nao_abriu`.
- Painel: card de Integrações fala do app (online/pausado/enviando, envia por, sistema); fila mostra
  "Enviada (sem confirmação)" e as novas falhas.

Não validado: envio real num Mac/Windows com WhatsApp logado, geração dos instaladores
(`npm run dist:mac` / `dist:win`), nome do processo do WhatsApp Desktop no Windows.

## Etapa 6 — App offline e envio pelo celular (2026-09-13)

Decisão: painel continua web (gestão de qualquer lugar, automações 24h no servidor); o app desktop
é só o executor. Pra quando o computador não está disponível:

- **Aviso global de app offline** (modo WhatsApp Web): no topo de todas as telas do painel quando há
  mensagem na fila e o app está offline, pausado ou nunca conectou ("offline há 2 h — 14 mensagens
  paradas"), com atalho pra enviar pelo celular. Dispensar vale até a quantidade mudar.
  `GET /whatsapp-web/resumo` passou a trazer o status do app.
- **Enviar pelo celular** (aba da Fila, `?modo=celular`): cartões com a mensagem formatada, na mesma
  prioridade do app. "Enviar pelo WhatsApp" reserva o item (`POST /fila/:id/assumir`, lease de
  15 min, respeita o teto diário) e mostra "Abrir WhatsApp" (`wa.me` com o texto); depois
  "Enviei" / "Não enviei" (`POST /fila/:id/concluir`). Dois toques de propósito: abrir o link após
  um `await` perde o gesto do usuário e o iOS bloqueia.
- Reserva é a mesma do app (`claimed`), com `executor = 'app' | 'celular'` — nenhuma mensagem é
  pega pelos dois. "Enviei" grava `envio_confirmado = true` e atualiza a campanha; "Não enviei"
  volta pro status anterior (`status_anterior`), então item que aguardava aprovação não volta
  liberado.
- Endpoint da fila aceita vários status separados por vírgula.

App desktop: permissão `com.apple.security.automation.apple-events` (hardened runtime + assinatura
ad-hoc) pra controlar o System Events no app instalado; tela de permissão explica que no
`npm start` quem aparece em Acessibilidade é o programa do terminal.

Validado com envio real: modo WhatsApp Web no navegador (Mac, rodando pelo terminal).
