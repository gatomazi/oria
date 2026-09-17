'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Única ponte entre a tela e o processo principal — só essas chamadas existem, nada de acesso
// direto a Node/Electron no renderer.
contextBridge.exposeInMainWorld('app', {
  info: () => ipcRenderer.invoke('app:info'),
  obterEstado: () => ipcRenderer.invoke('estado:obter'),
  obterConfig: () => ipcRenderer.invoke('config:obter'),
  salvarConfig: (config) => ipcRenderer.invoke('config:salvar', config),
  salvarToken: (token) => ipcRenderer.invoke('token:salvar', token),
  iniciar: () => ipcRenderer.invoke('envio:iniciar'),
  pausar: () => ipcRenderer.invoke('envio:pausar'),
  testar: (telefone) => ipcRenderer.invoke('envio:testar', telefone),
  pedirPermissao: () => ipcRenderer.invoke('permissao:pedir'),
  aoMudarEstado: (callback) => {
    const ouvinte = (_ev, estado) => callback(estado);
    ipcRenderer.on('estado', ouvinte);
    return () => ipcRenderer.removeListener('estado', ouvinte);
  },
});
