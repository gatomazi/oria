'use strict';

// Motor de envio — sem nenhuma dependência do Electron (testável com `node --test`). Tudo que
// toca o sistema (abrir link, tecla, app em primeiro plano, tempo ocioso, painel, relógio) chega
// injetado em `deps`.
//
// Ciclo de 1 mensagem:
//   1. só reserva item com o computador parado há `ociosoSeg` (não segura lease à toa)
//   2. abre a conversa (whatsapp://send no Desktop, https://web.whatsapp.com/send no navegador)
//   3. espera carregar; se o usuário mexer no computador, espera ele parar
//   4. confere que o WhatsApp (ou o navegador) está em primeiro plano — senão NÃO aperta Enter
//   5. aperta Enter; no navegador, fecha a aba aberta
//   6. reporta "sent" sem confirmação (o app não lê a tela) e respeita a pausa aleatória

const HEARTBEAT_A_CADA_MS = 30 * 1000;
const ESPERA_FILA_VAZIA_MS = 30 * 1000;
const ESPERA_OCIOSO_MS = 2 * 1000;
const MAX_ESPERA_USUARIO_MS = 90 * 1000;
const CONFERENCIAS_PRIMEIRO_PLANO = 4;

// Nome do app/processo em primeiro plano, comparado sem diferenciar maiúsculas e por "contém"
// (macOS devolve "WhatsApp"/"Google Chrome", Windows devolve o processo: "WhatsApp", "chrome").
const APPS_ESPERADOS = {
  desktop: ['whatsapp'],
  navegador: ['chrome', 'safari', 'firefox', 'edge', 'msedge', 'brave', 'opera', 'arc', 'vivaldi'],
};

class TokenInvalidoError extends Error {}

function montarUrlConversa(modo, telefone, texto) {
  const numero = String(telefone).replace(/\D/g, '');
  if (!/^\d{10,15}$/.test(numero)) throw new Error('telefone inválido');
  const params = `phone=${numero}&text=${encodeURIComponent(texto)}`;
  return modo === 'navegador' ? `https://web.whatsapp.com/send?${params}` : `whatsapp://send?${params}`;
}

function appEsperado(modo, nomeApp) {
  const nome = String(nomeApp || '').toLowerCase();
  return APPS_ESPERADOS[modo === 'navegador' ? 'navegador' : 'desktop'].some((trecho) => nome.includes(trecho));
}

function aleatorioEntre(min, max, aleatorio = Math.random) {
  return min + (max - min) * aleatorio();
}

class MotorEnvio {
  constructor(deps) {
    this.deps = deps;
    this.rodando = false;
    this.pausado = true;
    this.ultimoHeartbeat = 0;
    this.enviadosNoLote = 0;
    this.testando = false;
    // Trava de envio: mensagem da fila e "Testar" nunca digitam ao mesmo tempo.
    this.travaEnvio = Promise.resolve();
    this.estado = {
      situacao: 'pausado',
      detalhe: 'Pausado',
      enviadosSessao: 0,
      falhasSessao: 0,
      ultimoEnvioEm: null,
      ultimoErro: null,
    };
  }

  config() {
    return this.deps.obterConfig();
  }

  atualizar(parcial) {
    this.estado = { ...this.estado, ...parcial };
    if (this.deps.aoMudarEstado) this.deps.aoMudarEstado({ ...this.estado, pausado: this.pausado });
  }

  log(msg) {
    if (this.deps.log) this.deps.log(msg);
  }

  // Liga o loop sem enviar nada (pausado): o painel já vê o app online.
  conectar() {
    if (this.rodando) return;
    this.rodando = true;
    this.loop().finally(() => { this.rodando = false; });
  }

  iniciar() {
    this.pausado = false;
    this.atualizar({ situacao: 'iniciando', detalhe: 'Conectando ao painel…', ultimoErro: null });
    this.avisarPainel();
    this.conectar();
  }

  pausar() {
    this.pausado = true;
    this.atualizar({ situacao: 'pausado', detalhe: 'Pausado' });
    this.avisarPainel();
  }

  // Heartbeat imediato (sem esperar os 30 s) pra o painel refletir iniciar/pausar/testar na hora.
  avisarPainel() {
    this.heartbeat(true).catch(() => {});
  }

  async exclusivo(fn) {
    const anterior = this.travaEnvio;
    let liberar;
    this.travaEnvio = new Promise((resolve) => { liberar = resolve; });
    await anterior;
    try {
      return await fn();
    } finally {
      liberar();
    }
  }

  // "Testar" da tela: não exige pausar — se uma mensagem da fila estiver saindo, espera ela terminar.
  async testar(telefone, texto) {
    this.testando = true;
    this.atualizar({ situacao: 'testando', detalhe: 'Enviando mensagem de teste…' });
    this.avisarPainel();
    try {
      return await this.exclusivo(() => this.enviarMensagem(telefone, texto));
    } finally {
      this.testando = false;
      this.atualizar(this.pausado ? { situacao: 'pausado', detalhe: 'Pausado' } : { situacao: 'aguardando', detalhe: 'Retomando o envio da fila…' });
      this.avisarPainel();
    }
  }

  parar() {
    this.pausado = true;
    this.encerrar = true;
  }

  async dormir(ms) {
    const { dormir } = this.deps;
    const fim = this.deps.agora() + ms;
    while (!this.encerrar && !this.pausado && this.deps.agora() < fim) {
      await dormir(Math.min(1000, fim - this.deps.agora()));
    }
  }

  async heartbeat(forcar = false) {
    if (!forcar && this.deps.agora() - this.ultimoHeartbeat < HEARTBEAT_A_CADA_MS) return this.ultimaResposta;
    // Conta a partir da tentativa (não do sucesso): painel fora do ar não vira 1 request por segundo.
    this.ultimoHeartbeat = this.deps.agora();
    const cfg = this.config();
    this.ultimaResposta = await this.deps.painel.heartbeat({
      versao: this.deps.versao,
      whatsapp: 'nao_verificavel',
      executor: cfg.modo === 'navegador' ? 'navegador' : 'desktop',
      plataforma: this.deps.plataforma,
      pausado: this.pausado,
      testando: this.testando,
    });
    return this.ultimaResposta;
  }

  async loop() {
    while (!this.encerrar) {
      if (this.pausado) {
        // Pausado continua avisando o painel (que mostra "app online, pausado").
        await this.heartbeat().catch(() => {});
        await this.deps.dormir(1000);
        continue;
      }
      try {
        await this.ciclo();
      } catch (err) {
        if (err instanceof TokenInvalidoError) {
          this.pausar();
          this.atualizar({ situacao: 'erro', detalhe: 'Token recusado pelo painel — gere um novo em Integrações', ultimoErro: 'token_invalido' });
          continue;
        }
        this.log(`erro no ciclo: ${err.message}`);
        this.atualizar({ situacao: 'erro', detalhe: 'Painel indisponível — tentando de novo', ultimoErro: err.message });
        await this.dormir(ESPERA_FILA_VAZIA_MS);
      }
    }
  }

  async ciclo() {
    const resposta = await this.heartbeat();
    if (resposta && resposta.ativo === false) {
      this.atualizar({ situacao: 'aguardando', detalhe: 'Modo WhatsApp Web está desligado no painel' });
      await this.dormir(ESPERA_FILA_VAZIA_MS);
      return;
    }

    const cfg = this.config();
    if (cfg.ociosoSeg > 0 && this.deps.obterTempoOciosoSeg() < cfg.ociosoSeg) {
      this.atualizar({ situacao: 'aguardando', detalhe: 'Aguardando você parar de usar o computador' });
      await this.dormir(ESPERA_OCIOSO_MS);
      return;
    }

    const { item, motivo } = await this.deps.painel.claim();
    if (!item) {
      this.atualizar({ situacao: 'aguardando', detalhe: DETALHE_MOTIVO[motivo] || 'Nada para enviar agora' });
      await this.dormir(ESPERA_FILA_VAZIA_MS);
      return;
    }

    this.atualizar({ situacao: 'enviando', detalhe: 'Enviando mensagem…' });
    const resultado = await this.exclusivo(() => this.enviarMensagem(item.telefone, item.texto));
    await this.reportar(item.id, resultado);

    if (resultado.status === 'sent') {
      this.enviadosNoLote += 1;
      this.atualizar({ enviadosSessao: this.estado.enviadosSessao + 1, ultimoEnvioEm: new Date(this.deps.agora()).toISOString() });
    } else {
      this.atualizar({ falhasSessao: this.estado.falhasSessao + 1, ultimoErro: resultado.codigo });
    }

    if (this.enviadosNoLote >= cfg.loteAntesPausa) {
      this.enviadosNoLote = 0;
      const pausa = aleatorioEntre(cfg.pausaLongaMinSeg, cfg.pausaLongaMaxSeg, this.deps.aleatorio);
      this.atualizar({ situacao: 'aguardando', detalhe: `Pausa de ${Math.round(pausa / 60)} min entre lotes` });
      await this.dormir(pausa * 1000);
    } else {
      const pausa = aleatorioEntre(cfg.pausaMinSeg, cfg.pausaMaxSeg, this.deps.aleatorio);
      this.atualizar({ situacao: 'aguardando', detalhe: 'Intervalo entre mensagens' });
      await this.dormir(pausa * 1000);
    }
  }

  async reportar(id, resultado) {
    const corpo = resultado.status === 'sent'
      ? { status: 'sent', confirmado: false }
      : { status: 'failed', codigo: resultado.codigo, mensagem: resultado.detalhe };
    // Resultado é o que mais importa não perder; se não chegar, o lease vence e o item vira
    // "desconhecido" no painel.
    for (let tentativa = 1; tentativa <= 4; tentativa += 1) {
      try {
        await this.deps.painel.resultado(id, corpo);
        return;
      } catch (err) {
        if (err instanceof TokenInvalidoError) throw err;
        this.log(`falha ao reportar resultado (tentativa ${tentativa}/4): ${err.message}`);
        await this.deps.dormir(3000 * tentativa);
      }
    }
  }

  // Espera o computador ficar parado. Devolve false se o usuário não largar dentro do limite.
  async aguardarOcioso(minimoSeg) {
    const limite = this.deps.agora() + MAX_ESPERA_USUARIO_MS;
    while (this.deps.obterTempoOciosoSeg() < minimoSeg) {
      if (this.encerrar || this.deps.agora() > limite) return false;
      this.atualizar({ situacao: 'enviando', detalhe: 'Aguardando você parar de usar o computador' });
      await this.deps.dormir(500);
    }
    return true;
  }

  async confereAppEsperado(modo) {
    for (let i = 0; i < CONFERENCIAS_PRIMEIRO_PLANO; i += 1) {
      const nome = await this.deps.automacao.appEmPrimeiroPlano().catch(() => '');
      if (appEsperado(modo, nome)) return true;
      await this.deps.dormir(1000);
    }
    return false;
  }

  // Usado pelo ciclo e pelo "Testar envio" (que não passa pela fila).
  async enviarMensagem(telefone, texto) {
    const cfg = this.config();
    const modo = cfg.modo === 'navegador' ? 'navegador' : 'desktop';
    let url;
    try {
      url = montarUrlConversa(modo, telefone, texto);
    } catch (err) {
      return { status: 'failed', codigo: 'numero_invalido', detalhe: err.message };
    }

    try {
      await this.deps.abrirUrl(url);
    } catch (err) {
      return { status: 'failed', codigo: 'app_nao_abriu', detalhe: modo === 'desktop' ? 'WhatsApp Desktop não abriu (está instalado?)' : 'navegador não abriu' };
    }

    // Tempo pro app/aba carregar a conversa com o texto já preenchido.
    const esperaSeg = modo === 'navegador' ? cfg.esperaNavegadorSeg : cfg.esperaDesktopSeg;
    await this.deps.dormir(esperaSeg * 1000);

    // Enter só com o computador parado e o app certo na frente — é o que evita digitar dentro de
    // outro programa que o usuário abriu nesse meio tempo.
    if (!(await this.aguardarOcioso(Math.min(2, cfg.ociosoSeg || 2)))) {
      return { status: 'failed', codigo: 'interrompido', detalhe: 'computador em uso durante o envio' };
    }
    if (!(await this.confereAppEsperado(modo))) {
      return {
        status: 'failed',
        codigo: 'app_nao_abriu',
        detalhe: modo === 'desktop' ? 'WhatsApp Desktop não ficou em primeiro plano' : 'navegador não ficou em primeiro plano',
      };
    }

    await this.deps.automacao.pressionarEnter();
    await this.deps.dormir(2500);

    if (modo === 'navegador' && (await this.confereAppEsperado(modo))) {
      // Cada link abre uma aba nova do WhatsApp Web — fecha pra não acumular.
      await this.deps.automacao.fecharAba().catch((err) => this.log(`falha ao fechar aba: ${err.message}`));
    }
    return { status: 'sent' };
  }
}

const DETALHE_MOTIVO = {
  fila_vazia: 'Nada na fila',
  fora_da_janela: 'Fora da janela de horário de envio',
  teto_diario: 'Teto diário atingido — volta amanhã',
  limite_recomendado: 'Limite recomendado do dia atingido (campanhas voltam amanhã)',
  provider_inativo: 'Modo WhatsApp Web está desligado no painel',
};

module.exports = { MotorEnvio, TokenInvalidoError, montarUrlConversa, appEsperado };
