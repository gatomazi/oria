'use strict';

const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, powerMonitor, safeStorage, systemPreferences, nativeImage, Notification } = require('electron');
const { MotorEnvio } = require('./envio');
const { criarClientePainel } = require('./painel');
const { criarArmazenamento } = require('./config');
const { carregarAutomacao, plataformaSuportada } = require('./automacao');

// App desktop que executa a fila de envio do WhatsApp Web do painel (docs/plano-whatsapp-web-envio.md).
// O painel decide o que sai e quando (limites, janela, fila); o app só abre a conversa, confere o
// app em primeiro plano e aperta Enter — no WhatsApp Desktop ou numa aba do navegador.

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let janela = null;
let tray = null;
let motor = null;
let armazenamento = null;
let ultimoEstado = null;

// Só abre os 2 formatos de link que o próprio app monta — nunca uma URL vinda de fora.
function abrirUrlConversa(url) {
  if (!url.startsWith('whatsapp://send?') && !url.startsWith('https://web.whatsapp.com/send?')) {
    return Promise.reject(new Error('URL não permitida'));
  }
  return shell.openExternal(url, { activate: true });
}

function acessibilidadeLiberada(pedir = false) {
  if (process.platform !== 'darwin') return true;
  return systemPreferences.isTrustedAccessibilityClient(pedir);
}

function iconeTray() {
  const arquivo = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  const imagem = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', arquivo));
  if (process.platform === 'darwin') imagem.setTemplateImage(true);
  return imagem;
}

function criarJanela() {
  if (janela) {
    janela.show();
    janela.focus();
    return;
  }
  janela = new BrowserWindow({
    width: 460,
    height: 720,
    minWidth: 400,
    minHeight: 560,
    title: 'Envio WhatsApp — Orgulho Regional',
    backgroundColor: '#111820',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  janela.removeMenu();
  janela.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  janela.once('ready-to-show', () => janela.show());
  // A tela não navega pra lugar nenhum nem abre janelas — tudo externo é bloqueado.
  janela.webContents.on('will-navigate', (ev) => ev.preventDefault());
  janela.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  janela.on('close', (ev) => {
    // Fechar a janela só esconde: o envio continua pela bandeja.
    if (!app.isQuitting) {
      ev.preventDefault();
      janela.hide();
    }
  });
}

function atualizarTray() {
  if (!tray) return;
  const pausado = !ultimoEstado || ultimoEstado.pausado;
  tray.setToolTip(`Envio WhatsApp — ${ultimoEstado ? ultimoEstado.detalhe : 'Pausado'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: ultimoEstado ? ultimoEstado.detalhe : 'Pausado', enabled: false },
    { label: `Enviadas nesta sessão: ${ultimoEstado ? ultimoEstado.enviadosSessao : 0}`, enabled: false },
    { type: 'separator' },
    pausado
      ? { label: 'Iniciar envio', click: () => iniciarEnvio() }
      : { label: 'Pausar envio', click: () => motor.pausar() },
    { label: 'Abrir', click: () => criarJanela() },
    { type: 'separator' },
    { label: 'Sair', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}

function enviarEstadoParaTela(estado) {
  ultimoEstado = estado;
  atualizarTray();
  if (janela && !janela.isDestroyed()) janela.webContents.send('estado', estado);
}

function iniciarEnvio() {
  if (!acessibilidadeLiberada(true)) {
    return { erro: 'Libere o app em Ajustes → Privacidade e Segurança → Acessibilidade e tente de novo.' };
  }
  const cfg = armazenamento.obter();
  if (!cfg.painelUrl || !armazenamento.tokenConfigurado()) {
    return { erro: 'Configure a URL do painel e o token antes de iniciar.' };
  }
  motor.iniciar();
  return {};
}

// "Abrir ao ligar o computador". No macOS 13+ o registro usa o SMAppService, que só aceita o app
// empacotado (rodando pelo `npm start` o executável é o Electron de desenvolvimento e o sistema
// recusa com "Operation not permitted"). Devolve o valor que realmente ficou valendo + um aviso.
function aplicarInicioComSistema(ativar) {
  if (!app.isPackaged) {
    return { ativo: false, aviso: 'Abrir ao ligar o computador só funciona no app instalado (não no modo desenvolvimento).' };
  }
  const opcoesMac = process.platform === 'darwin' ? { type: 'mainAppService' } : {};
  app.setLoginItemSettings({ openAtLogin: ativar, ...opcoesMac });
  const atual = app.getLoginItemSettings(opcoesMac);
  if (!ativar) return { ativo: false };
  if (process.platform === 'darwin' && atual.status === 'requires-approval') {
    return { ativo: true, aviso: 'Aprove o app em Ajustes → Geral → Itens de Início para ele abrir ao ligar o computador.' };
  }
  if (!atual.openAtLogin && atual.status !== 'enabled') {
    return { ativo: false, aviso: 'O sistema não permitiu abrir o app ao ligar o computador. Adicione manualmente nos itens de início do sistema.' };
  }
  return { ativo: true };
}

function registrarIpc() {
  ipcMain.handle('app:info', () => ({
    versao: app.getVersion(),
    plataforma: process.platform,
    empacotado: app.isPackaged,
    suportado: plataformaSuportada(),
    acessibilidade: acessibilidadeLiberada(false),
  }));
  ipcMain.handle('estado:obter', () => ultimoEstado);
  ipcMain.handle('config:obter', () => ({ ...armazenamento.obter(), tokenConfigurado: armazenamento.tokenConfigurado() }));

  ipcMain.handle('config:salvar', (_ev, entrada) => {
    if (!entrada || typeof entrada !== 'object') return { erro: 'dados inválidos' };
    const anterior = armazenamento.obter().iniciarComSistema;
    const { config, erro } = armazenamento.salvar(entrada);
    if (erro) return { erro };
    // Só mexe no registro do sistema quando a opção muda (antes chamava a cada "Salvar ajustes").
    if (config.iniciarComSistema === anterior) return { config };
    const { ativo, aviso } = aplicarInicioComSistema(config.iniciarComSistema);
    if (ativo !== config.iniciarComSistema) {
      return { config: armazenamento.salvar({ iniciarComSistema: ativo }).config, aviso };
    }
    return { config, aviso };
  });

  ipcMain.handle('token:salvar', (_ev, token) => armazenamento.salvarToken(token));
  ipcMain.handle('envio:iniciar', () => iniciarEnvio());
  ipcMain.handle('envio:pausar', () => { motor.pausar(); return {}; });
  // Pede a permissão (o macOS adiciona o app na lista) e abre direto a tela de Acessibilidade.
  ipcMain.handle('permissao:pedir', async () => {
    const acessibilidade = acessibilidadeLiberada(true);
    if (!acessibilidade && process.platform === 'darwin') {
      await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    }
    return { acessibilidade };
  });

  // Teste manual pro próprio número — mesmo fluxo do envio real, sem passar pela fila.
  ipcMain.handle('envio:testar', async (_ev, telefone) => {
    if (!acessibilidadeLiberada(true)) return { erro: 'Libere o app em Acessibilidade antes de testar.' };
    if (motor.testando) return { erro: 'Já tem um teste em andamento.' };
    const numero = String(telefone || '').replace(/\D/g, '');
    if (!/^\d{10,15}$/.test(numero)) return { erro: 'Telefone inválido — use DDI + DDD + número, ex: 5548999999999' };
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return motor.testar(numero, `Teste do app de envio (${hora}).\nSe chegou, está funcionando.`);
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  armazenamento = criarArmazenamento({ diretorio: app.getPath('userData'), safeStorage });
  const painel = criarClientePainel({ obterUrl: () => armazenamento.obter().painelUrl, obterToken: () => armazenamento.obterToken() });

  motor = new MotorEnvio({
    painel,
    automacao: plataformaSuportada() ? carregarAutomacao() : null,
    abrirUrl: abrirUrlConversa,
    obterTempoOciosoSeg: () => powerMonitor.getSystemIdleTime(),
    obterConfig: () => armazenamento.obter(),
    agora: () => Date.now(),
    dormir: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    aleatorio: Math.random,
    versao: app.getVersion(),
    plataforma: process.platform,
    log: (msg) => console.log(`[envio] ${msg}`),
    aoMudarEstado: (estado) => {
      // Notifica só na transição pra "token recusado", não a cada atualização de estado.
      const tokenRecusado = estado.ultimoErro === 'token_invalido';
      if (tokenRecusado && !(ultimoEstado && ultimoEstado.ultimoErro === 'token_invalido') && Notification.isSupported()) {
        new Notification({ title: 'Envio WhatsApp pausado', body: 'O painel recusou o token. Gere um novo em Integrações.' }).show();
      }
      enviarEstadoParaTela(estado);
    },
  });

  registrarIpc();
  tray = new Tray(iconeTray());
  tray.on('click', () => criarJanela());
  enviarEstadoParaTela({ ...motor.estado, pausado: true });

  // Sempre começa pausado (segurança: nada é enviado sem o usuário mandar), mas já conectado
  // pro painel mostrar "app online".
  motor.conectar();
  criarJanela();

  // Suspensão/bloqueio de tela: pausa — ninguém está olhando e o teclado simulado não faz sentido.
  powerMonitor.on('suspend', () => motor.pausar());
  powerMonitor.on('lock-screen', () => motor.pausar());
});

app.on('second-instance', () => criarJanela());
app.on('before-quit', () => { app.isQuitting = true; if (motor) motor.parar(); });
app.on('window-all-closed', (ev) => ev.preventDefault());
