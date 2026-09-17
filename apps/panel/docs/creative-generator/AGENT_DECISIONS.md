# AGENT_DECISIONS — Oria / Orgulho Regional (Etapa 2)

Formato: Contexto · Decisão · Alternativas · Motivo · Impacto. Data de todas: 15/09/2026.

## D-201 — Core Python dentro deste repositório (`services/creative-core`)
- **Contexto:** decisão do usuário: fonte única da verdade em B, serviço separado no Railway a partir do mesmo repo.
- **Decisão:** pacote `creative_core` + `service.py` (WSGI) em `services/creative-core/`, com `requirements.txt` (Pillow, openai, gunicorn), `pyproject.toml`, `Procfile`, `nixpacks.toml`, `railway.json` e `.gitignore` próprios. Módulos puros que o core usava do gerador (`remarketing`, `cabide`, `regional_context`) e o snapshot `regioes.json`/`cidades.json` foram trazidos para dentro do pacote.
- **Impacto:** o serviço é autossuficiente. O gerador interno mantém um espelho byte a byte verificado por script (lá). Dados regionais são snapshot (`scripts/sync_data.py`).

## D-202 — Superfície mínima em arquivos compartilhados
- **Decisão:** tudo do módulo em arquivos novos (`routes/criativos.js`, `lib/creative-core/*`, `admin/src/pages/criativos/*`, `admin/src/api/criativos.ts`, `src/criativos.css`, `test/creative-core*.test.js`). Em compartilhados, só inserções: `server.js` +13 linhas, `App.tsx` +2, `nav.ts` +3, `statusMap.ts` +12 (append).
- **Motivo:** outro agente trabalha na `master` ao mesmo tempo.

## D-203 — Flags desligadas no código, não em `db/entitlements.json`
- **Contexto:** a instrução pedia a flag desligada em `db/entitlements.json`, mas `db/` é gitignored (dado de runtime, com PII) e o valor real vem do Postgres (`app_config`).
- **Decisão:** default `false` para as 5 flags em `lib/creative-core/flags.js`; ligar via entitlement da conta ou env `CREATIVE_FEATURE_FLAGS`. `ENTITLEMENTS_DEFAULT` do `server.js` e o arquivo local não foram tocados.
- **Impacto:** um deploy acidental sobe com o módulo desligado (403 em tudo além de status/catálogo).

## D-204 — Postgres obrigatório para o gerador
- **Decisão:** sem `DATABASE_URL` as rotas do gerador respondem 503. Não há fallback em arquivo JSON.
- **Motivo:** jobs, fila com `FOR UPDATE SKIP LOCKED`, histórico e BYOK precisam de transação/durabilidade; o disco do container é efêmero.

## D-205 — Tenant definido pelo servidor
- **Contexto:** o painel não é multi-tenant (1 admin, sem roles).
- **Decisão:** `tenant_id` em todas as tabelas `creative_*`, valor de `CREATIVE_TENANT_ID` (padrão `default`), nunca do request; todo acesso filtra por tenant (testado contra Postgres real).
- **Impacto:** preparado para multi-tenant sem migração destrutiva; isolamento real entre tenants depende de auth por conta, que o painel ainda não tem.

## D-206 — BYOK com contexto HKDF próprio
- **Decisão:** reutiliza `encriptarSegredo/descriptografarSegredo` do `server.js` com contexto `openai-api-key-creative-v1`; guarda `last4`; key decifrada só no worker/rota que chama o core; teste de key via `GET https://api.openai.com/v1/models` (URL fixa, sem custo).
- **Impacto:** rotacionar `ADMIN_SESSION_SECRET` invalida a key (tela pede recadastro).

## D-207 — Jobs em processo, com retry de infraestrutura separado de retry do usuário
- **Decisão:** worker `setInterval` (5 s, `unref`) + `kick()` ao criar lote. Serviço fora do ar → item volta para a fila (até 3 vezes, 60 s). Erro de negócio/provedor → item `failed` com a mensagem segura do contrato. Retry do usuário reusa o plano salvo (mesmo prompt, `generation_attempt + 1`). Itens presos voltam para a fila no boot.
- **Alternativas:** fila externa (BigQueue/Redis) — inexistente no projeto.

## D-208 — Plano completo fica no banco; API só expõe resumo
- **Decisão:** `creative_generations.plan` guarda o plano (necessário para retry), mas nenhuma rota devolve `prompt.text`; a UI recebe `planSummary` + `prompt_sha256`.

## D-209 — Validação de negócio só no core
- **Decisão:** o painel valida forma (whitelist de campos, ids UUID, limites de lote ≤ 40) e delega ao core as regras de motor (overlay em Ângulos Limpos, intenção × multipeça, limites por motor, ângulo × nicho). Criação de lote chama `/v1/plans` do 1º item para falhar rápido (422) antes de enfileirar.

## D-210 — `/services/` e `/routes/` bloqueados no static
- **Contexto:** `express.static(__dirname)` serve a raiz do repositório (inclusive `server.js`, `lib/`, `docs/` — situação pré-existente).
- **Decisão:** 1 middleware antes do static devolvendo 404 para `/services/*` e `/routes/*`. O resto da exposição pré-existente foi só registrado (não é escopo desta etapa).

## D-211 — `git pull --rebase` antes de cada commit não é possível com a regra de paths explícitos
- **Contexto:** `pull --rebase` recusa rodar com qualquer alteração não commitada — as minhas (antes do commit) ou as do outro agente (várias vezes havia `server.js` modificado por ele) — e `stash` é proibido.
- **Decisão:** antes de cada commit: `git status` + `git fetch` + checagem `HEAD..@{u}` (parar se a origin tiver avançado); commit só com paths explícitos (`git commit -- <paths>`); `git pull --rebase` depois do commit (quando a árvore permitiu). Em nenhum momento a origin estava à frente.

## D-212 — Admin funcional, lapidação na Etapa 3
- **Decisão:** página com abas e componentes do design system; editor JSON para Brand/Niche Kit e Context Profile (validado pelo contrato). Formulários guiados de kit ficam para a Etapa 3.
