# Auditoria de ownership e tenancy — `whatsapp-webhook-go`

**Repositório auditado:** `/Users/gtomazi/projects/whatsapp-webhook-go`
**HEAD:** `bf91ff1` — *feat: accept Meta app id from the panel on media upload*
**Escopo:** 16 arquivos `.go` (3.017 linhas), lidos integralmente, mais `go.mod`, `Dockerfile`,
`.env.example`, `.gitignore` e os três HTML embutidos.
**Natureza:** READ-ONLY. Nenhum arquivo do repositório auditado foi criado, alterado ou apagado.
**Verificações executadas:** `go build ./...` (limpo), `go vet ./...` (limpo), `go test ./...` (ok —
1 pacote, 6 testes, em `pacer_test.go` e `media_upload_test.go`).

---

## 1. Resumo executivo

**O serviço não está pronto para multi-tenant.** A identidade do remetente do WhatsApp
(`phone_number_id`, `access_token`, `WABA ID`, `app_secret`, `app_id`) é lida de variáveis de
ambiente uma única vez no boot (`main.go:52-69`) para uma struct global de processo (`main.go:40`),
e é consumida diretamente dentro de toda operação de envio, sem nunca ser recebida por requisição.

### A pergunta que mais importa: mudança de contrato ou reescrita?

**As duas coisas, em proporções assimétricas — e a divisão é limpa o bastante para ser sequenciada.**

| Metade do serviço | Veredito | Evidência |
|---|---|---|
| **Saída** (`/send/*`, fila, templates, upload) | **Mudança de contrato**, esforço S–M | Todo envio passa por **uma única função**, `metaPost` (`sender.go:21-51`), que lê exatamente dois globais: `cfg.PhoneNumberID` (`sender.go:24`) e `cfg.AccessToken` (`sender.go:36`). São **9 call sites** (`sender.go:63,96,141,192,242,294,326,357` e `queue.go:338`). Dar a essa função um parâmetro de identidade torna todo o caminho de saída escopado por requisição. |
| **Entrada** (webhook da Meta) | **Reescrita**, esforço L | O webhook **não roteia**. `metadata.phone_number_id` é desserializado (`types.go:30-33`) e usado **só em `log.Printf`** (`webhook.go:227`). `entry.ID` (o WABA ID no payload da Meta) é desserializado (`types.go:13`) e **nunca lido**. A validação HMAC usa um único `cfg.AppSecret` de processo (`webhook.go:136-146`). Três comportamentos do caminho de entrada — `NotifyNumber`, `ReplyRedirectMessage`, `ForwardURL` — são config global consumida sem escopo (`webhook.go:41,95,255`). |
| **Persistência** | **Migração de schema**, esforço M | As três tabelas (`events`, `queue_items`, `problem_orders`, `db.go:52-101`) **não têm nenhuma coluna de tenant**. Os seis stores em memória (`store.go:34`, `queue.go:50`, `problems.go:57`, `retry.go:15`, `webhook.go:21`, `sender.go:18`) são globais e nenhum tem chave de tenant. |

**O item que não é incremental** é o contrato com o painel. Hoje o painel **lê** a identidade do
remetente do healthcheck do serviço (`sender.go:443-449`, endpoint registrado **sem autenticação**
em `main.go:87`). Isso é a inversão exata do INV-25: o chamador depende de um valor padrão
configurado dentro do serviço. Esse contrato precisa ser **removido**, não estendido — e remover
implica mudar painel e serviço na mesma janela.

### A decisão em aberto que determina o tamanho de tudo

Há **uma decisão de topologia de deploy que muda a estimativa em uma ordem de grandeza**, e ela não
está registrada em lugar nenhum do repositório (não há manifesto de deploy — `find` por
`*.yml`/`*.yaml`/`*.toml`/`Procfile`/`*.json` na raiz e um nível abaixo não retornou nada):

- **Um processo por Organization** (um container por tenant): o código **já está na forma certa**.
  Variável de ambiente por container *é* identidade por instalação, e a maior parte dos achados 4/5
  abaixo deixa de ser defeito e vira arquitetura. Custo no repositório: ~XS, restando só a remoção
  do contrato de `/health` e a autenticação por tenant. Custo fora do repositório: um container,
  um Postgres (ou um schema) e um app da Meta por assinante.
- **Um processo compartilhado para todos os tenants**: praticamente todos os 26 achados abaixo
  passam a valer, o caminho de entrada precisa ser reescrito, e os seis stores globais precisam ser
  re-chaveados.

Registro isso como **decisão em aberto**, não como recomendação. O que a evidência sustenta é
apenas: *o código como está escrito é compatível com o primeiro modelo e incompatível com o
segundo.*

### O precedente do `appId` (ponto de atenção do último commit)

`bf91ff1` é um **precedente parcial e instrutivo**, não um caso isolado nem o padrão-alvo completo.

- É a **forma certa**: identidade recebida no corpo da requisição, com fallback para env
  (`media_upload.go:34,67-70`).
- Tem **validação de formato fail-closed e testada**: `appIDPattern` (`media_upload.go:39`),
  aplicada em `media_upload.go:75`, com três testes (`media_upload_test.go:18-64`).
- **Não tem validação de ownership**: nada verifica que o chamador tem direito àquele `appId`
  (`media_upload.go:67-78`).
- E o defeito estrutural: **a credencial não viajou junto com a identidade**. O `appId` vem da
  requisição, mas o `access_token` usado com ele continua sendo o global
  (`media_upload.go:102,130`). Identidade recebida e credencial fixa **podem discordar**.

Hoje a exploração é limitada **pela Meta, não por este serviço**: um token que não tem permissão
sobre o `appId` informado faz a Graph API rejeitar. O serviço não é o ponto de enforcement. Isso é
uma constatação, não uma mitigação — no segundo tenant, quando os tokens passarem a ser vários, o
enforcement da Meta deixa de ser suficiente porque o token global deixa de existir.

---

## 2. Inventário de achados

### Identidade do remetente

```text
F-01 — phone_number_id é fixo por processo, lido de variável de ambiente
Categoria: 5 (global indevido)
FATO: cfg.PhoneNumberID vem de mustEnv("META_PHONE_NUMBER_ID") no boot (main.go:55) e é
      interpolado diretamente na URL de toda mensagem enviada
      (sender.go:24: "https://graph.facebook.com/%s/%s/messages"). Nenhum handler de /send/*
      aceita um remetente; os structs de request (types.go:123-181) não têm campo para isso.
IMPACTO: o remetente é propriedade do processo. Dois tenants no mesmo processo enviariam pelo
      mesmo número. É a violação direta do INV-25.
Prioridade: P1 | Risco: HIGH | Esforço: S
Severidade hoje: NENHUMA — há um número e ele é o correto.
Severidade no segundo tenant: CRITICAL — bloqueador absoluto. O tenant B envia como o tenant A,
      com o número, o nome de exibição e a reputação do tenant A.
```

```text
F-02 — access token da Meta é global de processo
Categoria: 5 (global indevido)
FATO: cfg.AccessToken vem de mustEnv("META_ACCESS_TOKEN") (main.go:56) e é usado em todos os
      caminhos de saída: envio (sender.go:36), download de mídia (sender.go:388,418), upload
      resumable (media_upload.go:102,130) e gestão de templates
      (templates_management.go:61,125,168).
IMPACTO: uma credencial para todas as operações. Não existe caminho de código que aceite um token
      por requisição nem que busque um token por tenant.
Prioridade: P1 | Risco: HIGH | Esforço: L
Severidade hoje: NENHUMA.
Severidade no segundo tenant: CRITICAL — é a credencial, não só o identificador. Exige
      armazenamento cifrado por tenant, que não existe hoje (ver F-21).
```

```text
F-03 — WABA ID vem de variável de ambiente, lida a cada chamada
Categoria: 5 (global indevido) — com aspecto correto registrado em P-04
FATO: resolveWABAID() lê os.Getenv("META_WABA_ID") a cada invocação
      (templates_management.go:26-32) e alimenta os três handlers de template
      (templates_management.go:47,99,155).
IMPACTO: a conta WhatsApp Business inteira — o namespace de templates — é de processo. Listar,
      criar ou apagar template opera sobre a WABA única.
Prioridade: P1 | Risco: HIGH | Esforço: S
Severidade hoje: NENHUMA.
Severidade no segundo tenant: CRITICAL — /templates/delete (templates_management.go:144) apagaria
      um template da WABA errada, e a exclusão na Meta é destrutiva e não reversível pelo serviço.
```

```text
F-04 — /health expõe a identidade do remetente sem autenticação, e o painel a consome
Categoria: 5 (global indevido) — é o mecanismo que materializa a inversão do INV-25
FATO: handleHealth devolve {"status":"ok","phone_number_id": cfg.PhoneNumberID}
      (sender.go:443-449). Está registrado em main.go:87 SEM o wrapper auth() — todos os outros
      endpoints de dados usam auth() ou dashAuth() (main.go:78-111). Conforme o brief (seção 1), o
      painel lê phone_number_id justamente dessa resposta.
IMPACTO: (a) qualquer um que alcance a porta descobre o phone_number_id de produção sem
      credencial; (b) o painel DESCOBRE a identidade do remetente em vez de DETERMINÁ-LA. Esse é
      o contrato que o INV-25 proíbe.
Prioridade: P1 | Risco: MEDIUM | Esforço: XS (no serviço) / M (coordenado com o painel)
Severidade hoje: LOW — o dado vazado é um identificador, não uma credencial, e é um número
      comercial público. O problema hoje é de contrato, não de sigilo.
Severidade no segundo tenant: HIGH — um endpoint não autenticado não tem como saber por qual
      tenant responder. Não há versão multi-tenant desse contrato; ele precisa ser removido.
```

```text
F-05 — o webhook de entrada NÃO usa metadata.phone_number_id para rotear nem para validar
Categoria: 6 (potencial cross-tenant)
FATO: InboundMetadata.PhoneNumberID existe no struct (types.go:30-33) e aparece uma única vez no
      código: dentro de um log.Printf (webhook.go:226-227). InboundEntry.ID (o WABA ID que a Meta
      põe no payload, types.go:13) é desserializado e nunca lido. processWebhook (webhook.go:155)
      trata todo payload com object=="whatsapp_business_account" (webhook.go:162) como sendo deste
      serviço, qualquer que seja o número de destino.
IMPACTO: o serviço não sabe a que instalação um evento pertence. Ele assume. Todo evento que
      passa pela verificação de assinatura é processado como se fosse do único tenant: gera evento
      no dashboard (webhook.go:230-236), dispara notifyOwner (webhook.go:247) e auto-resposta
      (webhook.go:250).
Prioridade: P1 | Risco: HIGH | Esforço: L
Severidade hoje: LOW — só existe uma WABA apontando para este endpoint, então "assumir" acerta.
Severidade no segundo tenant: CRITICAL — se o endpoint for compartilhado, é o vazamento
      cross-tenant principal: a mensagem do cliente do tenant B aparece no dashboard do tenant A e
      é encaminhada ao NotifyNumber do tenant A (F-17). O campo necessário para rotear JÁ CHEGA no
      payload e já está desserializado — é o achado que mais barateia a correção.
```

```text
F-06 — verificação de assinatura HMAC é opcional e falha ABERTA
Categoria: 6 (potencial cross-tenant) — fail-open
FATO: o bloco inteiro de verificação está sob `if cfg.AppSecret != ""` (webhook.go:136-146). Com
      META_APP_SECRET vazio, qualquer POST em /webhook é aceito e processado. META_APP_SECRET é
      getEnv(..., "") — opcional (main.go:57) — e nem sequer aparece no .env.example.
IMPACTO: sem app secret configurado, qualquer um pode injetar eventos forjados: criar eventos
      falsos no dashboard, disparar auto-respostas (webhook.go:250) e fazer o serviço enviar
      mensagens ao NotifyNumber (webhook.go:247) — ou seja, gastar cota de envio da Meta.
Prioridade: P1 | Risco: HIGH | Esforço: XS
Severidade hoje: MEDIUM — depende inteiramente de configuração. O `.env` local DEFINE
      META_APP_SECRET, então localmente a verificação está ligada. O valor em produção é
      NOT VERIFIED.
Severidade no segundo tenant: CRITICAL — o app secret passa a ser o que distingue os tenants na
      entrada. Fail-open num roteador de tenants é aceitar eventos de origem arbitrária como sendo
      de um tenant arbitrário.
```

```text
F-07 — verify token do webhook comparado com == (não é tempo constante)
Categoria: 5 (global indevido) — achado de segurança, não de tenancy
FATO: `token == cfg.VerifyToken` em webhook.go:118. Compare com webhook.go:141, onde o HMAC usa
      corretamente hmac.Equal.
IMPACTO: vazamento teórico de timing no segredo de verificação.
Prioridade: P3 | Risco: LOW | Esforço: XS
Severidade hoje: LOW — explorar exigiria um número enorme de requisições contra ruído de rede, e
      o token só serve para (re)assinar o webhook na Meta. Defeito latente e pouco explorável.
      Consta porque o padrão correto já existe três linhas adiante, no mesmo arquivo — a correção
      é copiar o que já está certo ali.
Severidade no segundo tenant: LOW (inalterada) — a menos que o verify token passe a ser por
      tenant, caso em que vira um seletor de escopo e sobe para MEDIUM.
```

```text
F-08 — não há idempotência por id de evento nem proteção contra replay na entrada
Categoria: 6 (potencial cross-tenant) — parcial
FATO: processWebhook (webhook.go:155-264) não mantém nenhum conjunto de ids já vistos. msg.ID
      (types.go:49) é desserializado e nunca usado. Não há checagem de timestamp
      (types.go:50 / :109, ambos desserializados e não usados). A única proteção parecida é o mapa
      de cooldown por telefone da auto-resposta (webhook.go:19-22,32-39) e o dedup por wamid
      restrito ao caminho de retry (queue.go:129-138).
IMPACTO: um payload assinado capturado pode ser reenviado indefinidamente. Cada replay recria
      evento no dashboard e dispara notifyOwner — que É um envio real à Meta (webhook.go:95) e não
      tem cooldown nenhum (diferente da auto-resposta).
Prioridade: P2 | Risco: MEDIUM | Esforço: S
Severidade hoje: LOW — exige que o atacante já possua um payload validamente assinado. O pacer
      (pacer.go) limita a taxa, não o volume.
Severidade no segundo tenant: MEDIUM — a superfície cresce com o número de endpoints/segredos, e
      o custo do replay passa a recair sobre a cota da Meta de um tenant específico.
```

### Autenticação do chamador

```text
F-09 — uma única API key compartilhada para todo o serviço, e ausência dela desliga a autenticação
Categoria: 5 (global indevido)
FATO: cfg.APIKey é getEnv("API_KEY", "") — opcional (main.go:59). O middleware auth() retorna
      `next(w, r)` imediatamente quando cfg.APIKey == "" (main.go:123-126); dashAuth() faz o mesmo
      (dashboard.go:17-20). Quando há chave, a comparação é `key != cfg.APIKey` (main.go:132) e
      `key != cfg.APIKey` (dashboard.go:23) — nenhuma é tempo constante.
IMPACTO: (a) sem API_KEY, todos os endpoints de envio, fila, templates, upload e problemas ficam
      abertos; (b) mesmo com ela, não existe identidade de chamador — só um segredo compartilhado.
      O serviço não tem como distinguir dois chamadores.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: MEDIUM — depende de configuração. O `.env` local define API_KEY. O valor em
      produção é NOT VERIFIED. Com um único chamador confiável, "uma chave" é coerente.
Severidade no segundo tenant: CRITICAL — é aqui que "escopo vindo de entrada não confiável" vira
      real. Com uma chave compartilhada, qualquer tenant que a possua pode enviar como qualquer
      outro tenant simplesmente informando o escopo alheio (e.g. o `appId` de F-19, a `loja` de
      F-12/F-25). A identidade do tenant precisa vir da autenticação, nunca do corpo.
```

```text
F-10 — o dashboard aceita a credencial na query string
Categoria: 5 (global indevido)
FATO: dashAuth lê a chave primeiro de r.URL.Query().Get("key") (dashboard.go:19), e a mensagem de
      erro instrui o usuário a usá-la assim: "adicione ?key=SUA_CHAVE na URL" (dashboard.go:24).
IMPACTO: a credencial vai para access log de proxy/CDN, histórico do navegador e header Referer.
Prioridade: P2 | Risco: MEDIUM | Esforço: S
Severidade hoje: MEDIUM — é a credencial real do serviço, circulando em URL.
Severidade no segundo tenant: HIGH — uma URL de dashboard vazada passa a dar acesso aos dados de
      um tenant específico, e o vazamento é passivo (não exige ação do atacante).
```

### Estado de processo

```text
F-11 — seis stores globais de processo, nenhum com chave de tenant
Categoria: 5 (global indevido)
FATO: evStore (store.go:34), msgQueue (queue.go:50), problemStore (problems.go:57), retryStore
      (retry.go:15-19), lastReplyAt (webhook.go:19-22) e sendPacer (sender.go:18, inicializado em
      main.go:70). Todos são `var` de pacote, todos com mutex próprio, nenhum indexado por tenant.
      Não há sync.Once no repositório (grep negativo); os clientes HTTP (sender.go:14,
      media_upload.go:17) não carregam credencial — o token vai por header/URL a cada chamada, o
      que é o comportamento correto.
IMPACTO: todo estado observável do serviço é de instalação. Dois tenants no mesmo processo
      compartilhariam fila, eventos, problemas e cooldowns.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: NENHUMA — um tenant, um estado.
Severidade no segundo tenant: CRITICAL no modelo de processo compartilhado; NENHUMA no modelo de
      um processo por Organization. É o achado mais sensível à decisão de topologia.
```

```text
F-12 — o campo `loja` parece escopo mas não é: é texto livre do chamador, usado só como filtro
Categoria: 4 (default implícito) — degrada para 6 sob chave compartilhada
FATO: QueueAddRequest.Loja (queue.go:38) é copiado sem validação para QueueItem.Loja
      (queue.go:110) e persistido na coluna `loja` de queue_items (db.go:99,207). No consumo, é
      apenas um filtro OPCIONAL: `if loja != "" && it.Loja != loja { continue }`
      (dashboard.go:105-107). Sem o parâmetro, handleQueueList devolve a fila inteira
      (dashboard.go:94-118) e ainda agrega contagens sobre a fila NÃO filtrada (dashboard.go:120-130).
IMPACTO: existe uma coluna com cara de escopo que não escopa nada. Omitir o filtro é o caminho
      padrão, não a exceção.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: NENHUMA — todas as lojas são da mesma dona, por desenho.
Severidade no segundo tenant: CRITICAL — se `loja` for promovida a chave de tenancy sem mudar
      quem a fornece, o escopo passa a vir de entrada não confiável. É o padrão que o brief chama
      de categoria 6. O lado positivo está registrado em P-07: o encanamento ponta a ponta já
      existe.
```

```text
F-13 — a chave de deduplicação da fila não inclui tenant, e a rejeição é silenciosa
Categoria: 4 (default implícito)
FATO: dedupKey usa apenas destinatário + template, ou destinatário + hash da mensagem
      (queue.go:58-71). Nem `Loja` nem qualquer outro escopo entra na chave. isDuplicate varre a
      fila INTEIRA (queue.go:78-95). Na rejeição, handleQueueAdd responde
      `{"success":true,"data":{"duplicate":true}}` — HTTP 200 (dashboard.go:67-72).
IMPACTO: dois tenants que mandem o mesmo template para o mesmo número de cliente colidem. O
      segundo é descartado com resposta de sucesso.
Prioridade: P2 | Risco: MEDIUM | Esforço: S
Severidade hoje: NENHUMA — colisão entre lojas da mesma dona é justamente o que se quer evitar.
Severidade no segundo tenant: HIGH — perda silenciosa de mensagem, e silenciosa é o pior modo de
      falha: o painel do tenant B recebe 200 e não tem como saber que nada foi enviado. Mesmo
      problema em RemoveDuplicates (queue.go:176-208), que agrupa por dedupKey e APAGA
      (queue.go:205) os perdedores do agrupamento — cross-tenant deletion no segundo tenant.
```

```text
F-14 — retryStore guarda o pedido original sem nenhum escopo
Categoria: 5 (global indevido)
FATO: retryStore é map[wamid]QueueAddRequest, global, FIFO de 500 (retry.go:13-36). O QueueAddRequest
      guardado inclui Loja (queue.go:344-347) mas a busca é só por wamid (retry.go:38-43), e o item
      criado a partir dele vai para o msgQueue global (webhook.go:206 → queue.go:129).
IMPACTO: baixo risco de colisão (o wamid é único na Meta), mas o item de retry entra na fila
      global e será despachado pelo remetente global (queue.go:338 → sender.go:24).
Prioridade: P2 | Risco: LOW | Esforço: S
Severidade hoje: NENHUMA.
Severidade no segundo tenant: HIGH — o retry é um envio que NÃO passa pela requisição do painel;
      ele nasce dentro do serviço, a partir de um webhook. É exatamente o "job/webhook que
      descobre escopo em vez de recebê-lo". Se o escopo não estiver gravado junto com o wamid, não
      há de onde recuperá-lo.
```

```text
F-15 — o cooldown da auto-resposta é chaveado só por telefone do cliente
Categoria: 6 (potencial cross-tenant)
FATO: lastReplyAt é map[string]time.Time chaveado pelo `to` (webhook.go:21,34,38).
IMPACTO: o brief classifica explicitamente "cache cuja chave não inclui o tenant" como leitura
      cross-tenant. Um consumidor que fale com dois tenants teria a auto-resposta de um suprimida
      pelo cooldown do outro — por até 6 horas (padrão de REPLY_COOLDOWN_MINUTES, main.go:64).
Prioridade: P2 | Risco: MEDIUM | Esforço: XS
Severidade hoje: NENHUMA.
Severidade no segundo tenant: MEDIUM — falha silenciosa e difícil de diagnosticar; o cliente do
      tenant B simplesmente não recebe a resposta automática, sem erro em lugar nenhum.
```

```text
F-16 — pacer único de processo: um tenant atrasa os outros
Categoria: 5 (global indevido)
FATO: sendPacer é um pacer global (sender.go:18), e metaPost chama sendPacer.wait() como primeira
      instrução (sender.go:22). O pacer serializa TODAS as chamadas com intervalo mínimo
      (pacer.go:24-40), padrão 1000ms (main.go:68). O comentário em pacer.go:8-10 declara a
      intenção: somar "TODAS as origens".
IMPACTO: os limites de taxa da Meta são por número/WABA, mas o pacer é por processo. Uma campanha
      grande de um tenant enfileira atrás de si as mensagens transacionais de todos os outros.
Prioridade: P2 | Risco: MEDIUM | Esforço: S
Severidade hoje: NENHUMA — com um remetente, um pacer global é exatamente a semântica certa.
Severidade no segundo tenant: HIGH — vizinho barulhento com efeito direto na latência percebida.
      Uma campanha de 1000 mensagens a 1 msg/s bloqueia por ~17 minutos a confirmação de pedido de
      outro tenant.
```

### Comportamento configurado globalmente

```text
F-17 — NotifyNumber e a mensagem de auto-resposta são config de processo, consumidas na entrada
Categoria: 5 (global indevido)
FATO: cfg.NotifyNumber (main.go:66) é o destino de notifyOwner, que envia para ele o telefone, o
      nome de perfil e o conteúdo da mensagem de TODO cliente que escrever
      (webhook.go:86-100, formatação em webhook.go:93). cfg.ReplyRedirectMessage (main.go:45-50,63)
      é o texto enviado de volta a todo cliente (webhook.go:41), e o padrão gerado embute um número
      específico via link wa.me (main.go:49).
IMPACTO: não é só configuração — é o destino de dados pessoais de clientes e o conteúdo enviado em
      nome da marca. Ambos são de processo.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: NENHUMA.
Severidade no segundo tenant: CRITICAL — em endpoint compartilhado, combinado com F-05 (que não
      valida a quem o evento pertence), isto encaminha os dados de contato dos clientes do tenant B
      para o telefone do tenant A. É vazamento de PII entre clientes distintos, não apenas quebra
      de isolamento lógico.
```

```text
F-18 — repasse do payload bruto para uma única URL global, sem autenticação adicionada pelo serviço
Categoria: 5 (global indevido)
FATO: cfg.ForwardURL (main.go:60) recebe um http.Post simples com o corpo BRUTO do webhook
      (webhook.go:255-263). Nenhum header é definido além do Content-Type implícito; não há
      assinatura, nem API key, nem timeout dedicado (usa o http.Post do pacote, sem cliente com
      Timeout). Qualquer autenticação existente precisa estar embutida na própria URL.
IMPACTO: responde à pergunta 13 do brief pelo lado do serviço Go: o serviço não adiciona
      autenticação nenhuma. O `?secret=` comparado com `!==` no painel só pode vir de dentro do
      valor de WEBHOOK_FORWARD_URL. O payload repassado contém telefone, nome de perfil e conteúdo
      das mensagens dos clientes.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: MEDIUM — o `.env` local tem WEBHOOK_FORWARD_URL VAZIO, então localmente o repasse
      está desligado. O valor em produção é NOT VERIFIED. Observação adicional: http.Post sem
      cliente com timeout pode deixar a goroutine pendurada indefinidamente (webhook.go:256), já
      que processWebhook roda em goroutine solta (webhook.go:152).
Severidade no segundo tenant: CRITICAL — um destino para todos os tenants significa que os eventos
      de todos chegam ao mesmo lugar, e o receptor não tem no payload nada que o próprio serviço
      tenha validado como escopo (F-05).
```

```text
F-19 — appId aceito do chamador, validado no formato, NÃO validado em ownership, e desacoplado da credencial
Categoria: 6 (potencial cross-tenant)
FATO: MediaUploadRequest.AppID vem do corpo JSON (media_upload.go:34). Tem precedência sobre o env
      (media_upload.go:67-70), é validado contra ^[0-9]{5,32}$ (media_upload.go:39,75) e entra no
      caminho da URL da Graph API (media_upload.go:101-102). Nenhuma checagem verifica que o
      chamador tem direito àquele app. O token usado continua sendo cfg.AccessToken global
      (media_upload.go:102 e :130).
IMPACTO: identidade por requisição sem credencial por requisição. É a forma do INV-25 com a metade
      que importa faltando.
Prioridade: P2 | Risco: MEDIUM | Esforço: S
Severidade hoje: LOW — quem barra o abuso é a Meta, não este serviço: o token global não tem
      permissão sobre apps de terceiros e a Graph API rejeita. Registro explicitamente que o
      serviço NÃO é o ponto de enforcement, e que a proteção observada é externa a ele.
Severidade no segundo tenant: HIGH — quando houver vários tokens, o enforcement externo deixa de
      existir na forma atual, e a regra "identidade do corpo + credencial da config" passa a poder
      cruzar tenants. É também o ponto onde a correção é mais barata: o handler já recebe o campo,
      já valida formato e já tem testes (P-03).
```

### Credenciais e dados

```text
F-20 — o access token entra na query string no caminho de upload, e corpos de erro da Meta são
       repassados e logados verbatim
Categoria: 5 (global indevido)
FATO: em startUploadSession, o token vai na URL: "...&access_token=%s" com
      url.QueryEscape(cfg.AccessToken) (media_upload.go:101-102). Todo o resto do serviço usa
      header Authorization (sender.go:36,388,418; media_upload.go:130;
      templates_management.go:61,125,168). Corpos de erro da Meta são devolvidos ao chamador sem
      filtro (media_upload.go:112,141; sender.go:47,399,429; templates_management.go:74,138,181) e
      logados integralmente em templates_management.go:73,137,180.
IMPACTO: credenciais em query string aparecem em access log de proxy/CDN e em telemetria de rede.
      Se a Meta ecoar a URL da requisição dentro de um corpo de erro, o token chegaria ao chamador
      e ao log do serviço.
Prioridade: P2 | Risco: MEDIUM | Esforço: S
Severidade hoje: MEDIUM pelo token na URL (fato observado); o eco da URL em corpo de erro é
      NOT VERIFIED — não observei a Meta fazendo isso e não testei contra a API real.
Severidade no segundo tenant: HIGH — deixa de ser um token e passa a ser N tokens de N clientes.
```

```text
F-21 — não há rotação nem tratamento de expiração de token
Categoria: 5 (global indevido)
FATO: cfg.AccessToken é lido uma vez no boot (main.go:56) para uma struct global (main.go:40) e
      nunca é relido. Nenhuma ocorrência de refresh, expiry ou 401 tratado especificamente: um
      token expirado vira um erro genérico "meta api %d: %s" (sender.go:47), reportado ao chamador
      como 502 (sender.go:100) e registrado como evento de erro (sender.go:99). Mudar o token exige
      reiniciar o processo.
IMPACTO: expiração é indistinguível de qualquer outra falha da Meta, e a recuperação é um restart
      manual.
Prioridade: P2 | Risco: MEDIUM | Esforço: M
Severidade hoje: MEDIUM se o token for de usuário (60 dias); LOW se for token de System User
      (sem expiração). Qual dos dois é NOT VERIFIED — depende do Meta Business Manager, fora do
      repositório.
Severidade no segundo tenant: HIGH — com N tenants, a expiração deixa de ser um evento raro e
      vira operação corrente; e a correção por restart deixa de ser aceitável porque derrubaria
      todos os tenants.
```

```text
F-22 — nenhuma tabela tem coluna de tenant
Categoria: 5 (global indevido)
FATO: migrate() cria events, problem_orders e queue_items (db.go:52-101). Nenhuma das três tem
      organization_id, tenant_id ou equivalente. events (db.go:53-63) não tem sequer `loja`.
      Nenhum SELECT filtra por escopo: loadEvents (db.go:131-133), loadQueue (db.go:255-258) e
      loadProblems (db.go:349-352) carregam tudo. dbClearEvents executa `DELETE FROM events` sem
      WHERE (db.go:184), acionável por /dashboard/events/clear (main.go:91).
IMPACTO: a persistência não tem conceito de dono. Migrar exige DDL nas três tabelas, backfill e
      revisão de cada uma das 11 consultas do arquivo.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: NENHUMA.
Severidade no segundo tenant: CRITICAL — inclusive o DELETE sem WHERE, que passaria a apagar o
      histórico de todos os tenants a partir de um botão do dashboard de um deles.
```

```text
F-23 — problem_orders tem chave primária global e faz merge no PRIMEIRO registro que casa,
       propagando PII entre registros
Categoria: 6 (potencial cross-tenant)
FATO: numero é PRIMARY KEY sozinho (db.go:66). Em memória, Upsert varre s.items e para no
      PRIMEIRO cujo Numero bate, ignorando Loja (problems.go:68-70) — o padrão "primeiro registro
      que casa" que o brief manda caçar. Ao casar, COPIA para o novo registro os campos ausentes do
      anterior: Telefone, Email, CPF (problems.go:71-79). No banco, o ON CONFLICT (numero) DO
      UPDATE faz o mesmo com COALESCE(NULLIF(...)) (db.go:312-322).
IMPACTO: dois tenants com o mesmo número de pedido colidem, e a colisão não apenas sobrescreve —
      ela HERDA telefone, e-mail e CPF do registro anterior. O registro do tenant B passaria a
      exibir a PII do cliente do tenant A.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: NENHUMA — numeração de pedido vinda de uma fonte só.
Severidade no segundo tenant: CRITICAL — contaminação de PII entre clientes distintos. Números de
      pedido são sequenciais e curtos; colisão entre tenants não é hipótese remota, é o esperado.
```

```text
F-24 — handleProblemsSync apaga registros por um escopo vindo do corpo da requisição
Categoria: 6 (potencial cross-tenant)
FATO: o handler lê `loja` do corpo JSON (problems.go:237-241) e chama SyncLoja(req.Loja,
      req.Numeros) (problems.go:246), que remove da memória e do banco TODOS os itens daquela loja
      ausentes da lista `keep` (problems.go:131-154 → dbDeleteProblems, db.go:339). O comentário em
      problems.go:230-231 documenta que uma lista vazia limpa tudo daquela loja. A única
      autenticação é a API key única (main.go:108 → auth).
IMPACTO: escopo vindo de entrada não confiável, usado para SELECIONAR O QUE APAGAR. É a categoria 6
      na forma mais direta que aparece no repositório.
Prioridade: P1 | Risco: HIGH | Esforço: M
Severidade hoje: LOW — um só chamador, que já possui a chave e já é dono de todas as lojas.
Severidade no segundo tenant: CRITICAL — com chave compartilhada (F-09), qualquer tenant apaga os
      dados de problemas de qualquer outro passando o nome da loja alheia. Destrutivo e sem
      confirmação.
```

```text
F-25 — regra de negócio de um tenant específico embutida no despacho, sobrescrevendo o chamador
Categoria: 4 (default implícito)
FATO: em dispatchItem: `if lang == "" || lang == "en" { lang = "pt_BR" }`, com o comentário
      "// todos os templates da Reserva INK são pt_BR" (queue.go:318-321). O comentário DECLARA a
      premissa de instalação única — é o equivalente, neste repositório, da causa-raiz declarada em
      comentário que o brief descreve na pergunta 6.
IMPACTO: um chamador que peça explicitamente "en" recebe pt_BR, silenciosamente. Não é fallback
      para valor ausente: é override de valor presente.
Prioridade: P2 | Risco: MEDIUM | Esforço: XS
Severidade hoje: NENHUMA — a premissa é verdadeira para este tenant.
Severidade no segundo tenant: HIGH — um tenant que atenda em outro idioma teria os templates
      trocados sem erro. Note que handleSendTemplate (sender.go:122-124) faz o correto: só preenche
      pt_BR quando Language está VAZIO. Os dois caminhos divergem, e o certo já existe.
```

```text
F-26 — ausência de DATABASE_URL degrada silenciosamente para memória
Categoria: 3 parcial / 5 — degradação detectada e registrada, porém fail-OPEN
FATO: initDB retorna sem erro quando DATABASE_URL está vazia, logando "dados somente em memória"
      (db.go:18-22); o mesmo nas falhas de conexão e de ping (db.go:28-36). Todas as funções db*
      retornam cedo quando db == nil (db.go:111,179,191,216,237,298,333). O serviço sobe
      normalmente. O `.env` local NÃO define DATABASE_URL.
IMPACTO: o serviço aceita mensagens na fila e as perde no restart, sem sinalizar isso a nenhum
      chamador — /health (sender.go:443-449) não reporta o estado do banco.
Prioridade: P2 | Risco: MEDIUM | Esforço: S
Severidade hoje: MEDIUM — depende de configuração em produção, que é NOT VERIFIED. A detecção e o
      log são deliberados (por isso "categoria 3 parcial"), mas a decisão é continuar, não abortar.
Severidade no segundo tenant: HIGH — perda silenciosa de dados de cliente pagante, sem sinal.
```

---

## 3. Contagem por categoria

| Categoria | Significado | Qtd | Achados |
|---|---|---|---|
| 1 | já organization-scoped | **0** | — |
| 2 | explicitamente atribuído | **0** (achados) / 3 (padrões corretos, §4) | — |
| 3 | não atribuído e corretamente excluído | **0** (achados) / 4 (padrões corretos, §4) | F-26 conta como parcial |
| 4 | default implícito | **3** | F-12, F-13, F-25 |
| 5 | global indevido | **15** | F-01, F-02, F-03, F-04, F-07, F-09, F-10, F-11, F-14, F-16, F-17, F-18, F-20, F-21, F-22 |
| 6 | potencial cross-tenant | **8** | F-05, F-06, F-08, F-15, F-19, F-23, F-24 (+ F-12 degradando de 4 para 6) |

**Total: 26 achados.** Nenhum recurso do serviço está hoje escopado por tenant (categoria 1 = zero),
o que é coerente com o serviço ser single-tenant por construção e não por descuido.

### Distribuição hoje vs. no segundo tenant

| Severidade | Hoje | No segundo tenant |
|---|---|---|
| CRITICAL | 0 | 12 |
| HIGH | 0 | 10 |
| MEDIUM | 7 | 3 |
| LOW | 4 | 1 |
| NENHUMA | 15 | 0 |

**Nenhum achado é CRITICAL ou HIGH hoje.** Os sete MEDIUM de hoje (F-06, F-08 parcial, F-09, F-10,
F-18, F-20, F-21, F-26) são todos de segurança/operação, não de tenancy, e quatro deles dependem de
configuração de produção que não pude verificar. **Vinte e dois dos vinte e seis viram CRITICAL ou
HIGH no segundo tenant.** É a mesma assimetria que o brief relata da auditoria do painel, e a
mesma conclusão: a migração não é incremental *no caminho de entrada*; no caminho de saída, é.

---

## 4. Padrões corretos já existentes (categorias 1-3)

Estes reduzem o custo da implementação futura e devem ser tratados como o padrão-alvo a copiar.

```text
P-01 — HMAC em tempo constante, sobre o corpo cru, na ordem certa
Categoria: 2 | webhook.go:130-146
O corpo é lido com io.ReadAll ANTES de qualquer parse (webhook.go:130), o HMAC é calculado sobre
esses bytes exatos (webhook.go:139) e a comparação usa hmac.Equal (webhook.go:141) — tempo
constante. Não há re-serialização entre verificar e usar. É o padrão correto e completo; o que
falta é apenas o segredo deixar de ser único (F-06).
```

```text
P-02 — ausência de WABA ID tratada fail-closed, com a tentativa de auto-descoberta REMOVIDA e
       documentada
Categoria: 3 | templates_management.go:18-32
resolveWABAID retorna erro explícito quando META_WABA_ID não está definida; os três handlers
propagam como 502 e abortam (templates_management.go:47-52, 99-104, 155-160). Nada é adivinhado,
não há fallback para "o primeiro que existir". O comentário em templates_management.go:20-25
registra que a auto-descoberta via Graph API foi TENTADA E REMOVIDA por não existir na API.
É literalmente o princípio "receba, não descubra" já aplicado neste repositório — o argumento
mais forte disponível de que a equipe reconhece o padrão.
```

```text
P-03 — appId validado contra allowlist estrita antes de entrar na URL, com testes
Categoria: 3 (na dimensão path-injection; NÃO na dimensão ownership — ver F-19)
media_upload.go:39 (regex ^[0-9]{5,32}$), aplicada em media_upload.go:75, com o comentário em
media_upload.go:37-38 explicando a ameaça. Coberta por TestGivenAppIDWithNonDigits... e
TestGivenInvalidEnvAppIDAndNoRequestAppID... (media_upload_test.go:18-33, 52-64). Entrada não
confiável detectada e rejeitada, fail-closed, com teste. É o esqueleto sobre o qual a validação de
ownership deve ser construída.
```

```text
P-04 — ausência de credencial no upload tratada fail-closed, com ordem de checagem deliberada
Categoria: 3 | media_upload.go:65-74, testado em media_upload_test.go:35-50
O comentário em media_upload.go:65-66 registra a decisão de checar a credencial DEPOIS da validação
do request, para que um request malformado receba o erro correto. É cuidado de diagnóstico raro de
se ver, e vale preservar na migração.
```

```text
P-05 — segredos mascarados no log de boot
Categoria: 2 | main.go:113-114
APIKey e AppSecret são logados como BOOLEANOS (`cfg.APIKey != ""`, `cfg.AppSecret != ""`), nunca
como valor. Nenhuma ocorrência de token, chave ou segredo em texto claro em nenhum log do
repositório (verificado em todos os log.Printf dos 16 arquivos). Ressalva: os IDENTIFICADORES são
logados em claro — phone_number_id e META_WABA_ID (main.go:113-114). Isso responde à pergunta 8:
credenciais não vazam em log; identificadores sim.
```

```text
P-06 — token por header Authorization em todo o caminho de mensagens
Categoria: 2 | sender.go:36, 388, 418; media_upload.go:130; templates_management.go:61, 125, 168
Sete dos oito pontos que usam o token o enviam por header. O único desvio é
media_upload.go:101-102 (F-20) — ou seja, o padrão correto é a regra e o desvio é a exceção
pontual.
```

```text
P-07 — o encanamento de um campo de escopo ponta a ponta JÁ EXISTE (falta apenas ser autoritativo)
Categoria: 2 (como mecanismo; ver F-12 quanto à semântica)
`loja` atravessa todas as camadas: QueueAddRequest.Loja (queue.go:38) → QueueItem.Loja
(queue.go:19,110) → coluna loja em queue_items (db.go:99) → INSERT (db.go:204,207) → SELECT
(db.go:256,270) → filtro de leitura (dashboard.go:96,105) → agregação (dashboard.go:121,126) → e é
carregado adiante no retry (queue.go:345). O mesmo vale para problem_orders (db.go:68,309,323,350).
IMPACTO NA ESTIMATIVA: o trabalho estrutural de propagar um campo de escopo por toda a fila e pelo
store de problemas já está feito. Substituir `loja` (texto do chamador) por organization_id
(derivado da autenticação) é uma mudança de ORIGEM e de OBRIGATORIEDADE, não de arquitetura. Isso
rebaixa o esforço de F-12/F-22 de L para M.
```

```text
P-08 — segredos fora do controle de versão e fora da imagem
Categoria: 2 | .gitignore:3 (.env), .gitignore:1-2 (binários), Dockerfile:6
.env está no .gitignore e .env.example contém apenas placeholders. O Dockerfile copia
seletivamente `COPY *.go *.html ./` (Dockerfile:6) — .env, teste_envio.py e o binário local de
15MB não entram na imagem. Build multi-stage com CGO_ENABLED=0 sobre alpine, com ca-certificates
instalado (Dockerfile:10-12).
```

```text
P-09 — pacer correto sob concorrência, com testes
Categoria: 2 | pacer.go:13-40, pacer_test.go:9-63
Reserva o slot sob mutex e dorme FORA dele (pacer.go:29-38) — não segura o lock durante o sleep.
Testado em sequência, em concorrência e desligado. O objeto é bem construído; o problema é só o
fato de haver um único (F-16).
```

```text
P-10 — o caminho de saída é um funil de UMA função
Categoria: 2 (como propriedade estrutural) | sender.go:21-51
Este é o fato isolado mais favorável do repositório. Todos os 9 pontos de envio — texto, template,
mídia, botões, lista, reação, marcar-como-lida, auto-resposta, notificação e despacho da fila —
passam por metaPost. Não há nenhuma chamada direta à API de mensagens da Meta fora dela
(verificado: as demais chamadas a graph.facebook.com são de mídia (sender.go:382,413), templates
(templates_management.go:54,118,162) e upload (media_upload.go:101,125), todas em endpoints
distintos de /messages). Por isso o caminho de saída é mudança de contrato e não reescrita.
```

---

## 5. Respostas diretas às 17 perguntas

### Identidade do remetente

**1. Como o serviço seleciona a WABA?**
Variável de ambiente `META_WABA_ID`, lida via `os.Getenv` a cada chamada dentro de `resolveWABAID()`
(`templates_management.go:26-32`). Não está na struct `Config` — é a única credencial/identificador
lido fora do boot. Não vem de banco, header nem corpo. Se ausente, o serviço **falha fechado** com
erro explícito (P-02). É usada só nos três endpoints de template
(`templates_management.go:47,99,155`); o caminho de envio de mensagens não usa WABA ID.

**2. Como seleciona o `phone_number_id`? Ele é fixo por processo?**
Variável de ambiente `META_PHONE_NUMBER_ID`, via `mustEnv` — **obrigatória, o processo aborta sem
ela** (`main.go:55`, `main.go:147-153`). **Sim, é fixo por processo**: lido uma vez no boot para
`cfg` (`main.go:40,52`) e interpolado na URL de envio em `sender.go:24`. Nenhum endpoint aceita um
`phone_number_id` por requisição; nenhum struct de request em `types.go:123-181` tem campo para
isso.

**3. O healthcheck: que outros campos expõe? Exige autenticação?**
Expõe **exatamente dois campos**: `status` (literal `"ok"`) e `phone_number_id`
(`sender.go:443-449`). Nada mais — não expõe estado do banco, versão, WABA ID nem contadores.
**Não exige autenticação nenhuma**: `main.go:87` registra `handleHealth` diretamente, sem os
wrappers `auth()` ou `dashAuth()` que protegem todos os demais endpoints de dados
(`main.go:78-111`). É também sempre 200 — nunca reporta degradação, inclusive quando o banco caiu
para modo memória (F-26).

**4. Existe suporte a mais de um número hoje, mesmo que não usado?**
**Não. Nenhum.** Não há mapa, lista, tabela nem seletor de números em lugar algum do repositório.
`cfg.PhoneNumberID` é uma `string` (`main.go:15`). Não existe "escolha entre eles" porque não
existe pluralidade a escolher. O único campo que poderia servir para isso —
`metadata.phone_number_id` do payload de entrada — é desserializado e usado apenas em log
(`webhook.go:227`, F-05).

### Estado e escopo

**5. Existe estado global ou singleton no processo? Liste cada um.**
Sim — **treze** `var` de pacote. Nenhum `sync.Once` (grep negativo). Nenhum cliente HTTP com
credencial embutida (o token vai por header/URL a cada chamada — P-06).

| # | Global | Local | Carrega escopo? |
|---|---|---|---|
| 1 | `cfg Config` | `main.go:40` | **Sim — é A identidade do tenant** (phone_number_id, token, app secret, verify token, app id, notify number, reply message, forward URL) |
| 2 | `evStore` | `store.go:34` | Sim — ring buffer de 500 eventos, sem chave de tenant |
| 3 | `msgQueue` | `queue.go:50` | Sim — fila de mensagens, sem chave de tenant (só `loja` informativa) |
| 4 | `problemStore` | `problems.go:57` | Sim — pedidos com PII, chaveados só por `numero` |
| 5 | `retryStore` | `retry.go:15` | Sim — pedidos originais chaveados por wamid |
| 6 | `lastReplyAt` + `replyMu` | `webhook.go:19-22` | Sim — cooldown chaveado só por telefone do cliente |
| 7 | `sendPacer` | `sender.go:18` | Sim — rate limit de processo, não de número |
| 8 | `db *pgxpool.Pool` | `db.go:15` | Sim — uma conexão, um banco, sem separação |
| 9 | `httpClient` | `sender.go:14` | Não — só timeout |
| 10 | `mediaUploadClient` | `media_upload.go:17` | Não — só timeout |
| 11 | `appIDPattern` | `media_upload.go:39` | Não — regex imutável, compilada uma vez (boa prática) |
| 12-14 | `dashboardHTML`, `problemsHTML`, `automaticosHTML` | `dashboard.go:11`, `problems.go:12`, `automaticos.go:11` | **Sim, indiretamente** — HTML embutido com marca de um tenant (F-27 abaixo) |

**6. Há premissa de uma única Organization/instalação no código? Há comentário que a declare?**
**Sim, e está declarada em comentário** — o padrão que o brief pedia para procurar:

- `queue.go:320`: `lang = "pt_BR" // todos os templates da Reserva INK são pt_BR` — regra de
  negócio de um tenant nomeado, embutida no despacho e sobrescrevendo o chamador (F-25).
- `media_upload.go:22`: referência a um documento interno do painel
  (`docs/PROMPT-CLAUDE-CAMPANHAS-REMARKETING-MIDIA-WHATSAPP.md`) e a "amostra de template" como
  conceito do produto único.
- `media_upload.go:98-100`: comentário descreve o comportamento de `server.js` do painel como se
  houvesse **um** painel: "server.js repassa sem sanitizar".
- Marca fixa nos três HTML embutidos: `"Use Sul · Reserva INK"` (`dashboard.html:116`,
  `automaticos.html:68`, `problems.html:79`) e deep links fixos para `reserva.ink`
  (`dashboard.html:264`, `problems.html:148`).
- `main.go:49`: o texto padrão de auto-resposta embute um link `wa.me` de um número específico.

### Credenciais

**7. Como as credenciais da Meta são armazenadas? Estão cifradas?**
**Em variáveis de ambiente, em texto claro, sem cifra em nenhum ponto.** Carregadas no boot para a
struct global `cfg` (`main.go:52-69`): `META_ACCESS_TOKEN` (`main.go:56`, obrigatória),
`META_APP_SECRET` (`main.go:57`, **opcional** — e ausente do `.env.example`), `META_VERIFY_TOKEN`
(`main.go:58`, obrigatória), `META_APP_ID` (`main.go:61`, opcional), `META_WABA_ID`
(`templates_management.go:27`, lida sob demanda) e `API_KEY` (`main.go:59`, opcional).
**Nenhuma credencial é lida do banco.** As três tabelas (`db.go:52-101`) não têm coluna de
credencial — o que significa que hoje **não existe nenhum mecanismo de armazenamento de
credenciais por tenant**, cifrado ou não. O `.env` local existe em disco (gitignored, `.gitignore:3`)
e contém 7 chaves: `META_PHONE_NUMBER_ID`, `META_ACCESS_TOKEN`, `META_VERIFY_TOKEN`,
`META_APP_SECRET`, `API_KEY`, `PORT`, `WEBHOOK_FORWARD_URL`. Não li nem reproduzo os valores.

**8. As credenciais aparecem em log, erro ou resposta de API? Há masking?**
**Há masking deliberado, e ele funciona para as credenciais.** `main.go:113-114` loga `APIKey` e
`AppSecret` como booleanos, nunca como valor (P-05). Varri todos os `log.Printf` dos 16 arquivos:
nenhuma credencial em texto claro. **Três ressalvas factuais:**
1. **Identificadores** são logados em claro: `phone_number_id` e `META_WABA_ID` (`main.go:113-114`),
   e `phone_number_id` também é devolvido por um endpoint público (`sender.go:447`, F-04).
2. O access token **entra na query string** da chamada de upload (`media_upload.go:101-102`, F-20) —
   fora do log do serviço, mas dentro de logs de qualquer intermediário.
3. Corpos de erro da Meta são repassados ao chamador e logados **verbatim**
   (`templates_management.go:73-74,137-138,180-181`; `sender.go:47`; `media_upload.go:112,141`). Se
   a Meta ecoar a URL da requisição num erro de upload, o token iria junto. **Exploração:
   NOT VERIFIED** — não testei contra a API real.
4. **PII de cliente aparece em log em claro**: telefone, nome de perfil e tipo de mensagem
   (`webhook.go:226-227`), e telefone do destinatário (`webhook.go:180`, `queue.go:340`).

**9. Há rotação de token? Como o serviço lida com expiração?**
**Não há rotação e não há tratamento de expiração.** O token é lido uma vez no boot
(`main.go:56`) e nunca é relido — trocá-lo exige reiniciar o processo. Nenhuma ocorrência de
refresh/renew/expiry no repositório. Um token expirado produz o erro genérico
`"meta api %d: %s"` (`sender.go:47`), devolvido como 502 (`sender.go:100`) e gravado como evento de
erro (`sender.go:99`). Não há detecção específica de 401, nem retry, nem alerta. (F-21)

### Webhooks de entrada

**10. Como um webhook recebido da Meta é roteado?**
**Não é roteado. Não há decisão de destino.** `processWebhook` (`webhook.go:155`) verifica apenas
`payload.Object == "whatsapp_business_account"` (`webhook.go:162`) e então processa tudo como sendo
da instalação única. Não pela URL (há **um** path, `/webhook`, `main.go:76` — sem segmento de
tenant), não por campo do payload, não por `phone_number_id`, e não por tentativa. Os dois campos
que permitiriam rotear — `entry.ID` (WABA ID, `types.go:13`) e `metadata.phone_number_id`
(`types.go:32`) — **estão desserializados e disponíveis**; o segundo é usado exclusivamente em
`log.Printf` (`webhook.go:227`) e o primeiro não é lido em lugar nenhum. (F-05)
*Nota:* o repositório **não** tem o antipadrão do painel (testar o segredo de cada loja em sequência
até um HMAC validar). Ele não tem descoberta errada — ele não tem descoberta nenhuma.

**11. A assinatura da Meta é verificada? Em tempo constante? O corpo cru é preservado?**
**Sim, sim e sim — mas condicionalmente.** Quando `cfg.AppSecret != ""` (`webhook.go:136`): o corpo
é lido cru com `io.ReadAll` antes de qualquer parse (`webhook.go:130`), o HMAC-SHA256 é calculado
sobre esses bytes exatos (`webhook.go:138-140`), e a comparação usa **`hmac.Equal`** — tempo
constante (`webhook.go:141`). O mesmo `body` cru é o que vai para `processWebhook` e para o repasse
(`webhook.go:152,256`), sem re-serialização. **A condicional é o problema**: com `META_APP_SECRET`
vazio a verificação é inteiramente pulada e qualquer POST é aceito — fail-open (F-06). Uma
observação menor: o header `X-Hub-Signature-256` ausente resulta em `sig == ""`, que `hmac.Equal`
rejeita corretamente — ou seja, ausência de assinatura falha fechado *quando* o secret está
configurado.

**12. Há idempotência por id de evento? Há proteção contra replay?**
**Não e não.** `processWebhook` (`webhook.go:155-264`) não mantém conjunto de ids processados.
`msg.ID` (`types.go:49`) e ambos os `Timestamp` (`types.go:50`, `types.go:109`) são desserializados
e **nunca lidos**. Não há janela de tolerância de timestamp. As duas proteções parciais existentes
são colaterais, não desenhadas para replay: o cooldown da auto-resposta por telefone
(`webhook.go:32-39`) e o dedup por wamid no caminho de retry (`queue.go:129-138`). `notifyOwner`
(`webhook.go:87`) — que faz um **envio real à Meta** — não tem nenhuma. (F-08)

**13. Como repassa o evento ao painel? Com que autenticação?**
`http.Post(cfg.ForwardURL, "application/json", bytes.NewReader(body))` — o **corpo bruto** do
webhook, para a URL de `WEBHOOK_FORWARD_URL` (`webhook.go:255-257`, `main.go:60`).
**Confirmando o outro lado do contrato descrito no brief: o serviço Go NÃO adiciona autenticação
nenhuma.** Nenhum header além do Content-Type, nenhuma assinatura, nenhuma API key. Portanto o
`?secret=` que o painel compara com `!==` só pode estar **embutido no próprio valor da variável de
ambiente**. Consequências factuais: (a) o segredo trafega em query string dos dois lados; (b) o
painel não tem como validar a origem além desse segredo, porque nada mais é enviado; (c) não há
retry nem fila — falha de rede só produz um log (`webhook.go:258-259`); (d) `http.Post` do pacote
não tem timeout, e roda em goroutine solta (`webhook.go:152`).
**NOT VERIFIED:** o valor de produção de `WEBHOOK_FORWARD_URL`. No `.env` local ele está **vazio**,
ou seja, localmente o repasse está desligado.

### Caminho para multi-tenant

**14. Como seria o vínculo correto com `organization_id`? (recomendação, não estado observado)**
O que a evidência sustenta é onde as mudanças precisariam incidir:

- *Saída:* `metaPost` (`sender.go:21`) precisaria receber a identidade do remetente como parâmetro
  em vez de ler `cfg` (`sender.go:24,36`). São 9 call sites (§1). Os structs de request
  (`types.go:123-181`) precisariam do vínculo — **derivado da autenticação, não do corpo**, sob
  pena de recriar F-19/F-24.
- *Autenticação:* `auth()` (`main.go:121-138`) teria de resolver credencial → organization e
  colocá-la no `r.Context()`, substituindo a comparação com a chave única (F-09). Esse é o ponto
  onde o escopo passa a ser confiável; sem ele, tudo o mais é teatro.
- *Entrada:* `processWebhook` (`webhook.go:155`) teria de resolver o tenant por
  `metadata.phone_number_id` (já disponível, `webhook.go:227`) **antes** de qualquer efeito, e a
  verificação HMAC (`webhook.go:136-146`) teria de usar o app secret daquele tenant — o que exige
  ou um endpoint por tenant, ou uma busca do secret por WABA ID (`entry.ID`, `types.go:13`) antes
  de validar.
- *Persistência:* coluna de organization nas três tabelas (`db.go:52-101`), no `dedupKey`
  (`queue.go:60`), na PK de `problem_orders` (`db.go:66`) e nas chaves dos seis stores em memória.

**15. O serviço precisaria de armazenamento próprio por tenant, ou bastaria receber tudo do painel?**
**Precisaria de armazenamento próprio**, e a evidência é concreta, não teórica. Três caminhos do
código produzem efeitos **sem uma requisição do painel em curso** — não há de quem "receber" o
escopo nesses momentos:

1. **Webhook de entrada** (`webhook.go:155`): chega da Meta. Para saber a quem pertence, o serviço
   precisa mapear `phone_number_id → organization` **localmente**.
2. **Verificação HMAC** (`webhook.go:138`): precisa do app secret **antes** de poder confiar no
   payload — logo, não pode vir do payload. Precisa estar armazenado.
3. **Retry automático** (`webhook.go:205-209` → `queue.go:129`): nasce dentro do serviço, a partir
   de um webhook de falha, e reenvia usando o remetente. Se o escopo não estiver persistido junto
   com o wamid (hoje `retryStore` é volátil, `retry.go:12-13`), não há de onde recuperá-lo.

Some-se a fila persistente (`db.go:83-100`), cujos itens são enviados minutos ou dias depois de
enfileirados, por um botão do dashboard (`main.go:95`). No mínimo, o serviço precisa de uma tabela
mapeando `organization_id → (phone_number_id, waba_id, app_id, access_token, app_secret,
verify_token, notify_number, reply_message, forward_url)` — **e o access token e o app secret
exigem cifra em repouso**, que hoje não existe em nenhuma forma no repositório (F-07).

**16. Quais achados alteram o custo de migração?**

*Barateiam (o que já está pronto):*
- **P-10** — o funil de uma função (`sender.go:21-51`) é o que torna o caminho de saída S em vez de L.
- **F-05 invertido** — o campo de roteamento (`metadata.phone_number_id`) **já chega e já está
  desserializado** (`types.go:32`, `webhook.go:227`). A correção é usar o que já se tem, não
  obter um dado novo.
- **P-07** — o encanamento de um campo de escopo ponta a ponta (`loja`) já existe em fila e
  problemas. Rebaixa F-12/F-22 de L para M.
- **P-01** — o HMAC já é correto e completo; só falta o segredo deixar de ser único.
- **P-02** — o padrão "receba, não descubra" já foi aplicado deliberadamente uma vez neste
  repositório, e documentado.
- **P-03/P-04** — o handler de upload já recebe identidade por requisição, já valida formato
  fail-closed e já tem testes. É o esqueleto onde a validação de ownership se encaixa.
- **Tamanho e limpeza** — 3.017 linhas, pacote único, zero dependências além de `pgx`
  (`go.mod:5`), `go build`/`go vet`/`go test` limpos. Não há camadas nem abstrações a desfazer.

*Encarecem:*
- **F-04** — o contrato de `/health` como fonte de identidade acopla a mudança ao painel: não dá
  para migrar um lado de cada vez.
- **F-02/F-07/F-21** — não existe nenhum armazenamento de credencial por tenant, nem cifra em
  repouso, nem rotação. É construção nova, não adaptação.
- **F-22/F-23** — DDL nas três tabelas + backfill + revisão das 11 consultas de `db.go`. A PK de
  `problem_orders` (`db.go:66`) muda, o que afeta o `ON CONFLICT` (`db.go:312`).
- **F-17/F-18** — três comportamentos (notificação, auto-resposta, repasse) são config global
  consumida na entrada; cada um vira config por tenant.
- **F-11** — seis stores a re-chavear, **se** a topologia for de processo compartilhado.

*Reescrita necessária (não adaptação):* o roteamento de entrada (`webhook.go:155-264`) e o
armazenamento de credenciais. *Mudança de contrato (adaptação):* todo o caminho de saída.

**17. Quais novos invariants?** — §6.

---

## 6. Invariants propostos

Redigidos para virarem teste ou lint. Cada um traz o mecanismo de verificação.

```text
INV-W1 — Nenhum caminho de envio lê a identidade do remetente de estado de processo.
Verificação (lint): grep/AST — nenhuma referência a cfg.PhoneNumberID, cfg.AccessToken ou
cfg.AppID fora do bootstrap (main.go) e da camada de resolução de tenant. Hoje falharia em
sender.go:24,36,388,418; media_upload.go:102,130; templates_management.go:61,125,168.
Verificação (teste): metaPost deve exigir um parâmetro de identidade; a compilação quebra se
alguém voltar a ler do global.
```

```text
INV-W2 — Dois envios de duas organizations usam dois phone_number_id distintos, e nenhum vem da
configuração do serviço. (Instanciação direta do INV-25.)
Verificação (teste): servidor HTTP falso no lugar da Graph API; duas requisições autenticadas como
orgs distintas; assertar que as URLs recebidas contêm os dois phone_number_id esperados, e que
desconfigurar META_PHONE_NUMBER_ID não altera o resultado.
```

```text
INV-W3 — Todo evento de webhook é atribuído a exatamente uma organization ANTES de qualquer efeito
colateral, por metadata.phone_number_id; um evento não atribuível é descartado e contabilizado.
Verificação (teste): payload com phone_number_id desconhecido → nenhum evento no store, nenhuma
chamada de saída, contador de rejeição incrementado. Hoje falharia: webhook.go:230 registra o
evento antes de qualquer verificação de escopo.
```

```text
INV-W4 — A verificação de assinatura nunca é opcional: sem segredo resolvido para o escopo, o
request é rejeitado.
Verificação (teste): app secret ausente + POST em /webhook → 403 e zero efeitos. Hoje o teste
falharia: webhook.go:136 pula a verificação inteira e segue para webhook.go:149.
Verificação (lint): proibir o padrão `if <segredo> != "" { <verificação> }` no pacote de webhook.
```

```text
INV-W5 — A identidade do tenant é derivada exclusivamente da autenticação do chamador, nunca de
campo do corpo, query ou header arbitrário.
Verificação (lint): nenhum campo de struct de request pode se chamar organization_id, tenant_id,
app_id, waba_id, phone_number_id ou loja. Hoje falharia em MediaUploadRequest.AppID
(media_upload.go:34), QueueAddRequest.Loja (queue.go:38) e no corpo de handleProblemsSync
(problems.go:237-240).
Verificação (teste): requisição autenticada como org A informando escopo da org B → 403, e nenhum
dado da org B lido ou apagado. Cobre F-19, F-12 e F-24.
```

```text
INV-W6 — Toda consulta e toda escrita no banco tem predicado de organization.
Verificação (lint): toda string SQL em db.go que contenha SELECT, UPDATE ou DELETE tem de conter
organization_id. Hoje falharia em db.go:133, 184 (DELETE FROM events sem WHERE), 243, 258, 339, 352.
Verificação (teste): dados de duas orgs no banco; toda função de leitura devolve só os da org
pedida.
```

```text
INV-W7 — Toda chave de estado em memória inclui a organization.
Verificação (teste): com duas orgs, assertar isolamento de evStore, msgQueue, problemStore,
retryStore e lastReplyAt. Especificamente: o cooldown de auto-resposta da org A não suprime a
resposta da org B para o mesmo telefone de cliente (hoje falharia — webhook.go:21).
Verificação (lint): nenhum map[string]... indexado por telefone ou por número de pedido sem o
organization_id no tipo da chave.
```

```text
INV-W8 — Deduplicação e remoção de duplicados nunca cruzam organizations.
Verificação (teste): duas orgs enfileiram o mesmo template para o mesmo telefone → dois itens
pendentes, nenhum marcado duplicate. Hoje falharia em queue.go:60-71 e queue.go:176-208.
```

```text
INV-W9 — O serviço não expõe identidade de tenant em endpoint não autenticado.
Verificação (teste): GET /health sem credencial → resposta sem phone_number_id, sem waba_id e sem
qualquer identificador de tenant. Hoje falharia em sender.go:447.
Verificação (lint): a resposta de handleHealth só pode conter chaves de uma allowlist fixa.
```

```text
INV-W10 — Credenciais de tenant nunca em texto claro em repouso, em log, em query string ou em
resposta de erro.
Verificação (teste): capturar o log de um ciclo completo (boot, envio, erro da Meta, upload) e
assertar que nenhum valor de credencial aparece; assertar que nenhuma URL construída contém
access_token= (hoje falharia em media_upload.go:101-102); assertar que corpos de erro da Meta são
sanitizados antes de writeError/log.Printf.
```

```text
INV-W11 — Um envio disparado internamente (retry, auto-resposta, notificação) carrega o escopo
persistido da mensagem que o originou, nunca um default de configuração.
Verificação (teste): reiniciar o processo entre o envio e o webhook de falha; o retry resultante
ainda deve usar o remetente da org correta. Hoje falharia em dois pontos: retryStore é volátil
(retry.go:12-13) e notifyOwner/maybeAutoReply leem cfg global (webhook.go:41,95).
```

```text
INV-W12 — Degradação de infraestrutura falha fechada ou é visível.
Verificação (teste): sem DATABASE_URL, ou /health reporta degraded, ou o boot aborta. Hoje o
serviço sobe silenciosamente em modo memória (db.go:18-22) e /health continua respondendo "ok"
(sender.go:446).
```

---

## 7. Esforço de migração por área (XS/S/M/L/XL — sem horas)

| # | Área | Esforço | Justificativa (com evidência) |
|---|---|---|---|
| 1 | **Identidade do remetente no caminho de saída** | **S** | Uma função (`sender.go:21-51`), 9 call sites. Nenhuma outra chamada a `/messages` no repositório (P-10). |
| 2 | **Remoção do contrato `/health` como fonte de identidade** | **XS** neste repo / **M** coordenado | A mudança em `sender.go:443-449` é trivial; o custo é a janela conjunta com o painel, que hoje lê dali. |
| 3 | **Rate limiting por remetente** | **S** | O `pacer` já é correto e testado (P-09); vira um mapa de pacers por `phone_number_id`. |
| 4 | **Autenticação do chamador com identidade de tenant** | **M** | `auth()`/`dashAuth()` (`main.go:121-138`, `dashboard.go:13-29`) passam de comparação com chave única a resolução credencial→org + contexto. Toca todos os 21 endpoints (`main.go:76-111`). |
| 5 | **Schema + backfill (3 tabelas, 11 consultas)** | **M** | `db.go:52-101` mais as consultas em `db.go:117,133,184,205,228,243,258,308,339,352`. Muda a PK de `problem_orders` (`db.go:66`) e o `ON CONFLICT` (`db.go:312`). Barateado por P-07. |
| 6 | **Re-chaveamento dos 6 stores em memória** | **M** (compartilhado) / **XS** (processo por tenant) | `store.go:34`, `queue.go:50`, `problems.go:57`, `retry.go:15`, `webhook.go:21`, `sender.go:18`. **Totalmente dependente da decisão de topologia (§1).** |
| 7 | **Config comportamental por tenant** (notify, auto-resposta, forward) | **M** | `main.go:60,63-66` → armazenamento por tenant; consumo em `webhook.go:41,95,255` precisa receber o escopo já resolvido. |
| 8 | **Roteamento do webhook de entrada** | **L** | Reescrita de `processWebhook` (`webhook.go:155-264`): resolução de tenant antes de qualquer efeito, e resolução do app secret **antes** da validação HMAC (`webhook.go:136-146`) — um problema de ovo-e-galinha que exige ou endpoint por tenant ou busca por `entry.ID`. |
| 9 | **Armazenamento de credenciais por tenant, cifrado, com rotação** | **L** | Construção nova: não há hoje nenhuma tabela, cifra ou caminho de rotação (F-07, F-21). Inclui gestão de chave de cifra, que o repositório não tem. |
| 10 | **De-branding e escopo dos 3 dashboards HTML** | **M** | ~50KB de HTML/JS embutido com marca fixa e links fixos (`dashboard.html:116,264`; `problems.html:79,148`; `automaticos.html:68`). Trabalho mecânico, mas volumoso. |
| 11 | **Suíte de testes dos invariants INV-W1..W12** | **M** | Hoje há 6 testes em 2 arquivos, cobrindo pacer e validação de appId. Não há nenhum teste de webhook, fila, store, envio ou banco — a base de partida é essencialmente zero para o que importa aqui. |
| 12 | **Correções de segurança independentes de tenancy** | **S** | F-06 (fail-closed), F-07 e F-09 (comparação em tempo constante), F-10 (chave fora da URL), F-20 (token em header), F-08 (idempotência). Baratas e não bloqueantes — podem ser feitas antes da migração. |

**Total agregado: L.** Concentrado em três itens (8, 9 e a topologia do item 6). Sem eles, seria M.

**Sequência que a evidência sugere** (recomendação, não estado observado): item 12 (independente) →
decisão de topologia → itens 1+2+4 juntos, na mesma janela do painel, porque o contrato de `/health`
não se parte ao meio → itens 5+7 → itens 8+9 → itens 3+6+10+11.

---

## 8. `NOT VERIFIED`

Cada item traz o que exatamente falta para verificá-lo.

1. **Topologia de deploy em produção** — um processo para todos os tenants, ou um por instalação?
   **Determina a estimativa de §7 em uma ordem de grandeza.** Não há manifesto de deploy no
   repositório: `find` por `*.yml`, `*.yaml`, `*.toml`, `Procfile` e `*.json` na raiz e um nível
   abaixo não retornou nada; o `Dockerfile` não revela orquestração. *Falta:* o painel da
   plataforma de hospedagem (Railway/Fly/Render/etc.) ou o repositório de infraestrutura.

2. **Valor de produção de `WEBHOOK_FORWARD_URL`** — e se ele carrega o `?secret=` que o painel
   compara. No `.env` local a variável está **vazia** (repasse desligado localmente). Confirmei o
   lado Go do contrato (o serviço não adiciona autenticação — `webhook.go:255-257`); o valor não.
   *Falta:* as variáveis de ambiente de produção.

3. **`META_APP_SECRET` está definido em produção?** Determina se a verificação HMAC está ligada ou
   se o webhook está aberto (F-06). O `.env` local define. *Falta:* variáveis de produção.

4. **`API_KEY` está definida em produção?** Determina se os 21 endpoints estão autenticados ou
   abertos (F-09). O `.env` local define. *Falta:* variáveis de produção.

5. **`DATABASE_URL` está definida em produção?** Determina se há persistência ou se o serviço roda
   em modo memória com perda silenciosa no restart (F-26). O `.env` local **não** define. *Falta:*
   variáveis de produção.

6. **Natureza do access token da Meta** — System User token (sem expiração) ou token de usuário
   (60 dias)? Determina se F-21 é latente ou ativo. *Falta:* Meta Business Manager → Usuários do
   sistema.

7. **A Meta ecoa a URL da requisição em corpos de erro do endpoint de upload?** Determina se
   F-20 é uma exposição real do token ou apenas o risco genérico de credencial em query string.
   *Falta:* uma chamada real ao endpoint de upload com parâmetros inválidos — não executada por ser
   uma auditoria read-only contra uma API de produção.

8. **O painel envia `loja` em todas as chamadas de `/queue/add`?** O lado Go aceita o campo como
   opcional (`queue.go:38`, sem validação em `dashboard.go:63-66`). Se o painel omitir em algum
   caminho, o único campo com cara de escopo fica vazio nesses registros. *Falta:* o repositório do
   painel (`server.js`), fora do escopo desta auditoria.

9. **O lado do painel do contrato de `/health`** — o brief cita `server.js:15213`; não li o
   repositório do painel. Tudo o que afirmo sobre o painel nesta auditoria vem do brief, não de
   observação própria, e está identificado como tal.

10. **Quantos apps/WABAs da Meta a conta comercial possui** — determina se um segundo tenant usaria
    um `appId` diferente (tornando F-19 material) ou o mesmo app com outro número. *Falta:* Meta
    Business Manager.

11. **`teste_envio.py`** (5.850 bytes, presente em disco, listado no `.gitignore:5`) — não o
    auditei. Não é parte do artefato construído: o `Dockerfile:6` copia apenas `*.go *.html`.
    Registro a existência para que não passe por omissão.

12. **Comportamento em produção sob concorrência real** — `processWebhook` roda em goroutine solta
    sem limite (`webhook.go:152`) e `http.Post` do repasse não tem timeout (`webhook.go:256`).
    Não executei teste de carga. *Falta:* teste de carga ou métricas de produção.

---

*Auditoria read-only. Nenhum arquivo do repositório `whatsapp-webhook-go` foi modificado, criado ou
removido. Único artefato escrito: este documento, no repositório do painel.*
