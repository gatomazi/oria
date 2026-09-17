'use strict';

// Fila do WhatsApp Web × compra do cliente.
//
// O bug que este arquivo existe pra impedir: as checagens de "já comprou" aconteciam todas no
// momento de ENFILEIRAR, mas a mensagem só sai quando alguém reserva o item da fila — e entre as
// duas coisas passam horas (janela de envio 8h-22h, teto diário, limite recomendado, e no modo
// manual a espera por aprovação). Uma compra nesse intervalo não cancelava nada, e o cliente
// recebia "esqueceu algo no carrinho?" depois de comprar.
//
// Roda contra Postgres real porque o que precisa ser provado é o casamento telefone↔pedido com os
// formatos que cada tabela guarda de verdade (outbox com DDI 55, pedidos_ink sem).

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { variantesTelefone } = require('../lib/recuperacao/compra');

const URL_TESTE = process.env.META_TEST_DATABASE_URL;

if (!URL_TESTE) {
  test('fila × compra (pulado: defina META_TEST_DATABASE_URL)', { skip: true }, () => {});
} else {
  const pool = new Pool({ connectionString: URL_TESTE });
  const PAGOS = ['paid', 'succeeded', 'free'];

  test.after(async () => { await pool.end(); });

  // Mesma consulta que o claim faz antes de liberar um item de recuperação.
  async function jaComprou(loja, telefone, desde) {
    const { rows } = await pool.query(
      `SELECT 1 FROM pedidos_ink
        WHERE loja = $1 AND payment_status = ANY($2) AND criado_em >= $3 AND is_troca IS NOT TRUE
          AND buyer_telefone = ANY($4)
        LIMIT 1`,
      [loja, PAGOS, desde, variantesTelefone(telefone)]
    );
    return rows.length > 0;
  }

  test.before(async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS pedidos_ink (
      id BIGSERIAL PRIMARY KEY, loja TEXT, ink_order_id BIGINT, payment_status TEXT,
      total_value NUMERIC, criado_em TIMESTAMPTZ, buyer_telefone TEXT, is_troca BOOLEAN)`);
  });

  test('compra DEPOIS do item entrar na fila cancela o envio', async () => {
    await pool.query('DELETE FROM pedidos_ink');
    const entrouNaFila = new Date(Date.now() - 3 * 3600 * 1000).toISOString(); // 3h atrás
    // Cliente comprou 1h atrás — depois de a mensagem já estar esperando na fila.
    await pool.query(
      `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, buyer_telefone, is_troca)
       VALUES ('sul', 1, 'paid', 100, now() - interval '1 hour', '54999887766', false)`
    );
    // A fila guarda o telefone no formato do WhatsApp, com DDI. As duas tabelas divergem de
    // propósito, e é justamente aí que um casamento ingênuo falharia.
    assert.equal(await jaComprou('sul', '5554999887766', entrouNaFila), true);
  });

  test('compra ANTES do item entrar na fila não cancela — aquela já foi checada no enfileiramento', async () => {
    await pool.query('DELETE FROM pedidos_ink');
    await pool.query(
      `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, buyer_telefone, is_troca)
       VALUES ('sul', 2, 'paid', 100, now() - interval '5 hours', '54999887766', false)`
    );
    const entrouNaFila = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    assert.equal(await jaComprou('sul', '5554999887766', entrouNaFila), false);
  });

  test('pedido não pago não cancela o envio', async () => {
    await pool.query('DELETE FROM pedidos_ink');
    await pool.query(
      `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, buyer_telefone, is_troca)
       VALUES ('sul', 3, 'pending', 100, now(), '54999887766', false)`
    );
    // Pix gerado e não pago é exatamente o caso que a recuperação existe pra resgatar.
    assert.equal(await jaComprou('sul', '5554999887766', new Date(Date.now() - 3600 * 1000).toISOString()), false);
  });

  test('troca não conta como compra', async () => {
    await pool.query('DELETE FROM pedidos_ink');
    await pool.query(
      `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, buyer_telefone, is_troca)
       VALUES ('sul', 4, 'paid', 100, now(), '54999887766', true)`
    );
    assert.equal(await jaComprou('sul', '5554999887766', new Date(Date.now() - 3600 * 1000).toISOString()), false);
  });

  test('compra de OUTRA loja não cancela', async () => {
    await pool.query('DELETE FROM pedidos_ink');
    await pool.query(
      `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, buyer_telefone, is_troca)
       VALUES ('centro', 5, 'paid', 100, now(), '54999887766', false)`
    );
    assert.equal(await jaComprou('sul', '5554999887766', new Date(Date.now() - 3600 * 1000).toISOString()), false);
  });

  test('telefone de outro cliente não cancela', async () => {
    await pool.query('DELETE FROM pedidos_ink');
    await pool.query(
      `INSERT INTO pedidos_ink (loja, ink_order_id, payment_status, total_value, criado_em, buyer_telefone, is_troca)
       VALUES ('sul', 6, 'paid', 100, now(), '54988776655', false)`
    );
    assert.equal(await jaComprou('sul', '5554999887766', new Date(Date.now() - 3600 * 1000).toISOString()), false);
  });

  test('o status de cancelamento sai da dedupe da fila', async () => {
    // A unique de dedupe cobre os status "vivos". Um item cancelado por compra precisa sair dela,
    // senão um carrinho novo do mesmo cliente não conseguiria entrar na fila depois.
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uq_wa_web_outbox_dedupe'`
    );
    if (!rows.length) return; // schema do outbox não criado neste banco de teste
    assert.ok(!/cancelado_compra/.test(rows[0].indexdef),
      'cancelado_compra não pode estar na dedupe, senão bloqueia envio futuro legítimo');
  });
}
