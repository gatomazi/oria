# Brief de auditoria — `whatsapp-webhook-go`

> Documento **autocontido**. Quem for executá-lo não precisa conhecer o projeto que o originou nem
> ter acesso a outra documentação. Entregue este arquivo inteiro à sessão/agente que trabalhar
> dentro do repositório `whatsapp-webhook-go`.

---

## 0. Instrução ao executor

Você vai auditar o repositório **`whatsapp-webhook-go`**, um serviço em Go que intermedia o envio e
o recebimento de mensagens de WhatsApp pela API oficial da Meta (Cloud API / WABA).

**Esta é uma auditoria READ-ONLY.**

- **Não altere, crie ou apague nenhum arquivo do projeto.**
- Não faça refactor, não corrija bugs, não abra PR, não rode migrations, não mude configuração.
- Pode ler código, rodar `grep`/busca, rodar testes e builds seguros.
- **Entregue fatos, não correções.** Recomendação, quando houver, deve estar rotulada como tal e
  nunca apresentada como estado atual.
- Onde não conseguir verificar, escreva **`NOT VERIFIED`** e diga exatamente o que falta (comando,
  painel, credencial, repositório). **Não assuma. Não preencha lacuna com suposição plausível.**
- Cite **`arquivo:linha`** em toda afirmação factual.

---

## 1. Contexto mínimo

Existe um painel administrativo (Node/Express, outro repositório) que hoje opera **uma única
empresa**, com três lojas da mesma dona. Ele é **single-tenant por desenho declarado** — não é um
descuido, é o escopo com que foi construído.

Esse painel está sendo transformado em **SaaS multi-tenant**. O modelo de tenancy já está decidido:

```text
1 assinatura = 1 Organization = 1 Store ativa
```

Um mesmo dono com duas lojas terá **duas Organizations independentes**, isoladas entre si como
clientes distintos. Não haverá visão consolidada entre Organizations.

**Onde o seu repositório entra.** O painel Node **não seleciona** a WABA nem o `phone_number_id`
usado para enviar mensagens. Ele **lê** esses valores da resposta de healthcheck do serviço Go:

```js
// no repositório do painel, server.js:15213
const phoneNumberId = connected ? healthResult.value.phone_number_id || null : null;
```

Ou seja: **a identidade do remetente do WhatsApp é propriedade do serviço Go**, não do painel. Hoje
existe exatamente um número, implícito no serviço.

Isso torna o seu repositório um **bloqueador da fase de multi-tenancy** do painel: enquanto o
serviço tiver um remetente implícito e único, o WhatsApp não pode ser multi-tenant.

### O alvo contra o qual comparar

O painel já fixou este invariant, que o serviço Go precisará satisfazer:

> **INV-25 — Nenhum serviço externo da plataforma detém identidade de tenant implícita.**
> Todo serviço auxiliar recebe a identidade do tenant **por requisição**; o chamador nunca depende de
> um valor padrão configurado dentro do serviço.
> *Verificação:* com duas organizations, dois envios usam dois `phone_number_id` distintos, e nenhum
> deles vem da configuração interna do serviço.

Use isso como régua: para cada mecanismo que encontrar, pergunte se ele **recebe** o escopo ou se o
**descobre**.

---

## 2. O padrão que estamos caçando

Na auditoria do painel, o achado mais produtivo foi este padrão, e ele se repetiu doze vezes:

> O código foi cuidadoso com **"e se não estiver conectado?"** e descuidado com
> **"e se pertencer a outro escopo?"**

Procure recursos **globais ou "selecionados"** que sejam consumidos dentro de operações que deveriam
ser escopadas por tenant, **sem validação explícita de ownership**.

### Padrões de busca que renderam achados

Aplique cada um:

- `findFirst`, `[0]`, `rows[0]`, `.Find(`, `LIMIT 1` **sem `ORDER BY` determinístico**;
- **"primeiro registro que casa"** como forma de descobrir escopo — no painel, o webhook descobria a
  loja **testando o segredo de cada loja em sequência** até um HMAC validar;
- conta/número/credencial **selecionada globalmente**, lida de config, variável de ambiente ou
  tabela de linha única (procure `CHECK (id = 1)` e equivalentes);
- **variável de ambiente usada como identidade de tenant**;
- **singletons, caches e memoização que guardem escopo entre requisições** — um cache cuja chave
  não inclui o tenant é uma leitura cross-tenant;
- fallback do tipo **"se só existe um candidato, use esse"** (no painel isso era inofensivo com três
  lojas e passaria a disparar em 100% dos tenants no modelo 1:1);
- **jobs e webhooks que descobrem escopo em vez de recebê-lo**;
- escopo vindo de **entrada não confiável** (query string, body, header) e usado para escolher dados
  ou credenciais.

---

## 3. Perguntas que a auditoria deve responder

Responda a todas. Se alguma não se aplicar ao serviço, diga isso explicitamente.

### Identidade do remetente
1. **Como o serviço seleciona a WABA?** Variável de ambiente, config, banco, header da requisição?
2. **Como seleciona o `phone_number_id`?** Mesma pergunta. Ele é fixo por processo?
3. O healthcheck expõe `phone_number_id` (o painel lê de lá). **Que outros campos ele expõe?** O
   healthcheck exige autenticação?
4. Existe suporte a **mais de um número** hoje, mesmo que não usado? Se sim, como se escolhe entre
   eles?

### Estado e escopo
5. **Existe estado global ou singleton no processo?** Variáveis de pacote, `sync.Once`, clientes HTTP
   com credencial embutida, caches de token, mapas de config. Liste cada um e diga se carrega escopo.
6. **Há premissa de uma única Organization/instalação** no código? Procure comentários que digam
   isso — no painel, a causa-raiz estava declarada num comentário.

### Credenciais
7. **Como as credenciais da Meta são armazenadas?** (access token, app secret, verify token do
   webhook.) Estão em env, arquivo, banco? **Estão cifradas?**
8. As credenciais **aparecem em log**, em mensagem de erro ou em resposta de API? Há masking?
9. Há **rotação** de token? Como o serviço lida com expiração?

### Webhooks de entrada
10. **Como um webhook recebido da Meta é roteado?** Como o serviço decide a que instalação/conta o
    evento pertence — pela URL, por um campo do payload, pelo `phone_number_id`, ou por tentativa?
11. A **assinatura da Meta** (`X-Hub-Signature-256`) é verificada? Com comparação em tempo constante?
    O corpo cru é preservado para isso?
12. Há **idempotência** por id de evento? Há proteção contra **replay**?
13. Como o serviço repassa o evento ao painel Node? Com que autenticação? *(No painel, o repasse
    chega em `POST /api/webhooks/whatsapp` e é protegido por um `?secret=` opcional comparado com
    `!==` — não timing-safe. Confirme o outro lado desse contrato.)*

### Caminho para multi-tenant
14. **Como seria o vínculo correto com `organization_id`?** Descreva o que precisaria mudar para que
    o serviço recebesse a identidade do remetente **por requisição** (INV-25), em vez de tê-la fixa.
15. O serviço precisaria de **armazenamento próprio** por tenant, ou bastaria receber tudo do painel
    a cada chamada? Argumente com base no código real.
16. **Quais achados alteram o custo de migração** — para mais ou para menos? Diga explicitamente o
    que já está pronto para multi-tenant e o que precisa ser reescrito.
17. **Quais novos invariants** (no estilo do INV-25 acima) precisariam existir para impedir regressão
    depois da migração? Redija-os de forma **verificável**: cada um tem que virar um teste ou um lint,
    não um princípio genérico.

---

## 4. Como classificar cada achado

### Categoria de ownership — escolha exatamente uma

| # | Categoria | Significado |
|---|---|---|
| 1 | **já organization-scoped** | o escopo é derivado do tenant e validado |
| 2 | **explicitamente atribuído** | há atribuição deliberada e verificada |
| 3 | **não atribuído e corretamente excluído** | ausência detectada e tratada fail-closed |
| 4 | **default implícito** | funciona hoje porque só há um candidato; quebra em silêncio no segundo tenant |
| 5 | **global indevido** | recurso de processo/instalação consumido em operação escopada |
| 6 | **potencial cross-tenant** | o escopo pode ser influenciado por entrada não confiável ou por ordem de registros |

**Registre também as categorias 1-3.** Elas são o padrão-alvo, mostram o que já está certo e
reduzem o trabalho de implementação. Na auditoria do painel, encontrar o padrão correto já
implementado noutro arquivo baixou o custo estimado de várias correções.

### Formato de cada achado

```text
F-xx — <título curto>
Categoria: <1-6>
FATO: <o que o código faz, com arquivo:linha>
IMPACTO: <o que acontece em consequência>
Prioridade: P0 | P1 | P2 | P3
Risco: CRITICAL | HIGH | MEDIUM | LOW
Esforço: XS | S | M | L | XL
Severidade hoje: <...>
Severidade no segundo tenant: <...>
```

**A distinção "hoje / segundo tenant" é obrigatória** e costuma ser o dado mais informativo. No
painel, apenas 4 de 12 achados eram P1 hoje — **onze dos doze viravam P0 ou P1 no segundo tenant**.
É o que explica por que a migração não é incremental.

**Não infle prioridade.** Classifique pelo que a evidência sustenta. Um defeito latente e não
explorável é um defeito latente e não explorável — registre como tal, e diga por que ainda assim
merece constar.

---

## 5. Entregável

Um relatório com:

1. **Resumo executivo** — o serviço está pronto para multi-tenant? O que o impede?
2. **Inventário de achados** F-01..F-nn no formato acima.
3. **Contagem por categoria** (1-6).
4. **Padrões corretos já existentes** (categorias 1-3), com `arquivo:linha`.
5. **Respostas diretas** às 17 perguntas da seção 3.
6. **Invariants propostos**, cada um verificável por teste ou lint.
7. **Estimativa de esforço de migração**, em XS/S/M/L/XL por área — **sem estimar horas**.
8. **`NOT VERIFIED`** — lista explícita do que não pôde ser verificado e o que falta para verificar.

---

## 6. O que NÃO fazer

- Não alterar código, configuração ou infraestrutura.
- Não implementar nenhuma das mudanças que a auditoria identificar.
- Não assumir comportamento por analogia com outros serviços.
- Não apresentar recomendação como se fosse fato observado.
- Não omitir o que está **certo** — o padrão-alvo é parte do resultado.
- Não parar a auditoria para pedir confirmação: registre a dúvida como `NOT VERIFIED` ou como
  decisão em aberto e siga.

---

## 7. Por que isto importa

Este serviço é a **única lacuna de cobertura** que resta antes de escrever o plano de productização
do painel. Todo o resto — rotas, tabelas, jobs, webhooks, integrações, storage, credenciais — já foi
auditado. O plano de migração não pode sequenciar a fase de WhatsApp sem saber o que este
repositório assume sobre identidade e escopo.

Concretamente: o painel precisa saber se tornar o WhatsApp multi-tenant é **uma mudança de contrato**
(o serviço passa a receber o remetente por requisição) ou **uma reescrita** (o serviço tem estado e
premissas de instalação única espalhados). A resposta muda o custo e a posição dessa fase no plano.
