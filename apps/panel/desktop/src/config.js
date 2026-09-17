'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { validarUrlPainel } = require('./painel');

const PADRAO = {
  painelUrl: '',
  modo: 'desktop',
  esperaDesktopSeg: 5,
  esperaNavegadorSeg: 15,
  ociosoSeg: 10,
  pausaMinSeg: 8,
  pausaMaxSeg: 20,
  loteAntesPausa: 20,
  pausaLongaMinSeg: 120,
  pausaLongaMaxSeg: 240,
  iniciarComSistema: false,
};

// Faixas aceitas — valores fora disso vêm de edição manual do arquivo ou bug na tela.
const LIMITES = {
  esperaDesktopSeg: [2, 30],
  esperaNavegadorSeg: [5, 60],
  ociosoSeg: [0, 120],
  pausaMinSeg: [5, 600],
  pausaMaxSeg: [5, 900],
  loteAntesPausa: [1, 200],
  pausaLongaMinSeg: [30, 3600],
  pausaLongaMaxSeg: [30, 7200],
};

function validarConfig(entrada) {
  const cfg = { ...PADRAO };
  if (entrada.painelUrl !== undefined) {
    if (entrada.painelUrl !== '' && !validarUrlPainel(entrada.painelUrl)) return { erro: 'URL do painel deve começar com https://' };
    cfg.painelUrl = entrada.painelUrl === '' ? '' : validarUrlPainel(entrada.painelUrl);
  }
  if (entrada.modo !== undefined) {
    if (entrada.modo !== 'desktop' && entrada.modo !== 'navegador') return { erro: 'modo inválido' };
    cfg.modo = entrada.modo;
  }
  for (const [chave, [min, max]] of Object.entries(LIMITES)) {
    if (entrada[chave] === undefined) continue;
    const n = Number(entrada[chave]);
    if (!Number.isFinite(n) || n < min || n > max) return { erro: `${chave} deve ficar entre ${min} e ${max}` };
    cfg[chave] = n;
  }
  if (cfg.pausaMinSeg > cfg.pausaMaxSeg) return { erro: 'a pausa mínima não pode ser maior que a máxima' };
  if (cfg.pausaLongaMinSeg > cfg.pausaLongaMaxSeg) return { erro: 'a pausa longa mínima não pode ser maior que a máxima' };
  if (entrada.iniciarComSistema !== undefined) cfg.iniciarComSistema = entrada.iniciarComSistema === true;
  return { config: cfg };
}

// Config em JSON no diretório do usuário; o token vai criptografado pelo cofre do sistema
// (safeStorage → Keychain no macOS, DPAPI no Windows). Sem cofre disponível o token fica só em
// memória — nunca em texto puro no disco.
function criarArmazenamento({ diretorio, safeStorage }) {
  const arquivo = path.join(diretorio, 'config.json');
  let dados = { ...PADRAO };
  let tokenMemoria = '';

  try {
    const lido = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    const { config } = validarConfig(lido);
    dados = { ...(config || PADRAO), tokenCriptografado: lido.tokenCriptografado || null };
  } catch {
    dados = { ...PADRAO, tokenCriptografado: null };
  }

  function gravar() {
    fs.mkdirSync(diretorio, { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), { mode: 0o600 });
  }

  return {
    obter() {
      const { tokenCriptografado, ...config } = dados;
      return config;
    },
    salvar(entrada) {
      const { config, erro } = validarConfig({ ...this.obter(), ...entrada });
      if (erro) return { erro };
      dados = { ...config, tokenCriptografado: dados.tokenCriptografado };
      gravar();
      return { config };
    },
    obterToken() {
      if (tokenMemoria) return tokenMemoria;
      if (!dados.tokenCriptografado || !safeStorage.isEncryptionAvailable()) return '';
      try {
        tokenMemoria = safeStorage.decryptString(Buffer.from(dados.tokenCriptografado, 'base64'));
      } catch {
        tokenMemoria = '';
      }
      return tokenMemoria;
    },
    salvarToken(token) {
      const limpo = String(token || '').trim();
      if (limpo && !/^[A-Za-z0-9_-]{32,128}$/.test(limpo)) return { erro: 'token com formato inválido' };
      tokenMemoria = limpo;
      if (!limpo) {
        dados.tokenCriptografado = null;
      } else if (safeStorage.isEncryptionAvailable()) {
        dados.tokenCriptografado = safeStorage.encryptString(limpo).toString('base64');
      } else {
        dados.tokenCriptografado = null;
        gravar();
        return { aviso: 'cofre do sistema indisponível: o token vale só até fechar o app' };
      }
      gravar();
      return {};
    },
    tokenConfigurado() {
      return Boolean(this.obterToken());
    },
  };
}

module.exports = { criarArmazenamento, validarConfig, PADRAO };
