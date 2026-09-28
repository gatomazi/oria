# Parcerias e Afiliados · guia de operação do lojista

Menu: **Comunicação › Parcerias e Afiliados** (só aparece com o módulo liberado). Abas: Visão geral · Parceiros · A pagar (owner) ·
Collabs · Vendas atribuídas · Revisões · Níveis e benefícios.

## Conceitos que evitam erro de leitura

- **Comissão ≠ desconto ≠ margem.** Desconto é o que o cliente ganha no cupom. Comissão é o que **você deve ao parceiro**. Margem aqui
  é *receita líquida do item − custo de produção da INK* (sem taxas e impostos) — a tela sempre diz qual base o contrato usa.
- **Receita atribuída não é receita incremental.** Um cupom não prova que a venda não aconteceria sem ele.
- **Previsto não é dívida.** Só o que já foi **liberado** vence. Liberado = pagamento confirmado + entrega + carência do contrato.
- Cinco datas diferentes: **pedido**, **competência** (mês da venda), **liberação**, **vencimento/previsão** e **pagamento efetivo**
  (quando você transferiu, não quando registrou). Cada filtro responde uma pergunta; o período ativo e o fuso aparecem sob os filtros.

## Cadastrar um parceiro e o contrato

1. **Parceiros › Novo parceiro** (nome, contato mínimo, rede). Entra como *candidato*; o owner **aprova** no perfil. Aprovar não dá
   comissão nem peça grátis.
2. Perfil › **Contratos e cupons › Novo contrato**: modalidade (cupom, collab ou híbrida), **base** (% da receita líquida, % da margem
   de produção ou valor por unidade), política de pagamento e conflito. Use **Simular** para comparar as bases sobre as vendas recentes.
   - Remuneração acima do teto do nível (margem: Raiz 15%, Voz 20%, Referência 25%, Embaixador 30%, configuráveis) exige o **motivo do
     override**. Para bases que não são margem, a comparação é por equivalência projetada; sem histórico de vendas, o override é exigido.
   - Cada mudança é uma **nova versão** (o histórico é imutável). Vendas passadas seguem a versão da data em que ocorreram.
   - Só o owner ativa/pausa/encerra contrato. Contrato em rascunho **não remunera**.

## Cupom (promoção `standard` da INK)

O Oria tem o **próprio programa de afiliados**: **não crie afiliado na INK**. A INK só aplica o desconto do cupom; comissão e tracking são do Oria.

1. No perfil: **Cadastrar cupom** (código, desconto, validade). Código repetido com vigência sobreposta é recusado. Fica *Aguardando
   criação/verificação na INK* — **não é "Ativo"**.
2. Crie no painel da INK uma **promoção comum (standard)** com o **mesmo código**, o desconto do cliente e **sem valor/quantidade mínima**, sem
   aplicação automática, sem exibir na vitrine/carrinho, sem limite de usos e sem restringir produtos.
3. **Verificar na INK** (1 consulta de leitura) confirma código/tipo/desconto/vigência ou lista a divergência. **Prévia INK** mostra o pedido que o
   Oria enviaria (escrita **desligada**: nada é enviado).
4. **Ativar** (owner): o Oria confere a promoção na INK antes. Existente e compatível → vincula o ID e ativa (vale só para pedidos **a partir de
   agora**). Divergente → **não ativa** e mostra o que difere. Inexistente com escrita desligada → **não ativa** e continua aguardando. Erro de
   rede/permissão da INK → **não ativa** e mostra o erro.
5. Pausar/encerrar fecha a vigência no Oria na hora (**a promoção na INK continua existindo** — ajuste/exclua lá se quiser); **Retomar** abre
   vigência nova (o período pausado continua sem comissão).

Códigos comuns sem parceiro não geram comissão. Parceiro que também tem afiliado **nativo da INK**: marque no cadastro — as vendas dele
ficam bloqueadas até você conciliar (a API não permite detectar isso).

## Collab por estampa

1. **Collabs › Nova collab**. No detalhe: **Adicionar criador** (contrato de collab/híbrido + participação; a soma dos criadores ≤ 100%) e
   **Adicionar produtos** (busca no catálogo ou ids da INK — vale produto isolado, sem agrupamento).
2. A comissão vem do **item vendido** cujo `id` de produto está no vínculo na data da venda — com ou sem cupom.
3. **Buscar no agrupamento** propõe produtos novos do mesmo agrupamento: ficam *aguardando aprovação* (padrão seguro), com a prévia do impacto,
   e **nunca** comissionam retroativamente. Remover um produto fecha a vigência; vendas anteriores continuam atribuídas.
4. Mesmo item com cupom de **outro** parceiro: paga o criador da collab; o cupom fica só como evidência. Cupom do **próprio** criador não
   gera comissão dupla. Comissão dupla só com política `split_explicit` e confirmação administrativa.

## Do pedido à comissão

O painel lê os pedidos **já sincronizados** (sem chamar a INK). **Reconciliar pedidos agora** (owner) faz o cálculo sob demanda; o job de
30 minutos faz o mesmo. **Vendas atribuídas** mostra cada linha: origem, base líquida, regra e comissão. Pedido de troca não é venda;
cancelado/reembolsado/chargeback não comissiona; aguardando pagamento fica *provisionado*.

**Revisões** lista o que o sistema não decide sozinho (pedido antigo sem cupom capturado, item sem produto, custo desconhecido, colisão).
O owner **associa** o item a uma collab/cupom ou **descarta**, sempre com motivo (auditado).

## Fechar e pagar

1. **A pagar › Por parceiro e competência**: KPIs (vencido, 7/30 dias, previsto, disponível, pago no período, ajustes). Filtre por tipo de
   data, parceiro, modalidade, collab, categoria, forma de pagamento, parcial/quitado e vencidos. **Exportar CSV** respeita os mesmos filtros.
2. **Fechar lote** congela o que será pago (respeita o mínimo do contrato; abaixo dele acumula). **Aprovar** o lote antes de pagar.
3. **Registrar pagamento**: escolha os lançamentos, o **valor de cada um** (pagamento parcial mantém o saldo restante), a **data efetiva**,
   a forma e a referência. O Oria **não faz Pix**: o registro só vale depois de salvar; há confirmação e recibo gerencial.
4. **Estornar pagamento** cria um contralançamento — o registro original fica visível. Não existe "apagar".
5. **Alterar vencimento**: sempre com motivo; a recalculação por política não o desfaz; fica log antes/depois.
6. **Reembolso/chargeback depois de pago**: vira **ajuste a compensar** (débito) que abate o próximo pagamento; o Pix registrado não muda.
7. **Cachê por conteúdo** entra por *Lançamento manual*, em categoria separada de comissão por venda.

## Níveis e benefícios

- O sistema calcula elegibilidade (metas simultâneas, só vendas elegíveis) e **propõe**; você aprova em **Níveis e benefícios**. Meta de
  margem sem custo verificado aparece como *não verificada* e não promove. O nível nunca reescreve um contrato em vigor.
- **Carteira de benefícios**: crédito de até 25% da contribuição pós-parceria positiva e verificada de vendas **entregues**. **Conceder
  peça** debita produção + frete reais; exige nível, vendas, período, atividade e saldo. *Criador convidado* é exceção documentada
  (entregáveis + aprovação), não sobe nível e não vira dinheiro a pagar.

## Rodar o cenário de demonstração localmente

```bash
# banco LOCAL migrado (npm run migrate:up); o script recusa host que não seja localhost
DATABASE_URL=postgres://… DEMO_SENHA='senha-local-12+' node apps/panel/scripts/afiliados/seed-demo.cjs
AFILIADOS_MODULE_ENABLED=true npm --prefix apps/panel start   # /admin/parcerias
```

Cria parceiros (collab, cupom, híbrido), contratos, uma collab, cupons, ~20 pedidos **sintéticos** e um pagamento parcial. Logins:
`demo-owner@local.oria` e `demo-member@local.oria` (a senha é a que você definiu).
