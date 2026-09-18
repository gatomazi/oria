# Aceite do convite de owner — Tenant Plane

> Contrato da rota que **consome** o convite emitido pelo control plane.
> Complementa `docs/architecture/control-plane.md` §3.6/§15, que descreve a **emissão**.
>
> Código: `apps/panel/lib/auth/invites.js` · rotas em `apps/panel/lib/auth/router.js` ·
> migration `apps/panel/migrations/sql/0020-convite-aceite.{up,down}.sql` ·
> tela `apps/panel/src/pages/convite/AceitarConvitePage.tsx` ·
> testes `apps/panel/test/invariants/convite-aceite.test.js`.

---

## 1. Onde isto fecha

O control plane (`apps/platform-admin`) cria a Organization e emite o convite; a resposta traz o
token cru **uma única vez**. Até aqui o convite existia e **não podia ser aceito por interface
nenhuma** — era o limite declarado no §13 do contrato do control plane.

O aceite é do **Tenant Plane** porque é aqui que existe `users`, `sessions`, senha e membership. O
control plane não ganha rota nova, não ganha campo novo e não é alterado por este trabalho.

```text
Oria Admin  ──emite──▶  token cru (entregue por fora, uma vez)
                             │
                             ▼
Oria Panel  ──POST /api/admin/convite/consultar──▶  o que é este convite (não consome)
            ──POST /api/admin/convite/aceitar ──▶  conta + membership + sessão (consome)
```

---

## 2. As duas rotas

Ambas são **anônimas** (é o ponto: quem aceita pode ainda não ter conta) e ambas são **POST**,
nunca GET: o token é o segredo, e segredo em URL vira histórico do navegador, `Referer`, log do
proxy e log de acesso do Railway.

| | `POST /api/admin/convite/consultar` | `POST /api/admin/convite/aceitar` |
|---|---|---|
| corpo | `{ token }` | `{ token, senha?, nome? }` |
| consome? | **não** (só trava a linha até o fim da transação) | **sim** |
| 200/201 | `{ email, papel, organizationNome, contaExistente, autenticadoComo }` | `201 { ok, user, organizationId, organizationNome, papel, contaCriada, csrfToken }` + `Set-Cookie` |
| corpo com campo extra | `400 campos_nao_aceitos` | `400 campos_nao_aceitos` |

`consultar` existe para a tela saber **qual formulário mostrar** (senha nova × "entre na conta que
já existe") sem gastar o convite. Ela responde a token inválido exatamente como `aceitar`.

`organizationId` no corpo é campo **não aceito** — não é ignorado, é recusado. A Organization vem
do convite lido no banco.

---

## 3. Quem aceita — a identidade é o e-mail do convite

O convite carrega `email` e `papel`. O e-mail é lido **do banco**, nunca do request.

| situação | o que acontece |
|---|---|
| e-mail **sem** conta, sem sessão | cria a conta com a senha definida agora, cria o membership, abre sessão |
| e-mail **com** conta, sem sessão | `409 conta_existente` — "entre nessa conta e aceite de novo". A senha **não** é tocada |
| sessão autenticada **do mesmo** e-mail | aceita; a senha não é pedida nem aceita (`400 senha_nao_aceita`) |
| sessão autenticada de **outro** e-mail | `403 convite_de_outra_conta`; o convite continua pendente |

A regra que isto protege: **o aceite nunca pode virar um jeito de assumir a conta de outra
pessoa.** "Tem um token, então troca a senha" é exatamente o desenho que permitiria isso — e é por
isso que uma conta existente exige autenticação prévia, pelo login normal, com rate limit e tudo.

Simétrico: o token também não transfere o convite para quem estiver logado no navegador. A sessão
precisa ser **daquele** e-mail.

O membership nasce com o `papel` do convite (`owner` | `member`), sob `ON CONFLICT DO NOTHING`, e
a sessão passa a apontar para a Organization do convite — o mesmo `UPDATE sessions SET
active_organization_id` do `POST /session/organization`, com o valor vindo do banco.

Organization suspensa: `409 organization_indisponivel`, com ROLLBACK. `auth_memberships` só devolve
Organizations ativas, então o membership nasceria invisível e a pessoa entraria sem workspace. O
convite continua valendo para quando a Organization voltar.

---

## 4. O que o token prova

O token é `crypto.randomBytes(32).toString('base64url')` (256 bits, 43 caracteres), gerado pelo
control plane. No banco existe **só** `sha256(token)` em hex — `token_hash TEXT UNIQUE CHECK
(token_hash ~ '^[0-9a-f]{64}$')`.

O aceite usa a **mesma expressão** da emissão:

```js
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
```

O que viaja para o Postgres é o hash. Não existe `WHERE token = $1`, não existe comparação de texto
com o que veio do cliente, e o token cru não aparece em log, auditoria, resposta nem chave de rate
limit. Um teste lê `apps/platform-admin/lib/organizations.js` e reprova se a expressão da emissão
mudar sem o aceite mudar junto.

---

## 5. O que o convidado vê quando falha

`platform_convite_pendente` e `platform_consumir_convite` devolvem
`ok | desconhecido | usado | revogado | expirado`. Os **quatro** motivos de falha viram a **mesma
resposta**:

```http
404  { "error": "convite inválido, expirado ou já usado", "codigo": "convite_invalido" }
```

Token malformado (tamanho ou alfabeto errado) responde igual, sem tocar o banco. Quem tenta não
distingue "este token nunca existiu" de "este token já foi usado" — a distinção diria, a quem
tivesse um link vazado, se vale a pena continuar.

O motivo real vai para o log do servidor:

```text
[CONVITE] /convite/aceitar recusado: convite_invalido (expirado) ref=3f2a10bb44c1
```

`ref` são os **12 primeiros hex** do hash. Não é o token (que nunca é logado) e não é o hash
inteiro (que é a chave da linha no banco: um log com ele seria um log com a credencial).

Os códigos que **não** são genéricos — `conta_existente`, `convite_de_outra_conta`,
`senha_nao_aceita`, `senha_invalida`, `organization_indisponivel`, `campos_nao_aceitos` — só
aparecem para quem **já provou ter um convite válido**, ou para quem errou o próprio formulário.
Nenhum deles ajuda a descobrir se um token existe.

---

## 6. Rate limit

`lib/auth/rate-limit.js` · `createConviteLimiter()` — mesmo balde de dois níveis do login, em
memória, processo único.

**Chave:** `convite:` + os 12 primeiros hex do `sha256(token)`.

- **Não o IP.** Atrás do proxy do Railway, `req.ip` é o endereço do proxy (QW-01): um balde único
  para o mundo, que o primeiro erro de qualquer pessoa fecharia para todas.
- **Não a conta.** O e-mail é do convite, e só é conhecido depois de consultá-lo no banco — é
  justamente a consulta que está sendo limitada.
- **O hash, não o token.** O balde é uma estrutura em memória, inspecionável em heap dump e em log
  de erro. O prefixo curto separa convites sem reconstruir o que está gravado.

| balde | limite | o que ele faz |
|---|---|---|
| por chave | 10 / 15 min | freia o **loop** em cima de um mesmo token — o caso do link vazado |
| global | 60 / min | é a defesa real contra **varredura**: cada token chutado é uma chave nova, então só o balde global a vê |

Com 256 bits de token o chute não tem chance estatística; o limite existe para que a tentativa não
custe CPU e conexão de banco. Os baldes são **separados** dos do login: uma varredura de convites
não consome a franquia de quem está tentando entrar, e vice-versa.

Só falhas contam. Uma consulta bem-sucedida do mesmo convite válido é limitada apenas pelo balde
global — ela não escreve nada e quem a faz já tem o token.

---

## 7. A migration 0020 — e por que o GRANT não está nela

### 7.1 O que a migration acrescenta

`platform_consumir_convite(hash, user)` exige o UUID do usuário (`CHECK ((usado_em IS NOT NULL) =
(usado_por IS NOT NULL))`). Mas **quem aceita pode não ter conta ainda**: para criar a pessoa é
preciso o e-mail do convite, e para saber o e-mail seria preciso consumi-lo.
`organization_owner_invites` é global **privada** — a role da aplicação não lê a tabela, e não deve.

A 0020 acrescenta a leitura que faltava, com a mesma projeção e o mesmo vocabulário de `motivo`:

```sql
platform_convite_pendente(hash)        -- SECURITY DEFINER, FOR UPDATE, não escreve
  … a rota cria/resolve o usuário …
platform_consumir_convite(hash, user)  -- grava usado_em/usado_por
```

As duas rodam na **mesma transação**. O `FOR UPDATE` da primeira é o que torna o par atômico: um
segundo aceite concorrente espera o COMMIT/ROLLBACK do primeiro e então lê a linha já marcada,
devolvendo `usado`. Qualquer ROLLBACK devolve o convite intacto — inclusive o das recusas do §3.

A 0020 não toca a 0019 (já mergeada em `main`), não cria tabela, não altera coluna e não mexe em
dado. O `.down.sql` é um `DROP FUNCTION`.

### 7.2 O GRANT

**Decisão: o `GRANT EXECUTE` para `oria_app` NÃO vai numa migration.** Ele entra em
`apps/panel/lib/platform/app-role.js` → `FUNCOES_DA_APLICACAO`, que é o SQL do **OPS-14**.

É o precedente do repositório, não uma escolha nova: `auth_memberships(UUID)`,
`onboarding_consumir_convite(TEXT)`, `job_lease_adquirir(...)` e todas as outras `SECURITY
DEFINER` que o painel chama são concedidas exatamente ali. O cabeçalho do arquivo diz por quê —
*"role é objeto do cluster e a senha não pode morar no repositório"*.

E, concretamente, uma migration com `GRANT … TO oria_app` estaria **errada** neste repositório:

1. **A role pode não existir quando a migration roda.** Em produção o OPS-14 é a RELEASE F, ainda
   não executada (`docs/productization/production-rollout-runbook.md` §14): hoje a `DATABASE_URL`
   é a role dona. Uma migration que referencia `oria_app` quebraria o pre-deploy de todo ambiente
   anterior à F — e de todo banco novo, de todo dev box.
2. **O nome da role não é fixo.** `scripts/test-db.mjs` provisiona `oria_app`, mas
   `auth-flow.test.js` e `tenancy-db-negative-controls.test.js` sorteiam nomes
   (`oria_app_auth_<hex>`). Uma migration só pode escrever um nome literal.
3. **Uma versão condicional (`DO $$ IF EXISTS (pg_roles) $$`) não provaria nada.** Seria um no-op
   em CI, e `npm run test:app-role` continuaria dependendo do registro em `app-role.js` para
   passar. Duas fontes de verdade, uma delas inerte.

O que garante que o GRANT não seja esquecido é o teste, não a migration:
`test/invariants/convite-aceite.test.js` provisiona a role pelo SQL real de `app-role.js` e checa
`has_function_privilege` nas duas funções — e `npm run test:app-role` roda a suíte inteira sob
`oria_app`. Tirar as duas linhas de `FUNCOES_DA_APLICACAO` faz esse arquivo reprovar (controle
negativo executado, §9 do relatório da rodada).

### 7.3 Manifesto de tenancy

Nada a declarar: `organization_owner_invites` já está em `TABELAS_GLOBAIS` (com motivo) e em
`TABELAS_GLOBAIS_PRIVADAS`; `organization_members`, `organizations` e `audit_log` já estão sob RLS;
`users` e `sessions` já são `TABELAS_GLOBAIS_DA_APLICACAO`. A 0020 não cria tabela — só uma função.
Um teste deste trabalho reafirma que a tabela de convites continua **ilegível** pela role da
aplicação: o acesso é só pela projeção estreita das duas funções.

---

## 8. Alternativas descartadas

**1. O painel ter a sua própria tabela de convites.** Duplicaria o estado que o control plane já é
dono de emitir, reemitir e revogar: uma revogação no Admin não alcançaria a cópia do painel. O
convite é um objeto do control plane; o painel o **consome**, não o possui. (Isto não contradiz a
separação de planos: o reuso entre os dois apps acontece **pelo banco**, via funções `SECURITY
DEFINER`, que é o que o §1.1 do contrato do control plane já estabelece.)

**2. Consumir primeiro e criar a conta depois.** É o que evitaria a 0020 — e quebra na primeira
falha: o `CHECK` da tabela não aceita `usado_por` nulo, e se o INSERT em `users` falhasse o convite
já teria sido gasto. A ordem "ler travando → resolver a pessoa → consumir" mantém tudo numa
transação só.

**3. O convidado digitar o próprio e-mail, e o aceite conferir contra o do convite.** Também
evitaria a 0020. Descartada porque troca uma leitura do banco por um dado do cliente: a identidade
passaria a depender do que foi digitado, e a UX ficaria pior (o convidado teria de acertar a grafia
exata). O e-mail do convite é autoridade; ele se lê, não se informa.

**4. Redefinir a senha quando o e-mail já tem conta.** É o desenho que transforma um convite em
tomada de conta. Recusado por escrito no §3.

**5. Um link `/admin/convite?token=…`.** O token no query string entra em log de acesso, `Referer`
e histórico. A tela aceita o **fragmento** (`/admin/convite#<token>`), que o navegador não envia ao
servidor, e o apaga da barra de endereço assim que o lê; colar o código à mão continua funcionando.

**6. `sessions.metodo = 'convite'`.** Exigiria alterar o `CHECK` de uma tabela viva (0011) só para
renomear o que já é verdade: a sessão nasce de uma senha que a pessoa acabou de definir. Quem veio
de convite está registrado na auditoria (`org.invite.accept`, com `contaCriada`).

**7. Rate limit por IP.** Ver §6: atrás do proxy, seria um balde único para todo mundo.

---

## 9. A tela

`/admin/convite` — rota **anônima** do SPA (fora do `ProtectedRoute` e fora do `AppShell`). Usa o
mesmo painel do login e da escolha de workspace (`.ad-login*`, `admin-shell.css`) e os componentes
do DS (`Field`, `Input`, `Button`, `Callout`); nenhum visual novo.

Passos: colar o código (ou abrir `/admin/convite#<token>`) → `consultar` → a tela mostra para quem
é o convite e em qual Organization, e então pede **senha nova**, ou oferece **ir para o login**
(conta existente), ou **sair desta conta** (sessão de outro e-mail), ou o botão de **aceitar**
(sessão do e-mail certo). Ao concluir, recarrega o SPA em `/admin` com a sessão nova.

Para acomodar a rota anônima, `App.tsx` passou a ter o `ProtectedRoute` como **rota-mãe** das telas
do painel (`<Route element={<PainelAutenticado />}>`) em vez de envolver o `<Routes>` inteiro.
Nenhuma tela existente mudou de caminho.

---

## 10. O passo-a-passo do owner

1. Recebe o código de convite de quem administra o Oria (uma vez; não é recuperável).
2. Abre `https://app.oria.com.br/admin/convite`.
3. Cola o código e clica em **Continuar**. A tela confirma o e-mail e a Organization.
4. Define a senha (mínimo 12 caracteres), opcionalmente o nome, e clica em **Criar conta e entrar**.
5. Cai no painel, já com a Organization do convite ativa.

Se o e-mail já tiver conta no Oria: entra na conta pelo login normal, volta a `/admin/convite`,
cola o código e clica em **Aceitar convite**. A senha da conta não é alterada em nenhum momento.
