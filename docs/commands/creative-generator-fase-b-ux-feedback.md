# Creative Generator V2 — Fase B + Diretriz de UX + Feedback/Histórico

## Objetivo desta rodada

Quero consolidar em um único direcionamento:

1. o **fechamento da Rodada 1 do A/B**;
2. a autorização para iniciar a **Fase B — CreativePlan V2 + Prompt Compiler**;
3. a **diretriz de UX** para garantir que o gerador continue simples e user friendly;
4. a inclusão de **feedback explícito do usuário** em cada criativo gerado;
5. a inclusão de uma ação de **“Copiar Dados”** para reutilizar rapidamente a configuração de um criativo que funcionou bem.

---

## 1. Fechamento da Rodada 1

A Rodada 1 está suficiente para encerrar a investigação inicial de anatomia.

**Não execute a Rodada 2 agora.**

Minha avaliação humana das 40 imagens foi:

- não encontrei dedos extras;
- não encontrei mãos claramente incorretas;
- não encontrei problemas anatômicos aparentes;
- a qualidade geral ficou boa;
- portanto, neste momento, não existe sinal suficiente para justificar mais 40 gerações apenas para investigar anatomia.

Quero aproveitar os achados qualitativos da Rodada 1 e transformá-los em regras estruturais da próxima fase.

### 1.1 Encerramento do experimento

A avaliação cega está encerrada.

Pode abrir o `private/manifest_private.json` e gerar o relatório da Rodada 1, mas **NÃO** quero que o relatório tente declarar um “vencedor” geral com base em `n=4` por célula.

Quero apenas:

- mapear os braços;
- confirmar tecnicamente o comportamento de `A/B/C/D/E`;
- registrar que nenhuma das 40 imagens apresentou problema anatômico aparente na avaliação humana;
- identificar a quais braços pertencem especificamente:
  - `IMG-009`;
  - `IMG-018`;
  - `IMG-037`.

Essas três foram exemplos de vestuário infantil adequado e quero saber se existe alguma relação com o braço gerador.

Também registre como conclusão:

> a regressão de anatomia observada anteriormente não se reproduziu nesta Rodada 1 após a instrumentação e os ajustes da Fase A.

Não interprete isso como prova estatística de que o problema foi eliminado permanentemente. É apenas o resultado deste experimento.

---

## 2. Pontos qualitativos encontrados

Os pontos que quero transformar em estrutura de produto agora são:

1. **Vestuário infantil**
   - crianças devem estar sempre bem vestidas;
   - evitar shorts muito curtos, saias curtas e qualquer composição inadequada;
   - isso deve ser dividido entre:
     - política global de menores;
     - política de marca mais restritiva.

2. **Direção do olhar**
   - em muitos casos a pessoa não olha para a câmera;
   - isso não deve ficar ao acaso do modelo;
   - precisa virar propriedade explícita da cena/plano.

3. **Coerência semântica entre produto e composição**
   - exemplo: uma estampa ligada a “Pai” não deveria sugerir automaticamente “Mãe”;
   - isso é problema de semântica do produto, não apenas de prompt.

---

## 3. Fase B autorizada

Com a Rodada 1 encerrada, autorizo iniciar a **Fase B — CreativePlan V2 + Prompt Compiler**.

Mas a Fase B deve considerar desde já estes novos conceitos:

- `gaze_mode`;
- `minor_safety_policy`;
- `brand_minor_wardrobe_policy`;
- espaço para `product.semantic_context`;
- compatibilidade futura com `Subjects`;
- compatibilidade futura com `relations/interactions`;
- compiler versionado.

**Não implemente ainda** toda a UI de Subjects.

**Também não implemente ainda** Product Enrichment via GPT.

Quero apenas que os contratos do CreativePlan não nos obriguem a quebrar schema depois quando C/F chegarem.

---

## 4. Vestuário infantil — separar safety de preferência da marca

Quando usamos crianças em criativos comerciais, quero que o sistema tenha uma proteção estrutural contra composições inadequadas.

Mas não quero hardcodar no core que toda criança do SaaS obrigatoriamente deve usar calça comprida, porque isso mistura safety com direção criativa da marca.

Quero duas camadas.

### 4.1 Camada global — política de menores

Sempre aplicar para personagens menores de idade:

- roupa apropriada para a idade;
- nada revelador;
- nada sexualizado;
- nada com estética adulta;
- poses naturais e apropriadas à idade;
- peças ajustadas de maneira normal, sem foco corporal;
- contexto comercial/familiar/cotidiano coerente.

Essa camada não é configurável para ficar mais permissiva.

### 4.2 Camada de marca — wardrobe policy

Para a Entre Nós, quero inicialmente algo equivalente a:

```json
{
  "minor_wardrobe_policy": {
    "enabled": true,
    "legs_coverage": "full",
    "allow_short_shorts": false,
    "allow_short_skirts": false,
    "allow_revealing_clothing": false,
    "style": "casual_age_appropriate"
  }
}
```

Na prática, para crianças da Entre Nós:

- preferir calça;
- jeans;
- sarja;
- legging apropriada;
- peças compridas;
- roupas casuais infantis;
- evitar shorts muito curtos;
- evitar saias curtas;
- evitar qualquer composição que exponha demais as pernas.

Não precisa usar exatamente esse schema se houver desenho melhor, mas quero essa separação entre:

- `global_minor_safety_policy`
- `brand_minor_wardrobe_policy`

Isso deverá entrar no `CreativePlan` / `Compiler` e futuramente ser configurável pelo Brand Kit.

---

## 5. Direção do olhar precisa deixar de ser aleatória

Outro achado forte:

aproximadamente 85% das imagens ficaram com a pessoa olhando para fora da câmera.

Não considero isso necessariamente erro visual, mas não quero que o modelo decida sozinho.

Quero transformar direção do olhar em propriedade explícita da cena/ângulo.

### 5.1 Tipo sugerido

```ts
type GazeMode =
  | "camera"
  | "interaction"
  | "off_camera"
  | "product"
  | "auto"
```

Semântica:

- `camera`: pessoa olha diretamente para a câmera.
- `interaction`: pessoa olha para outra pessoa ou para a ação.
- `off_camera`: olhar espontâneo para fora da câmera.
- `product`: olhar direcionado ao produto/objeto.
- `auto`: planner escolhe com base no ângulo/interação.

`auto` **não pode** significar simplesmente “deixar o modelo decidir”.

O planner precisa resolver `auto` para um valor concreto **antes** de compilar o prompt.

### 5.2 Defaults desejados

- pessoa única + `CAIMENTO` → `camera`;
- pessoa única + retrato editorial → `camera`;
- pessoa única + produto em foco → normalmente `camera`;
- lifestyle cotidiano → `camera` ou `off_camera`, dependendo do preset;
- duas ou mais pessoas interagindo → `interaction`;
- presente → `interaction`;
- leitura/brincadeira → `interaction`;
- creator selfie → normalmente `camera` / reflexo conforme o formato.

Quero isso incorporado ao desenho do `CreativePlan V2`.

---

## 6. Produto precisa influenciar a composição semântica

Hoje produto e persona/cena estão pouco relacionados.

Precisamos enriquecer o produto com contexto semântico.

Não quero inferir simplesmente pelo gênero da peça.

Quero representar o significado da estampa/produto.

### 6.1 Exemplos

#### `Brincar com Meu Pai`

Pode significar:

- wearer principal: criança;
- relationship theme: `father_child`;
- supporting adult recomendado: pai;
- supporting adult incompatível como sugestão automática: mãe.

#### `Mãe Primeira BFF`

Pode significar:

- wearer principal: criança ou mãe, dependendo do produto;
- relationship theme: `mother_child`;
- cena recomendada: mãe + filho(a).

#### `Irmãs em União`

- relationship theme: `siblings`;
- composition recommendation: duas irmãs.

### 6.2 Sugestão de estrutura

```json
{
  "semantic_context": {
    "wearer_roles": ["child"],
    "relationship_themes": ["father_child"],
    "recommended_supporting_roles": ["father"],
    "incompatible_auto_supporting_roles": ["mother"],
    "scene_intents": ["play", "bond", "family"]
  }
}
```

Não quero que `incompatible_auto_supporting_roles` bloqueie manualmente uma escolha do usuário.

A regra deve ser:

- recomendações automáticas respeitam a semântica;
- se o usuário escolher manualmente outra composição, pode prosseguir;
- o sistema mostra warning de possível incoerência.

Exemplo:

> Esta estampa está classificada como “pai e filho”, mas a cena selecionada usa “mãe” como pessoa de apoio.

A pessoa decide se quer continuar.

---

## 7. Isso reforça a função do Product Enrichment

Na Fase F já planejamos `Analisar produto com GPT`.

Agora esse enrichment deve incluir também:

- público provável;
- faixa etária;
- tipo de peça;
- wearer roles;
- relationship themes;
- supporting roles recomendados;
- scene intents;
- contextos recomendados;
- ângulos recomendados;
- restrições de cena;
- termos/frases visíveis relevantes da estampa quando puderem alterar o contexto.

Tudo como proposta estruturada.

**Nunca gravar automaticamente sem aprovação.**

---

## 8. Não quero corrigir isso com texto solto

Não resolva:

- direção do olhar;
- vestuário infantil;
- relação pai/mãe;
- quantidade de pessoas;

simplesmente acrescentando parágrafos ao prompt atual.

Esses itens devem nascer como **dados do plano**.

Depois o Prompt Compiler transforma em instrução.

A direção continua:

`UI -> CreativeConfig -> CreativePlan -> Prompt Compiler -> Generation`

---

## 9. Diretriz de UX — manter o sistema user friendly

Um ponto de produto **muito importante**:

**não confunda a complexidade do CreativePlan com a complexidade da interface.**

O `CreativePlan` pode e deve ser rico internamente, mas o usuário **não pode** precisar preencher 20–30 campos para gerar um criativo.

### 9.1 Regra central

> Quanto mais informação o sistema já possui sobre produto, marca, nicho, contexto e persona, menos perguntas fazemos ao usuário.

Quero **progressive disclosure**.

### 9.2 Fluxo padrão deve ser muito curto

Para a maioria das gerações, algo próximo de:

1. Produto
2. Objetivo / tipo de criativo
3. Pessoas, somente quando necessário
4. Gerar

Ou idealmente:

1. Produto
2. `Gerar com configuração recomendada`

O sistema resolve o restante.

### 9.3 Não expor campos técnicos como formulário padrão

Não quero expor campos como:

- `gaze_mode`;
- `pose_risk`;
- `minor_wardrobe_policy`;
- `semantic_context`;
- `relationship_theme`;
- `reference_roles`;
- `composition_policy`;
- `compiler_settings`;

como formulário padrão.

Esses campos pertencem ao motor.

### 9.4 Auto-resolução

Ao selecionar um produto, o sistema deve montar automaticamente uma recomendação usando:

- Product Enrichment;
- Brand Kit;
- Niche Kit;
- contexto padrão;
- personas;
- semântica da estampa;
- tipo da peça;
- público;
- ângulos permitidos;
- histórico/configurações da marca.

#### Exemplo

Produto:

`Brincar com Meu Pai — Pipa Menina`

O sistema pode resolver automaticamente:

- pessoa principal: menina;
- pessoa de apoio: pai;
- relationship theme: `father_child`;
- roupa da criança: política da Entre Nós;
- roupa do pai: neutra;
- ângulo recomendado: conexão/vínculo;
- interação recomendada: brincar;
- gaze: `interaction`;
- contexto: parque/casa;
- QA: ligado por haver duas pessoas;
- formato: baseado na escolha atual/padrão.

O usuário não deve preencher tudo isso.

Ele vê algo como:

> **Sugestão para este produto**  
> Menina + pai · brincando · ambiente externo · conexão/vínculo

e pode simplesmente clicar:

`Usar sugestão`

### 9.5 Alterações em linguagem humana

Em vez de mostrar atributos técnicos, mostrar escolhas compreensíveis.

Não:

`gaze_mode = interaction`

Mostrar:

**Olhar**
- Para a câmera
- Entre as pessoas
- Espontâneo
- Para o produto

Não:

`relationship_theme = father_child`

Mostrar:

**Quem acompanha a criança?**
- Pai
- Mãe
- Irmão/irmã
- Ninguém
- Outro

Não:

`pose_risk = high`

Mostrar, se realmente necessário:

> Esta composição é mais complexa e pode exigir nova geração.

### 9.6 Personalizar cena

Quando o usuário quiser controle maior, abrir:

`Personalizar cena`

Aí podemos apresentar poucos blocos:

- **Pessoas** — quem aparece?
- **Interação** — o que estão fazendo?
- **Ambiente** — onde acontece?
- **Enquadramento** — como a foto é feita?
- **Olhar** — para onde olham?

Mesmo aqui, evitar transformar isso num formulário enorme.

Usar:

- cards;
- chips;
- thumbnails;
- presets;
- sugestões;
- toggles quando realmente necessários.

### 9.7 Avançado

Separar uma terceira camada:

`Avançado`

Aqui podem existir controles que usuários comuns raramente precisam:

- contexto específico;
- qualidade;
- quantidade;
- comportamento de QA;
- referências;
- prompt/plan;
- opções técnicas.

Prompt, JSON e Compiler são ferramentas de debug/admin, não elementos principais da experiência.

### 9.8 GPT deve reduzir preenchimento

Brand Kit, Niche Kit, Contexto, Personas, Ângulos e Product Enrichment não devem virar questionários gigantes.

Priorizar fluxos como:

- “Descreva sua marca em poucas palavras”
- “Informe o site/loja e deixe o sistema montar uma proposta”

Depois mostrar:

`Revise o que encontramos`

em vez de exigir que o usuário preencha cada atributo do schema.

### 9.9 Regra para novos campos

Sempre que adicionarmos um campo ao CreativePlan, pergunte:

1. O usuário realmente precisa escolher isso?
2. Podemos inferir?
3. Existe um default seguro?
4. Produto já nos informa?
5. Brand Kit já nos informa?
6. Niche Kit já nos informa?
7. Persona já nos informa?
8. O ângulo pode resolver?
9. Podemos perguntar apenas em caso de ambiguidade?

Somente se nenhuma dessas fontes resolver, criar controle visível.

### 9.10 Meta de interação

Para uma geração comum com produto já cadastrado:

**máximo ideal de 2–4 decisões explícitas do usuário.**

Exemplo:

1. selecionar produto;
2. selecionar `Criativo`;
3. aceitar cena recomendada ou trocar pessoas;
4. Gerar.

Todo o restante é derivado.

Para Mockup:

1. selecionar produto;
2. escolher Preset / Receita / Referência;
3. Gerar.

Também não transformar Mockup Blueprint em formulário obrigatório.

### 9.11 Regra arquitetural

Quero exatamente o seguinte equilíbrio:

- **backend rico**;
- **planner inteligente**;
- **UI simples**.

Ao entregar a Fase B, inclua também um pequeno mapeamento:

`campo do CreativePlan -> origem do valor`

com origens como:

- `user`
- `product`
- `product_enrichment`
- `brand`
- `niche`
- `persona`
- `angle`
- `planner_default`
- `safety_policy`

Quero enxergar claramente quais campos realmente exigem input manual e quais são derivados.

**Não avance para uma interface que simplesmente espelhe o schema do CreativePlan.**

---

## 10. Gostei / Não Gostei — feedback explícito do usuário

Quero começar a construir um histórico real do que o usuário aprovou ou rejeitou.

### 10.1 Ação por criativo gerado

Cada criativo gerado deve permitir feedback simples e explícito:

- `Gostei`
- `Não gostei`

Opcionalmente pode existir depois:

- `Neutro`
- `Favoritar`
- `Salvar como referência`

Mas inicialmente o obrigatório é:

- `Gostei`
- `Não gostei`

### 10.2 Objetivo do feedback

Esse feedback deve servir para:

- criar histórico de preferências por loja / organização;
- entender quais composições performam melhor visualmente;
- alimentar recomendações futuras;
- ajudar o planner a sugerir cenas mais próximas do que o usuário costuma aprovar;
- permitir auditoria do que foi bem recebido ou mal recebido.

### 10.3 O que salvar junto com o feedback

Ao marcar `Gostei` ou `Não gostei`, salvar junto:

- `creative_id`
- `organization_id`
- `store_id` (quando existir)
- `job_id`
- `user_id` (quem marcou)
- status do feedback (`liked` / `disliked`)
- timestamp
- `plan_schema_version`
- `compiler_version`
- `prompt_version`
- `angle`
- produto(s)
- personas/subjects usados
- contexto
- objective
- mode (`creative` / `mockup`)
- flags relevantes (ex.: QA ligado, normalize refs, etc.)
- asset/result correspondente

Não precisa mostrar tudo na UI, mas precisa ficar disponível no histórico.

### 10.4 Uso futuro

Ainda não quero um sistema completo de aprendizado automático em cima disso, mas quero preparar base para:

- “criativos parecidos com os que você gostou”;
- “ângulos mais aprovados nesta loja”;
- “contextos mais aprovados”;
- “pessoas/composições mais aprovadas”.

---

## 11. Copiar Dados — reaproveitar o que funcionou

Quero uma ação por criativo gerado:

`Copiar Dados`

### 11.1 O que significa

Ao clicar `Copiar Dados`, o sistema deve abrir o gerador já **pré-populado** com os dados que geraram aquele criativo.

Isso pode ser:

- mesma modalidade (`creative` / `mockup`);
- mesmo produto;
- mesmo objetivo;
- mesmo angle/angle_ref;
- mesma persona/configuração de pessoas;
- mesmo contexto;
- mesmo formato;
- mesma qualidade;
- mesmo plano ou equivalente reconstituído do plano;
- mesmas escolhas relevantes de cena.

Não precisa copiar IDs de execução/camadas operacionais.

Precisa copiar o que faz sentido como **input de geração**.

### 11.2 Objetivo

Isso deve permitir:

- gerar variações rápidas de algo que funcionou;
- editar levemente uma composição boa;
- reaproveitar configuração sem montar tudo de novo;
- transformar um criativo bom em ponto de partida de outro.

### 11.3 Requisito de UX

`Copiar Dados` deve ser simples.

Exemplo de fluxo:

- no card/item do criativo gerado:
  - `Gostei`
  - `Não gostei`
  - `Copiar Dados`

Ao clicar em `Copiar Dados`:

- abrir o Gerador;
- preencher automaticamente os campos disponíveis;
- mostrar um resumo do que foi trazido;
- permitir gerar de novo imediatamente ou ajustar.

### 11.4 Fonte da verdade

A origem dessa cópia deve ser preferencialmente o `CreativePlan` persistido, não um parse frágil da tela.

Se for preciso, criar um helper do tipo:

- `buildGenerationDraftFromPlan(plan, resultMetadata)`

para reconstruir o draft de entrada do gerador.

---

## 12. Requisitos da Fase B

Implementar:

1. `CreativePlan schema_version=2`;
2. novo Prompt Compiler;
3. `CompiledPrompt`;
4. seções determinísticas/versionadas;
5. compatibilidade total com plano V1;
6. golden tests provando que V1 continua byte a byte;
7. persistência de `plan_schema_version`;
8. persistência de `compiler_version`;
9. `gaze_mode` resolvido no plano;
10. políticas de menor representáveis no plano;
11. espaço tipado para `product.semantic_context`;
12. não depender da nova UI;
13. permitir montar e testar planos V2 por fixture/API;
14. modelar também a base necessária para:
    - feedback `Gostei / Não gostei`;
    - ação `Copiar Dados`;
    - histórico de aprovação/reprovação.

**Não remover o `PromptBuilder` atual** até a equivalência necessária estar provada.

---

## 13. Direção do Compiler

Quero que o compiler trabalhe com seções explícitas, aproximadamente:

1. `fidelity_rules`;
2. `reference_roles`;
3. `product_semantic_context`;
4. `people_composition_contract`;
5. `gaze`;
6. `scene_action`;
7. `brand`;
8. `niche`;
9. `context`;
10. `minor_wardrobe_policy`;
11. `text_rules`;
12. `avoid`;
13. `output_format`.

A ordem final pode ser ajustada se houver justificativa técnica.

O importante é que consigamos inspecionar algo como:

```json
{
  "section": "gaze",
  "source": "angle",
  "value": "camera"
}
```

em vez de descobrir depois que isso estava perdido dentro de milhares de caracteres.

---

## 14. Compatibilidade

O schema V2 deve ser aditivo.

Nada de converter histórico antigo.

- plano V1 continua legível;
- plano V1 continua compilável pelo fluxo antigo;
- jobs antigos continuam abrindo;
- aliases atuais continuam funcionando;
- Fase B não deve exigir ainda migration de `Subjects`.

---

## 15. Entrega esperada da Fase B

Antes de seguir para a Fase C, me entregue:

1. commits;
2. contratos novos/alterados;
3. migration;
4. exemplos de `CreativePlan V1` e `V2` para o mesmo request;
5. exemplo completo de `CompiledPrompt`;
6. lista das seções do compiler;
7. como `gaze_mode` é resolvido;
8. como as políticas de menores entram no plano;
9. como `product.semantic_context` foi preparado sem implementar ainda o enrichment GPT;
10. golden tests;
11. suíte completa;
12. backward compatibility;
13. riscos ou decisões novas descobertas;
14. confirmação de nenhuma chamada OpenAI desnecessária;
15. confirmação de sem push/deploy;
16. proposta de modelagem / persistência para:
    - feedback `Gostei / Não gostei`;
    - ação `Copiar Dados`;
    - mapeamento `campo do CreativePlan -> origem do valor`.

**Não inicie a Fase C automaticamente.**

Quero revisar a arquitetura do `CreativePlan V2` antes de começarmos `Subjects` / `Relations`.
