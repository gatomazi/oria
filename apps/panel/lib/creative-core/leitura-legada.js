'use strict';

// OPS-22 · configuração da leitura dupla TEMPORÁRIA dos arquivos do Creative Core (rodada 19, trilha G).
//
//   CREATIVE_LEGACY_READ_FROM              tenant legado (nome do diretório antigo, ex.: "default")
//   CREATIVE_LEGACY_READ_ORGANIZATION_ID   a ÚNICA Organization que pode ler desse diretório
//
// As duas juntas ou nenhuma. Nada é deduzido ("só existe uma Organization" não liga nada). Ausentes:
// desligada (padrão). Isto NÃO escolhe tenant: o tenant continua sendo a Organization da request
// (INV-22); a configuração só diz de onde uma Organization específica pode LER arquivos que ainda
// não foram movidos por `npm run tenancy:mover-criativos`. Removida no CLEANUP, depois da verificação.

const { TENANT_RE, UUID_RE } = require('./storage');

class LeituraLegadaConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LeituraLegadaConfigError';
  }
}

// Devolve null (desligada) ou { de, organizationId } congelado. Configuração inválida lança — o boot
// deve falhar em vez de subir com o fallback num estado que ninguém declarou.
function lerLeituraLegada(env = {}) {
  const de = String(env.CREATIVE_LEGACY_READ_FROM || '').trim().toLowerCase();
  const organizationId = String(env.CREATIVE_LEGACY_READ_ORGANIZATION_ID || '').trim().toLowerCase();
  if (!de && !organizationId) return null;
  if (!de || !organizationId) {
    throw new LeituraLegadaConfigError('CREATIVE_LEGACY_READ_FROM e CREATIVE_LEGACY_READ_ORGANIZATION_ID vão juntas (ou nenhuma)');
  }
  if (!TENANT_RE.test(de) || UUID_RE.test(de)) {
    throw new LeituraLegadaConfigError('CREATIVE_LEGACY_READ_FROM inválido: nome do tenant legado ([a-z0-9_-], sem forma de uuid)');
  }
  if (!UUID_RE.test(organizationId)) {
    throw new LeituraLegadaConfigError('CREATIVE_LEGACY_READ_ORGANIZATION_ID inválido: id (uuid) da Organization');
  }
  return Object.freeze({ de, organizationId });
}

// Contagem por tipo + log com limite de frequência: o suficiente para saber se o fallback ainda é
// usado (e quando é seguro desligar), sem inundar o log. Nunca registra caminho nem nome de arquivo.
function criarObservadorLeituraLegada({ logger = console, intervaloMs = 60000, agora = () => Date.now() } = {}) {
  const contagem = { referencia: 0, asset: 0 };
  let ultimoLog = -Infinity;
  return {
    registrar({ tipo }) {
      const chave = tipo === 'asset' ? 'asset' : 'referencia';
      contagem[chave] += 1;
      if (agora() - ultimoLog < intervaloMs) return;
      ultimoLog = agora();
      (logger.warn || logger.log).call(logger, `[CRIATIVOS] OPS-22 leitura legada usada (referencias=${contagem.referencia} assets=${contagem.asset}) — rode tenancy:mover-criativos e a verificação antes de desligar`);
    },
    contagem: () => ({ ...contagem }),
  };
}

module.exports = { LeituraLegadaConfigError, lerLeituraLegada, criarObservadorLeituraLegada };
