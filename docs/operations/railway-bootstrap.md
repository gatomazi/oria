# Bootstrap do projeto Railway "Oria"

Rodada 20. **Nada aqui foi executado.** Nenhum project, service, banco ou volume foi criado, e nenhum
segredo real aparece neste documento.

O projeto Railway antigo continua sendo a produção legada. O projeto **Oria** é o alvo isolado: subir,
validar, migrar e, se preciso, voltar para a stack antiga (§36 da rodada 20).

> **Pré-condição de rollout:** o `production-rollout-runbook.md` (raiz: `docs/productization/`) só
> começa depois do **OPS-27 VERIFIED**. Este bootstrap prepara a infraestrutura; ele não libera deploy.

## Ordem

### 1. Criar o project

- [ ] Novo project no Railway chamado **Oria**, na mesma conta/organização.
- [ ] Conectar o repositório GitHub `gatomazi/oria` (o push inicial precisa ter acontecido).

### 2. PostgreSQL do painel

- [ ] Adicionar um Postgres (plugin/serviço gerenciado) chamado, por exemplo, `oria-panel-db`.
- [ ] Guardar a URL para o `DATABASE_URL` do `oria-panel` (referência entre services, não valor colado).
- [ ] **OPS-04:** habilitar backup e **testar uma restauração** antes de qualquer migração de dados.

### 3. PostgreSQL do WhatsApp

- [ ] Adicionar um segundo Postgres, `oria-whatsapp-db`. Os bancos **não** são unificados (§18).
- [ ] Backup e restauração testados também aqui.

### 4. Service `oria-panel`

- [ ] Source: repositório `gatomazi/oria`, **Root Directory** `apps/panel`.
- [ ] Watch Paths: `/apps/panel/**` (e `/contracts/**`, se quiser rebuild ao mudar contrato).
- [ ] Build: padrão (o `postinstall` builda o admin).
- [ ] Start: `npm start`.
- [ ] Healthcheck: o painel **não tem** `/health` hoje — usar `GET /` ou deixar sem healthcheck até
      existir um endpoint próprio (`infra/railway/services.md`).
- [ ] Ingress público: sim.

### 5. Service `oria-creatives`

- [ ] Root Directory `apps/creative-generator`; Watch Paths `/apps/creative-generator/**`.
- [ ] Runtime Python 3.12 (`.python-version` + `requirements.txt`).
- [ ] Start: `gunicorn 'creative_core.service:create_app()'`.
- [ ] Healthcheck: `/v1/health`.
- [ ] **Sem domínio público** (OPS-01). Só rede privada.
- [ ] Variável `CREATIVE_CORE_SERVICE_TOKEN` (≥ 32) antes do primeiro deploy: sem ela o serviço não sobe.

### 6. Service `oria-whatsapp`

- [ ] Root Directory `services/whatsapp`; Watch Paths `/services/whatsapp/**`.
- [ ] Build pelo `Dockerfile` do próprio serviço.
- [ ] Healthcheck: `/health`.
- [ ] Ingress público: **sim** (webhook da Meta).

### 7. Rede privada

- [ ] `CREATIVE_CORE_URL` = domínio interno do `oria-creatives` (ex.: `http://oria-creatives.railway.internal:<porta>`) — OPS-02.
- [ ] `WHATSAPP_SERVICE_URL` = domínio interno do `oria-whatsapp`.
- [ ] `PANEL_SENDER_RESOLVER_URL` e `WEBHOOK_FORWARD_URL` = domínio interno do `oria-panel`, em https, **sem query**.
- [ ] Conferir que só `oria-panel` e `oria-whatsapp` têm domínio público.

### 8. Volume

- [ ] Volume no `oria-panel` (uploads e cache de imagens). Sem volume, criativos e artes se perdem no deploy (OPS-03).
- [ ] Confirmar que o backup do volume **preserva links simbólicos** (o OPS-22 usa um durante o cutover).
- [ ] Gerador e WhatsApp: sem volume.

### 9. Variáveis

- [ ] Preencher pelos nomes de `infra/railway/env-manifest.md`, service a service.
- [ ] Segredos gerados fora do repositório; nada de copiar valor do projeto antigo sem necessidade
      (o repasse e o webhook exigem valores **novos** — OPS-09).
- [ ] `npm run release:preflight -- --from-env-file <export> --stage release-n --legacy-forward-panel` → sem BLOCK.

### 10. Pre-deploy

- [ ] `oria-panel`: *Pre-deploy Command* do runbook §8.2 (mapeamento + migrations + bootstrap + seed + import + re-cifra + remetente).
- [ ] `oria-creatives` e `oria-whatsapp`: nenhum.

### 11. Healthchecks e observação

- [ ] Ver o boot de cada service: painel (`[POSTGRES] conexão e migrations verificadas`),
      Gerador (`/v1/health` respondendo), WhatsApp (`sig_verify=true`, `forward=...`).

### 12. Só então: rollout

- [ ] Seguir `docs/productization/production-rollout-runbook.md` desde §5, com o OPS-27 VERIFIED.

## O que este projeto novo muda no runbook

O runbook foi escrito para o projeto Railway **antigo**, com releases em commits antigos
(`31a7cdb`, `3adad08`, `8c024d2`) do repositório do painel. Num projeto novo, partindo do monorepo,
existem duas opções — e **a escolha é do usuário**, numa rodada própria:

1. **Rollout no projeto antigo** (como o runbook descreve) e, depois, migração para o Oria.
2. **Rollout direto no projeto Oria**, a partir do monorepo. Isso exige reescrever a sequência de
   releases: os checkpoints intermediários não existem na história do monorepo, e os testes de
   contrato que provam cada passo dependem do repositório legado.

Enquanto a decisão não existir, o runbook continua valendo como está, e o Oria fica pronto e parado.
