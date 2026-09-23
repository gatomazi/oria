# Creative Generator V2 — Especificação de evolução

## Contexto

O Gerador de Criativos já está funcional e possui uma base importante:

- motores de geração;
- produtos com imagens de referência;
- Brand Kit;
- Niche Kit;
- Contextos;
- Personas;
- geração em lote;
- histórico;
- pré-visualização de prompt.

A próxima evolução deve atacar dois problemas diferentes:

1. **qualidade e controle da geração**;
2. **experiência de montagem do criativo**.

O objetivo não é apenas redesenhar a tela atual. É transformar a geração em um sistema estruturado, previsível, extensível por marca e reutilizável também para geração de mockups de e-commerce.

---

# 1. Prioridade zero — auditar a regressão de qualidade

Antes de alterar prompts ou UI, comparar a implementação que rodava localmente com a implementação atual do serviço.

Investigar especificamente:

- modelo usado;
- endpoint/API utilizado;
- parâmetros de qualidade;
- resolução enviada e resolução solicitada;
- formato final;
- ordem das imagens de referência;
- quantidade de imagens de referência;
- transformação/compressão das imagens antes do envio;
- prompt-base;
- prompt de sistema;
- wrappers adicionados pelo backend;
- serialização do prompt;
- ordem das seções do prompt;
- regras negativas;
- tratamento de pessoa/persona;
- retries;
- qualquer normalização ou truncamento;
- diferenças entre execução local e execução via serviço.

Gerar um relatório objetivo contendo:

- diferenças encontradas;
- quais diferenças podem afetar anatomia;
- quais diferenças podem afetar fidelidade do produto;
- quais diferenças podem afetar composição;
- recomendação concreta de correção.

**Não partir do pressuposto de que “mais prompt” resolve mãos e dedos extras.**

---

# 2. Nova arquitetura da geração

A geração não deve ser montada diretamente como um prompt gigante.

Criar uma etapa intermediária estruturada:

`configuração da UI -> CreativePlan JSON -> Prompt Compiler -> Image Generation -> QA -> resultado`

## CreativePlan

O CreativePlan deve representar de forma explícita:

- objetivo;
- produto(s);
- pessoas;
- relação entre pessoas;
- quem veste qual produto;
- interação;
- ângulo;
- cena;
- contexto;
- marca;
- nicho;
- enquadramento;
- formato;
- quantidade;
- regras obrigatórias;
- restrições;
- texto na imagem;
- copy externa;
- qualidade.

Exemplo conceitual:

```json
{
  "objective": "clean_creative",
  "products": [],
  "subjects": [],
  "interaction": {},
  "angle": {},
  "scene": {},
  "brand": {},
  "niche": {},
  "context": {},
  "output": {},
  "constraints": {}
}
```

O JSON deve ser persistido junto ao job para permitir:

- debugging;
- reprodução;
- comparação;
- versionamento;
- regeneração;
- auditoria.

---

# 3. Pessoas e composição — nova entidade central

Hoje a Persona é tratada quase como uma escolha única.

Isso é insuficiente para marcas como Entre Nós.

Precisamos separar:

- **pessoa principal**;
- **pessoas de apoio**;
- **relação entre elas**;
- **quem usa o produto**;
- **como elas interagem**.

## Subject / Person

Criar uma estrutura equivalente a:

```ts
type CreativeSubject = {
  id: string
  role: "primary" | "supporting"
  personaId?: string
  generatedProfile?: {
    label: string
    ageRange?: string
    genderPresentation?: string
  }
  relationToPrimary?:
    | "mother"
    | "father"
    | "daughter"
    | "son"
    | "sibling"
    | "partner"
    | "friend"
    | "grandparent"
    | "custom"
  wearsProduct: boolean
  productId?: string
  prominence: "hero" | "secondary" | "background"
}
```

## Exemplos que a UI deve permitir

### Infantil

- pessoa principal: menino 5–7 anos;
- veste o produto: sim;
- adicionar pessoa:
  - mãe;
  - veste o produto: não;
- interação:
  - brincando juntos;
  - lendo juntos;
  - abraço espontâneo;
  - caminhando;
  - fazendo atividade em casa.

### Casal

- pessoa principal: mulher;
- segunda pessoa: parceiro;
- ambos usam produtos diferentes do mesmo kit.

### Família

- mãe;
- pai;
- criança;
- bebê;
- produtos atribuíveis individualmente.

---

# 4. Nova etapa “Pessoas e cena”

Adicionar ao Gerador uma etapa própria.

## Pessoa principal

Campos:

- persona;
- usar pessoa automática;
- produto que está vestindo;
- enquadramento desejado.

## Adicionar pessoa

Botão:

`+ Adicionar pessoa`

Para cada pessoa adicionada:

- persona;
- relação;
- usa produto?;
- qual produto?;
- importância visual.

## Interação

Presets iniciais:

- espontâneo / candid;
- abraço;
- conversa;
- olhando um para o outro;
- caminhando;
- brincando;
- lendo;
- cozinhando;
- fazendo atividade;
- presenteando;
- foto de grupo;
- customizado.

O sistema pode filtrar interações incompatíveis com idade ou quantidade de pessoas.

---

# 5. Anatomia e confiabilidade

Prompts negativos ajudam, mas não são suficientes.

Implementar três camadas.

## 5.1 Prompt compiler consciente da composição

O prompt deve informar de forma explícita:

- quantidade exata de pessoas;
- quem está ao lado de quem;
- quantidade de mãos potencialmente visíveis;
- qual pessoa segura cada objeto;
- evitar sobreposição impossível;
- evitar mãos cruzando corpos de forma ambígua;
- anatomia natural;
- cinco dedos por mão quando visíveis;
- membros completos e coerentes.

Evitar cenas desnecessariamente complexas quando o objetivo for comercial.

## 5.2 Pose risk

Adicionar internamente um conceito de risco de anatomia:

- low;
- medium;
- high.

Exemplo:

- retrato sem mãos: low;
- pessoa segurando xícara: medium;
- três crianças abraçadas segurando objetos: high.

Para geração comercial, favorecer automaticamente composições de menor risco, a menos que o usuário escolha explicitamente uma interação mais complexa.

## 5.3 QA pós-geração

Depois da geração, executar uma inspeção visual estruturada.

Avaliar:

- mãos;
- quantidade de dedos;
- braços;
- pernas;
- rostos;
- olhos;
- pessoas fundidas;
- objetos fundidos;
- texto indesejado;
- fidelidade do produto;
- fidelidade da estampa;
- quantidade correta de pessoas.

Exemplo:

```json
{
  "anatomy": {
    "pass": false,
    "issues": ["extra_finger_left_hand"]
  },
  "productFidelity": {
    "pass": true
  },
  "composition": {
    "pass": true
  }
}
```

Permitir um retry automático limitado quando falhar em problemas objetivos.

Não criar loop infinito.

Salvar o resultado do QA no job.

---

# 6. Repensar os “Ângulos”

Os ângulos atuais estão numerosos, parcialmente sobrepostos e ainda carregam uma origem muito ligada aos criativos regionais.

Reduzir o catálogo global.

## Sugestão de ângulos globais

### 1. Lifestyle cotidiano

Pessoa usando o produto em uma situação natural do dia a dia.

### 2. Conexão / vínculo

Duas ou mais pessoas interagindo de forma genuína.

### 3. Retrato editorial

Pessoa como protagonista, composição mais limpa e controlada.

### 4. Ação / movimento

Pessoa realizando uma atividade compatível com o produto e contexto.

### 5. Produto em foco

Produto usado ou apresentado com leitura visual prioritária.

### 6. Produto sem pessoa

Flatlay, cabide, dobrado, composição de e-commerce ou editorial.

Opcionalmente manter:

### 7. Creator / social

Linguagem de conteúdo espontâneo, sem fingir depoimento.

---

# 7. Ângulos customizáveis por marca

Além dos ângulos globais, permitir que uma organização/marca crie seus próprios ângulos.

Criar entidade:

```ts
type CreativeAngle = {
  id: string
  scope: "system" | "organization" | "brand"
  brandId?: string
  name: string
  description: string
  objective?: string
  promptInstructions: string
  allowedProductTypes?: string[]
  peopleMode?: "none" | "single" | "multiple" | "any"
  active: boolean
  version: number
}
```

Na marca deve existir uma área:

`Ângulos da marca`

Ações:

- novo;
- editar;
- duplicar;
- arquivar;
- gerar com GPT;
- restaurar versão.

Assim uma marca de família pode ter:

- mãe e filho;
- irmãos;
- casal;
- família em casa;
- presente afetivo.

Enquanto uma marca regional pode ter:

- pertencimento local;
- cenário da cidade;
- identidade cultural;
- lifestyle urbano.

Sem contaminar o catálogo global.

---

# 8. Produtos + Commerce Connector

A aba Produtos deve suportar duas origens:

- manual;
- commerce connector.

Criar uma abstração de fonte de produto.

Exemplo:

```ts
type ProductSource =
  | { type: "manual" }
  | {
      type: "connector"
      connectorId: string
      externalProductId: string
    }
```

Quando existir um connector de comércio compatível:

- permitir sincronizar produtos;
- importar imagens;
- nome;
- descrição;
- variantes;
- URL;
- disponibilidade;
- SKU, quando existir;
- categoria/tipo;
- metadados úteis.

Mostrar badge:

- Manual;
- Sincronizado;
- Atualização pendente;
- Erro de sincronização.

A geração não deve depender obrigatoriamente do connector.

O cadastro manual continua existindo.

## Enriquecimento por GPT

Depois de importar, permitir:

`Analisar produto com GPT`

O sistema pode sugerir:

- tipo de peça;
- público;
- idade;
- gênero de modelagem, se aplicável;
- características visuais;
- usos;
- ambientes;
- restrições;
- quais ângulos fazem sentido.

O usuário aprova antes de salvar.

---

# 9. Brand Kit, Niche Kit e Contexto

Os três conceitos são válidos, porém hoje parecem cadastros separados demais.

Padronizar a experiência.

Cada um deve ter:

- estado vazio consistente;
- botão Novo;
- botão “Preencher com GPT”;
- formulário guiado;
- preview estruturado;
- versão;
- status;
- editar;
- duplicar;
- arquivar.

## Preenchimento com GPT

Não simplesmente gerar texto livre.

Usar perguntas guiadas + Structured Output.

### Brand Kit

GPT deve estruturar:

- posicionamento;
- público;
- tom de voz;
- visual;
- valores;
- elementos recorrentes;
- o que evitar;
- restrições comerciais.

### Niche Kit

- tipo de mercado;
- produtos;
- ambientes naturais;
- situações de uso;
- materiais;
- clichês;
- oportunidades;
- problemas recorrentes de criativo;
- linguagem visual.

### Contexto

- local;
- atividade;
- momento;
- personagens;
- objetos;
- iluminação;
- clima;
- atmosfera;
- restrições.

---

# 10. Biblioteca criativa

Considerar agrupar conceitualmente:

- Brand Kit;
- Niche Kit;
- Contextos;
- Personas;
- Ângulos;
- Receitas de Mockup.

Não é obrigatório mudar toda a navegação agora, mas a UI deve passar a tratá-los como partes de uma mesma “biblioteca criativa”.

---

# 11. Gerador de Mockups

Adicionar um novo modo ao Gerador.

No topo da geração:

`Criativo | Mockup`

## Objetivo

Aproveitar:

- produto;
- referências;
- marca;
- nicho;
- persona;
- contexto;
- pipeline de geração.

Mas com lógica específica para e-commerce.

---

# 12. Modos de Mockup

Presets iniciais:

- modelo editorial;
- modelo e-commerce clean;
- flatlay;
- cabide;
- peça dobrada;
- close de estampa;
- detalhe de tecido;
- conjunto / kit;
- composição para card de categoria.

---

# 13. “Usar mockup como referência”

Adicionar um fluxo central:

`Adicionar mockup de referência`

O usuário faz upload de uma imagem de outra loja, Pinterest, catálogo ou referência própria.

O sistema NÃO deve apenas mandar a imagem de forma opaca para o gerador.

Primeiro executar uma análise visual estruturada.

## Mockup Blueprint

Extrair:

- aspect ratio;
- tipo de cena;
- fundo;
- iluminação;
- direção da luz;
- intensidade;
- lente percebida;
- distância;
- enquadramento;
- posição da pessoa;
- pose;
- posição das mãos;
- crop;
- espaço negativo;
- cor dominante;
- styling;
- caimento da camiseta;
- posição do produto;
- escala do produto;
- distância da câmera;
- profundidade de campo;
- tratamento editorial;
- elementos do cenário.

Exemplo:

```json
{
  "mode": "editorial_model",
  "camera": {
    "framing": "mid_thigh",
    "orientation": "vertical",
    "angle": "eye_level"
  },
  "lighting": {
    "type": "soft_side_light",
    "temperature": "warm"
  },
  "background": {
    "type": "minimal_interior",
    "tone": "light_beige"
  },
  "subject": {
    "pose": "three_quarter",
    "expression": "natural"
  },
  "garment": {
    "fit": "regular",
    "visibility": "full_front"
  }
}
```

Depois:

`Mockup Blueprint + produto real + persona opcional -> prompt compiler`

---

# 14. Receitas de Mockup

Depois de analisar uma referência, permitir:

`Salvar como receita`

Exemplos:

- Card categoria — feminino clean;
- Editorial bege;
- Produto em cabide claro;
- Flatlay infantil;
- Modelo lateral com espaço para texto.

Entidade sugerida:

```ts
type MockupRecipe = {
  id: string
  brandId?: string
  name: string
  sourceReferenceUrl?: string
  blueprint: object
  promptInstructions: string
  active: boolean
  version: number
}
```

Isso transforma uma descoberta pontual de prompt em um ativo reutilizável da loja.

---

# 15. Nova UI do Gerador

A tela atual está funcional, porém muito longa e com baixa hierarquia.

Não transformar tudo em um wizard rígido de várias páginas.

Usar um **builder progressivo**.

## Desktop

### Coluna esquerda — configuração

Etapas colapsáveis:

1. Objetivo
2. Produto
3. Pessoas e cena
4. Ângulo
5. Marca e contexto
6. Saída

Cada etapa deve mostrar um resumo quando fechada.

Exemplo:

`Produto · Brincar com Meu Pai — Pipa Menina`

`Pessoas · Menina 6–8 anos + mãe`

`Ângulo · Conexão / vínculo`

### Coluna direita — Preview sticky

Mostrar:

- resumo visual;
- imagens de referência;
- pessoas;
- ângulo;
- formato;
- quantidade;
- prompt/plan em aba avançada.

Ações:

- Pré-visualizar;
- Gerar;
- Copiar prompt;
- Ver plano JSON.

Não mostrar um prompt gigante como informação principal.

Prompt é modo avançado/debug.

---

# 16. Seleções recomendadas

O sistema deve reduzir trabalho.

Ao escolher produto:

- sugerir tipo de persona;
- sugerir ângulos;
- sugerir contexto;
- sugerir receitas de mockup;
- carregar Brand/Niche da marca;
- usar contexto automático.

Adicionar:

`Usar configuração recomendada`

Mas todas as escolhas continuam editáveis.

---

# 17. Hierarquia da tela

Melhorar visualmente:

- menos linhas longas de checkbox;
- mais cards/chips;
- seleção com thumbnail quando existir;
- grupos visuais;
- títulos mais claros;
- explicações curtas;
- estados de seleção mais evidentes;
- uso consistente de drawers/modals para edição avançada;
- preview realmente visual;
- sticky action bar no desktop quando necessário.

A tela deve parecer um **creative builder**, não um formulário administrativo.

---

# 18. Fluxo recomendado — Criativo

1. Escolher `Criativo`.
2. Escolher objetivo.
3. Escolher produto.
4. Definir pessoa principal.
5. Adicionar pessoas, se necessário.
6. Definir interação.
7. Escolher ângulo.
8. Contexto e marca entram automaticamente.
9. Ajustar opções avançadas, se necessário.
10. Pré-visualizar CreativePlan.
11. Gerar.
12. Executar QA.
13. Se falha objetiva e retry habilitado, regenerar uma vez.
14. Salvar job, plan, prompt, QA e resultado.

---

# 19. Fluxo recomendado — Mockup

1. Escolher `Mockup`.
2. Escolher produto.
3. Escolher:
   - preset;
   - receita salva;
   - referência nova.
4. Se referência:
   - analisar;
   - gerar blueprint;
   - permitir pequenos ajustes.
5. Escolher persona quando aplicável.
6. Escolher formato.
7. Gerar.
8. QA:
   - anatomia;
   - fidelidade do produto;
   - fidelidade da estampa;
   - composição.
9. Salvar receita opcionalmente.

---

# 20. Observabilidade

Cada geração deve guardar:

- model;
- provider;
- prompt version;
- CreativePlan;
- prompt final;
- referências usadas;
- ordem das referências;
- parâmetros;
- duração;
- custo;
- QA;
- retry;
- erro;
- output.

Isso será essencial para entender por que uma versão “local” ou anterior funcionava melhor.

---

# 21. Fases de implementação

## Fase A — auditoria e regressão

Antes de mexer em UI:

- comparar local x atual;
- corrigir diferenças;
- adicionar tracing mínimo.

## Fase B — CreativePlan + Prompt Compiler

Sem redesign grande.

Garantir que a geração seja estruturada.

## Fase C — Pessoas e relações

Adicionar:

- primary subject;
- supporting subjects;
- relations;
- product assignment;
- interactions.

## Fase D — Ângulos V2

- reduzir catálogo global;
- migrar equivalências;
- criar CRUD de ângulos por marca.

## Fase E — UI do Gerador V2

- builder progressivo;
- preview sticky;
- resumo por etapa;
- advanced/debug separado.

## Fase F — Commerce Product Source

- abstração;
- sync;
- UI;
- enriquecimento opcional.

## Fase G — Mockup Generator

- presets;
- blueprint;
- receitas;
- análise de referência.

## Fase H — QA automático

- anatomia;
- fidelidade;
- composição;
- retry limitado.

---

# 22. Critérios de aceite

## Pessoas

É possível gerar explicitamente:

- criança sozinha;
- criança + mãe;
- criança + pai;
- irmãos;
- casal;
- família;
- pessoa usando o produto enquanto a outra não usa;
- duas pessoas usando produtos diferentes.

## Ângulos

- catálogo global menor;
- sem dependência conceitual da Use Sul/regionais;
- marca pode criar ângulo próprio;
- ângulo pode ser gerado/ajudado por GPT.

## Produtos

- manual continua funcionando;
- connector é opcional;
- produto sincronizado mantém vínculo externo;
- imagens são utilizáveis como referências.

## Inteligência

- Brand Kit preenchível com GPT;
- Niche Kit preenchível com GPT;
- Contexto preenchível com GPT;
- Structured Output;
- usuário aprova antes de persistir.

## Mockups

- usuário pode selecionar um produto;
- subir mockup de referência;
- extrair blueprint;
- gerar novo mockup usando o produto real;
- salvar o blueprint como receita.

## Qualidade

- geração registra parâmetros;
- QA detecta problemas objetivos de anatomia;
- retry é limitado;
- produto/estampa possuem checagem de fidelidade.

---

# 23. Restrições

Não:

- reescrever o sistema inteiro de uma vez;
- misturar redesign com refactor profundo sem etapas;
- remover fluxos atuais antes da equivalência funcional;
- assumir que prompt negativo resolve regressão de anatomia;
- manter regras regionais dentro dos ângulos globais;
- obrigar commerce connector;
- tornar GPT obrigatório para preencher cadastros;
- esconder dados de debug necessários para comparar gerações.

---

# 24. Primeira rodada solicitada ao agente

Nesta primeira rodada:

1. leia o código atual do Gerador;
2. mapeie arquitetura, models, endpoints, prompt compiler atual e pipeline;
3. compare execução local anterior/compatível com a execução atual;
4. identifique a causa provável da regressão de anatomia;
5. mapeie impacto de:
   - CreativePlan;
   - multi-person composition;
   - custom angles;
   - commerce product source;
   - mockup recipes;
   - automatic QA;
6. proponha migração incremental;
7. identifique arquivos que serão alterados;
8. identifique migrations necessárias;
9. identifique contratos/API que precisam mudar;
10. prepare wireframe textual do Gerador V2.

**Nesta primeira rodada não fazer refatoração ampla nem mudança visual definitiva.**

Entregar um relatório técnico e um plano de implementação em fases, com riscos, dependências e ordem recomendada.

