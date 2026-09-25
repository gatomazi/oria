# Gerador de Criativos — Fase E (UI V2, local, atrás de flag)

Branch `feature/creative-fase-c`, worktree `oria-creative-fase-a`. Implementação **local**, atrás de
`CREATIVE_UI_V2_ORGS` (rollout operacional por Organization, nunca comercial — mesmo mecanismo de
`CREATIVE_PROMPT_V2_ORGS`/`CREATIVE_PLAN_V2_ORGS`). **Sem push, sem merge, sem deploy, sem chamada à OpenAI.**
Mockup Generator, Product Enrichment GPT, Commerce Connector, aprendizado por feedback e QA/retry automático não
foram iniciados. V1 (`GerarTab.tsx`) intocado — nenhuma linha alterada; contas fora da flag continuam vendo
exatamente o que viam antes.

## 0. O que já existia e o que a Fase E precisou construir

Ler o código antes de desenhar a tela mudou o escopo real do trabalho: o **backend** de Angles V2 (famílias,
`recommend_angle`, catálogo de famílias exposto em `GET /catalog`) já estava pronto desde a Fase D — só não tinha
NENHUMA tela usando. O **frontend** não tinha nada: zero referência a `custom_angle`/família em `src/`. Dois gaps
de plumbing que precisaram ser fechados para a UI simples funcionar:

- `angle_family_hint` — o core já aceitava esse campo (`engines.py::_resolve_angle_id`) desde a Fase D, mas o
  painel nunca o repassava (`INPUT_KEYS` não o incluía). Sem isso, não havia como a tela mandar "o usuário
  escolheu esta família" sem inventar um ângulo personalizado por baixo. Adicionado em `requests.js`.
- **`angle_id: "auto"` puro** (sem `custom_angle`/`angle_family_hint`) — o caminho que aciona
  `recommend_angle()` de verdade — também não tinha uma entrada aceita no painel (`angle_ids` legado exige 13 ids
  maiúsculos; `"auto"` minúsculo não batia na regex). É exatamente o caminho que "Sugestão para esta estampa"
  precisa. Adicionado.
- `planSummary()` não expunha `angle_recommendation` (family/preset/source/reason) — só o `angle` legado
  (id/label). Sem isso a tela não tinha como mostrar a recomendação real, só inventar uma. Adicionado.

Sem esses três, a Fase E teria duas opções ruins: inventar a recomendação no frontend (proibido pelo comando) ou
não ter fluxo de "Gerar assim" sem escolher um ângulo primeiro. Nenhuma das duas é o que foi pedido.

## 1. O fluxo comum, como ficou

**`GerarTabV2.tsx`** (novo arquivo), renderizado no lugar de `GerarTab.tsx` quando `status.uiV2` é `true`
(`CriativosPage.tsx`, uma linha de condicional — nenhuma outra aba muda).

1. **Produto** — lista de checkbox de produto único (multipeça e os outros dois motores continuam só na V1; ver
   §7, "o que ficou de fora").
2. Ao marcar um produto, a tela chama `POST /preview` com o mínimo necessário (`angle_ids: ["auto"]`, sem
   `custom_angle`/hint) e mostra a **recomendação real** do motor:
   > **Sugestão para esta estampa**
   > Retrato editorial · uma pessoa, padrão do motor
   > `[Gerar assim] [Personalizar cena]`
3. **Gerar assim** manda o mesmo request direto para `POST /jobs`. **Personalizar cena** expande:
   - **Estilo**: 6 cartões de família (a recomendada já vem marcada), `action_movement` fica de fora (reserved).
     "Outros estilos" mostra os ângulos personalizados da Organization/Store, com origem rotulada.
   - **Personalizar cena**: Interação, Pessoas (com/sem pessoa), Ambiente, Olhar — todos opcionais, defaults
     preenchidos, nunca cards vazios. "Avançado" (Enquadramento/formato, Quantidade) fica escondido por padrão.
   - **Gerar N criativos** ao final.

Nenhum `age_band`, `pose_risk`, `semantic_context`, id de relation, provenance, compiler ou JSON aparece na tela
em nenhum momento — só o que `planSummary()` já filtrava para telas (a Fase E não teve que esconder nada de novo,
só reaproveitar o resumo que já era seguro).

### Criar ângulo personalizado sem questionário

Modal com só o essencial visível: **Nome do estilo**, **Família**, **"Como você quer que a fotografia pareça?"**
(mapeia direto para `definition.photographic_direction`), Descrição opcional. "Personalizar" (fechado por padrão)
tem Enquadramento/Iluminação/Composição + **Olhar** como controle estruturado (`default_gaze`, nunca escondido em
texto livre) + Escopo (Organization/Store). O slug (identidade dentro do escopo, exigido pela API desde a Fase D)
é gerado a partir do nome (`gerarSlug()`, client-side) — a tela nunca pergunta por ele.

## 2. Screenshots (painel real, autenticado, local)

Ambiente: Postgres efêmero + serviço `creative_core` real (`python -m creative_core.service`, sem OpenAI) +
`node server.js` real, Organization/Store/produto/entitlement seedados via SQL direto (nenhum atalho de
produção), login feito **pelo usuário** (a screen de login é um bloqueio deliberado — nunca digito/submeto senha,
mesmo de uma conta de teste local; ver a troca no início desta sessão).

| Estado | Screenshot |
|---|---|
| Tela inicial, produto ainda não escolhido | `screenshot-1790127550997-3.jpg` |
| Recomendação real numa geração NOVA (não copiada) | `screenshot-1790127561354-4.jpg` |
| Personalizar cena: família recomendada pré-marcada, cartões | `screenshot-1790127571199-5.jpg` |
| Mobile (390×844) | `screenshot-1790127581124-6.jpg` |

(arquivos em `/var/folders/.../claude-chrome-screenshots-EUa9kj/` — locais à máquina desta sessão)

## 3. Casos de uso ponta a ponta validados no Chrome (painel real)

- **Primeira geração com recomendação**: produto novo, sem Copiar Dados, `Sugestão para esta estampa` aparece
  com família + motivo reais (`"uma pessoa, padrão do motor"`, traduzido de `single_person_default`).
- **`angle_id:auto` puro**: confirmado no payload (`item.request.angle_id === 'auto'`, sem `custom_angle`/hint) —
  teste de unidade + prévia real no Chrome mostrando `Ângulo: Orgulho discreto` (o legado que a família roteou).
- **Família por cartão**: clicar em "Retrato editorial" seleciona o cartão (verde), state consistente.
- **Custom Angle ativo**: criado pela tela (Café editorial, family lifestyle, `default_gaze: camera`), aparece em
  "Outros estilos", seleciona corretamente, Prévia mostra "Ângulo personalizado: Café editorial (v1)".
- **Conflito de seleção corrigido em Chrome**: ao marcar um Custom Angle, o cartão de família (que ainda mostrava
  a recomendação) ficava marcado AO MESMO TEMPO que o checkbox do ângulo — duas escolhas aparentemente ativas.
  Achado ao vivo, corrigido (`GerarTabV2.tsx`, o `value` do `RadioCardGroup` volta a `null` quando
  `escolha.tipo === 'custom'`), rebuildado e reconfirmado no mesmo Chrome antes de seguir.
- **`Gerar` desabilitado sem OpenAI key**: mesmo comportamento do V1 — não é possível dar submit sem a BYOK
  cadastrada (a suite não chama OpenAI, então isto não foi forçado a passar; é o estado observado e correto).
- **Mobile (390px)**: cartões empilham em coluna única, Prévia desce abaixo do formulário, tabs viram scroll
  horizontal — tudo herdado do layout responsivo já existente (`criativos.css`), nada quebrado.
- **Store vs Organization / histórico com ângulo desativado / cópia de produto arquivado**: cobertos pelos testes
  automatizados (`creative-custom-angle-effect.test.js`, D.1.1) — o Chrome confirmou a PLUMBING nova
  (`angle_family_hint`, `angle_id:auto` puro, recomendação em `planSummary`), a reautorização e o replay já
  tinham evidência de teste real da rodada anterior; refazer manualmente no Chrome seria repetir prova já dada.

Não foi gerada nenhuma imagem real nem chamada a OpenAI — confirmando o payload até o backend e a prévia do
plano (`POST /preview`), como o comando autorizou.

## 4. Testes automatizados

| Suite | Resultado |
|---|---|
| Core Python completo (inclui 546 golden V1) | 322/322 |
| Painel — arquivos tocados diretamente (`creative-core`, `creative-custom-angle-effect`) | 21+17 = todos verdes |
| Painel — status/flag da UI V2 (`GET /status`: `uiV2`/`planV2`, ligado só por Organization) | novo, verde |
| Painel completo (`test/*.test.js` + `test/invariants/*.test.js`) | **1332/1333** — ver nota abaixo |

Testes novos desta rodada: `angle_family_hint` válido/família inválida/junto de custom angle (recusado),
`angle_ids:["auto"]` puro passa reto, `planSummary.angle_recommendation` passa como veio do plano (e é `null`
quando o plano não tem), status expõe `uiV2`/`planV2` corretamente (default false, ligado só para a Organization
da env, uma outra Organization na env não liga para esta).

**A única falha da suíte completa (1332/1333)**: `R19 · o problema original: Go novo SEM a flag (URL limpa) →
painel antigo recusa`, com `Error: go saiu com 1: ... listen tcp :59840: bind: address already in use`. Não é
uma regressão desta rodada — é uma colisão de porta num subprocesso Go (`whatsapp-webhook-go`) que o teste sobe
via `livre()` (encontra uma porta livre, fecha, reabre no binário — corrida clássica sob carga com ~1330 outros
testes competindo por portas/processos na mesma máquina). Evidência: (1) o texto do erro é literalmente
"address already in use", a causa mecânica direta, sem mistério a investigar; (2) nada desta rodada toca
`whatsapp-webhook-go`, R19 ou lógica de repasse — as mudanças ficaram em `requests.js`/`rollout.js`/
`routes/criativos.js` (Custom Angle/família) e no frontend; (3) rodado ISOLADO no mesmo container, 9/9 verde,
incluindo esse exato subteste. Gate considerado verde.

## 5. Diferenças V1 × V2

| | V1 (`GerarTab.tsx`) | V2 (`GerarTabV2.tsx`) |
|---|---|---|
| Decisões no fluxo comum | ~10+ campos visíveis de uma vez | produto → recomendação → Gerar assim (2-3 decisões) |
| Ângulo | 13 checkboxes legados, sempre visíveis | 6 cartões de família + "Outros estilos"; 13 legados só no histórico |
| Recomendação | só aparece depois de Copiar Dados (`resumoCena`) | aparece numa geração NOVA, sempre que o motor recomenda |
| Custom Angle | não tinha UI nenhuma (só CRUD via API) | cadastro mínimo (3 campos visíveis) + seleção |
| Pessoas/Interação numa geração nova | não editável (só via Copiar Dados) | Interação/Pessoas/Ambiente/Olhar editáveis, com defaults |
| Motores | Ângulos Limpos, Remarketing, Funil, multipeça | só Ângulos Limpos, produto único (ver §7) |
| Campos técnicos | nenhum exposto (igual) | nenhum exposto (igual — herdado do `planSummary` já seguro) |

## 6. Compatibilidade e limites estruturais

- `planSchemaVersion` continua a gating de "Personalizar cena"/Custom Angle — sem `planV2` a tela V2 ainda mostra
  a recomendação (funciona em plano v1: `angle_recommendation` está presente nas duas versões), mas
  "Personalizar cena"/ângulo personalizado exigem `planV2` também ligado para a mesma Organization (documentado
  no `status`, dois booleans independentes — a tela não tenta adivinhar).
- Nenhum schema de `CreativePlan` mudou. Nenhuma versão de compiler mudou. `custom_angle_replay_of` (D.1.1)
  continua sendo o único caminho de reautorização — a V2 herda automaticamente porque reusa `getCopiaDados`.

## 7. O que ficou de fora desta rodada (honesto, não escondido)

- **Remarketing e Funil por Criativo** continuam só na V1. A V2 simplifica exatamente o fluxo que o comando
  descreveu (Ângulos Limpos); estender a mesma simplicidade aos outros dois motores é trabalho novo, não uma
  extensão trivial (eles têm headline/CTA/etapa de funil, que não fazem parte do princípio "produto → recomendação
  → gerar").
- **Multipeça** na V2: não implementado (a tela V2 só oferece produto único). O motivo é o mesmo — multipeça muda
  a forma como a recomendação e a cena funcionam, e mereceria sua própria passada de design, não uma adaptação
  apressada.
- **"Pessoas" em Personalizar cena** é um toggle com/sem pessoa (`persona_mode`), não um editor completo de
  `subjects` (quem aparece, quem veste qual produto, relação). Um editor completo de Subjects para uma geração
  NOVA (distinto de Copiar Dados, que já tinha isso) é uma peça de UI substancial por si só — chips por pessoa,
  seleção de produto vestido, validação de minor safety em tempo real. Ficou de fora para não estourar ainda mais
  uma rodada já longa; a limitação é real e visível ao usuário (o campo diz "Com pessoa (automático)", não convida
  a escolher QUEM).
- **"Gerar de novo"/"Gerar variação" a partir de Copiar Dados** estão fiados nos MESMOS testes automatizados da
  D.1.1 (o mecanismo é idêntico — `custom_angle_replay_of`, `actions.again`/`actions.variation`); não foram
  reexercitados manualmente no Chrome nesta rodada porque não havia OpenAI configurada para produzir um criativo
  `completed` real a copiar (gerar um fake exigiria inserir direto no banco, o que testaria a MEMÓRIA do teste, não
  a tela — decidi não simular isso e reportar a lacuna em vez de fabricar uma prova fraca).
- **Acessibilidade**: os componentes reusados (`RadioCardGroup`, `Field`, `Modal` via Radix, `Checkbox`) já
  carregam foco/aria/teclado do design system existente — não houve auditoria de acessibilidade dedicada além de
  reuso desses componentes (nenhum teste com leitor de tela rodado nesta sessão).
- **Um pequeno incidente de processo, corrigido**: ao encerrar o ambiente local no fim da validação, usei
  `pkill -f "node server.js"` sem checar o PID antes — o mesmo tipo de erro já cometido (e corrigido) durante a
  investigação do STORE-01 na D.1.1. Desta vez verifiquei DEPOIS que nenhum outro processo relevante (`node-pg-migrate`,
  `test-db.mjs` de outra sessão ativa no checkout principal) foi afetado — o padrão de busca não colidiu com eles —
  mas o processo correto era checar ANTES, não depois. Registrado para não repetir.

## 8. Proposta de rollout em etapas

1. **Agora**: `CREATIVE_UI_V2_ORGS` vazio em todo ambiente real — ninguém vê a V2 além desta validação local.
2. **Revisão do usuário** (este documento + código) antes de qualquer próximo passo.
3. Se aprovado: ligar `CREATIVE_UI_V2_ORGS` para 1 conta interna de teste em ambiente real (não produção de
   cliente), confirmar o fluxo com Postgres/serviço reais de novo (não só local), sem gerar imagem real ainda.
4. Só depois: 1-2 contas de cliente voluntárias, com acompanhamento; nunca `*` sem antes fechar as lacunas do §7
   que forem consideradas bloqueantes (Subjects completo, Remarketing/Funil, se decidido que são necessários para
   o rollout amplo).
5. Rollout amplo (`*`) só depois do STORE-01/gate integrado confirmado estável em produção real (D.1.1 já fechou
   isso; manter monitorado) e de pelo menos uma rodada real de geração paga validando que a recomendação produz
   prompts sensatos na prática, não só em prévia.

**Parando aqui para revisão, como o comando pediu — sem deploy, sem merge, sem push.**
