'use strict';

// Read model das integrações: UM estado por provider, derivado de FATOS, no servidor.
//
// Antes, cada card decidia sozinho o que dizer — e dois cards podiam se contradizer ("API conectada"
// ao lado de erro 403; "Não incluído no plano" com o plano concedendo; "Pendente" porque um webhook
// que foi adiado de propósito não existe). Aqui a regra é uma só, em ordem de precedência, e o
// frontend só traduz o estado em rótulo.
//
// O vocabulário é fechado (`ESTADOS`). Cada valor tem UM significado:
//
//   not_entitled          o plano da Organization não inclui esta integração
//   platform_unavailable  a PLATAFORMA (app da Meta/Google, chave do serviço) não está configurada
//   not_configured        nada foi feito por esta Organization ainda
//   configured            há credencial/conexão, mas falta escolher o recurso (conta, propriedade)
//   connecting            uma conexão está sendo concluída agora
//   connected             conectada e utilizável
//   connected_with_data   conectada e já trouxe dados
//   degraded              conectada, mas algo impede o uso pleno (plataforma perdeu a config, token perto de vencer)
//   error                 a última operação falhou; exige ação (reconectar)
//   deferred              deliberadamente adiada — NÃO é falha
//   coming_soon           não implementada
//
// `proximaAcao` diz o que fazer, sem prometer que o botão existe: a tela decide como apresentar.

const ESTADOS = Object.freeze([
  'not_entitled', 'platform_unavailable', 'not_configured', 'configured', 'connecting',
  'connected', 'connected_with_data', 'degraded', 'error', 'deferred', 'coming_soon',
]);

const PROXIMAS_ACOES = Object.freeze([
  'none', 'ask_plan', 'wait_platform', 'configure', 'select_resource', 'reconnect', 'retry',
]);

// fatos:
//   comingSoon            a integração não existe no produto
//   entitled              true | false | null (null = não depende de plano)
//   platformAvailable     a plataforma está pronta para esta integração
//   configured            existe credencial/conexão
//   connected             conexão utilizável
//   needsResource         falta escolher conta/propriedade
//   hasData               já trouxe dados
//   connecting            conexão em andamento
//   failing               'error' | 'degraded' | null — o que a última operação disse
function derivarEstado(fatos) {
  const f = fatos || {};
  if (f.comingSoon) return { estado: 'coming_soon', proximaAcao: 'none' };
  if (f.entitled === false) return { estado: 'not_entitled', proximaAcao: 'ask_plan' };
  // Plataforma sem configuração só bloqueia quem AINDA não conectou. Quem já está conectado e vê a
  // plataforma perder a config está degradado, não "indisponível": os dados dele continuam lá.
  if (f.platformAvailable === false) {
    return f.connected ? { estado: 'degraded', proximaAcao: 'wait_platform' } : { estado: 'platform_unavailable', proximaAcao: 'wait_platform' };
  }
  if (f.connecting) return { estado: 'connecting', proximaAcao: 'none' };
  if (f.failing === 'error') return { estado: 'error', proximaAcao: 'reconnect' };
  if (f.failing === 'degraded') return { estado: 'degraded', proximaAcao: 'reconnect' };
  if (f.connected && f.needsResource) return { estado: 'configured', proximaAcao: 'select_resource' };
  if (f.connected) return { estado: f.hasData ? 'connected_with_data' : 'connected', proximaAcao: 'none' };
  if (f.configured) return { estado: 'configured', proximaAcao: 'select_resource' };
  return { estado: 'not_configured', proximaAcao: 'configure' };
}

// Uma linha do read model. `componentes` guarda partes que têm estado próprio (ex.: a API da Ink
// está conectada e o webhook, adiado): ausência de um componente não rebaixa o provider.
function linhaDoProvider(provider, fatos, componentes = null) {
  const { estado, proximaAcao } = derivarEstado(fatos);
  return {
    provider,
    estado,
    proximaAcao,
    entitled: fatos.entitled === undefined ? null : fatos.entitled,
    platformAvailable: fatos.platformAvailable !== false,
    ...(componentes ? { componentes } : {}),
  };
}

// Uma leitura que falha não pode virar "não configurado" (mentira) nem derrubar a tela inteira:
// vira `error` com ação de tentar de novo, e o provider seguinte é lido normalmente.
function linhaComFalha(provider) {
  return { provider, estado: 'error', proximaAcao: 'retry', entitled: null, platformAvailable: true, leituraFalhou: true };
}

module.exports = { ESTADOS, PROXIMAS_ACOES, derivarEstado, linhaDoProvider, linhaComFalha };
