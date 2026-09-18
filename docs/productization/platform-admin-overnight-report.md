# Oria Admin — relatório da execução noturna (17→18/09/2026)

Resposta ao §40 do comando
[`claude-execucao-noturna-oria-admin-pronto-para-use-origens.md`](../../apps/panel/docs/commands-produtizacao/claude-execucao-noturna-oria-admin-pronto-para-use-origens.md).

> **Resumo em uma linha:** o Oria Admin está **pronto e não deployado**. Todo o produto existe,
> está testado e está no `main`; o que falta é criar o service no Railway, e isso depende de dois
> cliques no dashboard que o CLI não faz.

---

## 1. Oria Admin — **PARTIAL**

Código, banco, API, interface e testes: prontos. Deploy: não feito. Nada bloqueia o deploy além
da criação do service.

O fluxo agora fecha ponta a ponta: o Admin cria a Organization e emite o convite, e o owner
consegue **aceitar** pelo painel (seção 33).

## 2. Branch / HEAD

`main`, HEAD `b20afcf`. As branches de trabalho (`feature/platform-admin`, `refactor/panel-flatten`)
já foram integradas.

## 3. Merge para `main`

Feito, em três merges explícitos (`--no-ff`):

| merge | o que traz |
|---|---|
| `8bc76ce` | refatoração estrutural do painel (um deployable só) |
| `217dc8b` | backend do control plane |
| `e3db5b4` | interface do control plane |

As duas frentes não compartilharam **nenhum** arquivo — verifiquei antes de mesclar, e não houve
conflito entre elas.

## 4. Push

Feito. `origin/main` = `7422bf5` no momento da escrita; o merge do aceite do convite (`0c36145`)
sobe em seguida.

## 5. CI — **verde**

`b20afcf`: os cinco jobs passaram (painel, control plane, contratos/autocontenção, Gerador, Go).

Antes disso o CI reprovou duas vezes, e as duas eram achados legítimos do merge — nenhum deles
apareceria sem juntar as frentes:

1. **Dry-run do runbook.** O teste exigia `No migrations to run!` na RELEASE D'. Isso só valia
   enquanto o HEAD tivesse o mesmo schema da D0; a primeira migration nova depois dela (a do
   control plane) derrubou o teste sem que nada estivesse errado. A expectativa passou a ser
   derivada do repositório (migrations do HEAD menos as da D0), então continua valendo conforme o
   schema andar — e o que o teste guarda segue sendo o essencial: nenhuma migration **inesperada**
   roda naquele degrau.
2. **Falso positivo de vazamento de segredo.** A conferência procurava a senha do banco solta no
   texto. A senha do Postgres de teste é palavra de dicionário (no CI, `teste`), e o pre-deploy
   passou a imprimir o SQL de uma migration cujos comentários dizem "o teste compara as duas".
   Agora procura `usuario:senha@`, que é a forma em que credencial vaza de verdade; os segredos
   longos e aleatórios continuam conferidos sozinhos.

Também corrigi o `test:negative` do control plane, que não subia banco: o script exigia
`ADMIN_TEST_DATABASE_URL` e a própria mensagem de erro mandava rodar pelo comando que não a
definia.

**Corrigi uma lacuna aqui:** os 110 testes do control plane **não eram executados por ninguém** —
nem pelo `test-all.mjs`, nem pelo CI. Agora há um job próprio (`a7c2e23`) rodando a suíte e os
controles negativos. Suíte que não roda deixa de valer em semanas, sem aviso.

## 6. Railway — deploy **NÃO FEITO**

O service `oria-admin` não existe. A especificação completa está em
[`infra/railway/services.md`](../../infra/railway/services.md).

Por que não criei sozinho: `railway add --service --repo` cria o service mas **não** define o Root
Directory, e sem ele o build sai da raiz do monorepo e falha com "No start command detected" —
exatamente o erro do primeiro deploy do painel. Criar um service quebrado não adianta nada.

## 7. URL / health

Não aplicável ainda. Quando subir: `GET /health` responde `{"status":"ok"}` mesmo sem nenhum admin
cadastrado — deliberado, para o Railway não marcar unhealthy e reiniciar em laço enquanto o
bootstrap não acontece.

**Os outros três serviços seguem no ar.** O painel foi verificado depois do merge estrutural:
`/` landing, `/admin` SPA, `/hotpix/{id}` responde, `/{id}` 404, código-fonte não exposto.

## 8. Auth do Platform Admin

Pronta e isolada do painel em tudo: tabela própria (`platform_admin_sessions`), cookie host-only
`__Host-oria_platform_session` (sem `Domain`, `Secure`, `HttpOnly`, `SameSite=Strict`), segredo
próprio (`PLATFORM_ADMIN_SESSION_SECRET`). Token opaco de 256 bits, só o SHA-256 no banco. CSRF é
HMAC vinculado à sessão. Sessão nova a cada login (anti-fixation). Um token de sessão do painel
apresentado aqui não encontra linha nenhuma — há teste para isso.

Senha: scrypt com os parâmetros da OWASP, hash de referência para o login custar o mesmo tempo com
e-mail inexistente, comparação em tempo constante. Rate limit por **conta** (não por IP — atrás do
proxy do Railway o IP é o do proxy).

## 9. Bootstrap

`npm run platform-admin:bootstrap` em `apps/platform-admin`, com `PLATFORM_ADMIN_EMAIL` e
`PLATFORM_ADMIN_PASSWORD` como entrada do comando. Idempotente, nunca imprime a senha, não existe
senha padrão, o primeiro nasce `platform_owner`. **As duas variáveis não vão para o Railway** —
seriam a senha do dono da plataforma guardada em texto no painel de infraestrutura.

Sem admin nenhum, o login responde `503 bootstrap_pendente` e a tela explica isso.

## 10. Migrations

`1790000400000_platform-admin` (+ `sql/0019-*.{up,down}.sql`): 9 tabelas de plataforma, índices
parciais (uma assinatura ativa por organization, um convite pendente por e-mail), domínio
`platform_feature`, e **trigger** protegendo o último `platform_owner` — a regra vale mesmo para
quem editar por SQL.

O schema é do **painel**: as migrations rodam no pre-deploy do `oria-panel`. O Admin apenas
verifica que rodaram e morre no boot, com mensagem explícita, se não rodaram.

## 11-13. Planos, plano `internal`, entitlements

Planos: criar, editar, substituir features, arquivar (mutações só para `platform_owner`).

O plano técnico `internal` é semeado com exatamente as 10 features do Tenant #1, e um teste compara
a lista com `config/entitlements/tenant1-entitlements.json`. **Não é allow-all:** `instagram` e
`advancedAutomations` ficam de fora e são negadas como qualquer ausência.

Resolver de entitlements: `override > plano > false`. A UI mostra a origem de cada feature.

## 14-16. Criação da Organization, Store 1:1, convite do owner

Uma transação só: Organization + Store + assinatura + estado de onboarding + convite do owner +
auditoria. Qualquer falha desfaz tudo, inclusive o convite.

**Bug corrigido esta noite (`167baa7`):** reenviar o mesmo formulário (clique duplo, refresh, retry
de rede) respondia `409 bootstrap_interno_indisponivel` em vez de devolver a Organization já criada
— o gate rodava antes da reserva de idempotência. Quem estivesse do outro lado não teria como saber
se o primeiro envio funcionou, justamente na operação que se faz **uma vez**. A reserva passou para
a frente do gate; o gate não afrouxou (chaves diferentes continuam disputando o mesmo advisory
lock). O teste que existia rodava com `SECOND_TENANT_ENABLED=1`, que pula o gate — por isso não
pegava. O novo cobre o caminho real, e foi validado por controle negativo.

Convite: o token aparece **uma vez**; no banco só existe o hash.

## 17. Gate do segundo tenant

`SECOND_TENANT_ENABLED` desligado. O bootstrap interno só funciona enquanto **não há nenhuma**
Organization — e o gate não olha o nome: "Use Origens" não recebe tratamento especial (há teste
provando isso). Valor inválido na variável derruba o boot: não existe "ligado por engano".

## 18. Suspensão / reativação

Implementadas, com motivo obrigatório (4–500 chars), efeito nos entitlements efetivos e registro em
auditoria. Suspender não apaga nada.

## 19-22. Integrações, onboarding, jobs/webhooks, auditoria

Leitura, com filtros e paginação por cursor. Auditoria com vocabulário fechado de ações e drawer de
antes/depois. Onboarding é somente leitura nesta versão (não existe "marcar como concluído").

`lastTestEm`/`lastSuccessEm` vêm sempre `null` porque a coluna não existe: a UI mostra vazio e
explica, em vez de derivar de `atualizadoEm` e exibir dado fabricado.

## 23. Rotas do frontend

18 arquivos em `apps/platform-admin/public/`, **sem build step e sem nenhum recurso externo**:
login, visão geral, organizations (lista + detalhe com 7 abas), planos, platform admins, e seis
telas de observabilidade. 35 das 40 rotas da API têm tela; as 5 restantes são o `/health` e
agregados que o detalhe já devolve.

Há selo **Control plane** em dois pontos da casca: o operador não confunde esta superfície com o
painel do lojista.

## 24. Testes

| suíte | resultado |
|---|---|
| control plane | **130/130** (110 backend + 19 interface + 1 do fix desta noite) |
| painel | **908/908**, 0 skipped — e **908/908** também sob a role `oria_app` |
| invariantes de migration do painel (na árvore mesclada) | 30/30 |
| contratos cross-service + `repo:self-check` | OK |

Piso do gate: **908**.

## 25. Controles negativos

**20 no control plane** (15 do backend + 5 da interface), todos executados no ciclo de 5 passos.
Três precisaram ser **fortalecidos** porque não detectavam o defeito que deveriam pegar:
`bypassrls` casava com o próprio comentário, `secret-response` só conferia valores conhecidos, e o
de path traversal não pegava nada sozinho (a normalização da URL já resolvia) — foi refeito para o
par realista de `decodeURIComponent` + conferência removida, e aí sim reprova.

Mais um controle negativo executado por mim no fix de idempotência: com o gate de volta na frente
da reserva, a suíte reprova exatamente o teste novo (1 falha em 17), e volta a passar com a
correção.

## 26. Build

`npm run build` do painel (`tsc -b && vite build`) OK, `dist/` no lugar. O control plane não tem
build: o `build` dele apenas verifica que os 15 módulos carregam.

## 27. `repo:self-check`

OK — 561 arquivos varridos, snapshots do histórico legado conferem com o manifesto, e a regra nova
reprova se `apps/panel/admin/` voltar a existir.

## 28. Regressões no painel

Nenhuma. A suíte completa do painel (908) rodou depois da refatoração estrutural, e os invariantes
tocados pela migration do control plane rodaram de novo na árvore mesclada.

## 29. Commits

24 commits novos em `main` desde `1c74ec1`, incluindo os três merges. Nenhum segredo, nenhum valor
real de variável.

## 30. Blockers

1. **O service `oria-admin` não existe** — único bloqueio real para abrir o Admin no navegador.
2. ~~O convite não pode ser aceito pela interface~~ — **resolvido** (`0c36145`). Ver a seção 33.
3. ~~CI em execução~~ — **resolvido**: verde nos cinco jobs em `b20afcf`.

## 31. O que você precisa fazer amanhã

1. **Criar o service** `oria-admin` no dashboard do Railway: repo `gatomazi/oria`, **Root
   Directory `apps/platform-admin`**, ingress público. Build `npm ci`, start `npm start`, health
   `/health`. (Depois disso, variáveis e domínio podem ir pelo CLI.)
2. **Variáveis:** `DATABASE_URL` (o mesmo Postgres do painel), `PLATFORM_ADMIN_SESSION_SECRET`
   (gerado na hora, ≥ 32) e `PLATFORM_ADMIN_URL`.
3. **Rodar o bootstrap** do primeiro admin, com e-mail e senha escolhidos por você.
4. **Entrar e conferir** a visão geral: *Bootstrap interno: disponível*. Se disser "indisponível",
   já existe uma Organization — pare e investigue antes de criar qualquer coisa.
5. **Criar a Use Origens** (o passo a passo campo a campo está na seção 5 de
   [`platform-admin-bootstrap.md`](../operations/platform-admin-bootstrap.md)). Copiar o token do
   convite: ele aparece **uma vez**.
6. **Decidir a marca:** o painel ainda diz "Orgulho Regional" no título da aba, na tela de login e
   como nome de produto padrão. Não mexi porque o texto é escolha sua — mas o default de
   `productName` num SaaS multi-tenant provavelmente deveria ser "Oria", não a marca do primeiro
   cliente.

## 32. GO / NO-GO para cadastrar a Use Origens manualmente

**GO condicional.** O produto está pronto e provado; o condicional é operacional, não de qualidade:
criar o service e rodar o bootstrap. Depois disso o fluxo inteiro funciona — inclusive o aceite do
convite pelo owner, que aterrissou ainda nesta madrugada (seção 33).

Nada de Tenant #1 foi criado automaticamente. Nenhuma Organization existe.

---

## 33. Aceite do convite — fechado depois do relatório original

Duas rotas anônimas no painel, ambas **POST** (token em URL vira histórico, `Referer` e log de
acesso): `/api/admin/convite/consultar`, que **não** consome e só mostra para quem é o convite, e
`/api/admin/convite/aceitar`, que consome.

O que ficou travado por decisão, não por acaso:

- **A identidade é o e-mail do convite, lido do banco.** Se aquele e-mail já tem conta, o aceite
  responde `409 conta_existente` e **não toca na senha** — "tem token, logo troca a senha" é
  exatamente como se toma a conta de outra pessoa. A pessoa entra pelo login normal e volta.
- **Falha não diz qual falha.** `desconhecido`, `usado`, `revogado` e `expirado` devolvem a mesma
  resposta, byte a byte (há teste comparando as quatro). O motivo real vai só para o log, com uma
  referência curta derivada do hash — nunca o token, nunca o hash inteiro.
- **A tela usa o fragmento da URL** (`/admin/convite#<token>`), que o navegador não envia ao
  servidor, e o apaga da barra assim que lê.
- Tudo numa transação: se qualquer passo falhar, o convite **volta a valer**.

O `GRANT` da função do control plane foi para o SQL do OPS-14 (`app-role.js`), não para uma
migration — a role `oria_app` ainda não existe nos ambientes anteriores à RELEASE F, e uma
migration com `GRANT … TO oria_app` quebraria o pre-deploy de todo banco novo. Foi preciso uma
migration nova (`0020`) por outro motivo: uma função de **consulta** que trava a linha sem consumir,
porque quem aceita normalmente ainda não tem conta e o e-mail precisa vir do banco.

Verificado no Chrome de verdade, não por curl: token no fragmento → tela confirma e-mail e
Organization → senha definida → painel aberto com a Organization do convite ativa, e `audit_log`
com `org.invite.accept` sem token.

**Suíte do painel: 934/934**, incluindo sob a role `oria_app`. Piso do gate em 934.
