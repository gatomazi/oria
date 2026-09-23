# Creative Generator V2 — Correção final da Fase C + validação visual controlada

A Fase C está bem encaminhada e a arquitetura de Subjects / Relations / Interactions / Feedback / Copiar Dados está aprovada em princípio.

Mas **não considero a Fase C fechada ainda** por dois motivos:

1. a suíte completa do painel ainda precisa fechar verde no HEAD final;
2. encontrei uma contradição importante nos prompts de peça infantil que precisa ser corrigida antes de qualquer teste visual real.

Não iniciar a próxima fase.

## 1. Gate da suíte

Primeiro:

- conclua a suíte completa do painel no HEAD final;
- se houver falha, investigue e corrija;
- não atribua falha de negative control a carga da máquina sem evidência suficiente;
- só considere a Fase C tecnicamente fechada com a suíte completa verde.

Quero o resultado final registrado no relatório.

## 2. Correção crítica — peça infantil ≠ cena composta somente por crianças

Nos exemplos da Fase C existe uma contradição.

O bloco de fidelidade ainda contém algo equivalente a:

> O MODELO da cena é SEMPRE uma criança, NUNCA um adulto.

Isso não é mais válido agora que Subjects permite:

- criança + pai;
- criança + mãe;
- família;
- adulto de apoio.

A regra correta é:

`a pessoa que veste a peça infantil deve ser criança`.

### 2.1 Regra desejada

Para uma peça infantil:

- qualquer Subject que veste aquela peça deve ser menor compatível com o tipo da peça;
- adultos podem aparecer normalmente como Subjects de apoio;
- adultos não podem vestir aquela peça infantil;
- uma criança não deve ser forçada a ser o único modelo/personagem da cena;
- a regra deve funcionar com múltiplos produtos e múltiplos Subjects.

Quero substituir a regra antiga por algo semanticamente equivalente a:

> Preserve o TIPO DE PEÇA original: camiseta infantil, manga curta, gola redonda, tamanho infantil. Qualquer pessoa que VESTE esta peça deve ser uma criança compatível com a faixa do produto. Adultos podem aparecer na cena como pessoas de apoio, mas NUNCA vestem esta peça infantil.

## 3. Isso deve ser estrutural, não apenas troca de frase

Não quero apenas editar uma string hardcoded.

Agora que temos Subjects, quero a validação também no plano:

`subject.wears_product_id = produto infantil => subject.age_band deve ser infantil compatível`

Se um adulto for explicitamente configurado para vestir produto infantil:

- erro de validação;
- não gerar prompt contraditório.

Se um adulto estiver na cena sem vestir:

- válido.

Para produtos adultos:

- não aplicar a restrição infantil.

Para multi-product:

- validar cada atribuição individualmente.

## 4. Remover dependência da regra antiga

Revisar fidelity rules/compiler para garantir que não exista mais a ideia global:

`O MODELO da cena é SEMPRE uma criança`

quando há Subjects V2.

Se isso precisar continuar no V1 por golden/backward compatibility:

- manter somente no fluxo V1 congelado;
- no compiler V2 usar a regra nova por wearer/subject.

**Não quebrar os 546 golden cases do V1.**

## 5. Testes obrigatórios para essa correção

Adicionar casos válidos:

- criança + pai: criança veste produto infantil, pai não veste;
- criança + mãe: criança veste, mãe não veste;
- duas crianças: cada uma veste produto infantil;
- família com 4: duas crianças vestem produtos infantis, adultos não vestem.

Adicionar casos inválidos:

- adulto veste infantil;
- troca de produto em que adulto recebe produto infantil.

## 6. Outro ponto a revisar — scene picks × interaction

Nos exemplos, o plano ainda pode carregar um `scene_picks.acao` como “chegando a um ambiente...” ao mesmo tempo em que a interaction estruturada é `playing` ou `reading_together`.

Quero confirmar que não estamos mantendo `scene_picks` contraditórios/sem efeito apenas por herança do fluxo antigo.

Regra desejada:

- quando `scene_mode = frame` e existe `interaction` estruturada, `scene_picks` antigos que descrevem outra ação não devem disputar semanticamente com a interaction;
- se são irrelevantes para o prompt, preferir não persistir como decisão ativa;
- se ainda são usados para algum aspecto secundário, documentar exatamente qual.

Isso importa porque:

- `Gerar de novo` preserva `scene_picks`;
- `Copiar Dados` carrega `scene_picks`;
- feedback/histórico pode interpretar um pick como parte da cena.

## 7. Feedback e Copiar Dados — aprovados

A direção está aprovada:

- feedback por usuário e criativo;
- upsert;
- `store_id nullable`;
- snapshot vindo do plano;
- nenhuma influência automática no planner;
- `Gerar de novo`;
- `Gerar variação`;
- draft vindo do plano persistido;
- provenance preservada.

Também aprovo `mixed` + `provenance_sources`.

## 8. UI mínima — aprovada

Gostei do fluxo:

- Gostei;
- Não gostei;
- Copiar dados;
- Recomendado;
- Gerar assim;
- Gerar de novo;
- Personalizar cena.

Manter a filosofia de não expor internals.

## 9. “Recomendado: Criança + pai”

Por enquanto aceito o rótulo neutro `Criança + pai` quando gênero não está definido.

Não inferir gênero sem dado.

## 10. Validação visual real antes de rollout

Depois de:

1. corrigir a regra de wearer infantil;
2. revisar `scene_picks` × interaction;
3. deixar core e painel totalmente verdes;

quero uma **pequena validação visual**, porque Subjects de 2–4 pessoas ainda não foram testados com imagens reais.

### Casos

- B — menino + mãe lendo;
- C — duas irmãs;
- D — casal;
- E — família.

## 11. Quantidade do lote visual

Gerar inicialmente:

- 2 imagens por caso;
- B, C, D e E.

Total: **8 imagens**.

Parâmetros:

- quality `medium`;
- Feed 4:5;
- `gpt-image-2`;
- sem retries automáticos.

## 12. O que avaliar nas 8 imagens

Para cada imagem:

- anatomia: mãos, dedos, braços, membros, fusões;
- pessoas: quantidade correta, idade aparente, relação plausível;
- produto: produto correto em cada pessoa, nenhuma troca, infantil só em criança;
- interação: leitura, candid, olhar entre casal, group photo;
- gaze conforme o plano;
- vestuário infantil da Entre Nós;
- qualidade comercial: utilizável / ajuste pequeno / inutilizável.

## 13. Caso E é o principal stress test

Observar especialmente:

- quantidade de pessoas;
- mãos;
- troca/fusão;
- qual criança usa qual produto;
- adultos sem produto infantil;
- composição simples;
- roupa adequada das crianças.

Se vier ruim, primeiro reportar o problema. Não corrigir imediatamente com “mais prompt”.

## 14. Não usar QA automático ainda

- sem retry automático;
- sem QA como juiz;
- sem ML;
- avaliação humana primeiro.

## 15. Ordem de trabalho agora

1. concluir suíte atual;
2. corrigir regra de produto infantil por wearer;
3. revisar `scene_picks` × interaction;
4. rodar novamente core completo, painel completo e golden V1;
5. atualizar relatório;
6. executar as 8 imagens reais;
7. parar e entregar.

## 16. Entrega esperada

Entregar:

1. resultado final da suíte do painel no HEAD anterior;
2. commit da correção de wearer infantil;
3. explicação do problema e solução;
4. resultado da revisão `scene_picks` × interaction;
5. testes novos;
6. core completo;
7. painel completo;
8. golden V1;
9. confirmação de V1 congelado;
10. quantidade exata de chamadas OpenAI;
11. custo/usage;
12. modelo solicitado e servido;
13. as 8 imagens separadas por caso B/C/D/E;
14. resumo objetivo dos problemas encontrados por caso;
15. nenhuma correção automática baseada nas imagens ainda;
16. sem push;
17. sem merge;
18. sem deploy;
19. próxima fase parada.

Não iniciar UI V2 completa, Mockups, Commerce Connector ou Product Enrichment depois disso.
