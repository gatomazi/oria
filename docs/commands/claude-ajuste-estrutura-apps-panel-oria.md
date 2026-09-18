# Ajuste estrutural — transformar `apps/panel` no painel real do Oria

## Contexto

O monorepo Oria foi criado a partir de um snapshot do antigo projeto Orgulho Regional.

Por isso, hoje a estrutura de `apps/panel` herdou duas responsabilidades históricas:

```text
apps/panel/
├── frontend/site público legado da Orgulho Regional
├── backend/API que hoje pertence ao Oria
└── admin/
    └── frontend React/Vite que de fato é o painel do Oria
```

No produto Oria isso está conceitualmente errado.

O diretório:

```text
apps/panel
```

deve representar **o painel SaaS dos clientes do Oria**.

O antigo site público da Orgulho Regional não faz mais parte desse app.

O frontend que hoje está em:

```text
apps/panel/admin
```

é o frontend correto do produto e deve subir para a raiz de:

```text
apps/panel
```

Ao mesmo tempo, o backend existente na raiz precisa ser preservado.

---

# 1. Objetivo final

A estrutura alvo é:

```text
apps/
├── panel/
│   ├── src/                 # frontend React/Vite atual de admin/src
│   ├── public/              # frontend atual de admin/public, se existir
│   ├── index.html           # shell do SPA atual
│   ├── vite.config.mjs      # ou config equivalente compatível com CJS
│   │
│   ├── server.js            # backend/API existente
│   ├── lib/
│   ├── migrations/
│   ├── scripts/
│   ├── test/
│   │
│   ├── package.json         # manifest unificado
│   ├── package-lock.json    # lockfile único
│   └── dist/                # build final do SPA
│
├── platform-admin/          # NÃO tocar nesta refatoração
└── creative-generator/

services/
└── whatsapp/
```

Ao final:

```text
apps/panel/admin
```

não deve mais existir.

---

# 2. Escopo

Esta rodada é exclusivamente uma **refatoração estrutural do `apps/panel`**.

Não alterar arquitetura de tenancy, auth, integrações, jobs, WhatsApp, planos ou Control Plane.

Não tocar:

```text
apps/platform-admin
apps/creative-generator
services/whatsapp
```

exceto se algum script/root manifest precisar apenas ter paths atualizados.

---

# 3. Antes de alterar

Confirmar:

```bash
git status
git branch --show-current
git log -10 --oneline
```

Se houver outra frente mexendo em:

```text
apps/panel/server.js
apps/panel/src
apps/panel/index.html
apps/panel/admin
apps/panel/package.json
```

aguardar essa frente terminar antes de iniciar a fusão.

Não editar simultaneamente os mesmos arquivos em duas sessões.

---

# 4. Não fazer um `git mv admin/* .` cego

Há colisões reais entre a raiz e `admin/`.

A raiz contém:

```text
backend/API
package.json CommonJS
server.js
lib/
migrations/
scripts/
testes
frontend/site legado
```

`admin/` contém:

```text
frontend React/Vite real do Oria
package.json ESM
src/
index.html
tooling do Vite
```

Portanto a mudança precisa ser uma **fusão consciente**, não uma sobrescrita.

---

# 5. Backend permanece CommonJS

O backend atual usa:

```text
require(...)
module.exports
```

e `server.js` é grande.

Não converter o backend para ESM nesta rodada.

O `package.json` final de `apps/panel` deve continuar compatível com CommonJS.

Não adicionar:

```json
"type": "module"
```

no root do package se isso quebrar o backend.

---

# 6. Adaptar Vite ao package CommonJS

O frontend pode continuar usando normalmente:

```text
import
export
React
TypeScript
Vite
```

O tooling do Vite deve ser compatível com um package root CommonJS.

Preferir:

```text
vite.config.mjs
```

ou outra configuração oficialmente suportada que não exija converter todo o backend para ESM.

Não usar essa refatoração como desculpa para converter `server.js`.

---

# 7. Identificar exatamente o frontend legado

Antes de apagar qualquer coisa da raiz de `apps/panel`, classificar:

```text
arquivo pertence ao frontend público legado?
arquivo pertence ao backend SaaS?
arquivo pertence ao design system ainda usado?
arquivo pertence aos testes/tooling?
```

Só remover o que for comprovadamente do frontend/site legado da Orgulho Regional.

Não apagar código backend ou shared por nome/pasta sem confirmar uso.

---

# 8. Promover o frontend atual

Mover conceitualmente:

```text
apps/panel/admin/src
→ apps/panel/src

apps/panel/admin/public
→ apps/panel/public

apps/panel/admin/index.html
→ apps/panel/index.html

apps/panel/admin/vite.config.*
→ apps/panel/vite.config.mjs
```

Ajustar conforme a estrutura real encontrada.

Se a raiz atual tiver `src/` com arquivos compartilhados ainda necessários:

```text
não sobrescrever silenciosamente.
```

Resolver arquivo a arquivo.

Se for apenas frontend legado:

```text
substituir pelo src do painel real.
```

---

# 9. Package manifests

Hoje existem dois `package.json`.

Fundir em um único:

```text
apps/panel/package.json
```

O manifest final precisa conter:

```text
dependências do backend
+
dependências do frontend
+
scripts unificados
+
engines
```

Não manter dois manifests para o mesmo deployable.

---

# 10. Scripts finais

Esperado conceitualmente:

```json
{
  "scripts": {
    "dev": "...",
    "dev:frontend": "vite",
    "build": "vite build",
    "start": "node server.js",
    "test": "..."
  }
}
```

Não inventar os scripts exatos se os existentes tiverem regras adicionais.

Preservar:

```text
migrations
auth bootstrap
tenant scripts
integration scripts
productization scripts
```

---

# 11. Lockfile único

Resultado:

```text
apps/panel/package-lock.json
```

único.

Não copiar `node_modules`.

Remover qualquer:

```text
apps/panel/admin/node_modules
apps/panel/node_modules
```

antes de reinstalar, se necessário.

Depois:

```bash
npm install
```

ou:

```bash
npm ci
```

conforme o momento apropriado e o lock final.

Não manter dois lockfiles para o mesmo deployable.

---

# 12. Build output

Hoje podem existir referências para:

```text
admin/dist
```

O build final deve produzir:

```text
apps/panel/dist
```

Atualizar:

```text
server.js
static file serving
fallback SPA
tests
Railway config
scripts
docs
```

---

# 13. Backend servindo SPA

O backend deve continuar servindo o frontend no mesmo origin.

Alvo:

```text
GET /
→ SPA

/api/*
→ backend
```

SPA fallback:

```text
rotas frontend
→ index.html
```

sem interceptar APIs.

Preservar:

```text
same-origin
cookies
CSRF
session
```

Não introduzir CORS.

---

# 14. Remover o frontend legado

Depois que o novo frontend estiver funcionando na raiz, remover os artefatos do antigo site público da Orgulho Regional.

Não manter código morto apenas “por garantia”.

Mas antes de remover:

```text
grep/import usage
testes
build
```

para confirmar que não é usado pelo Oria.

---

# 15. Eliminar `apps/panel/admin`

Depois que:

```text
src promovido
index.html promovido
Vite adaptado
package.json fundido
lockfile fundido
build atualizado
tests atualizados
```

remover:

```text
apps/panel/admin/
```

por completo.

---

# 16. Referências residuais

Buscar:

```bash
grep -R "admin/dist" apps/panel
grep -R "apps/panel/admin" .
grep -R "/admin/src" .
grep -R "admin/index.html" .
```

ou equivalente robusto.

Ao final:

```text
zero referências executáveis/testáveis ao antigo subdiretório.
```

Documentação histórica pode mencionar o layout antigo apenas se claramente marcada como histórica.

---

# 17. Rotas `/admin`

A antiga pasta física:

```text
apps/panel/admin
```

não deve ser confundida com URL.

Se o frontend atualmente usa rota web:

```text
/admin
```

avaliar se isso ainda faz sentido.

Como o produto Oria agora é o painel em si, preferir:

```text
/
```

como aplicação principal.

Não manter `/admin` só por causa da estrutura antiga.

Se remover `/admin` de URL quebrar links/fluxos existentes importantes, implementar redirect temporário:

```text
/admin/*
→ /*
```

sem duplicar frontend.

Documentar.

---

# 18. Public assets

Consolidar assets do painel real em:

```text
apps/panel/public
```

ou imports via `src/assets`.

Não carregar assets específicos do site antigo se não forem usados.

---

# 19. CSS / design system

Se houver CSS/design tokens úteis na raiz antiga:

```text
preservar apenas o que o painel usa.
```

Não manter folhas inteiras do site legado se não participam do produto.

---

# 20. Railway

O service continua:

```text
oria-panel
Root Directory: /apps/panel
```

Comandos esperados:

```text
Build:
npm ci && npm run build

Start:
npm start
```

Healthcheck:

```text
usar o caminho já definido/provado
```

Se `/health` já foi criado, preferir ele.

Não mudar Root Directory.

---

# 21. CI

Atualizar qualquer CI que ainda entre em:

```text
apps/panel/admin
```

para trabalhar diretamente em:

```text
apps/panel
```

O job deve:

```text
npm ci
npm test
npm run build
```

conforme a estratégia atual.

---

# 22. Root orchestration

Atualizar scripts da raiz do monorepo que assumam:

```text
apps/panel/admin
```

O root deve tratar:

```text
apps/panel
```

como deployable completo.

---

# 23. `repo:self-check`

Adicionar/ajustar controles para reprovar se no futuro reaparecer:

```text
apps/panel/admin/package.json
apps/panel/admin/src
apps/panel/admin/dist
```

como segundo app dentro do panel.

Não reprovar documentação histórica.

---

# 24. Testes direcionados durante a mudança

Rodar testes relacionados a:

```text
static/public serving
SPA fallback
auth/session
CSRF
build paths
public files
Railway preflight
root scripts
package manifest
```

---

# 25. Suíte completa do painel

Essa mudança afeta:

```text
package manifest
frontend build
static serving
runtime layout
```

Portanto ao final rodar:

```bash
cd apps/panel
npm test
npm run build
```

Não reutilizar apenas evidência antiga para esta refatoração.

Se houver harness `oria_app`, rodar também a suíte relevante sob `oria_app`.

---

# 26. Não repetir Go / Creative

Se não houver alteração em:

```text
services/whatsapp
apps/creative-generator
```

não rodar suas suítes completas.

Apenas root checks/contracts se necessário.

---

# 27. Teste de produção local

Subir:

```bash
npm start
```

com o `dist` já gerado.

Verificar:

```text
GET /
SPA carrega
asset JS/CSS carrega
API continua respondendo
refresh em rota SPA funciona
```

Não usar apenas Vite dev server como prova.

---

# 28. Não tocar `apps/platform-admin`

A construção do Control Plane está em frente separada.

Não mover/copiar arquivos entre:

```text
apps/panel
apps/platform-admin
```

nesta rodada.

---

# 29. Commit isolado

Criar commit separado:

```text
refactor(panel): flatten tenant SPA into panel root
```

Pode dividir em 2–3 commits se isso melhorar revisão:

```text
refactor(panel): merge frontend dependencies into panel package
refactor(panel): promote tenant SPA to panel root
chore(panel): remove legacy storefront structure
```

---

# 30. Resultado conceitual

Antes:

```text
apps/panel
= antigo site Orgulho Regional
+ backend Oria
+ admin/painel Oria
```

Depois:

```text
apps/panel
= Painel do cliente Oria
+ backend/API Oria
```

E separadamente:

```text
apps/platform-admin
= Control Plane Oria
```

---

# 31. Checkpoint final

Retornar:

```text
1. layout final de apps/panel
2. arquivos legados removidos
3. arquivos do admin promovidos
4. package.json final
5. package-lock final
6. CommonJS/ESM strategy
7. Vite config final
8. build output
9. static serving
10. SPA fallback
11. comportamento de /admin URL
12. Railway config
13. CI paths
14. root scripts
15. repo:self-check
16. references grep
17. panel tests
18. panel build
19. oria_app regression
20. production-mode local smoke
21. commits
22. blockers/riscos
23. confirmação de que apps/panel/admin não existe mais
24. GO / NO-GO para manter esta estrutura como definitiva
```

---

# Estado esperado

```text
apps/panel/admin = REMOVIDO

apps/panel
= deployable único
= frontend SPA do Oria
+ backend/API
+ migrations/scripts/tests

backend
= CommonJS preservado

frontend
= React/Vite preservado

Railway
= 1 service oria-panel

CORS adicional
= NÃO

apps/platform-admin
= separado e intocado
```
