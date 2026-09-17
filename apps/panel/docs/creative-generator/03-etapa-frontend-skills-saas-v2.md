# ETAPA 3 — Lapidação do Frontend SaaS com Skills

## Pré-condição

Executar somente quando:

- Etapa 1 estiver validada;
- Etapa 2 estiver funcional;
- os contratos estiverem estáveis;
- os 3 motores SaaS estiverem funcionando;
- multipeça estiver integrada aos 3 fluxos.

Não reescrever regra de negócio nesta etapa.

---

# 1. Objetivo

Melhorar:

- hierarquia;
- densidade;
- navegação;
- consistência;
- microinterações;
- estados;
- responsividade;
- percepção de qualidade;
- clareza entre os 3 motores;
- clareza entre 1 produto e multipeça.

---

# 2. Skills a aplicar

Ordem:

```text
1. front-end-design
2. taste-skill
3. impeccable
4. brandkit
5. animate
```

`animate` somente depois do layout resolvido.

---

# 3. Skills não prioritárias

Não priorizar:

```text
remotion-best-practices
canvas-design
```

salvo necessidade específica.

---

# 4. Prompt para Claude

```text
Antes de alterar o frontend do Gerador de Criativos SaaS, aplique as skills instaladas nesta ordem:

1. front-end-design
2. taste-skill
3. impeccable
4. brandkit

Use animate apenas depois de a estrutura visual estar resolvida.

Faça primeiro uma auditoria do módulo atual.

Não altere backend, contratos ou regras de negócio nesta etapa.

Analise:

- hierarquia da página;
- densidade visual;
- seleção entre os 3 motores;
- fluxo de 1 produto vs multipeça;
- progressive disclosure;
- preview;
- Brand/Niche Kit;
- jobs;
- loading;
- erro parcial;
- histórico;
- OpenAI não configurada;
- feature bloqueada;
- desktop;
- mobile;
- acessibilidade;
- consistência com o design system.

Crie antes:

docs/creative-generator-frontend-refinement.md

O documento deve conter:

- problemas encontrados;
- componentes afetados;
- recomendações;
- prioridade;
- risco;
- plano de implementação.

Depois implemente em pequenas etapas.
```

---

# 5. Objetivo visual

O módulo deve parecer:

- SaaS premium;
- clean;
- profissional;
- autoral;
- previsível;
- produtivo.

Evitar:

- formulário administrativo;
- cards demais;
- UI genérica;
- excesso de badges;
- excesso de informação;
- wizard pesado.

---

# 6. Fluxo principal

Estrutura sugerida:

```text
1. Motor
2. Produtos
3. Direção
4. Comunicação
5. Formato
6. Preview
```

---

# 7. Seleção do motor

Exibir apenas:

```text
[ Ângulos Limpos ]
[ Remarketing ]
[ Funil por Criativo ]
```

Descrição curta:

```text
Ângulos Limpos
Imagem pura, sem texto promocional.

Remarketing
Recupere visitantes, produtos e carrinhos.

Funil por Criativo
Headlines, CTAs e elementos visuais por estágio.
```

---

# 8. Seleção de quantidade de produtos

Após o motor:

```text
Produtos

[ Um produto ] [ Multipeça ]
```

Se Multipeça:

```text
Selecione de 2 a 6 produtos
```

Não tratar como estratégia separada.

---

# 9. Fluxo — Ângulos Limpos

Mais simples.

Mostrar:

```text
Produto(s)
Contexto
Ângulo
Persona
Formato
Quantidade
Copy opcional
```

Não mostrar:

- headline na imagem;
- CTA;
- badges;
- benefícios.

---

# 10. Fluxo — Remarketing

Começar por:

```text
O que você quer recuperar?

[ Visitante ]
[ Produto visto ]
[ Coleção ]
[ Carrinho ]
[ Checkout ]
[ Objeção ]
```

Se Multipeça estiver ativo, esconder intenções incompatíveis ou mostrar explicação.

Exemplo:

```text
Produto visto
Requer 1 produto.
```

---

# 11. Fluxo — Funil por Criativo

Começar por:

```text
[ TOFU ]
[ MOFU ]
[ BOFU ]
```

Depois:

- headline;
- subheadline;
- CTA;
- badges;
- benefícios;
- densidade;
- search bar;
- chips.

---

# 12. Progressive Disclosure

Não mostrar tudo de uma vez.

Defaults:

```text
Brand Kit atual
Niche Kit padrão
Contexto automático
Persona automática
Produto único
```

Avançado:

- provider;
- modelo;
- prompt debug;
- versões;
- parâmetros técnicos.

---

# 13. Layout desktop

Sugestão:

```text
Formulário 60%
Preview 40%
```

Preview sticky quando possível.

---

# 14. Preview

Mostrar:

- motor;
- productMode;
- produtos;
- ângulo;
- contexto;
- formato;
- overlay quando aplicável;
- total de criativos.

Exemplo:

```text
Funil por Criativo
Multipeça · 4 produtos
MOFU · Flatlay
Feed 4:5
```

---

# 15. Multipeça — UX

Se ativo:

mostrar lista visual dos produtos.

Cada item:

- thumbnail;
- nome;
- tipo;
- cor;
- ação remover;
- ação reordenar.

Indicar:

```text
Produto principal
```

quando relevante.

---

# 16. Brand/Niche Kit

Mostrar summary compacto:

```text
Use Origens
Moda regional
Geographic Context
```

Ação:

```text
Editar kit
```

---

# 17. Ângulos

Grid compacto com:

- nome;
- descrição curta;
- mini preview;
- selecionado/não selecionado.

Não usar cards gigantes.

---

# 18. Estados vazios

## Sem OpenAI

```text
Conecte sua conta OpenAI para gerar criativos.

[ Configurar integração ]
```

## Sem Brand Kit

```text
Configure sua marca antes de gerar.

[ Criar Brand Kit ]
```

## Sem produto

```text
Adicione um produto para começar.
```

## Feature bloqueada

```text
Este recurso não está disponível no seu plano.

[ Ver planos ]
```

---

# 19. Estado de geração

Mostrar:

```text
Gerando 8 de 20
```

Com:

- progress bar;
- concluídos;
- falhas;
- item atual.

Permitir sair da página sem cancelar job.

---

# 20. Falha parcial

Exemplo:

```text
17 concluídos
3 falharam
```

Ações:

```text
[ Tentar novamente os 3 ]
[ Ver detalhes ]
```

Retry individual.

---

# 21. Histórico

Filtros:

- data;
- motor;
- productMode;
- produto;
- ângulo;
- funil;
- remarketing intent;
- formato.

Cada item:

- thumbnail;
- creative_id;
- status;
- motor;
- single/multi;
- contexto;
- download;
- gerar variação;
- retry.

---

# 22. Headline e CTA

Aplicável apenas a:

```text
Remarketing
Funil por Criativo
```

Permitir:

- gerar;
- regenerar;
- editar;
- bloquear;
- remover.

---

# 23. Modo Clean

Aplicável apenas a:

```text
Remarketing
Funil por Criativo
```

Não confundir com Ângulos Limpos.

Descrição:

```text
Reduz a comunicação para headline + CTA.
```

---

# 24. CTA

Editor:

```text
Texto do botão
[ Ver todas as cidades ]

Intensidade
[ Discreto ] [ Médio ] [ Forte ]
```

Preview imediato.

---

# 25. Motion

Depois do layout aprovado, usar `animate` para:

- troca de motor;
- troca single/multi;
- upload;
- accordion;
- progresso;
- preview;
- conclusão.

Sem animação decorativa.

---

# 26. Responsividade

Desktop é prioridade produtiva.

Mobile deve continuar utilizável.

No mobile:

- preview abaixo;
- seções colapsáveis;
- CTA principal sticky opcional;
- lista multipeça horizontal/compacta.

---

# 27. Acessibilidade

Garantir:

- contraste;
- foco;
- labels;
- navegação por teclado;
- estados de erro;
- aria quando necessário;
- informação não dependente apenas de cor.

---

# 28. Critérios de aceite

- [ ] Usuário entende os 3 motores rapidamente.
- [ ] Multipeça aparece como opção dentro do motor.
- [ ] Ângulos Multipeça não aparece como estratégia SaaS.
- [ ] Ângulos Limpos continua visualmente simples.
- [ ] Remarketing começa pela intenção.
- [ ] Funil começa por TOFU/MOFU/BOFU.
- [ ] Preview tem protagonismo.
- [ ] Progressive disclosure funciona.
- [ ] Brand/Niche Kit é claro.
- [ ] Jobs transmitem confiança.
- [ ] Falha parcial é recuperável.
- [ ] Histórico é filtrável.
- [ ] Desktop tem boa densidade.
- [ ] Mobile funciona.
- [ ] Skills foram usadas para refinamento.
- [ ] Backend não foi alterado nesta etapa.

---

# 29. Resultado esperado

```text
SaaS
└── Gerador de Criativos
    ├── Ângulos Limpos
    │   ├── 1 produto
    │   └── Multipeça
    │
    ├── Remarketing
    │   ├── 1 produto
    │   └── Multipeça quando aplicável
    │
    └── Funil por Criativo
        ├── 1 produto
        └── Multipeça
```

A experiência deve parecer um único produto coeso, não três ferramentas desconectadas.
