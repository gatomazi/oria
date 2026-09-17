# Relatório de validação — Etapa 2 (Gerador de Criativos no painel / Oria)

Data: 15/09/2026. Veredito: **funcional e validado sem custo** (unitário + Postgres real + E2E com serviço Python real e
OpenAI falso). Ressalvas: geração real não executada (por instrução), gunicorn/deploy não testados, validação visual
responsiva e axe-core pendentes para a Etapa 3.

## Gate da Etapa 2 (agente §21)

| Item | Status | Evidência |
|---|---|---|
| Somente 3 motores aparecem | ✅ | core aceita só `CLEAN_ANGLES/REMARKETING/FUNNEL_VISUAL`; `flags.js` só mapeia esses; UI lista só esses |
| Multipeça dentro dos motores | ✅ | `product_mode` no formulário; regras do core (Limpos 2–6, Remarketing 2–5 por intenção, Funil 2–6); flag `creative_multi_product` |
| Tenant isolation | ✅ (servidor) | `tenant_id` do servidor; teste Postgres com 2 tenants; painel ainda sem auth por conta (D-205) |
| BYOK | ✅ | cifrado por contexto próprio, só `last4` na API, key ausente de logs/lotes/histórico (T-206) |
| Jobs | ✅ | estados queued→planning→generating→processing→completed/partial/failed/cancelled; retry individual; requeue no boot; indisponibilidade com espera |
| Storage | ✅ | `UPLOADS_DIR/creatives/tenant/{tenant}/…`, magic bytes, sha256, rota autenticada |
| Histórico | ✅ | `creative_generations.record` com todos os campos do spec §25 (+ generation_attempt, core_version) |
| Clean angles sem overlay | ✅ | core (Etapa 1) + UI sem campos de texto + E2E (`overlay.allowed=false`) |
| Remarketing funcional | ✅ | E2E multipeça coleção; 422 para product_view multipeça |
| Funnel visual funcional | ✅ | E2E MOFU multipeça com chips |
| Single e multi | ✅ | E2E dos dois modos |
| build / typecheck / test | ✅ | T-207 |

## Critérios de aceite do spec 02 (§35)

| Critério | Status |
|---|---|
| SaaS exibe somente 3 motores; Coleção, Orgânico e Ângulos Multipeça não aparecem | ✅ |
| Multipeça funciona dentro dos 3 motores | ✅ (sem custo; real pendente) |
| Ângulos Limpos sem overlay | ✅ |
| Remarketing e Funil independentes | ✅ |
| Feature flags controlam acesso | ✅ (default desligado) |
| BYOK funciona | ✅ (cadastro/cifra/uso validados; chamada real pendente) |
| Tenant isolation | ✅ no servidor (ver D-205) |
| Brand/Niche Kits persistem (com versão) | ✅ |
| Context Intelligence reaproveitado | ✅ (providers do core; perfis custom com status) |
| Jobs, retry, assets persistentes | ✅ |
| Histórico registra product_mode | ✅ |
| Outro cliente não regional consegue usar | ✅ (E2E com "Casa Aroma" + generic_commerce) |

## Arquivos

Novos: `services/creative-core/**`, `lib/creative-core/{client,flags,byok,storage,schema,status,memoryStore,pgStore,requests,worker}.js`,
`routes/criativos.js`, `admin/src/api/criativos.ts`, `admin/src/pages/criativos/{CriativosPage,GerarTab,LotesTab,CadastrosTabs}.tsx`,
`src/criativos.css`, `test/creative-core.test.js`, `test/creative-core-pg.test.js`, docs em `docs/creative-generator/` e
`docs/creative-generator-saas-integration-plan.md`.

Compartilhados (só inserção): `server.js` (+13), `admin/src/App.tsx` (+2), `admin/src/shell/nav.ts` (+3), `admin/src/lib/statusMap.ts` (+12).
Marcado como superado: `docs/implementacao_gerador_criativos_saas_painel_angulos_multipeca.md`.

## Riscos e pendências para a Etapa 3 / operação

1. Rodar `MANUAL_TEST_GUIDE.md` com a key real (qualidade `low`) antes de ligar flags em produção.
2. Criar o serviço `creative-core` no Railway e validar build Nixpacks + gunicorn.
3. Exposição estática pré-existente da raiz do repositório (`server.js`, `lib/`, `docs/`) — só `/services` e `/routes` foram bloqueados.
4. Editor de kits em JSON é funcional, não amigável — Etapa 3.
5. Screenshots responsivos (320–1440) e axe-core não feitos.
6. O remote do repositório tem um token GitHub embutido na URL de `origin` (visto em `git remote -v`) — recomendado rotacionar e trocar por credential helper/SSH.
