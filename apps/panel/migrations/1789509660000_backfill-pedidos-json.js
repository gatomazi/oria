'use strict';

// Era `backfillPedidosSeNecessario()` no boot (`server.js:1138` em 8a7ea3d).
//
// `db/pedidos.json` tem hotpages com código Pix real de cliente, criadas antes do painel migrar
// para o Postgres. Uma leitura direta do Postgres vazio "esqueceria" essas hotpages. Copia uma vez
// só, e apenas se a chave `pedidos` ainda não existir em `app_config`.
//
// Guarda de segurança que o boot não tinha: se o arquivo não estiver montado (container novo, CI,
// volume não anexado), a migration NÃO falha e NÃO escreve — não há nada a copiar, e inventar uma
// chave vazia aqui destruiria a de produção na próxima leitura. A ausência do arquivo é registrada.

const fs = require('fs');
const path = require('path');

exports.shorthands = undefined;

function arquivoDePedidos() {
  const storageDir = process.env.STORAGE_DIR || path.join(__dirname, '..');
  return path.join(storageDir, 'db', 'pedidos.json');
}

exports.up = async (pgm) => {
  const { rows } = await pgm.db.query('SELECT 1 FROM app_config WHERE chave = $1', ['pedidos']);
  if (rows.length) {
    console.log('[migrate] app_config.pedidos já existe — backfill dispensado');
    return;
  }

  const arquivo = arquivoDePedidos();
  let doArquivo = {};
  try {
    doArquivo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  } catch {
    console.log(`[migrate] ${arquivo} ausente ou ilegível — nada a copiar`);
    return;
  }

  const total = Object.keys(doArquivo || {}).length;
  if (!total) {
    console.log('[migrate] pedidos.json vazio — nada a copiar');
    return;
  }

  await pgm.db.query(
    `INSERT INTO app_config (chave, valor, atualizado_em) VALUES ($1, $2, now())
     ON CONFLICT (chave) DO NOTHING`,
    ['pedidos', JSON.stringify(doArquivo)]
  );
  console.log(`[migrate] backfill de pedidos.json feito (${total} pedido(s))`);
};

// Reversível, mas destrutivo em produção: apagaria as hotpages Pix que só existem no banco depois
// que o arquivo sumiu num deploy. Só desfaz o que ESTA migration escreveu não é verificável sem
// um marcador que a versão original também não tinha.
exports.down = () => {
  throw new Error(
    'backfill-pedidos-json é irreversível: apagar app_config.pedidos removeria hotpages Pix reais.'
  );
};
