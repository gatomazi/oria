-- Reversível sem perda: a 0020 só acrescentou uma função de LEITURA (nenhuma tabela, nenhuma
-- coluna, nenhum dado). Derrubá-la devolve o schema ao estado da 0019 — o convite continua lá,
-- com `platform_consumir_convite` intacta; o que deixa de existir é a rota de aceite do painel.
--
-- O `GRANT EXECUTE` da role da aplicação não é desfeito aqui porque não foi concedido aqui: ele
-- vem do SQL do OPS-14 (lib/platform/app-role.js). `DROP FUNCTION` já leva junto o privilégio.

DROP FUNCTION IF EXISTS platform_convite_pendente(TEXT);
