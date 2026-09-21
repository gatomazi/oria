-- Reparo de dado: `loja` recebeu o `store_id` (UUID) em pedidos da Store nativa.
--
-- Depois da rodada de Recuperação, o reconciliador de Pix pendente e o vínculo manual de pedido passaram a chamar
-- o upsert de pedidos com a CHAVE de escopo da Store — que, na Store nativa, é o `store_id`. O upsert gravava
-- essa chave na coluna `loja`, e a tela de Clientes mostrava o UUID como nome de loja. O código agora só grava
-- a chave LEGADA em `loja` (`lojaLegadaParaColuna`); aqui se desfaz o que já foi gravado.
--
-- Só toca linha cuja `loja` é EXATAMENTE o `store_id` dela (texto): chave legada verdadeira nunca tem essa forma.
-- Idempotente; forward-only (não há o que "desfazer": o valor nulo é o correto).

UPDATE pedidos_ink SET loja = NULL WHERE store_id IS NOT NULL AND loja = store_id::text;
UPDATE pedidos_ink_itens SET loja = NULL WHERE store_id IS NOT NULL AND loja = store_id::text;
