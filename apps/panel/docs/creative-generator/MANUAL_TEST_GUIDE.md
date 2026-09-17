# Roteiro de teste manual — Gerador de Criativos (Oria)

> Etapa 2. Este roteiro é o único ponto em que a geração **real** (paga, na sua conta OpenAI) acontece — nada foi gerado
> de verdade durante a implementação. Faça com `quality = low` e 1 criativo por lote até confirmar o comportamento.

## 0. O que você vai subir

| Processo | Onde | Porta sugerida |
|---|---|---|
| Postgres | local (Docker, Postgres.app ou brew) | 5432 |
| Serviço Python do gerador | `services/creative-core` | 8765 |
| Painel Node (Express) | raiz do repositório | 8080 |
| Admin em modo dev (opcional) | `admin/` (Vite, proxy `/api` → 8080) | 5173 |

## 1. Serviço Python (`services/creative-core`)

```bash
cd services/creative-core
python3.12 -m venv .venv && . .venv/bin/activate
pip install --index-url https://pypi.org/simple -r requirements.txt
python run_tests.py                                   # esperado: suítes 6/6 OK

export CREATIVE_CORE_SERVICE_TOKEN="$(python -c 'import secrets;print(secrets.token_hex(32))')"
echo "$CREATIVE_CORE_SERVICE_TOKEN"                   # copie: o Node usa o mesmo valor
gunicorn 'creative_core.service:create_app()' --bind 127.0.0.1:8765 --timeout 240
```

Conferir: `curl http://127.0.0.1:8765/v1/health` → `{"status": "ok", "versions": {"core_version": "1.1.0", ...}}`.

Variáveis do serviço:

| Variável | Obrigatória | Valor |
|---|---|---|
| `CREATIVE_CORE_SERVICE_TOKEN` | sim | ≥ 32 caracteres; o serviço não sobe sem ele |
| `OPENAI_IMAGE_MODEL` / `OPENAI_TEXT_MODEL` | não | padrão `gpt-image-2` / `gpt-5.6` |
| `OPENAI_IMAGE_MODEL_FALLBACKS` / `OPENAI_TEXT_MODEL_FALLBACKS` | não | lista separada por vírgula (usada só se o modelo não existir) |
| `WEB_CONCURRENCY` | não | workers do gunicorn (padrão 2) |

> O serviço **não** usa `OPENAI_API_KEY`. A chave vem do painel (BYOK), por requisição.

## 2. Painel Node (raiz)

```bash
npm install                     # se ainda não instalou (também builda o admin via postinstall)
export DATABASE_URL=postgres://USUARIO:SENHA@127.0.0.1:5432/orgulho_dev
export ADMIN_PASSWORD='uma-senha-local'
export ADMIN_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
export CREATIVE_CORE_URL=http://127.0.0.1:8765
export CREATIVE_CORE_SERVICE_TOKEN='<o mesmo token do serviço Python>'
export CREATIVE_FEATURE_FLAGS=creative_generator,creative_clean_angles,creative_remarketing,creative_funnel_visual,creative_multi_product
# opcionais: CREATIVE_TENANT_ID=default  UPLOADS_DIR=/caminho/persistente
npm start
```

Variáveis do Node usadas pelo módulo:

| Variável | Obrigatória | Observação |
|---|---|---|
| `DATABASE_URL` | sim para o gerador | sem ela as rotas do gerador respondem 503 (o resto do painel segue igual) |
| `ADMIN_SESSION_SECRET` | sim | já existe; também deriva a chave que cifra a OpenAI key (contexto `openai-api-key-creative-v1`). **Rotacionar invalida as keys salvas** (a tela pede para cadastrar de novo) |
| `CREATIVE_CORE_URL` | sim | URL do serviço Python (no Railway, a URL privada do serviço) |
| `CREATIVE_CORE_SERVICE_TOKEN` | sim | igual ao do serviço Python |
| `CREATIVE_FEATURE_FLAGS` | não | liga flags sem mexer em entitlements (útil em dev). Em produção prefira o entitlement |
| `CREATIVE_TENANT_ID` | não | padrão `default` (o painel ainda não é multi-tenant) |
| `UPLOADS_DIR` | não | onde ficam referências e criativos (padrão: volume Railway ou `./uploads`) |

### Ligar as flags sem env (alternativa)

As flags também são lidas do entitlement da conta (`app_config` chave `entitlements`, ou `db/entitlements.json` sem Postgres):

```sql
INSERT INTO app_config (chave, valor, atualizado_em)
VALUES ('entitlements', '{"creative_generator": true, "creative_clean_angles": true}', now())
ON CONFLICT (chave) DO UPDATE SET valor = app_config.valor || EXCLUDED.valor, atualizado_em = now();
```

Conferir: a tabela `creative_*` aparece no banco depois do boot (9 tabelas) e o log não mostra `[CRIATIVOS] schema não inicializado`.

## 3. Onde cadastrar a OpenAI API Key

Admin → **Integrações** (`/admin/integracoes`) → card **OpenAI** → campo *API Key* → **Salvar**. O gerador não tem mais aba de configurações: o estado do módulo (serviço, Postgres, flags) fica em *Estado do módulo*, no mesmo card.

Conferir:
- a tela mostra só `cadastrada · final XXXX`; o campo esvazia depois de salvar;
- **Testar chave** responde "Chave válida." (usa `GET /v1/models`, sem custo);
- no banco, `SELECT openai_key_enc FROM creative_settings` não contém `sk-`;
- nas DevTools (Network), nenhuma resposta do `/api/admin/criativos/*` contém a key;
- `localStorage`/`sessionStorage` do navegador não têm a key.

## 4. Cadastros mínimos

1. **Produtos** → cadastre 1 produto com 1 imagem (PNG/JPEG) e, para multipeça, mais 3.
   Conferir: SVG/arquivo não-imagem é recusado; o arquivo aparece em `UPLOADS_DIR/creatives/tenant/default/products/…`.
2. **Marca e nicho** → Brand Kit → **Novo**. Três jeitos de preencher o formulário guiado:
   - **Preencher com ChatGPT** → Copiar prompt → responder no ChatGPT → colar a resposta → Preencher formulário;
   - "Ou partir de um kit pronto" → `Use Origens`;
   - à mão, campo a campo (listas: um item por linha).
   Depois **Salvar**. Conferir: resposta sem JSON mostra "Não encontrei um JSON na resposta…"; chave que não existe no kit
   aparece em "Parte da resposta foi ignorada"; ângulo inventado é descartado; editar gera `v2` e mantém os campos
   avançados (rótulos de ângulo, regras por estratégia) — visíveis em **Editar como JSON**; JSON com campo errado
   (ex.: `"tone": "texto"`) volta "dados inválidos: tone: expected array".
3. (opcional) **Contextos** → Novo → mesmo formulário guiado (Preencher com ChatGPT ou à mão) → mantenha `status = Rascunho`, salve;
   depois **Editar** → **Aprovado** → Salvar `v2`. Conferir: resposta colada do ChatGPT sempre volta o status para Rascunho;
   aprovar sem nenhuma cena mostra "Para aprovar, informe ao menos uma cena."; metadados do assunto só aparecem em **Editar como JSON** e são mantidos.
4. (opcional) **Personas** → Novo → Preencher com ChatGPT, "Ou partir de uma persona sugerida" ou à mão → Salvar. **Editar** gera `v2`.

## 5. Passo a passo por motor

Para cada caso: aba **Gerar** → escolha → **Pré-visualizar** → confira a prévia → **Gerar N criativos** → aba **Lotes** acompanha.

### 5.1 Ângulos Limpos — um produto
- Motor *Ângulos Limpos* → *Um produto* → 1 produto → ângulo **Flatlay** (ou **Lifestyle cotidiano**) → Brand Kit → Feed → qualidade `low`.
- Prévia: *Texto na imagem* = "nenhum (imagem limpa)"; não existem campos de headline/CTA/selos no formulário.
- Resultado: **imagem sem nenhum texto gráfico** (headline, CTA, preço, selo, botão). Só pode haver texto que já existe no produto.
- Opcional: ligue *Gerar copy externa* → **Gerar copy** → 3 variantes TOFU/MOFU/BOFU (texto do anúncio, não da imagem).

### 5.2 Ângulos Limpos — multipeça
- *Multipeça* com 3 produtos → Flatlay → Story.
- Conferir: cada produto aparece **uma vez**, sem fundir/trocar; formato 1080×1920; continua sem texto.
- Erro esperado: escolher **Cabide** com Niche Kit *Comércio genérico* → "Ângulo não disponível para esta marca, nicho ou estratégia."

### 5.3 Remarketing — um produto
- Intenção **Produto visto** → 1 produto → ângulo **Premium / Estilo** → headline "Ainda pensando nele?".
- Prévia: etapa `BOFU`, layout de 1 produto, headline/CTA preenchidos.
- Resultado: headline e CTA **escritos exatamente** como na prévia, legíveis, sem texto inventado.

### 5.4 Remarketing — multipeça
- Intenção **Coleção** → 4 produtos → Flatlay → Feed.
- Prévia: layout `flatlay_grid` ou `flatlay_hero_stack`, headline "Não achou o seu ainda?", CTA "Ver todas →".
- Erros esperados (regra do motor): **Produto visto** com multipeça → "Modo de produto não suportado para esta combinação."; **Carrinho** com multipeça sem marcar "Estes produtos são o carrinho/pedido real" → mesmo erro; com a opção marcada → aceita. 6 produtos → "Quantidade de produtos fora do limite permitido." (máximo 5 no remarketing).
- **Prova social** sem dados reais: o criativo não pode ter estrelas, nota, depoimento ou número de clientes.

### 5.5 Funil por Criativo — TOFU (um produto)
- Etapa **TOFU** → 1 produto → **Identidade de marca** (ou *Identidade / Origem* com Use Origens).
- Conferir: aparência de post social, só headline curta, **sem botão sólido, preço, cupom ou selo**; o formulário não oferece selos/chips/busca no TOFU.

### 5.6 Funil por Criativo — MOFU multipeça
- **MOFU** → 3 produtos → **Premium / Estilo** → chips "Azul | Terracota | Creme" e barra de busca "caneca de cerâmica".
- Conferir: chips e barra de busca com o texto literal; headline + subheadline + CTA discreto.

### 5.7 Funil por Criativo — BOFU (um produto)
- **BOFU** → benefícios (1 por linha) + 1 selo → Story.
- Conferir: CTA forte, benefícios e selo **só os informados**; área segura do Story (nada importante nos 14% superiores e 20% inferiores).

## 6. Lotes, falhas e histórico

| Teste | Como | Esperado |
|---|---|---|
| Progresso | lote com 2 ângulos × 2 formatos | "Gerando X de 4", estados Na fila → Planejando → Gerando → Processando → Concluído |
| Falha parcial | remova a key durante um lote grande, ou use uma key inválida | itens com "A credencial do provedor de IA foi recusada." / "Cadastre (ou reconecte) a OpenAI API Key…"; lote **Parcial** ou **Falhou**, sem perder os concluídos |
| Retry individual | recadastre a key → **Tentar de novo** no item | mesmo criativo, "tentativa 2", termina Concluído |
| Serviço fora do ar | pare o gunicorn e crie um lote | status do módulo "fora do ar"; itens voltam para a fila (até 3 vezes, 1 min entre tentativas) e só então falham com "Serviço do gerador indisponível" |
| Cancelar | **Cancelar lote** com itens na fila | lote Cancelado; itens na fila viram Cancelado |
| Reinício | derrube o Node no meio de um item | ao subir, o item volta para a fila (log `[CRIATIVOS] … interrompido(s) voltaram pra fila`) |
| Histórico | aba Histórico | cada criativo com motor, modo, ângulo, formato, funil/intenção, versões de marca e prompt; `creative_generations.record` com `tenant_id`, `product_mode`, `brand_kit_version`, `niche_kit_version`, `prompt_version` |
| Storage | `UPLOADS_DIR/creatives/tenant/default/creatives/<creative_id>/image.png` | PNG no tamanho do formato (1080×1350 ou 1080×1920) |

## 7. Segurança (conferir uma vez)

- Deslogado: `curl -i http://127.0.0.1:8080/api/admin/criativos/status` → 401.
- Arquivos do serviço não são públicos: `curl -i http://127.0.0.1:8080/services/creative-core/README.md` → 404.
- Sem `CREATIVE_FEATURE_FLAGS` e sem entitlement: a tela mostra "Gerador de Criativos desligado" e `POST /api/admin/criativos/jobs` → 403.
- Serviço Python direto sem token: `curl -i http://127.0.0.1:8765/v1/contracts` → 401.
- A resposta de `/api/admin/criativos/preview`, `/jobs/:id` e `/history` nunca contém o texto do prompt (só `prompt_sha256`).

## 8. Railway (quando for publicar)

Serviço **creative-lab** (código em `services/creative-core`) no mesmo repositório, configurado pelo painel:
- *Root Directory*: `services/creative-core`; Start Command `gunicorn 'creative_core.service:create_app()'` (bind/workers em `gunicorn.conf.py`); Watch Paths `/services/creative-core/**`. O serviço Node da raiz não muda.
- Variáveis: `CREATIVE_CORE_SERVICE_TOKEN` (+ opcionais de modelo). Health check: `/v1/health`.
- Preferir rede privada; se tiver domínio público, o token continua obrigatório.

Serviço Node existente — adicionar variáveis: `CREATIVE_CORE_URL` (URL privada, ex.: `http://creative-lab.railway.internal:8080`), `CREATIVE_CORE_SERVICE_TOKEN`. Deixar as flags **desligadas** até concluir este roteiro; depois ligar pelo entitlement da conta.

## 9. Teste automatizado equivalente (sem custo)

Já rodado na implementação (ver `AGENT_TEST_LOG.md`): Node + Postgres + serviço Python real + um OpenAI **falso** local. Para repetir:
`OPENAI_BASE_URL=http://127.0.0.1:<porta-do-fake>/v1` no serviço Python faz o SDK falar com um servidor falso em vez da OpenAI.
