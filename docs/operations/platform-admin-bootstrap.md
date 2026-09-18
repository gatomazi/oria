# Bootstrap do Oria Admin (Control Plane)

Como colocar o `oria-admin` de pé e criar o **primeiro platform admin**, sem senha padrão e sem
que a senha apareça em lugar nenhum.

Contrato da API e modelo de dados: [`docs/architecture/control-plane.md`](../architecture/control-plane.md).

---

## 1. O que o processo exige para subir

O Oria Admin **não sobe** em produção sem:

| variável | por quê |
|---|---|
| `DATABASE_URL` | o mesmo Postgres do painel; o boot verifica que as migrations rodaram |
| `PLATFORM_ADMIN_SESSION_SECRET` | ≥ 32 caracteres; assina o token CSRF vinculado à sessão |
| `PLATFORM_ADMIN_URL` | `https://admin.oria.com.br` — identidade canônica do app |

E **não exige** que já exista um platform admin. Sem nenhum:

```text
o processo sobe
GET /health responde {"status":"ok"}
POST /api/platform/auth/login responde 503 bootstrap_pendente
```

Essa separação é deliberada: um service que não sobe por falta de conta é um service que o Railway
marca como unhealthy e reinicia em laço. O que fica indisponível é o **login**, não o processo.

Opcionais:

| variável | padrão | nota |
|---|---|---|
| `PORT` | `8080` | |
| `PLATFORM_ADMIN_SESSION_TTL_HOURS` | `8` | 1..24 |
| `SECOND_TENANT_ENABLED` | `0` | `1` libera criação de Organization externa |
| `ONBOARDING_STEP_REQUIREMENTS` | — | JSON com o requisito de cada passo; sem ele, a criação exige `passos` no request |
| `APP_URL` / `PUBLIC_SITE_URL` | — | só para **negar** essas origens em mutações |
| `PLATFORM_ADMIN_STATIC_DIR` | `public/` | onde está o build do frontend |

Valor inválido em `SECOND_TENANT_ENABLED` (nem `0`/`1`/vazio) **derruba o boot**. Não existe
"desligado por engano" nem "ligado por engano".

---

## 2. Migrations

O schema é do **painel** — inclusive as tabelas do control plane. Antes de subir o `oria-admin`:

```bash
npm --prefix apps/panel run migrate:up      # DATABASE_URL apontando para o banco do painel
```

O boot do Admin verifica que `1790000400000_platform-admin` foi aplicada. Se não foi, o processo
morre com mensagem explícita, **antes** de anunciar a porta:

```text
[BOOT] Postgres indisponível ou desatualizado: migration 1790000400000_platform-admin não aplicada …
```

Um service que aceita requisições com o schema errado é pior do que um service que não sobe.

---

## 3. Criar o primeiro platform admin

```bash
cd apps/platform-admin
DATABASE_URL='postgres://…' \
PLATFORM_ADMIN_EMAIL='voce@exemplo.com' \
PLATFORM_ADMIN_PASSWORD='<a senha que você escolher>' \
npm run platform-admin:bootstrap
```

Saída de sucesso:

```text
[bootstrap] platform admin criado: voce@exemplo.com (papel=platform_owner). A senha não é exibida.
```

O que o script garante:

- **Sem as duas variáveis, recusa e explica.** Não inventa e-mail, não inventa senha, e não existe
  senha padrão neste projeto.
- **A senha nunca é impressa** — nem no sucesso, nem no erro, nem em stack trace.
- **Idempotente.** Rodar de novo com o mesmo e-mail responde `já existe` e **não troca a senha**
  (trocar senha é outra operação, deliberada) e não duplica.
- **O primeiro nasce `platform_owner`**; do segundo em diante, `platform_operator` — salvo
  `PLATFORM_ADMIN_ROLE` explícito.
- Senha mínima de 12 caracteres (mesma regra do painel; scrypt com os parâmetros da OWASP).
- Corrida com outro bootstrap: quem perder responde "outro processo criou primeiro" e sai com 0.

Opcional: `PLATFORM_ADMIN_NAME` (só rótulo) e `PLATFORM_ADMIN_ROLE`.

### No Railway

`PLATFORM_ADMIN_EMAIL` e `PLATFORM_ADMIN_PASSWORD` **não** são variáveis do service: são entrada de
um comando pontual. Rode o bootstrap uma vez, com os valores que você escolher, e não os deixe
gravados no service.

`PLATFORM_ADMIN_SESSION_SECRET` **é** variável do service (gere 32+ bytes aleatórios; ele é novo e
específico do Admin, não é reaproveitado do painel).

---

## 4. Depois do primeiro admin

O `platform_owner` cria os demais pela interface (`/platform-admins`) ou pela API:

```http
POST /api/platform/admins
{ "email": "…", "nome": "…", "senha": "…", "papel": "platform_operator" }
```

Regras que valem sempre:

- **O último `platform_owner` ativo não pode ser desativado, removido nem rebaixado.** Conferido na
  aplicação (para dar um `409 ultimo_platform_owner` legível) **e** por trigger no banco (para o
  caso de alguém esquecer a checagem da aplicação, ou editar por SQL).
- Desativar um admin **revoga as sessões dele na hora**.
- `platform_operator` opera Organizations (suspender, override, convite, troca de plano) mas
  **não** gere platform admins nem cria/arquiva planos.

---

## 5. O fluxo de amanhã — cadastrar a Use Origens como Tenant #1

```text
1. abrir https://admin.oria.com.br
2. rodar o bootstrap (seção 3) e entrar como platform_owner
3. /organizations → "Criar Organization"
       Nome:        Use Origens
       Store:       Use Origens
       Plano:       Internal
       Owner email: <o e-mail de quem vai ser owner>
       bootstrapInterno: sim
4. copiar o token do convite da resposta  ← aparece UMA vez
5. entregar o token ao owner
6. acompanhar o onboarding em /organizations/:id
```

### Por que o passo 3 funciona (e por que só funciona uma vez)

`SECOND_TENANT_ENABLED` continua **desligado**, e continua bloqueando a criação de tenant externo.
O Tenant #1 passa por um caminho distinto e explícito:

```text
SECOND_TENANT_ENABLED = 1  →  criação externa liberada
SECOND_TENANT_ENABLED = 0  (padrão)
    ├─ nenhuma Organization existe  →  bootstrap interno permitido
    └─ já existe Organization       →  409 bootstrap_interno_indisponivel
```

A decisão é serializada por advisory lock de transação: dois pedidos simultâneos não veem ambos
"zero Organizations". E **o nome não entra na decisão** — `"Use Origens"` é só um nome. Depois que
a primeira Organization existir, o caminho recusa para sempre.

### O token do convite

Aparece **uma única vez**, na resposta da criação (e na de reissue). No banco existe só o SHA-256.
Não é recuperável. Copie, entregue por um canal que você confia, e não o coloque em URL, log,
título de página nem analytics.

Se perder: `POST /api/platform/organizations/:id/invites/:inviteId/reissue` revoga o anterior e
emite outro. Revogar o **único** caminho para um owner é recusado — a Organization nunca fica sem
caminho para ter dono.

> **Limitação conhecida hoje:** a rota que o owner usa para **aceitar** o convite é do Tenant Plane
> (é lá que ele define a senha). A função de banco `platform_consumir_convite(token_hash, user_id)`
> já existe, com uso único; ligá-la a uma rota do painel é trabalho de outra frente. Até lá, o
> convite é emitido e rastreado, mas não pode ser aceito pela interface.

---

## 6. Suspender e reativar

```http
POST /api/platform/organizations/:id/suspend      { "motivo": "…" }
POST /api/platform/organizations/:id/reactivate   { "motivo": "…" }
```

Suspender tem **efeito real**, não é rótulo:

- a Organization some das memberships (`auth_memberships` filtra `status = 'active'`), então o
  tenant perde login e seleção de workspace;
- o resolver de entitlements nega **todas** as features, inclusive as com override `true`;
- `platform_organizations_ativas()` deixa de devolvê-la para jobs e schedulers;
- webhooks podem continuar sendo autenticados e persistidos, mas não produzem efeito tenant-owned.

Os **dados permanecem**, o Admin continua vendo tudo, e reativar restaura.

---

## 7. Verificação rápida

```bash
curl -fsS https://admin.oria.com.br/health            # {"status":"ok"}
```

E, localmente, antes de subir:

```bash
cd apps/platform-admin
npm ci
npm run build          # carrega todos os módulos e confere o fail-fast de produção
npm test               # 110 testes, Postgres descartável (container próprio)
npm run test:negative  # 15 controles negativos, ciclo de 5 passos
```

Os testes do Admin sobem o próprio container (`oria-pa-test`) e **não** semeiam Organization
nenhuma — é isso que torna o gate do Tenant #1 testável. Eles exigem as migrations do painel
instaladas (`npm --prefix apps/panel ci`).

---

## 8. Problemas comuns

| sintoma | causa provável |
|---|---|
| `[BOOT] configuração inválida: PLATFORM_ADMIN_SESSION_SECRET ausente` | falta a variável no service |
| `[BOOT] configuração inválida: PLATFORM_ADMIN_URL …` | URL com path, query, credencial, `http` ou `localhost` |
| login responde `503 bootstrap_pendente` | o bootstrap ainda não rodou |
| login responde `403 origem_nao_permitida` | mutação sem `Origin`, ou vinda de `app.oria.com.br` / `oria.com.br` |
| escrita responde `403 csrf` | falta o header `X-CSRF-Token` (pegue em `GET /api/platform/auth/session`) |
| criar Organization responde `403 second_tenant_disabled` | faltou `bootstrapInterno: true`, ou já existe Organization |
| criar Organization responde `409 onboarding_config_required` | falta `ONBOARDING_STEP_REQUIREMENTS` ou `passos` no request |
| a raiz responde JSON em vez da interface | o frontend ainda não foi publicado em `public/` |
