'use strict';

// Storage persistente do gerador: UPLOADS_DIR (volume Railway) em
//   creatives/tenant/{tenant_id}/products/{product_id}/{uuid}.{ext}   referências de produto
//   creatives/tenant/{tenant_id}/creatives/{creative_id}/image.png    criativos gerados
// Nomes sempre gerados pelo servidor; tenant/ids validados por regex antes de virar caminho (sem path traversal);
// tipo de imagem validado por magic bytes, não pela extensão nem pelo mime declarado.
//
// OPS-22 · leitura dupla TEMPORÁRIA (rodada 19, trilha G). Enquanto `npm run tenancy:mover-criativos`
// não termina, arquivos antigos ainda estão em creatives/tenant/<tenant legado>/. Com `leituraLegada`
// ({ de, organizationId }, de lib/creative-core/leitura-legada.js), uma LEITURA que não acha o arquivo
// no diretório da Organization tenta o legado — só para a Organization declarada, só dentro do
// diretório legado, e avisa `aoUsarLegado` (log/contagem para saber quando desligar). Escrita
// sempre no diretório da Organization. Sem `leituraLegada`: comportamento anterior.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TENANT_RE = /^[a-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_RE = /^products\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(png|jpg|webp)$/;
const ASSET_RE = /^creatives\/[0-9a-f-]{36}\/image\.png$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function detectarImagem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function erro(mensagem, httpStatus = 400) {
  const e = new Error(mensagem);
  e.httpStatus = httpStatus;
  return e;
}

function dentroDe(base, relativo) {
  const absoluto = path.resolve(base, relativo);
  if (!absoluto.startsWith(base + path.sep)) throw erro('caminho inválido');
  return absoluto;
}

// Diretório do tenant legado: um filho DIRETO de creatives/tenant, com nome de tenant legado (nunca
// com forma de uuid — esse é o formato dos diretórios das Organizations).
function raizLegadaConfinada(raizTenants, de) {
  if (typeof de !== 'string' || !TENANT_RE.test(de) || UUID_RE.test(de)) throw erro('leitura legada: origem inválida', 500);
  const alvo = path.resolve(raizTenants, de);
  if (path.dirname(alvo) !== raizTenants) throw erro('leitura legada: origem fora do diretório de tenants', 500);
  return alvo;
}

function createStorage({ uploadsDir, tenantId, leituraLegada = null, aoUsarLegado = () => {} }) {
  if (!TENANT_RE.test(tenantId)) throw new Error('tenant inválido');
  const raizTenants = path.resolve(uploadsDir, 'creatives', 'tenant');
  const raiz = path.resolve(raizTenants, tenantId);
  // Só a Organization mapeada explicitamente ao tenant legado enxerga o diretório legado.
  const raizLegada = leituraLegada && leituraLegada.organizationId === tenantId
    ? raizLegadaConfinada(raizTenants, leituraLegada.de)
    : null;

  const dentroDaRaiz = (relativo) => dentroDe(raiz, relativo);

  function ler(relativo, tipo) {
    try {
      return fs.readFileSync(dentroDaRaiz(relativo));
    } catch (err) {
      if (!raizLegada || !err || err.code !== 'ENOENT') throw err;
      const legado = dentroDe(raizLegada, relativo);
      let buf;
      try {
        // Link simbólico no diretório legado não é seguido: só arquivo regular.
        if (!fs.lstatSync(legado).isFile()) throw err;
        buf = fs.readFileSync(legado);
      } catch (errLegado) {
        // O mover pode ter levado o arquivo entre as duas leituras: tenta o caminho novo mais uma vez.
        if (errLegado && errLegado.code === 'ENOENT') return fs.readFileSync(dentroDaRaiz(relativo));
        throw errLegado;
      }
      try { aoUsarLegado({ tipo, organizationId: tenantId }); } catch { /* observabilidade não derruba a leitura */ }
      return buf;
    }
  }

  return {
    decodeImage(dataBase64) {
      if (typeof dataBase64 !== 'string' || dataBase64.length === 0) throw erro('imagem ausente');
      const buf = Buffer.from(dataBase64, 'base64');
      if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw erro('imagem vazia ou maior que 10 MB');
      const tipo = detectarImagem(buf);
      if (!tipo) throw erro('formato de imagem não suportado (use PNG, JPEG ou WebP)');
      return { buf, ...tipo };
    },

    saveProductReference(productId, dataBase64) {
      if (!UUID_RE.test(productId)) throw erro('produto inválido');
      const { buf, mime, ext } = this.decodeImage(dataBase64);
      const ref = `products/${productId}/${crypto.randomUUID()}.${ext}`;
      const destino = dentroDaRaiz(ref);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, buf);
      return { ref, mime, sizeBytes: buf.length };
    },

    readProductReference(ref) {
      if (!REF_RE.test(String(ref))) throw erro('referência inválida');
      return ler(ref, 'referencia');
    },

    saveCreativeAsset(creativeId, asset) {
      if (!UUID_RE.test(creativeId)) throw erro('criativo inválido');
      const buf = Buffer.from(String(asset.data_base64 || ''), 'base64');
      const tipo = detectarImagem(buf);
      if (!tipo || tipo.mime !== 'image/png') throw erro('asset retornado não é PNG', 502);
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      if (asset.sha256 && asset.sha256 !== sha256) throw erro('asset corrompido (sha256 divergente)', 502);
      const storageKey = `creatives/${creativeId}/image.png`;
      const destino = dentroDaRaiz(storageKey);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.writeFileSync(destino, buf);
      return { storageKey, sha256, byteSize: buf.length, mime: 'image/png', width: asset.width, height: asset.height };
    },

    readCreativeAsset(storageKey) {
      if (!ASSET_RE.test(String(storageKey))) throw erro('asset inválido');
      return ler(storageKey, 'asset');
    },
  };
}

module.exports = { createStorage, detectarImagem, UUID_RE, TENANT_RE, REF_RE, ASSET_RE, MAX_IMAGE_BYTES };
