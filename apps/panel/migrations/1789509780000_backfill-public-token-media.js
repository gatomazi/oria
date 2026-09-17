'use strict';

// Era `backfillPublicTokenMedia()` no boot (`server.js:1168` em 8a7ea3d).
//
// `media_assets` criados antes de `public_token` existir nunca precisaram de URL pública. Preenche
// para ficarem prontos caso virem mídia de campanha.
//
// Mudança em relação ao boot: o original fazia um UPDATE por linha, sem lote. Aqui vai em lotes de
// 500, porque migration que trava a tabela inteira é exatamente o que o pre-deploy não pode fazer.
// O token continua vindo de `crypto.randomBytes` (CSPRNG) — nunca `Math.random`.

const crypto = require('crypto');

exports.shorthands = undefined;

const LOTE = 500;

exports.up = async (pgm) => {
  let total = 0;
  for (;;) {
    const { rows } = await pgm.db.query(
      `SELECT id FROM media_assets WHERE public_token IS NULL ORDER BY id LIMIT ${LOTE}`
    );
    if (!rows.length) break;
    for (const row of rows) {
      await pgm.db.query('UPDATE media_assets SET public_token = $1 WHERE id = $2', [
        crypto.randomBytes(24).toString('hex'),
        row.id,
      ]);
    }
    total += rows.length;
    if (rows.length < LOTE) break;
  }
  if (total) console.log(`[migrate] public_token: ${total} mídia(s) atualizada(s)`);
};

// Não desfaz: apagar o token invalidaria URLs públicas já distribuídas.
exports.down = () => {
  throw new Error('backfill-public-token-media é irreversível: os tokens já podem ter circulado.');
};
