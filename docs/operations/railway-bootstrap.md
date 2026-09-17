# Bootstrap do projeto Railway "Oria"

Rodada 20, atualizado na rodada 21. **Nada aqui foi executado.** Nenhum project, service, banco ou
volume foi criado, e nenhum segredo real aparece neste documento.

**Alvo fechado (rodada 21):** o rollout tem como destino o **projeto Railway novo `Oria`**, com os
services `oria-panel`, `oria-creatives` e `oria-whatsapp`, dois Postgres (painel e WhatsApp) e volume
só no painel. O **projeto Railway antigo é stack legada e origem de rollback** — ele continua no ar
durante a transição e não é alvo de nenhum passo do rollout. Não há mais escolha entre "projeto antigo
ou novo".

> **Pré-condição de rollout:** o **OPS-27 está VERIFIED** desde 17/09/2026
> (`docs/productization/ops-evidence/OPS-27.json`). O `production-rollout-runbook.md` (raiz:
> `docs/productization/`) continua bloqueado por outros motivos — infraestrutura não criada, demais OPS
> sem evidência, releases não publicadas e dogfood NOT STARTED. Este bootstrap prepara a
> infraestrutura; ele não libera deploy.

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

- [ ] Seguir `docs/productization/production-rollout-runbook.md` desde §5 (o OPS-27 já está VERIFIED),
      respeitando a estratégia de cutover abaixo.

## Estratégia de cutover (direção única, rodada 21)

```text
LEGACY RAILWAY continua live
  → NEW ORIA RAILWAY sobe isolado (sem tráfego real)
  → validação + migrations + import de dados
  → cutovers coordenados (URLs de webhook e domínio, um de cada vez)
  → dogfood da operação interna como Organization normal
  → legado permanece disponível para rollback por uma janela definida
```

- O Oria sobe **sem tráfego real**: nenhum webhook (Meta ou Ink) é reapontado antes da validação e do
  backup/restauração testados (OPS-04).
- Cada cutover tem rollback próprio, e a **janela de rollback do legado é declarada antes do primeiro
  deles**. Enquanto ela durar, o projeto antigo não é apagado nem tem variável removida.
- O dogfood só começa com o ambiente novo estável e `OPS-14`/`OPS-36` VERIFIED.

## O que o alvo novo muda na sequência de releases — em aberto

O runbook descreve as releases B, C e D0 como commits **antigos** do repositório antigo (`31a7cdb`,
`3adad08`, `8c024d2`; D' = HEAD), publicados no projeto Railway antigo sobre um banco que já continha a
produção. Com o alvo no projeto novo:

- **Mantém-se:** a ordem lógica dos OPS, os motivos de cada degrau (nenhum status perdido, checkpoint
  antes do cutover 5b, vínculo antes da materialização) e todos os pré-requisitos de segurança.
- **Precisa ser redefinido:** quais artefatos são publicados (os commits intermediários não existem na
  história do monorepo), o que substitui a premissa de "banco já em produção" (num Postgres novo é
  import + migrations), o que prova cada passo sem os commits antigos, e o que é rollback entre
  degraus (num ambiente novo, o rollback real é voltar o tráfego ao legado).

**Isso é decisão e trabalho de outra rodada.** Nenhuma sequência nova foi desenhada nem ensaiada aqui.
O detalhamento está no runbook, §20.3.
